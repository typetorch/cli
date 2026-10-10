/** `typetorch branch ls / rm`, the 32-branch cap, deploy's new-branch notes and kernel restore's guard (all faked). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { branchCapWarning, HEADS_MAX_BRANCHES, readRemovals, withoutRemoved } from "../src/branches";
import { branchCommand, BranchError, branchFlags, branchRows, protectedBranch } from "../src/commands/branch";
import { withLocal } from "../src/commands/common";
import { newBranchNotes } from "../src/commands/deploy";
import { restoredKernel } from "../src/commands/kernel";
import { loadProject, type Project } from "../src/config";
import { appendLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import type { FleetClient, ServerRow } from "../src/fleet";
import { scriptedInteraction } from "../src/interact";
import { captureJson, setOutputMode } from "../src/log";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

/** The kernel's `heads` entry, read through v2 (readSharedSeq) and written through v1 with a version guard (updateEntry). */
function fakeHeads(initial: Record<string, unknown> | undefined, options: { beforeWrite?: (heads: Record<string, unknown>) => void } = {}) {
	let heads = initial ? structuredClone(initial) : undefined;
	let version = 1;
	const writes: Record<string, unknown>[] = [];
	const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, ok: status >= 200 && status < 300, body, text: JSON.stringify(body ?? null), headers: new Headers(headers) });
	const oc = {
		async request(method: string, path: string, opts: { body?: string } = {}) {
			const url = new URL(`https://apis.roblox.com${path}`);
			const key = url.pathname.startsWith("/cloud/v2/") ? decodeURIComponent(url.pathname.split("/").pop()!) : url.searchParams.get("entryKey");
			if (key !== "heads") return reply(404, { code: "NOT_FOUND" });
			if (method === "GET") {
				if (!heads) return reply(404, { code: "NOT_FOUND" });
				return url.pathname.startsWith("/cloud/v2/") ? reply(200, { value: heads }) : reply(200, heads, { "roblox-entry-version": `v${version}` });
			}
			if (options.beforeWrite && heads) {
				options.beforeWrite(heads);
				options.beforeWrite = undefined;
				version++;
			}
			if (url.searchParams.get("matchVersion") !== `v${version}`) return reply(412, { error: "PRECONDITION_FAILED" });
			heads = JSON.parse(opts.body!);
			version++;
			writes.push(heads!);
			return reply(200, { version: `v${version}` });
		},
	};
	return { oc, writes, heads: () => heads };
}

const fleet = (servers: Partial<ServerRow>[]): FleetClient => ({ servers: async () => servers.map((s) => ({ jobId: "j", accessCode: false, experiment: false, ...s })) }) as unknown as FleetClient;

function setup(patch: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "tt-branch-"));
	const raw = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, branches: { master: "prod" }, channels: { staging: "prod" }, approval: "none", ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw));
	useSettings(new Settings({ startDir: root, env: {} }));
	const proj = loadProject(undefined, root);
	const state = join(root, ".typetorch");
	appendLocalLog(state, { seq: 3, at: "2026-10-08T12:00:00.000Z", action: "deploy", branch: "typetorch-migration", channel: "dev", artifactId: "abc1234-000003", assetId: 900000003, commit: "abc1234", commitHash: "", dirty: false, by: "me", universeId: 42 });
	return { proj, state, root };
}
const run = (proj: Project, argv: string[], deps: Parameters<typeof branchCommand>[1]) => branchCommand(parseArgs([...argv, "--config", proj.configPath], branchFlags), deps);
const HEADS = {
	prod: { seq: 5, artifactId: "p-5", channel: "prod", deployedAt: "2026-10-09T00:00:00Z", sig: "s" },
	"typetorch-migration": { seq: 3, artifactId: "abc1234-000003", channel: "dev", deployedAt: "2026-10-08T12:00:00Z" },
	"old-feature": { seq: 1, artifactId: "f-1", channel: "dev", deployedAt: "2026-09-01T00:00:00Z" },
};

