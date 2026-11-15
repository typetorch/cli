/**
 * `typetorch backend migrate` (plans/35 A and B): starts and follows the migration job on the backend that
 * typetorch.json `backend.url` names, with TYPETORCH_ADMIN_TOKEN:
 *
 *   --from <old url>          the old server's history into this one (its admin token: TYPETORCH_OLD_ADMIN_TOKEN);
 *                             checked first: the old /healthz and that the token is admin there (/v1/auth/check)
 *   --from-basin              Basin's Iceberg tables into this one (CLOUDFLARE_ACCOUNT_ID, BASIN_BUCKET, BASIN_SQL_TOKEN,
 *                             BASIN_NAMESPACE default typetorch)
 *   --to-basin [--events <url> --recordings <url>]   this backend's history into Basin's streams (BASIN_SEND_TOKEN;
 *                             default: the record's Basin streams)
 *   [--rows-per-second <n>]   the job's cap (the backend's default: TYPETORCH_MIGRATE_ROWS_PER_SECOND, 20,000)
 *   status [--json] [--watch] | pause | resume | cancel | resolve <page> resend|skip
 *
 * Every secret comes from the environment or the game repo's .env: never a flag, never printed (each is registered with
 * the scrubber the moment it is read), sent only in the start body over https.
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { backendCredentialsWarned, BackendError } from "../backend.ts";
import { backendUrlError, type Project } from "../config.ts";
import { checkOldBackend, formatReport } from "../endpoints.ts";
import {
	ADMIN_TOKEN_VAR,
	BASIN_BUCKET_VAR,
	BASIN_NAMESPACE_DEFAULT,
	BASIN_NAMESPACE_VAR,
	BASIN_SEND_TOKEN_VAR,
	BASIN_SQL_TOKEN_VAR,
	CLOUDFLARE_ACCOUNT_VAR,
	OLD_ADMIN_TOKEN_VAR,
	registerSecret,
	settings,
} from "../env.ts";
import { dim, emitJson, info, isJson, warn, yellow } from "../log.ts";
import { FINAL_STATES, formatMigration, migrationAction, migrationStatus, streamUrlError, type MigrateBody, type MigrationStatus } from "../migration.ts";
import type { OpenCloud } from "../opencloud.ts";
import { basinSinkOf, readSettings } from "../settings.ts";
import { openCloud, project } from "./common.ts";

export const MIGRATE_FLAGS = { from: "string", "from-basin": "boolean", "to-basin": "boolean", "rows-per-second": "string", watch: "boolean" } as const;
/** Flags only `backend migrate` takes (setup refuses them). */
export const MIGRATE_ONLY_FLAGS = Object.keys(MIGRATE_FLAGS);
/** `backend setup` flags that mean nothing to migrate. */
const SETUP_ONLY_FLAGS = ["url", "flush-seconds", "record-share", "analytics", "ingest", "dry-run", "no-ping", "backend-dir", "port", "cloudflared", "no-open", "key-file", "fallback-key-file"];
export const ROWS_PER_SECOND_MAX = 1_000_000;
export const WATCH_EVERY_MS = 5000;
export const MIGRATE_TIMEOUT_MS = 10_000;

export const MIGRATE_USAGE = `typetorch backend migrate --from <old url> | --from-basin | --to-basin [--events <url> --recordings <url>]
                          [--rows-per-second <n>] [--force]
typetorch backend migrate status [--json] [--watch] | pause | resume | cancel | resolve <page> resend|skip

  Moves history without touching files (plans/35): a job on the backend that typetorch.json backend.url names (with
  ${ADMIN_TOKEN_VAR}) copies it page by page, checks every day (match / missing / differs / duplicates) and survives
  restarts on either side. Live ingest always comes first; the source is only read.
  --from <url>     the OLD server's history into this one, newest day first. Its admin token: ${OLD_ADMIN_TOKEN_VAR}
                   (env / .env). Checked first: <url>/healthz and that the token is admin there. Runbook: deploy the
                   new server, \`backend setup --url <new>\` (game servers follow), point the Roblox erasure webhook at
                   it, then this; turn the old one off once every day says match
  --from-basin     Basin's Iceberg tables in R2 into this backend: ${CLOUDFLARE_ACCOUNT_VAR}, ${BASIN_BUCKET_VAR},
                   ${BASIN_SQL_TOKEN_VAR}, ${BASIN_NAMESPACE_VAR} (default ${BASIN_NAMESPACE_DEFAULT})
  --to-basin       this backend's history into Basin's streams (${BASIN_SEND_TOKEN_VAR}); --events / --recordings
                   default to the record's Basin streams. Basin can't delete or dedupe: a page cut off mid-send stops
                   the job (needs_decision) until you resolve it
  --rows-per-second  the job's cap (default: the backend's TYPETORCH_MIGRATE_ROWS_PER_SECOND, 20,000)
  --force          start although the old server's checks failed
  status           steps, progress, rows/s, the days to go and the per-day report; --watch polls every 5 s (Ctrl+C
                   stops watching, the job keeps running); --json is the backend's status as-is
  pause, resume, cancel   the job (cancel keeps what was imported; a new start resumes from the backend's cursor)
  resolve <page> resend|skip   to-basin: a page cut off mid-send: send it again (Basin may hold it twice) or skip it
  A backend that answers 501 for a direction doesn't support it yet: update it.`;

