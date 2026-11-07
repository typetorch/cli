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
 *   "backup": { "refresh": "auto", "healthyHours": 3 }, // "off": only kernel deploy / typetorch backup refresh
 *   // The compiler (compiler.ts), optional: default goblox when it is installed (`bun add -d goblox`), else rbxtsc;
 *   // TYPETORCH_COMPILER overrides it:
 *   "compiler": "goblox",                        // "goblox" | "rbxtsc"
 *   // Experience notifications (plans/29; validateNotifications), pushed as-is by `typetorch notify push`:
 *   "notifications": { "dailyCap": 1, "kinds": { "gift_new": { "template": "<message_id>", "priority": 10, "repeat": "per_key" } } }
 * }
 * Secrets never go here: they live in the game repo's `.env` (env.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compilerValueError, type CompilerName } from "./compiler.ts";
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
	/** The compiler (compiler.ts); unset: goblox when installed, else rbxtsc. TYPETORCH_COMPILER overrides it. */
	compiler?: CompilerName;
	/** Experience notifications (plans/29): the kinds and caps `typetorch notify push` sends to the backend as-is. */
	notifications?: NotificationsConfig;
}

// Experience notifications (plans/29, plans/29-contract.md "Config") ---------------------------------------------------

export const NOTIFY_REPEATS = ["once_ever", "per_key", "daily"] as const;
export const NOTIFY_SENDS = ["asap", "preferred_hour"] as const;
/** A kind name (also the launch token's `k`). `custom` is reserved for one-offs (`typetorch notify send`). */
export const NOTIFY_KIND_PATTERN = /^[a-z0-9_]{1,24}$/;
export const NOTIFY_RESERVED_KIND = "custom";
export const NOTIFY_TEMPLATE_MAX = 128;
/** Roblox's limit for a notification string's text. */
export const NOTIFY_TEXT_MAX = 99;
/** A template placeholder / param name (Roblox templates use dashes: `{user-streak-remaining}`). */
export const NOTIFY_PARAM_NAME = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * A template text's placeholders in order of first use (`{name}`), or why the text isn't usable: over 99 characters,
 * an empty or invalid name, a `{` without its `}` (or nested), a `}` without its `{`.
 */
export function templatePlaceholders(text: string): { names: string[]; problem?: string } {
	const length = [...text].length;
	if (length === 0) return { names: [], problem: "is empty" };
	if (length > NOTIFY_TEXT_MAX) return { names: [], problem: `is ${length} characters; Roblox allows ${NOTIFY_TEXT_MAX}` };
	const names: string[] = [];
	let open = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") {
			if (open !== -1) return { names: [], problem: `has a "{" inside another placeholder (at ${i + 1})` };
			open = i;
		} else if (ch === "}") {
			if (open === -1) return { names: [], problem: `has a "}" without its "{" (at ${i + 1})` };
			const name = text.slice(open + 1, i);
			if (!NOTIFY_PARAM_NAME.test(name)) return { names: [], problem: `has the placeholder {${name}}: names are 1-32 characters of a-z A-Z 0-9 _ -` };
			if (!names.includes(name)) names.push(name);
			open = -1;
		}
	}
	if (open !== -1) return { names: [], problem: `has a "{" without its "}" (at ${open + 1})` };
	return { names };
}

export interface NotifyKindConfig {
	/** The template's text (at most 99 characters, `{placeholders}`): what you paste into the Creator Dashboard. */
	text?: string;
	/** The notification string's message id (Creator Dashboard, Engagement -> Notifications). None: planned, never sent. */
	template?: string;
	/** Lower wins when several are due for one user on one day (0-1000). */
	priority: number;
	repeat: (typeof NOTIFY_REPEATS)[number];
	/** Default preferred_hour. */
	send?: (typeof NOTIFY_SENDS)[number];
	perWeek?: number;
	maxWaitHours?: number;
	/** Roblox's dashboard groups by it; default the kind name. */
	category?: string;
	/** `want(user, kind, { template })` may name another template. */
	allowTemplate?: boolean;
	/** Outranks these kinds only within its last `withinHours` (off by default). */
	beats?: { kinds: string[]; withinHours: number };
}

