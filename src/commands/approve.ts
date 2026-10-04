/**
 * Approving deploys (user decision: "approve each deploy myself"; signing was removed later the same day, the simple
 * approval step stays). Agents, the dev-server and scripts may PREPARE a deploy; only a person at an interactive
 * terminal publishes it.
 *
 *   typetorch approve [id]          pending proposals (newest first) -> details -> y/N -> publish -> log
 *   typetorch reject <id>           drops a proposal
 *   typetorch proposals [--all]     lists them (non-interactive)
 *
 * How a deploy/rollback/promote ends (`releaseMode`):
 *   - approval required by typetorch.json "approval" ("all" by default, or "prod" for prod-channel branches):
 *     - a person at a terminal (proposer "cli", no --propose): the proposal is written and the y/N follows at once
 *       (one command);
 *     - anyone else (an agent, the dev-server, --propose): the proposal is written and nothing is published;
 *   - approval not required ("none", or "prod" for a dev-channel branch): published at once.
 *
 * Limitation: the approval is enforced by the CLI only. Deploy messages are not signed, so anything that holds the Open
 * Cloud deploy key (or runs code on any server of the universe) can still publish a deploy message (audit S-C2).
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { approvalRequired, type ApprovalPolicy, type Project } from "../config";
import type { LiveHead } from "../deployments";
import { settings } from "../env";
import { gitInfo } from "../git";
import { interaction, NotInteractiveError, type Interaction } from "../interact";
import { bold, dim, emitJson, formatTimings, info, isJson, red, Stopwatch, table, yellow } from "../log";
import { branchChannel, formatSources, strictest, type Channel } from "../naming";
import { DEPLOY_TOPIC, type OpenCloud } from "../opencloud";
import {
	age,
	appendProposal,
	appendProposalEvent,
	findProposal,
	pendingProposals,
	PROPOSER_PATTERN,
	readProposals,
	type Proposal,
	type ProposalArtifact,
	type ProposalKind,
	type ProposalState,
} from "../proposals";
import type { RegistryApi } from "../registry";
import { openCloud, project, projectStateDir, readHistory, registryApi, warnRegistryFallback, type History } from "./common";
import { checkChannelGuard } from "./deploy";
import { makeEntry, messageFor, registryMessage, release, type ReleaseResult } from "./release";

export const PROPOSED_BY_VAR = "TYPETORCH_PROPOSED_BY";

export interface Proposer {
	name: string;
	/** Given with --proposed-by or TYPETORCH_PROPOSED_BY (not inferred). */
	explicit: boolean;
}

/** --proposed-by, else TYPETORCH_PROPOSED_BY, else "cli" for a person at a terminal and "agent" for anything else. */
export function resolveProposer(flag: string | undefined, interactive: boolean): Proposer {
	const given = flag ?? settings().get(PROPOSED_BY_VAR)?.value;
	if (given !== undefined) {
		const name = given.trim().toLowerCase();
		if (!PROPOSER_PATTERN.test(name)) throw new UsageError(`--proposed-by must match ${PROPOSER_PATTERN} (e.g. cli, agent, dev-server/claude)`);
		return { name, explicit: true };
	}
	return { name: interactive ? "cli" : "agent", explicit: false };
}

export type ReleaseMode = { kind: "approve-now" } | { kind: "propose" } | { kind: "publish" };

/** How a release ends (see the module comment). */
export function releaseMode(input: { policy: ApprovalPolicy; branchChannel: Channel; proposer: Proposer; interactive: boolean; propose: boolean }): ReleaseMode {
	if (input.propose) return { kind: "propose" };
	if (!approvalRequired(input.policy, input.branchChannel)) return { kind: "publish" };
	const person = input.interactive && input.proposer.name === "cli";
	return person ? { kind: "approve-now" } : { kind: "propose" };
}

/** The mode for a command. */
export function modeFor(proj: Project, args: ParsedArgs, branchChannel: Channel, io: Interaction = interaction()): { mode: ReleaseMode; proposer: Proposer } {
	const proposer = resolveProposer(flagString(args, "proposed-by"), io.interactive);
	const mode = releaseMode({ policy: proj.config.approval, branchChannel, proposer, interactive: io.interactive, propose: flagBool(args, "propose") });
	return { mode, proposer };
}

