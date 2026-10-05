import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { autoRollbackHook, countdown } from "../src/commands/autorollback";
import {
	alertsCommand,
	alertsFlags,
	fleetCommand,
	fleetFlags,
	reportCommand,
	rollbackThreshold,
	serversCommand,
	waitForFleet,
	waitSeconds,
	WAIT_FLAGS,
	type FleetDeps,
} from "../src/commands/fleet";
import { validateConfig, type Project } from "../src/config";
import { appendLocalLog, readLocalLog, type LocalDeployment } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import {
	formatServersTable,
	httpFleetClient,
	parseReport,
	parseServer,
	rollbackCommand,
	rollbackDecision,
	summarize,
	type AlertRow,
	type FleetClient,
	type NewAlert,
	type ReportRow,
	type ServerRow,
} from "../src/fleet";
import { scriptedInteraction } from "../src/interact";
import { loadSigner, newKeyFile, writeKeyFile } from "../src/keyfiles";
import { setOutputMode } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import { verifySigned } from "../src/signing";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
	process.exitCode = 0;
});

const NOW = 1_791_220_000; // unix seconds
const job = (n: number) => `0000000${n}-aaaa-bbbb-cccc-000000000000`.slice(-36);
// Rows as the kernel posts them (short names; kernel src/server/Reports.luau).
const server = (n: number, patch: Record<string, unknown> = {}) => ({ j: job(n), t: "public", b: "dev", c: "dev", a: "4363e8c-d2b6d6", n: 3, m: 20, s: NOW - 3600, u: NOW - 20, p: 7, v: "0.3.2", q: 41, g: 2, h: "ok", sv: 2, ...patch });
const report = (seq: number, n: number, r: string, patch: Record<string, unknown> = {}) => ({ s: seq, b: "dev", a: "4363e8c-d2b6d6", j: job(n), r, d: 0.3, t: NOW - 5, g: 3, k: "0.3.2", p: 3, ...patch });

/** A fake fleet API: servers and reports change with `round` (each servers() call is one poll). */
function fakeFleet(rounds: { servers: Record<string, unknown>[]; reports: Record<string, unknown>[] }[], alerts: AlertRow[] = [], tick: "reports" | "servers" = "reports") {
	let round = -1;
	const posted: NewAlert[] = [];
	const at = () => rounds[Math.min(Math.max(round, 0), rounds.length - 1)];
	const fleet: FleetClient = {
		async servers(q = {}) {
			if (tick === "servers") round++;
			return at().servers.map(parseServer).filter((s): s is ServerRow => !!s && (!q.branch || s.branch === q.branch));
		},
		async reports(q) {
			if (tick === "reports") round++;
			return at().reports.map(parseReport).filter((r): r is ReportRow => !!r && (q.seq === undefined || r.seq === q.seq));
		},
		async alerts() {
			return alerts;
		},
		async postAlert(alert) {
			posted.push(alert);
			return true;
		},
	};
	return { fleet, posted, rounds: () => round + 1 };
}

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-fleet-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "none", ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	const { config, errors } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings: [] };
}

const clock = () => {
	let t = 0;
	return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => (t += ms) };
};

