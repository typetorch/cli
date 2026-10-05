/**
 * `typetorch test --cloud [artifact]`: the pre-publish gate (cloudtest.ts) as a command, and `gateRelease`, which
 * deploy, promote, rollback and approve call before anything is published or proposed.
 *
 *   typetorch test [--cloud] [<artifactId|assetId|#seq|commit>] [--branch <b>] [--seconds <n>] [--no-swap]
 *
 * Without an artifact: the newest upload of the branch (uploads.jsonl), else its live head. A bare asset id that no
 * log knows is tested as it is. Results go to tests.jsonl in the state dir; promote and approve reuse a pass of the
 * same asset from the last 24 h. Uses the assets key (universe.place.luau-execution-session:read + :write, and
 * asset:read on the place for its version list).
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import {
	appendTestRecord,
	DEFAULT_TEST_SECONDS,
	GateError,
	gatePolicy,
	MAX_TEST_SECONDS,
	readTestRecords,
	recentPass,
	runGate,
	summaryFor,
	type GateClient,
	type GateInput,
	type GateRun,
	type TestSummary,
} from "../cloudtest.ts";
import type { Project } from "../config.ts";
import { matchDeployment } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { bold, dim, emitJson, formatSeconds, green, info, isJson, isVerbose, red, yellow } from "../log.ts";
import { branchChannel, branchFromGit, branchNameError, strictest, type Channel } from "../naming.ts";
import { openCloud, project, projectStateDir, withLocal } from "./common.ts";

export const testFlags = {
	cloud: "boolean",
	unit: "boolean",
	branch: "string",
	seconds: "string",
	"no-swap": "boolean",
} as const;

/** The flags releasing commands take for the gate. */
export const GATE_FLAGS = { test: "boolean", "skip-test": "string" } as const;

export class GateFailedError extends Error {
	override name = "GateFailedError";
}

export interface TestTarget {
	assetId: number;
	artifactId?: string;
	/** The artifact's own channel, when known. */
	artifactChannel?: Channel;
	branch: string;
	from: string;
	seq?: number;
}

/** What `typetorch test` tests: the given artifact, else the branch's newest upload, else its live head. */
export function resolveTestTarget(proj: Project, wanted: string | undefined, branchFlag: string | undefined): TestTarget {
	const history = withLocal(proj, undefined, "not read");
	const git = gitInfo(proj.root);
	const branch = branchFlag ?? (git.gitBranch ? branchFromGit(git.gitBranch, proj.config.branches) : proj.config.defaultBranch);
	if (wanted !== undefined) {
		const deployed = matchDeployment(history.rows, wanted, branch);
		if (deployed) return { assetId: deployed.assetId, artifactId: deployed.artifactId, artifactChannel: deployed.channel, branch: branchFlag ?? deployed.branch, from: `#${deployed.seq} on ${deployed.branch}`, seq: deployed.seq };
		const upload = matchDeployment(history.uploads.map((u) => ({ ...u, seq: -1 })), wanted, branch);
		if (upload) return { assetId: upload.assetId, artifactId: upload.artifactId, artifactChannel: upload.channel, branch: branchFlag ?? upload.branch, from: "an upload" };
		if (/^\d{6,}$/.test(wanted.trim())) return { assetId: Number(wanted.trim()), branch, from: "asset id (not in the logs)" };
		throw new UsageError(`nothing matches "${wanted}" in the deployments or uploads (${history.stateDir}); pass a #seq, asset id, artifact id or commit`);
	}
	const upload = [...history.uploads].reverse().find((u) => u.branch === branch && u.moderation === "Approved");
	const head = history.heads.get(branch);
	if (upload && (!head || Date.parse(upload.at) >= Date.parse(head.deployedAt))) {
		return { assetId: upload.assetId, artifactId: upload.artifactId, artifactChannel: upload.channel, branch, from: `the newest upload of ${branch}` };
	}
	if (head) return { assetId: head.assetId, artifactId: head.artifactId, artifactChannel: head.channel, branch, from: `the live head of ${branch} (#${head.seq})`, seq: head.seq };
	throw new UsageError(`${branch} has no uploads or deployments in ${history.stateDir}; pass an artifact or asset id (or --branch)`);
}

