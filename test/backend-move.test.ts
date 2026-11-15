/**
 * CLI 0.19 (plans/35): `backend setup --analytics basin|duckdb` (the sink switch; a Basin sink is kept without the
 * flag), `--ingest <url>|none`, and `backend migrate` (start bodies per the contract, pause / resume / cancel /
 * resolve, the status view, --watch) against fake servers. Fake keys only; no secret may reach the output.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { backendCommand, backendFlags } from "../src/commands/backend";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { captureJson, setOutputMode } from "../src/log";
import { formatMigration, parseMigrationStatus, progressBar } from "../src/migration";
import { bodyProblems, signSettings, verifySettingsRecord, type SettingsBody, type SettingsRecord } from "../src/settings";
import { generateSigningKey, parseSigningKey, type DualSigner } from "../src/signing";
import { ADMIN, fakeServer, HOST, INGEST } from "./fixtures/fake-analytics";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";

const SEND = "basin-send-token-for-tests-0123456789";
const SQL = "basin-sql-token-for-tests-0123456789";
const OLD = "old-admin-token-for-tests-0123456789";
const EVENTS = "https://ev123.ingest.cloudflare.com";
const RECORDINGS = "https://rec456.ingest.cloudflare.com";
const INGEST_URL = "https://ingest.example.com";
const KEYS = { TYPETORCH_API_KEY: INGEST, TYPETORCH_ADMIN_TOKEN: ADMIN, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" };
const SECRETS = [SEND, SQL, OLD, INGEST, ADMIN];
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(patch: Record<string, unknown> = {}, env: Record<string, string> = KEYS): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-move-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod", dev: "dev" }, approval: "none", ...patch };
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
		return { result: await fn(), out: plain(lines.join("\n")) };
	} catch (error) {
		return { error: error as Error, out: plain(lines.join("\n")) };
	} finally {
		process.chdir(cwd);
		console.log = log;
		console.error = err;
	}
}

const noSecrets = (text: string) => {
	for (const secret of SECRETS) expect(text).not.toContain(secret);
};

/** The backend fake, a second one for the ingest host, and Basin's streams (any status counts; 401 for a wrong token). */
function network(options: { parts?: { analytics: boolean; fleet: boolean }; ingestDown?: boolean } = {}) {
	const backend = fakeServer({ parts: options.parts });
	const ingest = fakeServer({ parts: { analytics: true, fleet: false } });
	const basin: { host: string; auth: string | null }[] = [];
	const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.host.endsWith(".ingest.cloudflare.com")) {
			const auth = new Headers(init?.headers).get("authorization");
			basin.push({ host: url.host, auth });
			return new Response("method not allowed", { status: auth === `Bearer ${SEND}` ? 405 : 401 });
		}
		if (url.host === new URL(INGEST_URL).host) {
			if (options.ingestDown) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
			return ingest.fetch(input, init);
		}
		return backend.fetch(input, init);
	}) as typeof fetch;
	return { fetch: fetchFake, backend, ingest, basin };
}

const setup = (argv: string[], ctx: { proj: Project; cloud: ReturnType<typeof fakeDataStoreCloud>; signer: DualSigner; fetch: typeof fetch }) =>
	run(ctx.proj, () => backendCommand(parseArgs(["setup", "--url", HOST, ...argv], backendFlags), { oc: ctx.cloud.oc, signer: ctx.signer, fetch: ctx.fetch }));

const recordOf = (cloud: ReturnType<typeof fakeDataStoreCloud>) => cloud.values.settings as SettingsRecord;
const bodyOf = (cloud: ReturnType<typeof fakeDataStoreCloud>): SettingsBody => JSON.parse(recordOf(cloud).body);

/** The record is signed by both keys and passes the body checks the write path runs. */
function expectSigned(cloud: ReturnType<typeof fakeDataStoreCloud>, signer: DualSigner) {
	const record = recordOf(cloud);
	expect(verifySettingsRecord(record, { main: signer.main.publicKey })).toBe("sig");
	expect(verifySettingsRecord(record, { fallback: signer.fallback.publicKey })).toBe("sigF");
	expect(bodyProblems(bodyOf(cloud))).toEqual([]);
}

