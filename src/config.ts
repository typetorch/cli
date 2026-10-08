/**
 * `typetorch.json`: the game repo's TypeTorch settings. The CLI looks for it in the working directory and its
 * parents; the folder holding it is the project root that every other path is relative to.
 *
 * {
 *   "project": "my-game",
 *   "universeId": 123, "placeId": 456,
 *   "creator": { "groupId": 789 },            // or { "userId": 1 }: must own the experience (LoadAsset)
 *   "defaultBranch": "prod",
 *   "branches": { "main": "prod" },           // git branch -> TypeTorch branch
 *   "channels": { "prod": "prod" },           // TypeTorch branch -> channel (unlisted: prod for defaultBranch, else dev)
 *   "members": { "123456789": "owner" },      // userId -> owner | dev
 *   "revoked": { "123": true },               // optional
 *   "devBadgeId": null,
 *   "kernel": "node_modules/@typetorch/kernel", // optional, folder with place.project.json
 *   "approval": "all",                          // "all" (default) | "prod" | "none": which deploys need `typetorch approve`
 *   // Prod signing (CLI 0.5, plans/03 "Signed prod messages and heads"), written by `typetorch keys ...`:
 *   "signingPublicKeys": ["<base64>"],          // trusted main public keys = the key asset's PublicKeys
 *   "revokedKeys": ["<base64>"],                // = the key asset's RevokedKeys (optional)
 *   "fallbackPublicKey": "<base64>",            // the fallback key; kernel deploy stamps it as FallbackPublicKey
 *   "keyAssetId": 123,                           // the key asset; kernel deploy stamps it as KeyAssetId
 *   // The TypeTorch backend (`typetorch backend setup` writes it; CLI 0.8 called it "fleet", still read with a warning):
 *   "backend": { "url": "https://backend.example.com" },
 *   // Safety thresholds (health.ts; kernel 0.3.7), all optional:
 *   "health": { "errors": 3, "window": 30, "rollback": true, "dev": { "rollback": false } }, // stamped on each build
 *   "autoRollback": { "failedPct": 20 },         // deploy --wait rolls the branch back at this % of failed servers
 *   // The backup build in the place (kernel 0.3.6, refreshed by the luau engine; commands/backup.ts):
 *   "backup": { "refresh": "auto", "healthyHours": 3 } // "off": only kernel deploy / typetorch backup refresh
 * }
 * Secrets never go here: they live in the game repo's `.env` (env.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateAutoRollback, validateHealth, type AutoRollbackConfig, type HealthConfig } from "./health.ts";
import { isRecord, removeJsonField, setJsonFields } from "./json.ts";
import { branchNameError, isChannel, type Channel } from "./naming.ts";
import { isTestVectorKey, publicKeyError, publicKeyListProblems } from "./signing.ts";

export const CONFIG_FILE = "typetorch.json";
/** Kernel 0.3.4 / framework 0.3.2: two roles (CLI 0.9 refuses the old "admin"; 0.7.x-0.8.x read it as dev). */
export const ROLES = ["owner", "dev"] as const;
export type Role = (typeof ROLES)[number];

export interface ProjectConfig {
	project: string;
	universeId: number;
	placeId: number;
	creator: { groupId: number } | { userId: number };
	defaultBranch: string;
	branches: Record<string, string>;
	channels: Record<string, Channel>;
	members: Record<string, Role>;
	revoked?: Record<string, true>;
	devBadgeId: number | null;
	kernel?: string;
	/** Which deploys a person must approve (`typetorch approve`): every one, prod-channel branches, or none. */
	approval: ApprovalPolicy;
	/** Trusted main public keys (base64): the key asset's PublicKeys. Written by `keys init` / `keys rotate`. */
	signingPublicKeys?: string[];
	/** Revoked public keys (main or fallback): the key asset's RevokedKeys. */
	revokedKeys?: string[];
	/** The fallback public key (`keys init --fallback`); stamped on the kernel as FallbackPublicKey. */
	fallbackPublicKey?: string;
	/** The key asset (`keys init`); stamped on the kernel as KeyAssetId. */
	keyAssetId?: number;
	/**
	 * The TypeTorch backend (fleet: heartbeats, deploy reports, alerts; analytics; the owner list), what the CLI talks
	 * to. `typetorch backend setup` writes it. The keys come from the game repo's .env (backend.ts).
	 */
	backend?: { url: string };
	/** The health window's thresholds, stamped on every build (health.ts; kernel 0.3.7 reads them). */
	health?: HealthConfig;
	/** deploy --wait's auto-rollback threshold (health.ts). */
	autoRollback?: AutoRollbackConfig;
	/** The backup build's refresh (commands/backup.ts): after a prod deploy, the previous build once proven healthy. */
	backup?: BackupConfig;
}

