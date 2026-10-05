/**
 * Signing keys (plans/03 "Signed prod messages and heads"): key files, `keys init` / `keys init --fallback` /
 * `keys rotate` with Open Cloud mocked (fetch), and prod-only signing in releases. Every key here is a throwaway made
 * in a temp dir; HOME/USERPROFILE point at a temp dir too, so nothing can touch ~/.config/typetorch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "tt-home-"));
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

import { parseArgs } from "../src/args";
import { approveProposal, finishRelease, propose, type ReleaseRequest } from "../src/commands/approve";
import { signingStatus, withLocal } from "../src/commands/common";
import { checkPromoteChannel, ChannelGuardError } from "../src/commands/deploy";
import { keysCommand, keysFlags } from "../src/commands/keys";
import { promoteArguments } from "../src/commands/promote";
import { messageFor, release, SIGNATURE_PLACEHOLDER, SigningRequiredError } from "../src/commands/release";
import { loadProject, type Project } from "../src/config";
import { appendLocalLog, readLocalLog } from "../src/deployments";
import { readProposals } from "../src/proposals";
import { redact, Settings, useSettings } from "../src/env";
import { scriptedInteraction } from "../src/interact";
import { keyAssetRbxm, parseKeyList, readKeyAssetRbxm } from "../src/keyasset";
import {
	assertOutsideRepos,
	defaultKeyFile,
	KeyFileError,
	keyFilePath,
	loadSigner,
	newKeyFile,
	readKeyFile,
	SigningSetupError,
	writeKeyFile,
	type KeyRole,
} from "../src/keyfiles";
import { setOutputMode, Stopwatch } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import { readRegistry, type RegistryApi } from "../src/registry";
import { generateSigningKey, TEST_VECTOR_MAIN_SEED, verifySigned } from "../src/signing";

const FAKE_API_KEY = "test-api-key-not-real-0000";
const realFetch = globalThis.fetch;

afterAll(() => {
	globalThis.fetch = realFetch;
	process.env.HOME = realHome.HOME;
	process.env.USERPROFILE = realHome.USERPROFILE;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

// Fixtures ----------------------------------------------------------------------------------------------------------

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-keys-game-"));
	const raw = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t") + "\n");
	useSettings(new Settings({ startDir: root, env: { TYPETORCH_API_KEY: FAKE_API_KEY } }));
	return loadProject(undefined, root);
}

function keyDir(): string {
	return mkdtempSync(join(tmpdir(), "tt-keys-"));
}

function paths(dir: string): Record<KeyRole, string> {
	return { main: join(dir, "42.key"), fallback: join(dir, "42.fallback.key") };
}

interface Call {
	method: string;
	path: string;
	apiKey: string | null;
	json?: any;
	rbxm?: Uint8Array;
	request?: any;
}

/** A fake apis.roblox.com: asset create/PATCH, operations, moderation and messaging. No real network. */
function mockOpenCloud(options: { patchFails?: boolean; assetId?: number } = {}) {
	const calls: Call[] = [];
	const assetId = options.assetId ?? 555;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.hostname !== "apis.roblox.com") throw new Error(`unexpected host ${url.hostname}`);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const call: Call = { method, path: url.pathname, apiKey: headers.get("x-api-key") };
		if (init?.body instanceof FormData) {
			call.request = JSON.parse(String(init.body.get("request")));
			const file = init.body.get("fileContent") as Blob | null;
			if (file) call.rbxm = new Uint8Array(await file.arrayBuffer());
		} else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
		calls.push(call);
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (method === "POST" && url.pathname === "/assets/v1/assets") return json(200, { operationId: "op-create" });
		if (method === "PATCH" && url.pathname === `/assets/v1/assets/${assetId}`) {
			return options.patchFails ? json(403, { message: "Forbidden" }) : json(200, { operationId: "op-patch" });
		}
		if (method === "GET" && url.pathname === "/assets/v1/operations/op-create") {
			return json(200, { done: true, response: { assetId: String(assetId), moderationResult: { moderationState: "Approved" } } });
		}
		if (method === "GET" && url.pathname === "/assets/v1/operations/op-patch") {
			return json(200, { done: true, response: { assetId: String(assetId), revisionId: "2", moderationResult: { moderationState: "Approved" } } });
		}
		if (method === "POST" && url.pathname === "/cloud/v2/universes/42:publishMessage") return json(200, {});
		// the registry: no universe:read on this key, so releases fall back to the local log
		if (url.pathname.startsWith("/creator-configs-public-api/")) return json(403, { message: "Scope not authorized" });
		return json(404, { message: `not mocked: ${method} ${url.pathname}` });
	}) as typeof fetch;
	return calls;
}

async function keys(proj: Project, argv: string[], io = scriptedInteraction({ interactive: false })) {
	const args = parseArgs([...argv, "--config", proj.configPath], keysFlags);
	return keysCommand(args, { io });
}

