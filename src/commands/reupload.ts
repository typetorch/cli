/**
 * `typetorch deploy --reupload <artifactId|#seq|commit|assetId> [--branch <b>]`: when Roblox moderation takes down an
 * approved build after the fact, servers can't LoadAsset it any more. This re-uploads the EXACT bytes that went out
 * before (kept in `<state dir>/payloads/<artifactId>.rbxm` at upload; API keys can't download assets) as a NEW Model
 * asset, waits for moderation, then deploys it like any deploy: the cloud test (always for prod-channel branches), the
 * approval policy (prod = the owner's y/N or `typetorch approve`), a new seq, signed on prod-channel branches, and the
 * durable head. No rebuild: the artifact id stays the same (same bytes), only the asset id changes, so servers that
 * still run the old asset swap to the new copy of the same code.
 *
 * The upload is recorded in uploads.jsonl with `reuploadOf` (the old asset id), before anything is published, so a
 * stopped run can be finished with `typetorch promote <branch> <new assetId>`.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { sha256, type PayloadMeta } from "../build.ts";
import { appendUpload, matchDeployment, type UploadRecord } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { bold, dim, emitJson, formatSeconds, formatTimings, info, isJson, Stopwatch } from "../log.ts";
import { branchChannel, branchNameError } from "../naming.ts";
import { readKeptPayload } from "../payloads.ts";
import { checkPayloadContents } from "../rbxm.ts";
import { fixCensoredName, uploadPayload } from "../upload.ts";
import { finishRelease, modeFor, reportProposal, waitAfterRelease } from "./approve.ts";
import { openCloud, project, projectStateDir, signerFor, signingKeyPaths, withLocal } from "./common.ts";
import { checkChannelGuard, checkPromoteChannel } from "./deploy.ts";
import { rollbackSetting, waitSeconds } from "./fleet.ts";
import { gateRelease } from "./test.ts";
import { skipReason } from "../cloudtest.ts";

export class ReuploadError extends Error {
	override name = "ReuploadError";
}

interface Found {
	artifactId: string;
	assetId: number;
	branch: string;
	channel: UploadRecord["channel"];
	commit: string;
	commitHash: string;
	dirty: boolean;
	sha256?: string;
	sources?: UploadRecord["sources"];
	builtAt?: string;
	protocolHash?: string;
	changes?: string[];
	message?: string;
	seq: number;
	at?: string;
}

/** The build to re-upload: anything deployed before (the --branch first), else an upload that never went out. */
export function findBuild(history: ReturnType<typeof withLocal>, wanted: string, branch?: string): Found | undefined {
	const deployed = matchDeployment(history.rows, wanted, branch);
	if (deployed) return { ...deployed, sha256: deployed.sha256 };
	const upload = matchDeployment(
		history.uploads.map((u) => ({ ...u, seq: -1 })),
		wanted,
		branch,
	);
	return upload;
}