/** The human description of a proposal (approve shows it before asking). */
export function describeProposal(state: ProposalState, head: LiveHead | undefined, now = Date.now()): string[] {
	const p = state.proposal;
	const a = p.artifact;
	const lines = [
		bold(`${p.kind} ${a.artifactId} -> ${p.branch}`) + `  (proposal ${p.id}, ${p.branchChannel}-channel branch)`,
		`  artifact   ${a.artifactId}  asset ${a.assetId}  ${a.channel} channel${a.dirty ? yellow("  DIRTY build") : ""}`,
		`  commit     ${a.commit || "uncommitted"}${a.sources ? `   sources ${formatSources(a.sources)}` : ""}`,
	];
	if (a.bytes !== undefined || a.builtAt) lines.push(`  payload    ${a.bytes !== undefined ? `${(a.bytes / 1024).toFixed(1)} KB` : "?"}${a.builtAt ? `  built ${a.builtAt.replace("T", " ").slice(0, 19)} UTC` : ""}`);
	lines.push(`  proposed   by ${p.proposedBy} (${p.by}), ${age(p.at, now)} ago; expires in ${age(new Date(now).toISOString(), Date.parse(p.expiresAt))}`);
	if (p.message) lines.push(`  message    ${p.message}`);
	for (const change of p.changes ?? []) lines.push(`  change     ${change}`);
	const live = head ? `${head.artifactId} (asset ${head.assetId}, #${head.seq})` : "nothing yet";
	lines.push(`  replaces   ${live}`);
	if (p.from && head && (p.from.assetId !== head.assetId || p.from.seq !== head.seq)) {
		lines.push(yellow(`  note       the branch moved since the proposal (it ran ${p.from.artifactId}, #${p.from.seq})`));
	}
	if (head && head.assetId === a.assetId) lines.push(yellow("  note       this artifact is already live on the branch"));
	if (p.force) lines.push(yellow("  FORCED     proposed with --force (channel guard overridden)"));
	if (p.branchChannel === "prod") lines.push(yellow("  PROD       this goes to a prod-channel branch: public servers"));
	if (state.lastError) lines.push(red(`  last try   failed: ${state.lastError}`));
	return lines;
}

/**
 * Approves one pending proposal: details -> y/N -> publish -> "approved" event. Returns undefined when the person says
 * no (the proposal stays pending).
 */
export async function approveProposal(
	proj: Project,
	state: ProposalState,
	options: { io?: Interaction; noRegistry?: boolean; approver?: string; oc?: OpenCloud } = {},
): Promise<ReleaseResult | undefined> {
	const io = options.io ?? interaction();
	if (!io.interactive) throw new NotInteractiveError("approving needs a person at an interactive terminal (stdin is not a TTY)");
	const p = state.proposal;
	if (state.status !== "pending") throw new Error(`proposal ${p.id} is ${state.status}`);
	const dir = projectStateDir(proj);
	const deployer = options.oc ?? openCloud("deploy")!;
	const api = registryApi(deployer, proj, options.noRegistry ?? false);
	const watch = new Stopwatch();
	const history = await watch.stage("read", () => readHistory(proj, api, "--no-registry"));
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	const head = history.heads.get(p.branch);
	for (const line of describeProposal(state, head)) info(line);

	const targetChannel = strictest(branchChannel(proj.config, p.branch), history.snapshot?.value.channels[p.branch], p.branchChannel);
	checkChannelGuard({ branch: p.branch, branchChannel: targetChannel, artifactChannel: p.artifact.channel, dirty: p.artifact.dirty, force: p.force });
	if (head && head.assetId === p.artifact.assetId) throw new Error(`${p.artifact.artifactId} is already live on ${p.branch}; reject the proposal (typetorch reject ${p.id})`);

	if (!(await io.confirm(`Publish this ${p.kind} to ${p.branch}?`))) {
		info(`not published; proposal ${p.id} stays pending (typetorch approve ${p.id} / typetorch reject ${p.id})`);
		return undefined;
	}
	const approver = options.approver ?? gitInfo(proj.root).userName;
	let result: ReleaseResult;
	try {
		result = await release({
			proj,
			oc: deployer,
			api: history.snapshot ? api : undefined,
			history,
			action: p.kind,
			branch: p.branch,
			artifact: p.artifact,
			by: approver,
			force: p.force,
			note: p.message,
			assetName: p.artifact.assetName,
			watch,
			extra: {
				...(p.artifact.sha256 ? { sha256: p.artifact.sha256 } : {}),
				...(p.changes ? { changes: p.changes } : {}),
				proposalId: p.id,
				proposedBy: p.proposedBy,
			},
		});
	} catch (error) {
		appendProposalEvent(dir, { event: "failed", id: p.id, by: approver, error: (error as Error).message.slice(0, 300) });
		throw error;
	}
	appendProposalEvent(dir, { event: "approved", id: p.id, by: approver, seq: result.entry.seq, artifactId: p.artifact.artifactId });
	return result;
}