export interface MigrateDeps {
	oc?: Pick<OpenCloud, "request">;
	fetch?: typeof fetch;
	/** --watch (tests): the wait between polls, and a stop condition checked after each round. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	until?: (status: MigrationStatus) => boolean;
	now?: () => number;
	/** Aborting it is Ctrl+C (tests). */
	signal?: AbortSignal;
}

/** One secret from the environment or the game repo's .env, registered with the scrubber. */
function secret(name: string): string | undefined {
	const found = settings().get(name);
	if (!found) return undefined;
	registerSecret(found.value);
	return found.value;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export async function migrateCommand(args: ParsedArgs, deps: MigrateDeps = {}) {
	const [, action, ...rest] = args.positionals;
	for (const flag of SETUP_ONLY_FLAGS) if (args.flags[flag] !== undefined) throw new UsageError(`--${flag} doesn't go with \`backend migrate\` (it talks to typetorch.json backend.url)`);
	const starts = ([["from", flagString(args, "from") !== undefined], ["from-basin", flagBool(args, "from-basin")], ["to-basin", flagBool(args, "to-basin")]] as const).filter(([, on]) => on).map(([name]) => name);
	const rowsRaw = flagString(args, "rows-per-second");
	if (action !== undefined && starts.length) throw new UsageError(`--${starts[0]} starts a move: run it without "${action}"`);
	if (action !== undefined && rowsRaw !== undefined) throw new UsageError("--rows-per-second goes with --from, --from-basin or --to-basin");
	if (action !== "status" && flagBool(args, "watch")) throw new UsageError("--watch goes with `backend migrate status`");
	if (!starts.includes("to-basin") && (flagString(args, "events") !== undefined || flagString(args, "recordings") !== undefined)) {
		throw new UsageError("--events and --recordings go with --to-basin here (or with `backend setup --analytics basin`)");
	}
	if (action === undefined && starts.length === 0) throw new UsageError("what to move? --from <old url>, --from-basin or --to-basin; or status, pause, resume, cancel, resolve <page> resend|skip");
	if (starts.length > 1) throw new UsageError(`pick one of --from, --from-basin, --to-basin (got ${starts.map((s) => `--${s}`).join(", ")})`);
	if (action === "resolve") {
		if (rest.length !== 2) throw new UsageError("usage: typetorch backend migrate resolve <page> resend|skip");
	} else if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
	if (action !== undefined && !["status", "pause", "resume", "cancel", "resolve"].includes(action)) {
		throw new UsageError(`unknown migrate subcommand "${action}" (status, pause, resume, cancel, resolve)`);
	}
	let rowsPerSecond: number | undefined;
	if (rowsRaw !== undefined) {
		rowsPerSecond = Number(rowsRaw);
		if (!/^\d+$/.test(rowsRaw) || rowsPerSecond < 1 || rowsPerSecond > ROWS_PER_SECOND_MAX) throw new UsageError(`--rows-per-second must be a whole number from 1 to ${ROWS_PER_SECOND_MAX.toLocaleString("en-US")}, got "${rowsRaw}"`);
	}

	const proj = project(args);
	const url = proj.config.backend?.url?.replace(/\/+$/, "");
	if (!url) throw new UsageError("typetorch.json has no backend.url: point it at the backend that runs the job first (typetorch backend setup --url <url>)");
	const admin = backendCredentialsWarned().admin;
	if (!admin) throw new Error(`the migration needs the backend's admin token: put ${ADMIN_TOKEN_VAR} in ${settings().dotEnv} (or the environment)`);
	const options = { url, adminToken: admin.value, fetch: deps.fetch, timeoutMs: MIGRATE_TIMEOUT_MS };
	const host = hostOf(url);
	const show = (status: MigrationStatus, rate?: number) => {
		if (isJson()) return emitJson(status.raw);
		for (const line of formatMigration(status, { host, now: (deps.now ?? Date.now)(), rate })) info(line);
	};

	if (action === "status") {
		if (!flagBool(args, "watch")) return show(await migrationStatus(options));
		if (isJson()) throw new UsageError("--watch and --json don't mix");
		return watch(options, host, deps);
	}
	if (action === "pause" || action === "resume" || action === "cancel") {
		const status = await migrationAction(options, { action }, `${action} the migration`);
		if (!isJson()) info(`${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"} on ${host}`);
		return show(status);
	}
	if (action === "resolve") {
		const [page, choice] = rest as [string, string];
		if (choice !== "resend" && choice !== "skip") throw new UsageError(`resolve takes resend or skip, got "${choice}"`);
		if (!page.trim() || page.length > 200) throw new UsageError("resolve needs the page id the status names");
		const status = await migrationAction(options, { action: "resolve", page, choice }, `resolve page ${page}`);
		if (!isJson()) info(`page ${page}: ${choice === "resend" ? "sending it again" : "skipped"}`);
		return show(status);
	}

	// Start a move.
	const body = await startBody(starts[0]!, args, proj, url, deps, rowsPerSecond);
	const what = starts[0] === "from" ? "moving from the old server" : starts[0] === "from-basin" ? "moving from Basin" : "moving to Basin";
	const status = await migrationAction(options, body, what);
	if (!isJson()) {
		info(`${what}: started on ${host} (the job runs on the backend; closing this terminal doesn't stop it)`);
		info(dim("  follow it: typetorch backend migrate status --watch"));
	}
	return show(status);
}

/** The start body for one direction, after its checks. Secrets come from env / .env only. */
async function startBody(kind: "from" | "from-basin" | "to-basin", args: ParsedArgs, proj: Project, url: string, deps: MigrateDeps, rowsPerSecond: number | undefined): Promise<MigrateBody> {
	const rate = rowsPerSecond !== undefined ? { rowsPerSecond } : {};
	if (kind === "from") {
		const from = flagString(args, "from")!.trim().replace(/\/+$/, "");
		const problem = backendUrlError(from);
		if (problem) throw new UsageError(`--from ${problem}`);
		if (from === url) {
			throw new UsageError(
				`--from is typetorch.json backend.url itself (${hostOf(url)}): the job runs on the NEW server. First \`typetorch backend setup --url <new server>\` (game servers follow it), then \`backend migrate --from ${from}\``,
			);
		}
		const token = secret(OLD_ADMIN_TOKEN_VAR);
		if (!token) throw new Error(`--from needs the old server's admin token in ${OLD_ADMIN_TOKEN_VAR} (${settings().dotEnv} or the environment; never on the command line). With the old keys reused, it is the same value as ${ADMIN_TOKEN_VAR}`);
		const report = await checkOldBackend({ url: from, admin: token, name: OLD_ADMIN_TOKEN_VAR, fetch: deps.fetch });
		if (!report.ok) {
			const detail = formatReport(report, false).filter((line) => !line.includes(" skip ")).join("\n");
			if (!flagBool(args, "force")) throw new Error(`the old server's checks failed, nothing was started:\n${detail}\nFix that and run it again, or pass --force to start anyway`);
			warn(`--force: starting although the old server's checks failed:\n${detail}`);
		} else if (!isJson()) for (const line of formatReport(report)) info(dim(line));
		await warnIfRecordOnOld(proj, from, deps);
		return { action: "start", from: { kind: "backend", url: from, token }, ...rate };
	}
	if (kind === "from-basin") {
		const accountId = settings().get(CLOUDFLARE_ACCOUNT_VAR)?.value;
		const bucket = settings().get(BASIN_BUCKET_VAR)?.value;
		const token = secret(BASIN_SQL_TOKEN_VAR);
		const namespace = settings().get(BASIN_NAMESPACE_VAR)?.value ?? BASIN_NAMESPACE_DEFAULT;
		const missing = [[CLOUDFLARE_ACCOUNT_VAR, accountId], [BASIN_BUCKET_VAR, bucket], [BASIN_SQL_TOKEN_VAR, token]].filter(([, v]) => !v).map(([name]) => name);
		if (missing.length) throw new Error(`--from-basin needs ${missing.join(", ")} in ${settings().dotEnv} or the environment (never on the command line)`);
		return { action: "start", from: { kind: "basin", accountId: accountId!, bucket: bucket!, token: token!, namespace }, ...rate };
	}
	// to-basin: the flags' streams, else the record's Basin sink.
	let events = flagString(args, "events");
	let recordings = flagString(args, "recordings");
	if (events === undefined || recordings === undefined) {
		const sink = await recordSink(proj, deps);
		events ??= sink?.events;
		recordings ??= sink?.recordings;
	}
	if (!events || !recordings) throw new UsageError("--to-basin needs the two Basin stream URLs: --events <url> --recordings <url> (the record has no Basin sink to take them from)");
	for (const [flag, value] of [["events", events], ["recordings", recordings]] as const) {
		const problem = streamUrlError(value);
		if (problem) throw new UsageError(`--${flag} ${problem}`);
	}
	const token = secret(BASIN_SEND_TOKEN_VAR);
	if (!token) throw new Error(`--to-basin needs ${BASIN_SEND_TOKEN_VAR} (a Cloudflare API token with Pipelines Send) in ${settings().dotEnv} or the environment (never on the command line)`);
	if (!isJson()) info(yellow("  Basin can't delete or dedupe: a page cut off mid-send stops the job until you `resolve` it (resend or skip)"));
	return { action: "start", to: { kind: "basin", events, recordings, token }, ...rate };
}

/** The settings record's body (best effort: undefined without a deploy key or when it can't be read). */
async function recordBody(proj: Project, deps: MigrateDeps) {
	const oc = deps.oc ?? openCloud("deploy", true);
	if (!oc) return { note: "no Open Cloud deploy key to read the settings record with" };
	const read = await readSettings(oc, proj.config.universeId);
	if (read.error) return { note: `the settings record couldn't be read (${read.error.split("\n")[0]})` };
	return { body: read.body ?? {} };
}

async function recordSink(proj: Project, deps: MigrateDeps) {
	const read = await recordBody(proj, deps);
	return read.body ? basinSinkOf(read.body) : undefined;
}

/** Runbook step 2 before step 4: game servers should already post to the new server. */
async function warnIfRecordOnOld(proj: Project, from: string, deps: MigrateDeps) {
	const read = await recordBody(proj, deps);
	if (!read.body) {
		if (!isJson()) info(dim(`  not checked whether game servers still use ${hostOf(from)}: ${read.note}`));
		return;
	}
	const recordUrl = read.body.backend?.url?.replace(/\/+$/, "");
	if (recordUrl === from) {
		warn(
			`the settings record still points game servers at ${hostOf(from)} (the old server): run \`typetorch backend setup --url ${proj.config.backend?.url}\` first, so new rows land on the new server while the history moves (runbook step 2)`,
		);
	}
}

/** status --watch: a poll every 5 s (each call at most 10 s) until a final state or Ctrl+C. */
async function watch(options: { url: string; adminToken: string; fetch?: typeof fetch; timeoutMs: number }, host: string, deps: MigrateDeps) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	const external = deps.signal;
	if (external?.aborted) stop();
	external?.addEventListener("abort", stop);
	if (!deps.signal) {
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	}
	const now = deps.now ?? Date.now;
	const tty = Boolean(process.stdout.isTTY) && !deps.signal;
	let last: { rows: number; at: number } | undefined;
	try {
		while (!controller.signal.aborted) {
			let status: MigrationStatus | undefined;
			try {
				status = await migrationStatus({ ...options, signal: controller.signal });
			} catch (error) {
				if (controller.signal.aborted) break;
				// A 401 or a missing route won't fix itself; a slow or unreachable backend may.
				if (error instanceof BackendError && error.status !== 0 && error.status < 500) throw error;
				info(yellow(`${new Date(now()).toISOString().slice(11, 19)} UTC  ${(error as Error).message} (trying again in 5 s)`));
			}
			if (status) {
				const at = now();
				const rate = last && at > last.at ? Math.max(0, ((status.rowsDone - last.rows) * 1000) / (at - last.at)) : undefined;
				last = { rows: status.rowsDone, at };
				if (tty) process.stdout.write("\x1b[2J\x1b[H");
				info(dim(`${new Date(at).toISOString().replace("T", " ").slice(0, 19)} UTC  (every 5 s; Ctrl+C stops watching, the job keeps running)`));
				for (const line of formatMigration(status, { host, now: at, rate })) info(line);
				if (FINAL_STATES.has(status.state) || deps.until?.(status)) return;
			}
			await (deps.sleep ?? abortableSleep)(WATCH_EVERY_MS, controller.signal);
		}
		info(dim("stopped watching; the migration keeps running on the backend (typetorch backend migrate status)"));
	} finally {
		external?.removeEventListener("abort", stop);
		if (!deps.signal) {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done);
	});
}
