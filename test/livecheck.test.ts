/**
 * Live servers with nothing to run (cecot, 2026-10): doctor's "live servers" and "old game build" checks, the default
 * branch's head, `kernel deploy`'s guard, `deploy`'s warning and doctor's --show-ok. Place reads and head lookups are
 * faked; nothing talks to Roblox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleChecks } from "../src/commands/doctor";
import { guardDefaultBranch, KernelCheckError } from "../src/commands/kernel";
import { defaultBranchNotice } from "../src/commands/deploy";
import type { LiveHead } from "../src/deployments";
import { scriptedInteraction } from "../src/interact";
import { gatherKeyFacts, type Check, type KeyFacts } from "../src/keycheck";
import { newKeyFile, writeKeyFile } from "../src/keyfiles";
import {
	defaultBranchHead,
	defaultBranchWarning,
	deployDefaultHint,
	liveServerChecks,
	PLACE_GAME_LUAU,
	placeGameFrom,
	versionBeforeKernel,
	type HeadState,
	type PlaceGame,
} from "../src/livecheck";
import { OpenCloud } from "../src/opencloud";
import { readSharedSeq, type SharedSeq } from "../src/seqstore";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** cecot's typetorch.json: only master maps to prod. */
const config = { defaultBranch: "prod", branches: { master: "prod" }, channels: {} };
const SLOTS = ["ServerScriptService.TypeTorchKernel", "ReplicatedStorage.TypeTorchKernelShared", "ReplicatedFirst.TypeTorchKernelClient"];
const place = (patch: Partial<PlaceGame> = {}): PlaceGame & { source: string } => ({
	slots: SLOTS,
	oldBuild: [],
	rbxtsScripts: [],
	rbxtsCount: 0,
	kernelVersion: "0.3.8",
	source: "the place (Luau Execution)",
	...patch,
});
const shared = (branches: Record<string, unknown>): SharedSeq => ({ readable: true, branches });
const none: HeadState = { state: "none", detail: "no prod head in the DataStore heads" };
const byName = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.name, c]));

describe("the default branch's head", () => {
	const head = (seq: number, extra: Record<string, unknown> = {}) => ({ assetId: 1, artifactId: "a", seq, commit: "c", channel: "prod", deployedAt: "", t: 0, ...extra });
	test("a signed stored prod head is verified; an unsigned one isn't, unless it is the bootstrap head", () => {
		expect(defaultBranchHead({ config, shared: shared({ prod: head(7, { sig: "x" }) }) })).toMatchObject({ state: "verified" });
		expect(defaultBranchHead({ config, shared: shared({ prod: head(7, { sigF: "x" }) }) })).toMatchObject({ state: "verified" });
		expect(defaultBranchHead({ config, shared: shared({ prod: head(7) }) })).toMatchObject({ state: "unsigned" });
		expect(defaultBranchHead({ config, shared: shared({ prod: head(7) }), bootstrap: { prod: { a: 1, s: 7, i: "a" } } })).toMatchObject({ state: "verified", detail: expect.stringContaining("bootstrap") });
	});
	test("only another branch stored (cecot: typetorch-migration): none; the bootstrap head alone counts", () => {
		const heads = shared({ "typetorch-migration": head(3) });
		expect(defaultBranchHead({ config, shared: heads })).toEqual({ state: "none", detail: "no prod head in the DataStore heads" });
		expect(defaultBranchHead({ config, shared: heads, bootstrap: { prod: { a: 1, s: 2, i: "a" } } })).toMatchObject({ state: "verified" });
	});
	test("a dev-channel default branch needs no signature", () => {
		expect(defaultBranchHead({ config: { defaultBranch: "main", channels: { main: "dev" } }, shared: shared({ main: head(1) }) })).toMatchObject({ state: "verified" });
	});
	test("heads not readable: unknown, with this machine's log", () => {
		const local = new Map([["prod", { seq: 9 } as LiveHead]]);
		expect(defaultBranchHead({ config, shared: { readable: false, error: "the deploy key needs universe-datastores.objects:read" }, local })).toEqual({
			state: "unknown",
			detail: "the DataStore heads weren't read (the deploy key needs universe-datastores.objects:read); this machine's log has prod #9",
		});
		expect(defaultBranchHead({ config })).toMatchObject({ state: "unknown", detail: expect.stringContaining("no deploy key") });
	});
	test("readSharedSeq keeps the heads by branch ({} when the entry is missing, undefined when unreadable)", async () => {
		const store = (heads?: unknown, status = 200) => ({
			async request(_method: string, path: string) {
				if (status !== 200) return { status, ok: false, body: undefined, text: "forbidden", headers: new Headers() };
				if (path.endsWith("/heads") && heads !== undefined) return { status: 200, ok: true, body: { value: heads }, text: "", headers: new Headers() };
				return { status: 404, ok: false, body: undefined, text: "", headers: new Headers() };
			},
		});
		expect((await readSharedSeq(store({ prod: { seq: 4, sig: "s" } }) as any, 1)).branches).toEqual({ prod: { seq: 4, sig: "s" } });
		expect((await readSharedSeq(store() as any, 1)).branches).toEqual({});
		expect((await readSharedSeq(store(undefined, 403) as any, 1)).branches).toBeUndefined();
	});
});