describe("backend setup: the analytics sink (plans/35 B)", () => {
	setOutputMode({ json: false, verbose: false });

	test("--analytics basin writes the Basin sink with BASIN_SEND_TOKEN, keeps backend for the fleet API, accepts a fleet-only backend; no secret printed", async () => {
		const proj = project({}, { ...KEYS, BASIN_SEND_TOKEN: SEND });
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const net = network({ parts: { analytics: false, fleet: true } });
		// A fleet-only backend fails the key check while analytics would go to it ...
		const refused = await setup([], { proj, cloud, signer, fetch: net.fetch });
		expect(refused.error?.message).toContain("doesn't run its analytics part");
		expect(cloud.values.settings).toBeUndefined();
		// ... and passes once analytics goes to Basin.
		const done = await setup(["--analytics", "basin", "--events", EVENTS, "--recordings", RECORDINGS, "--record-share", "0.25"], { proj, cloud, signer, fetch: net.fetch });
		expect(done.error).toBeUndefined();
		expect(bodyOf(cloud)).toEqual({
			backend: { url: HOST, key: INGEST, analytics: { recordShare: 0.25 } },
			fleet: { url: HOST, token: INGEST },
			analytics: { backend: "basin", events: EVENTS, recordings: RECORDINGS, token: SEND, recordShare: 0.25 },
		});
		expectSigned(cloud, signer);
		// Both streams were reached with the send token (Basin's only check); the output names Basin, never a token.
		expect(net.basin.map((b) => b.host).sort()).toEqual(["ev123.ingest.cloudflare.com", "rec456.ingest.cloudflare.com"]);
		expect(done.out).toContain("analytics: Basin (ev123.ingest.cloudflare.com)");
		expect(done.out).toContain("analytics part may be off");
		noSecrets(done.out);
	});

	test("without --analytics a Basin sink is kept (dials and experiments too); --analytics duckdb moves it back", async () => {
		const proj = project({}, { ...KEYS, BASIN_SEND_TOKEN: SEND });
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const fleetOnly = network({ parts: { analytics: false, fleet: true } });
		expect((await setup(["--analytics", "basin", "--events", EVENTS, "--recordings", RECORDINGS], { proj, cloud, signer, fetch: fleetOnly.fetch })).error).toBeUndefined();
		// An experiment and an unknown dial (techEvery) the framework reads, written some other way.
		const withExtras = (value: SettingsRecord) => {
			const body = JSON.parse(value.body) as SettingsBody;
			body.analytics = { ...body.analytics, techEvery: 60, experiments: { hint: { weights: [1, 1] } } };
			body.backend!.analytics = { experiments: { hint: { weights: [1, 1] } } };
			return signSettings(signer, value.seq + 1, "2026-11-15T00:00:00.000Z", body);
		};
		cloud.values.settings = withExtras(recordOf(cloud));

		// A key change (no --analytics): the sink stays Basin, fleet-only still passes, the dial lands in both sections.
		const kept = await setup(["--flush-seconds", "30"], { proj, cloud, signer, fetch: fleetOnly.fetch });
		expect(kept.error).toBeUndefined();
		expect(kept.out).toContain("analytics: Basin (ev123.ingest.cloudflare.com), kept");
		expect(bodyOf(cloud).analytics).toEqual({ backend: "basin", events: EVENTS, recordings: RECORDINGS, token: SEND, techEvery: 60, flushSeconds: 30, experiments: { hint: { weights: [1, 1] } } });
		expect(bodyOf(cloud).backend).toEqual({ url: HOST, key: INGEST, analytics: { flushSeconds: 30, experiments: { hint: { weights: [1, 1] } } } });
		expectSigned(cloud, signer);

		// --dry-run says what it would keep and writes nothing.
		const seq = recordOf(cloud).seq;
		const dry = await setup(["--dry-run"], { proj, cloud, signer, fetch: fleetOnly.fetch });
		expect(dry.out).toContain("analytics: Basin (ev123.ingest.cloudflare.com), kept");
		expect(recordOf(cloud).seq).toBe(seq);

		// Back to DuckDB: the fleet-only backend now fails (analytics would go to it), a full one passes.
		const stillFleetOnly = await setup(["--analytics", "duckdb"], { proj, cloud, signer, fetch: fleetOnly.fetch });
		expect(stillFleetOnly.error?.message).toContain("doesn't run its analytics part");
		const back = await setup(["--analytics", "duckdb"], { proj, cloud, signer, fetch: network().fetch });
		expect(back.error).toBeUndefined();
		expect(back.out).toContain("analytics: the backend (DuckDB), moved back from Basin");
		expect(bodyOf(cloud).analytics).toEqual({ backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST, techEvery: 60, flushSeconds: 30, experiments: { hint: { weights: [1, 1] } } });
		expectSigned(cloud, signer);
		noSecrets(kept.out + dry.out + back.out);
	});

	test("refusals: no send token, no streams, --events without --analytics basin, http streams, a token flag; nothing written", async () => {
		const noToken = project();
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const net = network();
		const missing = await setup(["--analytics", "basin", "--events", EVENTS, "--recordings", RECORDINGS], { proj: noToken, cloud, signer, fetch: net.fetch });
		expect(missing.error?.message).toContain("needs BASIN_SEND_TOKEN");
		expect(missing.error?.message).toContain("never on the command line");
		const withToken = project({}, { ...KEYS, BASIN_SEND_TOKEN: SEND });
		expect((await setup(["--analytics", "basin"], { proj: withToken, cloud, signer, fetch: net.fetch })).error?.message).toContain("needs the two stream URLs");
		expect((await setup(["--events", EVENTS], { proj: withToken, cloud, signer, fetch: net.fetch })).error).toBeInstanceOf(UsageError);
		expect((await setup(["--analytics", "duckdb", "--events", EVENTS], { proj: withToken, cloud, signer, fetch: net.fetch })).error).toBeInstanceOf(UsageError);
		expect((await setup(["--analytics", "basin", "--events", "http://ev.ingest.cloudflare.com", "--recordings", RECORDINGS], { proj: withToken, cloud, signer, fetch: net.fetch })).error?.message).toContain("--events must be https");
		expect((await setup(["--analytics", "kafka"], { proj: withToken, cloud, signer, fetch: net.fetch })).error?.message).toContain("--analytics must be basin or duckdb");
		expect(() => parseArgs(["setup", "--analytics", "basin", "--token", SEND], backendFlags)).toThrow("unknown option --token");
		expect(cloud.values.settings).toBeUndefined();
		// A wrong send token: Basin answers 401, the check fails before anything is signed.
		const wrong = project({}, { ...KEYS, BASIN_SEND_TOKEN: "not-the-send-token-0123456789" });
		const refused = await setup(["--analytics", "basin", "--events", EVENTS, "--recordings", RECORDINGS], { proj: wrong, cloud, signer, fetch: net.fetch });
		expect(refused.error?.message).toContain("Basin refused the token");
		expect(cloud.values.settings).toBeUndefined();
	});

	test("a sink switched by another machine between the check and the write is refused, not overwritten", async () => {
		const proj = project({}, { ...KEYS, BASIN_SEND_TOKEN: SEND });
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const net = network();
		expect((await setup([], { proj, cloud, signer, fetch: net.fetch })).error).toBeUndefined();
		cloud.serverWrites("settings", (value: SettingsRecord) => {
			const body = JSON.parse(value.body) as SettingsBody;
			body.analytics = { backend: "basin", events: EVENTS, recordings: RECORDINGS, token: SEND };
			return signSettings(signer, value.seq + 1, "2026-11-15T00:00:00.000Z", body);
		});
		const raced = await setup(["--record-share", "0.5"], { proj, cloud, signer, fetch: net.fetch });
		expect(raced.error?.message).toContain("analytics sink or ingest address changed while the checks ran");
		expect(bodyOf(cloud).analytics?.backend).toBe("basin");
		// An ingest address that appears meanwhile isn't written unchecked either.
		const proj2 = project();
		const cloud2 = fakeDataStoreCloud();
		expect((await setup([], { proj: proj2, cloud: cloud2, signer, fetch: net.fetch })).error).toBeUndefined();
		cloud2.serverWrites("settings", (value: SettingsRecord) => {
			const body = JSON.parse(value.body) as SettingsBody;
			body.backend!.ingest = "https://unchecked.example.com";
			return signSettings(signer, value.seq + 1, "2026-11-15T00:00:00.000Z", body);
		});
		const raced2 = await setup(["--record-share", "0.5"], { proj: proj2, cloud: cloud2, signer, fetch: net.fetch });
		expect(raced2.error?.message).toContain("changed while the checks ran");
		expect(bodyOf(cloud2).backend?.analytics).toBeUndefined();
	});
});

