import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import {
	appendTestRecord,
	gatePolicy,
	gateScript,
	judgeGate,
	parseGate,
	readTestRecords,
	recentPass,
	runGate,
	skipReason,
	type GateInput,
	type GateRun,
} from "../src/cloudtest";
import { approveProposal, propose, type ReleaseRequest } from "../src/commands/approve";
import { GateFailedError, gateRelease, resolveTestTarget, testCommand } from "../src/commands/test";
import { validateConfig, type Project } from "../src/config";
import { appendUpload, readLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { scriptedInteraction } from "../src/interact";
import { setOutputMode } from "../src/log";
import { ApiError, type OpenCloud } from "../src/opencloud";
import { readProposals } from "../src/proposals";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
	process.exitCode = 0;
});

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-gate-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "none", ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t") + "\n");
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings };
}

const input: GateInput = { assetId: 123456789, artifactId: "12b63b9-3fa91c", branch: "dev", channel: "dev", seconds: 5, swap: true };

/** A raw task result like the live one (template payload, 2026-10-05). */
function rawResult(patch: Record<string, unknown> = {}) {
	return {
		v: 1,
		events: [],
		warnings: [],
		output: ["TypeTorch server started 3 modules in 70 ms"],
		errorCount: 0,
		warningCount: 0,
		generations: [
			{ n: 1, load: 0.46, boot: 0.07, run: 5, stop: 0.001, leaks: ["Workspace.TargetRushArena (Model)"], leakCount: 1 },
			{ n: 2, load: 0.01, boot: 0.08, run: 1, stop: 0.001, leaks: [], leakCount: 0 },
		],
		shared: { modules: 8, failures: [], seconds: 0.01 },
		kernel: { present: true, version: "0.3.1", api: 1 },
		payload: { artifactId: "12b63b9-3fa91c", channel: "dev", kernelApi: 1 },
		placeVersion: 15,
		limits: { stop: 5, ready: 20 },
		seconds: 6.9,
		phase: "swap-after-stop",
		...patch,
	};
}

function fakeRun(ok: boolean, patch: Partial<GateRun> = {}): GateRun {
	return {
		ok,
		verdict: ok ? { ok, problems: [], warnings: [] } : { ok, problems: [{ phase: "run", message: "Server.services.coins:12: attempt to index nil", count: 2 }], warnings: [] },
		input,
		placeVersion: 15,
		base: "latest published",
		seconds: 9.5,
		...patch,
	};
}

describe("the task script", () => {
	test("embeds the input as JSON in a long bracket string, and nothing else changes", () => {
		const script = gateScript(input);
		expect(script).toContain(`HttpService:JSONDecode([==[${JSON.stringify({ assetId: 123456789, artifactId: "12b63b9-3fa91c", branch: "dev", channel: "dev", requireChannel: null, seq: null, seconds: 5, swap: true, stubChannel: "dev" })}]==])`);
		expect(script).not.toContain("__CONFIG__");
		expect(script).not.toContain("`"); // no Luau interpolated strings inside a TS template literal
		for (const needle of ["ScriptContext.Error", "InsertService.LoadAsset", "boot.boot(kernel)", "STOP_DEADLINE", "TypeTorchTest", "tree.Shared:GetDescendants()"]) expect(script).toContain(needle);
	});
	test("prod: the payload Channel must be prod, but the stub kernel still runs as dev (real stores)", () => {
		const script = gateScript({ ...input, branch: "prod", channel: "prod", requireChannel: "prod" });
		expect(script).toContain('"requireChannel":"prod"');
		expect(script).toContain('"stubChannel":"dev"');
		// The game sees TypeTorch.channel = CONFIG.stubChannel, never the branch's channel.
		expect(script).toContain("channel = CONFIG.stubChannel,");
		expect(script).not.toContain("channel = CONFIG.channel,");
		expect(script).toContain('serverType = if CONFIG.stubChannel == "prod" then "public" else "reserved"');
	});
});

