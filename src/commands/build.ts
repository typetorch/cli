/** `typetorch build` and `typetorch upload`. */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { buildPayload, payloadBytes, PAYLOAD_FILE, readBuiltPayload, type PayloadMeta } from "../build.ts";
import { appendUpload } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch } from "../log.ts";
import { branchNameError, formatSources } from "../naming.ts";
import { describeProtocol } from "../protocol.ts";
import { describeHealth } from "../health.ts";
import { keepPayload } from "../payloads.ts";
import { fixCensoredName, uploadPayload } from "../upload.ts";
import { channelFlag, openCloud, project, projectStateDir } from "./common.ts";

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
	info(`  protocol ${describeProtocol({ hash: meta.protocolHash, status: meta.protocol?.status, since: meta.protocol?.since })}`);
	if (meta.health) info(`  health   ${describeHealth(meta.health)}`);
	for (const line of meta.notes?.changes ?? []) info(`  change   ${line}`);
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
	const result = await uploadPayload(oc, proj.config, meta, bytes, branch, {
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
		onUploaded: ({ assetId, displayName, moderation }) => {
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
				...(meta.notes?.message ? { message: meta.notes.message } : {}),
				changes: meta.notes?.changes,
				bytes: meta.bytes,
				builtAt: meta.builtAt,
				assetName: displayName,
				universeId: proj.config.universeId,
				project: proj.config.project,
				by,
			});
		},
	});
	watch.set("upload", result.uploadSeconds);
	watch.set("moderation", result.moderationSeconds);
	const timings = watch.total();
	const name = await fixCensoredName(oc, result);
	if (name.renamed) info(dim(`  asset name was censored by Roblox's text filter; renamed to "${name.name}"`));
	if (isJson()) return emitJson({ ...meta, branch, asset: { ...result, storedName: name.name }, timings });
	info(`uploaded ${meta.artifactId} as asset ${result.assetId} (${name.name ?? result.displayName}), ${result.moderationState}, ${formatSeconds(timings.total)}`);
	info(dim(`  publish it with: typetorch promote ${branch} ${result.assetId}`));
}