describe("backend setup --ingest (plans/35 C)", () => {
	setOutputMode({ json: false, verbose: false });

	test("set (checked at the ingest host), kept without the flag (and checked again), removed with none", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const net = network();
		const set = await setup(["--ingest", `${INGEST_URL}/`], { proj, cloud, signer, fetch: net.fetch });
		expect(set.error).toBeUndefined();
		expect(bodyOf(cloud).backend).toEqual({ url: HOST, key: INGEST, ingest: INGEST_URL });
		// The old sections still point at the main server (frameworks before 0.7.2 don't know ingest).
		expect(bodyOf(cloud).analytics).toEqual({ backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST });
		expect(net.ingest.calls.map((c) => `${c.method} ${c.path} ${c.auth}`)).toEqual(["GET /healthz false", "GET /v1/auth/check true"]);
		expect(set.out).toContain("ingest: ingest.example.com");
		expectSigned(cloud, signer);

		const kept = await setup([], { proj, cloud, signer, fetch: net.fetch });
		expect(kept.error).toBeUndefined();
		expect(bodyOf(cloud).backend?.ingest).toBe(INGEST_URL);
		expect(kept.out).toContain("ingest: ingest.example.com (kept)");
		expect(net.ingest.calls.length).toBe(4);

		const removed = await setup(["--ingest", "none"], { proj, cloud, signer, fetch: net.fetch });
		expect(removed.error).toBeUndefined();
		expect(bodyOf(cloud).backend).toEqual({ url: HOST, key: INGEST });
		expect(removed.out).toContain("ingest: removed");
		expectSigned(cloud, signer);
		noSecrets(set.out + kept.out + removed.out);
	});

	test("a dead ingest host is refused (nothing written), --force writes it; an http or endpoint URL is a usage error", async () => {
		const proj = project();
		const cloud = fakeDataStoreCloud();
		const signer = newSigner();
		const down = network({ ingestDown: true });
		const refused = await setup(["--ingest", INGEST_URL], { proj, cloud, signer, fetch: down.fetch });
		expect(refused.error?.message).toContain("refusing to write settings.backend");
		expect(refused.error?.message).toContain("ingest healthz");
		expect(cloud.values.settings).toBeUndefined();
		const forced = await setup(["--ingest", INGEST_URL, "--force"], { proj, cloud, signer, fetch: down.fetch });
		expect(forced.error).toBeUndefined();
		expect(bodyOf(cloud).backend?.ingest).toBe(INGEST_URL);
		expect((await setup(["--ingest", "http://ingest.example.com"], { proj, cloud, signer, fetch: down.fetch })).error?.message).toMatch(/--ingest must be https/);
		expect(bodyProblems({ backend: { url: HOST, key: INGEST, ingest: `${INGEST_URL}/v1/ingest` } })).toEqual(["backend.ingest must be the ingest servers' https base address"]);
	});
});