export interface ReleaseRequest {
	kind: ProposalKind;
	branch: string;
	branchChannel: Channel;
	artifact: ProposalArtifact;
	message?: string;
	changes?: string[];
	force: boolean;
	by: string;
	from?: LiveHead;
}

/** Writes a proposal for a request (nothing is published). */
export function propose(proj: Project, request: ReleaseRequest, proposer: Proposer): Proposal {
	return appendProposal(projectStateDir(proj), {
		kind: request.kind,
		branch: request.branch,
		branchChannel: request.branchChannel,
		artifact: request.artifact,
		...(request.message ? { message: request.message } : {}),
		...(request.changes ? { changes: request.changes } : {}),
		proposedBy: proposer.name,
		by: request.by,
		force: request.force,
		...(request.from ? { from: { artifactId: request.from.artifactId, assetId: request.from.assetId, seq: request.from.seq } } : {}),
		universeId: proj.config.universeId,
		project: proj.config.project,
	});
}

/** The output of a proposal that waits for approval. */
export function reportProposal(proposal: Proposal, extra: Record<string, unknown> = {}) {
	const approve = `typetorch approve ${proposal.id}`;
	if (isJson()) return emitJson({ proposal, approve, ...extra });
	info(bold(`proposed ${proposal.kind} ${proposal.artifact.artifactId} -> ${proposal.branch} (proposal ${proposal.id}, by ${proposal.proposedBy}); nothing published`));
	info(`approve with: ${approve}`);
	info(dim(`  reject with: typetorch reject ${proposal.id}; expires ${proposal.expiresAt.replace("T", " ").slice(0, 16)} UTC`));
}

export type ReleaseOutcome =
	| { kind: "published"; result: ReleaseResult }
	| { kind: "proposed"; proposal: Proposal }
	| { kind: "declined"; proposal: Proposal };

/** Ends a deploy, rollback or promote according to its mode: publish, propose, or propose + approve here. */
export async function finishRelease(input: {
	proj: Project;
	mode: ReleaseMode;
	proposer: Proposer;
	request: ReleaseRequest;
	/** A client with the deploy key (not needed to propose). */
	oc?: OpenCloud;
	api?: RegistryApi;
	history: History;
	watch: Stopwatch;
	noRegistry?: boolean;
	assetName?: string;
	extra?: Record<string, unknown>;
	io?: Interaction;
}): Promise<ReleaseOutcome> {
	const { proj, mode, request } = input;
	const io = input.io ?? interaction();
	if (mode.kind === "propose" || mode.kind === "approve-now") {
		const proposal = propose(proj, request, input.proposer);
		if (mode.kind === "propose") return { kind: "proposed", proposal };
		info(`proposal ${proposal.id} written; approve it now (or later: typetorch approve ${proposal.id})`);
		const result = await approveProposal(proj, { proposal, status: "pending" }, { io, noRegistry: input.noRegistry, oc: input.oc });
		return result ? { kind: "published", result } : { kind: "declined", proposal };
	}
	if (!input.oc) settings().requireApiKey("deploy"); // throws the "no key" message
	const result = await release({
		proj,
		oc: input.oc!,
		api: input.api,
		history: input.history,
		action: request.kind,
		branch: request.branch,
		artifact: request.artifact,
		by: request.by,
		force: request.force,
		note: request.message,
		assetName: input.assetName,
		watch: input.watch,
		extra: { ...(request.changes ? { changes: request.changes } : {}), proposedBy: input.proposer.name, ...input.extra },
	});
	return { kind: "published", result };
}

