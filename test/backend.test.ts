/**
 * CLI 0.9 (plans/21 B): `typetorch backend setup` against a fake backend (checks, the record's backend section and the
 * old fleet / analytics sections derived from it, typetorch.json backend.url, the ping, the owner list), the owner-list
 * PUT after every settings write (and its failures, which only warn), the backend's two secrets and their old names,
 * and the cleanup (removed commands are gone from the help or say where they moved). Fake keys only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { backendCredentials, ownersOf, putAccessList } from "../src/backend";
import { accessCommand, accessFlags } from "../src/commands/access";
import { analyticsDials, backendCommand, backendFlags } from "../src/commands/backend";
import { settingsCommand, settingsFlags } from "../src/commands/settings";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { setOutputMode } from "../src/log";
import { withBackend, type SettingsRecord } from "../src/settings";
import { generateSigningKey, parseSigningKey, type DualSigner } from "../src/signing";
import { ADMIN, fakeServer, HOST, INGEST } from "./fixtures/fake-analytics";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const KEYS = { TYPETORCH_API_KEY: INGEST, TYPETORCH_ADMIN_TOKEN: ADMIN, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" };

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(patch: Record<string, unknown> = {}, env: Record<string, string> = KEYS): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-backend-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod", dev: "dev" }, approval: "none", members: { "15": "owner", "16": "dev" }, ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings };
}

async function run<T>(proj: Project, fn: () => Promise<T>): Promise<{ result?: T; out: string; error?: Error }> {
	const lines: string[] = [];
	const log = console.log;
	const err = console.error;
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	const cwd = process.cwd();
	process.chdir(proj.root);
	try {
		return { result: await fn(), out: lines.join("\n") };
	} catch (error) {
		return { error: error as Error, out: lines.join("\n") };
	} finally {
		process.chdir(cwd);
		console.log = log;
		console.error = err;
	}
}

const bodyOf = (cloud: ReturnType<typeof fakeDataStoreCloud>) => JSON.parse((cloud.values.settings as SettingsRecord).body);

describe("backend setup", () => {
	setOutputMode({ json: false, verbose: false });

	test("checks pass: backend + the old fleet/analytics sections, typetorch.json backend.url (fleet dropped), ping, owner list; no secret printed", async () => {
		const proj = project({ fleet: { url: "https://old-tunnel.trycloudflare.com" } });
		const cloud = fakeDataStoreCloud();
		const server = fakeServer();
		const done = await run(proj, () => backendCommand(parseArgs(["setup", "--url", `${HOST}/`, "--flush-seconds", "15", "--record-share", "1"], backendFlags), { oc: cloud.oc, signer: newSigner(), fetch: server.fetch }));
		expect(done.error).toBeUndefined();
		expect(bodyOf(cloud)).toEqual({
			access: undefined,
			backend: { url: HOST, key: INGEST, analytics: { flushSeconds: 15, recordShare: 1 } },
			fleet: { url: HOST, token: INGEST },
			analytics: { backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST, flushSeconds: 15, recordShare: 1 },
		});
		const config = JSON.parse(readFileSync(proj.configPath, "utf8"));
		expect(config.backend).toEqual({ url: HOST });
		expect(config.fleet).toBeUndefined();
		expect(cloud.published.map((p) => JSON.parse(p.message))).toEqual([{ k: "settings", s: 1 }]);
		// The owner list went to the backend with the record's seq; the record holds no access yet, so no owners.
		expect(server.puts).toEqual([{ seq: 1, owners: [] }]);
		expect(done.out).toContain("backend setup: game servers use fleet.example.com: written as settings #1");
		expect(done.out).not.toContain(INGEST);
		expect(done.out).not.toContain(ADMIN);
		// The checks were GETs with the right roles, then one PUT.
		expect(server.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /v1/access"]);
	});

	test("a dead address writes nothing; --force writes it with warnings; the admin token as the key is refused even with --force (M2)", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const before = readFileSync(proj.configPath, "utf8");
		const dead = fakeServer({ throws: () => Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }) });
		const refused = await run(proj, () => backendCommand(parseArgs(["setup", "--url", "https://stale.trycloudflare.com"], backendFlags), { oc: cloud.oc, signer: newSigner(), fetch: dead.fetch }));
		expect(refused.error?.message).toContain("refusing to write settings.backend");
		expect(cloud.values.settings).toBeUndefined();
		expect(cloud.published).toEqual([]);
		expect(readFileSync(proj.configPath, "utf8")).toBe(before);
		const forced = await run(proj, () => backendCommand(parseArgs(["setup", "--url", "https://stale.trycloudflare.com", "--force"], backendFlags), { oc: cloud.oc, signer: newSigner(), fetch: dead.fetch }));
		expect(forced.error).toBeUndefined();
		expect(forced.out).toContain("--force: writing settings.backend although");
		expect(bodyOf(cloud).backend.url).toBe("https://stale.trycloudflare.com");

		// TYPETORCH_API_KEY holding the admin token: refused, --force or not, and nothing is written.
		const swapped = project({}, { ...KEYS, TYPETORCH_API_KEY: ADMIN, TYPETORCH_ADMIN_TOKEN: "another-admin-token-0123456789abcd" });
		const cloud2 = fakeDataStoreCloud();
		const admin = await run(swapped, () => backendCommand(parseArgs(["setup", "--url", HOST, "--force"], backendFlags), { oc: cloud2.oc, signer: newSigner(), fetch: fakeServer().fetch }));
		expect(admin.error?.message).toContain("--force cannot override this");
		expect(admin.error?.message).not.toContain(ADMIN);
		expect(cloud2.values.settings).toBeUndefined();
		// The same value for both: refused without asking the server, even when it is down.
		const same = project({}, { ...KEYS, TYPETORCH_ADMIN_TOKEN: INGEST });
		const cloud3 = fakeDataStoreCloud();
		const both = await run(same, () => backendCommand(parseArgs(["setup", "--url", "https://stale.trycloudflare.com", "--force"], backendFlags), { oc: cloud3.oc, signer: newSigner(), fetch: dead.fetch }));
		expect(both.error?.message).toContain("are the same value");
		expect(cloud3.values.settings).toBeUndefined();
	});

	test("--dry-run runs the checks and writes nothing; no key: a clear error with the .env path; bad dials are usage errors", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const dry = await run(proj, () => backendCommand(parseArgs(["setup", "--url", HOST, "--dry-run"], backendFlags), { oc: cloud.oc, signer: newSigner(), fetch: fakeServer().fetch }));
		expect(dry.error).toBeUndefined();
		expect(dry.out).toContain("dry run: would write settings #1");
		expect(cloud.values.settings).toBeUndefined();
		expect(JSON.parse(readFileSync(proj.configPath, "utf8")).backend).toBeUndefined();
		const nokey = project({}, { TYPETORCH_ADMIN_TOKEN: ADMIN, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" });
		const missing = await run(nokey, () => backendCommand(parseArgs(["setup", "--url", HOST], backendFlags), { oc: cloud.oc, signer: newSigner(), fetch: fakeServer().fetch }));
		expect(missing.error?.message).toContain("TYPETORCH_API_KEY isn't usable");
		expect(missing.error?.message).toContain(join(nokey.root, ".env"));
		const bad = await run(proj, () => backendCommand(parseArgs(["setup", "--url", HOST, "--record-share", "2"], backendFlags), { oc: cloud.oc, signer: newSigner(), fetch: fakeServer().fetch }));
		expect(bad.error?.message).toContain("--record-share must be a number from 0 to 1");
		const http = await run(proj, () => backendCommand(parseArgs(["setup", "--url", "http://backend.example.com"], backendFlags), { oc: cloud.oc, signer: newSigner() }));
		expect(http.error?.message).toMatch(/must be https/);
	});

	test("the old analytics section keeps its experiments; the dials carry over from the record when no flag is given", () => {
		const old = { analytics: { backend: "basin", events: "https://x.ingest.cloudflare.com", recordings: "https://y.ingest.cloudflare.com", token: "t", recordShare: 0.5, experiments: { onboarding_hint: { weights: [1, 3] } } } };
		const next = withBackend(old, { url: `${HOST}/`, key: INGEST, analytics: analyticsDials(old, {}) });
		expect(next.backend).toEqual({ url: HOST, key: INGEST, analytics: { recordShare: 0.5 } });
		expect(next.analytics).toEqual({ backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST, recordShare: 0.5, experiments: { onboarding_hint: { weights: [1, 3] } } });
		expect(analyticsDials({ backend: { url: HOST, key: INGEST, analytics: { flushSeconds: 30 } } }, { recordShare: 1 })).toEqual({ flushSeconds: 30, recordShare: 1 });
		expect(analyticsDials({}, {})).toBeUndefined();
	});
});

describe("the owner list (PUT /v1/access after every settings write)", () => {
	setOutputMode({ json: false, verbose: false });

	test("access push and later writes send the signed owners with the record's seq; same seq + list again is a no-op", async () => {
		const proj = project({ backend: { url: HOST }, members: { "15": "owner", "16": "dev", "7": "owner" } });
		const cloud = fakeDataStoreCloud();
		const server = fakeServer();
		const signer = newSigner();
		const pushed = await run(proj, () => accessCommand(parseArgs(["push"], accessFlags), { oc: cloud.oc, signer, fetch: server.fetch }));
		expect(pushed.error).toBeUndefined();
		expect(server.puts).toEqual([{ seq: 1, owners: [7, 15] }]);
		expect(pushed.out).toContain("backend owner list: 2 owners at settings #1");
		await run(proj, () => settingsCommand(parseArgs(["set", "game.coins", "5"], settingsFlags), { oc: cloud.oc, signer, fetch: server.fetch }));
		expect(server.puts.at(-1)).toEqual({ seq: 2, owners: [7, 15] });
		// Nothing changed: the record isn't written, the backend gets the same seq and list (idempotent there).
		const again = await run(proj, () => accessCommand(parseArgs(["push"], accessFlags), { oc: cloud.oc, signer, fetch: server.fetch }));
		expect(again.out).toContain("already set");
		expect(again.out).toContain("backend owner list: already at settings #2");
		expect(server.access).toMatchObject({ seq: 2, owners: [7, 15] });
		expect(JSON.stringify(server.puts)).not.toContain(ADMIN);
	});

	test("a backend that is down, refuses, or holds a newer seq only warns: the settings write stands", async () => {
		const proj = project({ backend: { url: HOST } });
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const down = fakeServer({ throws: () => Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }) });
		const written = await run(proj, () => settingsCommand(parseArgs(["set", "game.a", "1"], settingsFlags), { oc: cloud.oc, signer, fetch: down.fetch }));
		expect(written.error).toBeUndefined();
		expect(written.out).toContain("written as settings #1");
		expect(written.out).toContain("the backend's owner list wasn't updated");
		const ahead = fakeServer({ access: { seq: 9, owners: [15] } });
		const conflict = await run(proj, () => settingsCommand(parseArgs(["set", "game.a", "2"], settingsFlags), { oc: cloud.oc, signer, fetch: ahead.fetch }));
		expect(conflict.error).toBeUndefined();
		expect(conflict.out).toContain("the backend refused the owner list for settings #2");
		expect(conflict.out).toContain("it holds #9");
		const failing = fakeServer({ accessStatus: 500 });
		const broken = await run(proj, () => settingsCommand(parseArgs(["set", "game.a", "3"], settingsFlags), { oc: cloud.oc, signer, fetch: failing.fetch }));
		expect(broken.out).toContain("PUT /v1/access answered 500");
		expect(bodyOf(cloud).game).toEqual({ a: 3 });
	});

	test("no backend: nothing sent, nothing said; no admin token: one note", async () => {
		const none = project();
		const cloud = fakeDataStoreCloud();
		const server = fakeServer();
		const quiet = await run(none, () => settingsCommand(parseArgs(["set", "game.a", "1"], settingsFlags), { oc: cloud.oc, signer: newSigner(), fetch: server.fetch }));
		expect(quiet.out).not.toContain("owner list");
		expect(server.calls).toEqual([]);
		const noAdmin = project({ backend: { url: HOST } }, { TYPETORCH_API_KEY: INGEST, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" });
		const note = await run(noAdmin, () => settingsCommand(parseArgs(["set", "game.a", "1"], settingsFlags), { oc: fakeDataStoreCloud().oc, signer: newSigner(), fetch: server.fetch }));
		expect(note.out).toContain("backend owner list not sent: no TYPETORCH_ADMIN_TOKEN");
		expect(server.calls).toEqual([]);
	});

	test("putAccessList / ownersOf: the body, the outcomes, and the cap", async () => {
		expect(ownersOf({ members: { "16": "dev", "15": "owner", "3": "owner" }, revoked: {}, devBadgeId: null })).toEqual([3, 15]);
		expect(ownersOf(undefined)).toEqual([]);
		const server = fakeServer();
		expect(await putAccessList({ url: HOST, adminToken: ADMIN, seq: 3, owners: [1], fetch: server.fetch })).toMatchObject({ state: "updated", seq: 3 });
		expect(await putAccessList({ url: HOST, adminToken: ADMIN, seq: 3, owners: [1], fetch: server.fetch })).toMatchObject({ state: "same" });
		expect(await putAccessList({ url: HOST, adminToken: ADMIN, seq: 2, owners: [1], fetch: server.fetch })).toMatchObject({ state: "conflict", backendSeq: 3 });
		expect(await putAccessList({ url: HOST, adminToken: INGEST, seq: 4, owners: [1], fetch: server.fetch })).toMatchObject({ state: "failed" });
		expect(await putAccessList({ url: HOST, adminToken: ADMIN, seq: 5, owners: Array.from({ length: 201 }, (_, i) => i + 1), fetch: server.fetch })).toMatchObject({ state: "failed" });
	});
});

describe("the backend's secrets", () => {
	const settingsWith = (env: Record<string, string>) => new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-creds-")), env });

	test("the new names; the old ones are read with a warning naming the new one (never a value)", () => {
		const fresh = backendCredentials(settingsWith(KEYS));
		expect(fresh).toMatchObject({ key: { name: "TYPETORCH_API_KEY", value: INGEST }, admin: { name: "TYPETORCH_ADMIN_TOKEN", value: ADMIN }, notes: [] });
		const old = backendCredentials(settingsWith({ TYPETORCH_FLEET_INGEST_TOKEN: INGEST, TYPETORCH_FLEET_TOKEN: ADMIN, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" }));
		expect(old.key).toMatchObject({ name: "TYPETORCH_FLEET_INGEST_TOKEN", legacy: true });
		expect(old.admin).toMatchObject({ name: "TYPETORCH_FLEET_TOKEN", legacy: true });
		expect(old.notes.join("\n")).toContain("TYPETORCH_FLEET_TOKEN is now TYPETORCH_ADMIN_TOKEN");
		expect(old.notes.join("\n")).toContain("TYPETORCH_FLEET_INGEST_TOKEN is now TYPETORCH_API_KEY");
		expect(old.notes.join("\n")).not.toContain(INGEST);
		expect(old.notes.join("\n")).not.toContain(ADMIN);
	});

	test("a TYPETORCH_API_KEY that is still the CLI 0.8 Roblox key is never used as the backend key", () => {
		// The CLI 0.8 layout: TYPETORCH_API_KEY = Open Cloud, TYPETORCH_FLEET_INGEST_TOKEN = the backend's key.
		const layout = backendCredentials(settingsWith({ TYPETORCH_API_KEY: "roblox-open-cloud-key-0000", TYPETORCH_FLEET_INGEST_TOKEN: INGEST, TYPETORCH_FLEET_TOKEN: ADMIN }));
		expect(layout.key).toMatchObject({ name: "TYPETORCH_FLEET_INGEST_TOKEN", value: INGEST });
		expect(layout.refused).toContain("Rename TYPETORCH_API_KEY to OPENCLOUD_API_KEY");
		// The same value as an Open Cloud variable.
		const same = backendCredentials(settingsWith({ TYPETORCH_API_KEY: "roblox-open-cloud-key-0000", OPENCLOUD_DEPLOY_KEY: "roblox-open-cloud-key-0000", TYPETORCH_ADMIN_TOKEN: ADMIN }));
		expect(same.key).toBeUndefined();
		expect(same.refused).toContain("same value as OPENCLOUD_DEPLOY_KEY");
		// Alone, with no Open Cloud key and no admin token: most likely the old meaning.
		const alone = backendCredentials(settingsWith({ TYPETORCH_API_KEY: "roblox-open-cloud-key-0000" }));
		expect(alone.key).toBeUndefined();
		expect(alone.refused).toContain("rename it to OPENCLOUD_API_KEY");
	});
});

describe("cleanup (CLI 0.9)", () => {
	const cli = (args: string[], cwd: string) => {
		const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? "", PATHEXT: process.env.PATHEXT ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", NO_COLOR: "1" } });
		return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
	};
	const dir = () => mkdtempSync(join(tmpdir(), "tt-cleanup-"));

	test("help lists backend, not config or fleet; the keys section names the new variables", () => {
		const help = cli(["--help"], dir());
		expect(help.code).toBe(0);
		expect(help.out).toMatch(/\n {2}backend +point game servers at the TypeTorch backend/);
		expect(help.out).not.toMatch(/\n {2}config /);
		expect(help.out).not.toMatch(/\n {2}fleet /);
		expect(help.out).toContain("TYPETORCH_ADMIN_TOKEN");
		expect(help.out).not.toContain("else TYPETORCH_API_KEY");
	});
	test("config is an unknown command; fleet setup and settings set analytics point at backend setup; --require-shared-seq is unknown", () => {
		const cwd = dir();
		const config = cli(["config", "push"], cwd);
		expect(config.code).toBe(2);
		expect(config.out).toContain('unknown command "config"');
		const fleet = cli(["fleet", "setup", "--url", "https://x.example.com"], cwd);
		expect(fleet.code).toBe(2);
		expect(fleet.out).toContain("moved to `typetorch backend setup");
		const analytics = cli(["settings", "set", "analytics", "-"], cwd);
		expect(analytics.code).toBe(2);
		expect(analytics.out).toContain("moved to `typetorch backend setup");
		const seq = cli(["deploy", "--require-shared-seq"], cwd);
		expect(seq.code).toBe(2);
		expect(seq.out).toContain("unknown option --require-shared-seq");
	});
});
