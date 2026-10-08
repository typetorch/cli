/**
 * Fleet visibility (plans/12 P-O1, reader side) through the TypeTorch backend's **fleet API** (@typetorch/backend, SQLite)
 * that game kernels post their heartbeats, deploy reports and alerts to. `typetorch servers`, `report`, `alerts` and
 * `--wait` read it; `backend setup` tells game servers where it is.
 *
 *   GET  /v1/fleet/servers?branch=<b>                 { servers: [...] }   latest heartbeat per live server
 *   GET  /v1/fleet/reports?seq=<n>|artifact=<id>|latest[&branch=<b>]  { reports: [...] }
 *   GET  /v1/fleet/alerts?since=<unix ms>&level=<l>   { alerts: [...] }
 *   POST /v1/fleet/alert                              { level, code, message, branch?, seq?, artifact? } (the game key)
 *   GET  /v1/fleet/stream                             (SSE; not used: the CLI polls)
 * Reads send the admin token (`TYPETORCH_ADMIN_TOKEN`, Authorization: Bearer), posts the write-only game key
 * (`TYPETORCH_API_KEY`). Both come from the environment or the game repo's .env (backend.ts) and are never printed. The
 * URL is typetorch.json `backend.url`.
 *
 * The rows keep the kernel's contract (kernel src/server/Reports.luau); the parsers take the short field names the
 * kernel posts ({t, b, c, a, n, m, s, u, p, k?, x?, v, q, g, h, e?, sv} and {s, b, a, j, r, e?, d?, t, g, k, p}) or the
 * long names a server may answer with (job, branch, artifact, players, appliedSeq, health...). Reserved-server access
 * codes are never kept: only whether a server has one.
 *
 * The CLI keeps this small fetch client so it stays dependency-free (the backend pulls in DuckDB).
 */
import { ADMIN_TOKEN_VAR, BACKEND_KEY_VAR } from "./env.ts";
import { fleetHint, fleetNetworkHint, shortBody } from "./httphints.ts";
import { table } from "./log.ts";
import { withJob } from "./progress.ts";

export class FleetError extends Error {
	override name = "FleetError";
	constructor(
		message: string,
		readonly status = 0,
	) {
		super(message);
	}
}

export type AlertLevel = "info" | "warning" | "critical";
export const ALERT_LEVELS: readonly AlertLevel[] = ["info", "warning", "critical"];

export interface AlertRow {
	id?: string;
	/** Unix ms. */
	at?: number;
	level: string;
	code: string;
	message?: string;
	branch?: string;
	seq?: number;
	jobId?: string;
	artifactId?: string;
	acked?: boolean;
}

export interface NewAlert {
	level: AlertLevel;
	code: string;
	message: string;
	branch?: string;
	seq?: number;
	artifact?: string;
	jobs?: string[];
}

export interface FleetClient {
	servers(query?: { branch?: string }): Promise<ServerRow[]>;
	reports(query: { seq?: number; artifact?: string; latest?: boolean; branch?: string }): Promise<ReportRow[]>;
	alerts(query?: { since?: number; level?: string }): Promise<AlertRow[]>;
	/** With the game key (TYPETORCH_API_KEY); false when there is none (nothing sent). */
	postAlert(alert: NewAlert): Promise<boolean>;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** Unix seconds from a number (seconds or ms) or an ISO string. */
const unixSeconds = (v: unknown): number | undefined => {
	const n = num(v);
	if (n !== undefined) return n > 1e11 ? Math.floor(n / 1000) : n;
	if (typeof v === "string") {
		const ms = Date.parse(v);
		return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
	}
	return undefined;
};
const pick = (row: Record<string, unknown>, ...keys: string[]): unknown => {
	for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
	return undefined;
};
const rowsOf = (body: unknown, key: string): Record<string, unknown>[] => {
	const list = Array.isArray(body) ? body : Array.isArray((body as Record<string, unknown> | null)?.[key]) ? (body as Record<string, unknown[]>)[key] : [];
	return list.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r));
};

