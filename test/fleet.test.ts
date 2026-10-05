import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { reportCommand, serversCommand, waitForFleet, waitSeconds, WAIT_FLAGS } from "../src/commands/fleet";
import { validateConfig, type Project } from "../src/config";
import { appendLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import {
	FLEET_SCOPE,
	FleetScopeError,
	formatServersTable,
	listSortedMap,
	parseReport,
	parseServer,
	reportFilter,
	rollbackCommand,
	summarize,
	type ReportRow,
	type ServerRow,
} from "../src/fleet";
import { setOutputMode } from "../src/log";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
	process.exitCode = 0;
});

const NOW = 1_791_220_000; // unix seconds
const job = (n: number) => `0000000${n}-aaaa-bbbb-cccc-000000000000`.slice(-36);

/** A fake MemoryStore: the Open Cloud list endpoint over two maps, with pages of `pageSize` and the id filter. */
function fakeStore(maps: Record<string, { id: string; value: unknown }[]>, options: { pageSize?: number; status?: number; field?: string } = {}) {
	const calls: string[] = [];
	return {
		calls,
		oc: {
			async request(_method: string, path: string) {
				calls.push(path);
				if (options.status) return { status: options.status, ok: false, body: {}, text: "Scope not authorized.", headers: new Headers() };
				const url = new URL(`https://x${path}`);
				const map = decodeURIComponent(url.pathname.split("/")[7]);
				let items = [...(maps[map] ?? [])].sort((a, b) => a.id.localeCompare(b.id));
				const filter = url.searchParams.get("filter");
				if (filter) {
					const [, low, high] = /id > "([^"]*)" && id < "([^"]*)"/.exec(filter)!;
					items = items.filter((i) => i.id > low && i.id < high);
				}
				const start = Number(url.searchParams.get("pageToken") ?? 0);
				const size = options.pageSize ?? 100;
				const page = items.slice(start, start + size);
				const next = start + size < items.length ? String(start + size) : undefined;
				return { status: 200, ok: true, body: { [options.field ?? "items"]: page.map((i) => ({ path: `cloud/v2/universes/42/memory-store/sorted-maps/${map}/items/${encodeURIComponent(i.id)}`, id: i.id, value: i.value, etag: "e", expireTime: "2026-10-05T12:00:00Z" })), ...(next ? { nextPageToken: next } : {}) }, text: "", headers: new Headers() };
			},
		},
	};
}

const server = (n: number, patch: Record<string, unknown> = {}) => ({
	id: job(n),
	value: { t: "public", b: "dev", c: "dev", a: "12b63b9-3fa91c", n: 3, m: 20, s: NOW - 3600, u: NOW - 20, p: 7, v: "0.3.2", q: 41, g: 2, h: "ok", sv: 2, ...patch },
});
const report = (seq: number, n: number, r: string, patch: Record<string, unknown> = {}) => ({
	id: `${String(seq).padStart(10, "0")}/${job(n)}`,
	value: { s: seq, b: "dev", a: "4363e8c-d2b6d6", j: job(n), r, d: 0.3, t: NOW - 5, g: 3, k: "0.3.2", p: 3, ...patch },
});

function project(): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-fleet-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" } };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw));
	const { config } = validateConfig(raw);
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config: config!, warnings: [] };
}