/** Captures console output (to check no seed is ever printed). */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
	const lines: string[] = [];
	const original = { log: console.log, error: console.error };
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	try {
		return { result: await fn(), output: lines.join("\n") };
	} finally {
		console.log = original.log;
		console.error = original.error;
	}
}

const reload = (proj: Project) => loadProject(proj.configPath);
const seedOf = (path: string) => JSON.parse(readFileSync(path, "utf8")).seed as string;

// Key files ------------------------------------------------------------------------------------------------------------

describe("key files", () => {
	test("written plaintext outside the repo (0600 on POSIX), read back; the default path is per universe", () => {
		const dir = keyDir();
		const file = newKeyFile("main", 42);
		writeKeyFile(join(dir, "k.key"), file);
		const { info, key } = readKeyFile(join(dir, "k.key"), { role: "main", universeId: 42 });
		expect(info).toMatchObject({ role: "main", universeId: 42, publicKey: file.publicKey });
		expect(key.publicKey).toBe(file.publicKey);
		expect(JSON.parse(readFileSync(join(dir, "k.key"), "utf8"))).toMatchObject({ v: 2, kind: "typetorch-signing-key", role: "main", alg: "Ed25519" });
		if (process.platform !== "win32") expect(statSync(join(dir, "k.key")).mode & 0o777).toBe(0o600);
		expect(() => writeKeyFile(join(dir, "k.key"), newKeyFile("main", 42))).toThrow(/already exists/);
		expect(defaultKeyFile(42, "main")).toBe(join(FAKE_HOME, ".config", "typetorch", "keys", "42.key"));
		expect(defaultKeyFile(42, "fallback")).toBe(join(FAKE_HOME, ".config", "typetorch", "keys", "42.fallback.key"));
	});
	test("refused: wrong role or universe, an edited public key, a CLI 0.3 encrypted file, a test-vector key; errors never hold the seed", () => {
		const dir = keyDir();
		const file = newKeyFile("main", 42);
		writeKeyFile(join(dir, "a.key"), file);
		expect(() => readKeyFile(join(dir, "a.key"), { role: "fallback" })).toThrow(/holds the main key/);
		expect(() => readKeyFile(join(dir, "a.key"), { role: "main", universeId: 7 })).toThrow(/universe 42, not 7/);
		writeFileSync(join(dir, "b.key"), JSON.stringify({ ...file, publicKey: generateSigningKey().publicKey }));
		expect(() => readKeyFile(join(dir, "b.key"), { role: "main" })).toThrow(/does not match/);
		writeFileSync(join(dir, "c.key"), JSON.stringify({ v: 1, kind: "typetorch-signing-key", publicKey: "x", kdf: {}, cipher: {}, ciphertext: "x" }));
		expect(() => readKeyFile(join(dir, "c.key"), { role: "main" })).toThrow(/encrypted key file from CLI 0.3/);
		const vector = { ...file, seed: TEST_VECTOR_MAIN_SEED, publicKey: "ErlwbCHDCN4WvDHY6l3plaeihIONuatx2jjqoqXZiq4=" };
		writeFileSync(join(dir, "d.key"), JSON.stringify(vector));
		expect(() => readKeyFile(join(dir, "d.key"), { role: "main" })).toThrow(/test-vector/);
		writeFileSync(join(dir, "e.key"), JSON.stringify({ ...file, seed: file.seed.slice(0, 30) }));
		try {
			readKeyFile(join(dir, "e.key"), { role: "main" });
			throw new Error("should throw");
		} catch (error) {
			expect((error as Error).message).not.toContain(file.seed.slice(0, 30));
		}
		expect(() => readKeyFile(join(dir, "missing.key"), { role: "main" })).toThrow(KeyFileError);
	});
	test("never inside the project or any git work tree", () => {
		const proj = project();
		expect(() => assertOutsideRepos(join(proj.root, ".keys", "42.key"), proj.root)).toThrow(/outside the repo/);
		const repo = keyDir();
		Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
		expect(() => assertOutsideRepos(join(repo, "nested", "dir", "42.key"), proj.root)).toThrow(/git work tree/);
		expect(() => assertOutsideRepos(join(keyDir(), "new", "42.key"), proj.root)).not.toThrow();
	});
	test("paths: the flag, else the REAL environment (never an env file), else the default", () => {
		const proj = project();
		const dir = keyDir();
		writeFileSync(join(proj.root, ".env"), `TYPETORCH_KEY_FILE=${join(dir, "from-env-file.key")}\n`);
		useSettings(new Settings({ startDir: proj.root, env: {} }));
		expect(keyFilePath(proj, "main")).toBe(defaultKeyFile(42, "main"));
		useSettings(new Settings({ startDir: proj.root, env: { TYPETORCH_KEY_FILE: join(dir, "real.key"), TYPETORCH_FALLBACK_KEY_FILE: join(dir, "real-f.key") } }));
		expect(keyFilePath(proj, "main")).toBe(join(dir, "real.key"));
		expect(keyFilePath(proj, "fallback")).toBe(join(dir, "real-f.key"));
		expect(keyFilePath(proj, "main", join(dir, "flag.key"))).toBe(join(dir, "flag.key"));
	});
	test("seeds read from a key file are redacted from any error text", () => {
		const dir = keyDir();
		const file = newKeyFile("main", 42);
		writeKeyFile(join(dir, "r.key"), file);
		readKeyFile(join(dir, "r.key"), { role: "main" });
		expect(redact(`oops ${file.seed} oops`)).toBe("oops <secret> oops");
	});
});

