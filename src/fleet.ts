/**
 * Fleet visibility (plans/12 P-O1, reader side): the kernel's heartbeats and per-deploy reports in MemoryStore, read
 * with the Open Cloud MemoryStore API (`GET /cloud/v2/universes/{u}/memory-store/sorted-maps/{map}/items`, pages of
 * up to 100, CEL filter on `id` with `<`, `>` and `&&`; scope `memory-store.sorted-map:read`, on the deploy key).
 *
 * Contract (fixed with the kernel agent):
 *   TypeTorchServers  key = JobId, TTL 150 s
 *     {t serverType, b branch, c channel, a artifact id, n players, m max players, s startedAt, u last write (unix),
 *      p placeId, k? access code, x? experiment (1), v kernel version, q applied seq, g generation,
 *      h health "ok"|"failed"|"unverified"|"degraded", e? last error, sv = 2}
 *     (older servers write the same without q, g, h, e, sv)
 *   TypeTorchReports  key = `<seq, 10 digits>/<JobId>`, TTL 7 days
 *     {s seq, b branch, a artifact id, j JobId, r "swapped"|"failed"|"rolled_back"|"skipped"|"booted", e? error,
 *      d? seconds, t unix, g generation, k kernel version, p players}
 * Reserved-server access codes (`k`) are never printed or emitted: only whether a server has one.
 */
import { ApiError, type OpenCloud } from "./opencloud.ts";
import { table } from "./log.ts";

export const SERVERS_MAP = "TypeTorchServers";
export const REPORTS_MAP = "TypeTorchReports";
export const FLEET_SCOPE = "memory-store.sorted-map:read";
/** Stop reading after this many items (a huge fleet still answers; the summary says it was cut). */
export const MAX_ITEMS = 5000;

export class FleetScopeError extends Error {
	override name = "FleetScopeError";
	constructor(readonly status: number) {
		super(`the deploy key (OPENCLOUD_DEPLOY_KEY or the shared key) can't read MemoryStore (${status}): add ${FLEET_SCOPE} for this experience to it (Creator Hub > Open Cloud > API Keys)`);
	}
}

export interface SortedMapItem {
	id: string;
	value: unknown;
	expireTime?: string;
}

/** Every item of a sorted map (optionally filtered), paging with maxPageSize 100. A missing map is empty. */
export async function listSortedMap(
	oc: Pick<OpenCloud, "request">,
	universeId: number,
	map: string,
	options: { filter?: string; maxItems?: number } = {},
): Promise<{ items: SortedMapItem[]; truncated: boolean }> {
	const items: SortedMapItem[] = [];
	const maxItems = options.maxItems ?? MAX_ITEMS;
	let pageToken: string | undefined;
	while (true) {
		// encodeURIComponent, not URLSearchParams: a space must travel as %20, not "+".
		const query = ["maxPageSize=100", ...(options.filter ? [`filter=${encodeURIComponent(options.filter)}`] : []), ...(pageToken ? [`pageToken=${encodeURIComponent(pageToken)}`] : [])].join("&");
		const path = `/cloud/v2/universes/${universeId}/memory-store/sorted-maps/${encodeURIComponent(map)}/items?${query}`;
		const response = await oc.request("GET", path);
		if (response.status === 401 || response.status === 403) throw new FleetScopeError(response.status);
		if (response.status === 404) return { items, truncated: false };
		if (!response.ok) throw new ApiError("GET", path, response.status, response.body, response.text);
		// The v2 API names the list `items`; the beta named it `memoryStoreSortedMapItems`.
		const page: unknown[] = Array.isArray(response.body?.items) ? response.body.items : Array.isArray(response.body?.memoryStoreSortedMapItems) ? response.body.memoryStoreSortedMapItems : [];
		for (const raw of page) {
			const entry = raw as Record<string, unknown>;
			const id = typeof entry?.id === "string" ? entry.id : typeof entry?.path === "string" ? decodeURIComponent(entry.path.split("/").pop() ?? "") : undefined;
			if (!id) continue;
			items.push({ id, value: decodeValue(entry.value), ...(typeof entry.expireTime === "string" ? { expireTime: entry.expireTime } : {}) });
			if (items.length >= maxItems) return { items, truncated: true };
		}
		pageToken = typeof response.body?.nextPageToken === "string" && response.body.nextPageToken ? response.body.nextPageToken : undefined;
		if (!pageToken) return { items, truncated: false };
	}
}

/** A value written as a table comes back as a JSON object; one written as a JSON string is decoded too. */
function decodeValue(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

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
	/** The applied seq (sv 2). */
	seq?: number;
	generation?: number;
	health?: Health;
	error?: string;
	/** 2, or undefined for older kernels. */
	schema?: number;
}

export function parseServer(item: SortedMapItem): ServerRow | undefined {
	const v = item.value as Record<string, unknown> | undefined;
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const health = str(v.h);
	return {
		jobId: item.id,
		serverType: str(v.t),
		branch: str(v.b),
		channel: str(v.c),
		artifactId: str(v.a),
		players: num(v.n),
		maxPlayers: num(v.m),
		startedAt: num(v.s),
		updatedAt: num(v.u),
		placeId: num(v.p),
		accessCode: v.k !== undefined && v.k !== null && v.k !== "",
		experiment: v.x === 1 || v.x === true,
		kernelVersion: str(v.v),
		seq: num(v.q),
		generation: num(v.g),
		health: health && (HEALTH as readonly string[]).includes(health) ? (health as Health) : undefined,
		error: str(v.e),
		schema: num(v.sv),
	};
}

export type ReportResult = "swapped" | "failed" | "rolled_back" | "skipped" | "booted";
export const REPORT_RESULTS: readonly ReportResult[] = ["swapped", "failed", "rolled_back", "skipped", "booted"];

export interface ReportRow {
	key: string;
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

export function parseReport(item: SortedMapItem): ReportRow | undefined {
	const v = item.value as Record<string, unknown> | undefined;
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const [seqPart, jobPart] = item.id.split("/");
	const seq = num(v.s) ?? num(seqPart);
	const jobId = str(v.j) ?? jobPart;
	if (seq === undefined || !jobId) return undefined;
	return {
		key: item.id,
		seq,
		branch: str(v.b),
		artifactId: str(v.a),
		jobId,
		result: str(v.r) ?? "unknown",
		error: str(v.e),
		seconds: num(v.d),
		at: num(v.t),
		generation: num(v.g),
		kernelVersion: str(v.k),
		players: num(v.p),
	};
}

/** The report keys of one seq: `0000000042/<JobId>`. */
export function reportPrefix(seq: number): string {
	return `${String(seq).padStart(10, "0")}/`;
}

/** CEL filter for one seq's reports (`/` < JobId characters < `~`). */
export function reportFilter(seq: number): string {
	const prefix = reportPrefix(seq);
	return `id > "${prefix}" && id < "${prefix}~"`;
}

export async function readServers(oc: Pick<OpenCloud, "request">, universeId: number): Promise<{ servers: ServerRow[]; truncated: boolean }> {
	const { items, truncated } = await listSortedMap(oc, universeId, SERVERS_MAP);
	return { servers: items.map(parseServer).filter((s): s is ServerRow => s !== undefined), truncated };
}

export async function readReports(oc: Pick<OpenCloud, "request">, universeId: number, seq: number): Promise<{ reports: ReportRow[]; truncated: boolean }> {
	const { items, truncated } = await listSortedMap(oc, universeId, REPORTS_MAP, { filter: reportFilter(seq) });
	const reports = items.map(parseReport).filter((r): r is ReportRow => r !== undefined && r.seq === seq);
	return { reports, truncated };
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
