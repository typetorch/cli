/**
 * `typetorch deploy`: clean build (with the Notes attribute) -> upload (new Model asset) -> moderation = Approved ->
 * "uploaded" record -> then, by the approval policy (approve.ts): a proposal for `typetorch approve` (agents, the
 * dev-server), the y/N right here (a person at a terminal), or deploy message -> "published" record. The shared seq
 * sources are read in parallel with the build. A prod-channel deploy that will be published here loads both signing keys before the upload, so a
 * missing key fails before anything leaves the machine.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { accessStatus, accessWarning } from "../access.ts";
import { assertNoIdCollision, buildPayload, payloadBytes, readBuiltPayload, type PayloadMeta } from "../build.ts";
import { appendUpload } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { bold, dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch, warn } from "../log.ts";
import { branchChannel, branchNameError, formatSources, type Channel } from "../naming.ts";
import { DEPLOY_TOPIC } from "../opencloud.ts";
import { keepPayload } from "../payloads.ts";
import { assetNaming, fixCensoredName, uploadPayload } from "../upload.ts";
import { finishRelease, modeFor, reportProposal, waitAfterRelease } from "./approve.ts";
import { gatePolicy, skipReason } from "../cloudtest.ts";
import { describeProtocol } from "../protocol.ts";
import { checkRollout, parseRollout } from "../rollout.ts";
import { describeShared, DS_READ_SCOPE, DS_WRITE_SCOPES, readSharedSeq, type SharedSeq } from "../seqstore.ts";
import { describeRollbackSetting, rollbackSetting, waitSeconds, WAIT_FLAGS } from "./fleet.ts";
import { describeHealth } from "../health.ts";
import { describeTest, GATE_FLAGS, gateRelease } from "./test.ts";
import { widenCommand } from "./widen.ts";
import { describeBuild } from "./build.ts";
import {
	channelFlag,
	describeSigning,
	KEY_FILE_FLAGS,
	noteRegistryFlags,
	openCloud,
	project,
	projectStateDir,
	signerFor,
	signingKeyPaths,
	signingStatus,
	withLocal,
} from "./common.ts";
import { makeEntry, messageFor } from "./release.ts";

export const deployFlags = {
	branch: "string",
	channel: "string",
	"no-build": "boolean",
	"dry-run": "boolean",
	message: "string",
	force: "boolean",
	"no-registry": "boolean",
	"require-shared-seq": "boolean",
	/** Deprecated alias of --require-shared-seq (0.7.0 before the DataStore seq source). */
	"require-registry": "boolean",
	"moderation-timeout": "string",
	propose: "boolean",
	"proposed-by": "string",
	rollout: "string",
	widen: "string",
	...GATE_FLAGS,
	...WAIT_FLAGS,
	...KEY_FILE_FLAGS,
} as const;

export class ChannelGuardError extends Error {
	override name = "ChannelGuardError";
}

/**
 * `typetorch promote` to a prod-channel branch takes only prod-channel artifacts, even with --force: a dev build has
 * debug macros and Channel "dev", which prod servers refuse. Rebuild for prod instead.
 */