/** typetorch.json "backup". */
export interface BackupConfig {
	/** "auto" (default): a prod deploy or promote at your terminal refreshes the place's backup to the previous build. */
	refresh: "auto" | "off";
	/** How long the previous build must have run with no failure before it becomes the backup (hours, default 3). */
	healthyHours: number;
}

export const BACKUP_DEFAULTS: BackupConfig = { refresh: "auto", healthyHours: 3 };

/** Validates typetorch.json "backup": { refresh: "auto" | "off", healthyHours: 0-168 }. */
export function validateBackup(raw: unknown): { backup?: BackupConfig; errors: string[] } {
	if (!isRecord(raw)) return { errors: ['"backup" must be an object like { "refresh": "auto", "healthyHours": 3 }'] };
	const errors: string[] = [];
	for (const key of Object.keys(raw)) if (key !== "refresh" && key !== "healthyHours") errors.push(`"backup.${key}" is not a setting (refresh, healthyHours)`);
	if (raw.refresh !== undefined && raw.refresh !== "auto" && raw.refresh !== "off") errors.push('"backup.refresh" must be "auto" or "off"');
	if (raw.healthyHours !== undefined && !(typeof raw.healthyHours === "number" && raw.healthyHours >= 0 && raw.healthyHours <= 168)) errors.push('"backup.healthyHours" must be a number of hours from 0 to 168 (default 3)');
	if (errors.length) return { errors };
	return { backup: { refresh: (raw.refresh as BackupConfig["refresh"] | undefined) ?? BACKUP_DEFAULTS.refresh, healthyHours: (raw.healthyHours as number | undefined) ?? BACKUP_DEFAULTS.healthyHours }, errors };
}

export const APPROVAL_POLICIES = ["all", "prod", "none"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** Whether a release to a branch of this channel needs a person's approval under the policy. */
export function approvalRequired(policy: ApprovalPolicy, branchChannel: Channel): boolean {
	return policy === "all" || (policy === "prod" && branchChannel === "prod");
}

export interface Project {
	root: string;
	configPath: string;
	config: ProjectConfig;
	warnings: string[];
}

const KNOWN_KEYS = new Set([
	"$schema",
	"project",
	"universeId",
	"placeId",
	"creator",
	"defaultBranch",
	"branches",
	"channels",
	"members",
	"revoked",
	"devBadgeId",
	"kernel",
	"approval",
	"signingPublicKeys",
	"revokedKeys",
	"fallbackPublicKey",
	"keyAssetId",
	"backend",
	"fleet", // CLI 0.8's name for "backend": read with a warning (CLI 0.9 only)
	"health",
	"autoRollback",
	"backup",
]);

function positiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value))) {
		return Number(value);
	}
	return undefined;
}

