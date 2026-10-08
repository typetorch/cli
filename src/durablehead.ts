/**
 * Durable branch heads (for kernel 0.3.5). After a deploy message goes out (`release`: deploy, promote, rollback,
 * approve, the automatic rollback; and `deploy --widen`), the CLI also writes the head into the game's DataStore
 * "TypeTorch", in the shapes the kernel itself stores from a deploy message (Registry.luau saveHead):
 *   - `heads`: { [branch]: { assetId, artifactId, seq, commit, channel, deployedAt, rollback?, r?, rollout?, t, sig?,
 *     sigF? } } (prod heads carry the message's signatures, so prod servers can check them);
 *   - `deployments`: { list: [...] }, newest first, at most 100: the history entry of this deploy.
 *
 * Why: only a server that hears a deploy message records the head, and the ConfigService registry (gone in CLI 0.8)
 * couldn't be written with an API key, so a deploy made while no server of that branch ran reached nobody (new servers booted the old
 * head). Kernel 0.3.5 reads this copy at boot and about every 60 s, follows a newer head, and writes the MemoryStore
 * copy back when it is behind.
 *
 * The write is a read-merge-write guarded by the entry's version (Open Cloud DataStores v1: Get Entry answers
 * `roblox-entry-version`, Set Entry takes `matchVersion`, or `exclusiveCreate` for a key that doesn't exist yet), so it
 * never overwrites a game server's concurrent UpdateAsync: on a conflict it reads again and retries. v1, not v2, for the
 * write: v2's PATCH has been reported on the DevForum to refuse JSON object values. A branch's seq is never lowered:
 * the kernel's `replaces` rule decides (a higher seq; or the same deploy re-sent later with another rollout %), and a
 * signed head is never replaced by an unsigned one. Scopes: universe-datastores.objects:read, :create and :update (the
 * shared seq's). Without them the deploy still succeeds, with one warning line.
 *
 * CLI 0.8.1 (kernel 0.3.9): `heads.<branch>` also keeps the branch's last PREV_HEADS_KEPT (3) heads before it as `prev`
 * (newest first, the same shape without a `prev` of its own), so `/tt rollback` on a server that booted straight into a
 * bad build can still go back (a server-local swap; prod servers take only a previous head whose signature verifies).
 * Kernels 0.3.9+ keep the list on their own durable writes too; older kernels and older records simply have none.
 */
import { createHash } from "node:crypto";
import { debug, info, warn } from "./log.ts";
import type { DeployMessage, OpenCloud } from "./opencloud.ts";
import { DEPLOYMENTS_KEY, HEADS_KEY, SEQ_DATASTORE } from "./seqstore.ts";

/** The kernel keeps this many deployments (Constants.DEPLOYMENTS_KEPT). */
export const DEPLOYMENTS_KEPT = 100;
/** Read-merge-write attempts per key (a conflict = a server wrote the key between our read and write). */
const ATTEMPTS = 5;
export const DURABLE_SCOPES = "universe-datastores.objects:read, :create and :update";
export const NOT_DURABLE = "the head isn't stored durably: deploys reach only running servers";

type Requester = Pick<OpenCloud, "request">;

/** A branch head as the kernel stores it. */
export interface KernelHead {
	assetId: number;
	artifactId: string;
	seq: number;
	commit: string;
	channel: string;
	deployedAt: string;
	rollback?: true;
	r?: 1 | "resign";
	rollout?: number;
	t: number;
	sig?: string;
	sigF?: string;
	/** CLI 0.8.1 / kernel 0.3.9: the branch's previous heads, newest first (DataStore copy only). */
	prev?: KernelHead[];
}

/** How many previous heads `heads.<branch>.prev` keeps (kernel Constants.PREV_HEADS_KEPT). */
export const PREV_HEADS_KEPT = 3;

/** A deployment history entry as the kernel stores it (Registry.luau cleanDeployment). */
export interface KernelDeployment {
	seq: number;
	branch: string;
	channel: string;
	artifactId: string;
	assetId: number;
	commit: string;
	at: string;
	rollback?: true;
	r?: 1 | "resign";
	rollout?: number;
	t: number;
	sig?: string;
	sigF?: string;
}

