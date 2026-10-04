import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import {
	approveProposal,
	finishRelease,
	modeFor,
	propose,
	releaseMode,
	resolveProposer,
	unlockSigningKey,
	type ReleaseRequest,
} from "../src/commands/approve";
import { withLocal } from "../src/commands/common";
import { deployFlags } from "../src/commands/deploy";
import { keysInit, keysFlags } from "../src/commands/keys";
import { approvalRequired, validateConfig, type Project } from "../src/config";
import { readLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { NotInteractiveError, scriptedInteraction } from "../src/interact";
import { decryptKeyFile, encryptSeed, passphraseProblems, readKeyFile, validateKeyFile, WrongPassphraseError, writeKeyFile } from "../src/keystore";
import { setOutputMode, Stopwatch } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import { appendProposalEvent, findProposal, pendingProposals, PROPOSAL_TTL_MS, readProposals } from "../src/proposals";
import { generateSigningKey, parseSigningKey, verifyFields } from "../src/signing";

/** Cheap scrypt for tests (the real cost is N = 2^17). */
const FAST = { N: 2 ** 14, r: 8, p: 1 };
const PASS = "correct horse battery staple";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

function sh(cwd: string, ...cmd: string[]) {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

describe("key file encryption", () => {
	test("round trip; the public key is kept; wrong passphrase and tampering fail", () => {
		const { seed, publicKey } = generateSigningKey();
		const file = encryptSeed(seed, PASS, { universeId: 42, scrypt: FAST });
		expect(file.publicKey).toBe(publicKey);
		expect(JSON.stringify(file)).not.toContain(seed);
		expect(decryptKeyFile(file, PASS).publicKey).toBe(publicKey);
		expect(() => decryptKeyFile(file, "wrong passphrase!!")).toThrow(WrongPassphraseError);
		// any edited field breaks the AES-GCM tag (the header is additional data)
		expect(() => decryptKeyFile({ ...file, publicKey: generateSigningKey().publicKey }, PASS)).toThrow(WrongPassphraseError);
		expect(() => decryptKeyFile({ ...file, kdf: { ...file.kdf, N: 2 ** 15 } }, PASS)).toThrow(WrongPassphraseError);
		const ct = Buffer.from(file.ciphertext, "base64");
		ct[0] ^= 1;
		expect(() => decryptKeyFile({ ...file, ciphertext: ct.toString("base64") }, PASS)).toThrow(WrongPassphraseError);
	});
	test("the default cost is scrypt N=2^17; files with weak or absurd parameters are refused", () => {
		const file = encryptSeed(generateSigningKey().seed, PASS);
		expect(file.kdf).toMatchObject({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 });
		expect(() => validateKeyFile({ ...file, kdf: { ...file.kdf, N: 1024 } })).toThrow(/out of range/);
		expect(() => validateKeyFile({ ...file, kdf: { ...file.kdf, N: 2 ** 30 } })).toThrow(/out of range/);
		expect(() => validateKeyFile({ v: 2 })).toThrow(/unknown format/);
	});
	test("the key file is written with 0600 and read back", () => {
		const path = join(mkdtempSync(join(tmpdir(), "tt-kf-")), "keys", "1.key");
		const file = encryptSeed(generateSigningKey().seed, PASS, { scrypt: FAST });
		writeKeyFile(path, file);
		expect(readKeyFile(path)).toEqual(file);
		expect(() => readKeyFile(path + ".missing")).toThrow(/keys init/);
	});
	test("passphrase rules", () => {
		expect(passphraseProblems(PASS)).toEqual([]);
		expect(passphraseProblems("short")).toContain("at least 12 characters");
		expect(passphraseProblems("aaaaaaaaaaaaaa")).toContain("more than 4 different characters");
		expect(passphraseProblems(" leading space here")).toContain("no spaces at the start or end");
	});
});

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-approval-"));
	const raw = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t") + "\n");
	const { config, errors } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings: [] };
}

function keyFor(proj: Project) {
	const { seed, publicKey } = generateSigningKey();
	const keyFile = join(mkdtempSync(join(tmpdir(), "tt-keyfile-")), "42.key");
	writeKeyFile(keyFile, encryptSeed(seed, PASS, { scrypt: FAST }));
	proj.config.signingPublicKey = publicKey;
	return { keyFile, publicKey };
}

function fakeOc() {
	const published: string[] = [];
	return { published, oc: { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud };
}

const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777, channel: "dev" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false, bytes: 2048, builtAt: "2026-10-04T12:00:00.000Z" };
const request = (patch: Partial<ReleaseRequest> = {}): ReleaseRequest => ({ kind: "deploy", branch: "dev", branchChannel: "dev", artifact, changes: ["template: spin coins"], message: "make coins spin", force: false, by: "me", ...patch });