export function checkPromoteChannel(input: { branch: string; branchChannel: Channel; artifactId: string; artifactChannel: Channel }) {
	if (input.branchChannel !== "prod" || input.artifactChannel === "prod") return;
	throw new ChannelGuardError(
		`refusing to promote ${input.artifactId} to prod-channel branch "${input.branch}": it is a ${input.artifactChannel}-channel artifact, and prod branches only take prod-channel builds (--force doesn't change that); rebuild for prod: typetorch deploy --branch ${input.branch} (or typetorch upload --branch ${input.branch}, then promote that upload)`,
	);
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
	if (flagString(args, "widen") !== undefined) return widenCommand(args);
	const proj = project(args);
	// Dev access lists reach servers only through `typetorch access push` (ConfigService TypeTorchAccess): say so when
	// typetorch.json has members/revoked/devBadgeId that were never pushed, or changed since (a revoked dev stays a dev).
	const accessProblem = accessWarning(accessStatus(proj.config, projectStateDir(proj)));
	if (accessProblem) warn(accessProblem);
	const rollout = parseRollout(flagString(args, "rollout"));
	const skipTest = skipReason(flagString(args, "skip-test"));
	const testFlag = flagBool(args, "test");
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	noteRegistryFlags(args); // CLI 0.8: --no-registry does nothing (no ConfigService registry)
	const note = flagString(args, "message");
	const branchFlag = flagString(args, "branch");
	const channelOverride = channelFlag(args);
	if (branchFlag && branchNameError(branchFlag)) throw new UsageError(branchNameError(branchFlag)!);
	const noBuild = flagBool(args, "no-build");

	const builtBefore = noBuild ? readBuiltPayload(proj.root) : undefined;

	// One client per job (each with its own key when configured): uploads, and messaging + DataStores.
	const assets = openCloud("assets", dryRun);
	const deployer = openCloud("deploy", dryRun);
	const watch = new Stopwatch();

	// The shared seq sources (seqstore.ts: the kernel's DataStore heads and the CLI's counter), read while we build too.
	const sharedRead: Promise<SharedSeq | undefined> = deployer ? readSharedSeq(deployer, proj.config.universeId) : Promise.resolve(undefined);

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
		const notes = async (branch: string) => ({ message: note, previous: withLocal(proj).heads.get(branch) });
		const built = await watch.stage("build", () => buildPayload(proj, { branch: branchFlag, channel: channelOverride, clean: true, notes }));
		meta = built.meta;
		by = built.target.git.userName;
		bytes = payloadBytes(proj.root);
		info(`  build       ${formatSeconds(watch.timings.build)}  ${describeBuild(meta)}  ${formatBytes(meta.bytes)}`);
	}
	if (meta.sources) info(dim(`  sources     ${formatSources(meta.sources)}`));
	if (meta.protocol) info(dim(`  protocol    ${describeProtocol({ hash: meta.protocolHash, status: meta.protocol.status, since: meta.protocol.since })}`));
	// The health window this build carries (typetorch.json "health"; kernel 0.3.7+ reads it on each server).
	if (meta.health) info(dim(`  health      ${describeHealth(meta.health)}`));
	const branch = branchFlag ?? meta.branch;

	// CI: a machine without the deployment log must not guess a seq (servers ignore a seq below the one they applied).
	const shared = await sharedRead;
	const requireShared = flagBool(args, "require-shared-seq") || flagBool(args, "require-registry");
	if (flagBool(args, "require-registry")) warn("--require-registry is now --require-shared-seq (the DataStore seq)");
	if (requireShared && !shared?.readable) {
		throw new Error(
			`--require-shared-seq: no shared seq source is readable, so this machine can't know the next seq (servers ignore a seq at or below the one they applied). Give the deploy key ${DS_READ_SCOPE} (and ${DS_WRITE_SCOPES} to claim seqs atomically). DataStore: ${shared?.error ?? "no deploy key"}`,
		);
	}
	const history = withLocal(proj);
	// Two payloads with the same id but other bytes (a hash6 collision) must not both go out.
	assertNoIdCollision(meta, [...history.rows, ...history.uploads]);

	const targetChannel = branchChannel(proj.config, branch);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: meta.channel, dirty: meta.dirty, force });
	checkRollout(branch, targetChannel, rollout);
	const wait = waitSeconds(args, targetChannel);
	const rollback = rollbackSetting(args, proj.config);

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
		...(meta.protocolHash ? { protocolHash: meta.protocolHash } : {}),
	};

	const keyPaths = signingKeyPaths(proj, args);
	if (dryRun) {
		const ending = modeFor(proj, args, targetChannel).mode.kind;
		const entry = makeEntry({ action: "deploy", branch, artifact: { ...artifact, assetId: 0 }, by }, undefined, history.local, (shared?.highest ?? 0) + 1);
		const data = messageFor(entry, undefined, { placeholders: targetChannel === "prod", rollout });
		const signing = signingStatus(proj, targetChannel, keyPaths);
		const test = gatePolicy({ kind: "deploy", branchChannel: targetChannel, test: testFlag, skipTest });
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
			assets: meta.assets ?? null,
			approval: { policy: proj.config.approval, ending },
			test,
			wait: wait ?? null,
			autoRollback: wait !== undefined ? { failedPct: rollback.threshold ?? null, source: rollback.source } : null,
			health: meta.health ?? null,
			signing,
			seq: entry.seq,
			sharedSeq: shared ?? null,
			from: entry.fromArtifactId ? { artifactId: entry.fromArtifactId, assetId: entry.fromAssetId } : undefined,
			message: { topic: DEPLOY_TOPIC, data },
			stateDir: history.stateDir,
			timings: watch.total(),
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would deploy ${meta.artifactId} to ${branch} (branch channel ${targetChannel}) as #${entry.seq}`));
		info(`  approval     policy "${proj.config.approval}": ${ending}`);
		info(`  test         ${describeTest(undefined, test)}`);
		info(`  wait         ${wait !== undefined ? `up to ${wait} s for the servers' reports` : "no (--wait)"}`);
		if (wait !== undefined) info(`  rollback     ${describeRollbackSetting(rollback)}`);
		if (rollout !== undefined) info(`  rollout      ${rollout}% of the servers (typetorch deploy --widen <pct> later)`);
		info(`  signing      ${describeSigning(signing)}`);
		info(`  asset name   ${displayName}`);
		info(`  description  ${description.split("\n").join(dim(" | "))}`);
		if (message) info(`  message      ${message}`);
		for (const line of changes) info(`  change       ${line}`);
		info(`  assets       ${meta.assets?.placeVersion !== undefined ? `${meta.assets.count} hot asset(s) from place v${meta.assets.placeVersion}` : "none (no typetorch.assets.lock.json)"}`);
		info(`  creator      ${JSON.stringify(proj.config.creator)}`);
		info(`  seq          #${entry.seq} (at least; claimed when published). Shared: ${describeShared(shared)}`);
		if (entry.fromArtifactId) info(`  replaces     ${entry.fromArtifactId} (asset ${entry.fromAssetId})`);
		info(`  message      ${DEPLOY_TOPIC} ${JSON.stringify({ ...data, a: "<assetId>" })}`);
		info(dim(`  ${formatTimings(watch.total())}`));
		return;
	}

	// The final mode, with the registry's channel for the branch.
	const decided = modeFor(proj, args, targetChannel);
	// Published here (a person's y/N, or approval "none") to a prod-channel branch: both keys now, before the upload.
	const signer = decided.mode.kind !== "propose" ? signerFor(proj, targetChannel, keyPaths) : undefined;

	const stateDir = projectStateDir(proj);
	const upload = await uploadPayload(assets!, proj.config, meta, bytes, branch, {
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
		// The "uploaded" record, before anything is published: a failed publish can be finished with `promote`.
		onUploaded: ({ assetId, moderation }) => {
			// Kernel 0.3.6: the exact bytes stay in <state dir>/payloads (API keys can't download assets), so `kernel deploy`
			// can bake the prod head's payload into the place as the backup build.
			keepPayload(stateDir, meta.artifactId, bytes);
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
				...(meta.protocolHash ? { protocolHash: meta.protocolHash } : {}),
				universeId: proj.config.universeId,
				project: proj.config.project,
				by,
			});
		},
	});
	watch.set("upload", upload.uploadSeconds);
	watch.set("moderation", upload.moderationSeconds);

	// The pre-publish gate: on the approved upload, before the proposal or the message (always for prod-channel).
	const test = await watch.stage("test", () =>
		gateRelease({
			proj,
			kind: "deploy",
			branch,
			branchChannel: targetChannel,
			artifact: { artifactId: meta.artifactId, assetId: upload.assetId },
			test: testFlag,
			skipTest,
			via: "deploy",
			by,
			retryHint: `The upload is approved and recorded: after a fix, deploy again (or once it passes: typetorch test --cloud ${upload.assetId}, then typetorch promote ${branch} ${upload.assetId})`,
		}),
	);
	if (!test) delete watch.timings.test;

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
			...(test ? { test } : {}),
			...(rollout !== undefined ? { rollout } : {}),
		},
		oc: deployer!,
		history,
		watch,
		assetName: displayName,
		extra: { sha256: meta.sha256, ...(meta.protocolHash ? { protocolHash: meta.protocolHash } : {}) },
		keyPaths,
		signer,
	});
	// Off the critical path, after the message (or the proposal): rename a censored name, warn about a censored
	// description. Bounded (fixCensoredName), so a slow Assets API can't hold the command.
	const name = await fixCensoredName(assets!, upload);
	if (name.renamed) info(dim(`  asset name was censored by Roblox's text filter; renamed to "${name.name}"`));
	if (outcome.kind === "proposed") return reportProposal(outcome.proposal, { assetId: upload.assetId, assetName: name.name });
	if (outcome.kind === "declined") {
		if (isJson()) emitJson({ proposal: outcome.proposal, approve: `typetorch approve ${outcome.proposal.id}`, declined: true });
		return;
	}
	const { result } = outcome;
	const timings = watch.total();
	if (!isJson()) {
		info(
			bold(`deployed #${result.entry.seq} ${branch}@${meta.commit || "uncommitted"}${meta.dirty ? "*" : ""} -> ${meta.artifactId} (asset ${upload.assetId})${rollout ? ` to ${rollout}% of servers` : ""} in ${formatSeconds(timings.total)}`),
		);
		info(dim(`  ${formatTimings(timings)}`));
	}
	const fleet = await waitAfterRelease(proj, result, { seconds: wait, oc: deployer, branchChannel: targetChannel, threshold: rollback.threshold, thresholdSource: rollback.source, keyPaths });
	if (isJson()) {
		return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, assetName: name.name, timings, ...(fleet ? { fleet } : {}) });
	}
}