/** The kernel's ISO time ("2026-10-05T14:27:45Z", no milliseconds, like DateTime:ToIsoDate). */
function isoSeconds(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The head the kernel would store from `message` (Kernel.server.luau onDeployMessage). */
export function kernelHead(message: DeployMessage, at = new Date()): KernelHead {
	const head: KernelHead = { assetId: message.a, artifactId: message.i, seq: message.s, commit: message.c, channel: message.ch, deployedAt: isoSeconds(at), t: message.t };
	if (message.r === 1) head.rollback = true;
	if (message.r !== undefined) head.r = message.r;
	if (message.ro !== undefined && message.ro < 100) head.rollout = message.ro;
	if (message.sig) head.sig = message.sig;
	if (message.sigF) head.sigF = message.sigF;
	return head;
}

/** The history entry the kernel would store from `message`. */
export function kernelDeployment(message: DeployMessage, at = new Date()): KernelDeployment {
	const { deployedAt, ...head } = kernelHead(message, at);
	return { ...head, branch: message.b, at: deployedAt };
}

function isHead(value: unknown): value is Record<string, unknown> & { assetId: number } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { assetId?: unknown }).assetId === "number";
}

const isSigned = (head: Record<string, unknown>) => typeof head.sig === "string" || typeof head.sigF === "string";

/**
 * Whether `head` should replace `stored` (the kernel's `replaces`, without signature checks): a higher seq, or the same
 * deploy re-sent later (newer `t`) with another rollout %. Never a lower seq, and never an unsigned head over a signed
 * one.
 */