describe("judging a run", () => {
	test("a clean run passes; leftovers after the stop are warnings", () => {
		const verdict = judgeGate(parseGate([rawResult()]));
		expect(verdict.ok).toBe(true);
		expect(verdict.problems).toEqual([]);
		expect(verdict.warnings[0]).toMatchObject({ phase: "after-stop", message: expect.stringContaining("Workspace.TargetRushArena") });
	});
	test("errors while booting or running fail, grouped across generations", () => {
		const message = (n: number) => `ServerStorage.TypeTorch.Generations.12b63b9-3fa91c#${n}.Server.services.coins:12: attempt to index nil`;
		const raw = parseGate([
			rawResult({
				events: [
					{ p: "run", m: message(1), tr: "Server.services.coins, line 12\n" },
					{ p: "run", m: message(1) },
					{ p: "swap-run", m: message(2) },
					{ p: "after-stop", m: "leaked loop" },
				],
				errorCount: 4,
			}),
		]);
		const verdict = judgeGate(raw);
		expect(verdict.ok).toBe(false);
		expect(verdict.problems).toEqual([
			{ phase: "run", message: message(1), trace: "Server.services.coins, line 12\n", count: 2 },
			{ phase: "swap-run", message: message(2), count: 1 },
		]);
		expect(verdict.warnings.some((w) => w.message.includes("leaked loop") && w.message.includes("hard stop kills it"))).toBe(true);
	});
	test("boot, mount, Shared and stop problems fail; 'onStop threw' warnings during the stop fail too", () => {
		expect(judgeGate(parseGate([rawResult({ checks: ["the payload is dev-channel; prod servers only take prod"] })])).problems[0]).toMatchObject({ phase: "mount" });
		expect(judgeGate(parseGate([rawResult({ fatal: "LoadAsset(1) failed: no access", phase: "load", generations: [] })])).problems[0]).toMatchObject({ phase: "load", message: "LoadAsset(1) failed: no access" });
		const g = rawResult().generations;
		expect(judgeGate(parseGate([rawResult({ generations: [{ ...g[0], bootError: "TypeTorch server failed to start: x" }] })])).problems[0].phase).toBe("boot");
		expect(judgeGate(parseGate([rawResult({ generations: [g[0], { ...g[1], stopError: "the stop function took more than 5 s" }] })])).problems[0].phase).toBe("swap-stop");
		expect(judgeGate(parseGate([rawResult({ shared: { modules: 2, failures: [{ m: "Shared.ui", e: "LocalPlayer is nil" }], seconds: 0 } })])).problems[0].message).toBe("require Shared.ui: LocalPlayer is nil");
		const stopWarn = judgeGate(parseGate([rawResult({ warnings: [{ p: "stop", m: "CoinService.onStop threw: x" }, { p: "run", m: "Infinite yield possible" }] })]));
		expect(stopWarn.ok).toBe(false);
		expect(stopWarn.warnings).toContainEqual({ phase: "run", message: "Infinite yield possible", count: 1 });
		expect(stopWarn.problems).toContainEqual({ phase: "stop", message: "CoinService.onStop threw: x", count: 1 });
	});
	test("more errors than the task listed still count", () => {
		const verdict = judgeGate(parseGate([rawResult({ events: [{ p: "run", m: "x" }], errorCount: 150 })]));
		expect(verdict.problems.at(-1)?.message).toBe("149 more error(s) not listed");
	});
	test("a result that isn't a table is a GateError", () => {
		expect(() => parseGate(["nope"])).toThrow(/not a result table/);
	});
});

