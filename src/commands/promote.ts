/**
 * `typetorch promote <branch> <artifactId|assetId|#seq|commit>`: point a branch at an already uploaded payload with a
 * new seq. No build, upload or moderation wait. The artifact comes from the deployment history (anything that went out
 * before, on any branch) or from uploads.jsonl (an upload whose deploy stopped after moderation, or `typetorch
 * upload`). An upload not yet known to be Approved is checked with Roblox first. Like every release it follows the
 * approval policy (approve.ts).
 */
import { flagBool, UsageError, type ParsedArgs } from "../args";
import { matchDeployment, type UploadRecord } from "../deployments";
import { gitInfo } from "../git";
import { Stopwatch } from "../log";
import { branchChannel, branchNameError, strictest } from "../naming";
import { assertNoForeignDraft } from "../registry";
import type { ProposalArtifact } from "../proposals";
import { releaseExisting } from "./approve";
import { openCloud, project, readHistory, registryApi, warnRegistryFallback } from "./common";
import { checkChannelGuard } from "./deploy";

export const promoteFlags = {
	force: "boolean",
	"dry-run": "boolean",
	"no-registry": "boolean",
	message: "string",
	propose: "boolean",
	"proposed-by": "string",
	"key-file": "string",
} as const;

interface Candidate extends ProposalArtifact {
	seq: number;
	at: string;
	branch: string;
	/** Moderation state known locally ("Approved" for anything deployed before). */
	moderation: string;
	changes?: string[];
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
		bytes: upload.bytes,
		builtAt: upload.builtAt,
		assetName: upload.assetName,
		changes: upload.changes,
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
	const git = gitInfo(proj.root);

	// Optional: proposing needs no key; publishing (finishRelease) does.
	const oc = openCloud("deploy", true);
	const api = registryApi(oc, proj, noRegistry);
	const watch = new Stopwatch();
	const history = await watch.stage("read", () => readHistory(proj, api, noRegistry ? "--no-registry" : "no API key (dry run)"));
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	if (history.snapshot) assertNoForeignDraft(history.snapshot, force);

	// Anything deployed before (newest first, this branch first), then uploads that never went out.
	const deployed = matchDeployment(history.rows, wanted, branch);
	const target: Candidate | undefined = deployed
		? { ...deployed, moderation: "Approved", from: "deployments" }
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

	// An upload whose moderation wasn't Approved yet: ask Roblox now (needs the assets key), never publish otherwise.
	if (target.moderation !== "Approved" && !dryRun) {
		const assets = openCloud("assets")!;
		const state = (await assets.call("GET", `/assets/v1/assets/${target.assetId}?readMask=moderationResult`))?.moderationResult?.moderationState;
		if (state !== "Approved") throw new Error(`asset ${target.assetId} moderation is ${state ?? "unknown"}; only Approved assets can be promoted`);
	}

	const artifact: ProposalArtifact = {
		artifactId: target.artifactId,
		assetId: target.assetId,
		channel: target.channel,
		commit: target.commit,
		commitHash: target.commitHash,
		dirty: target.dirty,
		...(target.sources ? { sources: target.sources } : {}),
		...(target.sha256 ? { sha256: target.sha256 } : {}),
		...(target.bytes !== undefined ? { bytes: target.bytes } : {}),
		...(target.builtAt ? { builtAt: target.builtAt } : {}),
		...(target.assetName ? { assetName: target.assetName } : {}),
	};
	const { from, changes } = target;
	await releaseExisting({
		proj,
		args,
		kind: "promote",
		branch,
		branchChannel: targetChannel,
		artifact,
		changes,
		history,
		oc,
		api: history.snapshot ? api : undefined,
		watch,
		force,
		by: git.userName,
		summary: `${branch}: ${head ? `${head.artifactId} (asset ${head.assetId})` : "(no head)"} -> ${target.artifactId} (asset ${target.assetId}, ${target.channel} channel, from ${from === "deployments" ? `#${target.seq} on ${target.branch}` : "an upload"})`,
		dryRun,
	});
}
