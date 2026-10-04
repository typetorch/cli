/**
 * Pointing a branch at an (already approved) payload asset: shared by `deploy` and `rollback`.
 *   registry (when usable) -> deploy message -> local log
 * The deploy message is what moves live servers (and they persist it as their branch head), so a registry that can't
 * be written is a warning, not a failure.
 */
import type { Project } from "../config";
import { appendLocalLog, liveHeads, mergeDeployments, nextSeqFrom, type LocalDeployment } from "../deployments";
import { formatSeconds, info, warn, type Stopwatch } from "../log";
import type { Channel } from "../naming";
import { DEPLOY_TOPIC, deployMessage, type DeployMessage, type OpenCloud } from "../opencloud";
import {
	recordDeployment,
	RegistryConflictError,
	RegistryUnavailableError,
	writeRegistry,
	type RegistryApi,
	type RegistryDeployment,
} from "../registry";
import { warnRegistryFallback, type History } from "./common";

export interface ReleaseArtifact {
	artifactId: string;
	assetId: number;
	channel: Channel;
	commit: string;
	commitHash: string;
	dirty: boolean;
}

export interface ReleaseInput {
	proj: Project;
	oc: OpenCloud;
	api?: RegistryApi;
	history: History;
	action: "deploy" | "rollback";
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
	if (previous) {
		entry.fromAssetId = previous.assetId;
		entry.fromArtifactId = previous.artifactId;
	}
	return entry;
}

export function registryMessage(action: string, branch: string, artifactId: string, note?: string): string {
	return `typetorch ${action} ${branch} ${artifactId}${note ? `: ${note}` : ""}`;
}

export async function release(input: ReleaseInput): Promise<ReleaseResult> {
	const { proj, oc, api, history, watch } = input;
	let entry: RegistryDeployment | undefined;
	let registry: ReleaseResult["registry"] = "unavailable";
	let configVersion: number | undefined;

	if (api && history.snapshot) {
		const started = performance.now();
		try {
			const result = await writeRegistry(
				api,
				{ message: registryMessage(input.action, input.branch, input.artifact.artifactId, input.note), force: input.force, dryRun: false },
				(current) => {
					entry = makeEntry(input, current, history.local);
					return recordDeployment(current, entry);
				},
			);
			configVersion = result.configVersion;
			registry = result.changed ? "published" : "unchanged";
		} catch (error) {
			if (error instanceof RegistryConflictError) throw error;
			if (error instanceof RegistryUnavailableError) {
				warnRegistryFallback(error.message);
				registry = "unavailable";
			} else {
				warn(`registry write failed (${(error as Error).message}); continuing with the deploy message`);
				registry = "failed";
			}
		}
		watch.set("registry", Math.round(performance.now() - started) / 1000);
		info(`  registry    ${formatSeconds(watch.timings.registry)}  ${registry}${configVersion !== undefined ? ` (config v${configVersion})` : ""}`);
	} else {
		registry = api ? "unavailable" : "skipped";
	}
	entry ??= makeEntry(input, history.snapshot?.value, history.local);

	const message = deployMessage({
		b: entry.branch,
		a: entry.assetId,
		i: entry.artifactId,
		s: entry.seq,
		c: entry.commit,
		ch: entry.channel,
		rollback: input.action === "rollback",
	});
	await watch.stage("publish", () => oc.publishMessage(proj.config.universeId, DEPLOY_TOPIC, JSON.stringify(message)));
	info(`  publish     ${formatSeconds(watch.timings.publish)}  ${DEPLOY_TOPIC} ${JSON.stringify(message)}`);

	const local: LocalDeployment = {
		...entry,
		universeId: proj.config.universeId,
		project: proj.config.project,
		assetName: input.assetName,
		message: input.note,
		registry,
		configVersion,
		...input.extra,
		timings: watch.total(),
	};
	appendLocalLog(proj.root, local);
	return { entry: local, message, registry, configVersion };
}
