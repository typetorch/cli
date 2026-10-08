/**
 * The endpoint checks that guard the signed settings record (endpoints.ts): the URL, GET /healthz within 5 s and the
 * token (GET /v1/auth/check), for settings.fleet and settings.analytics; `fleet setup` / `settings set analytics`
 * refusing to sign a broken value (and --force going ahead); the changeSettings guard; and doctor's version of the
 * same checks against the live record. Fake servers only: tokens here are made up.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { configFleetChecks, reportChecks, settingsEndpointChecks } from "../src/commands/doctor";
import { fleetCommand, fleetFlags } from "../src/commands/fleet";
import { changeSettings, settingsCommand, settingsFlags } from "../src/commands/settings";
import { validateConfig, type Project } from "../src/config";
import {
	checkAnalyticsEndpoint,
	checkFleetEndpoint,
	EndpointCheckError,
	enforceEndpoints,
	failedSteps,
	formatReport,
	reportsJson,
	type EndpointReport,
} from "../src/endpoints";
import { Settings, useSettings } from "../src/env";
import { fleetNetworkHint, INGEST_TOKEN_HINT } from "../src/httphints";
import { setOutputMode } from "../src/log";
import { generateSigningKey, parseSigningKey, type DualSigner } from "../src/signing";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";

import { ADMIN, fakeServer, HOST, INGEST } from "./fixtures/fake-analytics";

const stepOf = (report: EndpointReport, step: string) => report.steps.find((s) => s.step === step)!;
const connectionError = (code: string, message = "fetch failed") => () => Object.assign(new Error(message), { cause: { code } });

describe("fleet endpoint: the URL", () => {
	test("a good https address passes all three steps with GETs only, and nothing prints the token", async () => {
		const server = fakeServer();
		const report = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: server.fetch });
		expect(report.ok).toBe(true);
		expect(report.steps.map((s) => [s.step, s.ok])).toEqual([["url", true], ["healthz", true], ["token", true]]);
		expect(stepOf(report, "token").detail).toContain("valid for fleet");
		expect(server.calls.every((c) => c.method === "GET")).toBe(true);
		expect(server.calls.map((c) => c.path)).toEqual(["/healthz", "/v1/auth/check"]);
		expect(JSON.stringify(report)).not.toContain(INGEST);
	});
	test("not a URL, http, credentials, an endpoint path, a query: refused before any request, each with a fix", async () => {
		const server = fakeServer();
		for (const [url, expected] of [
			["not a url", /must be the fleet API's https URL/],
			["http://fleet.example.com", /must be https/],
			["https://user:pw@fleet.example.com", /credentials/],
			["https://fleet.example.com/v1/fleet", /endpoint path/],
			["https://fleet.example.com/?a=1", /query or fragment/],
			["https://fleet.example.com/a%20b", /characters the kernel rejects/],
			[undefined, /https URL/],
		] as const) {
			const report = await checkFleetEndpoint({ url, token: INGEST, fetch: server.fetch });
			expect(report.ok).toBe(false);
			expect(stepOf(report, "url").detail).toMatch(expected);
			expect(stepOf(report, "url").hint).toBeTruthy();
			expect(stepOf(report, "healthz").skipped).toBe(true);
			expect(stepOf(report, "token").skipped).toBe(true);
		}
		expect(server.calls).toEqual([]);
	});
	test("http on localhost: refused for the settings record (the kernel only takes https), fine for typetorch.json's CLI-side url", async () => {
		const server = fakeServer();
		const record = await checkFleetEndpoint({ url: "http://127.0.0.1:8787", token: INGEST, fetch: server.fetch });
		expect(stepOf(record, "url").ok).toBe(false);
		expect(stepOf(record, "url").detail).toContain("kernel's Fleet module only accepts https");
		const file = await checkFleetEndpoint({ url: "http://127.0.0.1:8787", token: undefined, kernelRules: false, fetch: server.fetch });
		expect(file.ok).toBe(true);
		expect(stepOf(file, "token").skipped).toBe(true);
	});
});

describe("fleet endpoint: GET /healthz", () => {
	test("a dead quick tunnel (the host no longer resolves) says to start bun run local again", async () => {
		const server = fakeServer({ throws: connectionError("ENOTFOUND") });
		const report = await checkFleetEndpoint({ url: "https://old-tunnel-name.trycloudflare.com", token: INGEST, fetch: server.fetch });
		expect(report.ok).toBe(false);
		expect(stepOf(report, "healthz").detail).toContain("didn't answer (ENOTFOUND)");
		expect(stepOf(report, "healthz").hint).toContain("no longer exists");
		expect(stepOf(report, "healthz").hint).toContain("bun run local");
		expect(stepOf(report, "token").skipped).toBe(true);
	});
	test("Cloudflare 530 / 1033 (tunnel with nothing behind it), 502, and a server that refuses connections", async () => {
		const tunnel = "https://dead-one.trycloudflare.com";
		const cloudflare = (status: number, body: string) => fakeServer({ everything: () => new Response(body, { status }) });
		const a = await checkFleetEndpoint({ url: tunnel, token: INGEST, fetch: cloudflare(530, "<html><title>Error 1033</title>Cloudflare error code 1033</html>").fetch });
		expect(stepOf(a, "healthz").detail).toContain("HTTP 530");
		expect(stepOf(a, "healthz").hint).toContain("has nothing running behind it");
		const b = await checkFleetEndpoint({ url: tunnel, token: INGEST, fetch: cloudflare(502, "Bad gateway cloudflare").fetch });
		expect(stepOf(b, "healthz").hint).toContain("the server behind it doesn't answer");
		const c = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ throws: connectionError("ECONNREFUSED") }).fetch });
		expect(stepOf(c, "healthz").hint).toContain("nothing listens");
		// Bun's fetch: code "ConnectionRefused" on the error itself, for refused connections and unresolvable names alike.
		const bunError = () => Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
		const d = await checkFleetEndpoint({ url: tunnel, token: INGEST, fetch: fakeServer({ throws: bunError }).fetch });
		expect(stepOf(d, "healthz").detail).toContain("didn't answer (ConnectionRefused)");
		expect(stepOf(d, "healthz").hint).toContain("quick tunnel URLs die with their cloudflared");
		const e = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ throws: bunError }).fetch });
		expect(stepOf(e, "healthz").hint).toContain("nothing listens");
	});
	test("no answer within the time limit fails, with the limit in the message", async () => {
		const server = fakeServer({ delayMs: 2000 });
		const started = Date.now();
		const report = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: server.fetch, timeoutMs: 80 });
		expect(Date.now() - started).toBeLessThan(1500);
		expect(stepOf(report, "healthz").ok).toBe(false);
		expect(stepOf(report, "healthz").detail).toContain("didn't answer within 0.08 s");
		expect(stepOf(report, "healthz").hint).toContain("tunnel");
	});
	test("the default limit is 5 s", async () => {
		const { CHECK_TIMEOUT_MS } = await import("../src/endpoints");
		expect(CHECK_TIMEOUT_MS).toBe(5000);
	});
	test("a redirect is reported, not followed; a 200 that isn't the analytics server; a login wall", async () => {
		const redirect = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ everything: () => new Response("", { status: 301, headers: { location: "https://other.example.org/healthz" } }) }).fetch });
		expect(stepOf(redirect, "healthz").detail).toContain("redirects (301) to other.example.org");
		const wrong = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ everything: () => new Response("<html><title>Welcome to nginx!</title></html>") }).fetch });
		expect(stepOf(wrong, "healthz").detail).toContain(`not {"ok":true}`);
		expect(stepOf(wrong, "healthz").hint).toContain("isn't the TypeTorch analytics server");
		const wall = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ everything: () => new Response("Access denied", { status: 403 }) }).fetch });
		expect(stepOf(wall, "healthz").detail).toContain("/healthz is public");
	});
});

describe("fleet endpoint: the token", () => {
	test("a refused token says which variable to set, and stops there", async () => {
		const report = await checkFleetEndpoint({ url: HOST, token: "some-other-token-0123456789", fetch: fakeServer().fetch });
		expect(report.ok).toBe(false);
		expect(stepOf(report, "healthz").ok).toBe(true);
		expect(stepOf(report, "token").detail).toContain("refused the token (HTTP 401)");
		expect(stepOf(report, "token").hint).toBe(INGEST_TOKEN_HINT("fleet"));
		expect(stepOf(report, "token").hint).toContain("TT_ANALYTICS_INGEST_TOKENS");
	});
	test("the ADMIN token is refused: it would sit in a record every script in the game can read", async () => {
		const report = await checkFleetEndpoint({ url: HOST, token: ADMIN, fetch: fakeServer().fetch });
		expect(stepOf(report, "token").ok).toBe(false);
		expect(stepOf(report, "token").detail).toContain("ADMIN token");
		expect(stepOf(report, "token").hint).toContain("write-only");
	});
	test("accepted, but the fleet part is off on that server", async () => {
		const report = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ parts: { analytics: true, fleet: false } }).fetch });
		expect(stepOf(report, "token").detail).toContain("not for the fleet part");
		expect(stepOf(report, "token").hint).toContain("TT_SERVER_PARTS");
	});
	test("no token, a token with a newline in it, a too short one: caught before the request", async () => {
		const server = fakeServer();
		for (const [token, expected] of [[undefined, "no token"], [`${INGEST}\n`, "spaces or control"], ["short", "5 characters"]] as const) {
			const report = await checkFleetEndpoint({ url: HOST, token, fetch: server.fetch });
			expect(stepOf(report, "token").ok).toBe(false);
			expect(stepOf(report, "token").detail).toContain(expected);
		}
		expect(server.calls.every((c) => c.path === "/healthz")).toBe(true);
	});
	test("an older server without /v1/auth/check: /v1/settings proves the token is accepted (and refuses a wrong one)", async () => {
		const old = fakeServer({ authCheck: false });
		const accepted = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: old.fetch });
		expect(accepted.ok).toBe(true);
		expect(stepOf(accepted, "token").detail).toContain("older server without /v1/auth/check");
		expect(old.calls.map((c) => c.path)).toEqual(["/healthz", "/v1/auth/check", "/v1/settings"]);
		const refused = await checkFleetEndpoint({ url: HOST, token: "wrong-token-0123456789abcdef", fetch: fakeServer({ authCheck: false }).fetch });
		expect(stepOf(refused, "token").detail).toContain("refused the token");
		const neither = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer({ everything: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }).fetch });
		expect(stepOf(neither, "token").ok).toBe(false); // a 200 {ok:true} from /v1/auth/check without a role
	});
	test("a server that echoes the token in an error body or a connection error never leaks it", async () => {
		const token = "leaky-token-0123456789abcdef";
		const echo = fakeServer({ everything: () => new Response(`bad token ${token}`, { status: 500 }) });
		const a = await checkFleetEndpoint({ url: HOST, token, fetch: echo.fetch });
		const threw = fakeServer({ throws: () => new Error(`socket closed for Bearer ${token}`) });
		const b = await checkFleetEndpoint({ url: HOST, token, fetch: threw.fetch });
		for (const report of [a, b]) expect(JSON.stringify(report) + formatReport(report).join("\n")).not.toContain(token);
	});
});

describe("analytics endpoint", () => {
	const duck = (extra: Record<string, unknown> = {}) => ({ backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST, ...extra });

	test("DuckDB: the base address is the events URL without /v1/ingest; url, healthz and token pass", async () => {
		const server = fakeServer({ prefix: "/prefix" });
		const report = await checkAnalyticsEndpoint(duck({ events: `${HOST}/prefix/v1/ingest` }), { fetch: server.fetch });
		expect(report.ok).toBe(true);
		expect(server.calls.map((c) => c.path)).toEqual(["/healthz", "/v1/auth/check"]);
		const plain = fakeServer();
		expect((await checkAnalyticsEndpoint(duck(), { fetch: plain.fetch })).ok).toBe(true);
		expect(plain.calls.map((c) => c.path)).toEqual(["/healthz", "/v1/auth/check"]);
	});
	test("settings shape: not an object, a bad backend, no token, an events URL that isn't .../v1/ingest, http, credentials", async () => {
		const server = fakeServer();
		const problems: [unknown, RegExp][] = [
			["nope", /must be a JSON object/],
			[{ backend: "sqlite", events: HOST }, /backend .* must be "duckdb" or "basin"/],
			[{ backend: "duckdb", events: `${HOST}/v1/ingest` }, /needs the server's ingest token/],
			[duck({ events: HOST }), /must end in \/v1\/ingest/],
			[duck({ events: "http://fleet.example.com/v1/ingest" }), /must be https/],
			[duck({ events: "https://u:p@fleet.example.com/v1/ingest" }), /credentials/],
			[duck({ events: 42 }), /events must be a URL/],
			[duck({ token: "has a space" }), /token must be a non-empty string without spaces/],
			[duck({ identity: "ftp://x" }), /identity/],
		];
		for (const [settings, expected] of problems) {
			const report = await checkAnalyticsEndpoint(settings, { fetch: server.fetch });
			expect(report.ok).toBe(false);
			expect(stepOf(report, "url").detail).toMatch(expected);
			expect(stepOf(report, "url").hint).toBeTruthy();
		}
		expect(server.calls).toEqual([]);
	});
	test("http on localhost is allowed for DuckDB (Studio), with a note", async () => {
		const report = await checkAnalyticsEndpoint({ backend: "duckdb", events: "http://127.0.0.1:8787/v1/ingest", token: INGEST }, { fetch: fakeServer().fetch });
		expect(report.ok).toBe(true);
		expect(stepOf(report, "url").detail).toContain("Studio only");
	});
	test("DuckDB: a dead tunnel and a wrong token are caught like the fleet ones", async () => {
		const dead = await checkAnalyticsEndpoint(duck({ events: "https://stale.trycloudflare.com/v1/ingest" }), { fetch: fakeServer({ throws: connectionError("ENOTFOUND") }).fetch });
		expect(stepOf(dead, "healthz").hint).toContain("bun run local");
		const wrong = await checkAnalyticsEndpoint(duck({ token: "old-token-from-a-previous-run-0123" }), { fetch: fakeServer().fetch });
		expect(stepOf(wrong, "token").detail).toContain("refused the token");
		expect(stepOf(wrong, "token").hint).toContain('"token" field');
	});
	test("DuckDB: the admin token is refused here too", async () => {
		const report = await checkAnalyticsEndpoint(duck({ token: ADMIN }), { fetch: fakeServer().fetch });
		expect(stepOf(report, "token").detail).toContain("ADMIN token");
	});
	test("Basin: both stream URLs must answer (any status), a 401 is a refused token, no token is noted", async () => {
		const basin = (extra: Record<string, unknown> = {}) => ({ backend: "basin", events: "https://aaa.ingest.cloudflare.com", recordings: "https://bbb.ingest.cloudflare.com", token: "basin-send-token-0123456789", ...extra });
		const answers405 = fakeServer({ everything: () => new Response("method not allowed", { status: 405 }) });
		const ok = await checkAnalyticsEndpoint(basin(), { fetch: answers405.fetch });
		expect(ok.ok).toBe(true);
		expect(stepOf(ok, "token").skipped).toBe(true);
		expect(stepOf(ok, "token").detail).toContain("no side-effect-free check");
		expect(answers405.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
		const noToken = await checkAnalyticsEndpoint(basin({ token: undefined }), { fetch: answers405.fetch });
		expect(stepOf(noToken, "token").detail).toContain("doesn't require authentication");
		const refused = await checkAnalyticsEndpoint(basin(), { fetch: fakeServer({ everything: () => new Response("", { status: 401 }) }).fetch });
		expect(stepOf(refused, "token").detail).toContain("Basin refused the token");
		expect(stepOf(refused, "token").hint).toContain("Basin Pipelines Send");
		const wrongStream = await checkAnalyticsEndpoint(basin(), { fetch: fakeServer({ throws: connectionError("ENOTFOUND") }).fetch });
		expect(stepOf(wrongStream, "healthz").hint).toContain("wrong stream id");
		const noRecordings = await checkAnalyticsEndpoint(basin({ recordings: undefined }), { fetch: answers405.fetch });
		expect(stepOf(noRecordings, "url").detail).toContain("needs a recordings stream URL");
	});
});

describe("enforcing the checks", () => {
	setOutputMode({ json: false, verbose: false });
	const broken = async () => checkFleetEndpoint({ url: "https://stale.trycloudflare.com", token: INGEST, fetch: fakeServer({ throws: connectionError("ENOTFOUND") }).fetch });

	test("a failure throws one message with every failing step and its fix; nothing is said to be written", async () => {
		const report = await broken();
		let error: Error | undefined;
		try {
			enforceEndpoints({ reports: [report], what: "settings.fleet" });
		} catch (e) {
			error = e as Error;
		}
		expect(error).toBeInstanceOf(EndpointCheckError);
		expect(error!.message).toContain("refusing to write settings.fleet: 1 check failed, nothing was signed or written");
		expect(error!.message).toContain("FAIL fleet healthz");
		expect(error!.message).toContain("fix:");
		expect(error!.message).toContain("--force");
		expect(failedSteps([report])).toHaveLength(1);
	});
	test("--force turns the failures into one warning and lets the write go ahead", async () => {
		const report = await broken();
		const lines: string[] = [];
		const err = console.error;
		console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
		try {
			expect(enforceEndpoints({ reports: [report], what: "settings.fleet", force: true })).toBe(true);
		} finally {
			console.error = err;
		}
		expect(lines.join("\n")).toContain("--force: writing settings.fleet although 1 check failed");
	});
	test("passing checks print dim lines and return false", async () => {
		const report = await checkFleetEndpoint({ url: HOST, token: INGEST, fetch: fakeServer().fetch });
		const lines: string[] = [];
		const log = console.log;
		console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
		try {
			expect(enforceEndpoints({ reports: [report], what: "settings.fleet" })).toBe(false);
		} finally {
			console.log = log;
		}
		expect(lines.join("\n")).toContain("fleet healthz");
		expect(reportsJson([report])[0]).toMatchObject({ target: "fleet", ok: true });
	});
});

// The commands ----------------------------------------------------------------------------------------------------------

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-endpoints-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod", dev: "dev" }, approval: "none" };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	const { config, errors } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env: { TYPETORCH_FLEET_INGEST_TOKEN: INGEST } }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings: [] };
}

async function inProject<T>(proj: Project, fn: () => Promise<T>): Promise<{ result?: T; out: string; error?: Error }> {
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

describe("fleet setup and settings set analytics refuse a broken endpoint", () => {
	setOutputMode({ json: false, verbose: false });
	const stale = () => fakeServer({ throws: connectionError("ENOTFOUND") });

	test("fleet setup: a dead address writes nothing (no record, no ping, typetorch.json untouched)", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const before = readFileSync(proj.configPath, "utf8");
		const done = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", "https://stale.trycloudflare.com"], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: stale().fetch }));
		expect(done.error?.message).toContain("refusing to write settings.fleet");
		expect(done.error?.message).toContain("bun run local");
		expect(cloud.values.settings).toBeUndefined();
		expect(cloud.published).toEqual([]);
		expect(cloud.calls).toEqual([]);
		expect(readFileSync(proj.configPath, "utf8")).toBe(before);
		expect(done.error?.message).not.toContain(INGEST);
	});
	test("fleet setup: the wrong token (and the admin token) writes nothing; --force writes anyway, with warnings", async () => {
		const proj = project();
		const server = fakeServer();
		const cloud = fakeDataStoreCloud();
		useSettings(new Settings({ startDir: proj.root, env: { TYPETORCH_FLEET_INGEST_TOKEN: "stale-token-from-last-week-01234" } }));
		const wrong = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", HOST], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: server.fetch }));
		expect(wrong.error?.message).toContain("refused the token");
		useSettings(new Settings({ startDir: proj.root, env: { TYPETORCH_FLEET_INGEST_TOKEN: ADMIN } }));
		const admin = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", HOST], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: server.fetch }));
		expect(admin.error?.message).toContain("ADMIN token");
		expect(cloud.values.settings).toBeUndefined();
		const forced = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", HOST, "--force"], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: server.fetch }));
		expect(forced.error).toBeUndefined();
		expect(forced.out).toContain("--force: writing settings.fleet although 1 check failed");
		expect(cloud.values.settings).toBeDefined();
		expect(forced.out).not.toContain(ADMIN);
	});
	test("fleet setup --dry-run runs the checks too and fails when they do", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const dry = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", "https://stale.trycloudflare.com", "--dry-run"], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: stale().fetch }));
		expect(dry.error?.message).toContain("refusing to write settings.fleet");
		const good = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", HOST, "--dry-run"], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: fakeServer().fetch }));
		expect(good.error).toBeUndefined();
		expect(good.out).toContain("dry run: would write settings.fleet");
		expect(cloud.values.settings).toBeUndefined();
	});
	test("fleet setup with a good address and token writes the record, once the checks pass", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const done = await inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", HOST], fleetFlags), { oc: cloud.oc, signer: newSigner(), fetch: fakeServer().fetch }));
		expect(done.error).toBeUndefined();
		expect(done.out).toContain("fleet healthz");
		expect(JSON.parse((cloud.values.settings as { body: string }).body).fleet).toEqual({ url: HOST, token: INGEST });
		expect(done.out).not.toContain(INGEST);
	});
	test("settings set analytics: a broken value is refused before the record is read or signed", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const value = JSON.stringify({ backend: "duckdb", events: "https://stale.trycloudflare.com/v1/ingest", token: INGEST });
		const refused = await inProject(proj, () => settingsCommand(parseArgs(["set", "analytics", "-"], settingsFlags), { oc: cloud.oc, signer: newSigner(), stdin: async () => value, fetch: stale().fetch }));
		expect(refused.error?.message).toContain("refusing to write settings.analytics");
		expect(refused.error?.message).not.toContain(INGEST);
		expect(cloud.calls).toEqual([]);
		const badUrl = JSON.stringify({ backend: "duckdb", events: "http://fleet.example.com/ingest", token: INGEST });
		const refused2 = await inProject(proj, () => settingsCommand(parseArgs(["set", "analytics", "-"], settingsFlags), { oc: cloud.oc, signer: newSigner(), stdin: async () => badUrl, fetch: fakeServer().fetch }));
		expect(refused2.error?.message).toMatch(/must be https/);
		expect(cloud.values.settings).toBeUndefined();
	});
	test("settings set analytics: a good value passes (--force for a bad one writes it with warnings); set game.* needs no check", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const good = JSON.stringify({ backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST });
		const ok = await inProject(proj, () => settingsCommand(parseArgs(["set", "analytics", "-"], settingsFlags), { oc: cloud.oc, signer, stdin: async () => good, fetch: fakeServer().fetch }));
		expect(ok.error).toBeUndefined();
		expect(ok.out).toContain("analytics token");
		const bad = JSON.stringify({ backend: "duckdb", events: `${HOST}/v1/ingest`, token: "an-old-token-0123456789abcdefgh" });
		const forced = await inProject(proj, () => settingsCommand(parseArgs(["set", "analytics", "-", "--force"], settingsFlags), { oc: cloud.oc, signer, stdin: async () => bad, fetch: fakeServer().fetch }));
		expect(forced.error).toBeUndefined();
		expect(forced.out).toContain("--force: writing settings.analytics");
		const noFetch = (async () => {
			throw new Error("no network for game values");
		}) as unknown as typeof fetch;
		const game = await inProject(proj, () => settingsCommand(parseArgs(["set", "game.x", "1"], settingsFlags), { oc: cloud.oc, signer, fetch: noFetch }));
		expect(game.error).toBeUndefined();
	});
});

describe("changeSettings: no unchecked write to fleet or analytics", () => {
	test("changing fleet or analytics without `checked` is refused before anything is written; re-signing and other fields are fine", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = fakeDataStoreCloud();
		const fleetWrite = { proj, oc: cloud.oc, signer, what: "test", mutate: (body: object) => ({ ...body, fleet: { url: HOST, token: INGEST } }) };
		await expect(changeSettings(fleetWrite)).rejects.toThrow(/without checking its endpoint/);
		await expect(changeSettings({ ...fleetWrite, mutate: (body) => ({ ...body, analytics: { backend: "duckdb" } }) })).rejects.toThrow(/settings\.analytics/);
		expect(cloud.values.settings).toBeUndefined();
		await expect(changeSettings({ ...fleetWrite, checked: ["analytics"] })).rejects.toThrow(/settings\.fleet/);
		await changeSettings({ ...fleetWrite, checked: ["fleet"] });
		expect(JSON.parse((cloud.values.settings as { body: string }).body).fleet.url).toBe(HOST);
		// Unrelated fields and a re-sign never need a check, even with a fleet section present.
		await changeSettings({ proj, oc: cloud.oc, signer, what: "game", mutate: (body) => ({ ...body, game: { a: 1 } }) });
		await changeSettings({ proj, oc: cloud.oc, signer, what: "resign", mutate: (body) => body, resign: true });
		expect(JSON.parse((cloud.values.settings as { body: string }).body).game).toEqual({ a: 1 });
	});
});

describe("doctor: the endpoints in the live settings record", () => {
	const stale = { url: "https://stale.trycloudflare.com", token: INGEST };

	test("a stale fleet address and an invalid analytics URL are FAILs with fixes (the problem doctor used to miss)", async () => {
		const checks = await settingsEndpointChecks({
			body: { fleet: stale, analytics: { backend: "duckdb", events: "http://nope.example/ingest", token: INGEST } },
			fetch: fakeServer({ throws: connectionError("ENOTFOUND") }).fetch,
		});
		const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
		expect(byName["fleet url"]).toMatchObject({ status: "ok" });
		expect(byName["fleet healthz"]).toMatchObject({ status: "fail" });
		expect(byName["fleet healthz"]!.detail).toContain("Fix:");
		expect(byName["fleet healthz"]!.detail).toContain("bun run local");
		expect(byName["fleet token"]).toMatchObject({ status: "info" });
		expect(byName["analytics url"]).toMatchObject({ status: "fail" });
		expect(byName["analytics url"]!.detail).toMatch(/must be https/);
		expect(JSON.stringify(checks)).not.toContain(INGEST);
	});
	test("a healthy record: every step ok; a missing section is info; typetorch.json's url must match the record's", async () => {
		const server = fakeServer();
		const healthy = await settingsEndpointChecks({ body: { fleet: { url: HOST, token: INGEST }, analytics: { backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST } }, configFleetUrl: HOST, fetch: server.fetch });
		expect(healthy.map((c) => `${c.name}:${c.status}`)).toEqual(["fleet url:ok", "fleet healthz:ok", "fleet token:ok", "analytics url:ok", "analytics healthz:ok", "analytics token:ok"]);
		const none = await settingsEndpointChecks({ body: {}, fetch: server.fetch });
		expect(none.map((c) => c.status)).toEqual(["info", "info"]);
		const missing = await settingsEndpointChecks({ body: {}, configFleetUrl: HOST, fetch: server.fetch });
		expect(missing[0]).toMatchObject({ name: "fleet", status: "warn" });
		const mismatch = await settingsEndpointChecks({ body: { fleet: { url: HOST, token: INGEST } }, configFleetUrl: "https://other-tunnel.trycloudflare.com", fetch: server.fetch });
		expect(mismatch.find((c) => c.name === "fleet url mismatch")).toMatchObject({ status: "warn" });
		expect(mismatch.find((c) => c.name === "fleet url mismatch")!.detail).toContain("other-tunnel.trycloudflare.com");
		// Trailing slash and case don't count as a difference.
		const same = await settingsEndpointChecks({ body: { fleet: { url: HOST, token: INGEST } }, configFleetUrl: `${HOST.toUpperCase().replace("HTTPS", "https")}/`, fetch: server.fetch });
		expect(same.find((c) => c.name === "fleet url mismatch")).toBeUndefined();
	});
	test("typetorch.json fleet.url: reachable or a FAIL with the fix (no token needed)", async () => {
		const ok = await configFleetChecks("http://127.0.0.1:8787", { fetch: fakeServer().fetch });
		expect(ok).toEqual([{ name: "typetorch.json fleet", status: "ok", detail: expect.stringContaining("answered in") }]);
		const dead = await configFleetChecks("https://stale.trycloudflare.com", { fetch: fakeServer({ throws: connectionError("ENOTFOUND") }).fetch });
		expect(dead[0]).toMatchObject({ name: "typetorch.json fleet", status: "fail" });
		expect(dead[0]!.detail).toContain("Fix:");
	});
	test("reportChecks maps steps to doctor statuses", async () => {
		const report = await checkFleetEndpoint({ url: "https://x.example.com", token: INGEST, fetch: fakeServer({ throws: connectionError("ECONNREFUSED") }).fetch });
		expect(reportChecks(report).map((c) => [c.name, c.status])).toEqual([["fleet url", "ok"], ["fleet healthz", "fail"], ["fleet token", "info"]]);
	});
});

describe("network hints", () => {
	test("generic DNS, TLS and reset errors get a plain fix", () => {
		const dns = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
		expect(fleetNetworkHint(dns, "fleet.example.com")).toContain("doesn't resolve");
		expect(fleetNetworkHint(Object.assign(new Error("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), "fleet.example.com")).toContain("TLS certificate");
		expect(fleetNetworkHint(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), "fleet.example.com")).toContain("dropped the connection");
		// The quick-tunnel wording still wins for trycloudflare.com hosts.
		expect(fleetNetworkHint(dns, "x.trycloudflare.com")).toContain("no longer exists");
	});
});
