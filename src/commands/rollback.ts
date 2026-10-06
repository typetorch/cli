/**
 * `typetorch rollback`: re-point a branch at an already approved payload asset (no build, upload or moderation wait)
 * and tell its servers. Without --to it picks the newest earlier deployment on the branch whose artifact differs from
 * the live head. Like every release it follows the approval policy (approve.ts): a person approves it, or it becomes a
 * proposal for `typetorch approve`. A prod-channel branch's message is signed with both keys when it is published.
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { matchDeployment, previousDifferent } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { Stopwatch } from "../log.ts";
import { branchChannel, branchFromGit, branchNameError } from "../naming.ts";
import { releaseExisting } from "./approve.ts";
import { KEY_FILE_FLAGS, noteRegistryFlags, openCloud, project, readHistory } from "./common.ts";
import { WAIT_FLAGS } from "./fleet.ts";
import { GATE_FLAGS } from "./test.ts";
import { checkChannelGuard } from "./deploy.ts";

export const rollbackFlags = {
	branch: "string",
	to: "string",
	force: "boolean",
	"dry-run": "boolean",
	"no-registry": "boolean",
	message: "string",
	propose: "boolean",
	"proposed-by": "string",
	...GATE_FLAGS,
	...WAIT_FLAGS,
	...KEY_FILE_FLAGS,
} as const;

export async function rollbackCommand(args: ParsedArgs) {
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	noteRegistryFlags(args); // CLI 0.8: --no-registry does nothing
	const git = gitInfo(proj.root);
	const branch = flagString(args, "branch") ?? args.positionals[0] ?? (git.gitBranch ? branchFromGit(git.gitBranch, proj.config.branches) : undefined);
	if (!branch) throw new UsageError("which branch? pass --branch <name>");
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);

	// Optional: proposing needs no key; publishing (finishRelease) does.
	const oc = openCloud("deploy", true);
	const watch = new Stopwatch();
	const history = await watch.stage("read", () => readHistory(proj));

	const head = history.heads.get(branch);
	if (!head) {
		throw new Error(
			`branch "${branch}" has no deployments in the local log (${history.stateDir}/deployments.jsonl)`,
		);
	}
	const wanted = flagString(args, "to");
	const target = wanted ? matchDeployment(history.rows, wanted, branch) : previousDifferent(history.rows, branch, head);
	if (!target) {
		throw new Error(
			wanted
				? `no deployment matches "${wanted}" (try a #seq, asset id, artifact id (old or new form) or commit from \`typetorch deployments\`)`
				: `nothing to roll back to: no earlier deployment on "${branch}" has a different artifact than ${head.artifactId}`,
		);
	}
	if (target.assetId === head.assetId) throw new Error(`${target.artifactId} (asset ${target.assetId}) is already live on ${branch}`);

	const targetChannel = branchChannel(proj.config, branch);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: target.channel, dirty: target.dirty, force });

	await releaseExisting({
		proj,
		args,
		kind: "rollback",
		branch,
		branchChannel: targetChannel,
		artifact: {
			artifactId: target.artifactId,
			assetId: target.assetId,
			channel: target.channel,
			commit: target.commit,
			commitHash: target.commitHash,
			dirty: target.dirty,
			sources: target.sources,
			sha256: target.sha256,
			assetName: target.assetName,
			...(target.protocolHash ? { protocolHash: target.protocolHash } : {}),
		},
		changes: [`rollback to #${target.seq} (${target.artifactId})`],
		history,
		oc,
		watch,
		force,
		by: git.userName,
		summary: `${branch}: ${head.artifactId} (asset ${head.assetId}) -> ${target.artifactId} (asset ${target.assetId}, #${target.seq})`,
		dryRun,
	});
}