export interface NotificationsConfig {
	dailyCap?: number;
	quietAfterLeaveMinutes?: number;
	/** [days since last seen, max sends per week], ascending days; past the last = stop. */
	lapse?: [number, number][];
	unopenedBackoff?: { after: number; factor: number; days: number };
	kinds: Record<string, NotifyKindConfig>;
}

const NOTIFY_TOP_KEYS = ["dailyCap", "quietAfterLeaveMinutes", "lapse", "unopenedBackoff", "kinds"];
const NOTIFY_KIND_KEYS = ["text", "template", "priority", "repeat", "send", "perWeek", "maxWaitHours", "category", "allowTemplate", "beats"];

/**
 * Validates typetorch.json "notifications" with the contract's rules (plans/29-contract.md "Config"; the backend's copy of
 * these rules is authoritative, this one refuses a bad push before it leaves the PC): kind names [a-z0-9_]{1,24} and not
 * "custom"; priority an integer 0-1000; perWeek an integer 1-7; lapse ascending days; dailyCap an integer 1-3; template
 * at most 128 characters; text at most 99 characters with valid, balanced {placeholders} (names [a-zA-Z0-9_-]{1,32});
 * repeat / send from their lists; unknown fields refused (a typo would silently change nothing).
 * The value is returned unchanged (it is pushed as-is).
 */
