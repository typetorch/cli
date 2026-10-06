/**
 * Kernel 0.3.6 ("never an empty server"): the backup build baked into the place.
 *
 * - Every payload the CLI uploads is kept locally, `<state dir>/payloads/<artifactId>.rbxm` (the exact bytes Roblox
 *   got), because API keys can't download assets. The newest PAYLOADS_KEPT stay.
 * - `typetorch kernel deploy` (both modes) bakes the current prod head's kept payload into the place as
 *   `ServerStorage.TypeTorchBackup`: the payload root (one Model, Folders and ModuleScripts only, Channel "prod") with
 *   the attributes BackupArtifactId, BackupSeq, BackupBranch, BackupChannel and BackupAt added. It is a kernel slot, so
 *   every patch replaces it (refreshed by each kernel deploy). Without a kept payload for the prod head nothing is
 *   baked: the place keeps the backup it has (if any), with a warning; `doctor` shows its artifact and age.
 * - Servers run it only when nothing else can run (the head, the last known good and a build other servers run fine all
 *   failed): plans/01 "Never an empty server".
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveHead } from "./deployments.ts";
import { isRecord } from "./json.ts";
import { branchChannel, strictest, type Channel } from "./naming.ts";
import { checkPayloadContents, RbxmError, readRbxm, setRootAttributes, type RbxmInstance } from "./rbxm.ts";
import type { SlotRef } from "./placepatch.ts";

export const PAYLOADS_DIR = "payloads";
/** Payloads kept in the state dir (oldest removed first; the newest upload is always kept). */
export const PAYLOADS_KEPT = 40;
/** Where the backup goes in the place (a kernel slot: the patch replaces it). */
export const BACKUP_SLOT: SlotRef = { service: "ServerStorage", name: "TypeTorchBackup" };
/** The stamped backup model written for the place build (in the game's .typetorch/). */
export const BACKUP_FILE = "backup.rbxm";
/** `doctor` warns when the place's backup is older than this many days. */
export const BACKUP_STALE_DAYS = 30;

/** A file name for an artifact id (ids are `[a-z0-9-]`; anything else is replaced). */
export function keptPayloadName(artifactId: string): string {
	return `${artifactId.replace(/[^A-Za-z0-9._-]/g, "_")}.rbxm`;
}

export function keptPayloadPath(stateDir: string, artifactId: string): string {
	return join(stateDir, PAYLOADS_DIR, keptPayloadName(artifactId));
}

/** The kept payload of `artifactId`, or undefined. */
export function findKeptPayload(stateDir: string, artifactId: string): string | undefined {
	const path = keptPayloadPath(stateDir, artifactId);
	return existsSync(path) ? path : undefined;
}

/**
 * Keeps an uploaded payload (`<state dir>/payloads/<artifactId>.rbxm`) and removes the oldest beyond `keep`. Never
 * throws: keeping it is a convenience for a later `kernel deploy`, and must not fail an upload. Returns the path, or
 * undefined when it couldn't be written.
 */
export function keepPayload(stateDir: string, artifactId: string, bytes: Uint8Array, keep = PAYLOADS_KEPT): string | undefined {
	try {
		const dir = join(stateDir, PAYLOADS_DIR);
		mkdirSync(dir, { recursive: true });
		const path = keptPayloadPath(stateDir, artifactId);
		writeFileSync(path, bytes);
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".rbxm"))
			.map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
			.sort((a, b) => b.at - a.at);
		for (const old of files.slice(keep)) {
			if (old.name !== keptPayloadName(artifactId)) unlinkSync(join(dir, old.name));
		}
		return path;
	} catch {
		return undefined;
	}
}

/** The head the backup is made from: the default branch's head when it is prod-channel, else the newest prod head. */
export function backupHead(
	config: { defaultBranch: string; channels: Record<string, Channel> },
	heads: Map<string, LiveHead>,
	registryChannels?: Record<string, Channel>,
): LiveHead | undefined {
	const prod = (branch: string) => strictest(branchChannel(config, branch), registryChannels?.[branch]) === "prod";
	const preferred = heads.get(config.defaultBranch);
	if (preferred && prod(config.defaultBranch)) return preferred;
	let best: LiveHead | undefined;
	for (const [branch, head] of heads) {
		if (prod(branch) && (!best || head.seq > best.seq)) best = head;
	}
	return best;
}

export class BackupError extends Error {
	override name = "BackupError";
}