/**
 * Rollback and promote: re-publish an already uploaded artifact. Dry run, the approval decision, and the output; the
 * caller finds the target.
 */
export async function releaseExisting(input: {
	proj: Project;
	args: ParsedArgs;
	kind: "rollback" | "promote";
	branch: string;
	branchChannel: Channel;
	artifact: ProposalArtifact;
	changes?: string[];
	history: History;
	oc: OpenCloud | undefined;
	api?: RegistryApi;
	watch: Stopwatch;
	force: boolean;
	by: string;
	summary: string;
	dryRun: boolean;
}) {
	const { proj, args, kind, branch, history } = input;
	const note = flagString(args, "message");
	const head = history.heads.get(branch);
	if (input.dryRun) {
		const ending = modeFor(proj, args, input.branchChannel).mode.kind;
		const entry = makeEntry({ action: kind, branch, artifact: input.artifact, by: input.by }, history.snapshot?.value, history.local);
		const data = messageFor(entry);
		const plan = {
			dryRun: true,
			branch,
			from: head ?? null,
			to: input.artifact,
			seq: entry.seq,
			approval: { policy: proj.config.approval, ending },
			registry: history.snapshot
				? { readable: true, message: registryMessage(kind, branch, input.artifact.artifactId, note) }
				: { readable: false, reason: history.unavailable },
			message: { topic: DEPLOY_TOPIC, data },
		};
		if (isJson()) return emitJson(plan);
		info(bold(`dry run: would ${kind === "rollback" ? "roll back" : "promote"} ${input.summary} as #${entry.seq}`));
		info(`  approval  policy "${proj.config.approval}": ${ending}`);
		info(`  registry  ${history.snapshot ? `would publish "${plan.registry.message}"` : `not used (${history.unavailable})`}`);
		info(`  message   ${DEPLOY_TOPIC} ${JSON.stringify(data)}`);
		return;
	}
	const { mode, proposer } = modeFor(proj, args, input.branchChannel);
	if (mode.kind !== "propose") info(`${kind === "rollback" ? "rolling back" : "promoting"} ${input.summary}`);
	const outcome = await finishRelease({
		proj,
		mode,
		proposer,
		request: { kind, branch, branchChannel: input.branchChannel, artifact: input.artifact, message: note, changes: input.changes, force: input.force, by: input.by, from: head },
		oc: input.oc,
		api: input.api,
		history,
		watch: input.watch,
		noRegistry: flagBool(args, "no-registry"),
		assetName: input.artifact.assetName,
		extra: input.artifact.sha256 ? { sha256: input.artifact.sha256 } : undefined,
	});
	if (outcome.kind === "proposed") return reportProposal(outcome.proposal);
	if (outcome.kind === "declined") {
		if (isJson()) emitJson({ proposal: outcome.proposal, approve: `typetorch approve ${outcome.proposal.id}`, declined: true });
		return;
	}
	const { result } = outcome;
	const timings = input.watch.total();
	if (isJson()) return emitJson({ deployment: result.entry, message: result.message, registry: result.registry, timings });
	info(bold(`${kind === "rollback" ? "rolled back" : "promoted"} #${result.entry.seq} ${input.summary} in ${timings.total.toFixed(2)} s`));
	info(dim(`  ${formatTimings(timings)}`));
}

// Commands ---------------------------------------------------------------------------------------------------------

export const approveFlags = { "no-registry": "boolean" } as const;