describe("rows from the fleet API", () => {
	test("short (kernel) and long field names; access codes never kept", () => {
		const short = parseServer({ ...server(1), k: "secret-code" })!;
		expect(short).toMatchObject({ jobId: job(1), branch: "dev", seq: 41, health: "ok", players: 3, maxPlayers: 20, accessCode: true, kernelVersion: "0.3.2", schema: 2 });
		expect(JSON.stringify(short)).not.toContain("secret-code");
		const long = parseServer({ job: job(2), branch: "prod", artifact: "x", players: 1, maxPlayers: 10, startedAt: "2026-10-05T10:00:00Z", lastWrite: NOW * 1000, appliedSeq: 9, health: "degraded", kernel: "0.3.2", lastError: "boom" })!;
		expect(long).toMatchObject({ jobId: job(2), seq: 9, health: "degraded", error: "boom", updatedAt: NOW, startedAt: Date.parse("2026-10-05T10:00:00Z") / 1000 });
		expect(parseServer({ branch: "x" })).toBeUndefined();
		expect(parseReport(report(42, 3, "booted"))).toMatchObject({ seq: 42, jobId: job(3), result: "booted" });
		expect(parseReport({ seq: 42, job: job(4), result: "failed", error: "x", at: "2026-10-05T10:00:00Z" })).toMatchObject({ result: "failed", error: "x" });
	});
	test("the HTTP client: paths, the admin token for reads and the ingest token for alerts, errors without tokens", async () => {
		const calls: { url: string; auth?: string; method: string; body?: string }[] = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, method: init.method!, auth: (init.headers as Record<string, string>).authorization, body: init.body as string | undefined });
			if (url.includes("/reports")) return new Response(JSON.stringify({ reports: [report(42, 1, "swapped")] }));
			if (url.includes("/alerts")) return new Response(JSON.stringify({ alerts: [{ id: "a1", at: NOW * 1000, level: "warning", code: "server_stuck" }] }));
			if (url.endsWith("/alert")) return new Response("{}");
			return new Response(JSON.stringify({ servers: [server(1)] }));
		}) as unknown as typeof fetch;
		const client = httpFleetClient({ url: "https://fleet.example/", token: "admin-token-0000", ingestToken: "ingest-token-0000", fetch: fakeFetch });
		expect(await client.servers({ branch: "dev" })).toHaveLength(1);
		expect((await client.reports({ seq: 42 }))[0].result).toBe("swapped");
		expect((await client.alerts({ since: 5, level: "warning" }))[0]).toMatchObject({ code: "server_stuck", at: NOW * 1000 });
		expect(await client.postAlert({ level: "critical", code: "auto_rollback", message: "x" })).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url} ${c.auth}`)).toEqual([
			"GET https://fleet.example/v1/fleet/servers?branch=dev Bearer admin-token-0000",
			"GET https://fleet.example/v1/fleet/reports?seq=42 Bearer admin-token-0000",
			"GET https://fleet.example/v1/fleet/alerts?since=5&level=warning Bearer admin-token-0000",
			"POST https://fleet.example/v1/fleet/alert Bearer ingest-token-0000",
		]);
		const refused = httpFleetClient({ url: "https://fleet.example", token: "admin-token-0000", fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
		const error = (await refused.servers().catch((e: Error) => e)) as Error;
		expect(error.message).toContain("check TYPETORCH_FLEET_TOKEN");
		expect(error.message).not.toContain("admin-token");
		expect(await httpFleetClient({ url: "https://fleet.example", fetch: fakeFetch }).postAlert({ level: "info", code: "x", message: "y" })).toBe(false);
	});
});

describe("summaries and the rollback decision", () => {
	const servers = [server(1, { q: 42 }), server(2, { q: 41, h: "failed", e: "boom" }), server(3, { q: 41 }), server(4, { q: undefined, sv: undefined }), server(5, { b: "prod", q: 40 })].map((s) => parseServer(s)!);
	const reports = [report(42, 1, "skipped", { t: NOW - 50 }), report(42, 1, "swapped", { t: NOW - 10 }), report(42, 2, "failed", { e: "Server.boot: attempt to index nil" }), report(42, 6, "rolled_back", { e: "Server.boot: attempt to index nil" })].map((r) => parseReport(r)!);
	test("counts (newest report per server), errors grouped, servers still on older seqs", () => {
		const summary = summarize({ seq: 42, branch: "dev", artifactId: "4363e8c-d2b6d6", reports, servers });
		expect(summary.counts).toEqual({ swapped: 1, failed: 1, rolled_back: 1 });
		expect(summary.errors).toEqual([{ error: "Server.boot: attempt to index nil", count: 2, jobs: [job(2), job(6)] }]);
		expect(summary.stillOld.map((s) => s.jobId)).toEqual([job(2), job(3)]);
		expect(summary.waiting).toEqual([job(3), job(4)]);
		expect(summary.bad).toBe(true);
	});
	test("threshold over the servers that tried it (skipped excluded); early when it can't drop below", () => {
		const s = (counts: Record<string, number>, waiting: number) => ({ counts, reports: Object.values(counts).reduce((a, b) => a + b, 0), waiting: Array.from({ length: waiting }, (_, i) => job(i)) }) as never;
		expect(rollbackDecision(s({ swapped: 4, failed: 1 }, 0), 20)).toMatchObject({ failures: 1, answered: 5, met: true, early: true });
		expect(rollbackDecision(s({ swapped: 5, failed: 1 }, 0), 20)).toMatchObject({ met: false });
		expect(rollbackDecision(s({ swapped: 1, failed: 1, skipped: 10 }, 0), 20)).toMatchObject({ answered: 2, met: true });
		expect(rollbackDecision(s({ failed: 1 }, 10), 20)).toMatchObject({ met: true, early: false }); // 1 of 11 could still be < 20%
		expect(rollbackDecision(s({ failed: 3 }, 2), 20)).toMatchObject({ early: true }); // 3 of 5 whatever the rest say
		expect(rollbackDecision(s({ swapped: 3 }, 0), 20)).toMatchObject({ met: false, early: false });
	});
	test("the servers table and the rollback command (no #: PowerShell comments)", () => {
		const text = formatServersTable(servers.slice(0, 1), NOW);
		expect(text.split("\n")[0].split(/\s{2,}/)).toEqual(["job", "branch", "artifact", "seq", "health", "players", "kernel", "age", "seen"]);
		expect(text).toContain("#42");
		expect(rollbackCommand("prod", "12b63b9-3fa91c")).toBe("typetorch rollback --branch prod --to 12b63b9-3fa91c");
	});
});

describe("commands", () => {
	const capture = async (fn: () => Promise<void>) => {
		const out: string[] = [];
		const log = console.log;
		console.log = (line: string) => void out.push(line);
		try {
			await fn();
		} finally {
			console.log = log;
		}
		return out.join("\n");
	};
	const inProject = async <T>(proj: Project, fn: () => Promise<T>) => {
		const cwd = process.cwd();
		process.chdir(proj.root);
		try {
			return await fn();
		} finally {
			process.chdir(cwd);
		}
	};
	test("not configured: one line, nothing thrown", async () => {
		const proj = project();
		const text = await inProject(proj, () => capture(() => serversCommand(parseArgs([], { branch: "string", watch: "boolean" }))));
		expect(text).toBe(`the fleet API isn't configured: set typetorch.json "fleet": { "url": ... } (typetorch fleet setup --url <url>)`);
		const proj2 = project({ fleet: { url: "https://fleet.example" } });
		expect(await inProject(proj2, () => capture(() => serversCommand(parseArgs([], { branch: "string", watch: "boolean" }))))).toContain("TYPETORCH_FLEET_TOKEN");
	});
	test("servers --branch --json, and --watch rounds", async () => {
		const proj = project();
		const { fleet, rounds } = fakeFleet([{ servers: [server(1), server(2, { b: "prod" })], reports: [] }], [], "servers");
		setOutputMode({ json: true, verbose: false });
		const out = JSON.parse(await inProject(proj, () => capture(() => serversCommand(parseArgs(["--branch", "dev"], { branch: "string", watch: "boolean" }), { fleet, now: () => NOW * 1000 }))));
		expect(out.count).toBe(1);
		expect(out.servers[0]).toMatchObject({ jobId: job(1), uptimeSeconds: 3600, lastSeenSeconds: 20 });
		setOutputMode({ json: false, verbose: false });
		let n = 0;
		await inProject(proj, () => capture(() => serversCommand(parseArgs(["--watch"], { branch: "string", watch: "boolean" }), { fleet, now: () => NOW * 1000, sleep: async () => {}, until: () => ++n >= 3 })));
		expect(rounds()).toBe(4);
	});
	test("report latest: reads the log, exits 1 on failures, prints the rollback command", async () => {
		const proj = project();
		appendLocalLog(join(proj.root, ".typetorch"), { seq: 42, at: new Date().toISOString(), action: "deploy", branch: "dev", channel: "dev", artifactId: "4363e8c-d2b6d6", assetId: 1234567890, commit: "4363e8c", commitHash: "", dirty: false, by: "me", fromArtifactId: "8803f18-08ba71" });
		const { fleet } = fakeFleet([{ servers: [server(1, { q: 42 }), server(2, { q: 41 })], reports: [report(42, 1, "swapped"), report(42, 2, "failed", { e: "boom" })] }]);
		const text = await inProject(proj, () => capture(() => reportCommand(parseArgs(["latest", "--no-registry"], { branch: "string", "no-registry": "boolean" }), { fleet })));
		expect(text).toContain("#42 dev 4363e8c-d2b6d6: 1 swapped, 1 failed");
		expect(text).toContain("error [x1] boom");
		expect(text).toContain("typetorch rollback --branch dev --to 8803f18-08ba71");
		expect(process.exitCode).toBe(1);
	});
	test("alerts: newest last, --follow prints only new ones", async () => {
		const proj = project();
		const alerts: AlertRow[] = [
			{ id: "2", at: NOW * 1000, level: "critical", code: "auto_rollback", message: "rolled back", branch: "prod", seq: 9 },
			{ id: "1", at: NOW * 1000 - 5000, level: "warning", code: "server_stuck", message: "1 server" },
		];
		const { fleet } = fakeFleet([{ servers: [], reports: [] }], alerts);
		let n = 0;
		const text = await inProject(proj, () => capture(() => alertsCommand(parseArgs(["--follow"], alertsFlags), { fleet, now: () => NOW * 1000, sleep: async () => {}, until: () => ++n >= 2 })));
		const lines = text.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("server_stuck");
		expect(lines[1]).toContain("auto_rollback");
		expect(() => parseArgs(["--level", "loud"], alertsFlags)).not.toThrow();
		await expect(inProject(proj, () => alertsCommand(parseArgs(["--level", "loud"], alertsFlags), { fleet }))).rejects.toThrow(/--level/);
	});
	test("fleet setup: PATCH the draft with only TypeTorchFleet, publish, never read; typetorch.json fleet.url; the token never printed", async () => {
		const proj = project();
		useSettings(new Settings({ startDir: proj.root, env: { TYPETORCH_FLEET_INGEST_TOKEN: "ingest-secret-1234567890" } }));
		const calls: { method: string; path: string; json?: any }[] = [];
		const oc = { call: async (method: string, path: string, options: { json?: unknown } = {}) => (calls.push({ method, path, json: options.json }), method === "PATCH" ? { draftHash: "h1" } : { configVersion: 7 }) };
		const text = await inProject(proj, () => capture(() => fleetCommand(parseArgs(["setup", "--url", "https://fleet.example"], fleetFlags), { oc })));
		expect(calls.map((c) => `${c.method} ${c.path.replace(/.*repositories/, "")}`)).toEqual(["PATCH /InExperienceConfig/draft", "POST /InExperienceConfig/publish"]);
		expect(calls[0].json).toEqual({ entries: { TypeTorchFleet: { url: "https://fleet.example", token: "ingest-secret-1234567890" } } });
		expect(calls[1].json).toMatchObject({ draftHash: "h1", deploymentStrategy: "Immediate" });
		expect(text).not.toContain("ingest-secret");
		expect(JSON.parse(readFileSync(proj.configPath, "utf8")).fleet).toEqual({ url: "https://fleet.example" });
		await expect(inProject(proj, () => fleetCommand(parseArgs(["setup", "--url", "http://fleet.example"], fleetFlags), { oc }))).rejects.toThrow(/https/);
	});
});

