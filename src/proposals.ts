/**
 * Deploy proposals (decision: "approve each deploy myself"). When a deploy, rollback or promote needs approval and the
 * caller can't approve it (an agent, the dev-server, a script, or the user chose `--propose`), the CLI builds, uploads
 * and waits for moderation, then appends a proposal to `<state dir>/proposals.jsonl` and publishes nothing.
 * `typetorch approve <id>` (a person at an interactive terminal: details, y/N) publishes it.
 *
 * proposals.jsonl is append-only, one JSON object per line:
 *   {"event":"proposed", "id", "at", "expiresAt", "kind", "branch", "branchChannel", "artifact": {...}, ...}
 *   {"event":"approved", "id", "at", "by", "seq", "artifactId"}
 *   {"event":"rejected", "id", "at", "by", "reason"?}
 *   {"event":"failed",   "id", "at", "error"}        an approval whose publish failed; the proposal stays pending
 * A proposal's status: approved or rejected after such an event, else expired once `expiresAt` (24 h) has passed,
 * else pending. The dev-server watches this file (and deployments.jsonl) to update its deploy card.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryDeployment } from "./registry.ts";
import type { BuildSources, Channel } from "./naming.ts";

export const PROPOSALS_LOG = "proposals.jsonl";
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
export const PROPOSER_PATTERN = /^[a-z0-9][a-z0-9/._-]{0,47}$/;

export type ProposalKind = "deploy" | "rollback" | "promote" | "resign";
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ProposalArtifact {
	artifactId: string;
	assetId: number;
	channel: Channel;
	commit: string;
	commitHash: string;
	dirty: boolean;
	sources?: BuildSources;
	sha256?: string;
	bytes?: number;
	builtAt?: string;
	assetName?: string;
}

export interface Proposal {
	event: "proposed";
	id: string;
	at: string;
	expiresAt: string;
	kind: ProposalKind;
	branch: string;
	/** The branch's channel when proposed (prod-channel branches show a warning on approval). */
	branchChannel: Channel;
	artifact: ProposalArtifact;
	/** The --message (or Claude's summary). */
	message?: string;
	/** What changed (the payload's Notes changes). */
	changes?: string[];
	/** Who proposed it: "cli", "dev-server/claude", "agent", ... */
	proposedBy: string;
	/** The git/OS user that ran the proposing command. */
	by: string;
	/** The channel guard was overridden with --force when proposing. */
	force: boolean;
	/** The branch head when proposed. */
	from?: { artifactId: string; assetId: number; seq: number };
	universeId?: number;
	project?: string;
}

export interface ProposalEvent {
	event: "approved" | "rejected" | "failed";
	id: string;
	at: string;
	by?: string;
	seq?: number;
	artifactId?: string;
	reason?: string;
	error?: string;
}

export interface ProposalState {
	proposal: Proposal;
	status: ProposalStatus;
	/** The approved/rejected event. */
	decision?: ProposalEvent;
	/** The newest failed approval attempt, if any. */
	lastError?: string;
}

export function newProposalId(): string {
	return randomBytes(4).toString("hex");
}

export function proposalFile(dir: string): string {
	return join(dir, PROPOSALS_LOG);
}

function append(dir: string, entry: unknown) {
	mkdirSync(dir, { recursive: true });
	appendFileSync(proposalFile(dir), JSON.stringify(entry) + "\n");
}

export function appendProposal(dir: string, proposal: Omit<Proposal, "event" | "id" | "at" | "expiresAt">, now = Date.now()): Proposal {
	const full: Proposal = {
		event: "proposed",
		id: newProposalId(),
		at: new Date(now).toISOString(),
		expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
		...proposal,
	};
	append(dir, full);
	return full;
}

export function appendProposalEvent(dir: string, event: Omit<ProposalEvent, "at">): ProposalEvent {
	const full: ProposalEvent = { ...event, at: new Date().toISOString() } as ProposalEvent;
	append(dir, full);
	return full;
}

/** Every proposal with its status, oldest first. */
export function readProposals(dir: string, options: { universeId?: number; now?: number } = {}): ProposalState[] {
	const file = proposalFile(dir);
	if (!existsSync(file)) return [];
	const now = options.now ?? Date.now();
	const states = new Map<string, ProposalState>();
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (line.trim() === "") continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // a torn line
		}
		if (typeof entry?.id !== "string") continue;
		if (entry.event === "proposed") {
			if (options.universeId !== undefined && entry.universeId !== undefined && entry.universeId !== options.universeId) continue;
			if (!states.has(entry.id)) states.set(entry.id, { proposal: entry as Proposal, status: "pending" });
			continue;
		}
		const state = states.get(entry.id);
		if (!state || state.status !== "pending") continue; // the first decision wins
		if (entry.event === "approved" || entry.event === "rejected") {
			state.status = entry.event;
			state.decision = entry as ProposalEvent;
		} else if (entry.event === "failed") state.lastError = typeof entry.error === "string" ? entry.error : "failed";
	}
	for (const state of states.values()) {
		if (state.status === "pending" && Date.parse(state.proposal.expiresAt) <= now) state.status = "expired";
	}
	return [...states.values()];
}

/** Pending proposals, newest first. */
export function pendingProposals(dir: string, options: { universeId?: number; now?: number } = {}): ProposalState[] {
	// readProposals keeps file order; reversing first makes equal timestamps newest-first too (sort is stable).
	return readProposals(dir, options)
		.filter((s) => s.status === "pending")
		.reverse()
		.sort((a, b) => b.proposal.at.localeCompare(a.proposal.at));
}

/** A proposal by id or unique id prefix (4+ characters). */
export function findProposal(states: ProposalState[], wanted: string): ProposalState | undefined {
	const text = wanted.trim().toLowerCase();
	const exact = states.find((s) => s.proposal.id === text);
	if (exact || text.length < 4) return exact;
	const matches = states.filter((s) => s.proposal.id.startsWith(text));
	return matches.length === 1 ? matches[0] : undefined;
}

/** "3 min", "2 h 5 min", "1 d". */
export function age(fromIso: string, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - Date.parse(fromIso)) / 60_000));
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
	return `${Math.floor(minutes / (24 * 60))} d`;
}

/** The deployment action a proposal kind publishes as. */
export function proposalAction(kind: ProposalKind): RegistryDeployment["action"] {
	return kind;
}