describe("doctor: live servers", () => {
	test("cecot: the kernel, no prod head, no backup = FAIL with the fix", () => {
		const [check] = liveServerChecks({ config, game: place(), backup: { present: false }, head: none, restoreVersion: 173 });
		expect(check.name).toBe("live servers");
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("live servers have nothing to run");
		expect(check.detail).toContain("kernel 0.3.8 moves every player out after 15 s and kicks after 3 bounces");
		expect(check.detail).toContain("Deploy prod first (`typetorch deploy` from git branch master (or `typetorch deploy --branch prod`))");
		expect(check.detail).toContain("`typetorch kernel restore --version 173`");
	});
	test("an unsigned prod head or a dev-channel backup still fails; the restore version may be unknown", () => {
		const unsigned: HeadState = { state: "unsigned", detail: "prod #4 in the DataStore heads is unsigned" };
		expect(liveServerChecks({ config, game: place(), head: unsigned })[0].status).toBe("fail");
		const [check] = liveServerChecks({ config, game: place(), backup: { present: true, channel: "dev" }, head: none });
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("the backup build is dev-channel");
		expect(check.detail).toContain("--version <n>` (n: a place version from before the kernel install)");
	});
	test("a verified head, or a prod backup: ok", () => {
		expect(liveServerChecks({ config, game: place(), backup: { present: false }, head: { state: "verified", detail: "prod #7 (signed) in the DataStore heads" } })[0].status).toBe("ok");
		expect(liveServerChecks({ config, game: place(), backup: { present: true, channel: "prod" }, head: none })[0].status).toBe("ok");
	});
	test("heads unreadable: warn; no kernel in the place: ok; the place not read: info", () => {
		expect(liveServerChecks({ config, game: place(), head: { state: "unknown", detail: "the DataStore heads weren't read (x)" } })[0].status).toBe("warn");
		expect(liveServerChecks({ config, game: place({ slots: [] }), head: none })).toEqual([{ name: "live servers", status: "ok", detail: expect.stringContaining("no ServerScriptService.TypeTorchKernel") }]);
		expect(liveServerChecks({ config, head: none })[0].status).toBe("info");
	});
	test("an old roblox-ts build next to the kernel: warn", () => {
		const checks = byName(
			liveServerChecks({
				config,
				game: place({ oldBuild: ["ServerScriptService.TS", "ReplicatedStorage.rbxts_include"], rbxtsScripts: ["ServerScriptService.TS.main", "StarterPlayer.StarterPlayerScripts.Client"], rbxtsCount: 12 }),
				head: { state: "verified", detail: "prod #7" },
			}),
		);
		expect(checks["old game build"].status).toBe("warn");
		// Scripts inside a marker folder aren't listed twice.
		expect(checks["old game build"].detail).toContain("(ServerScriptService.TS, ReplicatedStorage.rbxts_include, StarterPlayer.StarterPlayerScripts.Client (+10 more))");
		expect(checks["old game build"].detail).toContain("session locks");
		expect(byName(liveServerChecks({ config, game: place(), head: { state: "verified", detail: "prod #7" } }))["old game build"].status).toBe("ok");
	});
	test("the place read: PLACE_GAME_LUAU in the doctor task, its result parsed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-live-"));
		const main = newKeyFile("main", 42);
		const fallback = newKeyFile("fallback", 42);
		const paths = { main: join(dir, "42.key"), fallback: join(dir, "42.fallback.key") };
		writeKeyFile(paths.main, main);
		writeKeyFile(paths.fallback, fallback);
		let script = "";
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (url.pathname.endsWith("/luau-execution-session-tasks")) {
				script = JSON.parse(String(init?.body)).script;
				return json({ path: "universes/42/places/2/versions/7/luau-execution-session-tasks/t1", state: "QUEUED" });
			}
			if (url.pathname.endsWith("/luau-execution-session-tasks/t1")) {
				return json({
					state: "COMPLETE",
					output: {
						results: [
							{
								kernel: { keyAssetId: "555", fallbackPublicKey: fallback.publicKey, version: "0.3.8", bootstrapHeads: "{}" },
								slots: SLOTS,
								oldBuild: ["ServerScriptService.TS"],
								rbxtsScripts: {},
								rbxtsCount: 0,
							},
						],
					},
				});
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const facts = await gatherKeyFacts({
			config: { universeId: 42, placeId: 2, creator: { groupId: 3 }, signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555 } as KeyFacts["config"] & { placeId: number },
			paths,
			stateDir: dir,
			assets: new OpenCloud("test-api-key-not-real-0000"),
		});
		expect(script).toContain(PLACE_GAME_LUAU);
		expect(script).toContain('GetAttribute("BootstrapHeads")');
		expect(facts.game).toEqual({ slots: SLOTS, oldBuild: ["ServerScriptService.TS"], rbxtsScripts: [], rbxtsCount: 0, kernelVersion: "0.3.8", bootstrapHeads: {}, source: "the place (Luau Execution)" });
		expect(facts.backup).toMatchObject({ present: false });
		const checks = byName(liveServerChecks({ config, game: facts.game, backup: facts.backup, head: none }));
		expect(checks["live servers"].status).toBe("fail");
		expect(checks["old game build"].status).toBe("warn");
	});
	test("placeGameFrom: an older result without a slots list still knows the server slot", () => {
		expect(placeGameFrom({ kernel: { version: "0.3.5" } }).slots).toEqual(["ServerScriptService.TypeTorchKernel"]);
		expect(placeGameFrom({ slots: {}, oldBuild: {} })).toEqual({ slots: [], oldBuild: [], rbxtsScripts: [], rbxtsCount: 0 });
	});
	test("the version before the kernel's first install, from the kernel log", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-live-"));
		expect(versionBeforeKernel(dir)).toBeUndefined();
		writeFileSync(
			join(dir, "kernel-deploys.jsonl"),
			[
				JSON.stringify({ event: "kernel-published", firstInstall: true, placeVersionBefore: 173, placeVersionAfter: 174 }),
				JSON.stringify({ event: "kernel-published", firstInstall: false, placeVersionBefore: 180 }),
			].join("\n"),
		);
		expect(versionBeforeKernel(dir)).toBe(173);
	});
	test("the deploy hint names every git branch mapped to the default branch", () => {
		expect(deployDefaultHint({ defaultBranch: "prod", branches: {} })).toBe("`typetorch deploy --branch prod`");
		expect(deployDefaultHint({ defaultBranch: "prod", branches: { master: "prod", main: "prod", dev: "dev" } })).toBe("`typetorch deploy` from git branch master or main (or `typetorch deploy --branch prod`)");
	});
});

