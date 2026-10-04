/**
 * Pointing a branch at an (already approved) payload asset: shared by `deploy`, `rollback` and `promote`.
 *   lock the state dir -> seq -> message -> registry (when readable) -> deploy message -> local log -> unlock
 *
 * One seq source (P-C1/S-L8): the seq is one above the highest in the registry (re-read inside the write) and the
 * state dir's log (re-read under the lock). When the registry is readable but the write fails, the release ABORTS
 * before the message: a deployment missing from a registry others read would let them reuse its seq.
 */
import type { Project } from "../config";
import { appendLocalLog, liveHeads, mergeDeployments, nextSeqFrom, readLocalLog, type LocalDeployment } from "../deployments";
import { formatSeconds, info, type Stopwatch } from "../log";
import type { BuildSources, Channel } from "../naming";
import { DEPLOY_TOPIC, deployMessage, encodeDeployMessage, type DeployMessage, type OpenCloud } from "../opencloud";
import { recordDeployment, RegistryConflictError, writeRegistry, type RegistryApi, type RegistryDeployment } from "../registry";
import { withStateLock } from "../state";
import type { History } from "./common";

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
	/** Extra fields for the local log line. */
	extra?: Partial<LocalDeployment>;
}

export interface ReleaseResult {
	entry: LocalDeployment;
	message: DeployMessage;
	registry: NonNullable<LocalDeployment["registry"]>;
	configVersion?: number;
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
): RegistryDeployment {
	const heads = liveHeads(registryValue, mergeDeployments(registryValue?.deployments ?? [], local));
	const previous = heads.get(input.branch);
	const entry: RegistryDeployment = {
		seq: nextSeqFrom(registryValue, local),
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

/** The deploy message for an entry; its t/r are copied onto the entry so the registry head carries them. */
export function messageFor(entry: RegistryDeployment): DeployMessage {
	const message = deployMessage({
		b: entry.branch,
		a: entry.assetId,
		i: entry.artifactId,
		s: entry.seq,
		c: entry.commit,
		ch: entry.channel,
		rollback: entry.action === "rollback",
	});
	entry.t = message.t;
	if (message.r === 1) entry.r = 1;
	encodeDeployMessage(message); // fail before anything is written when it is over 1 KiB
	return message;
}

export function registryMessage(action: string, branch: string, artifactId: string, note?: string): string {
	return `typetorch ${action} ${branch} ${artifactId}${note ? `: ${note}` : ""}`;
}

export async function release(input: ReleaseInput): Promise<ReleaseResult> {
	const { proj, oc, api, history, watch } = input;
	return withStateLock(history.stateDir, `${input.action} ${input.branch} ${input.artifact.artifactId}`, async () => {
		// Re-read the log under the lock: another deploy from this machine may have appended since history was read.
		const local = readLocalLog(history.stateDir, proj.config.universeId);
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
						entry = makeEntry(input, current, local);
						message = messageFor(entry);
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
			entry = makeEntry(input, history.snapshot?.value, local);
			message = messageFor(entry);
		}

		const localEntry: LocalDeployment = {
			...entry,
			universeId: proj.config.universeId,
			project: proj.config.project,
			assetName: input.assetName,
			message: input.note,
			registry,
			configVersion,
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
		info(`  publish     ${formatSeconds(watch.timings.publish)}  ${DEPLOY_TOPIC} ${JSON.stringify(message)}`);
		const logged: LocalDeployment = { ...localEntry, timings: watch.total() };
		appendLocalLog(history.stateDir, logged);
		return { entry: logged, message, registry, configVersion };
	});
}
