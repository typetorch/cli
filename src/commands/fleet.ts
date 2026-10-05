/**
 * Fleet visibility (fleet.ts): `typetorch servers`, `typetorch report`, and the `--wait` that deploy, promote, rollback
 * and approve run after the deploy message.
 *
 *   typetorch servers [--branch <b>] [--json]
 *   typetorch report <seq|artifact|latest> [--branch <b>] [--json]
 *
 * Both read MemoryStore through Open Cloud with the deploy key (scope memory-store.sorted-map:read). `report` exits 1
 * when a server failed or rolled back, and prints the rollback command; nothing is ever rolled back automatically.
 */
import { flagString, UsageError, type ParsedArgs } from "../args.ts";
import { matchDeployment } from "../deployments.ts";
import {
	FleetScopeError,
	formatCounts,
	formatServersTable,
	readReports,
	readServers,
	rollbackCommand,
	serverJson,
	summarize,
	type FleetSummary,
	type ServerRow,
} from "../fleet.ts";
import { bold, dim, emitJson, formatSeconds, green, info, isJson, red, table, warn, yellow } from "../log.ts";
import { branchNameError, type Channel } from "../naming.ts";
import type { OpenCloud } from "../opencloud.ts";
import { progress } from "../progress.ts";
import { sleep } from "../runtime.ts";
import { openCloud, project, readHistory, registryApi } from "./common.ts";

export const serversFlags = { branch: "string" } as const;
export const reportFlags = { branch: "string", "no-registry": "boolean" } as const;
/** The flags releasing commands take for the wait. */
export const WAIT_FLAGS = { wait: "optional", "no-wait": "boolean" } as const;
export const DEFAULT_WAIT_SECONDS = 90;

type Reader = Pick<OpenCloud, "request">;

