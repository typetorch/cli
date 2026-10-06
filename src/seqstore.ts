/**
 * The shared seq: every machine (the owner's PC, CI, the remote-claude dev-server) must hand out deploy numbers from
 * the same sequence, because servers order heads by seq and ignore one at or below what they applied.
 *
 * Sources, all read through Open Cloud with the deploy key (API keys CAN have these scopes):
 *   1. the state dir's deployments.jsonl (this machine);
 *   2. (CLI 0.7: the ConfigService registry, never readable with an API key; gone in CLI 0.8);
 *   3. the game's DataStore "TypeTorch" (Open Cloud DataStores v2, `universe-datastores.objects:read`), written by the
 *      kernel's live servers: `heads` ({ [branch]: { seq, ... } }) and `deployments` ({ list: [{ seq, ... }] }). A
 *      server that hears a deploy message records it, so these lag only while NO server runs in the universe;
 *   4. the key `seq` in the same DataStore: a counter the CLI itself claims through the atomic `:increment` endpoint
 *      (`universe-datastores.objects:create` + `:update`). Each increment returns a value no other caller gets, so two
 *      machines deploying at once never share a seq, servers or not.
 * Next seq = the counter's claim when the key can write it (at least one above every source), else
 * max(1, 2, 3) + 1.
 */
import type { OpenCloud } from "./opencloud.ts";

export const SEQ_DATASTORE = "TypeTorch";
export const HEADS_KEY = "heads";
export const DEPLOYMENTS_KEY = "deployments";
export const SEQ_KEY = "seq";
export const DS_READ_SCOPE = "universe-datastores.objects:read";
export const DS_WRITE_SCOPES = "universe-datastores.objects:create and universe-datastores.objects:update";

type Requester = Pick<OpenCloud, "request">;

function entryPath(universeId: number, key: string): string {
	return `/cloud/v2/universes/${universeId}/data-stores/${encodeURIComponent(SEQ_DATASTORE)}/entries/${encodeURIComponent(key)}`;
}

const seqOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** The highest seq in the kernel's `heads` value ({ [branch]: head }). */
export function highestInHeads(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let highest: number | undefined;
	for (const head of Object.values(value as Record<string, unknown>)) {
		const seq = seqOf((head as { seq?: unknown } | null)?.seq);
		if (seq !== undefined) highest = Math.max(highest ?? 0, seq);
	}
	return highest;
}

/** The highest seq in the kernel's `deployments` value ({ list: [...] }; a bare list is read too). */
export function highestInDeployments(value: unknown): number | undefined {
	const list = Array.isArray(value) ? value : Array.isArray((value as { list?: unknown } | null)?.list) ? (value as { list: unknown[] }).list : [];
	let highest: number | undefined;
	for (const entry of list) {
		const seq = seqOf((entry as { seq?: unknown } | null)?.seq);
		if (seq !== undefined) highest = Math.max(highest ?? 0, seq);
	}
	return highest;
}