export async function reuploadCommand(args: ParsedArgs) {
	const wanted = flagString(args, "reupload")!;
	if (flagBool(args, "no-build")) throw new UsageError("--reupload never builds: drop --no-build");
	if (flagString(args, "channel")) throw new UsageError("--reupload keeps the build's own channel: drop --channel");
	if (flagString(args, "rollout")) throw new UsageError("--reupload replaces a taken-down build on every server: drop --rollout");
	const proj = project(args);
	const branchFlag = flagString(args, "branch");
	if (branchFlag && branchNameError(branchFlag)) throw new UsageError(branchNameError(branchFlag)!);
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	const history = withLocal(proj);
	const found = findBuild(history, wanted, branchFlag);
	if (!found) throw new UsageError(`nothing matches "${wanted}" in this machine's deployments or uploads; try a #seq, asset id, artifact id or commit from \`typetorch deployments\``);
	const branch = branchFlag ?? found.branch;
	const stateDir = projectStateDir(proj);
	const bytes = readKeptPayload(stateDir, found.artifactId);
	if (!bytes) {
		throw new ReuploadError(
			`${found.artifactId} has no kept payload on this machine (<state dir>/payloads, kept at upload since CLI 0.7.4; the newest 40 stay): re-upload it from the machine that uploaded it, or rebuild it (git checkout ${found.commit} && typetorch deploy --branch ${branch})`,
		);
	}
	if (found.sha256 && sha256(bytes) !== found.sha256) throw new ReuploadError(`the kept payload of ${found.artifactId} isn't what was uploaded (sha256 differs): rebuild it`);
	const contents = checkPayloadContents(bytes);
	if (contents.rootProblems.length || contents.disallowed.length) throw new ReuploadError(`the kept payload of ${found.artifactId} isn't a clean payload: ${[...contents.rootProblems, ...contents.disallowed].slice(0, 5).join(", ")}`);
	const targetChannel = branchChannel(proj.config, branch);
	checkPromoteChannel({ branch, branchChannel: targetChannel, artifactId: found.artifactId, artifactChannel: found.channel });
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: found.channel, dirty: found.dirty, force });
	const head = history.heads.get(branch);
	const by = gitInfo(proj.root).userName;
	const summary = `${found.artifactId} (asset ${found.assetId}${found.seq >= 0 ? `, #${found.seq} on ${found.branch}` : ", an upload"}) as a NEW asset, then deploy it to ${branch}`;
	if (dryRun) {
		const plan = { dryRun: true, reupload: { artifactId: found.artifactId, oldAssetId: found.assetId, bytes: bytes.length, sha256: sha256(bytes) }, branch, branchChannel: targetChannel, head: head ?? null };
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would re-upload ${summary}`));
		info(`  bytes     ${bytes.length} (sha256 ${sha256(bytes).slice(0, 16)}), the kept payload`);
		info(`  approval  policy "${proj.config.approval}": ${modeFor(proj, args, targetChannel).mode.kind}`);
		return;
	}

	const decided = modeFor(proj, args, targetChannel);
	const keyPaths = signingKeyPaths(proj, args);
	// Published here (a person's y/N, or approval "none") to a prod-channel branch: both keys now, before the upload.
	const signer = decided.mode.kind !== "propose" ? signerFor(proj, targetChannel, keyPaths) : undefined;
	const assets = openCloud("assets")!;
	const deployer = openCloud("deploy", true);
	const watch = new Stopwatch();
	info(`re-uploading ${summary}`);
	const meta = { artifactId: found.artifactId, channel: found.channel, commit: found.commit } as PayloadMeta;
	const message = `re-upload of ${found.artifactId} (asset ${found.assetId} was taken down or unavailable)`;
	const upload = await uploadPayload(assets, proj.config, meta, bytes, branch, {
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
		onUploaded: ({ assetId, moderation, displayName }) => {
			appendUpload(stateDir, {
				artifactId: found.artifactId,
				assetId,
				moderation,
				branch,
				channel: found.channel,
				commit: found.commit,
				commitHash: found.commitHash,
				dirty: found.dirty,
				sha256: sha256(bytes),
				...(found.sources ? { sources: found.sources } : {}),
				message,
				changes: found.changes ?? [],
				bytes: bytes.length,
				...(found.builtAt ? { builtAt: found.builtAt } : {}),
				assetName: displayName,
				...(found.protocolHash ? { protocolHash: found.protocolHash } : {}),
				universeId: proj.config.universeId,
				project: proj.config.project,
				by,
				reuploadOf: found.assetId,
			});
		},
	});
	watch.set("upload", upload.uploadSeconds);
	watch.set("moderation", upload.moderationSeconds);
	const artifact = {
		artifactId: found.artifactId,
		assetId: upload.assetId,
		channel: found.channel,
		commit: found.commit,
		commitHash: found.commitHash,
		dirty: found.dirty,
		...(found.sources ? { sources: found.sources } : {}),
		sha256: sha256(bytes),
		bytes: bytes.length,
		...(found.builtAt ? { builtAt: found.builtAt } : {}),
		assetName: upload.displayName,
		...(found.protocolHash ? { protocolHash: found.protocolHash } : {}),
	};
	const test = await watch.stage("test", () =>
		gateRelease({
			proj,
			kind: "deploy",
			branch,
			branchChannel: targetChannel,
			artifact: { artifactId: found.artifactId, assetId: upload.assetId },
			test: flagBool(args, "test"),
			skipTest: skipReason(flagString(args, "skip-test")),
			via: "deploy",
			by,
			retryHint: `The new upload is approved and recorded: once it passes, typetorch promote ${branch} ${upload.assetId}`,
		}),
	);
	if (!test) delete watch.timings.test;
	const outcome = await finishRelease({
		proj,
		mode: decided.mode,
		proposer: decided.proposer,
		request: { kind: "deploy", branch, branchChannel: targetChannel, artifact, message, changes: found.changes, force, by, from: head, ...(test ? { test } : {}) },
		oc: deployer,
		history,
		watch,
		assetName: upload.displayName,
		extra: { sha256: sha256(bytes), reuploadOf: found.assetId, ...(found.protocolHash ? { protocolHash: found.protocolHash } : {}) },
		keyPaths,
		signer,
	});
	const name = await fixCensoredName(assets, upload);
	if (outcome.kind === "proposed") return reportProposal(outcome.proposal, { assetId: upload.assetId, assetName: name.name, reuploadOf: found.assetId });
	if (outcome.kind === "declined") {
		if (isJson()) emitJson({ proposal: outcome.proposal, approve: `typetorch approve ${outcome.proposal.id}`, declined: true });
		return;
	}
	const { result } = outcome;
	const timings = watch.total();
	if (!isJson()) {
		info(bold(`re-uploaded and deployed #${result.entry.seq} ${branch} -> ${found.artifactId} (asset ${found.assetId} -> ${upload.assetId}) in ${formatSeconds(timings.total)}`));
		info(dim(`  ${formatTimings(timings)}`));
	}
	const rollback = rollbackSetting(args, proj.config);
	const fleet = await waitAfterRelease(proj, result, { seconds: waitSeconds(args, targetChannel), oc: deployer, branchChannel: targetChannel, threshold: rollback.threshold, thresholdSource: rollback.source, keyPaths });
	if (isJson()) return emitJson({ reuploadOf: found.assetId, deployment: result.entry, message: result.message, assetName: name.name, timings, ...(fleet ? { fleet } : {}) });
}
