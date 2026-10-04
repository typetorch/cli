/** `typetorch pin`: signed pins on prod-channel branches (plans/03 "Signed pins"); throwaway keys only. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { pinBy, pinCommand, pinFlags, pinMessages, pinTarget } from "../src/commands/pin";
import { loadProject, type Project } from "../src/config";
import { appendLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { NotInteractiveError, scriptedInteraction } from "../src/interact";
import { newKeyFile, writeKeyFile } from "../src/keyfiles";
import { setOutputMode } from "../src/log";
import { encodePinMessage, type OpenCloud } from "../src/opencloud";
import { verifySignedPin } from "../src/signing";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

const JOB = (i: number) => `5f0c1a2b-0000-4000-8000-${String(i).padStart(12, "0")}`;

function setup(patch: Record<string, unknown> = {}) {
	const keys = mkdtempSync(join(tmpdir(), "tt-pin-keys-"));
	const main = newKeyFile("main", 42);
	const fallback = newKeyFile("fallback", 42);
	const paths = { main: join(keys, "42.key"), fallback: join(keys, "42.fallback.key") };
	writeKeyFile(paths.main, main);
	writeKeyFile(paths.fallback, fallback);
	const root = mkdtempSync(join(tmpdir(), "tt-pin-game-"));
	const raw = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, members: { "12345": "owner" }, signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555, approval: "none", ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	useSettings(new Settings({ startDir: root, env: {} }));
	const proj = loadProject(undefined, root);
	const state = join(root, ".typetorch");
	for (const [seq, branch, channel] of [[1, "prod", "prod"], [2, "dev", "dev"]] as const) {
		appendLocalLog(state, { seq, at: `2026-10-04T12:00:0${seq}.000Z`, action: "deploy", branch, channel, artifactId: `12b63b9-00000${seq}`, assetId: 900000000 + seq, commit: "12b63b9", commitHash: "", dirty: false, by: "me", universeId: 42 });
	}
	const published: { topic: string; message: any }[] = [];
	const oc = { publishMessage: async (_u: number, topic: string, m: string) => void published.push({ topic, message: JSON.parse(m) }) } as unknown as OpenCloud;
	const trust = { assetLoaded: true, publicKeys: [main.publicKey], revokedKeys: [] as string[], fallbackPublicKey: fallback.publicKey };
	return { proj, paths, state, published, oc, trust, root };
}

function run(proj: Project, argv: string[], deps: Parameters<typeof pinCommand>[1]) {
	return pinCommand(parseArgs([...argv, "--config", proj.configPath, "--no-registry"], pinFlags), deps);
}
const keyFlags = (paths: { main: string; fallback: string }) => ["--key-file", paths.main, "--fallback-key-file", paths.fallback];
const quiet = async <T>(fn: () => Promise<T>) => {
	const original = { log: console.log, error: console.error };
	console.log = () => {};
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.log = original.log;
		console.error = original.error;
	}
};

describe("pin arguments", () => {
	test("targets: --servers or --pct 1-99 for a pin; --servers or --all (pct 100) for an unpin", () => {
		expect(pinTarget({ unpin: false, servers: `${JOB(1)}, ${JOB(2)},${JOB(1)}`, all: false })).toEqual({ jobs: [JOB(1), JOB(2)] });
		expect(pinTarget({ unpin: false, pct: "10", all: false })).toEqual({ pct: 10 });
		expect(pinTarget({ unpin: true, all: true })).toEqual({ pct: 100 });
		for (const bad of [{ unpin: false, all: false }, { unpin: false, pct: "0", all: false }, { unpin: false, pct: "100", all: false }, { unpin: false, all: true }, { unpin: true, pct: "5", all: false }, { unpin: false, servers: "a,b", pct: "5", all: false }, { unpin: false, servers: "not a job!", all: false }]) {
			expect(() => pinTarget(bad as any)).toThrow(UsageError);
		}
	});
	test("by: --by, else the only owner, else the creator userId", () => {
		const { proj } = setup();
		expect(pinBy(proj)).toBe(12345);
		expect(pinBy(proj, "777")).toBe(777);
		expect(() => pinBy(proj, "me")).toThrow(UsageError);
		expect(pinBy({ config: { ...proj.config, members: {}, creator: { userId: 9 } } })).toBe(9);
		expect(() => pinBy({ config: { ...proj.config, members: {} } })).toThrow(/--by/);
	});
	test("many JobIds are split over messages that each fit 1 KiB, in order", () => {
		const jobs = Array.from({ length: 40 }, (_, i) => JOB(i));
		const chunks = pinMessages({ b: "prod", a: 900000001, by: 12345 }, { jobs }, true, 1759580240000);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.flatMap((c) => c.j)).toEqual(jobs);
		for (const c of chunks) expect(new TextEncoder().encode(encodePinMessage({ ...c, t: 1759580240000, sig: "x".repeat(88), sigF: "x".repeat(88) })).length).toBeLessThanOrEqual(1024);
	});
});

describe("typetorch pin", () => {
	test("prod-channel branch: signed with both keys (strict rule: sig once the key asset loaded, sigF before), logged", async () => {
		const { proj, paths, state, published, oc, trust } = setup();
		await quiet(() => run(proj, ["#1", "--branch", "prod", "--servers", `${JOB(1)},${JOB(2)}`, ...keyFlags(paths)], { oc, io: scriptedInteraction({ interactive: false }) }));
		expect(published).toHaveLength(1);
		const { topic, message } = published[0];
		expect(topic).toBe("TypeTorch/pin");
		expect(Object.keys(message)).toEqual(["j", "a", "b", "by", "t", "sig", "sigF"]);
		expect(message).toMatchObject({ j: [JOB(1), JOB(2)], a: 900000001, b: "prod", by: 12345 });
		expect(verifySignedPin(trust, message, message)).toBe("sig");
		expect(verifySignedPin({ ...trust, assetLoaded: false, publicKeys: [] }, message, message)).toBe("sigF");
		const log = readFileSync(join(state, "pins.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(log[0]).toMatchObject({ event: "pinned", branch: "prod", channel: "prod", assetId: 900000001, signed: true, by: 12345 });
	});
	test("unpin --all: pct 100, unpin true, no asset; signed", async () => {
		const { proj, paths, published, oc, trust } = setup();
		await quiet(() => run(proj, ["--unpin", "--all", "--branch", "prod", ...keyFlags(paths)], { oc, io: scriptedInteraction({ interactive: false }) }));
		const { message } = published[0];
		expect(Object.keys(message)).toEqual(["pct", "b", "by", "t", "unpin", "sig", "sigF"]);
		expect(message).toMatchObject({ pct: 100, unpin: true });
		expect(verifySignedPin(trust, message, message)).toBe("sig");
	});
	test("approval all: y/N at a terminal; without one it is refused (pins can't be proposed)", async () => {
		const { proj, paths, published, oc } = setup({ approval: "all" });
		await expect(run(proj, ["#1", "--branch", "prod", "--pct", "10", ...keyFlags(paths)], { oc, io: scriptedInteraction({ interactive: false }) })).rejects.toThrow(NotInteractiveError);
		await quiet(() => run(proj, ["#1", "--branch", "prod", "--pct", "10", ...keyFlags(paths)], { oc, io: scriptedInteraction({ answers: ["n"] }) }));
		expect(published).toEqual([]);
		const io = scriptedInteraction({ answers: ["y"] });
		await quiet(() => run(proj, ["#1", "--branch", "prod", "--pct", "10", ...keyFlags(paths)], { oc, io }));
		expect(published[0].message).toMatchObject({ pct: 10, a: 900000001 });
		expect(io.asked).toHaveLength(1);
	});
	test("missing keys fail before the y/N; the dev-server never pins on prod", async () => {
		const { proj, published, oc } = setup({ approval: "all" });
		const io = scriptedInteraction({ answers: ["y"] });
		const missing = mkdtempSync(join(tmpdir(), "tt-pin-none-"));
		await expect(run(proj, ["#1", "--branch", "prod", "--pct", "10", "--key-file", join(missing, "a.key"), "--fallback-key-file", join(missing, "b.key")], { oc, io })).rejects.toThrow(/no main key file/);
		expect(io.asked).toEqual([]);
		useSettings(new Settings({ startDir: proj.root, env: { TYPETORCH_PROPOSED_BY: "dev-server/claude" } }));
		await expect(run(proj, ["#1", "--branch", "prod", "--pct", "10"], { oc, io: scriptedInteraction({ answers: ["y"] }) })).rejects.toThrow(/dev-server never pins/);
		expect(published).toEqual([]);
	});
	test("dev-channel branch: unsigned and no key file is read", async () => {
		const { proj, published, oc } = setup();
		const missing = mkdtempSync(join(tmpdir(), "tt-pin-none-"));
		await quiet(() => run(proj, ["#2", "--branch", "dev", "--servers", JOB(7), "--key-file", join(missing, "a.key")], { oc, io: scriptedInteraction({ interactive: false }) }));
		expect(published[0].message).toEqual({ j: [JOB(7)], a: 900000002, b: "dev", by: 12345, t: published[0].message.t });
	});
	test("dry run: placeholders, nothing published, no log", async () => {
		const { proj, paths, state, published, oc } = setup();
		setOutputMode({ json: true, verbose: false });
		const lines: string[] = [];
		const original = console.log;
		console.log = (text: string) => void lines.push(text);
		try {
			await run(proj, ["#1", "--branch", "prod", "--pct", "5", "--dry-run", ...keyFlags(paths)], { oc });
		} finally {
			console.log = original;
		}
		const plan = JSON.parse(lines.join("\n"));
		expect(plan).toMatchObject({ dryRun: true, channel: "prod", signing: { ready: true }, target: { pct: 5 } });
		expect(plan.messages[0].sig).toStartWith("<signature");
		expect(published).toEqual([]);
		expect(existsSync(join(state, "pins.jsonl"))).toBe(false);
	});
});
