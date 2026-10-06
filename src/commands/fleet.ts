/**
 * Fleet visibility through the fleet API (fleet.ts): `typetorch servers`, `report`, `alerts`, `fleet setup`, and the
 * `--wait` that deploy, promote, rollback and approve run after the deploy message.
 *
 *   typetorch servers [--branch <b>] [--watch] [--json]
 *   typetorch report <seq|artifact|latest> [--branch <b>] [--json]
 *   typetorch alerts [--follow] [--level info|warning|critical] [--since <minutes>] [--json]
 *   typetorch fleet setup --url <url> [--dry-run]
 *
 * Configured by typetorch.json `fleet.url`, the admin token in TYPETORCH_FLEET_TOKEN (reads) and the write-only ingest
 * token in TYPETORCH_FLEET_INGEST_TOKEN (alerts the CLI posts; `fleet setup` gives it to game servers). Without them
 * the commands say so in one line and `--wait` is skipped with a note.
 *
 * `--wait` (default 90 s on prod-channel branches): polls the reports of the seq; at ~30 s re-sends the same deploy
 * message once when servers are still below it and haven't reported (idempotent: kernels ignore a seq they applied);
 * when 20% (`--rollback-at`) or more of the servers that tried the seq failed or rolled back (at least one), it rolls
 * the branch back to the previous artifact automatically (autorollback.ts; `--no-auto-rollback` turns it off). Stalled
 * servers alone never roll anything back: they are listed and raised as a `server_stuck` warning.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { fleetUrlError, updateProjectConfig, type Project, type ProjectConfig } from "../config.ts";
import { DEFAULT_FAILED_PCT, FAILED_PCT_BOUNDS } from "../health.ts";
import { matchDeployment } from "../deployments.ts";
import { settings } from "../env.ts";
import {
	ALERT_LEVELS,
	FLEET_INGEST_TOKEN_VAR,
	FLEET_TOKEN_VAR,
	FleetError,
	formatAlert,
	formatCounts,
	formatServersTable,
	httpFleetClient,
	rollbackCommand,
	rollbackDecision,
	serverJson,
	summarize,
	type AlertRow,
	type FleetClient,
	type FleetSummary,
	type RollbackDecision,
	type ServerRow,
} from "../fleet.ts";
import { bold, dim, emitJson, formatSeconds, green, info, isJson, red, table, warn, yellow } from "../log.ts";
import { branchNameError, type Channel } from "../naming.ts";
import type { OpenCloud } from "../opencloud.ts";
import { progress } from "../progress.ts";
import { publishConfigKey } from "../registry.ts";
import { sleep } from "../runtime.ts";
import { openCloud, project, readHistory, registryApi } from "./common.ts";

export const serversFlags = { branch: "string", watch: "boolean" } as const;
export const reportFlags = { branch: "string", "no-registry": "boolean" } as const;
export const alertsFlags = { follow: "boolean", level: "string", since: "string" } as const;
export const fleetFlags = { url: "string", "dry-run": "boolean" } as const;
/** The flags releasing commands take for the wait. */
export const WAIT_FLAGS = { wait: "optional", "no-wait": "boolean", "no-auto-rollback": "boolean", "rollback-at": "string" } as const;
export const DEFAULT_WAIT_SECONDS = 90;
export const DEFAULT_ROLLBACK_AT = DEFAULT_FAILED_PCT;
/** Seconds after the message when a still-waiting fleet gets the same message again. */
export const RESEND_AFTER_SECONDS = 30;
/** The ConfigService key game servers read the fleet API's URL and ingest token from. */
export const FLEET_CONFIG_KEY = "TypeTorchFleet";

export interface FleetDeps {
	fleet?: FleetClient;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Stop condition for --watch / --follow (tests): return true to stop after a round. */
	until?: () => boolean;
}

export type FleetSetup = { client: FleetClient; url: string; ingest: boolean } | { client?: undefined; missing: string };

