/**
 * The interim registry (until the backend exists): ONE ConfigService key, "TypeTorch", in the experience's
 * InExperienceConfig repository, written through the Open Cloud configs API (draft -> publish) and read by the kernel
 * (kernel/src/server/Registry.luau). The game shares the repository, so every write goes through `writeRegistry`,
 * which refuses to publish when the draft holds someone else's unpublished changes.
 *
 * API (OpenAPI spec in Roblox/creator-docs, operation ids CreatorConfigsPublicApi_*):
 *   GET   {base}            -> { metadata: { configVersion }, entries: { key: value }, conditionalRules? }
 *   GET   {base}/draft      -> { draftHash, entries: { key: { value, description } }, conditionalRules? }
 *   PATCH {base}/draft      <- { draftHash?, entries: { key: value } }  -> { draftHash }   (null value deletes)
 *   POST  {base}/publish    <- { draftHash, message, deploymentStrategy: "Immediate" } -> { configVersion }
 * Scopes: universe:read (reads), universe:write (draft + publish). Values are limited to 10,000 characters.
 */
import { isRecord, jsonEqual } from "./json";
import { debug, warn } from "./log";
import type { BuildSources, Channel } from "./naming";
import { ApiError, type OpenCloud } from "./opencloud";
import type { ProjectConfig, Role } from "./config";

export const REGISTRY_KEY = "TypeTorch";
export const REPOSITORY = "InExperienceConfig";
export const MAX_DEPLOYMENTS = 25;
/** The configs API limits a value to 10,000 characters; keep a margin. */
export const MAX_VALUE_CHARS = 9_500;

/**
 * A branch's live head. Heads are ordered by (seq, time): the higher seq wins, and on equal seq the later deployedAt
 * (`t` when present). `t`, `r` and `sig` are the signed deploy message's fields (plans/03), so a kernel can verify the
 * head exactly like the message it came from.
 */
export interface BranchHead {
	artifactId: string;
	assetId: number;
	channel: Channel;
	commit: string;
	commitHash: string;
	seq: number;
	deployedAt: string;
	by: string;
	/** The deploy message's `t` (unix ms). */
	t?: number;
	/** 1 when the message was a rollback. */
	r?: 1;
	/** base64 Ed25519 signature of the message (absent when the deploy was unsigned). */
	sig?: string;
	/** Commits of the game and the @typetorch packages in the payload. */
	sources?: BuildSources;
}

export interface RegistryDeployment {
	seq: number;
	at: string;
	action: "deploy" | "rollback" | "promote";
	branch: string;
	channel: Channel;
	artifactId: string;
	assetId: number;
	commit: string;
	commitHash: string;
	dirty: boolean;
	by: string;
	/** What the branch ran before this entry (absent for a branch's first deploy). */
	fromAssetId?: number;
	fromArtifactId?: string;
	sources?: BuildSources;
	/** The deploy message's `t`, `r` and `sig` (kept on the branch head; not in the registry's deployments list). */
	t?: number;
	r?: 1;
	sig?: string;
}

export interface RegistryValue {
	v: 1;
	defaultBranch: string;
	channels: Record<string, Channel>;
	members: Record<string, Role>;
	revoked: Record<string, true>;
	devBadgeId: number | null;
	branches: Record<string, BranchHead>;
	/** Newest last, at most MAX_DEPLOYMENTS. */
	deployments: RegistryDeployment[];
}

export function emptyRegistry(): RegistryValue {
	return { v: 1, defaultBranch: "prod", channels: {}, members: {}, revoked: {}, devBadgeId: null, branches: {}, deployments: [] };
}