describe("runGate", () => {
	const place = { universeId: 42, placeId: 7 };
	const versions = async () => [{ version: 16, published: false, hasPublishedField: true }, { version: 15, published: true, hasPublishedField: true }];
	test("runs on the latest published version and judges the result", async () => {
		const calls: unknown[] = [];
		const run = await runGate(
			{ placeVersions: versions, runLuau: async (...args: unknown[]) => (calls.push(args), { state: "COMPLETE", results: [rawResult()], path: "universes/42/places/7/versions/15/luau-execution-sessions/s/tasks/t" }) } as any,
			place,
			input,
		);
		expect(run.ok).toBe(true);
		expect(run.placeVersion).toBe(15);
		expect((calls[0] as unknown[])[4]).toEqual({ version: 15 });
		expect((calls[0] as unknown[])[3]).toBe(95); // 90 + seconds
	});
	test("a FAILED task fails the gate; a refused task names the scopes", async () => {
		const failed = await runGate({ placeVersions: versions, runLuau: async () => ({ state: "FAILED", results: [], error: { code: "SCRIPT_ERROR", message: "boom" } }) } as any, place, input);
		expect(failed.ok).toBe(false);
		expect(failed.verdict.problems[0]).toMatchObject({ phase: "task", message: expect.stringContaining("FAILED") });
		const refused = { placeVersions: versions, runLuau: async () => { throw new ApiError("POST", "/x", 403, {}, "Scope not authorized"); } };
		await expect(runGate(refused as any, place, input)).rejects.toThrow(/universe\.place\.luau-execution-session:read and :write/);
	});
});

describe("when the gate runs", () => {
	test("prod deploys and promotes always; rollbacks, dev and resigns only with --test; --skip-test wins", () => {
		expect(gatePolicy({ kind: "deploy", branchChannel: "prod", test: false }).run).toBe(true);
		expect(gatePolicy({ kind: "promote", branchChannel: "prod", test: false }).run).toBe(true);
		expect(gatePolicy({ kind: "rollback", branchChannel: "prod", test: false }).run).toBe(false);
		expect(gatePolicy({ kind: "rollback", branchChannel: "prod", test: true }).run).toBe(true);
		expect(gatePolicy({ kind: "deploy", branchChannel: "dev", test: false }).run).toBe(false);
		expect(gatePolicy({ kind: "deploy", branchChannel: "dev", test: true }).run).toBe(true);
		expect(gatePolicy({ kind: "resign", branchChannel: "prod", test: true }).run).toBe(false);
		expect(gatePolicy({ kind: "deploy", branchChannel: "prod", test: false, skipTest: "hotfix" })).toEqual({ run: false, why: "skipped: hotfix" });
	});
	test("--skip-test needs a reason", () => {
		expect(skipReason(undefined)).toBeUndefined();
		expect(skipReason("  hotfix,   tested in Studio ")).toBe("hotfix, tested in Studio");
		expect(() => skipReason(" ")).toThrow(/needs a reason/);
	});
	test("a pass of the same asset in the last 24 h is reused", () => {
		const proj = project();
		const dir = join(proj.root, ".typetorch");
		appendTestRecord(dir, { universeId: 42, assetId: 5, branch: "prod", channel: "prod", ok: false, seconds: 3, problems: 1, warnings: 0, via: "test" });
		expect(recentPass(readTestRecords(dir, 42), 5)).toBeUndefined();
		appendTestRecord(dir, { universeId: 42, assetId: 5, branch: "prod", channel: "prod", ok: true, seconds: 9, problems: 0, warnings: 0, via: "test" });
		const pass = recentPass(readTestRecords(dir, 42), 5)!;
		expect(pass.ok).toBe(true);
		expect(recentPass(readTestRecords(dir, 42), 5, Date.parse(pass.at) + 25 * 3600_000)).toBeUndefined();
		expect(recentPass(readTestRecords(dir, 99), 5)).toBeUndefined();
	});
});

