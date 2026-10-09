/**
 * `typetorch branch ls` and `typetorch branch rm <branch>`: the branches with a stored head, and removing a dev branch's
 * head when nothing runs it any more.
 *
 * Why: the kernel keeps every branch's head in ONE key, `heads` (DataStore "TypeTorch", and the MemoryStore HashMap of
 * the same name), and records at most HEADS_MAX_BRANCHES (32) branches: a deploy message for a new branch beyond that
 * isn't recorded by servers (kernel 0.3.6, Registry.luau admitsBranch). Every git branch deployed once (`deploy` from an
 * unmapped git branch makes a branch of its name) stays there for good.
 *
 * `rm` removes the branch from the durable copy (a version-guarded read-merge-write, durablehead.ts updateEntry) and
 * records the removal in `<state dir>/branches.jsonl` so this machine's log stops listing its head. It refuses:
 *   - the default branch and every prod-channel branch (typetorch.json `channels`, or a stored prod-channel head);
 *     --force doesn't change that;
 *   - a branch live servers still run (the backend's fleet API); without the fleet API it can't check, and needs --force;
 *   - a branch whose head changed since it was shown (a deploy landed meanwhile).
 * Servers only write a branch into the durable copy when they hear a deploy message FOR it, so the removal sticks. The
 * MemoryStore copy (which API keys can't write) keeps the branch until that key expires (45 days after its last write):
 * `/tt new <branch>` can still find it there until then. Deploying the branch again recreates it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import type { Project } from "../config.ts";
import { updateEntry } from "../durablehead.ts";
import type { FleetClient, ServerRow } from "../fleet.ts";
import { gitInfo } from "../git.ts";
import { interaction } from "../interact.ts";
import { isRecord } from "../json.ts";
import { bold, dim, emitJson, info, isJson, table, warn } from "../log.ts";
import { branchChannel, branchNameError } from "../naming.ts";
import { pendingProposals } from "../proposals.ts";
import { HEADS_KEY, readSharedSeq, type SharedSeq } from "../seqstore.ts";
import type { OpenCloud } from "../opencloud.ts";
import { openCloud, project, projectStateDir, withLocal } from "./common.ts";
import { fleetFor } from "./fleet.ts";
import { BRANCH_LOG, branchCapWarning, HEADS_MAX_BRANCHES, type BranchRemoval } from "../branches.ts";

export { BRANCH_LOG, branchCapWarning, HEADS_MAX_BRANCHES };

export const branchFlags = {
	force: "boolean",
	yes: "boolean",
	"dry-run": "boolean",
} as const;

export class BranchError extends Error {
	override name = "BranchError";
}

export interface BranchRow {
	branch: string;
	channel: "prod" | "dev";
	seq?: number;
	artifactId?: string;
	deployedAt?: string;
	signed: boolean;
	/** In the DataStore heads (else only in this machine's log). */
	stored: boolean;
	isDefault: boolean;
	/** Live servers on the branch (undefined: the fleet API isn't configured or failed). */
	servers?: number;
	/** Git branches typetorch.json maps to it. */
	git: string[];
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The branches: the DataStore heads, this machine's log, typetorch.json's mapped and default branches. */
export function branchRows(input: {
	config: Project["config"];
	shared?: SharedSeq;
	local: Map<string, { seq: number; artifactId: string; deployedAt: string; channel: string }>;
	servers?: ServerRow[];
}): BranchRow[] {
	const { config } = input;
	const names = new Set<string>([config.defaultBranch, ...Object.keys(config.channels ?? {}), ...Object.keys(input.shared?.branches ?? {}), ...input.local.keys()]);
	const rows: BranchRow[] = [];
	for (const branch of names) {
		const stored = input.shared?.branches?.[branch];
		const head = isRecord(stored) && typeof stored.seq === "number" ? stored : undefined;
		const local = input.local.get(branch);
		const useStored = head && (!local || (head.seq as number) >= local.seq);
		const channel = branchChannel(config, branch) === "prod" || head?.channel === "prod" ? "prod" : "dev";
		rows.push({
			branch,
			channel,
			seq: useStored ? (head!.seq as number) : local?.seq,
			artifactId: useStored ? str(head!.artifactId) : local?.artifactId,
			deployedAt: useStored ? str(head!.deployedAt) : local?.deployedAt,
			signed: Boolean(head && (typeof head.sig === "string" || typeof head.sigF === "string")),
			stored: head !== undefined,
			isDefault: branch === config.defaultBranch,
			servers: input.servers ? input.servers.filter((s) => s.branch === branch).length : undefined,
			git: Object.entries(config.branches ?? {})
				.filter(([, to]) => to === branch)
				.map(([git]) => git),
		});
	}
	return rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (b.seq ?? -1) - (a.seq ?? -1) || a.branch.localeCompare(b.branch));
}