/** Fills defaults; accepts the value as an object or as a JSON string. */
export function normalizeRegistry(raw: unknown): RegistryValue {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			value = undefined;
		}
	}
	const base = emptyRegistry();
	if (!isRecord(value)) return base;
	return {
		...value,
		v: 1,
		defaultBranch: typeof value.defaultBranch === "string" ? value.defaultBranch : base.defaultBranch,
		channels: isRecord(value.channels) ? (value.channels as RegistryValue["channels"]) : {},
		members: isRecord(value.members) ? (value.members as RegistryValue["members"]) : {},
		revoked: isRecord(value.revoked) ? (value.revoked as RegistryValue["revoked"]) : {},
		devBadgeId: typeof value.devBadgeId === "number" ? value.devBadgeId : null,
		branches: isRecord(value.branches) ? (value.branches as RegistryValue["branches"]) : {},
		deployments: Array.isArray(value.deployments) ? (value.deployments as RegistryDeployment[]) : [],
	};
}

/** Next deployment seq: one above the highest seq in the registry (deployments and branch heads). */
export function nextSeq(value: RegistryValue): number {
	let highest = 0;
	for (const d of value.deployments) if (typeof d.seq === "number") highest = Math.max(highest, d.seq);
	for (const head of Object.values(value.branches)) if (typeof head?.seq === "number") highest = Math.max(highest, head.seq);
	return highest + 1;
}

export function headFromDeployment(entry: RegistryDeployment): BranchHead {
	const head: BranchHead = {
		artifactId: entry.artifactId,
		assetId: entry.assetId,
		channel: entry.channel,
		commit: entry.commit,
		commitHash: entry.commitHash,
		seq: entry.seq,
		deployedAt: entry.at,
		by: entry.by,
	};
	if (entry.t !== undefined) head.t = entry.t;
	if (entry.r === 1) head.r = 1;
	if (entry.sig) head.sig = entry.sig;
	if (entry.sources) head.sources = entry.sources;
	return head;
}

/** Points `entry.branch` at the entry's artifact and appends the entry (then trims to the limits). */
export function recordDeployment(value: RegistryValue, entry: RegistryDeployment): RegistryValue {
	const next: RegistryValue = structuredClone(value);
	next.branches[entry.branch] = headFromDeployment(entry);
	const { sig: _sig, t: _t, r: _r, ...listed } = entry; // the head carries the signed fields; keep the list small
	next.deployments.push(listed);
	return trimRegistry(next).value;
}

/** Keeps at most `maxDeployments` (newest) and drops the oldest until the JSON fits `maxChars`. */
export function trimRegistry(
	value: RegistryValue,
	maxDeployments = MAX_DEPLOYMENTS,
	maxChars = MAX_VALUE_CHARS,
): { value: RegistryValue; dropped: number } {
	const next = { ...value, deployments: [...value.deployments].sort((a, b) => a.seq - b.seq) };
	let dropped = 0;
	while (next.deployments.length > maxDeployments) {
		next.deployments.shift();
		dropped++;
	}
	while (JSON.stringify(next).length > maxChars && next.deployments.length > 1) {
		next.deployments.shift();
		dropped++;
	}
	if (JSON.stringify(next).length > maxChars) {
		throw new Error(
			`the TypeTorch registry value is ${JSON.stringify(next).length} characters, over the ${maxChars} limit, even with one deployment (too many branches or members?)`,
		);
	}
	return { value: next, dropped };
}

/** Copies the project settings from typetorch.json into the registry value (branches and deployments kept). */
export function applyProjectConfig(value: RegistryValue, config: ProjectConfig): RegistryValue {
	const next: RegistryValue = {
		...structuredClone(value),
		v: 1,
		defaultBranch: config.defaultBranch,
		channels: { ...config.channels },
		members: { ...config.members },
		devBadgeId: config.devBadgeId,
	};
	if (config.revoked !== undefined) next.revoked = { ...config.revoked };
	return next;
}

/** The channel the registry gives a branch (what the kernel uses): channels[branch], else its head's, else default. */
export function registryBranchChannel(value: RegistryValue, branch: string): Channel {
	return value.channels[branch] ?? value.branches[branch]?.channel ?? (branch === value.defaultBranch ? "prod" : "dev");
}

// Draft safety ------------------------------------------------------------------------------------------------------