describe("gateRelease", () => {
	const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777 };
	test("prod deploy: runs, records, returns the pass", async () => {
		const proj = project();
		const seen: GateInput[] = [];
		const result = await gateRelease({ proj, kind: "deploy", branch: "prod", branchChannel: "prod", artifact, test: false, via: "deploy", deps: { runner: async (i) => (seen.push(i), fakeRun(true)) } });
		expect(result).toMatchObject({ ok: true, seconds: 9.5, placeVersion: 15 });
		expect(seen[0]).toMatchObject({ assetId: 777, branch: "prod", channel: "prod", requireChannel: "prod", swap: true, seconds: 5 });
		expect(readTestRecords(join(proj.root, ".typetorch"))[0]).toMatchObject({ assetId: 777, ok: true, via: "deploy" });
		// a promote of the same asset reuses it, --test runs it again
		let runs = 0;
		const reused = await gateRelease({ proj, kind: "promote", branch: "prod", branchChannel: "prod", artifact, test: false, via: "promote", deps: { runner: async () => (runs++, fakeRun(true)) } });
		expect(reused).toMatchObject({ ok: true, reused: true });
		await gateRelease({ proj, kind: "promote", branch: "prod", branchChannel: "prod", artifact, test: true, via: "promote", deps: { runner: async () => (runs++, fakeRun(true)) } });
		expect(runs).toBe(1);
	});
	test("a failure throws (nothing may be published) with the problems and --skip-test hint", async () => {
		const proj = project();
		const err = await gateRelease({ proj, kind: "deploy", branch: "prod", branchChannel: "prod", artifact, test: false, via: "deploy", deps: { runner: async () => fakeRun(false) } }).catch((e) => e);
		expect(err).toBeInstanceOf(GateFailedError);
		expect(err.message).toContain("run: Server.services.coins:12: attempt to index nil");
		expect(err.message).toContain('--skip-test "<reason>"');
	});
	test("dev without --test: not run; --skip-test: recorded without running", async () => {
		const proj = project();
		const never = async (): Promise<GateRun> => {
			throw new Error("must not run");
		};
		expect(await gateRelease({ proj, kind: "deploy", branch: "dev", branchChannel: "dev", artifact, test: false, via: "deploy", deps: { runner: never } })).toBeUndefined();
		expect(await gateRelease({ proj, kind: "deploy", branch: "prod", branchChannel: "prod", artifact, test: false, skipTest: "hotfix", via: "deploy", by: "me", deps: { runner: never } })).toMatchObject({ skipped: "hotfix", by: "me" });
	});
});

