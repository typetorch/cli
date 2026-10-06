/**
 * The signed settings record (kernel 0.3.8, plans/20; settings.ts, commands/settings.ts): the canonical string,
 * signing and the strict verify rule, the kernel's fixtures signed byte for byte, read-verify-change-sign-write with
 * conflicts and refusals, the ping, masking, and the commands (set/get/unset/push/status, access push, fleet setup).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { accessCommand, accessFlags } from "../src/commands/access";
import { fleetCommand, fleetFlags } from "../src/commands/fleet";
import { changeSettings, settingsCommand, settingsFlags } from "../src/commands/settings";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { setOutputMode } from "../src/log";
import {
	bodyProblems,
	describeFields,
	encodeBody,
	maskSecrets,
	parseRecord,
	readSettings,
	settingsCanonical,
	settingsPing,
	signSettings,
	verifySettingsRecord,
	writeSettings,
	type SettingsRecord,
} from "../src/settings";
import { generateSigningKey, parseSigningKey, verifyCanonicalStrict, type DualSigner } from "../src/signing";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";
import { FIXTURE_BODIES, fixtures } from "./fixtures/settings-fixtures";

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-settings-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod", dev: "dev" }, approval: "none", ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	const { config, errors } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings: [] };
}

async function run<T>(proj: Project, fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const lines: string[] = [];
	const log = console.log;
	const err = console.error;
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	const cwd = process.cwd();
	process.chdir(proj.root);
	try {
		const result = await fn();
		return { result, out: lines.join("\n") };
	} finally {
		process.chdir(cwd);
		console.log = log;
		console.error = err;
	}
}

const AT = () => new Date("2026-10-06T12:00:00.000Z");

describe("the record", () => {
	test("canonical string: tt1settings \\n seq \\n at \\n body; bad seq or a newline in `at` throw", () => {
		expect(settingsCanonical(3, "2026-10-06T12:00:00.000Z", '{"a":1}')).toBe('tt1settings\n3\n2026-10-06T12:00:00.000Z\n{"a":1}');
		expect(() => settingsCanonical(0, "x", "{}")).toThrow();
		expect(() => settingsCanonical(1.5, "x", "{}")).toThrow();
		expect(() => settingsCanonical(1, "a\nb", "{}")).toThrow();
	});
	test("the body is JSON with sorted keys at every level", () => {
		expect(encodeBody({ game: { b: 1, a: { d: 2, c: 3 } }, defaultBranch: "prod" })).toBe('{"defaultBranch":"prod","game":{"a":{"c":3,"d":2},"b":1}}');
	});
	test("both keys sign; the kernel's strict rule accepts sig once the key asset loaded, else sigF", () => {
		const signer = newSigner();
		const record = signSettings(signer, 7, "2026-10-06T12:00:00.000Z", { game: { x: 1 } });
		const canonical = settingsCanonical(record.seq, record.at, record.body);
		const trust = { assetLoaded: true, publicKeys: [signer.main.publicKey], revokedKeys: [], fallbackPublicKey: signer.fallback.publicKey };
		expect(verifyCanonicalStrict(trust, canonical, record)).toBe("sig");
		expect(verifyCanonicalStrict({ ...trust, assetLoaded: false, publicKeys: [] }, canonical, record)).toBe("sigF");
		expect(verifySettingsRecord(record, { main: signer.main.publicKey })).toBe("sig");
		expect(verifySettingsRecord(record, { fallback: signer.fallback.publicKey })).toBe("sigF");
		const tampered = { ...record, body: record.body.replace("1", "2") };
		expect(verifySettingsRecord(tampered, { main: signer.main.publicKey, fallback: signer.fallback.publicKey })).toBeUndefined();
		expect(verifySettingsRecord({ ...record, seq: 8 }, { main: signer.main.publicKey, fallback: signer.fallback.publicKey })).toBeUndefined();
	});
	test("the kernel's smoke fixtures are exactly what this CLI signs (kernel/scripts/smoke-settings.json)", () => {
		const made = fixtures();
		expect(Object.keys(made).sort()).toEqual(Object.keys(FIXTURE_BODIES).sort());
		const kernelFile = join(import.meta.dir, "..", "..", "kernel", "scripts", "smoke-settings.json");
		if (!existsSync(kernelFile)) return; // (no sibling kernel checkout here)
		expect(JSON.parse(readFileSync(kernelFile, "utf8"))).toEqual(JSON.parse(JSON.stringify(made)));
	});
	test("parseRecord refuses what isn't a v1 record", () => {
		expect(parseRecord(undefined).problem).toBeDefined();
		expect(parseRecord({ v: 2 }).problem).toContain("v1");
		expect(parseRecord({ v: 1, seq: 1, at: "x", body: "not json" }).problem).toContain("JSON");
		expect(parseRecord({ v: 1, seq: 1, at: "x", body: "[1]" }).problem).toContain("object");
		expect(parseRecord({ v: 1, seq: 2, at: "x", body: '{"a":1}', sig: "s", sigF: "f" }).body).toEqual({ a: 1 } as never);
	});
	test("caps and shapes: game over 16 KB, bad game keys, bad channels", () => {
		expect(bodyProblems({ game: { big: "x".repeat(17_000) } })[0]).toContain("over 16384");
		expect(bodyProblems({ game: { "bad key": 1 } })[0]).toContain("game key");
		expect(bodyProblems({ channels: { x: "staging" as "dev" } })[0]).toContain("prod or dev");
		expect(bodyProblems({ defaultBranch: "prod", game: { "shop.price": 50 } })).toEqual([]);
	});
	test("tokens are masked; field lines never hold a token", () => {
		const body = { fleet: { url: "https://fleet.example/api", token: "fleet-secret-123" }, analytics: { backend: "duckdb", events: "https://a.example/v1/ingest", token: "analytics-secret-123" }, game: { apiKey: "game-secret", price: 5 } };
		const masked = JSON.stringify(maskSecrets(body));
		expect(masked).not.toContain("secret");
		expect(masked).toContain('"price":5');
		expect(describeFields(body).join("\n")).not.toContain("secret");
		expect(describeFields(body).join("\n")).toContain("fleet.example");
	});
	test("the ping is {k:settings, s:seq}", () => {
		expect(JSON.parse(settingsPing(12))).toEqual({ k: "settings", s: 12 });
	});
});

describe("writes", () => {
	test("no record: seq 1, signed; then seq 2; an unchanged body writes nothing", async () => {
		const signer = newSigner();
		const cloud = fakeDataStoreCloud();
		const first = await writeSettings(cloud.oc, 42, signer, (body) => ({ ...body, defaultBranch: "prod" }), { now: AT });
		expect(first).toMatchObject({ outcome: "written", seq: 1 });
		const stored = cloud.values.settings as SettingsRecord;
		expect(stored).toMatchObject({ v: 1, seq: 1, at: "2026-10-06T12:00:00.000Z", body: '{"defaultBranch":"prod"}' });
		expect(verifySettingsRecord(stored, { main: signer.main.publicKey })).toBe("sig");
		const second = await writeSettings(cloud.oc, 42, signer, (body) => ({ ...body, game: { a: 1 } }), { now: AT });
		expect(second).toMatchObject({ outcome: "written", seq: 2, before: { defaultBranch: "prod" }, after: { defaultBranch: "prod", game: { a: 1 } } });
		const same = await writeSettings(cloud.oc, 42, signer, (body) => ({ ...body }), { now: AT });
		expect(same).toMatchObject({ outcome: "unchanged", seq: 2 });
		expect((cloud.values.settings as SettingsRecord).seq).toBe(2);
		const resigned = await writeSettings(cloud.oc, 42, signer, (body) => body, { now: AT, resign: true });
		expect(resigned).toMatchObject({ outcome: "written", seq: 3 });
	});
	test("a record other keys signed, or junk, is refused; --force replaces it", async () => {
		const mine = newSigner();
		const theirs = newSigner();
		const cloud = fakeDataStoreCloud({ settings: signSettings(theirs, 4, "x", { game: { a: 1 } }) });
		const refused = await writeSettings(cloud.oc, 42, mine, (body) => ({ ...body, game: { a: 2 } }));
		expect(refused.untrusted).toBe(true);
		expect(refused.error).toContain("isn't signed by your keys");
		expect((cloud.values.settings as SettingsRecord).seq).toBe(4);
		const forced = await writeSettings(cloud.oc, 42, mine, (body) => ({ ...body, access: { members: { "1": "dev" }, revoked: {}, devBadgeId: null } }), { force: true });
		// The untrusted record's fields are dropped, never re-signed with our keys.
		expect(forced).toMatchObject({ outcome: "written", seq: 5, untrusted: true, dropped: ["game"] });
		expect(forced.after).toEqual({ access: { members: { "1": "dev" }, revoked: {}, devBadgeId: null } });
		expect(verifySettingsRecord(cloud.values.settings as SettingsRecord, { main: mine.main.publicKey })).toBe("sig");
		const junk = fakeDataStoreCloud({ settings: { hello: "game code wrote this" } });
		expect((await writeSettings(junk.oc, 42, mine, (body) => body)).error).toContain("isn't a usable record");
	});
	test("a record signed with our fallback key only still counts as ours (after a main key rotation)", async () => {
		const old = newSigner();
		const rotated: DualSigner = { main: parseSigningKey(generateSigningKey().seed), fallback: old.fallback };
		const cloud = fakeDataStoreCloud({ settings: signSettings(old, 3, "x", { game: { a: 1 } }) });
		expect(await writeSettings(cloud.oc, 42, rotated, (body) => body, { resign: true })).toMatchObject({ outcome: "written", seq: 4 });
		expect(verifySettingsRecord(cloud.values.settings as SettingsRecord, { main: rotated.main.publicKey })).toBe("sig");
	});
	test("a write in between (another machine) is retried on the newer record", async () => {
		const signer = newSigner();
		const cloud = fakeDataStoreCloud({ settings: signSettings(signer, 1, "x", { game: { a: 1 } }) });
		cloud.serverWrites("settings", () => signSettings(signer, 2, "y", { game: { a: 1, b: 2 } }));
		const result = await writeSettings(cloud.oc, 42, signer, (body) => ({ ...body, game: { ...body.game, c: 3 } }));
		expect(result).toMatchObject({ outcome: "written", seq: 3 });
		expect(JSON.parse((cloud.values.settings as SettingsRecord).body).game).toEqual({ a: 1, b: 2, c: 3 });
	});
	test("over the caps: refused, nothing written; a missing scope says so", async () => {
		const signer = newSigner();
		const cloud = fakeDataStoreCloud();
		const big = await writeSettings(cloud.oc, 42, signer, () => ({ game: { big: "x".repeat(20_000) } }));
		expect(big.error).toContain("over 16384");
		expect(cloud.values.settings).toBeUndefined();
		const denied = fakeDataStoreCloud({}, { status: 403 });
		expect(await writeSettings(denied.oc, 42, signer, (body) => body)).toMatchObject({ scopeMissing: true });
		expect((await readSettings(denied.oc, 42)).scopeMissing).toBe(true);
	});
	test("changeSettings pings TypeTorch/deploy with the new seq (and not with --no-ping or when nothing changed)", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = fakeDataStoreCloud();
		const result = await changeSettings({ proj, oc: cloud.oc, signer, what: "test", mutate: (body) => ({ ...body, game: { a: 1 } }) });
		expect(result).toMatchObject({ outcome: "written", seq: 1, pinged: true });
		expect(cloud.published).toEqual([{ topic: "TypeTorch/deploy", message: '{"k":"settings","s":1}' }]);
		await changeSettings({ proj, oc: cloud.oc, signer, what: "test", mutate: (body) => body });
		await changeSettings({ proj, oc: cloud.oc, signer, what: "test", noPing: true, mutate: (body) => ({ ...body, game: { a: 2 } }) });
		expect(cloud.published).toHaveLength(1);
	});
});

describe("commands", () => {
	setOutputMode({ json: false, verbose: false });
	test("settings set/get/unset game values; status; values never need a token in the command line", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = fakeDataStoreCloud();
		const deps = { oc: cloud.oc, signer, now: AT };
		await run(proj, () => settingsCommand(parseArgs(["set", "game.shop.price", "75"], settingsFlags), deps));
		await run(proj, () => settingsCommand(parseArgs(["set", "game.flags", '{"pvp":true}'], settingsFlags), deps));
		const got = await run(proj, () => settingsCommand(parseArgs(["get", "game.shop.price"], settingsFlags), deps));
		expect(got.out.trim()).toBe("75");
		const stdin = '{"backend":"duckdb","events":"https://a.example/v1/ingest","token":"analytics-secret-0123456789"}';
		const set = await run(proj, () => settingsCommand(parseArgs(["set", "analytics", "-"], settingsFlags), { ...deps, stdin: async () => stdin }));
		expect(set.out).toContain("settings #3");
		const status = await run(proj, () => settingsCommand(parseArgs(["status"], settingsFlags), deps));
		expect(status.out).toContain("settings #3");
		expect(status.out).toContain("verified by your main key");
		expect(status.out).not.toContain("analytics-secret");
		const all = await run(proj, () => settingsCommand(parseArgs(["get"], settingsFlags), deps));
		expect(all.out).not.toContain("analytics-secret");
		expect(all.out).toContain("hidden");
		await run(proj, () => settingsCommand(parseArgs(["unset", "game.flags"], settingsFlags), deps));
		const body = JSON.parse((cloud.values.settings as SettingsRecord).body);
		expect(body.game).toEqual({ "shop.price": 75 });
		expect(body.analytics.token).toBe("analytics-secret-0123456789");
		expect(cloud.published.map((p) => JSON.parse(p.message).s)).toEqual([1, 2, 3, 4]);
		await expect(run(proj, () => settingsCommand(parseArgs(["set", "fleet", "{}"], settingsFlags), deps))).rejects.toThrow(/fleet setup/);
		await expect(run(proj, () => settingsCommand(parseArgs(["set", "game.x", "{bad"], settingsFlags), deps))).rejects.toThrow(/valid JSON/);
	});
	test("settings push: defaultBranch, channels and access from typetorch.json", async () => {
		const proj = project({ defaultBranch: "prod", members: { "15": "owner", "16": "dev" }, revoked: ["8"], devBadgeId: 5 });
		const cloud = fakeDataStoreCloud();
		await run(proj, () => settingsCommand(parseArgs(["push"], settingsFlags), { oc: cloud.oc, signer: newSigner() }));
		expect(JSON.parse((cloud.values.settings as SettingsRecord).body)).toEqual({
			access: { devBadgeId: 5, members: { "15": "owner", "16": "dev" }, revoked: { "8": true } },
			channels: { dev: "dev", prod: "prod" },
			defaultBranch: "prod",
		});
	});
	test("without signing keys every write says to run keys init", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		await expect(run(proj, () => settingsCommand(parseArgs(["set", "game.a", "1"], settingsFlags), { oc: cloud.oc }))).rejects.toThrow(/keys init/);
		expect(cloud.values.settings).toBeUndefined();
	});
	test("access push writes settings.access, records the hash; status reads the record back", async () => {
		const proj = project({ members: { "15": "owner" }, revoked: ["8"] });
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const pushed = await run(proj, () => accessCommand(parseArgs(["push"], accessFlags), { oc: cloud.oc, signer }));
		expect(pushed.out).toContain("settings #1");
		expect(JSON.parse((cloud.values.settings as SettingsRecord).body).access).toEqual({ members: { "15": "owner" }, revoked: { "8": true }, devBadgeId: null });
		expect(JSON.parse(readFileSync(join(proj.root, ".typetorch", "access.json"), "utf8"))).toMatchObject({ settingsSeq: 1 });
		const status = await run(proj, () => accessCommand(parseArgs(["status"], accessFlags), { oc: cloud.oc, signer }));
		expect(status.out).toContain("matches typetorch.json");
	});
	test("fleet setup writes settings.fleet with the ingest token from the environment, never printed", async () => {
		const proj = project();
		useSettings(new Settings({ startDir: proj.root, env: { TYPETORCH_FLEET_INGEST_TOKEN: "ingest-secret-1234567890" } }));
		const cloud = fakeDataStoreCloud();
		const done = await run(proj, () => fleetCommand(parseArgs(["setup", "--url", "https://fleet.example"], fleetFlags), { oc: cloud.oc, signer: newSigner() }));
		expect(JSON.parse((cloud.values.settings as SettingsRecord).body).fleet).toEqual({ url: "https://fleet.example", token: "ingest-secret-1234567890" });
		expect(done.out).not.toContain("ingest-secret");
		expect(JSON.parse(readFileSync(proj.configPath, "utf8")).fleet).toEqual({ url: "https://fleet.example" });
		await expect(run(proj, () => fleetCommand(parseArgs(["setup", "--url", "http://fleet.example"], fleetFlags), { oc: cloud.oc, signer: newSigner() }))).rejects.toThrow(/https/);
	});
	test("config push is gone with a pointer to settings push", async () => {
		const { configCommand } = await import("../src/commands/config");
		await expect(configCommand(parseArgs(["push"], {}))).rejects.toThrow(/settings push/);
	});
});
