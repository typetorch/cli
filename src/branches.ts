/**
 * Branch removals recorded on this machine (`typetorch branch rm`, `<state dir>/branches.jsonl`) and the kernel's
 * branch cap. Kept apart from commands/branch.ts so commands/common.ts (withLocal) can hide removed heads.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Kernel Constants.HEADS_MAX_BRANCHES: servers record at most this many branches in `heads`. */
export const HEADS_MAX_BRANCHES = 32;
/** `doctor` and `deploy` warn from this many stored branches on. */
export const HEADS_WARN_AT = 28;
export const BRANCH_LOG = "branches.jsonl";

/** A removal recorded on this machine: the branch's heads up to `seq` are gone. */
export interface BranchRemoval {
	event: "branch-removed";
	at: string;
	branch: string;
	/** The removed head's seq (heads at or below it are hidden from this machine's log). */
	seq: number;
	artifactId?: string;
	by?: string;
	universeId: number;
}

export function readRemovals(stateDir: string, universeId?: number): BranchRemoval[] {
	const file = join(stateDir, BRANCH_LOG);
	if (!existsSync(file)) return [];
	const out: BranchRemoval[] = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		try {
			const entry = JSON.parse(line);
			if (entry?.event === "branch-removed" && typeof entry.branch === "string" && typeof entry.seq === "number" && (universeId === undefined || entry.universeId === universeId)) out.push(entry);
		} catch {}
	}
	return out;
}

/** Drops the heads a removal covers (the head's seq at or below the removed one). */
export function withoutRemoved<T extends { seq: number }>(heads: Map<string, T>, removals: BranchRemoval[]): Map<string, T> {
	for (const removal of removals) {
		const head = heads.get(removal.branch);
		if (head && head.seq <= removal.seq) heads.delete(removal.branch);
	}
	return heads;
}

/** The stored-branch count line, or undefined below HEADS_WARN_AT. */
export function branchCapWarning(count: number): string | undefined {
	if (count < HEADS_WARN_AT) return undefined;
	const full = count >= HEADS_MAX_BRANCHES;
	return `the kernel's stored heads hold ${count} branches (servers record at most ${HEADS_MAX_BRANCHES})${full ? ": a deploy to a NEW branch isn't recorded by servers (only the CLI's durable copy has it)" : ""}. Remove dev branches nothing runs: typetorch branch ls, then typetorch branch rm <branch>`;
}

