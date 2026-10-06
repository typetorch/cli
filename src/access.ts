/**
 * The dev access list (typetorch.json `members`, `revoked`, `devBadgeId`) as the server-only ConfigService key
 * `TypeTorchAccess` (security audit 2026-10-06, plans/18).
 *
 * Why a key of its own: the registry key `TypeTorch` can only be written after a read (`config push` needs
 * universe:read, which API keys can't get), so typetorch.json's members never reached servers and only the creator
 * was a dev. This key is written blind with publishConfigKey (universe:write only), like `TypeTorchFleet`.
 * Why ConfigService and not a DataStore: any code in the universe (a backdoored free model) can write DataStores and
 * would add itself as an owner on every server; nothing in-game can write ConfigService.
 * Kernel 0.3.6+ (Access.luau) reads the key and, when it exists, takes its lists instead of the registry's.
 *
 * `access.json` in the state dir remembers what was last pushed (a hash, never the lists), so `deploy` and `doctor`
 * can warn when typetorch.json changed since (a revoked dev would still be a dev until the next push).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, Role } from "./config.ts";
import { isRecord } from "./json.ts";

export const ACCESS_CONFIG_KEY = "TypeTorchAccess";
export const ACCESS_RECORD = "access.json";

/** The published value (kernel Access.luau reads exactly these fields; `v` lets the shape change later). */
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
	configVersion?: number;
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

/** Whether there is anything to publish (an empty list needs no key: servers then fall back to the registry). */
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
		return { v: 1, universeId, sha256: raw.sha256, at: raw.at, ...(typeof raw.configVersion === "number" ? { configVersion: raw.configVersion } : {}) };
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
		return `typetorch.json lists ${counts}, but servers can't see them until they are published: run \`typetorch access push\` (ConfigService ${ACCESS_CONFIG_KEY}; kernel 0.3.6+). Until then only the experience creator is a dev`;
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