/** Draft entries come as { value, description }; tolerate raw values too. */
export function unwrapDraftEntries(entries: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!isRecord(entries)) return out;
	for (const [key, entry] of Object.entries(entries)) {
		out[key] = isRecord(entry) && "value" in entry ? entry.value : entry;
	}
	return out;
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return Symbol("unparseable");
	}
}

/** Equality that also treats a JSON string and the value it encodes as equal (draft vs published encodings). */
export function sameConfigValue(a: unknown, b: unknown): boolean {
	if (jsonEqual(a, b)) return true;
	if (typeof a === "string" && typeof b !== "string") return jsonEqual(tryParse(a), b);
	if (typeof b === "string" && typeof a !== "string") return jsonEqual(a, tryParse(b));
	return false;
}

function hasConditionalRules(rules: unknown): boolean {
	if (!isRecord(rules)) return false;
	const ruleIds = isRecord(rules.rules) ? Object.keys(rules.rules) : [];
	const order = Array.isArray(rules.rulesOrder) ? rules.rulesOrder : [];
	return ruleIds.length > 0 || order.length > 0;
}

/**
 * Keys (other than ours) whose draft value differs from the published one: someone else's unpublished edits, which a
 * publish would ship. Works whether the draft endpoint returns only the changed keys or the whole draft.
 */
export function foreignDraftChanges(input: {
	draftEntries: Record<string, unknown>;
	publishedEntries: Record<string, unknown>;
	draftRules?: unknown;
	publishedRules?: unknown;
	ownKey?: string;
}): string[] {
	const own = input.ownKey ?? REGISTRY_KEY;
	const keys: string[] = [];
	for (const [key, value] of Object.entries(input.draftEntries)) {
		if (key === own) continue;
		if (!sameConfigValue(value, input.publishedEntries[key])) keys.push(key);
	}
	if (hasConditionalRules(input.draftRules) && !jsonEqual(input.draftRules, input.publishedRules)) {
		keys.push("(conditional rules)");
	}
	return keys.sort();
}

// API --------------------------------------------------------------------------------------------------------------

/**
 * The configs API can not be used with this key: missing universe:read / universe:write (403 "Scope not authorized"),
 * or configs unsupported for this key or experience (other 4xx). Deploys then continue without the registry: game
 * servers persist the head from the deploy message themselves.
 */
export class RegistryUnavailableError extends Error {
	override name = "RegistryUnavailableError";
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Statuses that mean "this key can not use the configs API" rather than a transient or conflict error. */
function isUnavailableStatus(status: number): boolean {
	return status === 400 || status === 401 || status === 403 || status === 405 || status === 501;
}

function unavailable(error: unknown, universeId: number, scope: string): never {
	if (error instanceof ApiError && isUnavailableStatus(error.status)) {
		const text = error.text.replace(/\s+/g, " ").trim().slice(0, 300);
		throw new RegistryUnavailableError(
			`configs API ${error.method} ${error.status}${text ? ` ${text}` : ""}; the API key needs ${scope} for universe ${universeId}`,
			error.status,
		);
	}
	throw error;
}

export interface PublishedConfig {
	entries: Record<string, unknown>;
	configVersion?: number;
	conditionalRules?: unknown;
	/** false when the repository has no published config yet (404). */
	exists: boolean;
}

export interface DraftConfig {
	exists: boolean;
	draftHash?: string;
	/** Unwrapped values. */
	entries: Record<string, unknown>;
	conditionalRules?: unknown;
}

export class RegistryApi {
	readonly base: string;

	constructor(
		readonly oc: OpenCloud,
		readonly universeId: number,
		readonly repository = REPOSITORY,
	) {
		this.base = `/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${repository}`;
	}

