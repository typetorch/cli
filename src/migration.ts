/**
 * Moving a backend's history (plans/35 A and B): the client of the migration job on the backend
 * (`POST` / `GET /v1/admin/migrate`, admin token) and the compact status view `typetorch backend migrate status` prints.
 *
 * The job runs inside the backend the record points at (typetorch.json `backend.url`): it pulls from an old server
 * (`from.kind = "backend"`, its admin token) or from Basin's Iceberg tables (`from.kind = "basin"`, the R2 SQL token),
 * or pushes this backend's history into Basin's streams (`to.kind = "basin"`, the send token). Tokens travel only in
 * the start body; the backend stores them encrypted and never echoes them, and nothing here prints a request body.
 */
import { adminRequest, BackendError, type BackendRequestOptions } from "./backend.ts";
import { shortBody } from "./httphints.ts";
import { bold, cyan, dim, green, red, yellow } from "./log.ts";

export const MIGRATE_PATH = "/v1/admin/migrate";
export const MIGRATE_STATES = ["idle", "running", "paused", "waiting", "done", "failed", "cancelled", "needs_decision"] as const;
export const MIGRATE_DIRECTIONS = ["from-backend", "from-basin", "to-basin"] as const;
/** `sent` (to-basin): posted to Basin but not counted there (the server has no Basin read settings). */
export const DAY_STATES = ["pending", "importing", "match", "sent", "missing", "differs", "duplicates"] as const;
/** States after which nothing changes by itself (--watch stops there). */
export const FINAL_STATES: ReadonlySet<string> = new Set(["idle", "done", "failed", "cancelled"]);

export type MigrateSource =
	| { kind: "backend"; url: string; token: string }
	| { kind: "basin"; accountId: string; bucket: string; token: string; namespace: string };
export type MigrateTarget = { kind: "basin"; events: string; recordings: string; token: string };

/** The bodies of POST /v1/admin/migrate (plans/35 Contracts "A/B. The migration job"). */
export type MigrateBody =
	| { action: "start"; from: MigrateSource; rowsPerSecond?: number }
	| { action: "start"; to: MigrateTarget; rowsPerSecond?: number }
	| { action: "pause" | "resume" | "cancel" }
	| { action: "resolve"; page: string; choice: "resend" | "skip" };

export interface MigrateStep {
	name: string;
	state: string;
	done: number;
	total: number;
}

export interface MigrateDay {
	table: string;
	day: string;
	state: string;
	rowsSource: number;
	rowsTarget: number;
	note: string;
}

export interface MigrationStatus {
	state: string;
	direction: string | null;
	source: Record<string, unknown> | null;
	startedAt: number | null;
	finishedAt: number | null;
	rowsPerSecond: number | null;
	rowsDone: number;
	rowsTotal: number;
	steps: MigrateStep[];
	days: MigrateDay[];
	waitingFor: string | null;
	decision: unknown;
	error: string | null;
	/** The reply as sent (--json). */
	raw: Record<string, unknown>;
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strOrNull = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** A status reply, leniently: missing fields read as 0 / [] / null, never invented. */
export function parseMigrationStatus(json: Record<string, unknown>): MigrationStatus {
	const source = typeof json.source === "object" && json.source !== null && !Array.isArray(json.source) ? (json.source as Record<string, unknown>) : null;
	return {
		state: typeof json.state === "string" ? json.state : "?",
		direction: strOrNull(json.direction),
		source,
		startedAt: numOrNull(json.startedAt),
		finishedAt: numOrNull(json.finishedAt),
		rowsPerSecond: numOrNull(json.rowsPerSecond),
		rowsDone: num(json.rowsDone),
		rowsTotal: num(json.rowsTotal),
		steps: (Array.isArray(json.steps) ? json.steps : []).map(obj).map((s) => ({ name: String(s.name ?? "?"), state: String(s.state ?? "?"), done: num(s.done), total: num(s.total) })),
		days: (Array.isArray(json.days) ? json.days : []).map(obj).map((d) => ({
			table: String(d.table ?? "?"),
			day: String(d.day ?? "?"),
			state: String(d.state ?? "?"),
			rowsSource: num(d.rowsSource),
			rowsTarget: num(d.rowsTarget),
			note: typeof d.note === "string" ? d.note : "",
		})),
		waitingFor: strOrNull(json.waitingFor),
		decision: json.decision ?? null,
		error: strOrNull(json.error),
		raw: json,
	};
}

/** What the backend answered, as an error a person can act on. */
function migrateError(method: string, reply: { status: number; json?: Record<string, unknown>; text: string }, what: string): BackendError {
	const said = typeof reply.json?.error === "string" ? reply.json.error : shortBody(reply.text);
	if (reply.status === 501) return new BackendError(`${what}: this backend doesn't support it yet: update it${said ? ` (${said})` : ""}`, 501, reply.json);
	if (reply.status === 404 && !reply.json?.error) return new BackendError(`${method} ${MIGRATE_PATH} answered 404: the backend predates moves (plans/35): update it`, 404, reply.json);
	if (reply.status === 409) return new BackendError(`${what}: the backend refused (409): ${said}`, 409, reply.json);
	return new BackendError(`${method} ${MIGRATE_PATH} answered ${reply.status}: ${said}`, reply.status, reply.json);
}

/** GET /v1/admin/migrate: the job's status. */
export async function migrationStatus(options: BackendRequestOptions): Promise<MigrationStatus> {
	const reply = await adminRequest(options, "GET", MIGRATE_PATH, undefined, 2_000_000);
	if (reply.status !== 200 || !reply.json) throw migrateError("GET", reply, "the migration status");
	return parseMigrationStatus(reply.json);
}

/** POST /v1/admin/migrate with one action; the answer is the status. `what` names it in errors. */
export async function migrationAction(options: BackendRequestOptions, body: MigrateBody, what: string): Promise<MigrationStatus> {
	const reply = await adminRequest(options, "POST", MIGRATE_PATH, body, 2_000_000);
	if (reply.status < 200 || reply.status >= 300 || !reply.json) throw migrateError("POST", reply, what);
	return parseMigrationStatus(reply.json);
}

/** A Basin stream URL's problem, or undefined. */
export function streamUrlError(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "must be a Basin stream's https URL (https://<stream id>.ingest.cloudflare.com)";
	}
	if (url.protocol !== "https:") return "must be https (https://<stream id>.ingest.cloudflare.com)";
	if (url.username || url.password) return "must not hold credentials (the send token comes from BASIN_SEND_TOKEN in the game repo's .env)";
	if (url.search || url.hash) return "must not have a query or fragment";
	return undefined;
}