describe("approve and the gate", () => {
	const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777, channel: "prod" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false };
	const request = (patch: Partial<ReleaseRequest> = {}): ReleaseRequest => ({ kind: "promote", branch: "dev", branchChannel: "dev", artifact, force: false, by: "me", ...patch });
	const fakeOc = () => {
		const published: string[] = [];
		return { published, oc: { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud };
	};
	test("a proposal without a test runs it before the y/N when required; a failure keeps it pending", async () => {
		const proj = project({ approval: "all" });
		const p = propose(proj, request({ branch: "staging" }), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		const io = scriptedInteraction({ answers: ["y"] });
		await expect(approveProposal(proj, { proposal: p, status: "pending" }, { io, oc, test: true, gate: { runner: async () => fakeRun(false) } })).rejects.toThrow(GateFailedError);
		expect(io.asked).toEqual([]); // no y/N after a failed test
		expect(published).toEqual([]);
		expect(readProposals(join(proj.root, ".typetorch"))[0]).toMatchObject({ status: "pending", lastError: expect.stringContaining("cloud test") });
		await approveProposal(proj, { proposal: p, status: "pending" }, { io, oc, test: true, gate: { runner: async () => fakeRun(true) } });
		expect(published).toHaveLength(1);
		expect(readLocalLog(join(proj.root, ".typetorch"))[0].test).toMatchObject({ ok: true });
	});
	test("a proposal that passed (or was skipped with a reason) isn't tested again", async () => {
		const proj = project({ approval: "all" });
		const passed = propose(proj, request({ test: { ok: true, at: new Date().toISOString(), seconds: 9 } }), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		const never = { runner: async (): Promise<GateRun> => { throw new Error("must not run"); } };
		await approveProposal(proj, { proposal: passed, status: "pending" }, { io: scriptedInteraction({ answers: ["y"] }), oc, gate: never });
		expect(published).toHaveLength(1);
	});
});

describe("typetorch test", () => {
	test("tests the newest upload of the branch; a failure exits 1", async () => {
		const proj = project({ branches: { main: "dev" } });
		const dir = join(proj.root, ".typetorch");
		appendUpload(dir, { artifactId: "aaaaaaa-111111", assetId: 11111111, moderation: "Approved", branch: "dev", channel: "dev", commit: "aaaaaaa", commitHash: "", dirty: false, sha256: "x" });
		appendUpload(dir, { artifactId: "bbbbbbb-222222", assetId: 22222222, moderation: "Approved", branch: "dev", channel: "dev", commit: "bbbbbbb", commitHash: "", dirty: false, sha256: "y" });
		expect(resolveTestTarget(proj, undefined, "dev")).toMatchObject({ assetId: 22222222, branch: "dev" });
		expect(resolveTestTarget(proj, "aaaaaaa", "dev")).toMatchObject({ assetId: 11111111 });
		expect(resolveTestTarget(proj, "99999999", "dev")).toMatchObject({ assetId: 99999999, from: "asset id (not in the logs)" });
		const cwd = process.cwd();
		process.chdir(proj.root);
		try {
			setOutputMode({ json: true, verbose: false });
			const seen: GateInput[] = [];
			const out: string[] = [];
			const log = console.log;
			console.log = (line: string) => void out.push(line);
			try {
				await testCommand(parseArgs(["--cloud", "--branch", "prod", "22222222", "--seconds", "2", "--no-swap"], { cloud: "boolean", branch: "string", seconds: "string", "no-swap": "boolean", unit: "boolean" }), { runner: async (i) => (seen.push(i), fakeRun(false)) });
			} finally {
				console.log = log;
			}
			expect(seen[0]).toMatchObject({ assetId: 22222222, branch: "prod", channel: "prod", requireChannel: "prod", seconds: 2, swap: false });
			expect(process.exitCode).toBe(1);
			expect(JSON.parse(out[0])).toMatchObject({ ok: false, problems: [{ phase: "run" }] });
		} finally {
			process.chdir(cwd);
		}
	});
});

describe("CI hand-off", () => {
	test("approve --import: pending proposals of a CI state dir, with their upload and test lines, once", async () => {
		const { importProposals } = await import("../src/proposals");
		const ci = project();
		const ciDir = join(ci.root, ".typetorch");
		const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777, channel: "prod" as const, commit: "12b63b9", commitHash: "", dirty: false };
		const pending = propose(ci, { kind: "deploy", branch: "prod", branchChannel: "prod", artifact, force: false, by: "ci", test: { ok: true, at: new Date().toISOString(), seconds: 10 } }, { name: "ci", explicit: true });
		const done = propose(ci, { kind: "deploy", branch: "dev", branchChannel: "dev", artifact: { ...artifact, assetId: 888 }, force: false, by: "ci" }, { name: "ci", explicit: true });
		const { appendProposalEvent } = await import("../src/proposals");
		appendProposalEvent(ciDir, { event: "rejected", id: done.id });
		appendUpload(ciDir, { artifactId: artifact.artifactId, assetId: 777, moderation: "Approved", branch: "prod", channel: "prod", commit: "12b63b9", commitHash: "", dirty: false, sha256: "x", universeId: 42 });
		appendUpload(ciDir, { artifactId: "other", assetId: 999, moderation: "Approved", branch: "dev", channel: "dev", commit: "x", commitHash: "", dirty: false, sha256: "y", universeId: 42 });
		appendTestRecord(ciDir, { universeId: 42, assetId: 777, branch: "prod", channel: "prod", ok: true, seconds: 10, problems: 0, warnings: 0, via: "deploy" });

		const pc = project();
		const pcDir = join(pc.root, ".typetorch");
		expect(importProposals(pcDir, ciDir, { universeId: 42 })).toEqual([pending.id]);
		expect(importProposals(pcDir, ciDir, { universeId: 42 })).toEqual([]); // once
		expect(readProposals(pcDir).map((s) => s.proposal.id)).toEqual([pending.id]);
		const { readUploads } = await import("../src/deployments");
		expect(readUploads(pcDir).map((u) => u.assetId)).toEqual([777]);
		expect(recentPass(readTestRecords(pcDir, 42), 777)).toBeDefined();
		expect(() => importProposals(pcDir, join(pc.root, "nowhere"), { universeId: 42 })).toThrow(/no proposals.jsonl/);
	});
});
