/**
 * `typetorch deploy`: clean build (with the Notes attribute) -> upload (new Model asset) -> moderation = Approved ->
 * "uploaded" record -> then, by the approval policy (approve.ts): a proposal for `typetorch approve` (agents, the
 * dev-server), the approve prompt right here (a person at a terminal), or registry -> signed message -> "published"
 * record. The registry is read in parallel with the build so a conflict (or a missing scope) is known before anything
 * is uploaded.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args";
import { assertNoIdCollision, buildPayload, GENERATED_PATHS, payloadBytes, readBuiltPayload, resolveTarget, type PayloadMeta } from "../build";
import { appendUpload } from "../deployments";
import { settings } from "../env";
import { gitInfo } from "../git";
import { bold, dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch, warn } from "../log";
import { branchChannel, branchNameError, formatSources, strictest, type Channel } from "../naming";
import { DEPLOY_TOPIC } from "../opencloud";
import { assertNoForeignDraft, tryReadRegistry, type RegistrySnapshot } from "../registry";
import { assetNaming, fixCensoredName, uploadPayload } from "../upload";
import { finishRelease, modeFor, reportProposal, resolveProposer } from "./approve";
import { describeBuild } from "./build";
import { channelFlag, keyFilePath, openCloud, project, projectStateDir, registryApi, warnRegistryFallback, withLocal } from "./common";
import { makeEntry, registryMessage, signEntry } from "./release";

export const deployFlags = {
	branch: "string",
	channel: "string",
	"no-build": "boolean",
	"dry-run": "boolean",
	message: "string",
	force: "boolean",
	"no-registry": "boolean",
	"moderation-timeout": "string",
	propose: "boolean",
	"proposed-by": "string",
	"key-file": "string",
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
	const noBuild = flagBool(args, "no-build");

	// How this deploy ends (publish, propose, or propose + approve here), checked before anything is built: a person
	// approving needs a key file. Re-checked after the registry read, which may make the branch prod-channel.
	const builtBefore = noBuild ? readBuiltPayload(proj.root) : undefined;
	const plannedBranch = branchFlag ?? builtBefore?.meta.branch ?? resolveTarget(proj, gitInfo(proj.root, GENERATED_PATHS), {}).branch;
	if (!dryRun) modeFor(proj, args, branchChannel(proj.config, plannedBranch));

	// One client per job (each with its own key when configured): uploads, and messaging + registry.
	const assets = openCloud("assets", dryRun);
	const deployer = openCloud("deploy", dryRun);
	const api = registryApi(deployer, proj, noRegistry);
	const watch = new Stopwatch();

	// The registry read runs while we build; the build awaits it (after rbxtsc) for the Notes' previous head.
	const registryRead: Promise<{ snapshot?: RegistrySnapshot; unavailable?: string; error?: unknown }> = api
		? tryReadRegistry(api).catch((error) => ({ error }))
		: Promise.resolve({ unavailable: noRegistry ? "--no-registry" : "no API key (dry run)" });
	const readRegistryOrThrow = async () => {
		const read = await registryRead;
		if (read.error) {
			throw new Error(`could not read the registry: ${(read.error as Error).message ?? read.error} (pass --no-registry to deploy without it)`);
		}
		return read;
	};

	let meta: PayloadMeta;
	let bytes: Uint8Array;
	let by: string;
	if (builtBefore) {
		({ meta, bytes } = builtBefore);
		if (channelOverride && channelOverride !== meta.channel) {
			throw new UsageError(`the built payload is channel ${meta.channel}; rebuild for --channel ${channelOverride}`);
		}
		by = gitInfo(proj.root).userName;
		info(`using ${describeBuild(meta)}`);
	} else {
		const notes = async (branch: string) => {
			const read = await readRegistryOrThrow();
			return { message: note, previous: withLocal(proj, read.snapshot, read.unavailable).heads.get(branch) };
		};
		const built = await watch.stage("build", () => buildPayload(proj, { branch: branchFlag, channel: channelOverride, clean: true, notes }));
		meta = built.meta;
		by = built.target.git.userName;
		bytes = payloadBytes(proj.root);
		info(`  build       ${formatSeconds(watch.timings.build)}  ${describeBuild(meta)}  ${formatBytes(meta.bytes)}`);
	}
	if (meta.sources) info(dim(`  sources     ${formatSources(meta.sources)}`));
	const branch = branchFlag ?? meta.branch;

	const read = await readRegistryOrThrow();
	const snapshot = read.snapshot;
	if (!snapshot && api) warnRegistryFallback(read.unavailable ?? "unknown");
	if (snapshot) assertNoForeignDraft(snapshot, force);
	const history = withLocal(proj, snapshot, read.unavailable);
	// Two payloads with the same id but other bytes (a hash6 collision) must not both go out.
	assertNoIdCollision(meta, [...history.rows, ...history.uploads]);

	const targetChannel = strictest(branchChannel(proj.config, branch), snapshot?.value.channels[branch]);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: meta.channel, dirty: meta.dirty, force });

	const { displayName, description } = assetNaming(proj.config, meta, branch);
	const changes = meta.notes?.changes ?? [];
	const message = note ?? meta.notes?.message;
	const artifact = {
		artifactId: meta.artifactId,
		channel: meta.channel,
		commit: meta.commit,
		commitHash: meta.commitHash,
		dirty: meta.dirty,
		sources: meta.sources,
		sha256: meta.sha256,
		bytes: meta.bytes,
		builtAt: meta.builtAt,
		assetName: displayName,
	};

	if (dryRun) {
		let ending: string;
		try {
			ending = modeFor(proj, args, targetChannel).mode.kind;
		} catch (error) {
			ending = `refused: ${(error as Error).message}`;
		}
		const entry = makeEntry({ action: "deploy", branch, artifact: { ...artifact, assetId: 0 }, by }, snapshot?.value, history.local);
		const ci = ending === "ci" ? settings().ciSigningKey() : undefined;
		const data = signEntry(entry, ci);
		const plan = {
			dryRun: true,
			artifactId: meta.artifactId,
			branch,
			branchChannel: targetChannel,
			channel: meta.channel,
			sources: meta.sources,
			payload: { file: meta.file, bytes: meta.bytes, sha256: meta.sha256, modules: meta.modules, debugMacros: meta.debugMacros },
			asset: { displayName, description, creator: proj.config.creator },
			notes: { message: message ?? "", changes },
			approval: { policy: proj.config.approval, ending },
			registry: snapshot
				? { readable: true, configVersion: snapshot.configVersion, exists: snapshot.exists, message: registryMessage("deploy", branch, meta.artifactId, note) }
				: { readable: false, reason: read.unavailable },
			seq: entry.seq,
			from: entry.fromArtifactId ? { artifactId: entry.fromArtifactId, assetId: entry.fromAssetId } : undefined,
			message: { topic: DEPLOY_TOPIC, data, signed: data.sig !== undefined },
			stateDir: history.stateDir,
			timings: watch.total(),
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would deploy ${meta.artifactId} to ${branch} (branch channel ${targetChannel}) as #${entry.seq}`));
		info(`  approval     policy "${proj.config.approval}": ${ending}`);
		info(`  asset name   ${displayName}`);
		info(`  description  ${description.split("\n").join(dim(" | "))}`);
		if (message) info(`  message      ${message}`);
		for (const line of changes) info(`  change       ${line}`);
		info(`  creator      ${JSON.stringify(proj.config.creator)}`);
		info(
			`  registry     ${snapshot ? `readable (config v${snapshot.configVersion ?? "?"}${snapshot.exists ? "" : ", no TypeTorch key yet"}); would publish "${plan.registry.message}"` : `not used (${read.unavailable})`}`,
		);
		if (entry.fromArtifactId) info(`  replaces     ${entry.fromArtifactId} (asset ${entry.fromAssetId})`);
		info(`  message      ${DEPLOY_TOPIC} ${JSON.stringify({ ...data, a: "<assetId>", sig: data.sig ? "<signature>" : undefined })}`);
		info(dim(`  ${formatTimings(watch.total())}`));
		return;
	}

	// The final mode, with the registry's channel for the branch; a person without a key file can still propose.
	let decided: ReturnType<typeof modeFor>;
	try {
		decided = modeFor(proj, args, targetChannel);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		warn(`${error.message}; proposing instead`);
		decided = { mode: { kind: "propose" }, proposer: resolveProposer(flagString(args, "proposed-by"), false) };
	}

	const stateDir = projectStateDir(proj);
	const upload = await uploadPayload(assets!, proj.config, meta, bytes, branch, {
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
				...(message ? { message } : {}),
				changes,
				bytes: meta.bytes,
				builtAt: meta.builtAt,
				assetName: displayName,
				universeId: proj.config.universeId,
				project: proj.config.project,
				by,
			}),
	});
	watch.set("upload", upload.uploadSeconds);
	watch.set("moderation", upload.moderationSeconds);
	// Off the critical path of the decision: rename a censored name, warn about a censored description.
	const name = await fixCensoredName(assets!, upload);
	if (name.renamed) info(dim(`  asset name was censored by Roblox's text filter; renamed to "${name.name}"`));

	const outcome = await finishRelease({
		proj,
		mode: decided.mode,
		proposer: decided.proposer,
		request: {
			kind: "deploy",
			branch,
			branchChannel: targetChannel,
			artifact: { ...artifact, assetId: upload.assetId },
			message,
			changes,
			force,
			by,
			from: history.heads.get(branch),
		},
		oc: deployer!,
		api: snapshot ? api : undefined,
		history,
		watch,
		noRegistry,
		keyFile: keyFilePath(proj, flagString(args, "key-file")),
		assetName: displayName,
		extra: { sha256: meta.sha256 },
	});
	if (outcome.kind === "proposed") return reportProposal(outcome.proposal, { assetId: upload.assetId, assetName: name.name });
	if (outcome.kind === "declined") {
		if (isJson()) emitJson({ proposal: outcome.proposal, approve: `typetorch approve ${outcome.proposal.id}`, declined: true });
		return;
	}
	const { result } = outcome;
	const timings = watch.total();
	if (isJson()) {
		return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, assetName: name.name, timings });
	}
	info(
		bold(`deployed #${result.entry.seq} ${branch}@${meta.commit || "uncommitted"}${meta.dirty ? "*" : ""} -> ${meta.artifactId} (asset ${upload.assetId}${result.message.sig ? ", signed" : ", UNSIGNED"}) in ${formatSeconds(timings.total)}`),
	);
	info(dim(`  ${formatTimings(timings)}`));
}