describe("the key asset .rbxm", () => {
	test("one Model TypeTorchKeys with PublicKeys/RevokedKeys; read back; lists parse like the kernel does", () => {
		const a = generateSigningKey().publicKey;
		const b = generateSigningKey().publicKey;
		const bytes = keyAssetRbxm({ publicKeys: [a], revokedKeys: [b] });
		expect(readKeyAssetRbxm(bytes)).toEqual({ publicKeys: [a], revokedKeys: [b] });
		expect(readKeyAssetRbxm(keyAssetRbxm({ publicKeys: [a, b], revokedKeys: [] }))).toEqual({ publicKeys: [a, b], revokedKeys: [] });
		expect(parseKeyList(` ${a} ,,${b},garbage,`)).toEqual([a, b]);
		expect(parseKeyList(undefined)).toEqual([]);
		expect(() => keyAssetRbxm({ publicKeys: ["not a key"], revokedKeys: [] })).toThrow();
	});
});

// keys init / init --fallback / rotate ------------------------------------------------------------------------------

describe("keys init (main): key file, typetorch.json, key asset through Open Cloud", () => {
	test("fresh: makes the key, creates the group-owned key asset with PublicKeys = [it], records both; prints no seed", async () => {
		const proj = project();
		const dir = keyDir();
		const calls = mockOpenCloud();
		const { output } = await captureOutput(() => keys(proj, ["init", "--key-file", paths(dir).main]));
		const seed = seedOf(paths(dir).main);
		const config = reload(proj).config;
		expect(config.signingPublicKeys).toHaveLength(1);
		expect(config.keyAssetId).toBe(555);
		expect(readKeyFile(paths(dir).main, { role: "main", universeId: 42 }).info.publicKey).toBe(config.signingPublicKeys![0]);
		const create = calls.find((c) => c.method === "POST" && c.path === "/assets/v1/assets")!;
		expect(create.apiKey).toBe(FAKE_API_KEY);
		expect(create.request).toMatchObject({ assetType: "Model", displayName: "TypeTorch keys", creationContext: { creator: { groupId: "3" } } });
		expect(readKeyAssetRbxm(create.rbxm!)).toEqual({ publicKeys: config.signingPublicKeys!, revokedKeys: [] });
		expect(output).toContain(config.signingPublicKeys![0]);
		expect(output).not.toContain(seed);
		expect(readFileSync(proj.configPath, "utf8")).not.toContain(seed);
		// formatting of the rest of typetorch.json is kept
		expect(readFileSync(proj.configPath, "utf8")).toStartWith('{\n\t"project": "game",\n\t"universeId": 42,');
	});
	test("again: nothing changes and nothing is called", async () => {
		const proj = project();
		const dir = keyDir();
		mockOpenCloud();
		await captureOutput(() => keys(proj, ["init", "--key-file", paths(dir).main]));
		const before = readFileSync(proj.configPath, "utf8");
		const calls = mockOpenCloud();
		await captureOutput(() => keys(reload(proj), ["init", "--key-file", paths(dir).main]));
		expect(calls).toEqual([]);
		expect(readFileSync(proj.configPath, "utf8")).toBe(before);
	});
	test("resumes a run that stopped before the key asset existed", async () => {
		const dir = keyDir();
		const file = newKeyFile("main", 42);
		writeKeyFile(paths(dir).main, file);
		const proj = project({ signingPublicKeys: [file.publicKey] });
		const calls = mockOpenCloud();
		await captureOutput(() => keys(proj, ["init", "--key-file", paths(dir).main]));
		expect(reload(proj).config.keyAssetId).toBe(555);
		expect(calls.filter((c) => c.method === "POST" && c.path === "/assets/v1/assets")).toHaveLength(1);
	});
	test("typetorch.json lists a key but the file is gone: points at keys rotate, writes nothing", async () => {
		const proj = project({ signingPublicKeys: [generateSigningKey().publicKey], keyAssetId: 555 });
		const dir = keyDir();
		const calls = mockOpenCloud();
		await expect(keys(proj, ["init", "--key-file", paths(dir).main])).rejects.toThrow(/keys rotate/);
		expect(existsSync(paths(dir).main)).toBe(false);
		expect(calls).toEqual([]);
	});
	test("without an assets key nothing is written (no key file, no typetorch.json change)", async () => {
		const proj = project();
		useSettings(new Settings({ startDir: proj.root, env: {} }));
		const before = readFileSync(proj.configPath, "utf8");
		const dir = keyDir();
		const calls = mockOpenCloud();
		await expect(keys(proj, ["init", "--key-file", paths(dir).main])).rejects.toThrow(/no Open Cloud API key for assets/);
		expect(existsSync(paths(dir).main)).toBe(false);
		expect(readFileSync(proj.configPath, "utf8")).toBe(before);
		expect(calls).toEqual([]);
	});
	test("a key file that doesn't match typetorch.json is refused", async () => {
		const dir = keyDir();
		writeKeyFile(paths(dir).main, newKeyFile("main", 42));
		const proj = project({ signingPublicKeys: [generateSigningKey().publicKey] });
		mockOpenCloud();
		await expect(keys(proj, ["init", "--key-file", paths(dir).main])).rejects.toThrow(/not in typetorch.json "signingPublicKeys"/);
	});
});

