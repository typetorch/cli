/**
 * Pointing a branch at an (already approved) payload asset: shared by `deploy`, `rollback` and `promote`.
 *   lock the state dir -> seq -> message (signed for prod-channel branches) -> deploy message -> durable head
 *   (DataStore `heads` + `deployments`, durablehead.ts) -> local log -> unlock
 *
 * Signing (plans/03 "Signed prod messages and heads"): a release to a prod-channel branch must come with a signer (both
 * keys, keyfiles.ts `loadSigner`); the message and the durable head get `sig` and `sigF`. Dev-channel releases are
 * never signed. Signatures are made only here, right before publishing: dry runs and proposals never hold one.
 *
 * One seq source (P-C1/S-L8): the shared seq (seqstore.ts: the DataStore counter, else the kernel's DataStore heads,
 * else this machine's log, re-read under the lock). CLI 0.8: the ConfigService registry is gone (it was never readable
 * with an API key; plans/20); the local log keeps `registry: "skipped"`.
 */
import type { Project } from "../config.ts";
import { appendLocalLog, liveHeads, mergeDeployments, nextSeqFrom, readLocalLog, type LocalDeployment } from "../deployments.ts";
import { debug, formatSeconds, info, warn, type Stopwatch } from "../log.ts";
import { nextSharedSeq, type SharedSeq } from "../seqstore.ts";
import { reportDurableHead, storeDurableHead, type DurableHeadResult } from "../durablehead.ts";
import type { BuildSources, Channel } from "../naming.ts";
import { DEPLOY_TOPIC, deployMessage, encodeDeployMessage, type DeployMessage, type OpenCloud } from "../opencloud.ts";
import type { DualSigner } from "../signing.ts";
import type { RegistryDeployment } from "../registry.ts";
import { withStateLock } from "../state.ts";
import type { History } from "./common.ts";

export interface ReleaseArtifact {
	artifactId: string;
	assetId: number;
	channel: Channel;
	commit: string;
	commitHash: string;
	dirty: boolean;
	sources?: BuildSources;
}

export interface ReleaseInput {
	proj: Project;
	/** A client with the deploy key (messaging + DataStores). */
	oc: OpenCloud;
	history: History;
	action: RegistryDeployment["action"];
	branch: string;
	artifact: ReleaseArtifact;
	by: string;
	force: boolean;
	note?: string;
	assetName?: string;
	watch: Stopwatch;
	/** The target branch's channel: prod-channel releases are signed and need `signer`. */
	branchChannel: Channel;
	/** Both signing keys; required for a prod-channel branch, never used for a dev-channel one. */
	signer?: DualSigner;
	/** Dev-channel only: the message's `ro` (1-99). Not written to the durable head (see rollout.ts). */
	rollout?: number;
	/** The shared seq sources, already read (deploy reads them while it builds); else read under the lock. */
	sharedSeq?: SharedSeq;
	/** Extra fields for the local log line. */
	extra?: Partial<LocalDeployment>;
}

export interface ReleaseResult {
	entry: LocalDeployment;
	message: DeployMessage;
	/** Always "skipped" since CLI 0.8 (no ConfigService registry). */
	registry: NonNullable<LocalDeployment["registry"]>;
	/** The head written into the game's DataStore (kernel 0.3.5 boots and follows it with no server running). */
	durable?: DurableHeadResult;
}

/** The deployment entry for `branch`, with seq and "from" taken from what is known (registry value + local log). */
export function makeEntry(
	input: Pick<ReleaseInput, "action" | "branch" | "artifact" | "by">,
	registryValue: Parameters<typeof nextSeqFrom>[0],
	local: LocalDeployment[],
	/** The shared seq (seqstore.ts) when known: the entry takes at least this. */
	floor?: number,
): RegistryDeployment {
	const heads = liveHeads(registryValue, mergeDeployments(registryValue?.deployments ?? [], local));
	const previous = heads.get(input.branch);
	const entry: RegistryDeployment = {
		seq: Math.max(nextSeqFrom(registryValue, local), floor ?? 0),
		at: new Date().toISOString(),
		action: input.action,
		branch: input.branch,
		channel: input.artifact.channel,
		artifactId: input.artifact.artifactId,
		assetId: input.artifact.assetId,
		commit: input.artifact.commit,
		commitHash: input.artifact.commitHash,
		dirty: input.artifact.dirty,
		by: input.by,
	};
	if (input.artifact.sources) entry.sources = input.artifact.sources;
	if (previous) {
		entry.fromAssetId = previous.assetId;
		entry.fromArtifactId = previous.artifactId;
	}
	return entry;
}