describe("doctor --show-ok", () => {
	test("OK lines are hidden unless --show-ok; problems and info always show", () => {
		const checks: Check[] = [
			{ name: "a", status: "ok", detail: "" },
			{ name: "b", status: "warn", detail: "" },
			{ name: "c", status: "info", detail: "" },
			{ name: "d", status: "fail", detail: "" },
			{ name: "e", status: "ok", detail: "" },
		];
		expect(visibleChecks(checks, false)).toEqual({ shown: [checks[1], checks[2], checks[3]], hidden: 2 });
		expect(visibleChecks(checks, true)).toEqual({ shown: checks, hidden: 0 });
	});
});

describe("kernel deploy: the default branch guard", () => {
	const base = { config, head: none, backupBaked: false, force: false, dryRun: false };
	test("no verified head and no backup: refuses without a terminal, asks y/N with one", async () => {
		await expect(guardDefaultBranch({ ...base, io: scriptedInteraction({ interactive: false }) })).rejects.toThrow(KernelCheckError);
		await expect(guardDefaultBranch({ ...base, io: scriptedInteraction({ interactive: false }) })).rejects.toThrow(/moves every player out after 15 s.*--force/s);
		const no = scriptedInteraction({ answers: ["n"] });
		await expect(guardDefaultBranch({ ...base, io: no })).rejects.toThrow("not published. Deploy prod first (`typetorch deploy` from git branch master");
		expect(no.asked).toHaveLength(1);
		const yes = scriptedInteraction({ answers: ["y"] });
		await guardDefaultBranch({ ...base, io: yes });
		expect(yes.asked[0]).toContain("Publish the kernel anyway?");
	});
	test("--force, a dry run, a baked backup, a verified head or an unknown head: no question", async () => {
		const io = scriptedInteraction({ interactive: false });
		await guardDefaultBranch({ ...base, force: true, io });
		await guardDefaultBranch({ ...base, dryRun: true, io });
		await guardDefaultBranch({ ...base, backupBaked: true, io });
		await guardDefaultBranch({ ...base, head: { state: "verified", detail: "prod #7" }, io });
		await guardDefaultBranch({ ...base, head: { state: "unknown", detail: "x" }, io });
		expect(io.asked).toEqual([]);
	});
});