	async getPublished(): Promise<PublishedConfig> {
		const response = await this.oc.request("GET", this.base);
		if (response.status === 404) {
			debug(`configs: GET ${this.base} -> 404 (no published config yet?): ${response.text}`);
			return { entries: {}, exists: false };
		}
		if (!response.ok) unavailable(new ApiError("GET", this.base, response.status, response.body, response.text), this.universeId, "universe:read");
		const body = response.body;
		if (!isRecord(body) || (body.entries !== undefined && body.entries !== null && !isRecord(body.entries))) {
			warn(`configs: unexpected GET ${this.base} response shape (please report): ${response.text.slice(0, 2000)}`);
		}
		const entries = isRecord(body) && isRecord(body.entries) ? body.entries : {};
		const metadata = isRecord(body) && isRecord(body.metadata) ? body.metadata : {};
		return {
			entries,
			configVersion: typeof metadata.configVersion === "number" ? metadata.configVersion : undefined,
			conditionalRules: isRecord(body) ? body.conditionalRules : undefined,
			exists: true,
		};
	}

	async getDraft(): Promise<DraftConfig> {
		const path = `${this.base}/draft`;
		const response = await this.oc.request("GET", path);
		if (response.status === 404) {
			debug(`configs: GET ${path} -> 404 (no draft): ${response.text}`);
			return { exists: false, entries: {} };
		}
		if (!response.ok) unavailable(new ApiError("GET", path, response.status, response.body, response.text), this.universeId, "universe:read");
		const body = response.body;
		if (!isRecord(body) || (body.entries != null && !isRecord(body.entries)) || (body.draftHash != null && typeof body.draftHash !== "string")) {
			warn(`configs: unexpected GET ${path} response shape (please report): ${response.text.slice(0, 2000)}`);
		}
		debug(`configs: draft = ${response.text.slice(0, 500)}`);
		return {
			exists: true,
			draftHash: isRecord(body) && typeof body.draftHash === "string" && body.draftHash !== "" ? body.draftHash : undefined,
			entries: unwrapDraftEntries(isRecord(body) ? body.entries : undefined),
			conditionalRules: isRecord(body) ? body.conditionalRules : undefined,
		};
	}

	/** PATCHes the draft; returns the new draft hash (re-reads the draft if the response has none). */
	async patchDraft(entries: Record<string, unknown>, draftHash?: string): Promise<string | undefined> {
		const path = `${this.base}/draft`;
		const body: Record<string, unknown> = { entries };
		if (draftHash) body.draftHash = draftHash;
		let result;
		try {
			result = await this.oc.call("PATCH", path, { json: body });
		} catch (error) {
			unavailable(error, this.universeId, "universe:write");
		}
		if (isRecord(result) && typeof result.draftHash === "string" && result.draftHash) return result.draftHash;
		warn(`configs: PATCH ${path} returned no draftHash (please report the shape): ${JSON.stringify(result)?.slice(0, 2000)}`);
		return (await this.getDraft()).draftHash;
	}