// backend migrate ---------------------------------------------------------------------------------------------------------

const NEW = "https://new.example.com";
const OLD_URL = "https://old.example.com";

/** The new server (POST / GET /v1/admin/migrate, admin token) and the old one (/healthz, /v1/auth/check). */
function migrateNetwork(options: { status?: Record<string, unknown>[]; unsupported?: boolean; oldRole?: string } = {}) {
	const posts: { body: unknown; auth: string | null }[] = [];
	const gets: string[] = [];
	const old: string[] = [];
	const statuses = [...(options.status ?? [{ state: "running", direction: "from-backend", rowsDone: 0, rowsTotal: 0, steps: [], days: [] }])];
	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const auth = new Headers(init?.headers).get("authorization");
		if (url.origin === OLD_URL) {
			old.push(`${init?.method ?? "GET"} ${url.pathname}`);
			if (url.pathname === "/healthz") return json(200, { ok: true });
			if (url.pathname === "/v1/auth/check") return auth === `Bearer ${OLD}` ? json(200, { ok: true, role: options.oldRole ?? "admin", parts: { fleet: true, analytics: true } }) : json(401, { error: "no" });
			return json(404, { error: "not found" });
		}
		if (url.origin !== NEW || url.pathname !== "/v1/admin/migrate") return json(404, { error: "not found" });
		if (auth !== `Bearer ${ADMIN}`) return json(401, { error: "admin token required" });
		if ((init?.method ?? "GET") === "GET") {
			gets.push(url.pathname);
			return json(200, statuses.length > 1 ? statuses.shift()! : statuses[0]!);
		}
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		posts.push({ body, auth });
		const start = body.action === "start";
		if (options.unsupported && start && (body.to || (body.from as { kind?: string })?.kind === "basin")) return json(501, { error: "not implemented" });
		return json(200, statuses[0]!);
	}) as typeof fetch;
	return { fetch: fetchFake, posts, gets, old };
}

const migrate = (proj: Project, argv: string[], deps: Parameters<typeof backendCommand>[1]) => run(proj, () => backendCommand(parseArgs(["migrate", ...argv], backendFlags), deps));