/**
 * The alert body in the kernel's shape (kernel src/server/Fleet.luau: {level, code, message, j, b, a, s, t, g, k}), so
 * the fleet API sees one format; `j` = "cli" (no JobId), stuck JobIds go in the message.
 */
export function alertBody(alert: NewAlert): Record<string, unknown> {
	const jobs = alert.jobs?.length ? ` [${alert.jobs.slice(0, 10).join(", ")}${alert.jobs.length > 10 ? ", ..." : ""}]` : "";
	const message = `${alert.message}${jobs}`;
	return {
		level: alert.level,
		code: alert.code,
		message: message.length > 300 ? `${message.slice(0, 297)}...` : message,
		j: "cli",
		...(alert.branch ? { b: alert.branch } : {}),
		...(alert.artifact ? { a: alert.artifact } : {}),
		...(alert.seq !== undefined ? { s: alert.seq } : {}),
		t: Math.floor(Date.now() / 1000),
	};
}

/**
 * One configured fleet API over fetch (tests pass `fetch`): reads with the admin token, alerts with the game key (the
 * backend refuses the admin token on its game routes).
 */
export function httpFleetClient(options: { url: string; adminToken?: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }): FleetClient {
	const base = options.url.replace(/\/+$/, "");
	const doFetch = options.fetch ?? fetch;
	const request = async (method: string, path: string, token: string | undefined, body?: unknown): Promise<unknown> => {
		const label = `fleet API ${path.split("?")[0].replace("/v1/fleet/", "")}`;
		return withJob(label, async () => {
			const headers: Record<string, string> = {};
			if (token) headers.authorization = `Bearer ${token}`;
			if (body !== undefined) headers["content-type"] = "application/json";
			let response: Response;
			try {
				response = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
			} catch (error) {
				const host = new URL(base).host;
				throw new FleetError(fleetNetworkHint(error as Error, host) ?? `the fleet API at ${host} didn't answer: ${(error as Error).message}`);
			}
			const text = await response.text();
			if (response.status === 401 || response.status === 403) {
				throw new FleetError(`the backend refused the ${method === "GET" ? "admin token" : "game key"} (${response.status}): check ${method === "GET" ? ADMIN_TOKEN_VAR : BACKEND_KEY_VAR} in the game repo's .env`, response.status);
			}
			if (!response.ok) {
				// A known cause gets its fix; anything else shows the response, shortened (HTML pages reduced to their title).
				const hint = fleetHint(response.status, text, new URL(base).host);
				throw new FleetError(hint ?? `fleet API ${method} ${path.split("?")[0]} -> ${response.status} ${shortBody(text)}`, response.status);
			}
			try {
				return text ? JSON.parse(text) : undefined;
			} catch {
				throw new FleetError(`fleet API ${path.split("?")[0]} answered something that isn't JSON`);
			}
		});
	};
	const query = (params: Record<string, string | number | boolean | undefined>) => {
		const parts = Object.entries(params)
			.filter(([, v]) => v !== undefined && v !== false)
			.map(([k, v]) => (v === true ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`));
		return parts.length ? `?${parts.join("&")}` : "";
	};
	return {
		async servers(q = {}) {
			const body = await request("GET", `/v1/fleet/servers${query({ branch: q.branch })}`, options.adminToken);
			return rowsOf(body, "servers").map(parseServer).filter((s): s is ServerRow => s !== undefined);
		},
		async reports(q) {
			const body = await request("GET", `/v1/fleet/reports${query({ seq: q.seq, artifact: q.artifact, latest: q.latest, branch: q.branch })}`, options.adminToken);
			return rowsOf(body, "reports").map(parseReport).filter((r): r is ReportRow => r !== undefined);
		},
		async alerts(q = {}) {
			const body = await request("GET", `/v1/fleet/alerts${query({ since: q.since, level: q.level })}`, options.adminToken);
			return rowsOf(body, "alerts").map(parseAlert).filter((a): a is AlertRow => a !== undefined);
		},
		async postAlert(alert) {
			if (!options.apiKey) return false;
			await request("POST", "/v1/fleet/alert", options.apiKey, alertBody(alert));
			return true;
		},
	};
}

export type Health = "ok" | "failed" | "unverified" | "degraded";
export const HEALTH: readonly Health[] = ["ok", "failed", "unverified", "degraded"];

export interface ServerRow {
	jobId: string;
	serverType?: string;
	branch?: string;
	channel?: string;
	artifactId?: string;
	players?: number;
	maxPlayers?: number;
	/** Unix seconds. */
	startedAt?: number;
	/** Unix seconds of the last heartbeat. */
	updatedAt?: number;
	placeId?: number;
	/** A reserved server with an access code (the code itself is never kept). */
	accessCode: boolean;
	experiment: boolean;
	kernelVersion?: string;
	/** The applied seq (kernel 0.3.2+). */
	seq?: number;
	generation?: number;
	health?: Health;
	error?: string;
	/** 2, or undefined for older kernels. */
	schema?: number;
}

export function parseServer(row: Record<string, unknown>): ServerRow | undefined {
	const jobId = str(pick(row, "job", "jobId", "j", "id"));
	if (!jobId) return undefined;
	const health = str(pick(row, "health", "h"));
	const code = pick(row, "k", "accessCode", "hasAccessCode");
	const experiment = pick(row, "experiment", "x");
	return {
		jobId,
		serverType: str(pick(row, "serverType", "type", "t")),
		branch: str(pick(row, "branch", "b")),
		channel: str(pick(row, "channel", "c")),
		artifactId: str(pick(row, "artifact", "artifactId", "a")),
		players: num(pick(row, "players", "n")),
		maxPlayers: num(pick(row, "maxPlayers", "max_players", "m")),
		startedAt: unixSeconds(pick(row, "startedAt", "started_at", "s")),
		updatedAt: unixSeconds(pick(row, "lastWrite", "last_write", "lastSeen", "u")),
		placeId: num(pick(row, "placeId", "place_id", "p")),
		accessCode: code !== undefined && code !== false && code !== "",
		experiment: experiment === 1 || experiment === true || experiment === "1",
		kernelVersion: str(pick(row, "kernel", "kernelVersion", "v")),
		seq: num(pick(row, "appliedSeq", "applied_seq", "q")),
		generation: num(pick(row, "generation", "g")),
		health: health && (HEALTH as readonly string[]).includes(health) ? (health as Health) : undefined,
		error: str(pick(row, "lastError", "last_error", "error", "e")),
		schema: num(pick(row, "serverVersion", "server_version", "sv")),
	};
}

export type ReportResult = "swapped" | "failed" | "rolled_back" | "skipped" | "booted";
export const REPORT_RESULTS: readonly ReportResult[] = ["swapped", "failed", "rolled_back", "skipped", "booted"];

export interface ReportRow {
	seq: number;
	branch?: string;
	artifactId?: string;
	jobId: string;
	result: ReportResult | string;
	error?: string;
	seconds?: number;
	/** Unix seconds. */
	at?: number;
	generation?: number;
	kernelVersion?: string;
	players?: number;
}

export function parseReport(row: Record<string, unknown>): ReportRow | undefined {
	const seq = num(pick(row, "seq", "s"));
	const jobId = str(pick(row, "job", "jobId", "j"));
	if (seq === undefined || !jobId) return undefined;
	return {
		seq,
		branch: str(pick(row, "branch", "b")),
		artifactId: str(pick(row, "artifact", "artifactId", "a")),
		jobId,
		result: str(pick(row, "result", "r")) ?? "unknown",
		error: str(pick(row, "error", "e")),
		seconds: num(pick(row, "seconds", "d")),
		at: unixSeconds(pick(row, "at", "t")),
		generation: num(pick(row, "generation", "g")),
		kernelVersion: str(pick(row, "kernel", "kernelVersion", "k")),
		players: num(pick(row, "players", "p")),
	};
}

export function parseAlert(row: Record<string, unknown>): AlertRow | undefined {
	const code = str(pick(row, "code"));
	if (!code) return undefined;
	const at = num(pick(row, "at", "t"));
	return {
		id: str(pick(row, "id")) ?? (num(row.id) !== undefined ? String(row.id) : undefined),
		at: at !== undefined ? (at < 1e11 ? at * 1000 : at) : typeof row.at === "string" ? Date.parse(row.at) : undefined,
		level: str(pick(row, "level")) ?? "info",
		code,
		message: str(pick(row, "message", "text")),
		branch: str(pick(row, "branch", "b")),
		seq: num(pick(row, "seq", "s")),
		jobId: str(pick(row, "job", "jobId", "j")),
		artifactId: str(pick(row, "artifact", "artifactId", "a")),
		acked: row.acked === true || typeof row.ackedAt === "number" || typeof row.ackedAt === "string",
	};
}

// Summaries -------------------------------------------------------------------------------------------------------------

export interface ErrorGroup {
	error: string;
	count: number;
	jobs: string[];
}

export interface FleetSummary {
	seq: number;
	branch: string;
	artifactId?: string;
	/** Reports by result (each server's newest report for the seq). */
	counts: Record<string, number>;
	reports: number;
	errors: ErrorGroup[];
	/** Servers of the branch (alive now) whose applied seq is below this one; unknownSeq: older kernels without `q`. */
	stillOld: ServerRow[];
	unknownSeq: ServerRow[];
	/** Live servers of the branch. */
	servers: number;
	/** Servers of the branch that haven't reported this seq yet (alive, applied seq below it or unknown). */
	waiting: string[];
	/** Any server failed or rolled back. */
	bad: boolean;
}

/** One report per server: the newest by time (a retried swap may report twice). */
export function latestPerServer(reports: ReportRow[]): ReportRow[] {
	const byJob = new Map<string, ReportRow>();
	for (const report of reports) {
		const current = byJob.get(report.jobId);
		if (!current || (report.at ?? 0) >= (current.at ?? 0)) byJob.set(report.jobId, report);
	}
	return [...byJob.values()];
}

export function summarize(input: { seq: number; branch: string; artifactId?: string; reports: ReportRow[]; servers: ServerRow[] }): FleetSummary {
	const reports = latestPerServer(input.reports.filter((r) => r.seq === input.seq && (!r.branch || r.branch === input.branch)));
	const counts: Record<string, number> = {};
	for (const r of reports) counts[r.result] = (counts[r.result] ?? 0) + 1;
	const errors = new Map<string, ErrorGroup>();
	for (const r of reports) {
		if (!r.error) continue;
		const group = errors.get(r.error) ?? { error: r.error, count: 0, jobs: [] };
		group.count++;
		if (group.jobs.length < 5) group.jobs.push(r.jobId);
		errors.set(r.error, group);
	}
	const reported = new Set(reports.map((r) => r.jobId));
	const onBranch = input.servers.filter((s) => s.branch === input.branch);
	const stillOld = onBranch.filter((s) => s.seq !== undefined && s.seq < input.seq);
	const unknownSeq = onBranch.filter((s) => s.seq === undefined && !reported.has(s.jobId));
	const waiting = onBranch.filter((s) => !reported.has(s.jobId) && (s.seq === undefined || s.seq < input.seq)).map((s) => s.jobId);
	return {
		seq: input.seq,
		branch: input.branch,
		artifactId: input.artifactId,
		counts,
		reports: reports.length,
		errors: [...errors.values()].sort((a, b) => b.count - a.count),
		stillOld,
		unknownSeq,
		servers: onBranch.length,
		waiting,
		bad: (counts.failed ?? 0) + (counts.rolled_back ?? 0) > 0,
	};
}

/** "3 swapped, 1 failed, 2 skipped" (results in contract order, then anything else). */
export function formatCounts(counts: Record<string, number>): string {
	const keys = [...REPORT_RESULTS.filter((r) => counts[r]), ...Object.keys(counts).filter((k) => !(REPORT_RESULTS as readonly string[]).includes(k))];
	return keys.length ? keys.map((k) => `${counts[k]} ${k}`).join(", ") : "no reports";
}

export function formatAge(seconds: number | undefined): string {
	if (seconds === undefined || !Number.isFinite(seconds)) return "-";
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

/** The `typetorch servers` table: job, branch, artifact, seq, health, players, kernel, age (uptime), seen. */
export function formatServersTable(servers: ServerRow[], nowSeconds = Date.now() / 1000): string {
	const rows = [...servers]
		.sort((a, b) => (a.branch ?? "").localeCompare(b.branch ?? "") || (b.startedAt ?? 0) - (a.startedAt ?? 0))
		.map((s) => [
			s.jobId,
			`${s.branch ?? "?"}${s.serverType && s.serverType !== "public" ? ` (${s.serverType})` : ""}`,
			`${s.artifactId ?? "?"}${s.experiment ? " [A/B]" : ""}`,
			s.seq !== undefined ? `#${s.seq}` : "-",
			s.health ?? (s.schema === undefined ? "-" : "?"),
			s.players !== undefined ? `${s.players}/${s.maxPlayers ?? "?"}` : "-",
			s.kernelVersion ? `${s.kernelVersion}${s.schema === undefined ? " (old)" : ""}` : "-",
			formatAge(s.startedAt !== undefined ? nowSeconds - s.startedAt : undefined),
			formatAge(s.updatedAt !== undefined ? nowSeconds - s.updatedAt : undefined),
		]);
	return table(["job", "branch", "artifact", "seq", "health", "players", "kernel", "age", "seen"], rows);
}

/** A server row for JSON output (no access code, ever). */
export function serverJson(s: ServerRow, nowSeconds = Date.now() / 1000) {
	return { ...s, uptimeSeconds: s.startedAt !== undefined ? Math.round(nowSeconds - s.startedAt) : undefined, lastSeenSeconds: s.updatedAt !== undefined ? Math.round(nowSeconds - s.updatedAt) : undefined };
}

/** The exact command that rolls a branch back to what it ran before (no `#seq`: PowerShell reads `#` as a comment). */
export function rollbackCommand(branch: string, fromArtifactId?: string): string {
	return `typetorch rollback --branch ${branch}${fromArtifactId ? ` --to ${fromArtifactId}` : ""}`;
}

export interface RollbackDecision {
	/** Servers that reported failed or rolled_back for the seq. */
	failures: number;
	/** Servers that tried the seq (reports other than "skipped": a server outside a rollout never tried it). */
	answered: number;
	/** Live servers of the branch that haven't reported yet. */
	waiting: number;
	/** failures / answered, 0-1. */
	ratio: number;
	/** The threshold is met (at least one failure). */
	met: boolean;
	/** Met even if every waiting server succeeds: decide now. */
	early: boolean;
}

/** Whether a deploy's failures cross the auto-rollback threshold (percent of the servers that tried it). */
export function rollbackDecision(summary: FleetSummary, thresholdPercent: number): RollbackDecision {
	const failures = (summary.counts.failed ?? 0) + (summary.counts.rolled_back ?? 0);
	const answered = summary.reports - (summary.counts.skipped ?? 0);
	const waiting = summary.waiting.length;
	const ratio = answered > 0 ? failures / answered : 0;
	const met = failures >= 1 && ratio * 100 >= thresholdPercent;
	const early = failures >= 1 && (failures / (answered + waiting)) * 100 >= thresholdPercent;
	return { failures, answered, waiting, ratio, met, early };
}

export function formatAlert(alert: AlertRow): string {
	const when = alert.at !== undefined ? new Date(alert.at).toISOString().replace("T", " ").slice(0, 19) : "?";
	const where = [alert.branch, alert.seq !== undefined ? `#${alert.seq}` : undefined, alert.jobId ? alert.jobId.slice(0, 8) : undefined].filter(Boolean).join(" ");
	return `${when}  ${alert.level.padEnd(8)} ${alert.code.padEnd(16)} ${where ? `${where}  ` : ""}${alert.message ?? ""}${alert.acked ? " (acked)" : ""}`;
}