// The view --------------------------------------------------------------------------------------------------------------

const grouped = (n: number) => Math.round(n).toLocaleString("en-US");

/** A unix time in seconds or milliseconds as "YYYY-MM-DD HH:MM UTC". */
function when(t: number): string {
	const ms = t > 1e12 ? t : t * 1000;
	return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function duration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "?";
	if (seconds < 90) return `${Math.round(seconds)} s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
	if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
	return `${(seconds / 86_400).toFixed(1)} days`;
}

export function progressBar(done: number, total: number, width = 24): string {
	const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
	const filled = Math.round(share * width);
	return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function paintState(state: string): string {
	if (state === "done" || state === "match") return green(state);
	if (state === "failed" || state === "differs" || state === "missing") return red(state);
	if (state === "needs_decision" || state === "paused" || state === "waiting" || state === "duplicates") return yellow(state);
	if (state === "running" || state === "importing") return cyan(state);
	return state;
}

function hostOf(value: unknown): string {
	try {
		return new URL(String(value)).host;
	} catch {
		return String(value ?? "?");
	}
}

/** "old.example.com -> this backend", "Basin -> this backend", "this backend -> Basin". */
function route(status: MigrationStatus, here: string): string {
	const source = status.source;
	if (status.direction === "to-basin") return `${here} -> Basin`;
	if (status.direction === "from-basin" || source?.kind === "basin") return `Basin${typeof source?.bucket === "string" ? ` (${source.bucket})` : ""} -> ${here}`;
	if (source && typeof source.url === "string") return `${hostOf(source.url)} -> ${here}`;
	return here;
}

/** The page a decision is about (to-basin: a page cut off mid-send), when it names one. */
export function decisionPage(decision: unknown): string | undefined {
	const d = obj(decision);
	return typeof d.page === "string" ? d.page : typeof d.page === "number" ? String(d.page) : undefined;
}

export interface ViewOptions {
	/** The backend's host (typetorch.json backend.url). */
	host: string;
	/** Now, ms. */
	now: number;
	/** rows/s measured between two --watch polls; else the average since the start. */
	rate?: number;
	/** How many non-matching days to list one by one (default 12). */
	maxDays?: number;
}

/** The status as a few lines: state, progress, steps, the per-day report, what it waits for, a decision. */
export function formatMigration(status: MigrationStatus, view: ViewOptions): string[] {
	const lines: string[] = [];
	const here = `this backend (${view.host})`;
	if (status.state === "idle" && !status.direction) {
		lines.push(`migration ${paintState("idle")}: no move has run on ${view.host} (start one with typetorch backend migrate --from <old url> | --from-basin | --to-basin)`);
		return lines;
	}
	lines.push(`${bold("migration")} ${paintState(status.state)}  ${status.direction ?? "?"}  ${route(status, here)}`);
	const times = [status.startedAt ? `started ${when(status.startedAt)}` : undefined, status.finishedAt ? `finished ${when(status.finishedAt)}` : undefined].filter(Boolean);
	if (times.length) lines.push(dim(`  ${times.join(", ")}`));

	// Progress, rate and what is left.
	const pct = status.rowsTotal > 0 ? Math.min(100, (status.rowsDone / status.rowsTotal) * 100) : status.state === "done" ? 100 : 0;
	const elapsed = status.startedAt ? (view.now - (status.startedAt > 1e12 ? status.startedAt : status.startedAt * 1000)) / 1000 : undefined;
	const rate = view.rate ?? (elapsed && elapsed > 0 && status.state !== "done" ? status.rowsDone / elapsed : undefined);
	const left = Math.max(0, status.rowsTotal - status.rowsDone);
	const daysLeft = status.days.filter((d) => d.state === "pending" || d.state === "importing").length;
	const parts = [
		`${progressBar(status.rowsDone, status.rowsTotal)} ${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%`,
		`${grouped(status.rowsDone)} / ${grouped(status.rowsTotal)} rows`,
		rate !== undefined && status.state === "running" ? `${grouped(rate)} rows/s` : undefined,
		status.rowsPerSecond ? `cap ${grouped(status.rowsPerSecond)}/s` : undefined,
		status.days.length ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} to go` : undefined,
		rate && rate > 0 && left > 0 && status.state === "running" ? `about ${duration(left / rate)} left` : undefined,
	].filter(Boolean);
	lines.push(`  ${parts.join("  ")}`);

	if (status.steps.length) {
		const step = (s: MigrateStep) => {
			const count = s.total > 0 ? ` ${grouped(s.done)}/${grouped(s.total)}` : "";
			if (s.state === "done") return `${s.name} ${green("ok")}`;
			if (s.state === "failed") return `${s.name} ${red("FAILED")}${count}`;
			if (s.state === "running") return `${s.name} ${cyan("running")}${count}`;
			return dim(`${s.name} ${s.state}`);
		};
		lines.push(`  steps  ${status.steps.map(step).join(", ")}`);
	}

	// The per-day report: counts per state for each table, then the days that need a look.
	if (status.days.length) {
		const tables = [...new Set(status.days.map((d) => d.table))];
		for (const table of tables) {
			const days = status.days.filter((d) => d.table === table);
			const counts = new Map<string, number>();
			for (const d of days) counts.set(d.state, (counts.get(d.state) ?? 0) + 1);
			const order = [...DAY_STATES, ...[...counts.keys()].filter((k) => !(DAY_STATES as readonly string[]).includes(k))];
			const summary = order.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${paintState(s)}`);
			const span = days.length > 1 ? ` ${[...days].sort((a, b) => a.day.localeCompare(b.day))[0]!.day}..${[...days].sort((a, b) => b.day.localeCompare(a.day))[0]!.day}` : ` ${days[0]!.day}`;
			lines.push(`  ${table.padEnd(10)} ${days.length} day${days.length === 1 ? "" : "s"}${dim(span)}: ${summary.join(", ")}`);
		}
		const bad = status.days.filter((d) => d.state === "missing" || d.state === "differs" || d.state === "duplicates");
		const max = view.maxDays ?? 12;
		for (const d of bad.slice(0, max)) {
			const diff = d.state === "missing" ? `missing ${grouped(Math.max(0, d.rowsSource - d.rowsTarget))}` : d.state === "duplicates" ? `${grouped(Math.max(0, d.rowsTarget - d.rowsSource))} duplicate rows` : "differs";
			lines.push(`    ${d.day} ${d.table.padEnd(10)} ${paintState(d.state === "duplicates" ? "duplicates" : d.state)}: ${diff} (source ${grouped(d.rowsSource)}, here ${grouped(d.rowsTarget)})${d.note ? ` ${dim(d.note)}` : ""}`);
		}
		if (bad.length > max) lines.push(dim(`    and ${bad.length - max} more (--json lists every day)`));
	}

	if (status.waitingFor) lines.push(`  ${yellow("waiting for")} ${status.waitingFor}`);
	if (status.decision !== null && status.decision !== undefined) {
		const d = obj(status.decision);
		const text = typeof status.decision === "string" ? status.decision : typeof d.question === "string" ? d.question : typeof d.reason === "string" ? d.reason : typeof d.message === "string" ? d.message : JSON.stringify(status.decision);
		lines.push(`  ${yellow("decision")} ${text}`);
		const page = decisionPage(status.decision);
		if (page) {
			lines.push(`    typetorch backend migrate resolve ${page} resend   send the page again (Basin may then hold up to one page twice)`);
			lines.push(`    typetorch backend migrate resolve ${page} skip     leave it out (its rows may be missing in Basin)`);
		}
	}
	if (status.error) lines.push(`  ${red("error")} ${status.error}`);
	const allMatch = status.days.length > 0 && status.days.every((d) => d.state === "match");
	if (status.state === "done" && allMatch) {
		if (status.direction === "from-backend") lines.push(green(`  every day matches: keep a last backup of the source, then turn it off`));
		if (status.direction === "from-basin") lines.push(green(`  every day matches Basin's counts: the Basin tables can stay as a backup (the move only read them)`));
		if (status.direction === "to-basin") lines.push(green(`  every day is in Basin: keep a last backup, then TYPETORCH_PARTS=fleet turns this server's analytics off`));
	}
	if (status.state === "done" && status.direction === "to-basin" && status.days.some((d) => d.state === "sent")) {
		lines.push(`  ${dim("sent = posted but not counted in Basin: set CLOUDFLARE_ACCOUNT_ID, BASIN_BUCKET and BASIN_SQL_TOKEN on the server to check")}`);
	}
	return lines;
}