/** The fleet API for this project, or why it isn't configured (one line). */
export function fleetFor(proj: Project, deps: FleetDeps = {}): FleetSetup {
	const url = proj.config.fleet?.url;
	const token = settings().get(FLEET_TOKEN_VAR)?.value;
	const ingestToken = settings().get(FLEET_INGEST_TOKEN_VAR)?.value;
	if (deps.fleet) return { client: deps.fleet, url: url ?? "(test)", ingest: true };
	if (!url) return { missing: `the fleet API isn't configured: set typetorch.json "fleet": { "url": ... } (typetorch fleet setup --url <url>)` };
	if (!token) return { missing: `the fleet API's admin token isn't set: put ${FLEET_TOKEN_VAR} in the environment or the env file` };
	return { client: httpFleetClient({ url, token, ingestToken }), url, ingest: Boolean(ingestToken) };
}

function requireFleet(proj: Project, deps: FleetDeps): FleetClient | undefined {
	const setup = fleetFor(proj, deps);
	if (setup.client) return setup.client;
	if (isJson()) emitJson({ configured: false, reason: setup.missing });
	else info(setup.missing);
	return undefined;
}

export async function serversCommand(args: ParsedArgs, deps: FleetDeps = {}) {
	if (args.positionals.length) throw new UsageError(`unexpected argument "${args.positionals[0]}"`);
	const proj = project(args);
	const branch = flagString(args, "branch");
	if (branch && branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const fleet = requireFleet(proj, deps);
	if (!fleet) return;
	const clock = deps.now ?? Date.now;
	const watch = flagBool(args, "watch");
	if (watch && isJson()) throw new UsageError("--watch and --json don't mix");
	const tty = Boolean(process.stdout.isTTY);
	for (;;) {
		const now = clock() / 1000;
		const servers = await fleet.servers({ branch });
		if (isJson()) return emitJson({ universeId: proj.config.universeId, branch: branch ?? null, count: servers.length, servers: servers.map((s) => serverJson(s, now)) });
		if (watch && tty) process.stdout.write("\x1b[2J\x1b[H");
		if (watch) info(dim(`${new Date(clock()).toISOString().replace("T", " ").slice(0, 19)} UTC  (every 5 s; Ctrl+C stops)`));
		printServers(servers, branch, now);
		if (!watch || deps.until?.()) return;
		await (deps.sleep ?? sleep)(5000);
	}
}

function printServers(servers: ServerRow[], branch: string | undefined, now: number) {
	if (servers.length === 0) {
		info(`no live servers${branch ? ` on ${branch}` : ""} (servers post a heartbeat about every minute; kernels before 0.3.2 post none)`);
		return;
	}
	info(formatServersTable(servers, now));
	const byBranch = new Map<string, number>();
	for (const s of servers) byBranch.set(s.branch ?? "?", (byBranch.get(s.branch ?? "?") ?? 0) + 1);
	const players = servers.reduce((sum, s) => sum + (s.players ?? 0), 0);
	const unhealthy = servers.filter((s) => s.health && s.health !== "ok");
	info(dim(`${servers.length} server(s), ${players} player(s): ${[...byBranch].map(([b, n]) => `${b} ${n}`).join(", ")}`));
	if (unhealthy.length) info(yellow(`${unhealthy.length} not ok: ${unhealthy.map((s) => `${s.jobId.slice(0, 8)} ${s.health}${s.error ? ` (${s.error.slice(0, 120)})` : ""}`).join("; ")}`));
}

/** The human lines of a summary (shared by `report` and `--wait`). */
export function describeSummary(summary: FleetSummary, input: { fromArtifactId?: string; waitedSeconds?: number; timedOut?: boolean; rollbackHint?: boolean } = {}): string[] {
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
	if (summary.bad && input.rollbackHint !== false) {
		lines.push(red(bold(`  ${(summary.counts.failed ?? 0) + (summary.counts.rolled_back ?? 0)} server(s) failed or rolled back. To roll the branch back:`)));
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
	const fleet = requireFleet(proj, deps);
	if (!fleet) return;
	const oc = openCloud("deploy", true);
	const history = await readHistory(proj, registryApi(oc, proj, args.flags["no-registry"] === true), "--no-registry");
	const rows = history.rows.filter((d) => !branchFlag || d.branch === branchFlag);
	const isSeq = /^#?\d{1,7}$/.test(wanted);
	const deployment =
		wanted === "latest" ? rows.at(-1) : isSeq ? rows.filter((d) => d.seq === Number(wanted.replace("#", ""))).at(-1) : matchDeployment(rows, wanted, branchFlag);
	const seq = deployment?.seq ?? (isSeq ? Number(wanted.replace("#", "")) : undefined);
	// A seq this machine doesn't know: ask the API by artifact, or for its latest.
	const reports =
		seq !== undefined
			? await fleet.reports({ seq, branch: branchFlag })
			: await fleet.reports(wanted === "latest" ? { latest: true, branch: branchFlag } : { artifact: wanted, branch: branchFlag });
	const reportSeq = seq ?? reports.reduce((max, r) => Math.max(max, r.seq), -1);
	if (reportSeq < 0) throw new Error(`no deployment matches "${wanted}"${branchFlag ? ` on ${branchFlag}` : ""}, and the fleet API has no reports for it`);
	const branch = branchFlag ?? deployment?.branch ?? reports.find((r) => r.seq === reportSeq)?.branch;
	if (!branch) throw new Error(`#${reportSeq}: which branch? pass --branch`);
	const servers = await fleet.servers({ branch });
	const now = (deps.now ?? Date.now)() / 1000;
	const summary = summarize({ seq: reportSeq, branch, artifactId: deployment?.artifactId ?? reports.find((r) => r.seq === reportSeq)?.artifactId, reports, servers });
	if (summary.bad) process.exitCode = 1;
	if (isJson()) {
		return emitJson({
			...summary,
			stillOld: summary.stillOld.map((s) => serverJson(s, now)),
			unknownSeq: summary.unknownSeq.map((s) => serverJson(s, now)),
			deployment: deployment ?? null,
			rollback: summary.bad ? rollbackCommand(summary.branch, deployment?.fromArtifactId) : null,
			reportsList: reports.filter((r) => r.seq === reportSeq),
		});
	}
	for (const line of describeSummary(summary, { fromArtifactId: deployment?.fromArtifactId })) info(line);
	if (!summary.reports && !summary.servers) info(dim("  no reports and no live servers on the branch (kernels before 0.3.2 post none)"));
	else if (!summary.bad && summary.reports) info(green("  no failures"));
}

export async function alertsCommand(args: ParsedArgs, deps: FleetDeps = {}) {
	if (args.positionals.length) throw new UsageError(`unexpected argument "${args.positionals[0]}"`);
	const proj = project(args);
	const level = flagString(args, "level");
	if (level !== undefined && !(ALERT_LEVELS as readonly string[]).includes(level)) throw new UsageError(`--level must be one of ${ALERT_LEVELS.join(", ")}`);
	const fleet = requireFleet(proj, deps);
	if (!fleet) return;
	const clock = deps.now ?? Date.now;
	let since = clock() - flagInt(args, "since", 60) * 60_000;
	const follow = flagBool(args, "follow");
	if (follow && isJson()) throw new UsageError("--follow and --json don't mix");
	const seen = new Set<string>();
	for (let round = 0; ; round++) {
		const alerts = (await fleet.alerts({ since, level })).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
		if (isJson()) return emitJson({ since, level: level ?? null, alerts });
		const fresh = alerts.filter((a) => !seen.has(a.id ?? `${a.at}|${a.code}|${a.jobId ?? ""}`));
		for (const alert of fresh) {
			seen.add(alert.id ?? `${alert.at}|${alert.code}|${alert.jobId ?? ""}`);
			const line = formatAlert(alert);
			info(alert.level === "critical" ? red(line) : alert.level === "warning" ? yellow(line) : line);
		}
		if (round === 0 && alerts.length === 0) info(dim(`no alerts in the last ${flagInt(args, "since", 60)} min${level ? ` at level ${level}` : ""}`));
		if (!follow || deps.until?.()) return;
		since = Math.max(since, ...alerts.map((a) => (a.at ?? 0) - 1));
		await (deps.sleep ?? sleep)(5000);
	}
}

export async function fleetCommand(args: ParsedArgs, deps: { oc?: Pick<OpenCloud, "call"> } = {}) {
	const [sub, extra] = args.positionals;
	if (sub !== "setup") throw new UsageError(`unknown fleet subcommand "${sub ?? ""}" (setup)`);
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	const proj = project(args);
	const url = flagString(args, "url") ?? proj.config.fleet?.url;
	if (!url) throw new UsageError("which fleet API? pass --url https://<host>");
	const problem = fleetUrlError(url);
	if (problem) throw new UsageError(`--url ${problem}`);
	const ingest = settings().get(FLEET_INGEST_TOKEN_VAR);
	if (!ingest) throw new Error(`${FLEET_INGEST_TOKEN_VAR} isn't set: game servers post with the fleet API's write-only ingest token (put it in the environment or the env file; it is never printed)`);
	const dryRun = flagBool(args, "dry-run");
	const value = { url, token: ingest.value };
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, key: FLEET_CONFIG_KEY, value: { url, token: "<ingest token>" } });
		info(bold(`dry run: would write ConfigService key ${FLEET_CONFIG_KEY} = {"url":"${url}","token":"<${FLEET_INGEST_TOKEN_VAR}>"} and publish it`));
		return;
	}
	const oc = deps.oc ?? openCloud("deploy")!;
	const result = await publishConfigKey(oc, proj.config.universeId, FLEET_CONFIG_KEY, value, `typetorch fleet setup ${new URL(url).host}`);
	if (proj.config.fleet?.url !== url) updateProjectConfig(proj, { fleet: { url } });
	if (isJson()) return emitJson({ key: FLEET_CONFIG_KEY, url, configVersion: result.configVersion ?? null });
	info(bold(`game servers now post to ${url} (ConfigService ${FLEET_CONFIG_KEY}${result.configVersion !== undefined ? `, config v${result.configVersion}` : ""}; the token isn't read back)`));
	info(dim(`  typetorch.json fleet.url = ${url}; reads use ${FLEET_TOKEN_VAR}. Running servers pick it up when ConfigService pushes the update.`));
	info(dim("  note: the publish ships the whole ConfigService draft; an API key can't read it to check for other unpublished edits"));
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

