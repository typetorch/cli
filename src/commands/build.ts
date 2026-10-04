/** `typetorch build` and `typetorch upload`. */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args";
import { buildPayload, payloadBytes, PAYLOAD_FILE, readBuiltPayload, type PayloadMeta } from "../build";
import { changeLines } from "../changes";
import { appendUpload } from "../deployments";
import { gitInfo } from "../git";
import { dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch } from "../log";
import { branchNameError, formatSources } from "../naming";
import { fixCensoredName, uploadPayload } from "../upload";
import { channelFlag, openCloud, project, projectStateDir, withLocal } from "./common";

export const buildFlags = { branch: "string", channel: "string", clean: "boolean" } as const;

export function describeBuild(meta: PayloadMeta): string {
	const state = meta.dirty ? "dirty" : "clean";
	return `${meta.artifactId}  (branch ${meta.branch}, channel ${meta.channel}, ${meta.gitBranch || "no git branch"}@${meta.commit || "uncommitted"}, ${state})`;
}

export async function buildCommand(args: ParsedArgs) {
	const proj = project(args);
	const { meta, timings } = await buildPayload(proj, {
		branch: flagString(args, "branch"),
		channel: channelFlag(args),
		clean: flagBool(args, "clean"),
	});
	if (isJson()) return emitJson({ ...meta, timings });
	info(`built ${describeBuild(meta)}`);
	info(`  ${PAYLOAD_FILE}  ${formatBytes(meta.bytes)}  ${meta.modules ?? "?"} modules  sha256 ${meta.sha256.slice(0, 16)}…`);
	if (meta.sources) info(`  sources  ${formatSources(meta.sources)}`);
	if (meta.debugMacros === false) info(dim("  prod channel: $print/$warn removed, $assert/$error without source paths"));
	info(dim(`  ${formatTimings(timings)}`));
}

export const uploadFlags = {
	branch: "string",
	channel: "string",
	"no-build": "boolean",
	"moderation-timeout": "string",
} as const;

/** Build (clean, unless --no-build) and upload the payload; no registry change, no deploy message. */
export async function uploadCommand(args: ParsedArgs) {
	const proj = project(args);
	const oc = openCloud("assets")!;
	const watch = new Stopwatch();
	let meta: PayloadMeta;
	let bytes: Uint8Array;
	if (flagBool(args, "no-build")) {
		({ meta, bytes } = readBuiltPayload(proj.root));
	} else {
		meta = (await watch.stage("build", () => buildPayload(proj, { branch: flagString(args, "branch"), channel: channelFlag(args), clean: true }))).meta;
		bytes = payloadBytes(proj.root);
		info(`  build       ${formatSeconds(watch.timings.build)}  ${describeBuild(meta)}`);
	}
	const branch = flagString(args, "branch") ?? meta.branch;
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const stateDir = projectStateDir(proj);
	const by = gitInfo(proj.root).userName;
	const changes = changeLines({
		root: proj.root,
		branch,
		git: { commitHash: meta.commitHash, commit: meta.commit, dirty: meta.dirty },
		sources: meta.sources,
		previous: withLocal(proj, undefined).heads.get(branch),
	});
	const result = await uploadPayload(oc, proj.config, meta, bytes, branch, {
		changes,
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
		onUploaded: ({ assetId, displayName, moderation }) =>
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
	watch.set("upload", result.uploadSeconds);
	watch.set("moderation", result.moderationSeconds);
	const timings = watch.total();
	const name = await fixCensoredName(oc, result);
	if (name.renamed) info(dim(`  asset name was censored by Roblox's text filter; renamed to "${name.name}" (identity is in the description)`));
	if (isJson()) return emitJson({ ...meta, branch, asset: { ...result, storedName: name.name }, timings });
	info(`uploaded ${meta.artifactId} as asset ${result.assetId} (${name.name ?? result.displayName}), ${result.moderationState}, ${formatSeconds(timings.total)}`);
	info(dim(`  publish it with: typetorch promote ${branch} ${result.assetId}`));
}