export interface BackupInfo {
	artifactId: string;
	seq: number;
	branch: string;
	channel: Channel;
	/** ISO time the backup was baked (kernel deploy). */
	at: string;
}

/**
 * The backup model: the kept payload bytes with BackupArtifactId, BackupSeq, BackupBranch, BackupChannel and BackupAt
 * added to its root (everything else byte for byte). Refused (BackupError): not one Model root, anything but Folders
 * and ModuleScripts, a payload Channel other than "prod" (prod servers would refuse it at mount), or an ArtifactId that
 * isn't the head's.
 */
export function backupRbxm(bytes: Uint8Array, info: BackupInfo): Uint8Array {
	let contents;
	let instances: RbxmInstance[];
	try {
		contents = checkPayloadContents(bytes);
		instances = readRbxm(bytes);
	} catch (error) {
		throw new BackupError(`the kept payload can't be read: ${(error as Error).message}`);
	}
	if (contents.rootProblems.length) throw new BackupError(`the kept payload isn't a payload: ${contents.rootProblems.join("; ")}`);
	if (contents.disallowed.length) throw new BackupError(`the kept payload holds more than Folders and ModuleScripts: ${contents.disallowed.slice(0, 5).join(", ")}`);
	const byReferent = new Set(instances.map((i) => i.referent));
	const root = instances.find((i) => i.parent === -1 || !byReferent.has(i.parent))!;
	const attributes = root.attributes ?? {};
	if (attributes.Channel !== "prod") throw new BackupError(`the kept payload is ${String(attributes.Channel ?? "no")}-channel; the backup must be a prod build`);
	if (attributes.ArtifactId !== undefined && attributes.ArtifactId !== info.artifactId) {
		throw new BackupError(`the kept payload is artifact ${String(attributes.ArtifactId)}, not ${info.artifactId}`);
	}
	try {
		return setRootAttributes(bytes, {
			BackupArtifactId: info.artifactId,
			BackupSeq: info.seq,
			BackupBranch: info.branch,
			BackupChannel: info.channel,
			BackupAt: info.at,
		});
	} catch (error) {
		if (error instanceof RbxmError) throw new BackupError(`can't stamp the backup: ${error.message}`);
		throw error;
	}
}

/** The kernel place project with `ServerStorage.TypeTorchBackup` pointing at `modelPath` (a copy; the input is kept). */
export function addBackupToProject(project: unknown, modelPath: string): unknown {
	const copy = JSON.parse(JSON.stringify(project));
	if (!isRecord(copy) || !isRecord(copy.tree)) return copy;
	const tree = copy.tree as Record<string, unknown>;
	const service = isRecord(tree[BACKUP_SLOT.service]) ? (tree[BACKUP_SLOT.service] as Record<string, unknown>) : { $className: BACKUP_SLOT.service };
	service[BACKUP_SLOT.name] = { $path: modelPath.replace(/\\/g, "/") };
	tree[BACKUP_SLOT.service] = service;
	return copy;
}

/** A readable age ("3 h", "12 d") of an ISO time, or undefined. */
export function backupAge(at: string | undefined, now = Date.now()): { days: number; text: string } | undefined {
	if (!at) return undefined;
	const time = Date.parse(at);
	if (Number.isNaN(time)) return undefined;
	const seconds = Math.max(0, (now - time) / 1000);
	const days = seconds / 86400;
	const text = seconds < 3600 ? `${Math.round(seconds / 60)} min` : seconds < 86400 ? `${Math.round(seconds / 3600)} h` : `${Math.round(days)} d`;
	return { days, text };
}

/** The backup's attributes from a place summary script's result (doctor). */
export function backupFromPlace(value: unknown): Partial<BackupInfo> & { present: boolean; modules?: number } {
	if (!isRecord(value)) return { present: false };
	return {
		present: true,
		artifactId: typeof value.artifactId === "string" ? value.artifactId : undefined,
		seq: typeof value.seq === "number" ? value.seq : undefined,
		branch: typeof value.branch === "string" ? value.branch : undefined,
		channel: value.channel === "prod" || value.channel === "dev" ? value.channel : undefined,
		at: typeof value.at === "string" ? value.at : undefined,
		modules: typeof value.modules === "number" ? value.modules : undefined,
	};
}

/** Reads a kept payload (undefined when missing). */
export function readKeptPayload(stateDir: string, artifactId: string): Uint8Array | undefined {
	const path = findKeptPayload(stateDir, artifactId);
	return path ? new Uint8Array(readFileSync(path)) : undefined;
}