describe("backend migrate (plans/35 A/B)", () => {
	setOutputMode({ json: false, verbose: false });

	test("--from: the old server is checked, the start body is the contract's, nothing secret is printed; a record still on the old URL warns", async () => {
		const proj = project({ backend: { url: NEW } }, { ...KEYS, TYPETORCH_OLD_ADMIN_TOKEN: OLD });
		const signer = newSigner();
		const cloud = fakeDataStoreCloud({ settings: signSettings(signer, 3, "2026-11-15T00:00:00.000Z", { backend: { url: OLD_URL, key: INGEST } }) });
		const net = migrateNetwork();
		const done = await migrate(proj, ["--from", `${OLD_URL}/`, "--rows-per-second", "5000"], { fetch: net.fetch, oc: cloud.oc });
		expect(done.error).toBeUndefined();
		expect(net.old).toEqual(["GET /healthz", "GET /v1/auth/check"]);
		expect(net.posts).toEqual([{ body: { action: "start", from: { kind: "backend", url: OLD_URL, token: OLD }, rowsPerSecond: 5000 }, auth: `Bearer ${ADMIN}` }]);
		expect(done.out).toContain("the settings record still points game servers at old.example.com");
		expect(done.out).toContain(`typetorch backend setup --url ${NEW}`);
		expect(done.out).toContain("moving from the old server: started on new.example.com");
		noSecrets(done.out);
		// Without --rows-per-second the body has no rate (the backend's default applies), and a record on the new URL says nothing.
		const moved = fakeDataStoreCloud({ settings: signSettings(signer, 4, "2026-11-15T00:00:00.000Z", { backend: { url: NEW, key: INGEST } }) });
		const again = await migrate(proj, ["--from", OLD_URL], { fetch: net.fetch, oc: moved.oc });
		expect(net.posts[1]!.body).toEqual({ action: "start", from: { kind: "backend", url: OLD_URL, token: OLD } });
		expect(again.out).not.toContain("still points");
	});

	test("--from refusals: no old token, the old token isn't admin there (--force starts anyway), --from = backend.url, a token flag", async () => {
		const noToken = project({ backend: { url: NEW } });
		const net = migrateNetwork({ oldRole: "game" });
		expect((await migrate(noToken, ["--from", OLD_URL], { fetch: net.fetch, oc: fakeDataStoreCloud().oc })).error?.message).toContain("TYPETORCH_OLD_ADMIN_TOKEN");
		const proj = project({ backend: { url: NEW } }, { ...KEYS, TYPETORCH_OLD_ADMIN_TOKEN: OLD });
		const refused = await migrate(proj, ["--from", OLD_URL], { fetch: net.fetch, oc: fakeDataStoreCloud().oc });
		expect(refused.error?.message).toContain("the old server's checks failed, nothing was started");
		expect(refused.error?.message).toContain("TYPETORCH_OLD_ADMIN_TOKEN is the backend's GAME key");
		expect(net.posts).toEqual([]);
		const forced = await migrate(proj, ["--from", OLD_URL, "--force"], { fetch: net.fetch, oc: fakeDataStoreCloud().oc });
		expect(forced.error).toBeUndefined();
		expect(net.posts.length).toBe(1);
		noSecrets(refused.error!.message + forced.out);
		const self = await migrate(proj, ["--from", NEW], { fetch: net.fetch });
		expect(self.error?.message).toContain("the job runs on the NEW server");
		expect(() => parseArgs(["migrate", "--from", OLD_URL, "--token", OLD], backendFlags)).toThrow("unknown option --token");
		expect((await migrate(proj, ["--from", OLD_URL, "--to-basin"], { fetch: net.fetch })).error?.message).toContain("pick one of");
		expect((await migrate(proj, [], { fetch: net.fetch })).error?.message).toContain("what to move?");
		expect((await migrate(proj, ["--from", OLD_URL, "--rows-per-second", "0"], { fetch: net.fetch })).error?.message).toContain("--rows-per-second must be a whole number");
		expect((await migrate(proj, ["--url", NEW, "status"], { fetch: net.fetch })).error).toBeInstanceOf(UsageError);
	});

	test("--from-basin and --to-basin: the contract's bodies (secrets from env / .env only), the record's streams by default, 501 = update the backend", async () => {
		const env = { ...KEYS, CLOUDFLARE_ACCOUNT_ID: "acc123", BASIN_BUCKET: "game-bucket", BASIN_SQL_TOKEN: SQL, BASIN_SEND_TOKEN: SEND };
		const proj = project({ backend: { url: NEW } }, env);
		const net = migrateNetwork();
		const signer = newSigner();
		const cloud = fakeDataStoreCloud({ settings: signSettings(signer, 5, "2026-11-15T00:00:00.000Z", { backend: { url: NEW, key: INGEST }, analytics: { backend: "basin", events: EVENTS, recordings: RECORDINGS, token: SEND } }) });
		const fromBasin = await migrate(proj, ["--from-basin"], { fetch: net.fetch, oc: cloud.oc });
		expect(fromBasin.error).toBeUndefined();
		expect(net.posts[0]!.body).toEqual({ action: "start", from: { kind: "basin", accountId: "acc123", bucket: "game-bucket", token: SQL, namespace: "typetorch" } });
		const toBasin = await migrate(proj, ["--to-basin"], { fetch: net.fetch, oc: cloud.oc });
		expect(toBasin.error).toBeUndefined();
		expect(net.posts[1]!.body).toEqual({ action: "start", to: { kind: "basin", events: EVENTS, recordings: RECORDINGS, token: SEND } });
		expect(toBasin.out).toContain("Basin can't delete or dedupe");
		const flags = await migrate(proj, ["--to-basin", "--events", "https://other.ingest.cloudflare.com", "--recordings", RECORDINGS, "--rows-per-second", "1000"], { fetch: net.fetch, oc: fakeDataStoreCloud().oc });
		expect(flags.error).toBeUndefined();
		expect(net.posts[2]!.body).toEqual({ action: "start", to: { kind: "basin", events: "https://other.ingest.cloudflare.com", recordings: RECORDINGS, token: SEND }, rowsPerSecond: 1000 });
		noSecrets(fromBasin.out + toBasin.out + flags.out);

		// A namespace from the env; missing values are named (never their values).
		const named = project({ backend: { url: NEW } }, { ...env, BASIN_NAMESPACE: "game_ns" });
		await migrate(named, ["--from-basin"], { fetch: net.fetch });
		expect((net.posts[3]!.body as { from: { namespace: string } }).from.namespace).toBe("game_ns");
		const partial = project({ backend: { url: NEW } }, { ...KEYS, CLOUDFLARE_ACCOUNT_ID: "acc123" });
		expect((await migrate(partial, ["--from-basin"], { fetch: net.fetch })).error?.message).toContain("needs BASIN_BUCKET, BASIN_SQL_TOKEN");
		expect((await migrate(partial, ["--to-basin"], { fetch: net.fetch, oc: fakeDataStoreCloud().oc })).error?.message).toContain("--to-basin needs the two Basin stream URLs");
		expect((await migrate(proj, ["--events", EVENTS], { fetch: net.fetch })).error).toBeInstanceOf(UsageError);

		// (project() loads its env as this run's settings: back to the full one.)
		const again = project({ backend: { url: NEW } }, env);
		const old = migrateNetwork({ unsupported: true });
		const unsupported = await migrate(again, ["--from-basin"], { fetch: old.fetch });
		expect(unsupported.error?.message).toContain("this backend doesn't support it yet: update it");
		const unsupportedTo = await migrate(again, ["--to-basin"], { fetch: old.fetch, oc: cloud.oc });
		expect(unsupportedTo.error?.message).toContain("this backend doesn't support it yet: update it");
		noSecrets(unsupported.error!.message + unsupportedTo.error!.message);
	});

	test("pause, resume, cancel and resolve send the contract's bodies; resolve checks its arguments", async () => {
		const proj = project({ backend: { url: NEW } });
		const net = migrateNetwork();
		for (const action of ["pause", "resume", "cancel"]) expect((await migrate(proj, [action], { fetch: net.fetch })).error).toBeUndefined();
		const resolved = await migrate(proj, ["resolve", "events/2026-11-14/3", "resend"], { fetch: net.fetch });
		expect(resolved.error).toBeUndefined();
		expect(resolved.out).toContain("page events/2026-11-14/3: sending it again");
		await migrate(proj, ["resolve", "p7", "skip"], { fetch: net.fetch });
		expect(net.posts.map((p) => p.body)).toEqual([
			{ action: "pause" },
			{ action: "resume" },
			{ action: "cancel" },
			{ action: "resolve", page: "events/2026-11-14/3", choice: "resend" },
			{ action: "resolve", page: "p7", choice: "skip" },
		]);
		expect((await migrate(proj, ["resolve", "p7", "maybe"], { fetch: net.fetch })).error?.message).toContain("resolve takes resend or skip");
		expect((await migrate(proj, ["resolve", "p7"], { fetch: net.fetch })).error).toBeInstanceOf(UsageError);
		expect((await migrate(proj, ["status", "--from", OLD_URL], { fetch: net.fetch })).error).toBeInstanceOf(UsageError);
		expect((await migrate(proj, ["pause", "--watch"], { fetch: net.fetch })).error).toBeInstanceOf(UsageError);
		expect((await migrate(proj, ["rewind"], { fetch: net.fetch })).error?.message).toContain('unknown migrate subcommand "rewind"');
		const noUrl = project();
		expect((await migrate(noUrl, ["status"], { fetch: net.fetch })).error?.message).toContain("typetorch.json has no backend.url");
	});
});