export function validateNotifications(raw: unknown): { notifications?: NotificationsConfig; errors: string[] } {
	const at = (path: string) => `"notifications${path}"`;
	if (!isRecord(raw)) return { errors: [`${at("")} must be an object like { "kinds": { "gift_new": { "template": "<message_id>", "priority": 10, "repeat": "per_key" } } }`] };
	const errors: string[] = [];
	const isInt = (value: unknown, low: number, high: number) => typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
	const isPositive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
	for (const key of Object.keys(raw)) if (!NOTIFY_TOP_KEYS.includes(key)) errors.push(`${at(`.${key}`)} is not a setting (${NOTIFY_TOP_KEYS.join(", ")})`);
	if (raw.dailyCap !== undefined && !isInt(raw.dailyCap, 1, 3)) errors.push(`${at(".dailyCap")} must be a whole number from 1 to 3 (Roblox allows 1 a day)`);
	if (raw.quietAfterLeaveMinutes !== undefined && !(typeof raw.quietAfterLeaveMinutes === "number" && Number.isFinite(raw.quietAfterLeaveMinutes) && raw.quietAfterLeaveMinutes >= 0)) {
		errors.push(`${at(".quietAfterLeaveMinutes")} must be a number of minutes >= 0`);
	}
	if (raw.lapse !== undefined) {
		if (!Array.isArray(raw.lapse)) errors.push(`${at(".lapse")} must be a list of [days, perWeek] pairs, like [[14, 7], [30, 2], [60, 1]]`);
		else {
			let last = -Infinity;
			raw.lapse.forEach((pair, i) => {
				if (!Array.isArray(pair) || pair.length !== 2 || !isInt(pair[0], 0, 100_000) || !isInt(pair[1], 0, 7)) {
					errors.push(`${at(`.lapse[${i}]`)} must be [days, perWeek]: whole days >= 0 and 0-7 sends a week`);
					return;
				}
				if (pair[0] <= last) errors.push(`${at(".lapse")} must be in ascending days (${pair[0]} after ${last})`);
				last = pair[0];
			});
		}
	}
	if (raw.unopenedBackoff !== undefined) {
		const b = raw.unopenedBackoff;
		if (!isRecord(b)) errors.push(`${at(".unopenedBackoff")} must be { "after": 5, "factor": 0.5, "days": 14 }`);
		else {
			for (const key of Object.keys(b)) if (!["after", "factor", "days"].includes(key)) errors.push(`${at(`.unopenedBackoff.${key}`)} is not a setting (after, factor, days)`);
			if (!isInt(b.after, 1, 1000)) errors.push(`${at(".unopenedBackoff.after")} must be a whole number >= 1 (unopened sends in a row)`);
			if (!(typeof b.factor === "number" && b.factor > 0 && b.factor <= 1)) errors.push(`${at(".unopenedBackoff.factor")} must be a number above 0, at most 1`);
			if (!isInt(b.days, 1, 365)) errors.push(`${at(".unopenedBackoff.days")} must be a whole number of days from 1 to 365`);
		}
	}
	if (!isRecord(raw.kinds)) errors.push(`${at(".kinds")} must map kind names to { template, priority, repeat, ... }`);
	else
		for (const [name, kind] of Object.entries(raw.kinds)) {
			const path = (field = "") => at(`.kinds.${name}${field}`);
			if (!NOTIFY_KIND_PATTERN.test(name)) errors.push(`${path()}: a kind name is 1-24 characters of a-z 0-9 _`);
			else if (name === NOTIFY_RESERVED_KIND) errors.push(`${path()}: "custom" is reserved (one-offs: typetorch notify send)`);
			if (!isRecord(kind)) {
				errors.push(`${path()} must be { template, priority, repeat, ... }`);
				continue;
			}
			for (const key of Object.keys(kind)) if (!NOTIFY_KIND_KEYS.includes(key)) errors.push(`${path(`.${key}`)} is not a setting (${NOTIFY_KIND_KEYS.join(", ")})`);
			if (kind.template !== undefined && !(typeof kind.template === "string" && kind.template.length >= 1 && kind.template.length <= NOTIFY_TEMPLATE_MAX)) {
				errors.push(`${path(".template")} must be the notification's message id (1-${NOTIFY_TEMPLATE_MAX} characters)`);
			}
			if (kind.text !== undefined) {
				const problem = typeof kind.text === "string" ? templatePlaceholders(kind.text).problem : "must be a string";
				if (problem) errors.push(`${path(".text")} ${problem}`);
			}
			if (!isInt(kind.priority, 0, 1000)) errors.push(`${path(".priority")} must be a whole number from 0 to 1000 (lower wins)`);
			if (!NOTIFY_REPEATS.includes(kind.repeat as never)) errors.push(`${path(".repeat")} must be one of ${NOTIFY_REPEATS.join(", ")}`);
			if (kind.send !== undefined && !NOTIFY_SENDS.includes(kind.send as never)) errors.push(`${path(".send")} must be one of ${NOTIFY_SENDS.join(", ")}`);
			if (kind.perWeek !== undefined && !isInt(kind.perWeek, 1, 7)) errors.push(`${path(".perWeek")} must be a whole number from 1 to 7`);
			if (kind.maxWaitHours !== undefined && !isPositive(kind.maxWaitHours)) errors.push(`${path(".maxWaitHours")} must be a number of hours above 0`);
			if (kind.category !== undefined && !(typeof kind.category === "string" && kind.category.length > 0)) errors.push(`${path(".category")} must be a non-empty string`);
			if (kind.allowTemplate !== undefined && typeof kind.allowTemplate !== "boolean") errors.push(`${path(".allowTemplate")} must be true or false`);
			if (kind.beats !== undefined) {
				const beats = kind.beats;
				if (!isRecord(beats) || !Array.isArray(beats.kinds) || !beats.kinds.every((k) => typeof k === "string" && NOTIFY_KIND_PATTERN.test(k)) || !isPositive(beats.withinHours)) {
					errors.push(`${path(".beats")} must be { "kinds": ["<kind>", ...], "withinHours": <hours above 0> }`);
				} else for (const key of Object.keys(beats)) if (key !== "kinds" && key !== "withinHours") errors.push(`${path(`.beats.${key}`)} is not a setting (kinds, withinHours)`);
			}
		}
	if (errors.length) return { errors };
	return { notifications: raw as unknown as NotificationsConfig, errors };
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
	"compiler",
	"notifications",
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
	if (raw.compiler !== undefined) {
		const problem = compilerValueError(raw.compiler);
		if (problem) errors.push(`"compiler" ${problem}`);
	}
	if (raw.autoRollback !== undefined) {
		const checked = validateAutoRollback(raw.autoRollback);
		errors.push(...checked.errors);
		autoRollback = checked.autoRollback;
	}
	let notifications: NotificationsConfig | undefined;
	if (raw.notifications !== undefined) {
		const checked = validateNotifications(raw.notifications);
		errors.push(...checked.errors);
		notifications = checked.notifications;
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
			...(raw.compiler !== undefined ? { compiler: raw.compiler as CompilerName } : {}),
			...(notifications ? { notifications } : {}),
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