export async function approveCommand(args: ParsedArgs) {
	const io = interaction();
	if (!io.interactive) {
		throw new NotInteractiveError(
			"typetorch approve needs a person at an interactive terminal (stdin is not a TTY); run it yourself in PowerShell or a terminal",
		);
	}
	const proj = project(args);
	const dir = projectStateDir(proj);
	const all = readProposals(dir, { universeId: proj.config.universeId });
	let state: ProposalState | undefined;
	const wanted = args.positionals[0];
	if (wanted) {
		state = findProposal(all, wanted);
		if (!state) throw new Error(`no proposal "${wanted}" in ${dir} (typetorch proposals lists them)`);
		if (state.status !== "pending") throw new Error(`proposal ${state.proposal.id} is ${state.status}`);
	} else {
		const pending = pendingProposals(dir, { universeId: proj.config.universeId });
		if (pending.length === 0) {
			info("no pending proposals");
			return;
		}
		info(proposalTable(pending));
		if (pending.length === 1) state = pending[0];
		else {
			const answer = await io.ask(`which one? (1-${pending.length} or an id) `);
			state = /^\d+$/.test(answer) ? pending[Number(answer) - 1] : findProposal(pending, answer);
			if (!state) throw new UsageError(`no pending proposal "${answer}"`);
		}
	}
	const result = await approveProposal(proj, state, { io, noRegistry: flagBool(args, "no-registry") });
	if (!result) return;
	if (isJson()) return emitJson({ proposal: state.proposal.id, deployment: result.entry, message: result.message, registry: result.registry });
	info(bold(`approved ${state.proposal.id}: #${result.entry.seq} ${state.proposal.branch} -> ${result.entry.artifactId} (asset ${result.entry.assetId})`));
	if (result.entry.timings) info(dim(`  ${formatTimings(result.entry.timings)}`));
}

export const rejectFlags = { reason: "string" } as const;

export async function rejectCommand(args: ParsedArgs) {
	const wanted = args.positionals[0];
	if (!wanted) throw new UsageError("usage: typetorch reject <proposal id> [--reason <text>]");
	const proj = project(args);
	const dir = projectStateDir(proj);
	const state = findProposal(readProposals(dir, { universeId: proj.config.universeId }), wanted);
	if (!state) throw new Error(`no proposal "${wanted}" in ${dir}`);
	if (state.status !== "pending") throw new Error(`proposal ${state.proposal.id} is already ${state.status}`);
	const by = `${gitInfo(proj.root).userName}${interaction().interactive ? "" : " (non-interactive)"}`;
	const reason = flagString(args, "reason");
	appendProposalEvent(dir, { event: "rejected", id: state.proposal.id, by, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
	if (isJson()) return emitJson({ rejected: state.proposal.id });
	info(`rejected ${state.proposal.id} (${state.proposal.kind} ${state.proposal.artifact.artifactId} -> ${state.proposal.branch})`);
}

export const proposalsFlags = { all: "boolean" } as const;

function proposalTable(states: ProposalState[], now = Date.now()): string {
	return table(
		["#", "id", "status", "kind", "branch", "artifact", "by", "age"],
		states.map((s, i) => [
			String(i + 1),
			s.proposal.id,
			s.status,
			s.proposal.kind,
			s.proposal.branch,
			s.proposal.artifact.artifactId,
			s.proposal.proposedBy,
			age(s.proposal.at, now),
		]),
	);
}

export async function proposalsCommand(args: ParsedArgs) {
	const proj = project(args);
	const dir = projectStateDir(proj);
	const states = flagBool(args, "all")
		? readProposals(dir, { universeId: proj.config.universeId }).reverse().sort((a, b) => b.proposal.at.localeCompare(a.proposal.at))
		: pendingProposals(dir, { universeId: proj.config.universeId });
	if (isJson()) return emitJson({ stateDir: dir, proposals: states });
	if (states.length === 0) {
		info(flagBool(args, "all") ? "no proposals" : "no pending proposals");
		return;
	}
	info(proposalTable(states));
	if (states.some((s) => s.status === "pending")) info(dim("approve with: typetorch approve <id>   reject with: typetorch reject <id>"));
}