/** The human lines for a gate run (indent: "" for `typetorch test`, two spaces inside a deploy). */
export function describeGate(run: GateRun, indent = ""): string[] {
	const lines: string[] = [];
	const raw = run.raw;
	const at = (label: string, text: string) => lines.push(`${indent}  ${label.padEnd(9)} ${text}`);
	if (raw) {
		const first = raw.generations[0];
		const second = raw.generations[1];
		if (first?.load !== undefined) at("load", `${formatSeconds(first.load)}  LoadAsset`);
		if (first?.boot !== undefined) at("boot", `${formatSeconds(first.boot)}  Server.boot (onInit)${first.bootError ? red("  FAILED") : ""}`);
		if (raw.shared) at("shared", `${raw.shared.modules} module(s) required${raw.shared.failures.length ? red(`, ${raw.shared.failures.length} failed`) : ""}`);
		if (first?.run !== undefined) at("run", `${formatSeconds(first.run)}  onStart and loops running`);
		if (first?.stop !== undefined) at("stop", `${formatSeconds(first.stop)}  ${first.stopError ? red("NOT clean") : "clean"}${first.leakCount ? yellow(`, ${first.leakCount} leftover instance(s)`) : ""}`);
		if (second) {
			at("swap", `a second generation: boot ${formatSeconds(second.boot ?? 0)}, run 1 s, stop ${formatSeconds(second.stop ?? 0)}${second.bootError || second.stopError ? red("  FAILED") : ""}`);
		}
	}
	for (const problem of run.verdict.problems) {
		lines.push(red(`${indent}  FAIL ${problem.phase.padEnd(10)}${problem.count > 1 ? ` [x${problem.count}]` : ""} ${problem.message}`));
		const trace = problem.trace?.split("\n").filter((line) => line.trim()).slice(0, 3);
		for (const line of trace ?? []) lines.push(dim(`${indent}       ${line.trim()}`));
	}
	for (const warning of run.verdict.warnings.slice(0, isVerbose() ? 50 : 8)) {
		lines.push(yellow(`${indent}  warn ${warning.phase.padEnd(10)}${warning.count > 1 ? ` [x${warning.count}]` : ""} ${warning.message.slice(0, 400)}`));
	}
	if (run.verdict.warnings.length > 8 && !isVerbose()) lines.push(dim(`${indent}  (${run.verdict.warnings.length - 8} more warnings; --verbose shows them)`));
	if (raw && (!run.ok || isVerbose()) && raw.output.length) {
		lines.push(dim(`${indent}  last output:`));
		for (const line of raw.output.slice(-(isVerbose() ? 40 : 12))) lines.push(dim(`${indent}    ${line}`));
	}
	return lines;
}

function headline(run: GateRun, target: Pick<TestTarget, "assetId" | "artifactId">): string {
	const where = `place v${run.placeVersion ?? "?"} (${run.base})${run.raw?.kernel?.version ? `, kernel ${run.raw.kernel.version}` : ""}`;
	return `cloud test ${target.artifactId ?? run.raw?.payload?.artifactId ?? "?"} (asset ${target.assetId}) on ${where}`;
}

function verdictLine(run: GateRun): string {
	return run.ok
		? green(`passed in ${formatSeconds(run.seconds)}${run.verdict.warnings.length ? ` (${run.verdict.warnings.length} warning(s))` : ""}`)
		: red(`FAILED in ${formatSeconds(run.seconds)}: ${run.verdict.problems.length} problem(s)`);
}

export interface TestDeps {
	/** The assets client (Luau Execution, the place's versions). */
	assets?: GateClient;
	/** Replaces runGate (tests). */
	runner?: (input: GateInput) => Promise<GateRun>;
}

export function gateInput(proj: Project, input: { assetId: number; artifactId?: string; branch: string; channel?: Channel; seq?: number; seconds?: number; swap?: boolean }): GateInput {
	const channel = input.channel ?? strictest(branchChannel(proj.config, input.branch));
	return {
		assetId: input.assetId,
		...(input.artifactId ? { artifactId: input.artifactId } : {}),
		branch: input.branch,
		channel,
		...(channel === "prod" ? { requireChannel: "prod" as const } : {}),
		...(input.seq !== undefined ? { seq: input.seq } : {}),
		seconds: input.seconds ?? DEFAULT_TEST_SECONDS,
		swap: input.swap ?? true,
	};
}

