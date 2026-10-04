import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveProposal, finishRelease, propose, releaseMode, resolveProposer, type ReleaseRequest } from "../src/commands/approve";
import { withLocal } from "../src/commands/common";
import { approvalRequired, validateConfig, type Project } from "../src/config";
import { readLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { NotInteractiveError, scriptedInteraction } from "../src/interact";
import { setOutputMode, Stopwatch } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import { appendProposalEvent, findProposal, pendingProposals, PROPOSAL_TTL_MS, readProposals } from "../src/proposals";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-approval-"));
	const raw = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t") + "\n");
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings };
}

function fakeOc() {
	const published: string[] = [];
	return { published, oc: { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud };
}

const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777, channel: "dev" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false, bytes: 2048, builtAt: "2026-10-04T12:00:00.000Z" };
const request = (patch: Partial<ReleaseRequest> = {}): ReleaseRequest => ({ kind: "deploy", branch: "dev", branchChannel: "dev", artifact, changes: ["template: spin coins"], message: "make coins spin", force: false, by: "me", ...patch });
const dir = (proj: Project) => join(proj.root, ".typetorch");

describe("approval policy", () => {
	test("typetorch.json approval: all (default), prod, none; an old signingPublicKey is ignored without a warning", () => {
		expect(validateConfig({ project: "p", universeId: 1, placeId: 2, creator: { userId: 3 } }).config?.approval).toBe("all");
		expect(validateConfig({ project: "p", universeId: 1, placeId: 2, creator: { userId: 3 }, approval: "maybe" }).errors).toContain('"approval" must be one of all, prod, none');
		const old = validateConfig({ project: "p", universeId: 1, placeId: 2, creator: { userId: 3 }, signingPublicKey: "anything" });
		expect(old.errors).toEqual([]);
		expect(old.warnings).toEqual([]);
		expect(approvalRequired("all", "dev")).toBe(true);
		expect(approvalRequired("prod", "dev")).toBe(false);
		expect(approvalRequired("prod", "prod")).toBe(true);
		expect(approvalRequired("none", "prod")).toBe(false);
	});
	test("who can do what", () => {
		const cli = { name: "cli", explicit: false };
		const agent = { name: "agent", explicit: false };
		const devServer = { name: "dev-server/claude", explicit: true };
		const base = { policy: "all" as const, branchChannel: "dev" as const, propose: false };
		expect(releaseMode({ ...base, proposer: cli, interactive: true }).kind).toBe("approve-now");
		expect(releaseMode({ ...base, proposer: cli, interactive: true, propose: true }).kind).toBe("propose");
		expect(releaseMode({ ...base, proposer: agent, interactive: false }).kind).toBe("propose");
		// a pseudo-terminal doesn't make the dev-server a person
		expect(releaseMode({ ...base, proposer: devServer, interactive: true }).kind).toBe("propose");
		expect(releaseMode({ ...base, policy: "none", proposer: agent, interactive: false }).kind).toBe("publish");
		expect(releaseMode({ ...base, policy: "prod", proposer: agent, interactive: false }).kind).toBe("publish");
		expect(releaseMode({ ...base, policy: "prod", branchChannel: "prod", proposer: agent, interactive: false }).kind).toBe("propose");
		expect(releaseMode({ ...base, policy: "none", proposer: cli, interactive: true, propose: true }).kind).toBe("propose");
	});
	test("the proposer: flag, env, else cli at a terminal and agent otherwise", () => {
		project();
		expect(resolveProposer(undefined, true)).toEqual({ name: "cli", explicit: false });
		expect(resolveProposer(undefined, false)).toEqual({ name: "agent", explicit: false });
		expect(resolveProposer("dev-server/claude", false)).toEqual({ name: "dev-server/claude", explicit: true });
		expect(() => resolveProposer("Bad Name!", false)).toThrow();
		useSettings(new Settings({ startDir: tmpdir(), env: { TYPETORCH_PROPOSED_BY: "agent" } }));
		expect(resolveProposer(undefined, true)).toEqual({ name: "agent", explicit: true });
	});
});