/** Validates a parsed typetorch.json. Returns the normalized config, or every problem found. */
export function validateConfig(raw: unknown): { config?: ProjectConfig; errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isRecord(raw)) return { errors: ["typetorch.json must be a JSON object"], warnings };

	for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" (ignored)`);

	const project = typeof raw.project === "string" ? raw.project.trim() : "";
	if (!project) errors.push(`"project" must be a non-empty string`);

	const universeId = positiveInt(raw.universeId);
	if (universeId === undefined) errors.push(`"universeId" must be a positive integer`);
	const placeId = positiveInt(raw.placeId);
	if (placeId === undefined) errors.push(`"placeId" must be a positive integer`);

	let creator: ProjectConfig["creator"] | undefined;
	if (!isRecord(raw.creator)) {
		errors.push(`"creator" must be { "groupId": <id> } or { "userId": <id> } (the experience owner)`);
	} else {
		const groupId = positiveInt(raw.creator.groupId);
		const userId = positiveInt(raw.creator.userId);
		if (raw.creator.groupId !== undefined && raw.creator.userId !== undefined) {
			errors.push(`"creator" must have only one of groupId and userId`);
		} else if (groupId !== undefined) creator = { groupId };
		else if (userId !== undefined) creator = { userId };
		else errors.push(`"creator.groupId" or "creator.userId" must be a positive integer`);
	}

	const defaultBranch = raw.defaultBranch === undefined ? "prod" : raw.defaultBranch;
	if (typeof defaultBranch !== "string" || branchNameError(defaultBranch)) {
		errors.push(`"defaultBranch": ${typeof defaultBranch === "string" ? branchNameError(defaultBranch) : "must be a string"}`);
	}

	const branches: Record<string, string> = {};
	if (raw.branches !== undefined) {
		if (!isRecord(raw.branches)) errors.push(`"branches" must map git branch names to TypeTorch branch names`);
		else
			for (const [gitBranch, branch] of Object.entries(raw.branches)) {
				if (typeof branch !== "string" || branchNameError(branch)) {
					errors.push(`"branches.${gitBranch}": ${typeof branch === "string" ? branchNameError(branch) : "must be a string"}`);
				} else branches[gitBranch] = branch;
			}
	}

	const channels: Record<string, Channel> = {};
	if (raw.channels !== undefined) {
		if (!isRecord(raw.channels)) errors.push(`"channels" must map TypeTorch branch names to "prod" or "dev"`);
		else
			for (const [branch, channel] of Object.entries(raw.channels)) {
				if (branchNameError(branch)) errors.push(`"channels": ${branchNameError(branch)}`);
				if (!isChannel(channel)) errors.push(`"channels.${branch}" must be "prod" or "dev"`);
				else channels[branch] = channel;
			}
	}

	const members: Record<string, Role> = {};
	if (raw.members !== undefined) {
		if (!isRecord(raw.members)) errors.push(`"members" must map user ids to roles (${ROLES.join(", ")})`);
		else
			for (const [userId, role] of Object.entries(raw.members)) {
				if (!/^\d+$/.test(userId)) errors.push(`"members": "${userId}" is not a user id`);
				if (!ROLES.includes(role as Role)) {
					errors.push(`"members.${userId}" must be one of ${ROLES.join(", ")}${role === "admin" ? ` (the admin role is gone since kernel 0.3.4: use "dev", or "owner")` : ""}`);
				} else members[userId] = role as Role;
			}
	}

	let revoked: Record<string, true> | undefined;
	if (raw.revoked !== undefined) {
		revoked = {};
		const ids = Array.isArray(raw.revoked)
			? raw.revoked.map(String)
			: isRecord(raw.revoked)
				? Object.entries(raw.revoked)
						.filter(([, on]) => on === true)
						.map(([id]) => id)
				: undefined;
		if (!ids) errors.push(`"revoked" must be a list of user ids or { "<userId>": true }`);
		else
			for (const id of ids) {
				if (!/^\d+$/.test(id)) errors.push(`"revoked": "${id}" is not a user id`);
				else revoked[id] = true;
			}
	}

	let devBadgeId: number | null = null;
	if (raw.devBadgeId !== undefined && raw.devBadgeId !== null) {
		const id = positiveInt(raw.devBadgeId);
		if (id === undefined) errors.push(`"devBadgeId" must be a positive integer or null`);
		else devBadgeId = id;
	}

	if (raw.kernel !== undefined && (typeof raw.kernel !== "string" || raw.kernel.trim() === "")) {
		errors.push(`"kernel" must be a folder path`);
	}

	if (raw.approval !== undefined && !APPROVAL_POLICIES.includes(raw.approval as ApprovalPolicy)) {
		errors.push(`"approval" must be one of ${APPROVAL_POLICIES.join(", ")}`);
	}

	if (raw.signingPublicKeys !== undefined) errors.push(...publicKeyListProblems("signingPublicKeys", raw.signingPublicKeys));
	if (raw.revokedKeys !== undefined) errors.push(...publicKeyListProblems("revokedKeys", raw.revokedKeys));
	if (raw.fallbackPublicKey !== undefined) {
		const problem = publicKeyError(raw.fallbackPublicKey);
		if (problem) errors.push(`"fallbackPublicKey" ${problem}`);
		else if (isTestVectorKey(raw.fallbackPublicKey as string)) errors.push(`"fallbackPublicKey" is a public test-vector key from plans/03`);
		else if (Array.isArray(raw.signingPublicKeys) && raw.signingPublicKeys.includes(raw.fallbackPublicKey)) {
			errors.push(`"fallbackPublicKey" is also in "signingPublicKeys"; the fallback must be a separate key pair`);
		}
	}
	let backend: { url: string } | undefined;
	if (raw.backend !== undefined) {
		const url = isRecord(raw.backend) ? raw.backend.url : undefined;
		const problem = backendUrlError(url);
		if (problem) errors.push(`"backend.url" ${problem}`);
		else backend = { url: url as string };
		if (raw.fleet !== undefined) warnings.push(`"fleet" is ignored: "backend" replaces it (CLI 0.9); delete "fleet"`);
	} else if (raw.fleet !== undefined) {
		// CLI 0.8's name, read for one release. `typetorch backend setup` renames it.
		const url = isRecord(raw.fleet) ? raw.fleet.url : undefined;
		const problem = backendUrlError(url);
		if (problem) errors.push(`"fleet.url" ${problem}`);
		else {
			backend = { url: url as string };
			warnings.push(`"fleet" is now "backend" (CLI 0.9): rename "fleet": { "url": ... } to "backend": { "url": ... } (typetorch backend setup does it)`);
		}
	}
	let keyAssetId: number | undefined;
	if (raw.keyAssetId !== undefined) {
		keyAssetId = positiveInt(raw.keyAssetId);
		if (keyAssetId === undefined) errors.push(`"keyAssetId" must be a positive integer (the key asset's id)`);
	}
	let health: HealthConfig | undefined;
	if (raw.health !== undefined) {
		const checked = validateHealth(raw.health);
		errors.push(...checked.errors);
		health = checked.health;
	}
	let autoRollback: AutoRollbackConfig | undefined;
	let backup: BackupConfig | undefined;
	if (raw.backup !== undefined) {
		const checked = validateBackup(raw.backup);
		errors.push(...checked.errors);
		backup = checked.backup;
	}
	if (raw.autoRollback !== undefined) {
		const checked = validateAutoRollback(raw.autoRollback);
		errors.push(...checked.errors);
		autoRollback = checked.autoRollback;
	}

	if (errors.length > 0) return { errors, warnings };
	return {
		errors,
		warnings,
		config: {
			project,
			universeId: universeId!,
			placeId: placeId!,
			creator: creator!,
			defaultBranch: defaultBranch as string,
			branches,
			channels,
			members,
			revoked,
			devBadgeId,
			kernel: typeof raw.kernel === "string" ? raw.kernel : undefined,
			approval: (raw.approval as ApprovalPolicy | undefined) ?? "all",
			...(Array.isArray(raw.signingPublicKeys) ? { signingPublicKeys: raw.signingPublicKeys as string[] } : {}),
			...(Array.isArray(raw.revokedKeys) ? { revokedKeys: raw.revokedKeys as string[] } : {}),
			...(typeof raw.fallbackPublicKey === "string" ? { fallbackPublicKey: raw.fallbackPublicKey } : {}),
			...(keyAssetId !== undefined ? { keyAssetId } : {}),
			...(backend ? { backend } : {}),
			...(health ? { health } : {}),
			...(autoRollback ? { autoRollback } : {}),
			...(backup ? { backup } : {}),
		},
	};
}