describe("--wait", () => {
	test("on by default for prod (90 s), off for dev; --wait [s], --no-wait; --rollback-at, --no-auto-rollback", () => {
		const spec = { ...WAIT_FLAGS };
		expect(waitSeconds(parseArgs([], spec), "prod")).toBe(90);
		expect(waitSeconds(parseArgs([], spec), "dev")).toBeUndefined();
		expect(waitSeconds(parseArgs(["--wait", "30"], spec), "dev")).toBe(30);
		expect(waitSeconds(parseArgs(["--no-wait"], spec), "prod")).toBeUndefined();
		expect(parseArgs(["--wait", "latest"], spec)).toEqual({ positionals: ["latest"], flags: { wait: true } });
		expect(rollbackThreshold(parseArgs([], spec))).toBe(20);
		expect(rollbackThreshold(parseArgs(["--rollback-at", "50"], spec))).toBe(50);
		expect(rollbackThreshold(parseArgs(["--no-auto-rollback"], spec))).toBeUndefined();
		expect(() => rollbackThreshold(parseArgs(["--rollback-at", "0"], spec))).toThrow();
	});
	test("re-sends the same message once at 30 s while servers are still behind, then summarizes", async () => {
		const c = clock();
		const behind = { servers: [server(1, { q: 41 }), server(2, { q: 41 })], reports: [] };
		const { fleet } = fakeFleet([behind, behind, behind, behind, behind, behind, behind, { servers: [server(1, { q: 42 }), server(2, { q: 42 })], reports: [report(42, 1, "swapped"), report(42, 2, "swapped")] }]);
		let resends = 0;
		const result = await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: "x", seconds: 90, resend: async () => void resends++, deps: c });
		expect(resends).toBe(1);
		expect(result).toMatchObject({ resent: true, timedOut: false });
		expect(result.summary?.counts).toEqual({ swapped: 2 });
	});
	test("stalled only: no rollback; the stuck JobIds and a server_stuck warning alert; exit 0", async () => {
		const c = clock();
		const { fleet, posted } = fakeFleet([{ servers: [server(1, { q: 42 }), server(2, { q: 41 })], reports: [report(42, 1, "swapped")] }]);
		let ran = false;
		const result = await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: "x", seconds: 20, autoRollback: { threshold: 20, run: async () => ((ran = true), { rolledBack: true }) }, deps: c });
		expect(ran).toBe(false);
		expect(result.stuck).toEqual([job(2)]);
		expect(posted).toEqual([expect.objectContaining({ level: "warning", code: "server_stuck", seq: 42, jobs: [job(2)] })]);
		expect(process.exitCode ?? 0).toBe(0);
	});
	test("--no-auto-rollback: failures exit 1 and print the command, nothing rolled back", async () => {
		const c = clock();
		const { fleet } = fakeFleet([{ servers: [server(1, { q: 41 })], reports: [report(42, 1, "failed", { e: "boom" })] }]);
		const result = await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: "x", seconds: 20, deps: c });
		expect(result.autoRollback).toBeUndefined();
		expect(process.exitCode).toBe(1);
	});
	test("below the threshold: no rollback, exit 1", async () => {
		const c = clock();
		const reports = [report(42, 1, "failed"), ...[2, 3, 4, 5, 6].map((n) => report(42, n, "swapped"))];
		const { fleet } = fakeFleet([{ servers: [1, 2, 3, 4, 5, 6].map((n) => server(n, { q: n === 1 ? 41 : 42 })), reports }]);
		let ran = false;
		await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: "x", seconds: 20, autoRollback: { threshold: 20, run: async () => ((ran = true), { rolledBack: true }) }, deps: c });
		expect(ran).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("automatic rollback", () => {
	const keyDir = () => mkdtempSync(join(tmpdir(), "tt-fleet-keys-"));
	function deployed(proj: Project, branch: string, channel: "dev" | "prod") {
		const dir = join(proj.root, ".typetorch");
		const base = { at: new Date().toISOString(), action: "deploy" as const, branch, channel, commitHash: "", dirty: false, by: "me", universeId: 42 };
		appendLocalLog(dir, { ...base, seq: 41, artifactId: "8803f18-08ba71", assetId: 103115537258877, commit: "8803f18" });
		const entry: LocalDeployment = { ...base, seq: 42, artifactId: "4363e8c-d2b6d6", assetId: 128525130415605, commit: "4363e8c", fromAssetId: 103115537258877, fromArtifactId: "8803f18-08ba71", proposalId: "abcd1234" };
		appendLocalLog(dir, entry);
		return entry;
	}
	const failing = () => fakeFleet([{ servers: [1, 2, 3, 4].map((n) => server(n, { q: n === 1 ? 41 : 42 })), reports: [report(42, 1, "rolled_back", { e: "boom" }), ...[2, 3, 4].map((n) => report(42, n, "swapped"))] }]);
	function oc() {
		const published: string[] = [];
		return { published, oc: { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud };
	}
	test("at the threshold (1 of 4 = 25% >= 20%): critical alert, rollback to the previous artifact, reason logged, waits for its reports", async () => {
		const proj = project();
		const entry = deployed(proj, "dev", "dev");
		const { fleet, posted } = failing();
		const { oc: client, published } = oc();
		let waitedFor: number | undefined;
		const hook = autoRollbackHook(
			{ proj, oc: client, fleet, deployed: entry, branchChannel: "dev", keyPaths: { main: "x", fallback: "y" }, countdown: async () => "go", waitAfter: async (r) => void (waitedFor = r.entry.seq) },
			20,
		);
		const result = await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: entry.artifactId, fromArtifactId: entry.fromArtifactId, seconds: 60, autoRollback: hook, deps: clock() });
		expect(result.autoRollback).toEqual({ rolledBack: true, seq: 43 });
		expect(posted[0]).toMatchObject({ level: "critical", code: "auto_rollback", branch: "dev", seq: 42 });
		const message = JSON.parse(published[0]);
		expect(message).toMatchObject({ b: "dev", a: 103115537258877, i: "8803f18-08ba71", s: 43, r: 1 });
		const line = readLocalLog(join(proj.root, ".typetorch")).at(-1)!;
		expect(line).toMatchObject({ action: "rollback", proposedBy: "auto-rollback", autoRollback: { fromSeq: 42, fromArtifactId: "4363e8c-d2b6d6", reason: expect.stringContaining("1 of 4") } });
		expect(readFileSync(join(proj.root, ".typetorch", "proposals.jsonl"), "utf8")).toContain('"event":"auto_rollback","id":"abcd1234"');
		expect(waitedFor).toBe(43);
		expect(process.exitCode).toBe(1);
	});
	test("decides early once the threshold can't be missed (3 failed, 2 still to report: 60%)", async () => {
		const c = clock();
		const { fleet, rounds } = fakeFleet([{ servers: [1, 2, 3, 4, 5].map((n) => server(n, { q: 41 })), reports: [1, 2, 3].map((n) => report(42, n, "failed")) }]);
		let ran = 0;
		const result = await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: "x", seconds: 90, autoRollback: { threshold: 20, run: async () => (ran++, { rolledBack: true, seq: 43 }) }, deps: c });
		expect(rounds()).toBe(1);
		expect(c.now()).toBe(0);
		expect(ran).toBe(1);
		expect(result.decision).toMatchObject({ failures: 3, answered: 3, waiting: 2, early: true });
	});
	test("Ctrl+C in the 10 s window keeps the new build (nothing published)", async () => {
		const proj = project();
		const entry = deployed(proj, "dev", "dev");
		const { fleet } = failing();
		const { oc: client, published } = oc();
		const hook = autoRollbackHook({ proj, oc: client, fleet, deployed: entry, branchChannel: "dev", keyPaths: { main: "x", fallback: "y" }, countdown: async () => "kept" }, 20);
		const result = await waitForFleet({ fleet, branch: "dev", seq: 42, artifactId: entry.artifactId, seconds: 60, autoRollback: hook, deps: clock() });
		expect(result.autoRollback).toEqual({ rolledBack: false, kept: true });
		expect(published).toEqual([]);
		// the real window: SIGINT keeps; no terminal means no wait at all
		setTimeout(() => process.emit("SIGINT" as never), 20);
		expect(await countdown(scriptedInteraction({ interactive: true }), 5, "rolling back")).toBe("kept");
		expect(await countdown(scriptedInteraction({ interactive: false }), 5, "rolling back")).toBe("go");
	});
	test("a prod-channel branch: the rollback message is signed with both keys", async () => {
		const dir = keyDir();
		const paths = { main: join(dir, "42.key"), fallback: join(dir, "42.fallback.key") };
		const main = newKeyFile("main", 42);
		const fallback = newKeyFile("fallback", 42);
		writeKeyFile(paths.main, main);
		writeKeyFile(paths.fallback, fallback);
		const proj = project({ signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555 });
		const entry = deployed(proj, "prod", "prod");
		const { fleet } = failing();
		const { oc: client, published } = oc();
		const hook = autoRollbackHook({ proj, oc: client, fleet, deployed: { ...entry, branch: "prod" }, branchChannel: "prod", keyPaths: paths, countdown: async () => "go" }, 20);
		await hook.run({ summary: {} as never, decision: {} as never, reason: "test" });
		const message = JSON.parse(published[0]);
		expect(message).toMatchObject({ b: "prod", r: 1, s: 43 });
		expect(verifySigned({ assetLoaded: true, publicKeys: [main.publicKey], revokedKeys: [], fallbackPublicKey: fallback.publicKey }, message, message)).toBe("sig");
		expect(loadSigner(proj, paths)).toBeDefined();
	});
	test("nothing earlier to roll back to: a warning, nothing published", async () => {
		const proj = project();
		const entry: LocalDeployment = { seq: 1, at: new Date().toISOString(), action: "deploy", branch: "dev", channel: "dev", artifactId: "a", assetId: 1, commit: "a", commitHash: "", dirty: false, by: "me" };
		appendLocalLog(join(proj.root, ".typetorch"), entry);
		const { fleet } = failing();
		const { oc: client, published } = oc();
		const hook = autoRollbackHook({ proj, oc: client, fleet, deployed: entry, branchChannel: "dev", keyPaths: { main: "x", fallback: "y" }, countdown: async () => "go" }, 20);
		expect(await hook.run({ summary: {} as never, decision: {} as never, reason: "x" })).toEqual({ rolledBack: false });
		expect(published).toEqual([]);
	});
});

export type { FleetDeps };