function runner(proj: Project, deps: TestDeps): (input: GateInput) => Promise<GateRun> {
	if (deps.runner) return deps.runner;
	const oc = deps.assets ?? openCloud("assets")!;
	return (input) => runGate(oc, proj.config, input, { onWait: (text) => info(dim(`  ${text}`)) });
}

export async function testCommand(args: ParsedArgs, deps: TestDeps = {}) {
	if (flagBool(args, "unit")) throw new UsageError("typetorch test --unit (Jest-Lua specs under Lune) isn't built yet; typetorch test --cloud is");
	if (args.positionals.length > 1) throw new UsageError(`unexpected argument "${args.positionals[1]}"`);
	const proj = project(args);
	const branchFlag = flagString(args, "branch");
	if (branchFlag && branchNameError(branchFlag)) throw new UsageError(branchNameError(branchFlag)!);
	const seconds = flagInt(args, "seconds", DEFAULT_TEST_SECONDS);
	if (seconds < 1 || seconds > MAX_TEST_SECONDS) throw new UsageError(`--seconds must be from 1 to ${MAX_TEST_SECONDS}`);
	const target = resolveTestTarget(proj, args.positionals[0], branchFlag);
	const input = gateInput(proj, { ...target, seconds, swap: !flagBool(args, "no-swap") });
	if (!isJson()) info(dim(`testing ${target.artifactId ?? `asset ${target.assetId}`} (${target.from}) as ${input.branch} (${input.channel}-channel) for ${seconds} s...`));
	const run = await runner(proj, deps)(input);
	appendTestRecord(projectStateDir(proj), {
		universeId: proj.config.universeId,
		assetId: target.assetId,
		...(target.artifactId ? { artifactId: target.artifactId } : {}),
		branch: input.branch,
		channel: input.channel,
		ok: run.ok,
		seconds: run.seconds,
		...(run.placeVersion !== undefined ? { placeVersion: run.placeVersion } : {}),
		problems: run.verdict.problems.length,
		warnings: run.verdict.warnings.length,
		...(run.taskPath ? { task: run.taskPath } : {}),
		via: "test",
	});
	if (!run.ok) process.exitCode = 1;
	if (isJson()) {
		return emitJson({ ok: run.ok, target, input, placeVersion: run.placeVersion, base: run.base, seconds: run.seconds, problems: run.verdict.problems, warnings: run.verdict.warnings, result: run.raw ?? null, task: run.taskPath });
	}
	info(bold(headline(run, target)));
	for (const line of describeGate(run)) info(line);
	info(verdictLine(run));
}

// The gate inside releases ---------------------------------------------------------------------------------------------

export interface ReleaseGateInput {
	proj: Project;
	kind: "deploy" | "promote" | "rollback" | "resign";
	branch: string;
	branchChannel: Channel;
	artifact: { artifactId: string; assetId: number };
	/** `--test`: run it even where it is optional, and don't reuse an earlier pass. */
	test: boolean;
	/** `--skip-test "<reason>"` (already checked with skipReason). */
	skipTest?: string;
	via: string;
	by?: string;
	deps?: TestDeps;
	/** For the hint after a failure. */
	retryHint?: string;
}

/**
 * Runs the gate when the policy says so (gatePolicy): returns what to record, or undefined when it didn't apply.
 * Throws GateFailedError when it fails (nothing may be published or proposed then), GateError for setup problems.
 */