const RUNNING = {
	state: "running",
	direction: "from-backend",
	source: { kind: "backend", url: OLD_URL },
	startedAt: Date.parse("2026-11-15T10:00:00Z"),
	finishedAt: null,
	rowsPerSecond: 20000,
	rowsDone: 3_000_000,
	rowsTotal: 6_000_000,
	steps: [
		{ name: "erased", state: "done", done: 12, total: 12 },
		{ name: "identities", state: "done", done: 900, total: 900 },
		{ name: "fleet", state: "done", done: 5000, total: 5000 },
		{ name: "events", state: "running", done: 3, total: 6 },
		{ name: "recordings", state: "pending", done: 0, total: 0 },
		{ name: "live", state: "pending", done: 0, total: 0 },
		{ name: "rollups", state: "pending", done: 0, total: 0 },
		{ name: "verify", state: "pending", done: 0, total: 0 },
	],
	days: [
		{ table: "events", day: "2026-11-15", state: "match", rowsSource: 100, rowsTarget: 100, note: "" },
		{ table: "events", day: "2026-11-14", state: "missing", rowsSource: 5000, rowsTarget: 4880, note: "imported again once" },
		{ table: "events", day: "2026-11-13", state: "differs", rowsSource: 7000, rowsTarget: 7000, note: "" },
		{ table: "events", day: "2026-11-12", state: "importing", rowsSource: 9000, rowsTarget: 1000, note: "" },
		{ table: "events", day: "2026-11-11", state: "pending", rowsSource: 8000, rowsTarget: 0, note: "" },
		{ table: "recordings", day: "2026-11-15", state: "pending", rowsSource: 10, rowsTarget: 0, note: "" },
	],
	waitingFor: "the loader to catch up (raw/incoming 2 ticks behind)",
	decision: null,
	error: null,
};