export function headReplaces(stored: unknown, head: KernelHead): boolean {
	if (!isHead(stored)) return true;
	if (isSigned(stored) && !isSigned(head as unknown as Record<string, unknown>)) return false;
	const storedSeq = typeof stored.seq === "number" ? stored.seq : 0;
	if (head.seq !== storedSeq) return head.seq > storedSeq;
	if (stored.assetId !== head.assetId || stored.rollout === head.rollout) return false;
	const storedAt = typeof stored.t === "number" ? stored.t : 0;
	return head.t > storedAt;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** One `prev` entry: the head's own fields (as stored), never a `prev` of its own. */
function prevEntry(value: unknown): KernelHead | undefined {
	if (!isHead(value)) return undefined;
	const entry: Record<string, unknown> = { ...value };
	delete entry.prev;
	return entry as unknown as KernelHead;
}

/**
 * `head` as stored over `stored` (the branch's head before it): with `prev` = `stored` then its own `prev`, newest
 * first, at most PREV_HEADS_KEPT, never `head` itself; the same deploy written again keeps the list it had. The same
 * rule as the kernel's Registry.luau withPrev.
 */
export function withPrev(head: KernelHead, stored: unknown): KernelHead {
	const copy: KernelHead = { ...head };
	delete copy.prev;
	const list: KernelHead[] = [];
	const seen = new Set<string>();
	const add = (value: unknown) => {
		const entry = prevEntry(value);
		if (!entry || list.length >= PREV_HEADS_KEPT) return;
		if (entry.assetId === copy.assetId && entry.seq === copy.seq) return;
		const key = `${entry.assetId}#${entry.seq}`;
		if (seen.has(key)) return;
		seen.add(key);
		list.push(entry);
	};
	if (isHead(stored)) {
		if (!(stored.assetId === head.assetId && stored.seq === head.seq)) add(stored);
		const storedPrev = (stored as { prev?: unknown }).prev;
		if (Array.isArray(storedPrev)) for (const entry of storedPrev) add(entry);
	}
	return list.length > 0 ? { ...copy, prev: list } : copy;
}

/** `heads` with the branch's head merged in (its `prev` kept), or undefined when it already holds this (or a newer) head. */
export function mergeHeads(existing: unknown, branch: string, head: KernelHead): Record<string, unknown> | undefined {
	const heads = { ...(plainObject(existing) ?? {}) };
	if (!headReplaces(heads[branch], head)) return undefined;
	heads[branch] = withPrev(head, heads[branch]);
	return heads;
}

const deploymentKey = (entry: { branch?: unknown; seq?: unknown; assetId?: unknown }) =>
	typeof entry.seq === "number" ? `${entry.branch}#${entry.seq}` : `${entry.branch}@${entry.assetId}`;

/** `deployments` ({list}) with the entry added (newest first, at most 100), or undefined when it is already there. */
export function mergeDeploymentList(existing: unknown, entry: KernelDeployment): { list: unknown[] } | undefined {
	const object = plainObject(existing);
	const list = Array.isArray(object?.list) ? [...(object.list as unknown[])] : Array.isArray(existing) ? [...existing] : [];
	const key = deploymentKey(entry);
	if (list.some((item) => plainObject(item) && deploymentKey(item as KernelDeployment) === key)) return undefined;
	list.push(entry);
	const seqOf = (item: unknown) => (typeof plainObject(item)?.seq === "number" ? (plainObject(item)!.seq as number) : -1);
	list.sort((a, b) => seqOf(b) - seqOf(a));
	return { list: list.slice(0, DEPLOYMENTS_KEPT) };
}

function entryPath(universeId: number, key: string, extra = ""): string {
	return `/datastores/v1/universes/${universeId}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(SEQ_DATASTORE)}&entryKey=${encodeURIComponent(key)}${extra}`;
}

/** An entry's value as read (a value stored as a JSON string is decoded too). */
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

export interface KeyWrite {
	/** "written": this call wrote it; "unchanged": the key already had it. */
	outcome?: "written" | "unchanged";
	error?: string;
	scopeMissing?: boolean;
}

const scopeError = (status: number) => status === 401 || status === 403;

/** Read, merge, write with `matchVersion` (or `exclusiveCreate`), retried on conflicts. Never throws. */
export async function updateEntry(oc: Requester, universeId: number, key: string, merge: (value: unknown) => unknown | undefined): Promise<KeyWrite> {
	try {
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const read = await oc.request("GET", entryPath(universeId, key), { label: `DataStore ${SEQ_DATASTORE}/${key}` });
			if (scopeError(read.status)) return { scopeMissing: true, error: `${read.status} ${read.text.slice(0, 160)}` };
			const missing = read.status === 404 || read.status === 204;
			if (!missing && !read.ok) return { error: `read ${key}: ${read.status} ${read.text.slice(0, 160)}` };
			const version = read.headers.get("roblox-entry-version");
			if (!missing && !version) return { error: `read ${key}: no roblox-entry-version header` };
			const next = merge(missing ? undefined : decode(read.body));
			if (next === undefined) return { outcome: "unchanged" };
			const body = JSON.stringify(next);
			const md5 = createHash("md5").update(body, "utf8").digest("base64");
			const guard = missing ? "&exclusiveCreate=true" : `&matchVersion=${encodeURIComponent(version!)}`;
			const write = await oc.request("POST", entryPath(universeId, key, guard), {
				headers: { "content-type": "application/json", "content-md5": md5 },
				body,
				retry: true,
				label: `store ${key}`,
			});
			if (write.ok) return { outcome: "written" };
			if (scopeError(write.status)) return { scopeMissing: true, error: `${write.status} ${write.text.slice(0, 160)}` };
			// Someone wrote the key between the read and the write (a version mismatch, or it was created meanwhile).
			if (write.status === 409 || write.status === 412) {
				debug(`DataStore ${SEQ_DATASTORE}/${key}: changed since the read (${write.status}), attempt ${attempt}`);
				continue;
			}
			return { error: `write ${key}: ${write.status} ${write.text.slice(0, 160)}` };
		}
		return { error: `${key} kept changing (${ATTEMPTS} attempts)` };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

export interface DurableHeadResult {
	heads: KeyWrite;
	deployments: KeyWrite;
	/** Skipped: the client can't make requests (tests' fakes, dry runs). */
	skipped?: boolean;
}

/** Writes the message's head and history entry into the DataStore (both keys at once). Never throws. */
export async function storeDurableHead(oc: Requester | undefined, universeId: number, message: DeployMessage, at = new Date()): Promise<DurableHeadResult> {
	if (!oc || typeof oc.request !== "function") return { heads: {}, deployments: {}, skipped: true };
	const head = kernelHead(message, at);
	const entry = kernelDeployment(message, at);
	const [heads, deployments] = await Promise.all([
		updateEntry(oc, universeId, HEADS_KEY, (value) => mergeHeads(value, message.b, head)),
		updateEntry(oc, universeId, DEPLOYMENTS_KEY, (value) => mergeDeploymentList(value, entry)),
	]);
	return { heads, deployments };
}

/** One line: what was stored, or the warning (the deploy itself still succeeded). */
export function reportDurableHead(result: DurableHeadResult, message: DeployMessage): void {
	if (result.skipped) return;
	const { heads, deployments } = result;
	if (heads.scopeMissing || deployments.scopeMissing) {
		warn(`${NOT_DURABLE} (the deploy key needs ${DURABLE_SCOPES})`);
		return;
	}
	if (heads.error) {
		warn(`${NOT_DURABLE} (${heads.error})`);
		return;
	}
	if (deployments.error) debug(`DataStore ${SEQ_DATASTORE}/${DEPLOYMENTS_KEY} not updated: ${deployments.error}`);
	info(`  stored      DataStore ${SEQ_DATASTORE} ${HEADS_KEY}.${message.b} = #${message.s} (${heads.outcome === "written" ? "written" : "already there"})`);
}