export interface BranchDeps {
	oc?: Pick<OpenCloud, "request">;
	/** undefined: fleetFor(proj); null: not configured. */
	fleet?: FleetClient | null;
	io?: { interactive: boolean; confirm(question: string): Promise<boolean> };
}

async function liveServers(proj: Project, deps: BranchDeps): Promise<{ servers?: ServerRow[]; why?: string }> {
	let client: FleetClient | undefined;
	if (deps.fleet === null) return { why: "the backend's fleet API isn't configured" };
	if (deps.fleet) client = deps.fleet;
	else {
		const setup = fleetFor(proj);
		if (!setup.client) return { why: setup.missing };
		client = setup.client;
	}
	try {
		return { servers: await client.servers({}) };
	} catch (error) {
		return { why: `the fleet API failed: ${(error as Error).message}` };
	}
}

export async function branchCommand(args: ParsedArgs, deps: BranchDeps = {}) {
	const sub = args.positionals[0];
	if (sub === "ls" || sub === "list" || sub === undefined) return branchList(args, deps);
	if (sub === "rm" || sub === "remove") return branchRemove(args, deps);
	throw new UsageError(`unknown branch subcommand "${sub}" (ls, rm)`);
}

async function branchList(args: ParsedArgs, deps: BranchDeps) {
	const proj = project(args);
	const oc = deps.oc ?? openCloud("deploy", true);
	const shared = oc ? await readSharedSeq(oc, proj.config.universeId) : undefined;
	const { servers, why } = await liveServers(proj, deps);
	const local = withLocal(proj).heads;
	const rows = branchRows({ config: proj.config, shared, local, servers });
	const storedCount = Object.keys(shared?.branches ?? {}).length;
	// `source`, `default` and `head` as `branch ls` printed them before CLI 0.9.2 (scripts read them).
	const json = rows.map((r) => ({ ...r, default: r.isDefault, head: local.get(r.branch) ?? (isRecord(shared?.branches?.[r.branch]) ? shared!.branches![r.branch] : null) }));
	if (isJson()) return emitJson({ source: shared?.branches ? "datastore+local" : "local", branches: json, stored: shared?.branches ? storedCount : null, max: HEADS_MAX_BRANCHES, servers: servers ? true : (why ?? null) });
	info(
		table(
			["branch", "channel", "head", "deployed", "signed", "servers", "git"],
			rows.map((r) => [
				`${r.branch}${r.isDefault ? " (default)" : ""}`,
				r.channel,
				r.seq !== undefined ? `#${r.seq} ${r.artifactId ?? ""}${r.stored ? "" : " (this machine only)"}` : "none",
				r.deployedAt ?? "-",
				r.channel === "prod" ? (r.signed ? "yes" : r.stored ? "NO" : "-") : "-",
				r.servers !== undefined ? String(r.servers) : "?",
				r.git.join(", ") || "-",
			]),
		),
	);
	if (!shared?.branches) warn(`the DataStore heads weren't read (${oc ? (shared?.error ?? "unknown") : "no deploy key"}): only this machine's log is listed`);
	else info(dim(`${storedCount} of ${HEADS_MAX_BRANCHES} branches stored`));
	if (why) info(dim(`servers: ? (${why})`));
	const cap = shared?.branches ? branchCapWarning(storedCount) : undefined;
	if (cap) warn(cap);
}


/** Why `branch` can't be removed (prod), or undefined. */
export function protectedBranch(config: Project["config"], branch: string, stored: unknown): string | undefined {
	if (branch === config.defaultBranch) return `${branch} is the default branch (what public servers run)`;
	if (branchChannel(config, branch) === "prod") return `${branch} is a prod-channel branch (typetorch.json "channels")`;
	if (isRecord(stored) && stored.channel === "prod") return `${branch}'s stored head is a prod-channel build`;
	return undefined;
}