/** The auto-rollback threshold and where it comes from (shown in the deploy output). */
export interface RollbackSetting {
	/** Percent of the servers that tried the seq; undefined = off. */
	threshold?: number;
	source: "--rollback-at" | "--no-auto-rollback" | "typetorch.json autoRollback.failedPct" | "default";
}

/**
 * --rollback-at <percent>, else typetorch.json "autoRollback": { "failedPct" } (health.ts), else 20;
 * --no-auto-rollback turns it off.
 */
export function rollbackSetting(args: ParsedArgs, config?: Pick<ProjectConfig, "autoRollback">): RollbackSetting {
	const raw = flagString(args, "rollback-at");
	if (args.flags["no-auto-rollback"] === true) {
		if (raw !== undefined) throw new UsageError("--rollback-at and --no-auto-rollback together");
		return { source: "--no-auto-rollback" };
	}
	const [low, high] = FAILED_PCT_BOUNDS;
	if (raw !== undefined) {
		if (!/^\d+$/.test(raw) || Number(raw) < low || Number(raw) > high) throw new UsageError(`--rollback-at must be a percent from ${low} to ${high}, got "${raw}"`);
		return { threshold: Number(raw), source: "--rollback-at" };
	}
	if (config?.autoRollback) return { threshold: config.autoRollback.failedPct, source: "typetorch.json autoRollback.failedPct" };
	return { threshold: DEFAULT_ROLLBACK_AT, source: "default" };
}

