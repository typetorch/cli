/** `typetorch build` and `typetorch upload`. */
import { flagBool, flagInt, flagString, type ParsedArgs } from "../args";
import { buildPayload, readBuiltPayload, payloadBytes, PAYLOAD_FILE, type PayloadMeta } from "../build";
import { branchNameError } from "../naming";
import { UsageError } from "../args";
import { dim, emitJson, formatBytes, formatSeconds, formatTimings, info, isJson, Stopwatch } from "../log";
import { fixCensoredName, logUpload, uploadPayload } from "../upload";
import { channelFlag, openCloud, project } from "./common";

export const buildFlags = { branch: "string", channel: "string" } as const;

export function describeBuild(meta: PayloadMeta): string {
	const state = meta.dirty ? "dirty" : "clean";
	return `${meta.artifactId}  (branch ${meta.branch}, channel ${meta.channel}, ${meta.gitBranch || "no git branch"}@${meta.commit || "uncommitted"}, ${state})`;
}

export async function buildCommand(args: ParsedArgs) {
	const proj = project(args);
	const { meta, timings } = await buildPayload(proj, { branch: flagString(args, "branch"), channel: channelFlag(args) });
	if (isJson()) return emitJson({ ...meta, timings });
	info(`built ${describeBuild(meta)}`);
	info(`  ${PAYLOAD_FILE}  ${formatBytes(meta.bytes)}  sha256 ${meta.sha256.slice(0, 16)}…`);
	info(dim(`  ${formatTimings(timings)}`));
}

export const uploadFlags = {
	branch: "string",
	channel: "string",
	"no-build": "boolean",
	"moderation-timeout": "string",
} as const;

/** Build (unless --no-build) and upload the payload; no registry change, no deploy message. */
export async function uploadCommand(args: ParsedArgs) {
	const proj = project(args);
	const oc = openCloud()!;
	const watch = new Stopwatch();
	let meta: PayloadMeta;
	let bytes: Uint8Array;
	if (flagBool(args, "no-build")) {
		({ meta, bytes } = readBuiltPayload(proj.root));
	} else {
		meta = (await watch.stage("build", () => buildPayload(proj, { branch: flagString(args, "branch"), channel: channelFlag(args) }))).meta;
		bytes = payloadBytes(proj.root);
		info(`  build       ${formatSeconds(watch.timings.build)}  ${describeBuild(meta)}`);
	}
	const branch = flagString(args, "branch") ?? meta.branch;
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const result = await uploadPayload(oc, proj.config, meta, bytes, branch, {
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		onStage: (stage, s, detail) => info(`  ${stage.padEnd(10)}  ${formatSeconds(s)}  ${detail}`),
	});
	watch.set("upload", result.uploadSeconds);
	watch.set("moderation", result.moderationSeconds);
	const timings = watch.total();
	const name = await fixCensoredName(oc, result);
	if (name.renamed) info(dim(`  asset name was censored by Roblox's text filter; renamed to "${name.name}" (identity is in the description)`));
	logUpload(proj.root, { artifactId: meta.artifactId, assetId: result.assetId, name: name.name ?? result.displayName, sha256: meta.sha256, universeId: proj.config.universeId, timings });
	if (isJson()) return emitJson({ ...meta, branch, asset: { ...result, storedName: name.name }, timings });
	info(`uploaded ${meta.artifactId} as asset ${result.assetId} (${name.name ?? result.displayName}), ${result.moderationState}, ${formatSeconds(timings.total)}`);
}