/** An entry's value as the API returns it (a JSON value; a value stored as a JSON string is decoded too). */
function decode(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

export interface SharedSeq {
	/** At least one source answered (a missing entry counts: the universe has no deploys yet). */
	readable: boolean;
	/** The highest seq found (undefined: none yet). */
	highest?: number;
	heads?: number;
	deployments?: number;
	/** The CLI's counter (`seq`). */
	counter?: number;
	/** Why it isn't readable. */
	error?: string;
	scopeMissing?: boolean;
}

/** Reads `heads`, `deployments` and `seq` in parallel. Never throws. */
export async function readSharedSeq(oc: Requester, universeId: number): Promise<SharedSeq> {
	const keys = [HEADS_KEY, DEPLOYMENTS_KEY, SEQ_KEY] as const;
	const read = async (key: string): Promise<{ ok: boolean; value?: unknown; status?: number; error?: string }> => {
		try {
			const response = await oc.request("GET", entryPath(universeId, key), { label: `DataStore ${SEQ_DATASTORE}/${key}` });
			if (response.status === 404) return { ok: true };
			if (!response.ok) return { ok: false, status: response.status, error: `${response.status} ${response.text.slice(0, 200)}` };
			return { ok: true, value: decode(response.body?.value) };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	};
	const [heads, deployments, counter] = await Promise.all(keys.map(read));
	const result: SharedSeq = { readable: heads.ok || deployments.ok || counter.ok };
	if (heads.ok) result.heads = highestInHeads(heads.value);
	if (deployments.ok) result.deployments = highestInDeployments(deployments.value);
	if (counter.ok) result.counter = seqOf(counter.value);
	const found = [result.heads, result.deployments, result.counter].filter((n): n is number => n !== undefined);
	if (found.length) result.highest = Math.max(...found);
	if (!result.readable) {
		const failed = [heads, deployments, counter].find((r) => !r.ok)!;
		result.scopeMissing = failed.status === 401 || failed.status === 403;
		result.error = result.scopeMissing ? `the deploy key needs ${DS_READ_SCOPE} (${failed.error})` : (failed.error ?? "unknown");
	}
	return result;
}

/**
 * Claims a seq of at least `atLeast` from the counter: one atomic `:increment` by (atLeast - counter), so the returned
 * value is this caller's alone. `counter` is the value just read (undefined: missing). Never throws.
 */
export async function claimSeq(oc: Requester, universeId: number, atLeast: number, counter: number | undefined): Promise<{ seq?: number; error?: string; scopeMissing?: boolean }> {
	const amount = Math.max(1, atLeast - (counter ?? 0));
	try {
		const response = await oc.request("POST", `${entryPath(universeId, SEQ_KEY)}:increment`, { json: { amount }, label: "claim the next seq" });
		if (!response.ok) {
			const scopeMissing = response.status === 401 || response.status === 403;
			return { scopeMissing, error: scopeMissing ? `the deploy key needs ${DS_WRITE_SCOPES} to claim seqs (${response.status})` : `${response.status} ${response.text.slice(0, 200)}` };
		}
		const seq = seqOf(decode(response.body?.value));
		return seq !== undefined ? { seq } : { error: `the counter answered ${JSON.stringify(response.body).slice(0, 200)}` };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

export interface SeqDecision {
	seq: number;
	/** "counter": claimed atomically; "read": max of the sources + 1; "local": this machine's log only. */
	how: "counter" | "read" | "local";
	shared?: SharedSeq;
	note?: string;
}

/**
 * The seq for a release: `localNext` (the local log) and the shared sources, claimed through the counter when the key
 * may write it. `oc` undefined (tests, dry runs without a key): local only.
 */
export async function nextSharedSeq(oc: Requester | undefined, universeId: number, localNext: number, read?: SharedSeq): Promise<SeqDecision> {
	if (!oc || typeof oc.request !== "function") return { seq: localNext, how: "local" };
	const shared = read ?? (await readSharedSeq(oc, universeId));
	const atLeast = Math.max(localNext, (shared.highest ?? 0) + 1);
	if (!shared.readable) return { seq: atLeast, how: "local", shared, note: shared.error };
	const claimed = await claimSeq(oc, universeId, atLeast, shared.counter);
	if (claimed.seq !== undefined) return { seq: claimed.seq, how: "counter", shared };
	return { seq: atLeast, how: "read", shared, note: claimed.error };
}

export function describeShared(shared: SharedSeq | undefined): string {
	if (!shared) return "not read";
	if (!shared.readable) return `not readable: ${shared.error}`;
	const parts = [`heads ${shared.heads ?? "-"}`, `deployments ${shared.deployments ?? "-"}`, `counter ${shared.counter ?? "-"}`];
	return `DataStore ${SEQ_DATASTORE}: ${parts.join(", ")}`;
}
