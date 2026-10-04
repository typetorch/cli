/**
 * Deployment history from two sources: the registry (when the configs API is usable) and the local log
 * `.typetorch/deployments.jsonl` (one JSON line per deploy/rollback made from this machine). Game servers persist the
 * newest head they hear about (higher seq wins), so a branch's live head is its highest-seq entry in either source.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { table } from "./log";
import type { RegistryDeployment, RegistryValue } from "./registry";

export const LOCAL_LOG = ".typetorch/deployments.jsonl";

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
}

export function readLocalLog(root: string, universeId?: number): LocalDeployment[] {
	const file = join(root, LOCAL_LOG);
	if (!existsSync(file)) return [];
	const entries: LocalDeployment[] = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		try {
			const entry = JSON.parse(line) as LocalDeployment;
			if (typeof entry.seq !== "number" || typeof entry.branch !== "string") continue;
			if (universeId !== undefined && entry.universeId !== undefined && entry.universeId !== universeId) continue;
			entries.push(entry);
		} catch {
			// A torn line (crash mid-write) is skipped.
		}
	}
	return entries;
}

export function appendLocalLog(root: string, entry: LocalDeployment) {
	const file = join(root, LOCAL_LOG);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, JSON.stringify(entry) + "\n");
}

export interface DeploymentRow extends LocalDeployment {
	source: "registry" | "local" | "both";
}

function rowKey(d: RegistryDeployment): string {
	return `${d.seq}|${d.branch}|${d.assetId}|${d.action}`;
}

/** Registry and local entries merged (the registry's copy wins), oldest first. */
export function mergeDeployments(registry: RegistryDeployment[], local: LocalDeployment[]): DeploymentRow[] {
	const rows = new Map<string, DeploymentRow>();
	for (const d of local) rows.set(rowKey(d), { ...d, source: "local" });
	for (const d of registry) {
		const key = rowKey(d);
		const existing = rows.get(key);
		rows.set(key, existing ? { ...existing, ...d, source: "both" } : { ...d, source: "registry" });
	}
	return [...rows.values()].sort((a, b) => a.seq - b.seq || a.at.localeCompare(b.at));
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
}

/** Each branch's live head: the highest seq among the registry heads and every known deployment. */
export function liveHeads(registry: RegistryValue | undefined, rows: RegistryDeployment[]): Map<string, LiveHead> {
	const heads = new Map<string, LiveHead>();
	const offer = (head: LiveHead) => {
		const current = heads.get(head.branch);
		if (!current || head.seq > current.seq) heads.set(head.branch, head);
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
 * Finds a deployment by `#seq`, payload asset id (8+ digits), artifact id, or commit prefix (4+ hex chars).
 * Searches newest first, entries of `preferBranch` before others.
 */
export function matchDeployment<T extends RegistryDeployment>(rows: T[], wanted: string, preferBranch?: string): T | undefined {
	const text = wanted.trim();
	if (text === "") return undefined;
	const ordered = [...rows].sort((a, b) => {
		const pa = a.branch === preferBranch ? 1 : 0;
		const pb = b.branch === preferBranch ? 1 : 0;
		return pb - pa || b.seq - a.seq;
	});
	if (text.startsWith("#")) {
		const seq = Number(text.slice(1));
		return ordered.find((d) => d.seq === seq);
	}
	if (/^\d{8,}$/.test(text)) {
		const byAsset = ordered.find((d) => String(d.assetId) === text);
		if (byAsset) return byAsset;
	}
	const byArtifact = ordered.find((d) => d.artifactId === text);
	if (byArtifact) return byArtifact;
	if (/^[0-9a-f]{4,40}$/i.test(text)) {
		const lower = text.toLowerCase();
		return ordered.find((d) => d.commitHash?.toLowerCase().startsWith(lower) || d.commit?.toLowerCase().startsWith(lower));
	}
	return undefined;
}

/** The newest deployment on `branch` whose artifact differs from the head's. */
export function previousDifferent<T extends RegistryDeployment>(rows: T[], branch: string, head: { artifactId: string; assetId: number }): T | undefined {
	return [...rows]
		.filter((d) => d.branch === branch && d.artifactId !== head.artifactId && d.assetId !== head.assetId)
		.sort((a, b) => b.seq - a.seq)[0];
}

function time(iso: string): string {
	return iso ? iso.replace("T", " ").slice(0, 19) : "";
}

/** The `typetorch deployments` table. `*` marks each branch's live head. */
export function formatDeploymentsTable(rows: DeploymentRow[], heads: Map<string, LiveHead>): string {
	const body = rows.map((d) => {
		const live = heads.get(d.branch);
		const isLive = live !== undefined && live.seq === d.seq && live.assetId === d.assetId;
		const git = `${d.branch}@${d.commit || "uncommitted"}${d.dirty ? "*" : ""}`;
		const action = d.action === "rollback" && d.fromArtifactId ? `rollback (from ${d.fromArtifactId})` : d.action;
		return [
			isLive ? "*" : " ",
			`#${d.seq}`,
			time(d.at),
			d.channel ?? "",
			git,
			d.artifactId,
			String(d.assetId),
			d.source === "local" ? `${action} [local]` : action,
		];
	});
	return table([" ", "seq", "time (UTC)", "channel", "branch@commit", "artifact", "asset", "action"], body);
}
