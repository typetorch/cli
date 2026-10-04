/**
 * `typetorch promote <branch> <artifactId|assetId|#seq|commit>`: point a branch at an already uploaded payload with a
 * new seq and a signed deploy message. No build, upload or moderation wait. The artifact comes from the deployment
 * history (anything that went out before, on any branch) or from uploads.jsonl (an upload whose deploy stopped after
 * moderation, or `typetorch upload`). An upload not yet known to be Approved is checked with Roblox first.
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { matchDeployment, type UploadRecord } from "../deployments";
import { gitInfo } from "../git";
import { bold, dim, emitJson, formatTimings, info, isJson, Stopwatch } from "../log";
import { branchChannel, branchNameError, formatSources, strictest } from "../naming";
import { DEPLOY_TOPIC } from "../opencloud";
import { assertNoForeignDraft } from "../registry";
import { openCloud, project, readHistory, registryApi, signingKey, warnRegistryFallback } from "./common";
import { checkChannelGuard } from "./deploy";
import { makeEntry, registryMessage, release, signEntry, type ReleaseArtifact } from "./release";

export const promoteFlags = {
	force: "boolean",
	"dry-run": "boolean",
	"no-registry": "boolean",
	message: "string",
} as const;

interface Candidate extends ReleaseArtifact {
	seq: number;
	at: string;
	branch: string;
	sha256?: string;
	/** Moderation state known locally ("Approved" for anything deployed before). */
	moderation: string;
	from: "deployments" | "uploads";
}

function fromUpload(upload: UploadRecord): Candidate {
	return {
		seq: -1,
		at: upload.at,
		branch: upload.branch,
		artifactId: upload.artifactId,
		assetId: upload.assetId,
		channel: upload.channel,
		commit: upload.commit,
		commitHash: upload.commitHash,
		dirty: upload.dirty,
		sources: upload.sources,
		sha256: upload.sha256,
		moderation: upload.moderation,
		from: "uploads",
	};
}

export async function promoteCommand(args: ParsedArgs) {
	const [branch, wanted] = args.positionals;
	if (!branch || !wanted) throw new UsageError("usage: typetorch promote <branch> <artifactId|assetId|#seq|commit>");
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	const noRegistry = flagBool(args, "no-registry");
	const note = flagString(args, "message");
	const git = gitInfo(proj.root);

	const oc = openCloud("deploy", dryRun);
	const api = registryApi(oc, proj, noRegistry);
	const key = signingKey(proj);
	const watch = new Stopwatch();
	const history = await watch.stage("read", () => readHistory(proj, api, noRegistry ? "--no-registry" : "no API key (dry run)"));
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	if (history.snapshot) assertNoForeignDraft(history.snapshot, force);

	// Anything deployed before (newest first, this branch first), then uploads that never went out.
	const deployed = matchDeployment(history.rows, wanted, branch);
	const target: Candidate | undefined = deployed
		? { ...deployed, sources: deployed.sources, moderation: "Approved", from: "deployments" }
		: matchDeployment(history.uploads.map(fromUpload), wanted, branch);
	if (!target) {
		throw new Error(
			`nothing matches "${wanted}" in the deployments or uploads (${history.stateDir}); try a #seq, asset id, artifact id or commit from \`typetorch deployments\``,
		);
	}
	const head = history.heads.get(branch);
	if (head && head.assetId === target.assetId) throw new Error(`${target.artifactId} (asset ${target.assetId}) is already live on ${branch}`);

	const targetChannel = strictest(branchChannel(proj.config, branch), history.snapshot?.value.channels[branch]);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: target.channel, dirty: target.dirty, force });

	const artifact: ReleaseArtifact = {
		artifactId: target.artifactId,
		assetId: target.assetId,
		channel: target.channel,
		commit: target.commit,
		commitHash: target.commitHash,
		dirty: target.dirty,
		sources: target.sources,
	};
	const summary = `${branch}: ${head ? `${head.artifactId} (asset ${head.assetId})` : "(no head)"} -> ${target.artifactId} (asset ${target.assetId}, ${target.channel} channel, from ${target.from === "deployments" ? `#${target.seq} on ${target.branch}` : "an upload"})`;

	if (dryRun) {
		const entry = makeEntry({ action: "promote", branch, artifact, by: git.userName }, history.snapshot?.value, history.local);
		const message = signEntry(entry, key);
		const plan = {
			dryRun: true,
			branch,
			from: head ?? null,
			to: target,
			seq: entry.seq,
			moderation: target.moderation,
			registry: history.snapshot
				? { readable: true, message: registryMessage("promote", branch, target.artifactId, note) }
				: { readable: false, reason: history.unavailable },
			message: { topic: DEPLOY_TOPIC, data: message, signed: message.sig !== undefined },
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would promote ${summary} as #${entry.seq}`));
		if (target.sources) info(`  sources   ${formatSources(target.sources)}`);
		if (target.moderation !== "Approved") info(`  moderation was ${target.moderation} at upload; checked again before publishing`);
		info(`  registry  ${history.snapshot ? `would publish "${plan.registry.message}"` : `not used (${history.unavailable})`}`);
		info(`  message   ${DEPLOY_TOPIC} ${JSON.stringify({ ...message, sig: message.sig ? "<signature>" : undefined })}`);
		return;
	}

	if (target.moderation !== "Approved") {
		const assets = openCloud("assets")!;
		const state = (await assets.call("GET", `/assets/v1/assets/${target.assetId}?readMask=moderationResult`))?.moderationResult?.moderationState;
		if (state !== "Approved") throw new Error(`asset ${target.assetId} moderation is ${state ?? "unknown"}; only Approved assets can be promoted`);
	}

	info(`promoting ${summary}`);
	const result = await release({
		proj,
		oc: oc!,
		api: history.snapshot ? api : undefined,
		history,
		action: "promote",
		branch,
		artifact,
		by: git.userName,
		force,
		note,
		watch,
		signingKey: key,
		extra: target.sha256 ? { sha256: target.sha256 } : undefined,
	});
	const timings = watch.total();
	if (isJson()) return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, timings });
	info(bold(`promoted #${result.entry.seq} ${summary} in ${timings.total.toFixed(2)} s`));
	info(dim(`  ${formatTimings(timings)}`));
}