describe("backend migrate status: the view", () => {
	setOutputMode({ json: false, verbose: false });
	const view = (raw: Record<string, unknown>, rate?: number) => plain(formatMigration(parseMigrationStatus(raw), { host: "new.example.com", now: Date.parse("2026-11-15T10:05:00Z"), rate }).join("\n"));

	test("running: route, bar and percent, rows/s, days to go, steps, per-table counts, the problem days, waitingFor", () => {
		const text = view(RUNNING);
		expect(text).toContain("migration running  from-backend  old.example.com -> this backend (new.example.com)");
		expect(text).toContain(`${progressBar(1, 2)} 50%`);
		expect(text).toContain("3,000,000 / 6,000,000 rows");
		// 3M rows in 300 s since the start.
		expect(text).toContain("10,000 rows/s");
		expect(text).toContain("cap 20,000/s");
		expect(text).toContain("3 days to go");
		expect(text).toContain("about 5 min left");
		expect(text).toContain("steps  erased ok, identities ok, fleet ok, events running 3/6, recordings pending");
		expect(text).toContain("events     5 days 2026-11-11..2026-11-15: 1 pending, 1 importing, 1 match, 1 missing, 1 differs");
		expect(text).toContain("recordings 1 day 2026-11-15: 1 pending");
		expect(text).toContain("2026-11-14 events     missing: missing 120 (source 5,000, here 4,880) imported again once");
		expect(text).toContain("2026-11-13 events     differs: differs (source 7,000, here 7,000)");
		expect(text).toContain("waiting for the loader to catch up");
		expect(text).not.toContain("decision");
		// A rate measured between two polls wins over the average.
		expect(view(RUNNING, 15_000)).toContain("15,000 rows/s");
	});

	test("needs_decision (to-basin): the question and both resolve commands; duplicates are counted", () => {
		const text = view({
			...RUNNING,
			state: "needs_decision",
			direction: "to-basin",
			source: { kind: "backend" },
			days: [
				{ table: "events", day: "2026-11-14", state: "duplicates", rowsSource: 5000, rowsTarget: 5400, note: "" },
				{ table: "events", day: "2026-11-13", state: "match", rowsSource: 7000, rowsTarget: 7000, note: "" },
			],
			waitingFor: null,
			decision: { page: "events/2026-11-12/4", question: "page events/2026-11-12/4 was cut off mid-send" },
		});
		expect(text).toContain("migration needs_decision  to-basin  this backend (new.example.com) -> Basin");
		expect(text).toContain("decision page events/2026-11-12/4 was cut off mid-send");
		expect(text).toContain("typetorch backend migrate resolve events/2026-11-12/4 resend");
		expect(text).toContain("typetorch backend migrate resolve events/2026-11-12/4 skip");
		expect(text).toContain("2026-11-14 events     duplicates: 400 duplicate rows");
		expect(text).not.toContain("rows/s ");
	});

	test("done with every day matching: 100%, the turn-off hint; failed shows the error; idle says how to start", () => {
		const done = view({
			...RUNNING,
			state: "done",
			finishedAt: Date.parse("2026-11-15T10:10:00Z"),
			rowsDone: 6_000_000,
			steps: RUNNING.steps.map((s) => ({ ...s, state: "done" })),
			days: RUNNING.days.map((d) => ({ ...d, state: "match", rowsTarget: d.rowsSource })),
			waitingFor: null,
		});
		expect(done).toContain("migration done");
		expect(done).toContain("100%");
		expect(done).toContain("finished 2026-11-15 10:10 UTC");
		expect(done).toContain("0 days to go");
		expect(done).toContain("events     5 days 2026-11-11..2026-11-15: 5 match");
		expect(done).toContain("every day matches: keep a last backup of the source, then turn it off");
		expect(done).not.toContain("rows/s");
		// The Basin directions: their own finish line; `sent` (to-basin without read settings) is a known state.
		const toBasin = view({ ...RUNNING, direction: "to-basin", state: "done", steps: [], days: RUNNING.days.map((d, i) => ({ ...d, state: i ? "match" : "sent", rowsTarget: d.rowsSource })), waitingFor: null });
		expect(toBasin).toContain("sent = posted but not counted in Basin");
		expect(toBasin).not.toContain("every day is in Basin");
		const toBasinDone = view({ ...RUNNING, direction: "to-basin", state: "done", steps: [], days: RUNNING.days.map((d) => ({ ...d, state: "match", rowsTarget: d.rowsSource })), waitingFor: null });
		expect(toBasinDone).toContain("every day is in Basin");
		const fromBasin = view({ ...RUNNING, direction: "from-basin", state: "done", steps: [], days: RUNNING.days.map((d) => ({ ...d, state: "match", rowsTarget: d.rowsSource })), waitingFor: null });
		expect(fromBasin).toContain("every day matches Basin's counts");
		const failed = view({ ...RUNNING, state: "failed", error: "the old server answered 401: its admin token changed" });
		expect(failed).toContain("error the old server answered 401");
		expect(view({ state: "idle", direction: null, steps: [], days: [] })).toContain("no move has run on new.example.com");
		// A lenient parse: a bare reply still renders.
		expect(view({})).toContain("migration ?");
	});

	test("status prints the view; --json is the backend's reply as-is; --watch polls until a final state and Ctrl+C exits cleanly", async () => {
		const proj = project({ backend: { url: NEW } });
		const doneStatus = { ...RUNNING, state: "done", rowsDone: 6_000_000, waitingFor: null };
		const net = migrateNetwork({ status: [RUNNING, { ...RUNNING, rowsDone: 3_100_000 }, doneStatus] });
		const once = await migrate(proj, ["status"], { fetch: net.fetch });
		expect(once.out).toContain("migration running");

		setOutputMode({ json: true, verbose: false });
		let emitted: Record<string, unknown> | undefined;
		try {
			emitted = (await captureJson(async () => void (await migrate(proj, ["status"], { fetch: net.fetch })))) as Record<string, unknown>;
		} finally {
			setOutputMode({ json: false, verbose: false });
		}
		expect(emitted?.rowsDone).toBe(3_100_000);

		let clock = Date.parse("2026-11-15T10:05:00Z");
		const sleeps: number[] = [];
		const watched = await migrate(proj, ["status", "--watch"], {
			fetch: migrateNetwork({ status: [RUNNING, { ...RUNNING, rowsDone: 3_100_000 }, doneStatus] }).fetch,
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			signal: new AbortController().signal,
		});
		expect(watched.error).toBeUndefined();
		// Three polls, 5 s apart, then the final state ends it; the second round measured 100,000 rows in 5 s.
		expect(sleeps).toEqual([5000, 5000]);
		expect(watched.out).toContain("20,000 rows/s");
		expect(watched.out).toContain("migration done");

		// Ctrl+C (the signal) while waiting: a clean stop, the job keeps running.
		const ctrlC = new AbortController();
		const stopped = await migrate(proj, ["status", "--watch"], {
			fetch: migrateNetwork({ status: [RUNNING] }).fetch,
			sleep: async () => ctrlC.abort(),
			signal: ctrlC.signal,
		});
		expect(stopped.error).toBeUndefined();
		expect(stopped.out).toContain("stopped watching; the migration keeps running on the backend");

		// A backend that stops answering is retried; a refused admin token ends it.
		const flaky = migrateNetwork({ status: [RUNNING] });
		let calls = 0;
		const flakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (calls++ === 0) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
			return flaky.fetch(input, init);
		}) as typeof fetch;
		let rounds = 0;
		const retried = await migrate(proj, ["status", "--watch"], { fetch: flakyFetch, sleep: async () => {}, until: () => ++rounds >= 1, signal: new AbortController().signal });
		expect(retried.error).toBeUndefined();
		expect(retried.out).toContain("trying again in 5 s");
		expect(retried.out).toContain("migration running");
		const badToken = project({ backend: { url: NEW } }, { ...KEYS, TYPETORCH_ADMIN_TOKEN: "wrong-admin-token-0123456789abcdef" });
		const refused = await migrate(badToken, ["status", "--watch"], { fetch: flaky.fetch, sleep: async () => {}, signal: new AbortController().signal });
		expect(refused.error?.message).toContain("refused the admin token");
		expect((await migrate(proj, ["status", "--watch", "--json"], { fetch: net.fetch })).error).toBeDefined();
	});
});
