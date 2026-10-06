/**
 * The deployment data model: branch heads and deployment entries, as the local log and `typetorch deployments` keep
 * them (deployments.ts), in the shape the old ConfigService registry value had ({ branches, deployments, ... }).
 *
 * CLI 0.8 (kernel 0.3.8, plans/20): the ConfigService registry itself is gone. It was never readable with an API key
 * (universe:read is OAuth-only), so deploys always ran without it: heads reach servers through deploy messages and the
 * durable DataStore copy (durablehead.ts), the seq comes from seqstore.ts, and the project settings (defaultBranch,
 * channels, dev access, fleet, analytics, game values) live in the signed settings record (settings.ts).
 */
import { isRecord } from "./json.ts";
import type { BuildSources, Channel } from "./naming.ts";
import type { ProjectConfig, Role } from "./config.ts";

export const REGISTRY_KEY = "TypeTorch";
export const REPOSITORY = "InExperienceConfig";
export const MAX_DEPLOYMENTS = 25;
/** The configs API limits a value to 10,000 characters; keep a margin. */
export const MAX_VALUE_CHARS = 9_500;

/**
 * A branch's live head. Heads are ordered by (seq, time): the higher seq wins, and on equal seq the later deployedAt
 * (`t` when present). `t`, `r`, `sig` and `sigF` are the deploy message's fields, so a kernel verifies a prod head
 * exactly like the message it came from (plans/03 "Heads and stored records").
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
	/** 1 when the message was a rollback; "resign" for a head re-signed by `keys rotate`. */
	r?: 1 | "resign";
	/** Prod-channel branches: the message's signatures (main and fallback key). */
	sig?: string;
	sigF?: string;
	/** Commits of the game and the @typetorch packages in the payload. */
	sources?: BuildSources;
}

export interface RegistryDeployment {
	seq: number;
	at: string;
	/** "resign": `keys rotate` re-signed the branch's current head (same artifact, new seq). */
	action: "deploy" | "rollback" | "promote" | "resign";
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
	/** The deploy message's `t`, `r`, `sig` and `sigF` (kept on the branch head; not in the registry's deployments list). */
	t?: number;
	r?: 1 | "resign";
	sig?: string;
	sigF?: string;
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
	if (entry.r !== undefined) head.r = entry.r;
	if (entry.sig) head.sig = entry.sig;
	if (entry.sigF) head.sigF = entry.sigF;
	if (entry.sources) head.sources = entry.sources;
	return head;
}

/** Points `entry.branch` at the entry's artifact and appends the entry (then trims to the limits). */
export function recordDeployment(value: RegistryValue, entry: RegistryDeployment): RegistryValue {
	const next: RegistryValue = structuredClone(value);
	next.branches[entry.branch] = headFromDeployment(entry);
	const { t: _t, r: _r, sig: _sig, sigF: _sigF, ...listed } = entry; // the head carries the message fields; keep the list small
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
