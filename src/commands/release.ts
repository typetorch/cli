/**
 * Pointing a branch at an (already approved) payload asset: shared by `deploy`, `rollback` and `promote`.
 *   lock the state dir -> seq -> message (signed for prod-channel branches) -> registry (when readable) -> deploy
 *   message -> durable head (DataStore `heads` + `deployments`, durablehead.ts) -> local log -> unlock
 *
 * Signing (plans/03 "Signed prod messages and heads"): a release to a prod-channel branch must come with a signer (both
 * keys, keyfiles.ts `loadSigner`); the message and the registry head get `sig` and `sigF`. Dev-channel releases are
 * never signed. Signatures are made only here, right before publishing: dry runs and proposals never hold one.
 *
 * One seq source (P-C1/S-L8): the seq is one above the highest in the registry (re-read inside the write) and the
 * state dir's log (re-read under the lock). When the registry is readable but the write fails, the release ABORTS
 * before the message: a deployment missing from a registry others read would let them reuse its seq.
 */
import type { Project } from "../config.ts";
import { appendLocalLog, liveHeads, mergeDeployments, nextSeqFrom, readLocalLog, type LocalDeployment } from "../deployments.ts";
import { debug, formatSeconds, info, warn, type Stopwatch } from "../log.ts";
import { nextSharedSeq, type SharedSeq } from "../seqstore.ts";
import { reportDurableHead, storeDurableHead, type DurableHeadResult } from "../durablehead.ts";
import type { BuildSources, Channel } from "../naming.ts";
import { DEPLOY_TOPIC, deployMessage, encodeDeployMessage, type DeployMessage, type OpenCloud } from "../opencloud.ts";
import type { DualSigner } from "../signing.ts";
import { recordDeployment, RegistryConflictError, writeRegistry, type RegistryApi, type RegistryDeployment } from "../registry.ts";
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
	/** A client with the deploy key (messaging + configs). */
	oc: OpenCloud;
	api?: RegistryApi;
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
	/** Dev-channel only: the message's `ro` (1-99). Not written to the registry head (see rollout.ts). */
	rollout?: number;
	/** The shared seq sources, already read (deploy reads them while it builds); else read under the lock. */
	sharedSeq?: SharedSeq;
	/** Extra fields for the local log line. */
	extra?: Partial<LocalDeployment>;
}

export interface ReleaseResult {
	entry: LocalDeployment;
	message: DeployMessage;
	registry: NonNullable<LocalDeployment["registry"]>;
	configVersion?: number;
	/** The head written into the game's DataStore (kernel 0.3.5 boots and follows it with no server running). */
	durable?: DurableHeadResult;
}

/** The registry is readable but could not be written: nothing was published. */
export class ReleaseAbortedError extends Error {
	override name = "ReleaseAbortedError";
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
	const { proj, oc, api, history, watch } = input;
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
		const decided = await nextSharedSeq(oc, proj.config.universeId, nextSeqFrom(history.snapshot?.value, local), input.sharedSeq);
		if (decided.how === "local" && decided.note) warn(`the shared seq isn't readable (${decided.note}); #${decided.seq} comes from this machine's log only`);
		else if (decided.how === "read" && decided.note) debug(`seq #${decided.seq} from the DataStore sources; the counter wasn't claimed: ${decided.note}`);
		const floor = decided.seq;
		let entry: RegistryDeployment | undefined;
		let message: DeployMessage | undefined;
		let registry: ReleaseResult["registry"];
		let configVersion: number | undefined;

		if (api && history.snapshot) {
			const started = performance.now();
			try {
				const result = await writeRegistry(
					api,
					{ message: registryMessage(input.action, input.branch, input.artifact.artifactId, input.note), force: input.force, dryRun: false },
					(current) => {
						entry = makeEntry(input, current, local, floor);
						message = messageFor(entry, signer, { rollout: input.rollout });
						return recordDeployment(current, entry);
					},
				);
				configVersion = result.configVersion;
				registry = result.changed ? "published" : "unchanged";
			} catch (error) {
				if (error instanceof RegistryConflictError) throw error;
				const retry =
					input.action === "deploy"
						? ` The upload is approved and recorded: once the registry works, \`typetorch promote ${input.branch} ${input.artifact.assetId}\` publishes it without a rebuild (or add --no-registry).`
						: " Fix the registry (or pass --no-registry) and run it again.";
				throw new ReleaseAbortedError(
					`the registry is readable but writing it failed, so nothing was published (a deployment missing from the registry could let another machine reuse its seq): ${(error as Error).message}.${retry}`,
				);
			}
			watch.set("registry", Math.round(performance.now() - started) / 1000);
			info(`  registry    ${formatSeconds(watch.timings.registry)}  ${registry}${configVersion !== undefined ? ` (config v${configVersion})` : ""}`);
		} else {
			registry = api ? "unavailable" : "skipped";
		}
		if (!entry || !message) {
			entry = makeEntry(input, history.snapshot?.value, local, floor);
			message = messageFor(entry, signer, { rollout: input.rollout });
		}

		const localEntry: LocalDeployment = {
			...entry,
			universeId: proj.config.universeId,
			project: proj.config.project,
			assetName: input.assetName,
			message: input.note,
			registry,
			configVersion,
			...(input.rollout !== undefined ? { rollout: input.rollout } : {}),
			seqSource: decided.how,
			...input.extra,
		};
		const text = encodeDeployMessage(message);
		try {
			await watch.stage("publish", () => oc.publishMessage(proj.config.universeId, DEPLOY_TOPIC, text));
		} catch (error) {
			// The registry may already point at it; log the seq as used so it is never handed out twice.
			if (registry === "published") appendLocalLog(history.stateDir, { ...localEntry, registry, timings: watch.total() }, "registry-only");
			throw error;
		}
		info(`  publish     ${formatSeconds(watch.timings.publish)}  ${DEPLOY_TOPIC} ${describeMessage(message)}`);
		// The durable head: servers that start later (or run but missed the message) find it even when no server on the
		// branch heard the message. A failure (missing scopes) is one warning; the deploy stands.
		const durable = await storeDurableHead(oc, proj.config.universeId, message);
		reportDurableHead(durable, message);
		const logged: LocalDeployment = { ...localEntry, timings: watch.total() };
		appendLocalLog(history.stateDir, logged);
		return { entry: logged, message, registry, configVersion, durable };
	});
}

/** The message for a log line: signatures shortened (they are public, but long). */
export function describeMessage(message: DeployMessage): string {
	const { sig, sigF, ...rest } = message;
	if (!sig && !sigF) return JSON.stringify(rest);
	return `${JSON.stringify(rest)} signed (sig ${sig?.slice(0, 8)}..., sigF ${sigF?.slice(0, 8)}...)`;
}