describe("keys init --fallback", () => {
	test("makes its own key file and fallbackPublicKey; no network; again is a no-op", async () => {
		const proj = project();
		const dir = keyDir();
		const calls = mockOpenCloud();
		await captureOutput(() => keys(proj, ["init", "--fallback", "--fallback-key-file", paths(dir).fallback]));
		const config = reload(proj).config;
		expect(config.fallbackPublicKey).toBe(readKeyFile(paths(dir).fallback, { role: "fallback", universeId: 42 }).info.publicKey);
		await captureOutput(() => keys(reload(proj), ["init", "--fallback", "--fallback-key-file", paths(dir).fallback]));
		expect(reload(proj).config.fallbackPublicKey).toBe(config.fallbackPublicKey);
		expect(calls).toEqual([]);
	});
	test("a configured fallback key without its file: refused without --force", async () => {
		const proj = project({ fallbackPublicKey: generateSigningKey().publicKey });
		await expect(keys(proj, ["init", "--fallback", "--fallback-key-file", paths(keyDir()).fallback])).rejects.toThrow(/--force/);
	});
	test("--force: revokes the old fallback in the key asset (PATCH), sends the rekey hint, then makes a new pair", async () => {
		const dir = keyDir();
		const main = newKeyFile("main", 42);
		const oldFallback = newKeyFile("fallback", 42);
		writeKeyFile(paths(dir).main, main);
		writeKeyFile(paths(dir).fallback, oldFallback);
		const proj = project({ signingPublicKeys: [main.publicKey], fallbackPublicKey: oldFallback.publicKey, keyAssetId: 555 });
		// without --yes and without a terminal: refused before anything changes
		const none = mockOpenCloud();
		await expect(keys(proj, ["init", "--fallback", "--force", "--fallback-key-file", paths(dir).fallback])).rejects.toThrow(/--yes/);
		expect(none).toEqual([]);
		const calls = mockOpenCloud();
		const { output } = await captureOutput(() => keys(proj, ["init", "--fallback", "--force", "--yes", "--fallback-key-file", paths(dir).fallback]));
		const config = reload(proj).config;
		expect(config.fallbackPublicKey).not.toBe(oldFallback.publicKey);
		expect(config.revokedKeys).toEqual([oldFallback.publicKey]);
		const patch = calls.find((c) => c.method === "PATCH")!;
		expect(patch.path).toBe("/assets/v1/assets/555");
		expect(readKeyAssetRbxm(patch.rbxm!)).toEqual({ publicKeys: [main.publicKey], revokedKeys: [oldFallback.publicKey] });
		const rekey = calls.find((c) => c.path.endsWith(":publishMessage"))!;
		expect(rekey.json.topic).toBe("TypeTorch/rekey");
		expect(Object.keys(JSON.parse(rekey.json.message))).toEqual(["t"]);
		expect(readKeyFile(paths(dir).fallback, { role: "fallback" }).info.publicKey).toBe(config.fallbackPublicKey!);
		expect(output).toContain("kernel deploy");
		expect(output).not.toContain(seedOf(paths(dir).fallback));
	});
});