describe("approval policy", () => {
	test("typetorch.json approval: all (default), prod, none", () => {
		expect(validateConfig({ project: "p", universeId: 1, placeId: 2, creator: { userId: 3 } }).config?.approval).toBe("all");
		expect(validateConfig({ project: "p", universeId: 1, placeId: 2, creator: { userId: 3 }, approval: "maybe" }).errors).toContain('"approval" must be one of all, prod, none');
		expect(approvalRequired("all", "dev")).toBe(true);
		expect(approvalRequired("prod", "dev")).toBe(false);
		expect(approvalRequired("prod", "prod")).toBe(true);
		expect(approvalRequired("none", "prod")).toBe(false);
	});
	test("who can do what", () => {
		const cli = { name: "cli", explicit: false };
		const agent = { name: "agent", explicit: false };
		const devServer = { name: "dev-server/claude", explicit: true };
		const base = { policy: "all" as const, branchChannel: "dev" as const, propose: false, keyFileExists: true };
		expect(releaseMode({ ...base, proposer: cli, interactive: true }).kind).toBe("approve-now");
		expect(releaseMode({ ...base, proposer: cli, interactive: true, propose: true }).kind).toBe("propose");
		expect(releaseMode({ ...base, proposer: agent, interactive: false }).kind).toBe("propose");
		// a pseudo-terminal doesn't make the dev-server a person
		expect(releaseMode({ ...base, proposer: devServer, interactive: true }).kind).toBe("propose");
		// approval "none": a person signs, anyone else publishes unsigned
		expect(releaseMode({ ...base, policy: "none", proposer: cli, interactive: true }).kind).toBe("sign-now");
		expect(releaseMode({ ...base, policy: "none", proposer: agent, interactive: false }).kind).toBe("unsigned");
		expect(releaseMode({ ...base, policy: "prod", proposer: agent, interactive: false }).kind).toBe("unsigned");
		expect(releaseMode({ ...base, policy: "prod", branchChannel: "prod", proposer: agent, interactive: false }).kind).toBe("propose");
		// the CI escape hatch signs without a person, but never for the dev-server or an explicit agent
		const ciKey = parseSigningKey(generateSigningKey().seed);
		expect(releaseMode({ ...base, proposer: agent, interactive: false, ciKey }).kind).toBe("ci");
		expect(releaseMode({ ...base, proposer: devServer, interactive: false, ciKey }).kind).toBe("propose");
		expect(releaseMode({ ...base, proposer: { name: "agent", explicit: true }, interactive: false, ciKey }).kind).toBe("propose");
	});
	test("the proposer: flag, env, else cli at a terminal and agent otherwise", () => {
		project();
		expect(resolveProposer(undefined, true)).toEqual({ name: "cli", explicit: false });
		expect(resolveProposer(undefined, false)).toEqual({ name: "agent", explicit: false });
		expect(resolveProposer("dev-server/claude", false)).toEqual({ name: "dev-server/claude", explicit: true });
		expect(() => resolveProposer("Bad Name!", false)).toThrow();
		useSettings(new Settings({ startDir: tmpdir(), env: { TYPETORCH_PROPOSED_BY: "agent" } }));
		expect(resolveProposer(undefined, true)).toEqual({ name: "agent", explicit: true });
	});
	test("the CI escape hatch needs both variables in the real environment", () => {
		const { seed } = generateSigningKey();
		const dir = mkdtempSync(join(tmpdir(), "tt-ci-"));
		expect(new Settings({ startDir: dir, env: { TYPETORCH_SIGNING_KEY: seed } }).ciSigningKey()).toBeUndefined();
		expect(new Settings({ startDir: dir, env: { TYPETORCH_SIGNING_KEY: seed, TYPETORCH_ALLOW_ENV_SIGNING_KEY: "1" } }).ciSigningKey()).toBeDefined();
		writeFileSync(join(dir, ".env"), `TYPETORCH_SIGNING_KEY=${seed}\nTYPETORCH_ALLOW_ENV_SIGNING_KEY=1\n`);
		const fromFile = new Settings({ startDir: dir, env: {} });
		expect(fromFile.ciSigningKey()).toBeUndefined(); // files never enable it
		expect(fromFile.plaintextSigningKey()?.source).toBe(join(dir, ".env")); // found, for migration and warnings
	});
	test("a person approving needs a key file before anything is built", () => {
		const proj = project();
		const args = parseArgs(["--key-file", join(proj.root, "..", "missing.key")], deployFlags);
		expect(() => modeFor(proj, args, "dev", scriptedInteraction({}))).toThrow(/keys init/);
		expect(modeFor(proj, args, "dev", scriptedInteraction({ interactive: false })).mode.kind).toBe("propose");
	});
});

