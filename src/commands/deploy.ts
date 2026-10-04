/**
 * `typetorch deploy`: clean build -> upload (new Model asset) -> moderation = Approved -> "uploaded" record ->
 * registry -> signed deploy message -> "published" record, with per-stage timings. The registry is read in parallel
 * with the build so a conflict (or a missing scope) is known before anything is uploaded.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args";
import { assertNoIdCollision, buildPayload, payloadBytes, readBuiltPayload, type PayloadMeta } from "../build";
import { changeLines } from "../changes";
import { appendUpload } from "../deployments";
import { gitInfo } from "../git";
import { bold, dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch, warn } from "../log";
import { branchChannel, branchNameError, formatSources, strictest, type Channel } from "../naming";
import { DEPLOY_TOPIC } from "../opencloud";
import { assertNoForeignDraft, tryReadRegistry, type RegistrySnapshot } from "../registry";
import { assetNaming, fixCensoredName, uploadPayload } from "../upload";
import { describeBuild } from "./build";
import { channelFlag, openCloud, project, projectStateDir, registryApi, signingKey, warnRegistryFallback, withLocal } from "./common";
import { makeEntry, registryMessage, release, signEntry } from "./release";

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

	// One client per job (each with its own key when configured): uploads, and messaging + registry.
	const assets = openCloud("assets", dryRun);
	const deployer = openCloud("deploy", dryRun);
	const api = registryApi(deployer, proj, noRegistry);
	const key = signingKey(proj);
	const watch = new Stopwatch();

	// The registry read runs while we build.
	const registryRead: Promise<{ snapshot?: RegistrySnapshot; unavailable?: string; error?: unknown }> = api
		? tryReadRegistry(api).catch((error) => ({ error }))
		: Promise.resolve({ unavailable: noRegistry ? "--no-registry" : "no API key (dry run)" });

	const noBuild = flagBool(args, "no-build");
	let meta: PayloadMeta;
	let bytes: Uint8Array;
	let by: string;
	if (noBuild) {
		({ meta, bytes } = readBuiltPayload(proj.root));
		if (channelOverride && channelOverride !== meta.channel) {
			throw new UsageError(`the built payload is channel ${meta.channel}; rebuild for --channel ${channelOverride}`);
		}
		by = gitInfo(proj.root).userName;
		info(`using ${describeBuild(meta)}`);
	} else {
		const built = await watch.stage("build", () => buildPayload(proj, { branch: branchFlag, channel: channelOverride, clean: true }));
		meta = built.meta;
		by = built.target.git.userName;
		bytes = payloadBytes(proj.root);
		info(`  build       ${formatSeconds(watch.timings.build)}  ${describeBuild(meta)}  ${formatBytes(meta.bytes)}`);
	}
	if (meta.sources) info(dim(`  sources     ${formatSources(meta.sources)}`));
	const branch = branchFlag ?? meta.branch;

	const read = await registryRead;
	if (read.error) {
		throw new Error(`could not read the registry: ${(read.error as Error).message ?? read.error} (pass --no-registry to deploy without it)`);
	}
	const snapshot = read.snapshot;
	if (!snapshot && api) warnRegistryFallback(read.unavailable ?? "unknown");
	if (snapshot) assertNoForeignDraft(snapshot, force);
	const history = withLocal(proj, snapshot, read.unavailable);
	// Two payloads with the same id but other bytes (a hash6 collision) must not both go out.
	assertNoIdCollision(meta, [...history.rows, ...history.uploads]);

	const targetChannel = strictest(branchChannel(proj.config, branch), snapshot?.value.channels[branch]);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: meta.channel, dirty: meta.dirty, force });

	// What changed since the branch's previous deploy (the dev menu shows it from the asset description).
	const changes = changeLines({
		root: proj.root,
		branch,
		message: note,
		git: { commitHash: meta.commitHash, commit: meta.commit, dirty: meta.dirty },
		sources: meta.sources,
		previous: history.heads.get(branch),
	});
	const { displayName, description } = assetNaming(proj.config, meta, branch, changes);
	const artifact = {
		artifactId: meta.artifactId,
		channel: meta.channel,
		commit: meta.commit,
		commitHash: meta.commitHash,
		dirty: meta.dirty,
		sources: meta.sources,
	};

	if (dryRun) {
		const entry = makeEntry({ action: "deploy", branch, artifact: { ...artifact, assetId: 0 }, by }, snapshot?.value, history.local);
		const message = signEntry(entry, key);
		const plan = {
			dryRun: true,
			artifactId: meta.artifactId,
			branch,
			branchChannel: targetChannel,
			channel: meta.channel,
			sources: meta.sources,
			payload: { file: meta.file, bytes: meta.bytes, sha256: meta.sha256, modules: meta.modules, debugMacros: meta.debugMacros },
			asset: { displayName, description, creator: proj.config.creator },
			changes,
			registry: snapshot
				? { readable: true, configVersion: snapshot.configVersion, exists: snapshot.exists, message: registryMessage("deploy", branch, meta.artifactId, note) }
				: { readable: false, reason: read.unavailable },
			seq: entry.seq,
			from: entry.fromArtifactId ? { artifactId: entry.fromArtifactId, assetId: entry.fromAssetId } : undefined,
			message: { topic: DEPLOY_TOPIC, data: message, signed: message.sig !== undefined },
			stateDir: history.stateDir,
			timings: watch.total(),
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would deploy ${meta.artifactId} to ${branch} (branch channel ${targetChannel}) as #${entry.seq}`));
		info(`  asset name   ${displayName}`);
		info(`  description  ${description.split("\n---\n")[0].split("\n").join(dim(" | "))}`);
		for (const line of changes) info(`  change       ${line}`);
		info(`  creator      ${JSON.stringify(proj.config.creator)}`);
		info(
			`  registry     ${snapshot ? `readable (config v${snapshot.configVersion ?? "?"}${snapshot.exists ? "" : ", no TypeTorch key yet"}); would publish "${plan.registry.message}"` : `not used (${read.unavailable})`}`,
		);
		if (entry.fromArtifactId) info(`  replaces     ${entry.fromArtifactId} (asset ${entry.fromAssetId})`);
		info(`  message      ${DEPLOY_TOPIC} ${JSON.stringify({ ...message, a: "<assetId>", sig: message.sig ? "<signature>" : undefined })}`);
		info(dim(`  ${formatTimings(watch.total())}`));
		return;
	}

	const stateDir = projectStateDir(proj);
	const upload = await uploadPayload(assets!, proj.config, meta, bytes, branch, {
		changes,
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
		// The "uploaded" record, before anything is published: a failed publish can be finished with `promote`.
		onUploaded: ({ assetId, moderation }) =>
			appendUpload(stateDir, {
				artifactId: meta.artifactId,
				assetId,
				moderation,
				branch,
				channel: meta.channel,
				commit: meta.commit,
				commitHash: meta.commitHash,
				dirty: meta.dirty,
				sha256: meta.sha256,
				sources: meta.sources,
				assetName: displayName,
				universeId: proj.config.universeId,
				project: proj.config.project,
				by,
			}),
	});
	watch.set("upload", upload.uploadSeconds);
	watch.set("moderation", upload.moderationSeconds);

	const result = await release({
		proj,
		oc: deployer!,
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
		signingKey: key,
		extra: { sha256: meta.sha256 },
	});
	// Command start -> message published: the deploy latency that matters (servers swap ~1-2 s later).
	const timings = watch.total();
	// After the message, off the critical path: rename the asset if Roblox's text filter censored its name.
	const name = await fixCensoredName(assets!, upload);
	if (name.renamed) info(dim(`  asset name was censored by Roblox's text filter; renamed to "${name.name}" (identity is in the description)`));
	if (isJson()) {
		return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, assetName: name.name, timings });
	}
	info(
		bold(`deployed #${result.entry.seq} ${branch}@${meta.commit || "uncommitted"}${meta.dirty ? "*" : ""} -> ${meta.artifactId} (asset ${upload.assetId}${result.message.sig ? ", signed" : ""}) in ${formatSeconds(timings.total)}`),
	);
	info(dim(`  ${formatTimings(timings)}`));
}