/** The nearest folder at or above `start` that holds typetorch.json. */
export function findProjectRoot(start: string = process.cwd()): string | undefined {
	let dir = resolve(start);
	while (true) {
		if (existsSync(join(dir, CONFIG_FILE))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Loads and validates typetorch.json (`configPath` overrides the search). */
export function loadProject(configPath?: string, cwd: string = process.cwd()): Project {
	let path: string;
	if (configPath) {
		path = resolve(cwd, configPath);
		if (!existsSync(path)) throw new ConfigError(`${path} does not exist`);
	} else {
		const root = findProjectRoot(cwd);
		if (!root) throw new ConfigError(`no ${CONFIG_FILE} in ${resolve(cwd)} or any parent folder; run inside a TypeTorch game repo`);
		path = join(root, CONFIG_FILE);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new ConfigError(`${path} is invalid:\n  - ${errors.join("\n  - ")}`);
	return { root: dirname(path), configPath: path, config, warnings };
}

export type KeyConfigField = "signingPublicKeys" | "revokedKeys" | "fallbackPublicKey" | "keyAssetId" | "backend";

/** The backend's base URL: https (game servers only reach https; http on localhost for this PC), no credentials in it. */
export function backendUrlError(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 300) return "must be the backend's https URL";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "must be the backend's https URL";
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return "must be https (Roblox game servers only reach https endpoints)";
	if (url.username || url.password) return "must not hold credentials (the keys come from the game repo's .env: TYPETORCH_API_KEY, TYPETORCH_ADMIN_TOKEN)";
	return undefined;
}

/**
 * Writes key fields into the project's typetorch.json (only those fields change; formatting stays) and refreshes
 * `proj.config`. Refuses to write a file that would not validate. Writing `backend` also drops CLI 0.8's `fleet`.
 */
export function updateProjectConfig(proj: Project, updates: Partial<Record<KeyConfigField, unknown>>) {
	let text = readFileSync(proj.configPath, "utf8");
	if (updates.backend !== undefined) text = removeJsonField(text, "fleet");
	const next = setJsonFields(text, updates);
	const { config, errors, warnings } = validateConfig(JSON.parse(next));
	if (!config) throw new ConfigError(`refusing to write an invalid ${proj.configPath}:\n  - ${errors.join("\n  - ")}`);
	writeFileSync(proj.configPath, next);
	proj.config = config;
	proj.warnings = warnings;
}