/** The threshold alone (rollbackSetting); undefined with --no-auto-rollback. */
export function rollbackThreshold(args: ParsedArgs, config?: Pick<ProjectConfig, "autoRollback">): number | undefined {
	return rollbackSetting(args, config).threshold;
}

/** One line for the deploy output: "auto-rollback at 20% of the servers that tried it (default)". */
export function describeRollbackSetting(setting: RollbackSetting): string {
	return setting.threshold === undefined
		? `auto-rollback off (${setting.source})`
		: `auto-rollback at ${setting.threshold}% of the servers that tried it (${setting.source})`;
}

export interface AutoRollbackHook {
	/** Percent of the servers that tried the seq. */
	threshold: number;
	/** Rolls the branch back (autorollback.ts); called once, after the summary. */
	run(input: { summary: FleetSummary; decision: RollbackDecision; reason: string }): Promise<{ rolledBack: boolean; kept?: boolean; seq?: number }>;
}

export interface WaitResult {
	summary?: FleetSummary;
	waitedSeconds: number;
	timedOut: boolean;
	resent: boolean;
	decision?: RollbackDecision;
	autoRollback?: { rolledBack: boolean; kept?: boolean; seq?: number };
	/** Servers that never reported (no failures anywhere). */
	stuck?: string[];
	/** Why there is no summary (not configured, an API error). */
	unavailable?: string;
}