describe("keys rotate re-signs the current prod heads; keys resign", () => {
	const head = (branch: string, seq: number, channel: "prod" | "dev" = "prod") => ({
		seq,
		at: `2026-10-04T12:00:0${seq}.000Z`,
		action: "deploy" as const,
		branch,
		channel,
		artifactId: `12b63b9-00000${seq}`,
		assetId: 900000000 + seq,
		commit: "12b63b9",
		commitHash: "12b63b9".padEnd(40, "0"),
		dirty: false,
		by: "me",
		universeId: 42,
	});
	function withHeads(approval: "none" | "all") {
		const dir = keyDir();
		const main = newKeyFile("main", 42);
		const fallback = newKeyFile("fallback", 42);
		writeKeyFile(paths(dir).main, main);
		writeKeyFile(paths(dir).fallback, fallback);
		const proj = project({ signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555, approval, channels: { prod: "prod", staging: "prod" } });
		const state = join(proj.root, ".typetorch");
		appendLocalLog(state, head("prod", 1));
		appendLocalLog(state, head("staging", 2));
		appendLocalLog(state, head("dev", 3, "dev"));
		appendLocalLog(state, head("prod", 4));
		return { dir, main, fallback, proj, state };
	}
	const deployMessages = (calls: Call[]) => calls.filter((c) => c.json?.topic === "TypeTorch/deploy").map((c) => JSON.parse(c.json.message));
	const keyFlags = (dir: string) => ["--key-file", paths(dir).main, "--fallback-key-file", paths(dir).fallback];

	test("approval none: each prod-channel head goes out again: same artifact and asset, new seq, r = resign, signed with the NEW key", async () => {
		const { dir, main, proj, state } = withHeads("none");
		const calls = mockOpenCloud();
		await captureOutput(() => keys(proj, ["rotate", "--yes", ...keyFlags(dir)]));
		const fresh = reload(proj).config.signingPublicKeys![0];
		const messages = deployMessages(calls);
		expect(messages.map((m) => [m.b, m.a, m.i, m.s, m.r])).toEqual([
			["prod", 900000004, "12b63b9-000004", 5, "resign"],
			["staging", 900000002, "12b63b9-000002", 6, "resign"],
		]);
		const trust = { assetLoaded: true, publicKeys: [fresh], revokedKeys: [main.publicKey] };
		for (const m of messages) expect(verifySigned(trust, m, m)).toBe("sig");
		// the dev-channel head is left alone; the old prod head no longer verifies under the rotated key set
		expect(messages.some((m) => m.b === "dev")).toBe(false);
		const log = readLocalLog(state, 42);
		expect(log.filter((e) => e.action === "resign").map((e) => [e.branch, e.seq, e.fromArtifactId, e.r])).toEqual([
			["prod", 5, "12b63b9-000004", "resign"],
			["staging", 6, "12b63b9-000002", "resign"],
		]);
		// the order: PATCH the key asset, the rekey hint, then the re-signed heads
		const order = calls.map((c) => (c.method === "PATCH" ? "patch" : c.json?.topic)).filter(Boolean);
		expect(order).toEqual(["patch", "TypeTorch/rekey", "TypeTorch/deploy", "TypeTorch/deploy"]);
	});
	test("approval all, nobody at a terminal: the re-signs become proposals; approve publishes them signed", async () => {
		const { dir, proj, state } = withHeads("all");
		const calls = mockOpenCloud();
		await captureOutput(() => keys(proj, ["rotate", "--yes", ...keyFlags(dir)]));
		expect(deployMessages(calls)).toEqual([]);
		const pending = readProposals(state).filter((p) => p.status === "pending");
		expect(pending.map((p) => [p.proposal.kind, p.proposal.branch, p.proposal.artifact.assetId])).toEqual([
			["resign", "prod", 900000004],
			["resign", "staging", 900000002],
		]);
		const published: string[] = [];
		const oc = { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud;
		const fresh = reload(proj);
		await captureOutput(() => approveProposal(fresh, pending[0], { io: scriptedInteraction({ answers: ["y"] }), oc, noRegistry: true, keyPaths: paths(dir) }));
		const message = JSON.parse(published[0]);
		expect(message).toMatchObject({ b: "prod", a: 900000004, r: "resign", s: 5 });
		expect(verifySigned({ assetLoaded: true, publicKeys: fresh.config.signingPublicKeys!, revokedKeys: fresh.config.revokedKeys! }, message, message)).toBe("sig");
	});
	test("a re-sign proposal whose branch moved since is refused", async () => {
		const { dir, proj, state } = withHeads("all");
		mockOpenCloud();
		await captureOutput(() => keys(proj, ["resign", ...keyFlags(dir)]));
		const pending = readProposals(state).find((p) => p.status === "pending" && p.proposal.branch === "prod")!;
		appendLocalLog(state, head("prod", 9));
		const oc = { publishMessage: async () => {} } as unknown as OpenCloud;
		await expect(approveProposal(reload(proj), pending, { io: scriptedInteraction({ answers: ["y"] }), oc, noRegistry: true, keyPaths: paths(dir) })).rejects.toThrow(/moved since/);
	});
	test("keys resign alone re-signs the live prod heads with the current keys", async () => {
		const { dir, main, proj } = withHeads("none");
		const calls = mockOpenCloud();
		await captureOutput(() => keys(proj, ["resign", ...keyFlags(dir)]));
		const messages = deployMessages(calls);
		expect(messages.map((m) => [m.b, m.s, m.r])).toEqual([
			["prod", 5, "resign"],
			["staging", 6, "resign"],
		]);
		expect(verifySigned({ assetLoaded: true, publicKeys: [main.publicKey], revokedKeys: [] }, messages[0], messages[0])).toBe("sig");
	});
});

describe("keys rotate", () => {
	function rotated() {
		const dir = keyDir();
		const main = newKeyFile("main", 42);
		const fallback = newKeyFile("fallback", 42);
		writeKeyFile(paths(dir).main, main);
		writeKeyFile(paths(dir).fallback, fallback);
		const proj = project({ signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555 });
		return { dir, main, fallback, proj };
	}
	test("new main key: PATCH (PublicKeys = new, old revoked), key file replaced, typetorch.json updated, TypeTorch/rekey {t}", async () => {
		const { dir, main, fallback, proj } = rotated();
		const calls = mockOpenCloud();
		const { output } = await captureOutput(() => keys(proj, ["rotate", "--yes", "--key-file", paths(dir).main]));
		const config = reload(proj).config;
		const fresh = readKeyFile(paths(dir).main, { role: "main", universeId: 42 }).info.publicKey;
		expect(fresh).not.toBe(main.publicKey);
		expect(config.signingPublicKeys).toEqual([fresh]);
		expect(config.revokedKeys).toEqual([main.publicKey]);
		expect(config.fallbackPublicKey).toBe(fallback.publicKey); // the fallback is never revoked by a rotation
		const patch = calls.find((c) => c.method === "PATCH")!;
		expect(patch.request).toEqual({ assetId: 555 });
		expect(readKeyAssetRbxm(patch.rbxm!)).toEqual({ publicKeys: [fresh], revokedKeys: [main.publicKey] });
		const rekey = calls.find((c) => c.path === "/cloud/v2/universes/42:publishMessage")!;
		expect(rekey.json.topic).toBe("TypeTorch/rekey");
		expect(JSON.parse(rekey.json.message).t).toBeNumber();
		// order: the key asset changes before the hint
		expect(calls.findIndex((c) => c.method === "PATCH")).toBeLessThan(calls.indexOf(rekey));
		expect(existsSync(`${paths(dir).main}.new`)).toBe(false);
		expect(output).not.toContain(seedOf(paths(dir).main));
		// prod deploys now sign with the new main key (and the same fallback)
		const signer = loadSigner(reload(proj), paths(dir));
		expect(signer.main.publicKey).toBe(fresh);
	});
	test("a lost main key: rotate works without the old file", async () => {
		const { dir, main, proj } = rotated();
		const lost = join(keyDir(), "gone.key");
		mockOpenCloud();
		await captureOutput(() => keys(proj, ["rotate", "--yes", "--key-file", lost]));
		expect(reload(proj).config.revokedKeys).toEqual([main.publicKey]);
		expect(readKeyFile(lost, { role: "main" }).info.publicKey).toBe(reload(proj).config.signingPublicKeys![0]);
		expect(existsSync(paths(dir).main)).toBe(true);
	});
	test("a failed PATCH changes nothing: same key file, same typetorch.json, no rekey, no leftover", async () => {
		const { dir, proj } = rotated();
		const before = { key: readFileSync(paths(dir).main, "utf8"), config: readFileSync(proj.configPath, "utf8") };
		const calls = mockOpenCloud({ patchFails: true });
		await expect(captureOutput(() => keys(proj, ["rotate", "--yes", "--key-file", paths(dir).main]))).rejects.toThrow(/nothing changed/);
		expect(readFileSync(paths(dir).main, "utf8")).toBe(before.key);
		expect(readFileSync(proj.configPath, "utf8")).toBe(before.config);
		expect(calls.some((c) => c.path.endsWith(":publishMessage"))).toBe(false);
		expect(existsSync(`${paths(dir).main}.new`)).toBe(false);
	});
	test("asks y/N at a terminal; refuses without --yes when nobody can answer; needs keys init first", async () => {
		const { dir, proj } = rotated();
		const calls = mockOpenCloud();
		await expect(keys(proj, ["rotate", "--key-file", paths(dir).main])).rejects.toThrow(/--yes/);
		await expect(keys(proj, ["rotate", "--key-file", paths(dir).main], scriptedInteraction({ answers: ["n"] }))).rejects.toThrow(/cancelled/);
		expect(calls).toEqual([]);
		await captureOutput(() => keys(proj, ["rotate", "--key-file", paths(dir).main], scriptedInteraction({ answers: ["y"] })));
		expect(calls.some((c) => c.method === "PATCH")).toBe(true);
		await expect(keys(project(), ["rotate", "--yes", "--key-file", paths(keyDir()).main])).rejects.toThrow(/keys init/);
	});
});

// Releases: prod signed, dev unsigned ---------------------------------------------------------------------------------

describe("prod-only signing in releases", () => {
	const artifact = { artifactId: "12b63b9-8be210", assetId: 777, channel: "prod" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false };

	function signedProject() {
		const dir = keyDir();
		const main = newKeyFile("main", 42);
		const fallback = newKeyFile("fallback", 42);
		writeKeyFile(paths(dir).main, main);
		writeKeyFile(paths(dir).fallback, fallback);
		const proj = project({ signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555, approval: "none" });
		const published: string[] = [];
		const oc = { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud;
		const trust = { assetLoaded: true, publicKeys: [main.publicKey], revokedKeys: [], fallbackPublicKey: fallback.publicKey };
		return { dir, main, fallback, proj, oc, published, trust };
	}
	const request = (patch: Partial<ReleaseRequest> = {}): ReleaseRequest => ({ kind: "deploy", branch: "prod", branchChannel: "prod", artifact, force: false, by: "me", ...patch });

	test("a prod-channel release is signed with both keys; the registry head carries sig/sigF, the list doesn't", async () => {
		const { dir, proj, oc, published, trust } = signedProject();
		let written: any;
		const api = {
			getPublished: async () => ({ entries: {}, exists: true, configVersion: 1 }),
			getDraft: async () => ({ exists: true, entries: {} }),
			patchDraft: async (entries: Record<string, unknown>) => {
				written = entries.TypeTorch;
				return "hash";
			},
			publish: async () => 2,
		} as unknown as RegistryApi;
		const snapshot = await readRegistry(api);
		const signer = loadSigner(proj, paths(dir));
		await captureOutput(() => release({ proj, oc, api, history: withLocal(proj, snapshot), action: "deploy", branch: "prod", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "prod", signer }));
		const message = JSON.parse(published[0]);
		expect(Object.keys(message)).toEqual(["b", "a", "i", "s", "c", "ch", "t", "sig", "sigF"]);
		expect(verifySigned(trust, message, message)).toBe("sig");
		expect(verifySigned({ ...trust, assetLoaded: false, publicKeys: [] }, message, message)).toBe("sigF");
		const head = written.branches.prod;
		expect(head).toMatchObject({ sig: message.sig, sigF: message.sigF, t: message.t });
		// the head verifies exactly like the message: b = its key, a/i/s/c/ch/t/r from the head
		expect(verifySigned(trust, { b: "prod", a: head.assetId, i: head.artifactId, s: head.seq, c: head.commit, ch: head.channel, t: head.t }, head)).toBe("sig");
		expect(written.deployments[0].sig).toBeUndefined();
		expect(readLocalLog(join(proj.root, ".typetorch"))[0].sig).toBe(message.sig);
	});
	test("prod without a signer is refused before anything is published", async () => {
		const { proj, oc, published } = signedProject();
		await expect(release({ proj, oc, history: withLocal(proj, undefined), action: "deploy", branch: "prod", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "prod" })).rejects.toThrow(SigningRequiredError);
		expect(published).toEqual([]);
	});
	test("a dev-channel release is unsigned even when a signer is around", async () => {
		const { dir, proj, oc, published } = signedProject();
		await captureOutput(() =>
			release({ proj, oc, history: withLocal(proj, undefined), action: "deploy", branch: "dev", artifact: { ...artifact, channel: "dev" }, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev", signer: loadSigner(proj, paths(dir)) }),
		);
		expect(JSON.parse(published[0]).sig).toBeUndefined();
		expect(JSON.parse(published[0]).sigF).toBeUndefined();
	});
	test("finishRelease (approval none): prod reads the key files and signs; dev never reads them", async () => {
		const { dir, proj, oc, published, trust } = signedProject();
		const missing = paths(keyDir()); // no files there
		await captureOutput(() => finishRelease({ proj, mode: { kind: "publish" }, proposer: { name: "cli", explicit: false }, request: request({ branch: "dev", branchChannel: "dev", artifact: { ...artifact, channel: "dev" } }), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), keyPaths: missing }));
		expect(JSON.parse(published[0]).sig).toBeUndefined();
		await expect(finishRelease({ proj, mode: { kind: "publish" }, proposer: { name: "cli", explicit: false }, request: request(), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), keyPaths: missing })).rejects.toThrow(SigningSetupError);
		expect(published).toHaveLength(1);
		await captureOutput(() => finishRelease({ proj, mode: { kind: "publish" }, proposer: { name: "agent", explicit: false }, request: request(), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), keyPaths: paths(dir) }));
		expect(verifySigned(trust, JSON.parse(published[1]), JSON.parse(published[1]))).toBe("sig");
	});
	test("the dev-server never publishes to a prod-channel branch", async () => {
		const { dir, proj, oc, published } = signedProject();
		await expect(finishRelease({ proj, mode: { kind: "publish" }, proposer: { name: "dev-server/claude", explicit: true }, request: request(), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), keyPaths: paths(dir) })).rejects.toThrow(/dev-server never publishes/);
		expect(published).toEqual([]);
	});
	test("approve: a prod proposal is signed at publish; missing keys fail before the y/N", async () => {
		const { dir, proj, oc, published, trust } = signedProject();
		// (the cloud test is recorded as skipped: this test is about signing; test/cloudtest.test.ts covers the gate)
		const p = propose(proj, { ...request(), test: { skipped: "signing test", at: new Date().toISOString() } }, { name: "agent", explicit: false });
		const early = scriptedInteraction({ answers: ["y"] });
		await expect(approveProposal(proj, { proposal: p, status: "pending" }, { io: early, oc, noRegistry: true, keyPaths: paths(keyDir()) })).rejects.toThrow(SigningSetupError);
		expect(early.asked).toEqual([]);
		await captureOutput(() => approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["y"] }), oc, noRegistry: true, keyPaths: paths(dir) }));
		const message = JSON.parse(published[0]);
		expect(verifySigned(trust, message, message)).toBe("sig");
		// the proposal itself never holds a signature
		expect(readFileSync(join(proj.root, ".typetorch", "proposals.jsonl"), "utf8")).not.toContain(message.sig);
	});
	test("loadSigner: keys must match typetorch.json, not be revoked, and differ", () => {
		const { dir, main, fallback } = signedProject();
		const base = { universeId: 42, signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey } as any;
		expect(loadSigner({ config: base }, paths(dir)).files.main.publicKey).toBe(main.publicKey);
		expect(() => loadSigner({ config: { ...base, signingPublicKeys: [generateSigningKey().publicKey] } }, paths(dir))).toThrow(/not in typetorch.json "signingPublicKeys"/);
		expect(() => loadSigner({ config: { ...base, fallbackPublicKey: generateSigningKey().publicKey } }, paths(dir))).toThrow(/not typetorch.json "fallbackPublicKey"/);
		expect(() => loadSigner({ config: { ...base, revokedKeys: [main.publicKey] } }, paths(dir))).toThrow(/revoked/);
		expect(() => loadSigner({ config: { ...base, signingPublicKeys: undefined } }, paths(dir))).toThrow(/keys init/);
		expect(() => loadSigner({ config: base }, { main: paths(dir).main, fallback: join(keyDir(), "none.key") })).toThrow(/keys init --fallback --force/);
	});
	test("dry runs never sign: placeholders of signature size, and a readiness report", () => {
		const { dir, proj } = signedProject();
		const entry = { seq: 3, at: "", action: "deploy" as const, branch: "prod", channel: "prod" as const, artifactId: artifact.artifactId, assetId: 1, commit: "12b63b9", commitHash: "", dirty: false, by: "me" };
		const message = messageFor({ ...entry }, undefined, { placeholders: true });
		expect(message.sig).toBe(SIGNATURE_PLACEHOLDER);
		expect(SIGNATURE_PLACEHOLDER).toHaveLength(88);
		expect(signingStatus(proj, "prod", paths(dir))).toMatchObject({ required: true, ready: true });
		expect(signingStatus(proj, "prod", paths(keyDir()))).toMatchObject({ required: true, ready: false });
		expect(signingStatus(proj, "dev", paths(keyDir()))).toEqual({ required: false });
	});
});

