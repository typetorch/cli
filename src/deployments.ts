/**
 * Deployment history from two sources: the registry (when the configs API is usable) and the local log
 * `deployments.jsonl` in the state dir (state.ts; one JSON line per published deploy/rollback/promote). Game servers
 * persist the newest head they hear about, so a branch's live head is its highest entry in either source, ordered by
 * (seq, time).
 *
 * `uploads.jsonl` in the same dir records every payload upload ("uploaded", written before anything is published), so
 * an approved asset whose publish failed can still be promoted (`typetorch promote`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestSummary } from "./cloudtest.ts";
import { dim, green, table } from "./log.ts";
import { parseArtifactId, type BuildSources, type Channel } from "./naming.ts";
import type { RegistryDeployment, RegistryValue } from "./registry.ts";

export const LOCAL_LOG = "deployments.jsonl";
export const UPLOAD_LOG = "uploads.jsonl";

export interface LocalDeployment extends RegistryDeployment {
	universeId?: number;
	project?: string;
	assetName?: string;
	/** sha256 of the payload bytes (recorded since revisions were added; older entries lack it). */
	sha256?: string;
	message?: string;
	/** What happened to the registry for this entry. */
	registry?: "published" | "unchanged" | "unavailable" | "failed" | "skipped";
	configVersion?: number;
	timings?: Record<string, number>;
	/** The payload Notes change lines. */
	changes?: string[];
	/** The proposal this release came from (`typetorch approve`). */
	proposalId?: string;
	/** Who prepared it: "cli", "dev-server/claude", "agent", "ci"... */
	proposedBy?: string;
	/** The pre-publish gate (`typetorch test --cloud`): passed, or skipped with the reason. */
	test?: TestSummary;
	/** Dev-channel rollout % sent as the message's `ro` (`--rollout`); widened later with `deploy --widen`. */
	rollout?: number;
	/** The payload's ProtocolHash attribute (protocol.ts), when it had one. */
	protocolHash?: string;
	/** An automatic rollback (--wait): why, and the deploy it undid. */
	autoRollback?: { reason: string; fromSeq: number; fromArtifactId: string };
	/** Where the seq came from (seqstore.ts): the DataStore counter, the shared sources read, or this machine only. */
	seqSource?: "counter" | "read" | "local";
	/**
	 * "published": the deploy message went out. "registry-only": the registry was written but the message failed (the
	 * seq is used; servers still pick the head up from the registry).
	 */
	event?: "published" | "registry-only";
}

function readJsonLines<T>(file: string, keep: (entry: any) => boolean): T[] {
	if (!existsSync(file)) return [];
	const entries: T[] = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			const entry = JSON.parse(line);
			if (keep(entry)) entries.push(entry as T);
		} catch {
			// A torn line (crash mid-write) is skipped.
		}
	}
	return entries;
}