/**
 * After a deploy message: polls the fleet API for the seq's reports until every live server of the branch reported it
 * or moved past it, or `seconds` pass; re-sends the message once at ~30 s for servers still behind; then the summary,
 * and an automatic rollback when the failures cross the threshold (see the module comment). Not configured, or an API
 * error: a note, and the deploy itself still counts as done.
 */
export async function waitForFleet(input: {
	fleet: FleetClient;
	branch: string;
	seq: number;
	artifactId: string;
	fromArtifactId?: string;
	seconds: number;
	/** Publishes the same deploy message again. */
	resend?: () => Promise<void>;
	autoRollback?: AutoRollbackHook;
	deps?: FleetDeps;
}): Promise<WaitResult> {
	const now = input.deps?.now ?? Date.now;
	const pause = input.deps?.sleep ?? sleep;
	const started = now();
	const elapsed = () => (now() - started) / 1000;
	info(dim(`  waiting up to ${input.seconds} s for the servers of ${input.branch} to report #${input.seq} (--no-wait skips this)...`));
	let summary: FleetSummary | undefined;
	let decision: RollbackDecision | undefined;
	let lastLine = "";
	let resent = false;
	const job = progress().job(`reports of #${input.seq} from the servers of ${input.branch}`);
	try {
		while (true) {
			const [reports, servers] = await Promise.all([input.fleet.reports({ seq: input.seq, branch: input.branch }), input.fleet.servers({ branch: input.branch })]);
			summary = summarize({ seq: input.seq, branch: input.branch, artifactId: input.artifactId, reports, servers });
			decision = rollbackDecision(summary, input.autoRollback?.threshold ?? DEFAULT_ROLLBACK_AT);
			const line = `${formatCounts(summary.counts)}; waiting for ${summary.waiting.length} of ${summary.servers}`;
			if (line !== lastLine) info(dim(`  ${formatSeconds(elapsed()).padStart(8)}  ${line}`));
			lastLine = line;
			job.update(`reports of #${input.seq}: ${summary.waiting.length} of ${summary.servers} server(s) still to report`);
			if (input.autoRollback && decision.early) break; // the threshold is met whatever the others report
			if (!resent && input.resend && elapsed() >= RESEND_AFTER_SECONDS && summary.waiting.length > 0) {
				resent = true;
				try {
					await input.resend();
					info(dim(`  ${formatSeconds(elapsed()).padStart(8)}  re-sent the deploy message (same seq) for ${summary.waiting.length} server(s) still behind`));
				} catch (error) {
					warn(`re-sending the deploy message failed: ${(error as Error).message}`);
				}
			}
			const done = summary.servers === 0 ? elapsed() >= 10 : summary.waiting.length === 0;
			if (done || elapsed() >= input.seconds) break;
			await pause(5000);
		}
	} catch (error) {
		job.done();
		const message = error instanceof FleetError ? error.message : `reading the fleet failed: ${(error as Error).message}`;
		warn(`${message}. The deploy went out; check later with \`typetorch report ${input.seq}\``);
		return { waitedSeconds: elapsed(), timedOut: false, resent, unavailable: message };
	}
	job.done();
	const timedOut = summary.waiting.length > 0 && summary.servers > 0;
	const result: WaitResult = { summary, waitedSeconds: elapsed(), timedOut, resent, decision };
	if (summary.servers === 0 && summary.reports === 0) {
		info(dim(`  no live servers on ${input.branch} reported (none running, or kernels before 0.3.2); new servers boot #${input.seq}`));
		return result;
	}
	const auto = Boolean(input.autoRollback && decision.met);
	for (const line of describeSummary(summary, { fromArtifactId: input.fromArtifactId, waitedSeconds: elapsed(), timedOut, rollbackHint: !auto })) info(line);

	if (auto && input.autoRollback) {
		const pct = Math.round(decision.ratio * 100);
		const reason = `${decision.failures} of ${decision.answered} server(s) that tried #${input.seq} failed or rolled back (${pct}% >= ${input.autoRollback.threshold}%)`;
		result.autoRollback = await input.autoRollback.run({ summary, decision, reason });
		process.exitCode = 1;
		return result;
	}
	if (summary.bad) {
		if (input.autoRollback) info(dim(`  below the auto-rollback threshold (${Math.round(decision.ratio * 100)}% < ${input.autoRollback.threshold}%): not rolled back`));
		process.exitCode = 1;
		return result;
	}
	if (timedOut) {
		// Stalled only: never a rollback. List them and raise a warning alert.
		result.stuck = summary.waiting;
		warn(`${summary.waiting.length} server(s) of ${input.branch} never reported #${input.seq}: ${summary.waiting.slice(0, 10).join(", ")}${summary.waiting.length > 10 ? ", ..." : ""} (they keep polling the head every 60 s)`);
		try {
			const sent = await input.fleet.postAlert({ level: "warning", code: "server_stuck", message: `${summary.waiting.length} server(s) didn't report #${input.seq} within ${input.seconds} s`, branch: input.branch, seq: input.seq, artifact: input.artifactId, jobs: summary.waiting.slice(0, 50) });
			if (!sent) info(dim(`  (alert server_stuck not posted: no ${FLEET_INGEST_TOKEN_VAR})`));
		} catch (error) {
			warn(`posting the server_stuck alert failed: ${(error as Error).message}`);
		}
	}
	return result;
}

