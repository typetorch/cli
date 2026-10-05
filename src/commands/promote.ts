/**
 * `typetorch promote <branch> <artifactId|assetId|#seq|commit>`: point a branch at an already uploaded payload with a
 * new seq. No build, upload or moderation wait. The artifact comes from the deployment history (anything that went out
 * before, on any branch) or from uploads.jsonl (an upload whose deploy stopped after moderation, or `typetorch
 * upload`). An upload not yet known to be Approved is checked with Roblox first. Like every release it follows the
 * approval policy (approve.ts), and a prod-channel branch's message is signed with both keys when it is published.
 *
 * A prod-channel branch only takes prod-channel artifacts, even with --force ("rebuild for prod"). The arguments may
 * also be given as `promote <artifact> <branch>` when the second one is a known branch and the first one isn't.
 */
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import { matchDeployment, type UploadRecord } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { Stopwatch } from "../log.ts";
import { branchChannel, branchNameError, strictest } from "../naming.ts";
import { assertNoForeignDraft } from "../registry.ts";
import type { ProposalArtifact } from "../proposals.ts";
import { releaseExisting } from "./approve.ts";
import type { Project } from "../config.ts";
import { KEY_FILE_FLAGS, openCloud, project, readHistory, registryApi, warnRegistryFallback, type History } from "./common.ts";
import { checkChannelGuard, checkPromoteChannel } from "./deploy.ts";

export const promoteFlags = {
	force: "boolean",
	"dry-run": "boolean",
	"no-registry": "boolean",
	message: "string",
	propose: "boolean",
	"proposed-by": "string",
	...KEY_FILE_FLAGS,
} as const;

/** Branch names this project knows: the default branch, channels, git-branch mappings and the deployed heads. */
export function knownBranches(proj: Project, history: Pick<History, "heads" | "snapshot">): Set<string> {
	const known = new Set<string>([proj.config.defaultBranch, ...Object.keys(proj.config.channels), ...Object.values(proj.config.branches)]);
	for (const branch of history.heads.keys()) known.add(branch);
	for (const branch of Object.keys(history.snapshot?.value.channels ?? {})) known.add(branch);
	return known;
}

/** `promote <branch> <artifact>`, or `promote <artifact> <branch>` when only the second is a known branch. */
export function promoteArguments(first: string, second: string, known: Set<string>): { branch: string; wanted: string; swapped: boolean } {
	if (!known.has(first) && known.has(second)) return { branch: second, wanted: first, swapped: true };
	return { branch: first, wanted: second, swapped: false };
}

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
	const [first, second] = args.positionals;
	if (!first || !second) throw new UsageError("usage: typetorch promote <branch> <artifactId|assetId|#seq|commit>");
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
	const { branch, wanted } = promoteArguments(first, second, knownBranches(proj, history));
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);

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
	checkPromoteChannel({ branch, branchChannel: targetChannel, artifactId: target.artifactId, artifactChannel: target.channel });
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
