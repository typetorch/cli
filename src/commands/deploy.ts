/**
 * `typetorch deploy`: build -> upload (new Model asset) -> moderation = Approved -> registry -> deploy message ->
 * local log, with per-stage timings. The registry is read in parallel with the build so a conflict (or a missing
 * scope) is known before anything is uploaded.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args";
import { buildPayload, payloadBytes, readBuiltPayload, type PayloadMeta } from "../build";
import { gitInfo } from "../git";
import { bold, dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch, warn } from "../log";
import { branchChannel, branchNameError, strictest, type Channel } from "../naming";
import { DEPLOY_TOPIC, deployMessage } from "../opencloud";
import { assertNoForeignDraft, tryReadRegistry, type RegistrySnapshot } from "../registry";
import { assetNaming, uploadPayload } from "../upload";
import { channelFlag, openCloud, project, registryApi, warnRegistryFallback, withLocal } from "./common";
import { describeBuild } from "./build";
import { makeEntry, registryMessage, release } from "./release";

export const deployFlags = {
	branch: "string",
	channel: "string",
	"no-build": "boolean",
	"dry-run": "boolean",
	message: "string",
	force: "boolean",
	"no-registry": "boolean",
	"moderation-timeout": "string",
} as const;

export class ChannelGuardError extends Error {
	override name = "ChannelGuardError";
}

/** Refuses dev-channel or dirty artifacts on a prod-channel branch unless forced (plans/10 "Promotion"). */
export function checkChannelGuard(input: {
	branch: string;
	branchChannel: Channel;
	artifactChannel: Channel;
	dirty: boolean;
	force: boolean;
}) {
	if (input.branchChannel !== "prod") return;
	const problems: string[] = [];
	if (input.artifactChannel !== "prod") problems.push(`a ${input.artifactChannel}-channel artifact`);
	if (input.dirty) problems.push("a dirty build");
	if (problems.length === 0) return;
	if (input.force) {
		warn(`deploying ${problems.join(" and ")} to prod-channel branch ${input.branch} (--force)`);
		return;
	}
	throw new ChannelGuardError(
		`refusing to deploy ${problems.join(" and ")} to prod-channel branch "${input.branch}" (pass --force to override)`,
	);
}

export async function deployCommand(args: ParsedArgs) {
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	const noRegistry = flagBool(args, "no-registry");
	const note = flagString(args, "message");
	const branchFlag = flagString(args, "branch");
	const channelOverride = channelFlag(args);
	if (branchFlag && branchNameError(branchFlag)) throw new UsageError(branchNameError(branchFlag)!);

	const oc = openCloud(dryRun);
	const api = registryApi(oc, proj, noRegistry);
	const watch = new Stopwatch();

	// Registry read runs while we build.
	const registryRead: Promise<{ snapshot?: RegistrySnapshot; unavailable?: string; error?: unknown }> = api
		? tryReadRegistry(api).catch((error) => ({ error }))
		: Promise.resolve({ unavailable: noRegistry ? "--no-registry" : "no API key (dry run)" });

	let meta: PayloadMeta;
	let bytes: Uint8Array;
	let by: string;
	if (flagBool(args, "no-build")) {
		({ meta, bytes } = readBuiltPayload(proj.root));
		if (channelOverride && channelOverride !== meta.channel) {
			throw new UsageError(`the built payload is channel ${meta.channel}; rebuild for --channel ${channelOverride}`);
		}
		by = gitInfo(proj.root).userName;
		info(`using ${describeBuild(meta)}`);
	} else {
		const built = await watch.stage("build", () => buildPayload(proj, { branch: branchFlag, channel: channelOverride }));
		meta = built.meta;
		by = built.target.git.userName;
		bytes = payloadBytes(proj.root);
		info(`  build       ${formatSeconds(watch.timings.build)}  ${describeBuild(meta)}  ${formatBytes(meta.bytes)}`);
	}
	const branch = branchFlag ?? meta.branch;

	const read = await registryRead;
	if (read.error) {
		throw new Error(
			`could not read the registry: ${(read.error as Error).message ?? read.error} (pass --no-registry to deploy without it)`,
		);
	}
	const snapshot = read.snapshot;
	if (!snapshot && api) warnRegistryFallback(read.unavailable ?? "unknown");
	if (snapshot) assertNoForeignDraft(snapshot, force);
	const history = withLocal(proj, snapshot, read.unavailable);

	const targetChannel = strictest(branchChannel(proj.config, branch), snapshot?.value.channels[branch]);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: meta.channel, dirty: meta.dirty, force });

	const { displayName, description } = assetNaming(proj.config, meta, branch);
	const artifact = {
		artifactId: meta.artifactId,
		channel: meta.channel,
		commit: meta.commit,
		commitHash: meta.commitHash,
		dirty: meta.dirty,
	};

	if (dryRun) {
		const entry = makeEntry({ action: "deploy", branch, artifact: { ...artifact, assetId: 0 }, by }, snapshot?.value, history.local);
		const message = deployMessage({ b: branch, a: 0, i: meta.artifactId, s: entry.seq, c: meta.commit, ch: meta.channel });
		const plan = {
			dryRun: true,
			artifactId: meta.artifactId,
			branch,
			branchChannel: targetChannel,
			channel: meta.channel,
			payload: { file: meta.file, bytes: meta.bytes, sha256: meta.sha256 },
			asset: { displayName, description, creator: proj.config.creator },
			registry: snapshot
				? { readable: true, configVersion: snapshot.configVersion, exists: snapshot.exists, message: registryMessage("deploy", branch, meta.artifactId, note) }
				: { readable: false, reason: read.unavailable },
			seq: entry.seq,
			from: entry.fromArtifactId ? { artifactId: entry.fromArtifactId, assetId: entry.fromAssetId } : undefined,
			message: { topic: DEPLOY_TOPIC, data: message },
			timings: watch.total(),
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would deploy ${meta.artifactId} to ${branch} (branch channel ${targetChannel}) as #${entry.seq}`));
		info(`  asset name   ${displayName}`);
		info(`  description  ${description.split("\n").join(dim(" | "))}`);
		info(`  creator      ${JSON.stringify(proj.config.creator)}`);
		info(
			`  registry     ${snapshot ? `readable (config v${snapshot.configVersion ?? "?"}${snapshot.exists ? "" : ", no TypeTorch key yet"}); would publish "${plan.registry.message}"` : `not used (${read.unavailable})`}`,
		);
		if (entry.fromArtifactId) info(`  replaces     ${entry.fromArtifactId} (asset ${entry.fromAssetId})`);
		info(`  message      ${DEPLOY_TOPIC} ${JSON.stringify({ ...message, a: "<assetId>" })}`);
		info(dim(`  ${formatTimings(watch.total())}`));
		return;
	}

	const upload = await uploadPayload(oc!, proj.config, meta, bytes, branch, {
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
	});
	watch.set("upload", upload.uploadSeconds);
	watch.set("moderation", upload.moderationSeconds);

	const result = await release({
		proj,
		oc: oc!,
		api: snapshot ? api : undefined,
		history,
		action: "deploy",
		branch,
		artifact: { ...artifact, assetId: upload.assetId },
		by,
		force,
		note,
		assetName: displayName,
		watch,
	});
	const timings = watch.total();
	if (isJson()) return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, timings });
	info(
		bold(`deployed #${result.entry.seq} ${branch}@${meta.commit || "uncommitted"}${meta.dirty ? "*" : ""} -> ${meta.artifactId} (asset ${upload.assetId}) in ${formatSeconds(timings.total)}`),
	);
	info(dim(`  ${formatTimings(timings)}`));
}