export async function gateRelease(input: ReleaseGateInput): Promise<TestSummary | undefined> {
	const { proj } = input;
	const policy = gatePolicy({ kind: input.kind, branchChannel: input.branchChannel, test: input.test, skipTest: input.skipTest });
	if (input.skipTest !== undefined) {
		info(yellow(`  test        SKIPPED (--skip-test): ${input.skipTest}`));
		return { skipped: input.skipTest, at: new Date().toISOString(), ...(input.by ? { by: input.by } : {}) };
	}
	if (!policy.run) return undefined;
	const dir = projectStateDir(proj);
	if (!input.test) {
		const pass = recentPass(readTestRecords(dir, proj.config.universeId), input.artifact.assetId);
		if (pass) {
			info(`  test        passed already (${pass.at.replace("T", " ").slice(0, 19)} UTC, via ${pass.via}); --test runs it again`);
			return { ok: true, at: pass.at, seconds: pass.seconds, ...(pass.placeVersion !== undefined ? { placeVersion: pass.placeVersion } : {}), reused: true };
		}
	}
	info(`  test        cloud test (${policy.why})...`);
	const gate = gateInput(proj, { assetId: input.artifact.assetId, artifactId: input.artifact.artifactId, branch: input.branch, channel: input.branchChannel });
	let run: GateRun;
	try {
		run = await runner(proj, input.deps ?? {})(gate);
	} catch (error) {
		if (error instanceof GateError) throw new GateError(`${error.message}. Nothing was published; to publish without the test: --skip-test "<reason>"`);
		throw error;
	}
	appendTestRecord(dir, {
		universeId: proj.config.universeId,
		assetId: input.artifact.assetId,
		artifactId: input.artifact.artifactId,
		branch: input.branch,
		channel: gate.channel,
		ok: run.ok,
		seconds: run.seconds,
		...(run.placeVersion !== undefined ? { placeVersion: run.placeVersion } : {}),
		problems: run.verdict.problems.length,
		warnings: run.verdict.warnings.length,
		...(run.taskPath ? { task: run.taskPath } : {}),
		via: input.via,
	});
	info(`  test        ${verdictLine(run)}  (place v${run.placeVersion ?? "?"}${run.raw?.kernel?.version ? `, kernel ${run.raw.kernel.version}` : ""})`);
	for (const line of describeGate(run, "          ")) info(line);
	if (!run.ok) {
		const problems = run.verdict.problems.map((p) => `  ${p.phase}: ${p.message.split("\n")[0].slice(0, 300)}`).join("\n");
		throw new GateFailedError(
			`the cloud test of ${input.artifact.artifactId} failed (${run.verdict.problems.length} problem(s)), so nothing was published:\n${problems}\n${input.retryHint ?? "Fix it and try again"}; to publish anyway: --skip-test "<reason>"`,
		);
	}
	return summaryFor(run);
}

/** One line for a proposal or a dry run. */
export function describeTest(test: TestSummary | undefined, policy?: { run: boolean; why: string }): string {
	if (!test) return policy ? (policy.run ? `will run before publishing (${policy.why})` : `not run (${policy.why})`) : "not run";
	if ("skipped" in test) return yellow(`SKIPPED: ${test.skipped}${test.by ? ` (by ${test.by})` : ""}`);
	if (test.ok) return green(`passed${test.reused ? " (earlier run)" : ""} in ${formatSeconds(test.seconds)}${test.placeVersion !== undefined ? ` on place v${test.placeVersion}` : ""}`);
	return red(`FAILED (${test.problems} problem(s))`);
}

export const TEST_USAGE = `typetorch test [--cloud] [<artifactId|assetId|#seq|commit>] [--branch <b>] [--seconds <n>] [--no-swap] [--json]

  The pre-publish gate, on its own. One Luau Execution task on the place's latest published version:
  LoadAsset the payload, the kernel's mount checks (Folders and ModuleScripts only, KernelApi, prod Channel on prod
  branches), boot its Server side with a stub kernel (onInit, onStart), require every Shared module, run --seconds
  (default 5), stop it (within the kernel's stop deadline) and check the stop was clean, then boot a second generation
  as a hot swap would (--no-swap skips it). Any error fails it (exit 1); leftovers after the stop are warnings.
  Without an artifact: the newest upload of the branch, else its live head. Results go to tests.jsonl.
  Game code runs with real DataStores and MemoryStores (Roblox allows them in tasks) but no players; workspace:GetAttribute("TypeTorchTest") is
  true there. Scopes (the assets key): universe.place.luau-execution-session:read and :write, asset:read on the place.
  --unit is not built yet.`;

export const GATE_USAGE = `  --test               run the cloud test (typetorch test --cloud) before publishing or proposing; it always runs for
                       deploys and promotes to prod-channel branches (a pass of the same asset in the last 24 h counts)
  --skip-test <reason> publish without it; the reason goes into the deploy log and the proposal`;
