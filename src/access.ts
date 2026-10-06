/**
 * The dev access list (typetorch.json `members`, `revoked`, `devBadgeId`), as `typetorch access push` writes it into
 * the signed settings record's `access` field (kernel 0.3.8, plans/20). The record is signed with both prod keys, so
 * in-universe code (which can write DataStores) can't add itself as an owner. (CLI 0.7.3-0.7.5 wrote the ConfigService
 * key TypeTorchAccess for kernels 0.3.6-0.3.7.)
 *
 * `access.json` in the state dir remembers what was last pushed (a hash, never the lists), so `deploy` and `doctor`
 * can warn when typetorch.json changed since (a revoked dev would still be a dev until the next push).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, Role } from "./config.ts";
import { isRecord } from "./json.ts";

export const ACCESS_RECORD = "access.json";

/** The lists (kernel Access.luau reads members, revoked and devBadgeId from settings.access). */
export interface AccessValue {
	v: 1;
	members: Record<string, Role>;
	revoked: Record<string, true>;
	devBadgeId: number | null;
}

/** What was pushed last (never the lists themselves). */
export interface AccessRecord {
	v: 1;
	universeId: number;
	sha256: string;
	at: string;
	/** CLI 0.7.x: the ConfigService config version of the push. */
	configVersion?: number;
	/** CLI 0.8: the settings record's seq written by the push. */
	settingsSeq?: number;
}

/** The value for a project's typetorch.json, with sorted keys (stable hashes). */
export function accessValue(config: Pick<ProjectConfig, "members" | "revoked" | "devBadgeId">): AccessValue {
	const sortedKeys = (keys: string[]) => [...keys].sort((a, b) => (a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length));
	const members: Record<string, Role> = {};
	for (const id of sortedKeys(Object.keys(config.members))) members[id] = config.members[id];
	const revoked: Record<string, true> = {};
	for (const id of sortedKeys(Object.keys(config.revoked ?? {}))) if (config.revoked?.[id]) revoked[id] = true;
	return { v: 1, members, revoked, devBadgeId: config.devBadgeId ?? null };
}

/** Whether typetorch.json lists anyone (with nothing listed, only the experience creator is a dev). */
export function accessConfigured(value: AccessValue): boolean {
	return Object.keys(value.members).length > 0 || Object.keys(value.revoked).length > 0 || value.devBadgeId !== null;
}

/** SHA-256 of the canonical JSON (the value already has sorted keys). */
export function accessHash(value: AccessValue): string {
	return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function readAccessRecord(stateDir: string, universeId: number): AccessRecord | undefined {
	const path = join(stateDir, ACCESS_RECORD);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw) || raw.v !== 1 || raw.universeId !== universeId || typeof raw.sha256 !== "string" || typeof raw.at !== "string") return undefined;
		return {
			v: 1,
			universeId,
			sha256: raw.sha256,
			at: raw.at,
			...(typeof raw.configVersion === "number" ? { configVersion: raw.configVersion } : {}),
			...(typeof raw.settingsSeq === "number" ? { settingsSeq: raw.settingsSeq } : {}),
		};
	} catch {
		return undefined;
	}
}

export function writeAccessRecord(stateDir: string, record: AccessRecord): void {
	mkdirSync(stateDir, { recursive: true });
	const path = join(stateDir, ACCESS_RECORD);
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`);
	renameSync(temp, path);
}

export interface AccessStatus {
	value: AccessValue;
	sha256: string;
	/** typetorch.json lists members, revoked users or a badge. */
	configured: boolean;
	/** This machine pushed the key at least once (access.json). */
	published: boolean;
	/** typetorch.json changed since the last push. */
	stale: boolean;
	record?: AccessRecord;
}

export function accessStatus(config: Pick<ProjectConfig, "members" | "revoked" | "devBadgeId" | "universeId">, stateDir: string): AccessStatus {
	const value = accessValue(config);
	const sha256 = accessHash(value);
	const record = readAccessRecord(stateDir, config.universeId);
	return {
		value,
		sha256,
		configured: accessConfigured(value),
		published: record !== undefined,
		stale: record !== undefined && record.sha256 !== sha256,
		...(record ? { record } : {}),
	};
}

/** One line for `deploy` and `doctor`, or undefined when nothing is wrong. */
export function accessWarning(status: AccessStatus): string | undefined {
	if (!status.configured) return undefined;
	const counts = describeAccess(status.value);
	if (!status.published) {
		return `typetorch.json lists ${counts}, but servers can't see them until they are pushed: run \`typetorch access push\` (the signed settings record; kernel 0.3.8+). Until then only the experience creator is a dev`;
	}
	if (status.stale) {
		return `typetorch.json's members/revoked/devBadgeId changed since the last \`typetorch access push\` (${status.record?.at ?? "?"}): run it again, or servers keep the old lists (a revoked dev stays a dev)`;
	}
	return undefined;
}

export function describeAccess(value: AccessValue): string {
	const members = Object.keys(value.members).length;
	const owners = Object.values(value.members).filter((role) => role === "owner").length;
	const revoked = Object.keys(value.revoked).length;
	const parts = [`${members} member${members === 1 ? "" : "s"}${members ? ` (${owners} owner${owners === 1 ? "" : "s"})` : ""}`];
	if (revoked) parts.push(`${revoked} revoked`);
	if (value.devBadgeId !== null) parts.push(`dev badge ${value.devBadgeId}`);
	return parts.join(", ");
}