describe("promote: prod branches take only prod-channel artifacts", () => {
	test("a dev-channel artifact to a prod-channel branch says rebuild for prod, even with --force", () => {
		expect(() => checkPromoteChannel({ branch: "prod", branchChannel: "prod", artifactId: "12b63b9-3fa91c", artifactChannel: "dev" })).toThrow(/rebuild for prod/i);
		expect(() => checkPromoteChannel({ branch: "prod", branchChannel: "prod", artifactId: "12b63b9-3fa91c", artifactChannel: "dev" })).toThrow(ChannelGuardError);
		expect(() => checkPromoteChannel({ branch: "prod", branchChannel: "prod", artifactId: "12b63b9-8be210", artifactChannel: "prod" })).not.toThrow();
		expect(() => checkPromoteChannel({ branch: "dev", branchChannel: "dev", artifactId: "12b63b9-3fa91c", artifactChannel: "dev" })).not.toThrow();
	});
	test("an approval of an old dev-artifact promote proposal is refused the same way", async () => {
		const proj = project({ approval: "all" });
		const p = propose(proj, { kind: "promote", branch: "prod", branchChannel: "prod", artifact: { artifactId: "12b63b9-3fa91c", assetId: 5, channel: "dev", commit: "12b63b9", commitHash: "", dirty: false }, force: true, by: "me" }, { name: "agent", explicit: false });
		const oc = { publishMessage: async () => {} } as unknown as OpenCloud;
		await expect(approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["y"] }), oc, noRegistry: true })).rejects.toThrow(/rebuild for prod/);
	});
	test("promote <artifact> <branch> works when only the second argument is a known branch", () => {
		const known = new Set(["prod", "dev"]);
		expect(promoteArguments("prod", "12b63b9-8be210", known)).toEqual({ branch: "prod", wanted: "12b63b9-8be210", swapped: false });
		expect(promoteArguments("12b63b9-8be210", "prod", known)).toEqual({ branch: "prod", wanted: "12b63b9-8be210", swapped: true });
		expect(promoteArguments("dev", "prod", known)).toEqual({ branch: "dev", wanted: "prod", swapped: false });
	});
});

beforeAll(() => mkdirSync(join(FAKE_HOME, ".config"), { recursive: true }));