describe("proposals", () => {
	test("lifecycle: proposed -> pending (newest first) -> approved / rejected; the first decision wins", () => {
		const proj = project();
		const a = propose(proj, request(), { name: "agent", explicit: false });
		const b = propose(proj, request({ branch: "feature-x" }), { name: "dev-server/claude", explicit: true });
		expect(pendingProposals(dir(proj)).map((s) => s.proposal.id)).toEqual([b.id, a.id]);
		expect(findProposal(readProposals(dir(proj)), a.id.slice(0, 5))?.proposal.id).toBe(a.id);
		appendProposalEvent(dir(proj), { event: "rejected", id: a.id, by: "me" });
		appendProposalEvent(dir(proj), { event: "approved", id: a.id, by: "me", seq: 9 });
		const states = readProposals(dir(proj));
		expect(states.find((s) => s.proposal.id === a.id)?.status).toBe("rejected");
		expect(states.find((s) => s.proposal.id === b.id)).toMatchObject({ status: "pending", proposal: { proposedBy: "dev-server/claude", changes: ["template: spin coins"], message: "make coins spin" } });
	});
	test("expire after 24 h", () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		expect(Date.parse(p.expiresAt) - Date.parse(p.at)).toBe(PROPOSAL_TTL_MS);
		expect(readProposals(dir(proj), { now: Date.parse(p.at) + PROPOSAL_TTL_MS - 1 })[0].status).toBe("pending");
		expect(readProposals(dir(proj), { now: Date.parse(p.at) + PROPOSAL_TTL_MS })[0].status).toBe("expired");
		expect(pendingProposals(dir(proj), { now: Date.parse(p.at) + PROPOSAL_TTL_MS + 1 })).toEqual([]);
	});
	test("a failed approval keeps the proposal pending and shows the error", () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		appendProposalEvent(dir(proj), { event: "failed", id: p.id, error: "registry down" });
		expect(readProposals(dir(proj))[0]).toMatchObject({ status: "pending", lastError: "registry down" });
	});
});

describe("approve", () => {
	test("refuses without an interactive terminal", async () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		await expect(approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ interactive: false }) })).rejects.toThrow(NotInteractiveError);
	});
	test("y: publishes the unsigned message, logs it with the proposal id, marks it approved; no key or passphrase", async () => {
		const proj = project();
		const p = propose(proj, request(), { name: "dev-server/claude", explicit: true });
		const { oc, published } = fakeOc();
		const io = scriptedInteraction({ answers: ["y"] });
		const result = await approveProposal(proj, { proposal: p, status: "pending" }, { io, oc, noRegistry: true });
		expect(result?.entry.seq).toBe(1);
		const message = JSON.parse(published[0]);
		expect(Object.keys(message)).toEqual(["b", "a", "i", "s", "c", "ch", "t"]);
		expect(message).toMatchObject({ b: "dev", a: 777, i: "12b63b9-3fa91c", s: 1 });
		expect(readLocalLog(dir(proj))[0]).toMatchObject({ proposalId: p.id, proposedBy: "dev-server/claude", changes: ["template: spin coins"] });
		expect(readProposals(dir(proj))[0]).toMatchObject({ status: "approved", decision: { seq: 1 } });
		expect(io.asked).toHaveLength(1); // just the y/N
	});
	test("n (or anything but y) leaves it pending and publishes nothing", async () => {
		const proj = project();
		const p = propose(proj, request(), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		for (const answer of ["n", "", "maybe"]) {
			expect(await approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: [answer] }), oc, noRegistry: true })).toBeUndefined();
		}
		expect(published).toEqual([]);
		expect(readProposals(dir(proj))[0].status).toBe("pending");
	});
	test("a rollback proposal publishes r=1", async () => {
		const proj = project();
		const p = propose(proj, request({ kind: "rollback" }), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		await approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["yes"] }), oc, noRegistry: true });
		expect(JSON.parse(published[0]).r).toBe(1);
	});
});

describe("finishRelease", () => {
	test("propose writes a proposal and publishes nothing; approve-now asks at once", async () => {
		const proj = project();
		const { oc, published } = fakeOc();
		const proposed = await finishRelease({ proj, mode: { kind: "propose" }, proposer: { name: "agent", explicit: false }, request: request(), history: withLocal(proj, undefined), watch: new Stopwatch(), io: scriptedInteraction({ interactive: false }) });
		expect(proposed.kind).toBe("proposed");
		expect(published).toEqual([]);
		const now = await finishRelease({ proj, mode: { kind: "approve-now" }, proposer: { name: "cli", explicit: false }, request: request({ branch: "feature-y" }), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), noRegistry: true, io: scriptedInteraction({ answers: ["y"] }) });
		expect(now.kind).toBe("published");
		expect(published).toHaveLength(1);
		expect(readProposals(dir(proj)).map((s) => s.status).sort()).toEqual(["approved", "pending"]);
	});
	test("publish (approval none) goes out at once", async () => {
		const proj = project({ approval: "none" });
		const { oc, published } = fakeOc();
		const out = await finishRelease({ proj, mode: { kind: "publish" }, proposer: { name: "agent", explicit: false }, request: request(), oc, history: withLocal(proj, undefined), watch: new Stopwatch(), io: scriptedInteraction({ interactive: false }) });
		expect(out.kind).toBe("published");
		expect(JSON.parse(published[0]).sig).toBeUndefined();
		expect(readLocalLog(dir(proj))[0]).toMatchObject({ proposedBy: "agent" });
	});
});