describe("branch rm", () => {
	test("removes a dev branch nothing runs: the DataStore heads lose it and this machine's log hides it", async () => {
		const { proj, state } = setup();
		const store = fakeHeads(HEADS);
		await run(proj, ["rm", "typetorch-migration", "--yes"], { oc: store.oc, fleet: fleet([{ branch: "prod", players: 20 }]) });
		expect(Object.keys(store.heads()!).sort()).toEqual(["old-feature", "prod"]);
		expect(readRemovals(state, 42)).toMatchObject([{ event: "branch-removed", branch: "typetorch-migration", seq: 3, artifactId: "abc1234-000003" }]);
		expect(withLocal(proj).heads.has("typetorch-migration")).toBe(false);
	});
	test("refuses the default branch and prod-channel branches, even with --force", async () => {
		const { proj } = setup();
		const store = fakeHeads({ ...HEADS, staging: { seq: 4, channel: "prod" }, hotfix: { seq: 2, channel: "prod" } });
		for (const branch of ["prod", "staging", "hotfix"]) {
			await expect(run(proj, ["rm", branch, "--yes", "--force"], { oc: store.oc, fleet: fleet([]) })).rejects.toThrow(/refusing to remove .*--force doesn't change that/);
		}
		expect(store.writes).toEqual([]);
		expect(protectedBranch(proj.config, "prod", undefined)).toContain("default branch");
		expect(protectedBranch(proj.config, "staging", undefined)).toContain("prod-channel branch");
		expect(protectedBranch(proj.config, "hotfix", { channel: "prod" })).toContain("prod-channel build");
	});
	test("refuses while live servers run it", async () => {
		const { proj } = setup();
		const store = fakeHeads(HEADS);
		await expect(run(proj, ["rm", "old-feature", "--yes"], { oc: store.oc, fleet: fleet([{ branch: "old-feature", players: 2 }, { branch: "old-feature", players: 1 }]) })).rejects.toThrow("2 live server(s) run it (3 player(s)");
		expect(store.writes).toEqual([]);
	});
	test("without the fleet API: refuses unless --force", async () => {
		const { proj } = setup();
		const store = fakeHeads(HEADS);
		await expect(run(proj, ["rm", "old-feature", "--yes"], { oc: store.oc, fleet: null })).rejects.toThrow(/can't check that no live server runs it.*--force/);
		await run(proj, ["rm", "old-feature", "--yes", "--force"], { oc: store.oc, fleet: null });
		expect(store.heads()).not.toHaveProperty("old-feature");
	});
	test("a deploy landing between the read and the write: nothing removed", async () => {
		const { proj, state } = setup();
		const store = fakeHeads(HEADS, { beforeWrite: (heads) => void (heads["old-feature"] = { seq: 9, channel: "dev" }) });
		await expect(run(proj, ["rm", "old-feature", "--yes"], { oc: store.oc, fleet: fleet([]) })).rejects.toThrow(BranchError);
		expect(store.heads()!["old-feature"]).toEqual({ seq: 9, channel: "dev" });
		expect(readRemovals(state)).toEqual([]);
	});
	test("y/N: no terminal needs --yes; n keeps it; --dry-run writes nothing; an unknown branch is refused", async () => {
		const { proj, state } = setup();
		const store = fakeHeads(HEADS);
		const deps = { oc: store.oc, fleet: fleet([]) };
		await expect(run(proj, ["rm", "old-feature"], { ...deps, io: scriptedInteraction({ interactive: false }) })).rejects.toThrow("--yes");
		const no = scriptedInteraction({ answers: ["n"] });
		await run(proj, ["rm", "old-feature"], { ...deps, io: no });
		expect(no.asked).toEqual(["Remove branch old-feature?"]);
		await run(proj, ["rm", "old-feature", "--dry-run"], deps);
		expect(store.writes).toEqual([]);
		expect(readRemovals(state)).toEqual([]);
		await expect(run(proj, ["rm", "nope", "--yes"], deps)).rejects.toThrow("no branch nope");
	});
	test("a mapped git branch and pending proposals are named (they recreate it)", async () => {
		const { proj, state } = setup({ branches: { master: "prod", develop: "old-feature" } });
		writeFileSync(join(state, "proposals.jsonl"), JSON.stringify({ event: "proposed", id: "ab12cd34", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), kind: "deploy", branch: "old-feature", branchChannel: "dev", universeId: 42 }) + "\n");
		setOutputMode({ json: true, verbose: false });
		const out = (await captureJson(() => run(proj, ["rm", "old-feature", "--dry-run"], { oc: fakeHeads(HEADS).oc, fleet: fleet([]) }))) as { notes: string[] };
		expect(out.notes.join("\n")).toContain("maps git branch develop to it");
		expect(out.notes.join("\n")).toContain("1 pending proposal(s) target it (ab12cd34)");
		expect(out.notes.join("\n")).toContain("MemoryStore");
	});
});

describe("branch ls", () => {
	test("rows: the DataStore heads, this machine's log, mapped git branches and live servers", () => {
		const { proj } = setup();
		const rows = branchRows({
			config: proj.config,
			shared: { readable: true, branches: { ...HEADS, staging: { seq: 4, channel: "prod" } } },
			local: withLocal(proj).heads,
			servers: [{ jobId: "a", branch: "prod", accessCode: false, experiment: false }] as ServerRow[],
		});
		expect(rows[0]).toMatchObject({ branch: "prod", isDefault: true, signed: true, servers: 1, git: ["master"], seq: 5 });
		expect(rows.find((r) => r.branch === "staging")).toMatchObject({ channel: "prod", signed: false, stored: true, servers: 0 });
		expect(rows.find((r) => r.branch === "typetorch-migration")).toMatchObject({ channel: "dev", stored: true, seq: 3 });
	});
	test("removals hide only heads up to the removed seq (a redeploy shows again)", () => {
		const heads = new Map([["a", { seq: 3 }], ["b", { seq: 7 }]]);
		withoutRemoved(heads, [{ event: "branch-removed", at: "", branch: "a", seq: 3, universeId: 1 }, { event: "branch-removed", at: "", branch: "b", seq: 5, universeId: 1 }]);
		expect([...heads.keys()]).toEqual(["b"]);
	});
});

describe("the 32-branch cap", () => {
	test("warns from 28, says what breaks at 32", () => {
		expect(branchCapWarning(27)).toBeUndefined();
		expect(branchCapWarning(28)).toContain("28 branches");
		expect(branchCapWarning(HEADS_MAX_BRANCHES)).toContain("a deploy to a NEW branch isn't recorded by servers");
	});
	test("deploy: a new branch from an unmapped git branch, and a new branch near the cap", () => {
		const config = { defaultBranch: "prod", branches: { master: "prod" } };
		const shared = { readable: true, branches: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`b${i}`, { seq: i }])) };
		const notes = newBranchNotes({ config, branch: "typetorch-migration", gitBranch: "typetorch-migration", shared, local: new Map() });
		expect(notes[0]).toContain('new branch "typetorch-migration": git branch typetorch-migration isn\'t in typetorch.json "branches"');
		expect(notes[0]).toContain("`typetorch deploy` from git branch master");
		expect(notes[1]).toContain("32 branches");
		// An existing branch, --branch, the default branch: nothing.
		expect(newBranchNotes({ config, branch: "b1", gitBranch: "b1", shared, local: new Map() })).toEqual([]);
		expect(newBranchNotes({ config, branch: "x", branchFlag: "x", gitBranch: "y", shared: { readable: true, branches: {} }, local: new Map() })).toEqual([]);
		expect(newBranchNotes({ config, branch: "prod", gitBranch: "main", shared, local: new Map() })).toEqual([]);
	});
});

describe("kernel restore: the default branch guard", () => {
	test("a version has the kernel when the check task reports its identity", () => {
		expect(restoredKernel({ KernelVersion: "0.3.8" })).toBe(true);
		expect(restoredKernel({ constantsVersion: "0.3.8" })).toBe(true);
		expect(restoredKernel({})).toBe(false);
	});
});

// The log file the removal writes is plain JSON lines.
test("branches.jsonl is one JSON object per line", async () => {
	const { proj, state } = setup();
	await run(proj, ["rm", "old-feature", "--yes"], { oc: fakeHeads(HEADS).oc, fleet: fleet([]) });
	const lines = readFileSync(join(state, "branches.jsonl"), "utf8").trim().split("\n");
	expect(lines.map((l) => JSON.parse(l).branch)).toEqual(["old-feature"]);
});
