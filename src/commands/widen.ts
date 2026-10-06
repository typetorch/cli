/**
 * `typetorch deploy --widen <pct> [--branch <b>]`: re-sends the branch's live deploy (the SAME seq) with a new rollout %
 * (kernel 0.2.3: servers below the new bucket that still run the old artifact swap; 100 = every server, sent without
 * `ro`). Dev-channel branches only (rollout.ts). No build, upload, registry write or new seq; logged to rollouts.jsonl.
 * Approval follows typetorch.json like a deploy, as a y/N at the terminal (it can't wait as a proposal: a proposal
 * would re-send an old message).
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitInfo } from "../git.ts";
import { interaction, NotInteractiveError, type Interaction } from "../interact.ts";
import { bold, dim, emitJson, info, isJson } from "../log.ts";
import { branchChannel, branchFromGit, branchNameError, strictest } from "../naming.ts";
import { DEPLOY_TOPIC, deployMessage, encodeDeployMessage, type OpenCloud } from "../opencloud.ts";
import { appendRollout, checkRollout, parseWiden, ROLLOUTS_LOG, type RolloutRecord } from "../rollout.ts";
import { reportDurableHead, storeDurableHead } from "../durablehead.ts";
import { modeFor } from "./approve.ts";
import { openCloud, project, projectStateDir, readHistory, registryApi, warnRegistryFallback } from "./common.ts";
import { fleetFor, waitForFleet, waitSeconds } from "./fleet.ts";

/** The newest rollout % recorded for (branch, seq): a widen, else the deploy's own; undefined = every server. */
export function currentRollout(dir: string, branch: string, seq: number, deployed?: number): number | undefined {
	const file = join(dir, ROLLOUTS_LOG);
	let latest: RolloutRecord | undefined;
	if (existsSync(file)) {
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			try {
				const entry = JSON.parse(line) as RolloutRecord;
				if (entry?.branch === branch && entry.seq === seq) latest = entry;
			} catch {}
		}
	}
	if (latest) return latest.rollout >= 100 ? undefined : latest.rollout;
	return deployed;
}

export interface WidenDeps {
	oc?: OpenCloud;
	io?: Interaction;
}

export async function widenCommand(args: ParsedArgs, deps: WidenDeps = {}) {
	const pct = parseWiden(flagString(args, "widen"))!;
	for (const flag of ["rollout", "message", "channel", "skip-test"]) {
		if (args.flags[flag] !== undefined) throw new UsageError(`--widen re-sends the live deploy; --${flag} goes with a new deploy`);
	}
	for (const flag of ["no-build", "test", "propose", "force"]) {
		if (args.flags[flag] === true) throw new UsageError(`--widen re-sends the live deploy; --${flag} doesn't apply`);
	}
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const git = gitInfo(proj.root);
	const branch = flagString(args, "branch") ?? (git.gitBranch ? branchFromGit(git.gitBranch, proj.config.branches) : undefined);
	if (!branch) throw new UsageError("which branch? pass --branch <name>");
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const noRegistry = flagBool(args, "no-registry");
	const oc = deps.oc ?? openCloud("deploy", true);
	const api = registryApi(oc, proj, noRegistry);
	const history = await readHistory(proj, api, noRegistry ? "--no-registry" : "no API key");
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	const channel = strictest(branchChannel(proj.config, branch), history.snapshot?.value.channels[branch]);
	checkRollout(branch, channel, pct, "--widen");
	const wait = waitSeconds(args, channel);
	const head = history.heads.get(branch);
	if (!head) throw new Error(`${branch} has no deployments to widen (${history.stateDir})`);
	const row = history.rows.filter((d) => d.branch === branch && d.seq === head.seq && d.assetId === head.assetId).at(-1);
	const dir = projectStateDir(proj);
	const before = currentRollout(dir, branch, head.seq, row?.rollout);
	const message = deployMessage({
		b: branch,
		a: head.assetId,
		i: head.artifactId,
		s: head.seq,
		c: head.commit,
		ch: row?.channel ?? head.channel,
		rollback: row?.action === "rollback",
		...(pct < 100 ? { rollout: pct } : {}),
	});
	const text = encodeDeployMessage(message);
	const what = `#${head.seq} ${branch} ${head.artifactId} (asset ${head.assetId}) from ${before !== undefined ? `${before}%` : "every server (or unknown)"} to ${pct >= 100 ? "every server" : `${pct}% of servers`}`;
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, branch, seq: head.seq, from: before ?? null, to: pct, message: { topic: DEPLOY_TOPIC, data: message } });
		info(bold(`dry run: would widen ${what}`));
		info(`  message   ${DEPLOY_TOPIC} ${text}`);
		return;
	}
	const io = deps.io ?? interaction();
	const { mode } = modeFor(proj, args, channel, io);
	if (mode.kind === "propose") throw new NotInteractiveError(`widening ${branch} needs your y/N at an interactive terminal (it can't wait as a proposal)`);
	if (mode.kind === "approve-now") {
		info(bold(`widen ${what}`));
		if (!(await io.confirm("Publish it?"))) {
			info("not published");
			return;
		}
	}
	const client = oc ?? openCloud("deploy")!;
	await client.publishMessage(proj.config.universeId, DEPLOY_TOPIC, text);
	// The durable head with the new rollout (same seq, newer t): servers that start later take the widened rollout.
	reportDurableHead(await storeDurableHead(client, proj.config.universeId, message), message);
	appendRollout(dir, { universeId: proj.config.universeId, branch, seq: head.seq, artifactId: head.artifactId, assetId: head.assetId, rollout: pct, ...(before !== undefined ? { from: before } : {}), by: git.userName });
	if (!isJson()) {
		info(bold(`widened ${what}`));
		info(dim(`  ${DEPLOY_TOPIC} ${text}`));
	}
	const setup = wait !== undefined ? fleetFor(proj) : undefined;
	if (setup && !setup.client) info(dim(`  not waiting for the servers' reports: ${setup.missing}`));
	const fleet =
		wait !== undefined && setup?.client
			? await waitForFleet({ fleet: setup.client, branch, seq: head.seq, artifactId: head.artifactId, fromArtifactId: row?.fromArtifactId, seconds: wait })
			: undefined;
	if (isJson()) emitJson({ branch, seq: head.seq, from: before ?? null, to: pct, message, ...(fleet ? { fleet } : {}) });
}
