/**
 * The automatic rollback `--wait` runs when a deploy's failures cross the threshold (fleet.ts `rollbackDecision`;
 * user decision 2026-10-05, replacing "never roll back by itself"):
 *   1. pick the previous artifact: the deploy's `from` (the head it replaced), else the newest earlier different one;
 *   2. post a critical `auto_rollback` alert to the fleet API (ingest token), or print it without one;
 *   3. at a terminal, a 10 s notice ("Ctrl+C keeps the new build"); without one, no wait;
 *   4. the same release path as `typetorch rollback` (release.ts, action "rollback"): signed with both keys on a
 *      prod-channel branch (the deployer's PC holds them); the reason goes on the deployment line (`autoRollback`)
 *      and, when the deploy came from a proposal, as an `auto_rollback` proposal event;
 *   5. then waits for the rollback's own reports (no second automatic rollback).
 * The approval policy isn't asked again: the person who approved the deploy chose --wait with auto-rollback.
 */
import { appendProposalEvent } from "../proposals.ts";
import type { Project } from "../config.ts";
import { matchDeployment, previousDifferent, type LocalDeployment } from "../deployments.ts";
import type { FleetClient } from "../fleet.ts";
import { gitInfo } from "../git.ts";
import { interaction, type Interaction } from "../interact.ts";
import type { KeyRole } from "../keyfiles.ts";
import { bold, info, red, Stopwatch, warn } from "../log.ts";
import type { Channel } from "../naming.ts";
import type { OpenCloud } from "../opencloud.ts";
import { progress } from "../progress.ts";
import type { DualSigner } from "../signing.ts";
import { projectStateDir, readHistory, signerFor } from "./common.ts";
import type { AutoRollbackHook } from "./fleet.ts";
import { release, type ReleaseResult } from "./release.ts";

export const ROLLBACK_NOTICE_SECONDS = 10;

/** The 10 s window: resolves "kept" on Ctrl+C, "go" when the time is up. Without a terminal: "go" at once. */
export async function countdown(io: Interaction, seconds: number, text: string): Promise<"go" | "kept"> {
	if (!io.interactive) return "go";
	info(red(bold(text)));
	return progress().suspend(
		() =>
			new Promise<"go" | "kept">((resolve) => {
				const onSigint = () => {
					clearTimeout(timer);
					resolve("kept");
				};
				const timer = setTimeout(() => {
					process.removeListener("SIGINT", onSigint);
					resolve("go");
				}, seconds * 1000);
				process.once("SIGINT", onSigint);
			}),
	);
}

export interface AutoRollbackInput {
	proj: Project;
	/** A client with the deploy key (messages). */
	oc: OpenCloud;
	fleet: FleetClient;
	/** The deploy that failed. */
	deployed: LocalDeployment;
	branchChannel: Channel;
	keyPaths: Record<KeyRole, string>;
	/** Tests: both keys already loaded. */
	signer?: DualSigner;
	io?: Interaction;
	/** Tests: replaces the 10 s window. */
	countdown?: (seconds: number, text: string) => Promise<"go" | "kept">;
	/** Waits for the rollback's own reports (fleet.ts waitForFleet without auto-rollback). */
	waitAfter?: (result: ReleaseResult) => Promise<unknown>;
}

/** The hook `waitForFleet` calls when the threshold is met. */
export function autoRollbackHook(input: AutoRollbackInput, threshold: number): AutoRollbackHook {
	return {
		threshold,
		run: async ({ reason }) => {
			const { proj, deployed } = input;
			const history = await readHistory(proj);
			const target =
				(deployed.fromAssetId !== undefined ? matchDeployment(history.rows.filter((d) => d.assetId === deployed.fromAssetId), String(deployed.fromAssetId), deployed.branch) : undefined) ??
				previousDifferent(history.rows, deployed.branch, deployed);
			if (!target) {
				warn(`auto-rollback: ${deployed.branch} has no earlier artifact to roll back to; nothing changed`);
				return { rolledBack: false };
			}
			const alertText = `auto-rollback of ${deployed.branch}: #${deployed.seq} ${deployed.artifactId} -> ${target.artifactId} (#${target.seq}): ${reason}`;
			try {
				const sent = await input.fleet.postAlert({ level: "critical", code: "auto_rollback", message: alertText, branch: deployed.branch, seq: deployed.seq, artifact: deployed.artifactId });
				if (!sent) info(red(`ALERT auto_rollback (not posted: no ingest token): ${alertText}`));
			} catch (error) {
				warn(`posting the auto_rollback alert failed (${(error as Error).message}): ${alertText}`);
			}
			const wait = input.countdown ?? ((seconds: number, text: string) => countdown(input.io ?? interaction(), seconds, text));
			const decision = await wait(ROLLBACK_NOTICE_SECONDS, `rolling back ${deployed.branch} to ${target.artifactId} in ${ROLLBACK_NOTICE_SECONDS} s: Ctrl+C keeps the new build`);
			if (decision === "kept") {
				info(bold(`kept #${deployed.seq} ${deployed.artifactId} on ${deployed.branch} (Ctrl+C); roll back later with: typetorch rollback --branch ${deployed.branch} --to ${target.artifactId}`));
				return { rolledBack: false, kept: true };
			}
			const signer = input.branchChannel === "prod" ? (input.signer ?? signerFor(proj, "prod", input.keyPaths)) : undefined;
			const result = await release({
				proj,
				oc: input.oc,
				history,
				action: "rollback",
				branch: deployed.branch,
				artifact: {
					artifactId: target.artifactId,
					assetId: target.assetId,
					channel: target.channel,
					commit: target.commit,
					commitHash: target.commitHash,
					dirty: target.dirty,
					sources: target.sources,
				},
				by: gitInfo(proj.root).userName,
				force: false,
				note: `auto-rollback: ${reason}`,
				assetName: target.assetName,
				watch: new Stopwatch(),
				branchChannel: input.branchChannel,
				signer,
				extra: {
					changes: [`auto-rollback from #${deployed.seq} (${deployed.artifactId}) to #${target.seq} (${target.artifactId})`],
					proposedBy: "auto-rollback",
					autoRollback: { reason, fromSeq: deployed.seq, fromArtifactId: deployed.artifactId },
					...(target.sha256 ? { sha256: target.sha256 } : {}),
					...(target.protocolHash ? { protocolHash: target.protocolHash } : {}),
				},
			});
			if (deployed.proposalId) appendProposalEvent(projectStateDir(proj), { event: "auto_rollback", id: deployed.proposalId, seq: result.entry.seq, reason: reason.slice(0, 300) });
			info(red(bold(`rolled back #${deployed.seq} ${deployed.branch}: #${result.entry.seq} -> ${target.artifactId} (asset ${target.assetId})`)));
			await input.waitAfter?.(result);
			return { rolledBack: true, seq: result.entry.seq };
		},
	};
}