export interface FleetDeps {
	/** A client with the deploy key. */
	oc?: Reader;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export async function serversCommand(args: ParsedArgs, deps: FleetDeps = {}) {
	if (args.positionals.length) throw new UsageError(`unexpected argument "${args.positionals[0]}"`);
	const proj = project(args);
	const branch = flagString(args, "branch");
	if (branch && branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const oc = deps.oc ?? openCloud("deploy")!;
	const now = (deps.now ?? Date.now)() / 1000;
	const { servers: all, truncated } = await readServers(oc, proj.config.universeId);
	const servers = all.filter((s) => !branch || s.branch === branch);
	if (isJson()) return emitJson({ universeId: proj.config.universeId, branch: branch ?? null, count: servers.length, truncated, servers: servers.map((s) => serverJson(s, now)) });
	if (servers.length === 0) {
		info(`no live servers${branch ? ` on ${branch}` : ""} (servers write a heartbeat every minute or so, TTL 150 s; kernels before the fleet heartbeat write none)`);
		return;
	}
	info(formatServersTable(servers, now));
	const byBranch = new Map<string, ServerRow[]>();
	for (const s of servers) byBranch.set(s.branch ?? "?", [...(byBranch.get(s.branch ?? "?") ?? []), s]);
	const players = servers.reduce((sum, s) => sum + (s.players ?? 0), 0);
	const parts = [...byBranch].map(([b, list]) => `${b} ${list.length}`);
	const unhealthy = servers.filter((s) => s.health && s.health !== "ok");
	info(dim(`${servers.length} server(s), ${players} player(s): ${parts.join(", ")}${truncated ? " (list cut at 5000)" : ""}`));
	if (unhealthy.length) info(yellow(`${unhealthy.length} not ok: ${unhealthy.map((s) => `${s.jobId.slice(0, 8)} ${s.health}${s.error ? ` (${s.error.slice(0, 120)})` : ""}`).join("; ")}`));
}

/** The human lines of a summary (shared by `report` and `--wait`). */
export function describeSummary(summary: FleetSummary, input: { fromArtifactId?: string; waitedSeconds?: number; timedOut?: boolean } = {}): string[] {
	const lines: string[] = [];
	const what = `#${summary.seq} ${summary.branch}${summary.artifactId ? ` ${summary.artifactId}` : ""}`;
	const totals = `${formatCounts(summary.counts)}${summary.servers ? ` (${summary.servers} live server(s) on ${summary.branch})` : ""}`;
	lines.push(summary.bad ? red(bold(`${what}: ${totals}`)) : `${what}: ${totals}`);
	for (const group of summary.errors) {
		lines.push(red(`  error [x${group.count}] ${group.error.slice(0, 400)}`));
		lines.push(dim(`    on ${group.jobs.join(", ")}${group.count > group.jobs.length ? ", ..." : ""}`));
	}
	if (summary.stillOld.length) {
		lines.push(`  still on an older seq: ${summary.stillOld.length}`);
		lines.push(
			table(
				["job", "seq", "artifact", "health"],
				summary.stillOld.slice(0, 20).map((s) => [s.jobId, `#${s.seq}`, `${s.artifactId ?? "?"}${s.experiment ? " [A/B]" : ""}`, s.health ?? "-"]),
			)
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n"),
		);
	}
	if (summary.unknownSeq.length) lines.push(dim(`  ${summary.unknownSeq.length} server(s) run an older kernel that doesn't report its seq`));
	if (input.timedOut && summary.waiting.length) lines.push(yellow(`  no report yet from ${summary.waiting.length} server(s) after ${formatSeconds(input.waitedSeconds ?? 0)}`));
	if (summary.bad) {
		lines.push(red(bold(`  ${(summary.counts.failed ?? 0) + (summary.counts.rolled_back ?? 0)} server(s) failed or rolled back. Nothing was rolled back for you; to roll the branch back:`)));
		lines.push(red(`    ${rollbackCommand(summary.branch, input.fromArtifactId)}`));
	}
	return lines;
}

export async function reportCommand(args: ParsedArgs, deps: FleetDeps = {}) {
	const [wanted, extra] = args.positionals;
	if (!wanted) throw new UsageError("usage: typetorch report <seq|artifact|latest> [--branch <b>]");
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	const proj = project(args);
	const branchFlag = flagString(args, "branch");
	if (branchFlag && branchNameError(branchFlag)) throw new UsageError(branchNameError(branchFlag)!);
	const oc = deps.oc ?? openCloud("deploy")!;
	const history = await readHistory(proj, registryApi(oc as OpenCloud, proj, args.flags["no-registry"] === true), "--no-registry");
	const rows = history.rows.filter((d) => !branchFlag || d.branch === branchFlag);
	let deployment;
	if (wanted === "latest") deployment = rows.at(-1);
	else if (/^#?\d{1,7}$/.test(wanted)) deployment = rows.filter((d) => d.seq === Number(wanted.replace("#", ""))).at(-1);
	else deployment = matchDeployment(rows, wanted, branchFlag);
	const seq = deployment?.seq ?? (/^#?\d{1,7}$/.test(wanted) ? Number(wanted.replace("#", "")) : undefined);
	if (seq === undefined) throw new Error(`no deployment matches "${wanted}"${branchFlag ? ` on ${branchFlag}` : ""} (${history.stateDir}); try a seq, an artifact id or \`latest\``);
	const branch = branchFlag ?? deployment?.branch;
	const now = (deps.now ?? Date.now)() / 1000;
	const [{ reports, truncated }, { servers }] = await Promise.all([readReports(oc, proj.config.universeId, seq), readServers(oc, proj.config.universeId)]);
	const summaryBranch = branch ?? reports[0]?.branch;
	if (!summaryBranch) throw new Error(`#${seq} isn't in the local log or the registry, and no server reported it; pass --branch`);
	const summary = summarize({ seq, branch: summaryBranch, artifactId: deployment?.artifactId ?? reports[0]?.artifactId, reports, servers });
	if (summary.bad) process.exitCode = 1;
	if (isJson()) {
		return emitJson({
			...summary,
			stillOld: summary.stillOld.map((s) => serverJson(s, now)),
			unknownSeq: summary.unknownSeq.map((s) => serverJson(s, now)),
			deployment: deployment ?? null,
			truncated,
			rollback: summary.bad ? rollbackCommand(summary.branch, deployment?.fromArtifactId) : null,
			reportsList: reports,
		});
	}
	for (const line of describeSummary(summary, { fromArtifactId: deployment?.fromArtifactId })) info(line);
	if (!summary.reports && !summary.servers) info(dim("  no reports and no live servers on the branch (reports are kept 7 days; kernels before the fleet reports write none)"));
	else if (!summary.bad && summary.reports) info(green(`  no failures`));
}

// --wait ----------------------------------------------------------------------------------------------------------------

/** --wait [seconds] / --no-wait: on by default for prod-channel branches (90 s), off for dev-channel ones. */
export function waitSeconds(args: ParsedArgs, branchChannel: Channel): number | undefined {
	if (args.flags["no-wait"] === true) {
		if (args.flags.wait !== undefined) throw new UsageError("--wait and --no-wait together");
		return undefined;
	}
	const value = args.flags.wait;
	if (typeof value === "string") {
		const seconds = Number(value);
		if (!Number.isInteger(seconds) || seconds < 5 || seconds > 1800) throw new UsageError(`--wait takes 5 to 1800 seconds, got "${value}"`);
		return seconds;
	}
	if (value === true) return DEFAULT_WAIT_SECONDS;
	return branchChannel === "prod" ? DEFAULT_WAIT_SECONDS : undefined;
}

export interface WaitResult {
	summary?: FleetSummary;
	waitedSeconds: number;
	timedOut: boolean;
	/** Why there is no summary (the scope, an API error). */
	unavailable?: string;
}

/**
 * After a deploy message: polls the reports for `seq` until every live server of the branch (as listed when the wait
 * started, plus any that appear) reported it or moved past it, or `seconds` pass. Prints the summary; a server that
 * failed or rolled back makes the summary red, prints the rollback command and sets exit code 1. A missing scope or an
 * API error is a warning: the deploy itself already went out.
 */
export async function waitForFleet(input: {
	oc: Reader;
	universeId: number;
	branch: string;
	seq: number;
	artifactId: string;
	fromArtifactId?: string;
	seconds: number;
	deps?: FleetDeps;
}): Promise<WaitResult> {
	const now = input.deps?.now ?? Date.now;
	const pause = input.deps?.sleep ?? sleep;
	const started = now();
	const elapsed = () => (now() - started) / 1000;
	info(dim(`  waiting up to ${input.seconds} s for the servers of ${input.branch} to report #${input.seq} (--no-wait skips this)...`));
	let summary: FleetSummary | undefined;
	let lastLine = "";
	const job = progress().job(`reports of #${input.seq} from the servers of ${input.branch}`);
	try {
		while (true) {
			const [{ reports }, { servers }] = await Promise.all([readReports(input.oc, input.universeId, input.seq), readServers(input.oc, input.universeId)]);
			summary = summarize({ seq: input.seq, branch: input.branch, artifactId: input.artifactId, reports, servers });
			const line = `${formatCounts(summary.counts)}; waiting for ${summary.waiting.length} of ${summary.servers}`;
			if (line !== lastLine) info(dim(`  ${formatSeconds(elapsed()).padStart(8)}  ${line}`));
			lastLine = line;
			job.update(`reports of #${input.seq}: ${summary.waiting.length} of ${summary.servers} server(s) still to report`);
			const done = summary.servers === 0 ? elapsed() >= 10 : summary.waiting.length === 0;
			if (done || elapsed() >= input.seconds) break;
			await pause(5000);
		}
	} catch (error) {
		job.done();
		const message = error instanceof FleetScopeError ? error.message : `reading the fleet failed: ${(error as Error).message}`;
		warn(`${message}. The deploy went out; check later with \`typetorch report ${input.seq}\``);
		return { waitedSeconds: elapsed(), timedOut: false, unavailable: message };
	}
	job.done();
	const timedOut = summary.waiting.length > 0 && summary.servers > 0;
	if (summary.servers === 0 && summary.reports === 0) {
		info(dim(`  no live servers on ${input.branch} reported (none running, or kernels before the fleet heartbeat); new servers boot #${input.seq}`));
	} else {
		for (const line of describeSummary(summary, { fromArtifactId: input.fromArtifactId, waitedSeconds: elapsed(), timedOut })) info(line);
	}
	if (summary.bad) process.exitCode = 1;
	return { summary, waitedSeconds: elapsed(), timedOut };
}

export const WAIT_USAGE = `  --wait [seconds]     after the message, wait for the servers' reports and print a summary (default on for
                       prod-channel branches, 90 s); a failed or rolled-back server prints the rollback command and
                       exits 1 (nothing is rolled back for you). --no-wait skips it. Needs memory-store.sorted-map:read`;

export const SERVERS_USAGE = `typetorch servers [--branch <b>] [--json]

  Live servers from the kernel's heartbeats (MemoryStore SortedMap TypeTorchServers, TTL 150 s): JobId, branch,
  artifact, applied seq, health, players, kernel version, age (uptime) and seen (last heartbeat).
  Scope (the deploy key): memory-store.sorted-map:read.`;

export const REPORT_USAGE = `typetorch report <seq|artifact|latest> [--branch <b>] [--json]

  What the servers reported for one deploy (MemoryStore SortedMap TypeTorchReports, kept 7 days): swapped / failed /
  rolled_back / skipped / booted counts, errors grouped, and the branch's servers still on an older seq. Exits 1 when
  a server failed or rolled back, and prints the rollback command. Scope (the deploy key): memory-store.sorted-map:read.`;