	/** Publishes the draft immediately; returns the new config version when the response has one. */
	async publish(draftHash: string | undefined, message: string): Promise<number | undefined> {
		const path = `${this.base}/publish`;
		const body: Record<string, unknown> = { message: message.slice(0, 200), deploymentStrategy: "Immediate" };
		if (draftHash) body.draftHash = draftHash;
		let result;
		try {
			result = await this.oc.call("POST", path, { json: body });
		} catch (error) {
			unavailable(error, this.universeId, "universe:write");
		}
		if (isRecord(result) && typeof result.configVersion === "number") return result.configVersion;
		warn(`configs: POST ${path} returned no configVersion (please report the shape): ${JSON.stringify(result)?.slice(0, 2000)}`);
		return undefined;
	}
}

// Read and write ---------------------------------------------------------------------------------------------------

export interface RegistrySnapshot {
	value: RegistryValue;
	/** Whether the TypeTorch key exists in the published config. */
	exists: boolean;
	/** The raw published value (object or JSON string), to keep its encoding on write. */
	raw: unknown;
	configVersion?: number;
	published: PublishedConfig;
	draft: DraftConfig;
	/** Other keys with unpublished draft edits. */
	foreign: string[];
	/** The draft holds an unpublished change to our own key (e.g. an earlier run that failed before publishing). */
	ownDraftDiffers: boolean;
}

/** Reads the published config and the draft (in parallel) and checks the draft for others' edits. */
export async function readRegistry(api: RegistryApi): Promise<RegistrySnapshot> {
	const [published, draft] = await Promise.all([api.getPublished(), api.getDraft()]);
	const raw = published.entries[REGISTRY_KEY];
	const foreign = foreignDraftChanges({
		draftEntries: draft.entries,
		publishedEntries: published.entries,
		draftRules: draft.conditionalRules,
		publishedRules: published.conditionalRules,
	});
	const ownDraftDiffers = REGISTRY_KEY in draft.entries && !sameConfigValue(draft.entries[REGISTRY_KEY], raw);
	return {
		value: normalizeRegistry(raw),
		exists: raw !== undefined && raw !== null,
		raw,
		configVersion: published.configVersion,
		published,
		draft,
		foreign,
		ownDraftDiffers,
	};
}

export class RegistryConflictError extends Error {
	override name = "RegistryConflictError";
}

export function assertNoForeignDraft(snapshot: RegistrySnapshot, force: boolean) {
	if (snapshot.foreign.length === 0) return;
	const keys = snapshot.foreign.join(", ");
	if (force) {
		warn(`the ${REPOSITORY} draft has unpublished changes to other keys (${keys}); --force publishes them too`);
		return;
	}
	throw new RegistryConflictError(
		`the experience's ${REPOSITORY} draft has unpublished changes to other keys: ${keys}. Publishing the registry ` +
			`would ship them. Publish or discard that draft in Creator Hub (Configs), or pass --force to publish it anyway.`,
	);
}

export interface WriteResult {
	before: RegistryValue;
	after: RegistryValue;
	changed: boolean;
	dryRun: boolean;
	configVersion?: number;
	/** Seconds spent in the API calls. */
	seconds: number;
}

/**
 * The ONLY way the CLI writes the registry: read draft + published -> refuse others' unpublished edits (unless
 * force) -> compute the new value from the PUBLISHED one -> PATCH the draft -> publish ("Immediate").
 * The new value is computed from what is live, not from an unpublished draft of our key (which would contain a
 * deployment that never went out); such a draft is replaced, with a warning.
 */
export async function writeRegistry(
	api: RegistryApi,
	options: { message: string; force: boolean; dryRun: boolean; snapshot?: RegistrySnapshot },
	mutate: (current: RegistryValue) => RegistryValue,
): Promise<WriteResult> {
	const started = performance.now();
	const snapshot = options.snapshot ?? (await readRegistry(api));
	assertNoForeignDraft(snapshot, options.force);
	if (snapshot.ownDraftDiffers) {
		warn(`the draft held an unpublished ${REGISTRY_KEY} change (an earlier run that did not publish?); replacing it`);
	}
	const before = snapshot.value;
	const after = trimRegistry(mutate(structuredClone(before))).value;
	const changed = !jsonEqual(before, after) || !snapshot.exists;
	if (options.dryRun || !changed) {
		return { before, after, changed, dryRun: options.dryRun, seconds: (performance.now() - started) / 1000 };
	}
	// Keep the stored encoding: a value created as a JSON string stays a string.
	const stored = typeof snapshot.raw === "string" ? JSON.stringify(after) : after;
	const draftHash = await api.patchDraft({ [REGISTRY_KEY]: stored }, snapshot.draft.draftHash);
	const configVersion = await api.publish(draftHash, options.message);
	return { before, after, changed, dryRun: false, configVersion, seconds: (performance.now() - started) / 1000 };
}

/**
 * Reads the registry, or explains why it can't: `unavailable` is set (and the deploy continues without the registry)
 * when the key can't use the configs API. Other errors (network, 5xx) are thrown.
 */
export async function tryReadRegistry(
	api: RegistryApi,
): Promise<{ snapshot?: RegistrySnapshot; unavailable?: string }> {
	try {
		return { snapshot: await readRegistry(api) };
	} catch (error) {
		if (error instanceof RegistryUnavailableError) return { unavailable: error.message };
		throw error;
	}
}

/** The one-line warning shown when deploys continue without the registry. */
export const REGISTRY_FALLBACK_NOTE =
	"registry: ConfigService not writable, servers persist the head from the message";
