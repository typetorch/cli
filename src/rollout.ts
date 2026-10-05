/**
 * Partial rollouts (plans/12 P-R1; kernel 0.2.3 reads `ro` on deploy messages). `--rollout <1-99>` on deploy, promote
 * and approve sends the message with `ro`: only servers whose bucket (djb2(JobId) % 100) is below it swap; the others
 * keep their artifact and new servers boot the head. `typetorch deploy --widen <pct>` re-sends the SAME seq with a new
 * `ro` (100 = every server: sent without `ro`).
 *
 * Dev-channel branches only: `ro` isn't covered by the signature (tt1), so prod servers ignore it on signed messages and
 * a prod "rollout" would reach every server. Use `typetorch pin --pct` (signed A/B pins) on prod instead.
 *
 * The registry head never carries the rollout: the kernel keeps a stored head with `ro` over a config head of the same
 * seq without one (Registry.branchHead), so a widen sent as a message alone reaches the polling path too.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./args.ts";
import type { Channel } from "./naming.ts";

export const ROLLOUTS_LOG = "rollouts.jsonl";

/** `--rollout`: a whole percent from 1 to 99 (undefined when not given). */
export function parseRollout(value: string | undefined, flag = "--rollout"): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 99) throw new UsageError(`${flag} must be a whole percent from 1 to 99, got "${value}"`);
	return Number(value);
}

/** `--widen`: 1-100 (100 = every server). */
export function parseWiden(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new UsageError(`--widen must be a whole percent from 1 to 100 (100 = every server), got "${value}"`);
	return Number(value);
}

export class RolloutError extends UsageError {
	override name = "RolloutError";
}

/** Refuses a rollout on a prod-channel branch (prod servers ignore `ro` on signed messages). */
export function checkRollout(branch: string, branchChannel: Channel, rollout: number | undefined, flag = "--rollout") {
	if (rollout === undefined || branchChannel !== "prod") return;
	throw new RolloutError(
		`${flag} only works on dev-channel branches: "${branch}" is prod-channel, and prod servers ignore the rollout % on signed deploy messages (it isn't covered by the signature), so every server would take it. Deploy without ${flag}, or try it on some prod servers first with signed A/B pins: typetorch pin <artifact> --branch ${branch} --pct <1-99>`,
	);
}

export interface RolloutRecord {
	at: string;
	universeId: number;
	branch: string;
	seq: number;
	artifactId: string;
	assetId: number;
	/** The new rollout % (100 = every server). */
	rollout: number;
	/** The rollout before (the deploy's, or the last widen's); undefined = unknown. */
	from?: number;
	by: string;
}

export function appendRollout(dir: string, record: Omit<RolloutRecord, "at">): RolloutRecord {
	const full: RolloutRecord = { at: new Date().toISOString(), ...record };
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, ROLLOUTS_LOG), JSON.stringify(full) + "\n");
	return full;
}

export const ROLLOUT_USAGE = `  --rollout <1-99>     dev-channel branches only: only that % of the branch's servers swap (the others keep their
                       artifact; new servers boot it); widen later with typetorch deploy --widen <pct>`;

export const WIDEN_USAGE = `typetorch deploy --widen <1-100> [--branch <b>] [--dry-run] [--wait [s]]
  re-sends the branch's live deploy (same seq) with a new rollout %; 100 = every server. Dev-channel branches only.`;