describe("proposals", () => {
	test("lifecycle: proposed -> pending (newest first) -> approved / rejected; the first decision wins", () => {
		const proj = project();
		const a = propose(proj, request(), { name: "agent", explicit: false });
		const b = propose(proj, request({ branch: "feature-x" }), { name: "dev-server/claude", explicit: true });
		const dir = join(proj.root, ".typetorch");
		expect(pendingProposals(dir).map((s) => s.proposal.id)).toEqual([b.id, a.id]);
		expect(findProposal(readProposals(dir), a.id.slice(0, 5))?.proposal.id).toBe(a.id);
		appendProposalEvent(dir, { event: "rejected", id: a.id, by: "me" });
		appendProposalEvent(dir, { event: "approved", id: a.id, by: "me", seq: 9 });
		const states = readProposals(dir);
		expect(states.find((s) => s.proposal.id === a.id)?.status).toBe("rejected");
		expect(states.find((s) => s.proposal.id === b.id)).toMatchObject({ status: "pending", proposal: { proposedBy: "dev-server/claude", changes: ["template: spin coins"], message: "make coins spin" } });
	});
	test("expire after 24 h", () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		const dir = join(proj.root, ".typetorch");
		expect(Date.parse(p.expiresAt) - Date.parse(p.at)).toBe(PROPOSAL_TTL_MS);
		expect(readProposals(dir, { now: Date.parse(p.at) + PROPOSAL_TTL_MS - 1 })[0].status).toBe("pending");
		expect(readProposals(dir, { now: Date.parse(p.at) + PROPOSAL_TTL_MS })[0].status).toBe("expired");
		expect(pendingProposals(dir, { now: Date.parse(p.at) + PROPOSAL_TTL_MS + 1 })).toEqual([]);
	});
	test("a failed approval keeps the proposal pending and shows the error", () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		const dir = join(proj.root, ".typetorch");
		appendProposalEvent(dir, { event: "failed", id: p.id, error: "registry down" });
		expect(readProposals(dir)[0]).toMatchObject({ status: "pending", lastError: "registry down" });
	});
});

describe("approve", () => {
	test("refuses without an interactive terminal", async () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		await expect(approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ interactive: false }) })).rejects.toThrow(NotInteractiveError);
		await expect(unlockSigningKey(proj, scriptedInteraction({ interactive: false }))).rejects.toThrow(NotInteractiveError);
	});
	test("y + passphrase: signs, publishes, logs the deploy with the proposal id, marks it approved", async () => {
		const proj = project();
		const { keyFile, publicKey } = keyFor(proj);
		const p = propose(proj, request(), { name: "dev-server/claude", explicit: true });
		const { oc, published } = fakeOc();
		const io = scriptedInteraction({ answers: ["y"], secrets: ["nope, wrong one", PASS] });
		const result = await approveProposal(proj, { proposal: p, status: "pending" }, { io, keyFile, oc, noRegistry: true });
		expect(result?.entry.seq).toBe(1);
		const message = JSON.parse(published[0]);
		const { sig, ...fields } = message;
		expect(verifyFields(publicKey, fields, sig)).toBe(true);
		expect(message).toMatchObject({ b: "dev", a: 777, i: "12b63b9-3fa91c", s: 1 });
		const dir = join(proj.root, ".typetorch");
		expect(readLocalLog(dir)[0]).toMatchObject({ proposalId: p.id, proposedBy: "dev-server/claude", sig, changes: ["template: spin coins"] });
		expect(readProposals(dir)[0]).toMatchObject({ status: "approved", decision: { seq: 1 } });
		expect(io.asked.filter((q) => q.startsWith("passphrase"))).toHaveLength(2); // one wrong try
	});
	test("n leaves it pending; three wrong passphrases publish nothing", async () => {
		const proj = project();
		const { keyFile } = keyFor(proj);
		const p = propose(proj, request(), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		expect(await approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["n"] }), keyFile, oc, noRegistry: true })).toBeUndefined();
		await expect(
			approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["y"], secrets: ["bad one 1xx", "bad one 2xx", "bad one 3xx"] }), keyFile, oc, noRegistry: true }),
		).rejects.toThrow(WrongPassphraseError);
		expect(published).toEqual([]);
		expect(readProposals(join(proj.root, ".typetorch"))[0].status).toBe("pending");
	});
	test("a key that doesn't match typetorch.json is refused", async () => {
		const proj = project();
		const { keyFile } = keyFor(proj);
		proj.config.signingPublicKey = generateSigningKey().publicKey;
		const p = propose(proj, request(), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		await expect(approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["y"], secrets: [PASS] }), keyFile, oc, noRegistry: true })).rejects.toThrow(/does not match/);
		expect(published).toEqual([]);
	});
});