async function branchRemove(args: ParsedArgs, deps: BranchDeps) {
	const branch = args.positionals[1];
	if (!branch || args.positionals.length > 2) throw new UsageError("usage: typetorch branch rm <branch> [--dry-run] [--yes] [--force]");
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const proj = project(args);
	const { config } = proj;
	const force = flagBool(args, "force");
	const dryRun = flagBool(args, "dry-run");
	const stateDir = projectStateDir(proj);

	const oc = deps.oc ?? openCloud("deploy");
	const shared = await readSharedSeq(oc!, config.universeId);
	if (!shared.branches) throw new BranchError(`can't read the DataStore heads: ${shared.error ?? "unknown"}`);
	const stored = shared.branches[branch];
	const blocked = protectedBranch(config, branch, stored);
	if (blocked) throw new BranchError(`refusing to remove ${branch}: ${blocked}. Only dev branches can be removed (--force doesn't change that)`);
	const local = withLocal(proj).heads.get(branch);
	if (!isRecord(stored) && !local) throw new BranchError(`no branch ${branch}: neither the DataStore heads nor this machine's log has it (typetorch branch ls)`);
	const seq = isRecord(stored) && typeof stored.seq === "number" ? stored.seq : (local?.seq ?? 0);
	const artifactId = isRecord(stored) ? str(stored.artifactId) : local?.artifactId;

	// Live servers on the branch: never removed from under them.
	const { servers, why } = await liveServers(proj, deps);
	if (servers) {
		const running = servers.filter((s) => s.branch === branch);
		if (running.length) {
			const players = running.reduce((n, s) => n + (s.players ?? 0), 0);
			throw new BranchError(`refusing to remove ${branch}: ${running.length} live server(s) run it (${players} player(s); typetorch servers --branch ${branch}). Wait for them to close (or move them with the dev menu), then run this again`);
		}
	} else if (!force) {
		throw new BranchError(`refusing to remove ${branch}: can't check that no live server runs it (${why}). Pass --force if you know none does`);
	} else warn(`not checked for live servers (${why}): removing anyway (--force)`);

	const notes: string[] = [];
	const mapped = Object.entries(config.branches ?? {})
		.filter(([, to]) => to === branch)
		.map(([git]) => git);
	if (mapped.length) notes.push(`typetorch.json maps git branch ${mapped.join(", ")} to it: the next deploy from there recreates it`);
	const proposals = pendingProposals(stateDir, { universeId: config.universeId }).filter((p) => p.proposal.branch === branch);
	if (proposals.length) notes.push(`${proposals.length} pending proposal(s) target it (${proposals.map((p) => p.proposal.id).join(", ")}): approving one recreates it (typetorch reject <id>)`);
	notes.push("servers' fast copy (MemoryStore, which API keys can't write) keeps it until that copy expires (45 days after its last write): /tt new can still find it until then");

	const what = `${branch} (#${seq}${artifactId ? ` ${artifactId}` : ""}${isRecord(stored) ? "" : ", this machine's log only"})`;
	if (!isJson()) {
		info(`${dryRun ? "dry run: would remove" : "removing"} ${what} from the stored heads${servers ? " (no live server runs it)" : ""}`);
		for (const note of notes) info(dim(`  note: ${note}`));
	}
	if (dryRun) {
		if (isJson()) emitJson({ dryRun: true, branch, seq, artifactId: artifactId ?? null, notes });
		return;
	}
	if (!flagBool(args, "yes")) {
		const io = deps.io ?? interaction();
		if (!io.interactive) throw new UsageError("refusing to remove without --yes (no interactive terminal to ask)");
		if (!(await io.confirm(`Remove branch ${branch}?`))) {
			info("not removed");
			return;
		}
	}

	let outcome = "unchanged";
	if (isRecord(stored)) {
		let changed = false;
		const write = await updateEntry(oc!, config.universeId, HEADS_KEY, (value) => {
			if (!isRecord(value) || !(branch in value)) return undefined;
			const now = value[branch];
			// A deploy landed since the read: leave it.
			if (!isRecord(now) || now.seq !== seq) {
				changed = true;
				return undefined;
			}
			const next = { ...value };
			delete next[branch];
			return next;
		});
		if (changed) throw new BranchError(`${branch}'s head changed since it was read (a deploy landed): nothing removed. Check typetorch branch ls`);
		if (write.error) throw new BranchError(`removing ${branch} from the DataStore heads failed${write.scopeMissing ? " (the deploy key needs universe-datastores.objects:read, :create and :update)" : ""}: ${write.error}`);
		outcome = write.outcome ?? "unchanged";
	}
	const record: BranchRemoval = { event: "branch-removed", at: new Date().toISOString(), branch, seq, ...(artifactId ? { artifactId } : {}), by: gitInfo(proj.root).userName, universeId: config.universeId };
	mkdirSync(stateDir, { recursive: true });
	appendFileSync(join(stateDir, BRANCH_LOG), `${JSON.stringify(record)}\n`);
	if (isJson()) return emitJson({ removed: branch, seq, artifactId: artifactId ?? null, durable: outcome, notes });
	info(bold(`removed ${branch}${outcome === "written" ? " from the DataStore heads" : " (it wasn't in the DataStore heads)"}; recorded in ${BRANCH_LOG}`));
}