function appendJsonLine(file: string, entry: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** The deployments in `dir` (the state dir), optionally only those of one universe. */
export function readLocalLog(dir: string, universeId?: number): LocalDeployment[] {
	return readJsonLines<LocalDeployment>(
		join(dir, LOCAL_LOG),
		(entry) =>
			typeof entry?.seq === "number" &&
			typeof entry?.branch === "string" &&
			(universeId === undefined || entry.universeId === undefined || entry.universeId === universeId),
	);
}

export function appendLocalLog(dir: string, entry: LocalDeployment, event: NonNullable<LocalDeployment["event"]> = "published") {
	appendJsonLine(join(dir, LOCAL_LOG), { ...entry, event });
}

/** One uploaded payload asset (written right after moderation, before any registry write or deploy message). */
export interface UploadRecord {
	event: "uploaded";
	at: string;
	artifactId: string;
	assetId: number;
	/** Roblox's moderation state when the upload finished: only "Approved" can be published. */
	moderation: string;
	/** The branch it was built for (it can be promoted to others). */
	branch: string;
	channel: Channel;
	commit: string;
	commitHash: string;
	dirty: boolean;
	sha256: string;
	sources?: BuildSources;
	/** The payload Notes (message + change lines), for proposals made from this upload. */
	message?: string;
	changes?: string[];
	bytes?: number;
	builtAt?: string;
	assetName?: string;
	universeId?: number;
	project?: string;
	by?: string;
	/** The payload's ProtocolHash (protocol.ts). */
	protocolHash?: string;
}

export function readUploads(dir: string, universeId?: number): UploadRecord[] {
	return readJsonLines<UploadRecord>(
		join(dir, UPLOAD_LOG),
		(entry) =>
			entry?.event === "uploaded" &&
			typeof entry?.assetId === "number" &&
			typeof entry?.artifactId === "string" &&
			(universeId === undefined || entry.universeId === undefined || entry.universeId === universeId),
	);
}

export function appendUpload(dir: string, record: Omit<UploadRecord, "event" | "at">): UploadRecord {
	const full: UploadRecord = { event: "uploaded", at: new Date().toISOString(), ...record };
	appendJsonLine(join(dir, UPLOAD_LOG), full);
	return full;
}

/** Uploads that were never published to any branch (the deploy failed after the upload, or `typetorch upload`). */
export function unpublishedUploads(uploads: UploadRecord[], rows: RegistryDeployment[]): UploadRecord[] {
	const published = new Set(rows.map((d) => d.assetId));
	const seen = new Set<number>();
	return uploads.filter((u) => {
		if (published.has(u.assetId) || seen.has(u.assetId)) return false;
		seen.add(u.assetId);
		return true;
	});
}

export interface DeploymentRow extends LocalDeployment {
	source: "registry" | "local" | "both";
}

function rowKey(d: RegistryDeployment): string {
	return `${d.seq}|${d.branch}|${d.assetId}|${d.action}`;
}

/** (seq, time) order: seq first, then the time (ISO strings compare correctly). */
export function compareDeployments(a: { seq: number; at?: string }, b: { seq: number; at?: string }): number {
	return a.seq - b.seq || (a.at ?? "").localeCompare(b.at ?? "");
}

/** Registry and local entries merged (the registry's copy wins), oldest first by (seq, time). */
export function mergeDeployments(registry: RegistryDeployment[], local: LocalDeployment[]): DeploymentRow[] {
	const rows = new Map<string, DeploymentRow>();
	for (const d of local) rows.set(rowKey(d), { ...d, source: "local" });
	for (const d of registry) {
		const key = rowKey(d);
		const existing = rows.get(key);
		rows.set(key, existing ? { ...existing, ...d, source: "both" } : { ...d, source: "registry" });
	}
	return [...rows.values()].sort(compareDeployments);
}

export interface LiveHead {
	branch: string;
	seq: number;
	assetId: number;
	artifactId: string;
	channel: RegistryDeployment["channel"];
	commit: string;
	commitHash: string;
	deployedAt: string;
	by: string;
	dirty?: boolean;
	sources?: BuildSources;
	/** The deployed payload's ProtocolHash, from the local log (protocol.ts). */
	protocolHash?: string;
}

/** Each branch's live head: the highest (seq, time) among the registry heads and every known deployment. */
export function liveHeads(registry: RegistryValue | undefined, rows: RegistryDeployment[]): Map<string, LiveHead> {
	const heads = new Map<string, LiveHead>();
	const offer = (head: LiveHead) => {
		const current = heads.get(head.branch);
		if (!current || compareDeployments({ seq: head.seq, at: head.deployedAt }, { seq: current.seq, at: current.deployedAt }) > 0) {
			heads.set(head.branch, head);
		}
	};
	for (const [branch, head] of Object.entries(registry?.branches ?? {})) {
		if (!head || typeof head.assetId !== "number") continue;
		offer({ branch, ...head, seq: typeof head.seq === "number" ? head.seq : 0 });
	}
	for (const d of rows) {
		offer({
			branch: d.branch,
			seq: d.seq,
			assetId: d.assetId,
			artifactId: d.artifactId,
			channel: d.channel,
			commit: d.commit,
			commitHash: d.commitHash,
			deployedAt: d.at,
			by: d.by,
			dirty: d.dirty,
			sources: d.sources,
			...((d as LocalDeployment).protocolHash ? { protocolHash: (d as LocalDeployment).protocolHash } : {}),
		});
	}
	return heads;
}

/** One above the highest seq known anywhere (registry when readable, local log). */
export function nextSeqFrom(registry: RegistryValue | undefined, local: RegistryDeployment[]): number {
	let highest = 0;
	for (const d of registry?.deployments ?? []) if (typeof d.seq === "number") highest = Math.max(highest, d.seq);
	for (const head of Object.values(registry?.branches ?? {})) if (typeof head?.seq === "number") highest = Math.max(highest, head.seq);
	for (const d of local) highest = Math.max(highest, d.seq);
	return highest + 1;
}

/**
 * Finds an artifact by `#seq`, payload asset id (8+ digits), artifact id (exact, then a prefix of 7+ characters,
 * so `12b63b9-3f` works), or commit prefix (4+ hex chars). Old and new id formats both match. Searches newest first,
 * entries of `preferBranch` before others.
 */
export function matchDeployment<T extends { seq: number; at?: string; branch: string; assetId: number; artifactId: string; commit?: string; commitHash?: string }>(
	rows: T[],
	wanted: string,
	preferBranch?: string,
): T | undefined {
	const text = wanted.trim();
	if (text === "") return undefined;
	const ordered = [...rows].sort((a, b) => {
		const pa = a.branch === preferBranch ? 1 : 0;
		const pb = b.branch === preferBranch ? 1 : 0;
		return pb - pa || compareDeployments(b, a);
	});
	if (text.startsWith("#")) {
		const seq = Number(text.slice(1));
		return ordered.find((d) => d.seq === seq);
	}
	if (/^\d{8,}$/.test(text)) {
		const byAsset = ordered.find((d) => String(d.assetId) === text);
		if (byAsset) return byAsset;
	}
	const lower = text.toLowerCase();
	const byArtifact = ordered.find((d) => d.artifactId === lower);
	if (byArtifact) return byArtifact;
	if (lower.length >= 7 && lower.includes("-")) {
		const byPrefix = ordered.find((d) => d.artifactId.startsWith(lower));
		if (byPrefix) return byPrefix;
	}
	if (/^[0-9a-f]{4,40}$/.test(lower)) {
		return ordered.find(
			(d) =>
				d.commitHash?.toLowerCase().startsWith(lower) ||
				d.commit?.toLowerCase().startsWith(lower) ||
				parseArtifactId(d.artifactId).commit?.startsWith(lower),
		);
	}
	return undefined;
}

/** The newest deployment on `branch` whose artifact differs from the head's. */
export function previousDifferent<T extends RegistryDeployment>(rows: T[], branch: string, head: { artifactId: string; assetId: number }): T | undefined {
	return [...rows]
		.filter((d) => d.branch === branch && d.artifactId !== head.artifactId && d.assetId !== head.assetId)
		.sort((a, b) => compareDeployments(b, a))[0];
}

function time(iso: string): string {
	return iso ? iso.replace("T", " ").slice(0, 19) : "";
}

/** "just now", "12m ago", "5h ago" for the last day; "" for older or unknown times. */
export function ago(iso: string, now = Date.now()): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return "";
}