describe("finishRelease", () => {
	test("propose writes a proposal and publishes nothing; approve-now asks at once", async () => {
		const proj = project();
		const { keyFile } = keyFor(proj);
		const { oc, published } = fakeOc();
		const history = withLocal(proj, undefined);
		const proposed = await finishRelease({ proj, mode: { kind: "propose" }, proposer: { name: "agent", explicit: false }, request: request(), oc, history, watch: new Stopwatch(), keyFile, io: scriptedInteraction({ interactive: false }) });
		expect(proposed.kind).toBe("proposed");
		expect(published).toEqual([]);
		const now = await finishRelease({ proj, mode: { kind: "approve-now" }, proposer: { name: "cli", explicit: false }, request: request({ branch: "feature-y" }), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), keyFile, noRegistry: true, io: scriptedInteraction({ answers: ["y"], secrets: [PASS] }) });
		expect(now.kind).toBe("published");
		expect(published).toHaveLength(1);
		const states = readProposals(join(proj.root, ".typetorch"));
		expect(states.map((s) => s.status).sort()).toEqual(["approved", "pending"]);
	});
	test("unsigned (approval none, no person) still publishes, without sig", async () => {
		const proj = project({ approval: "none" });
		const { oc, published } = fakeOc();
		const out = await finishRelease({ proj, mode: { kind: "unsigned" }, proposer: { name: "agent", explicit: false }, request: request(), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), io: scriptedInteraction({ interactive: false }) });
		expect(out).toMatchObject({ kind: "published", signed: false });
		expect(JSON.parse(published[0]).sig).toBeUndefined();
	});
});

describe("keys init", () => {
	test("needs a terminal; creates an encrypted key outside the repo and writes the public key", async () => {
		const proj = project();
		const keyFile = join(mkdtempSync(join(tmpdir(), "tt-home-")), "keys", "42.key");
		const args = parseArgs(["init", "--config", proj.configPath, "--key-file", keyFile], keysFlags);
		await expect(keysInit(args, scriptedInteraction({ interactive: false }))).rejects.toThrow(NotInteractiveError);
		setOutputMode({ json: true, verbose: false });
		const logs: string[] = [];
		const original = console.log;
		console.log = (line: string) => void logs.push(line);
		try {
			await keysInit(args, scriptedInteraction({ secrets: ["too short", PASS, PASS] }));
		} finally {
			console.log = original;
		}
		const file = readKeyFile(keyFile);
		expect(JSON.parse(readFileSync(proj.configPath, "utf8")).signingPublicKey).toBe(file.publicKey);
		expect(decryptKeyFile(file, PASS).publicKey).toBe(file.publicKey);
		expect(logs.join("\n")).not.toContain(PASS);
		await expect(keysInit(args, scriptedInteraction({ secrets: [PASS, PASS] }))).rejects.toThrow(/--force/);
	});
	test("refuses a key file inside the repo", async () => {
		const proj = project();
		const args = parseArgs(["init", "--config", proj.configPath, "--key-file", join(proj.root, "keys", "42.key")], keysFlags);
		await expect(keysInit(args, scriptedInteraction({ secrets: [PASS, PASS] }))).rejects.toThrow(/outside the repo/);
	});
	test("migrates a plaintext key: same public key, line removed from the env file", async () => {
		const proj = project();
		sh(proj.root, "git", "init", "-q");
		const { seed, publicKey } = generateSigningKey();
		const envFile = join(proj.root, ".env");
		writeFileSync(envFile, `OPENCLOUD_API_KEY=keep-this-0000\nTYPETORCH_SIGNING_KEY=${seed}\n`);
		useSettings(new Settings({ startDir: proj.root, env: {} }));
		const keyFile = join(mkdtempSync(join(tmpdir(), "tt-home-")), "42.key");
		setOutputMode({ json: true, verbose: false });
		const original = console.log;
		console.log = () => {};
		try {
			await keysInit(parseArgs(["init", "--config", proj.configPath, "--key-file", keyFile], keysFlags), scriptedInteraction({ answers: ["y", "y"], secrets: [PASS, PASS] }));
		} finally {
			console.log = original;
		}
		expect(readKeyFile(keyFile).publicKey).toBe(publicKey);
		expect(readFileSync(envFile, "utf8")).toBe("OPENCLOUD_API_KEY=keep-this-0000\n");
		expect(existsSync(keyFile)).toBe(true);
	});
});