describe("reading the maps", () => {
	test("pages through every item (v2 `items` or the beta's field), with the seq filter", async () => {
		const store = fakeStore({ TypeTorchReports: [report(41, 1, "swapped"), report(42, 1, "swapped"), report(42, 2, "failed"), report(42, 3, "skipped"), report(420, 4, "swapped")] }, { pageSize: 2 });
		const { items } = await listSortedMap(store.oc, 42, "TypeTorchReports", { filter: reportFilter(42) });
		expect(items.map((i) => i.id.split("/")[0])).toEqual(["0000000042", "0000000042", "0000000042"]);
		expect(store.calls).toHaveLength(2);
		expect(decodeURIComponent(store.calls[0])).toContain('filter=id > "0000000042/" && id < "0000000042/~"');
		const beta = fakeStore({ TypeTorchServers: [server(1)] }, { field: "memoryStoreSortedMapItems" });
		expect((await listSortedMap(beta.oc, 42, "TypeTorchServers")).items).toHaveLength(1);
	});
	test("a missing scope is a FleetScopeError naming the scope; a missing map is empty", async () => {
		const refused = fakeStore({}, { status: 403 });
		const error = await listSortedMap(refused.oc, 42, "TypeTorchServers").catch((e) => e);
		expect(error).toBeInstanceOf(FleetScopeError);
		expect(error.message).toContain(FLEET_SCOPE);
		expect((await listSortedMap(fakeStore({}, { status: 404 }).oc as any, 42, "x").catch(() => "threw"))).not.toBe("threw");
	});
	test("rows: old kernels (no q/h/sv), string values, and access codes are never kept", () => {
		const row = parseServer({ id: job(1), value: { b: "prod", a: "x", s: NOW, u: NOW, v: "0.3.1", k: "secret-code", n: 1, m: 10 } })!;
		expect(row).toMatchObject({ branch: "prod", seq: undefined, health: undefined, schema: undefined, accessCode: true, kernelVersion: "0.3.1" });
		expect(JSON.stringify(row)).not.toContain("secret-code");
		expect(parseServer({ id: job(2), value: "not an object" })).toBeUndefined();
		expect(parseReport({ id: `0000000042/${job(3)}`, value: { r: "booted", t: NOW } })).toMatchObject({ seq: 42, jobId: job(3), result: "booted" });
	});
});