describe("deploy: the default branch has nothing", () => {
	const proj = (root: string) => ({ root, config: { ...config, universeId: 42, placeId: 2 } }) as any;
	const luau = (result: Record<string, unknown> | Error) => ({
		calls: 0,
		async runLuau() {
			this.calls++;
			if (result instanceof Error) throw result;
			return { state: "COMPLETE", results: [result] } as any;
		},
	});
	const migration = shared({ "typetorch-migration": { seq: 3 } });
	test("cecot: a deploy to typetorch-migration names the branch, says public servers run prod, and how to deploy it", async () => {
		const message = await defaultBranchNotice({ proj: proj(mkdtempSync(join(tmpdir(), "tt-live-"))), branch: "typetorch-migration", shared: migration, local: new Map(), assets: luau({ kernel: { version: "0.3.8" }, slots: SLOTS }) });
		expect(message).toContain('deployed to branch "typetorch-migration", but public servers run prod, which has no verified head');
		expect(message).toContain("moves every player out after 15 s");
		expect(message).toContain("Deploy it: `typetorch deploy` from git branch master (or `typetorch deploy --branch prod`)");
	});
	test("with a prod backup in the place: it says servers run the backup", async () => {
		const message = await defaultBranchNotice({ proj: proj(mkdtempSync(join(tmpdir(), "tt-live-"))), branch: "dev", shared: migration, local: new Map(), assets: luau({ kernel: {}, slots: SLOTS, backup: { channel: "prod" } }) });
		expect(message).toContain("runs its backup build there, not this deploy");
	});
	test("the place unreadable: the kernel log decides; without one, a conditional warning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-live-"));
		const conditional = await defaultBranchNotice({ proj: proj(dir), branch: "dev", shared: migration, local: new Map(), assets: luau(new Error("403")), stateDir: dir });
		expect(conditional).toContain("If the published place has the kernel");
		writeFileSync(join(dir, "kernel-deploys.jsonl"), JSON.stringify({ event: "kernel-published", at: "2026-10-08T10:00:00Z" }) + "\n");
		const recorded = await defaultBranchNotice({ proj: proj(dir), branch: "dev", shared: migration, local: new Map(), assets: undefined, stateDir: dir });
		expect(recorded).toContain("installed by `kernel deploy` from this machine at 2026-10-08T10:00:00Z");
	});
	test("nothing to say: the default branch itself, a verified prod head, no kernel, a bootstrap head, heads unreadable", async () => {
		const root = mkdtempSync(join(tmpdir(), "tt-live-"));
		const kernel = luau({ kernel: {}, slots: SLOTS });
		expect(await defaultBranchNotice({ proj: proj(root), branch: "prod", shared: migration, local: new Map(), assets: kernel })).toBeUndefined();
		expect(await defaultBranchNotice({ proj: proj(root), branch: "dev", shared: shared({ prod: { seq: 5, sig: "s" } }), local: new Map(), assets: kernel })).toBeUndefined();
		expect(kernel.calls).toBe(0);
		expect(await defaultBranchNotice({ proj: proj(root), branch: "dev", shared: migration, local: new Map(), assets: luau({ slots: [] }) })).toBeUndefined();
		expect(await defaultBranchNotice({ proj: proj(root), branch: "dev", shared: migration, local: new Map(), assets: luau({ kernel: { bootstrapHeads: '{"prod":{"a":1,"s":2,"i":"x"}}' }, slots: SLOTS }) })).toBeUndefined();
		expect(await defaultBranchNotice({ proj: proj(root), branch: "dev", shared: { readable: false }, local: new Map(), assets: kernel })).toBeUndefined();
	});
	test("defaultBranchWarning is silent without a kernel", () => {
		expect(defaultBranchWarning({ config, branch: "dev", head: none, kernel: false })).toBeUndefined();
	});
});
