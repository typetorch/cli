/**
 * `typetorch rollback`: re-point a branch at an already approved payload asset (no build, upload or moderation wait)
 * and tell its servers. Without --to it picks the newest earlier deployment on the branch whose artifact differs from
 * the live head.
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { matchDeployment, previousDifferent } from "../deployments";
import { gitInfo } from "../git";
import { bold, dim, emitJson, formatTimings, info, isJson, Stopwatch } from "../log";
import { branchChannel, branchFromGit, branchNameError, strictest } from "../naming";
import { DEPLOY_TOPIC, deployMessage } from "../opencloud";
import { assertNoForeignDraft } from "../registry";
import { openCloud, project, readHistory, registryApi, warnRegistryFallback } from "./common";
import { checkChannelGuard } from "./deploy";
import { makeEntry, registryMessage, release } from "./release";

export const rollbackFlags = {
	branch: "string",
	to: "string",
	force: "boolean",
	"dry-run": "boolean",
	"no-registry": "boolean",
	message: "string",
} as const;

export async function rollbackCommand(args: ParsedArgs) {
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	const noRegistry = flagBool(args, "no-registry");
	const note = flagString(args, "message");
	const git = gitInfo(proj.root);
	const branch = flagString(args, "branch") ?? args.positionals[0] ?? (git.gitBranch ? branchFromGit(git.gitBranch, proj.config.branches) : undefined);
	if (!branch) throw new UsageError("which branch? pass --branch <name>");
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);

	const oc = openCloud(dryRun);
	const api = registryApi(oc, proj, noRegistry);
	const watch = new Stopwatch();
	const history = await watch.stage("read", () => readHistory(proj, api, noRegistry ? "--no-registry" : "no API key (dry run)"));
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	if (history.snapshot) assertNoForeignDraft(history.snapshot, force);

	const head = history.heads.get(branch);
	if (!head) {
		throw new Error(
			`branch "${branch}" has no deployments in the ${history.snapshot ? "registry or the " : ""}local log (.typetorch/deployments.jsonl)`,
		);
	}
	const wanted = flagString(args, "to");
	const target = wanted ? matchDeployment(history.rows, wanted, branch) : previousDifferent(history.rows, branch, head);
	if (!target) {
		throw new Error(
			wanted
				? `no deployment matches "${wanted}" (try a #seq, asset id, artifact id or commit from \`typetorch deployments\`)`
				: `nothing to roll back to: no earlier deployment on "${branch}" has a different artifact than ${head.artifactId}`,
		);
	}
	if (target.assetId === head.assetId) throw new Error(`${target.artifactId} (asset ${target.assetId}) is already live on ${branch}`);

	const targetChannel = strictest(branchChannel(proj.config, branch), history.snapshot?.value.channels[branch]);
	checkChannelGuard({ branch, branchChannel: targetChannel, artifactChannel: target.channel, dirty: target.dirty, force });

	const artifact = {
		artifactId: target.artifactId,
		assetId: target.assetId,
		channel: target.channel,
		commit: target.commit,
		commitHash: target.commitHash,
		dirty: target.dirty,
	};
	const summary = `${branch}: ${head.artifactId} (asset ${head.assetId}) -> ${target.artifactId} (asset ${target.assetId}, #${target.seq})`;

	if (dryRun) {
		const entry = makeEntry({ action: "rollback", branch, artifact, by: git.userName }, history.snapshot?.value, history.local);
		const message = deployMessage({ b: branch, a: target.assetId, i: target.artifactId, s: entry.seq, c: target.commit, ch: target.channel, rollback: true });
		const plan = {
			dryRun: true,
			branch,
			from: head,
			to: target,
			seq: entry.seq,
			registry: history.snapshot
				? { readable: true, message: registryMessage("rollback", branch, target.artifactId, note) }
				: { readable: false, reason: history.unavailable },
			message: { topic: DEPLOY_TOPIC, data: message },
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would roll back ${summary} as #${entry.seq}`));
		info(`  registry  ${history.snapshot ? `would publish "${plan.registry.message}"` : `not used (${history.unavailable})`}`);
		info(`  message   ${DEPLOY_TOPIC} ${JSON.stringify(message)}`);
		return;
	}

	info(`rolling back ${summary}`);
	const result = await release({
		proj,
		oc: oc!,
		api: history.snapshot ? api : undefined,
		history,
		action: "rollback",
		branch,
		artifact,
		by: git.userName,
		force,
		note,
		watch,
	});
	const timings = watch.total();
	if (isJson()) return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, timings });
	info(bold(`rolled back #${result.entry.seq} ${summary} in ${timings.total.toFixed(2)} s`));
	info(dim(`  ${formatTimings(timings)}`));
}