/** Re-exported for the commands that print alerts the same way. */
export type { AlertRow };

export const WAIT_USAGE = `  --wait [seconds]     after the message, wait for the servers' reports (the fleet API) and print a summary (default
                       on for prod-channel branches, 90 s; --no-wait skips it). At 30 s the message is re-sent once for
                       servers still behind. When --rollback-at (default: typetorch.json autoRollback.failedPct, else 20) %
                       or more of the servers that tried it failed or rolled back, the branch is rolled back to the
                       previous artifact automatically (a 10 s Ctrl+C window at a terminal; --no-auto-rollback turns it
                       off). Stalled servers alone never roll back.`;

export const SERVERS_USAGE = `typetorch servers [--branch <b>] [--watch] [--json]

  Live servers from the fleet API (typetorch.json fleet.url, ${FLEET_TOKEN_VAR}): JobId, branch, artifact, applied
  seq, health, players, kernel version, age (uptime) and seen (last heartbeat). --watch redraws every 5 s.`;

export const REPORT_USAGE = `typetorch report <seq|artifact|latest> [--branch <b>] [--json]

  What the servers reported for one deploy (the fleet API): swapped / failed / rolled_back / skipped / booted counts,
  errors grouped, and the branch's servers still on an older seq. Exits 1 when a server failed or rolled back, and
  prints the rollback command.`;

export const ALERTS_USAGE = `typetorch alerts [--follow] [--level info|warning|critical] [--since <minutes>] [--json]

  Alerts from the fleet API (servers, deploys, auto-rollbacks), the last --since minutes (default 60). --follow keeps
  printing new ones (polls every 5 s).`;

export const FLEET_USAGE = `typetorch fleet setup --url <https url> [--dry-run]

  Points game servers at the fleet API: writes the ConfigService key ${FLEET_CONFIG_KEY} = {url, token} with the
  write-only ingest token from ${FLEET_INGEST_TOKEN_VAR} (PATCH the draft with that key only, then publish; needs
  universe:write on the deploy key; nothing is read back, the token is never printed), and typetorch.json fleet.url.
  Reads (servers, report, alerts, --wait) use the admin token in ${FLEET_TOKEN_VAR}.`;