describe("summaries", () => {
	const servers = [server(1, { q: 42 }), server(2, { q: 41, h: "failed", e: "boom" }), server(3, { q: 41 }), server(4, { q: undefined, sv: undefined }), server(5, { b: "prod", c: "prod", q: 40 })].map((s) => parseServer(s)!);
	const reports = [report(42, 1, "skipped", { t: NOW - 50 }), report(42, 1, "swapped", { t: NOW - 10 }), report(42, 2, "failed", { e: "Server.boot: attempt to index nil" }), report(42, 6, "rolled_back", { e: "Server.boot: attempt to index nil" })].map((r) => parseReport(r)!);
	test("counts (newest report per server), errors grouped, servers still on older seqs", () => {
		const summary = summarize({ seq: 42, branch: "dev", artifactId: "4363e8c-d2b6d6", reports, servers });
		expect(summary.counts).toEqual({ swapped: 1, failed: 1, rolled_back: 1 });
		expect(summary.errors).toEqual([{ error: "Server.boot: attempt to index nil", count: 2, jobs: [job(2), job(6)] }]);
		expect(summary.stillOld.map((s) => s.jobId)).toEqual([job(2), job(3)]);
		expect(summary.unknownSeq.map((s) => s.jobId)).toEqual([job(4)]);
		expect(summary.waiting).toEqual([job(3), job(4)]);
		expect(summary.servers).toBe(4);
		expect(summary.bad).toBe(true);
	});
	test("the servers table and the rollback command (no #: PowerShell comments)", () => {
		const text = formatServersTable(servers.slice(0, 1), NOW);
		expect(text.split("\n")[0].split(/\s{2,}/)).toEqual(["job", "branch", "artifact", "seq", "health", "players", "kernel", "age", "seen"]);
		expect(text).toContain("#42");
		expect(text).toContain("3/20");
		expect(text).toContain("1h00m");
		expect(text).toContain("20s");
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
	test("servers --branch --json", async () => {
		const proj = project();
		const cwd = process.cwd();
		process.chdir(proj.root);
		try {
			setOutputMode({ json: true, verbose: false });
			const store = fakeStore({ TypeTorchServers: [server(1), server(2, { b: "prod" })] });
			const out = JSON.parse(await capture(() => serversCommand(parseArgs(["--branch", "dev"], { branch: "string" }), { oc: store.oc, now: () => NOW * 1000 })));
			expect(out.count).toBe(1);
			expect(out.servers[0]).toMatchObject({ jobId: job(1), uptimeSeconds: 3600, lastSeenSeconds: 20 });
		} finally {
			process.chdir(cwd);
		}
	});
	test("report latest: reads the log, exits 1 on failures, prints the rollback command", async () => {
		const proj = project();
		appendLocalLog(join(proj.root, ".typetorch"), { seq: 42, at: new Date().toISOString(), action: "deploy", branch: "dev", channel: "dev", artifactId: "4363e8c-d2b6d6", assetId: 1234567890, commit: "4363e8c", commitHash: "", dirty: false, by: "me", fromArtifactId: "8803f18-08ba71" });
		const cwd = process.cwd();
		process.chdir(proj.root);
		try {
			const store = fakeStore({ TypeTorchServers: [server(1, { q: 42 }), server(2, { q: 41 })], TypeTorchReports: [report(42, 1, "swapped"), report(42, 2, "failed", { e: "boom" })] });
			const text = await capture(() => reportCommand(parseArgs(["latest", "--no-registry"], { branch: "string", "no-registry": "boolean" }), { oc: store.oc }));
			expect(text).toContain("#42 dev 4363e8c-d2b6d6: 1 swapped, 1 failed");
			expect(text).toContain("error [x1] boom");
			expect(text).toContain("typetorch rollback --branch dev --to 8803f18-08ba71");
			expect(process.exitCode).toBe(1);
		} finally {
			process.chdir(cwd);
		}
	});
});

describe("--wait", () => {
	test("on by default for prod (90 s), off for dev; --wait [s], --no-wait", () => {
		const spec = { ...WAIT_FLAGS };
		expect(waitSeconds(parseArgs([], spec), "prod")).toBe(90);
		expect(waitSeconds(parseArgs([], spec), "dev")).toBeUndefined();
		expect(waitSeconds(parseArgs(["--wait"], spec), "dev")).toBe(90);
		expect(waitSeconds(parseArgs(["--wait", "30"], spec), "dev")).toBe(30);
		expect(waitSeconds(parseArgs(["--wait=45"], spec), "dev")).toBe(45);
		expect(waitSeconds(parseArgs(["--no-wait"], spec), "prod")).toBeUndefined();
		expect(() => waitSeconds(parseArgs(["--wait", "1"], spec), "dev")).toThrow(/5 to 1800/);
		// a positional after --wait isn't swallowed
		expect(parseArgs(["--wait", "latest"], spec)).toEqual({ positionals: ["latest"], flags: { wait: true } });
	});
	test("polls until every server of the branch reported, then summarizes (a failure exits 1)", async () => {
		let clock = 0;
		let polls = 0;
		const base = fakeStore({});
		const oc = {
			async request(method: string, path: string) {
				if (path.includes("TypeTorchReports")) polls++;
				const maps = {
					TypeTorchServers: [server(1, { q: polls >= 2 ? 42 : 41 }), server(2, { q: 41 })],
					TypeTorchReports: polls >= 2 ? [report(42, 1, "swapped"), report(42, 2, "rolled_back", { e: "boom" })] : [],
				};
				return fakeStore(maps).oc.request(method, path);
			},
		};
		void base;
		const result = await waitForFleet({ oc, universeId: 42, branch: "dev", seq: 42, artifactId: "4363e8c-d2b6d6", fromArtifactId: "8803f18-08ba71", seconds: 90, deps: { now: () => clock, sleep: async (ms) => void (clock += ms) } });
		expect(result.summary?.counts).toEqual({ swapped: 1, rolled_back: 1 });
		expect(result.timedOut).toBe(false);
		expect(clock).toBe(5000);
		expect(process.exitCode).toBe(1);
	});
	test("a missing scope is a warning, not a failure", async () => {
		const result = await waitForFleet({ oc: fakeStore({}, { status: 403 }).oc, universeId: 42, branch: "prod", seq: 7, artifactId: "x", seconds: 90, deps: { now: () => 0, sleep: async () => {} } });
		expect(result.unavailable).toContain(FLEET_SCOPE);
		expect(process.exitCode ?? 0).toBe(0);
	});
	test("times out with servers that never reported", async () => {
		let clock = 0;
		const store = fakeStore({ TypeTorchServers: [server(1, { q: 41 })], TypeTorchReports: [] });
		const result = await waitForFleet({ oc: store.oc, universeId: 42, branch: "dev", seq: 42, artifactId: "x", seconds: 20, deps: { now: () => clock, sleep: async (ms) => void (clock += ms) } });
		expect(result.timedOut).toBe(true);
		expect(result.summary?.waiting).toEqual([job(1)]);
	});
});

export type { ReportRow, ServerRow };