/**
 * The `typetorch deployments` table. `*` marks each branch's live head. `channelOf` (CLI 0.8.1, the kernel 0.3.9 rule):
 * the channel column is what the BRANCH is (prod: the default branch or one configured prod; every other branch dev),
 * with the build's own channel in brackets when it differs ("dev (prod build)"); without it, the build's channel.
 */
export function formatDeploymentsTable(rows: DeploymentRow[], heads: Map<string, LiveHead>, now = Date.now(), channelOf?: (branch: string) => Channel): string {
	const body = rows.map((d) => {
		const live = heads.get(d.branch);
		const isLive = live !== undefined && live.seq === d.seq && live.assetId === d.assetId;
		const git = `${d.branch}@${d.commit || "uncommitted"}${d.dirty ? "*" : ""}`;
		const action = (d.action === "rollback" || d.action === "promote") && d.fromArtifactId ? `${d.action} (from ${d.fromArtifactId})` : d.action;
		const channel = channelOf ? channelOf(d.branch) : d.channel;
		const build = channelOf && d.channel && d.channel !== channel ? ` (${d.channel} build)` : "";
		return [
			isLive ? "*" : " ",
			`#${d.seq}`,
			ago(d.at, now) ? `${time(d.at)} ${dim(`(${ago(d.at, now)})`)}` : time(d.at),
			channel === "prod" ? `${green(channel)}${build}` : `${channel ?? ""}${build}`,
			channel === "prod" ? `${green(d.branch)}${git.slice(d.branch.length)}` : git,
			d.artifactId,
			String(d.assetId),
			d.source === "local" ? `${action} [local]` : action,
		];
	});
	return table([" ", "#", "time (UTC)", "channel", "branch@commit", "artifact", "asset", "action"], body);
}