/** A signature-sized stand-in for dry runs (they never sign: a printed real signature could be published by anyone). */
export const SIGNATURE_PLACEHOLDER = "<signature: 88 base64 characters, made when published>".padEnd(88, ".");

/**
 * The deploy message for an entry, signed with both keys when `signer` is given; its t/r/sig/sigF are copied onto the
 * entry so the registry head carries them. `placeholders` (dry runs) puts signature-sized stand-ins in instead.
 */
export function messageFor(entry: RegistryDeployment, signer?: DualSigner, options: { placeholders?: boolean; rollout?: number } = {}): DeployMessage {
	const message = deployMessage(
		{
			b: entry.branch,
			a: entry.assetId,
			i: entry.artifactId,
			s: entry.seq,
			c: entry.commit,
			ch: entry.channel,
			rollback: entry.action === "rollback",
			resign: entry.action === "resign",
			...(options.rollout !== undefined ? { rollout: options.rollout } : {}),
		},
		signer,
	);
	if (!signer && options.placeholders) Object.assign(message, { sig: SIGNATURE_PLACEHOLDER, sigF: SIGNATURE_PLACEHOLDER });
	entry.t = message.t;
	if (message.r !== undefined) entry.r = message.r;
	if (signer && message.sig && message.sigF) {
		entry.sig = message.sig;
		entry.sigF = message.sigF;
	}
	encodeDeployMessage(message); // fail before anything is written when it is over 1 KiB
	return message;
}

export class SigningRequiredError extends Error {
	override name = "SigningRequiredError";
}

export function registryMessage(action: string, branch: string, artifactId: string, note?: string): string {
	return `typetorch ${action} ${branch} ${artifactId}${note ? `: ${note}` : ""}`;
}

export async function release(input: ReleaseInput): Promise<ReleaseResult> {
	const { proj, oc, history, watch } = input;
	// Prod-channel branches are signed (both keys); dev-channel ones never are.
	if (input.branchChannel === "prod" && !input.signer) {
		throw new SigningRequiredError(`${input.branch} is a prod-channel branch: its deploy message must be signed, and no signing keys were loaded`);
	}
	const signer = input.branchChannel === "prod" ? input.signer : undefined;
	return withStateLock(history.stateDir, `${input.action} ${input.branch} ${input.artifact.artifactId}`, async () => {
		// Re-read the log under the lock: another deploy from this machine may have appended since history was read.
		const local = readLocalLog(history.stateDir, proj.config.universeId);
		// The shared seq (seqstore.ts): claimed from the DataStore counter when the deploy key may, else the highest of the
		// kernel's DataStore heads/deployments + 1, else this machine's log (with a warning).
		const decided = await nextSharedSeq(oc, proj.config.universeId, nextSeqFrom(undefined, local), input.sharedSeq);
		if (decided.how === "local" && decided.note) warn(`the shared seq isn't readable (${decided.note}); #${decided.seq} comes from this machine's log only`);
		else if (decided.how === "read" && decided.note) debug(`seq #${decided.seq} from the DataStore sources; the counter wasn't claimed: ${decided.note}`);
		const floor = decided.seq;
		const entry = makeEntry(input, undefined, local, floor);
		const message = messageFor(entry, signer, { rollout: input.rollout });
		const registry: ReleaseResult["registry"] = "skipped";

		const localEntry: LocalDeployment = {
			...entry,
			universeId: proj.config.universeId,
			project: proj.config.project,
			assetName: input.assetName,
			message: input.note,
			registry,
			...(input.rollout !== undefined ? { rollout: input.rollout } : {}),
			seqSource: decided.how,
			...input.extra,
		};
		const text = encodeDeployMessage(message);
		await watch.stage("publish", () => oc.publishMessage(proj.config.universeId, DEPLOY_TOPIC, text));
		info(`  publish     ${formatSeconds(watch.timings.publish)}  ${DEPLOY_TOPIC} ${describeMessage(message)}`);
		// The durable head: servers that start later (or run but missed the message) find it even when no server on the
		// branch heard the message. A failure (missing scopes) is one warning; the deploy stands.
		const durable = await storeDurableHead(oc, proj.config.universeId, message);
		reportDurableHead(durable, message);
		const logged: LocalDeployment = { ...localEntry, timings: watch.total() };
		appendLocalLog(history.stateDir, logged);
		return { entry: logged, message, registry, durable };
	});
}

/** The message for a log line: signatures shortened (they are public, but long). */
export function describeMessage(message: DeployMessage): string {
	const { sig, sigF, ...rest } = message;
	if (!sig && !sigF) return JSON.stringify(rest);
	return `${JSON.stringify(rest)} signed (sig ${sig?.slice(0, 8)}..., sigF ${sigF?.slice(0, 8)}...)`;
}
