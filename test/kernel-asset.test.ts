/**
 * The kernel as an asset (commands/kernel-asset.ts; kernel 0.4.1 loader, plans/22):
 *   - the resolve task runs under Lune against fixture packages (an InsertService mock in the harness);
 *   - the drain message signs exactly like the kernel's test vector (scripts/loader-vectors.json in kernel-asset);
 *   - deploy --asset, promote, rollback and drain against fakes: the assets key's calls, a fake DataStore for the signed
 *     settings record (the pointers are checked in the written record), a fake fleet for the promote proof;
 *   - the loader slots project of install-loader.
 * No network, no real keys (the public test-vector seeds).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assetDeploy,
	drainCanonical,
	drainMessage,
	drainWindow,
	kernelDrain,
	kernelHealth,
	kernelPromote,
	kernelResolveScript,
	kernelRollback,
	loaderSlotsProject,
	packageIdentity,
	parseKernelResolve,
	pointerHistory,
	type AssetDeps,
} from "../src/commands/kernel-asset";
import { KERNEL_LOG } from "../src/commands/kernel";
import { loadProject, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import type { FleetClient } from "../src/fleet";
import { BAKED_FOLDER, pointerOf, type KernelPointer } from "../src/kernelasset";
import { setOutputMode } from "../src/log";
import { parseRecord, verifySettingsRecord } from "../src/settings";
import { parseSigningKey, TEST_VECTOR_FALLBACK_SEED, TEST_VECTOR_MAIN_SEED, TEST_VECTOR_PUBLIC_KEYS, verifyCanonical, type DualSigner } from "../src/signing";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";
import { harness, hasLune, packageFile, place, quiet } from "./fixtures/kernel-luau/lune-cloud";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

const SIGNER: DualSigner = { main: parseSigningKey(TEST_VECTOR_MAIN_SEED), fallback: parseSigningKey(TEST_VECTOR_FALLBACK_SEED) };
const [MAIN_PUBLIC, FALLBACK_PUBLIC] = TEST_VECTOR_PUBLIC_KEYS;
const HASH = "a".repeat(64);
const NOW = new Date("2026-10-09T12:00:00.000Z");

function gameProject(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-kasset-"));
	writeFileSync(join(root, "typetorch.json"), JSON.stringify({ project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, defaultBranch: "prod", ...patch }, null, "\t"));
	mkdirSync(join(root, ".typetorch"), { recursive: true });
	useSettings(new Settings({ startDir: root, env: {} }));
	return loadProject(join(root, "typetorch.json"));
}

function fakes(proj: Project, options: { moderation?: string; resolve?: Record<string, unknown>; fleet?: FleetClient; confirm?: boolean; interactive?: boolean } = {}) {
	const calls: string[] = [];
	const cloud = fakeDataStoreCloud();
	const records: any[] = [];
	const stateDir = join(proj.root, ".typetorch");
	const deps: AssetDeps = {
		assets: {
			async createModelAsset(input) {
				calls.push(`create ${input.displayName} ${JSON.stringify(input.creator)}`);
				return "op-create";
			},
			async updateModelAsset(input) {
				calls.push(`update ${input.assetId}`);
				return "op-update";
			},
			async waitForOperation(id) {
				calls.push(`operation ${id}`);
				return { done: true, response: { assetId: id === "op-create" ? "555" : String(proj.config.kernelAssetId), moderationResult: { moderationState: options.moderation ?? "Approved" } } };
			},
			async waitForModeration(assetId) {
				calls.push(`moderation ${assetId}`);
				return { state: options.moderation ?? "Approved", timedOut: false };
			},
			async runLuau(_u, _p, script) {
				calls.push(`task ${script.includes("GetLatestAssetVersionAsync") ? "resolve" : "?"}`);
				return { state: "COMPLETE", results: [options.resolve ?? { versionId: "777001", hash: HASH, problems: {}, tries: 1 }] };
			},
		} as AssetDeps["assets"],
		deploy: cloud.oc as unknown as AssetDeps["deploy"],
		signer: () => SIGNER,
		interactive: options.interactive ?? true,
		confirm: async () => options.confirm ?? true,
		record: (entry) => {
			records.push(entry);
			appendFileSync(join(stateDir, KERNEL_LOG), JSON.stringify({ at: NOW.toISOString(), ...entry }) + "\n");
		},
		fleet: options.fleet,
		now: () => NOW,
		setKernelAssetId: (id) => {
			calls.push(`kernelAssetId ${id}`);
			proj.config.kernelAssetId = id;
		},
	};
	const body = () => parseRecord(cloud.values.settings).body as any;
	return { deps, calls, cloud, records, body, stateDir };
}

const deployInput = (proj: Project, patch: Partial<Parameters<typeof assetDeploy>[0]> = {}) => ({
	proj,
	channel: "dev" as const,
	version: "0.4.1",
	hash: HASH,
	commit: "abc1234",
	bytes: new Uint8Array([1, 2, 3]),
	kept: ".typetorch/kernels/0.4.1-aaaaaaaaaaaa.rbxm",
	newAsset: false,
	reupload: false,
	dryRun: false,
	yes: true,
	timeoutSeconds: 120,
	...patch,
});

describe("the drain message", () => {
	test("signs exactly what the kernel's Drain.luau checks (the kernel's test vector)", () => {
		const fields = { v: "0.4.1", h: "c".repeat(64), w: 600, t: 1791500000000 };
		expect(drainCanonical(fields)).toBe(`tt1drain\n0.4.1\n${"c".repeat(64)}\n600\n1791500000000`);
		const message = JSON.parse(drainMessage(SIGNER, fields));
		// kernel-asset scripts/loader-vectors.json "drain" (made with node:crypto from the same public test seeds).
		expect(message).toEqual({
			k: "drain",
			...fields,
			sig: "mPEqz6fgW6CZ+mS4BiKasELnnYZrC/PIMutpmF/B65mUmYXk7c+rZv5xdmeY8BD+VqpfvovW31ogx9++SYz3BQ==",
			sigF: "49SirKmhOaFpxSQpjsjF6L7Hk6FWV2PLuCjJxmVeYphn9V+9kEQqa/Bf2rBDUcemi7bkpjF9TQYBdbW6qt+RCg==",
		});
		expect(() => drainCanonical({ ...fields, v: "a\nb" })).toThrow();
		expect(drainWindow("30", "drain")).toBe(1800);
		expect(drainWindow(undefined, "drain")).toBeUndefined();
		expect(() => drainWindow("61", "drain")).toThrow("0 to 60");
	});
});

describe.skipIf(!hasLune)("the resolve task (Lune, an InsertService mock)", () => {
	const run = (file: string, options: { waitSeconds?: number; latest?: number } = {}) =>
		parseKernelResolve(
			[harness(kernelResolveScript(555, HASH, options.waitSeconds ?? 0), place("game-installed.rbxl"), undefined, { assets: { latest: { "555": options.latest ?? 777001 }, files: { "777001": file } } }).result],
			HASH,
		);
	test("a good package: its version id, no problems", () => {
		expect(run(packageFile("kernel-v2", HASH))).toEqual({ versionId: 777001, problems: [] });
		expect(packageIdentity(new Uint8Array(readFileSync(packageFile("kernel-v2", HASH))))).toEqual({ version: undefined, hash: HASH, slots: ["ServerScriptService.TypeTorchKernel", "ReplicatedStorage.TypeTorchKernelShared", "ReplicatedFirst.TypeTorchKernelClient"] });
	});
	test("refused: enabled scripts, a trust root, another hash, a version that doesn't load", () => {
		expect(run(packageFile("kernel-v2", HASH, "enabled")).problems.join(" ")).toContain("is not disabled");
		expect(run(packageFile("kernel-v2", HASH, "trust")).problems.join(" ")).toContain("carries the trust root KeyAssetId");
		expect(run(packageFile("kernel-v2", "b".repeat(64))).problems[0]).toContain("KernelHash bbbbbbbbbbbb");
		expect(run(packageFile("kernel-v2", HASH), { latest: 999 }).problems[0]).toContain("LoadAssetVersion(999): Asset is not approved");
	});
});

describe("kernel deploy --asset (fakes)", () => {
	test("a dry run uploads and signs nothing", async () => {
		const proj = gameProject();
		const f = fakes(proj);
		const { json, error } = await quiet(() => assetDeploy(deployInput(proj, { dryRun: true }), f.deps));
		expect(error).toBeUndefined();
		expect(json).toMatchObject({ dryRun: true, channel: "dev", asset: "a NEW kernel asset" });
		expect(f.calls).toEqual([]);
		expect(f.cloud.values.settings).toBeUndefined();
	});

	test("first deploy: a new group asset (kernelAssetId), resolve, the dev pointer signed with both keys", async () => {
		const proj = gameProject();
		const f = fakes(proj);
		const { json, error } = await quiet(() => assetDeploy(deployInput(proj), f.deps));
		expect(error).toBeUndefined();
		expect(f.calls).toEqual(['create TypeTorchKernel {"groupId":3}', "operation op-create", "kernelAssetId 555", "task resolve"]);
		const pointer = pointerOf(f.body(), "dev")!;
		expect(pointer).toEqual({ asset: 555, versionId: 777001, version: "0.4.1", hash: HASH, loaderApi: 1, commit: "abc1234", at: NOW.toISOString() });
		expect(pointerOf(f.body(), "prod")).toBeUndefined();
		const record = f.cloud.values.settings as any;
		expect(verifySettingsRecord(record, { main: MAIN_PUBLIC })).toBe("sig");
		expect(verifySettingsRecord(record, { fallback: FALLBACK_PUBLIC })).toBe("sigF");
		expect(f.cloud.published.map((m) => JSON.parse(m.message).k)).toEqual(["settings"]);
		expect(f.records.at(-1)).toMatchObject({ event: "kernel-pointer", action: "deploy", channel: "dev", created: true, pointers: { dev: { versionId: 777001 } } });
		expect(json).toMatchObject({ pointer: { versionId: 777001 } });
	});

	test("--channel prod sets both pointers; an existing asset gets a new version; --drain sends the signed drain", async () => {
		const proj = gameProject({ kernelAssetId: 555 });
		const f = fakes(proj);
		const { error } = await quiet(() => assetDeploy(deployInput(proj, { channel: "prod", drainSeconds: 600 }), f.deps));
		expect(error).toBeUndefined();
		expect(f.calls.slice(0, 2)).toEqual(["update 555", "operation op-update"]);
		expect(pointerOf(f.body(), "prod")?.versionId).toBe(777001);
		expect(pointerOf(f.body(), "dev")?.versionId).toBe(777001);
		const drain = f.cloud.published.map((m) => JSON.parse(m.message)).find((m) => m.k === "drain");
		expect(drain).toMatchObject({ v: "0.4.1", h: HASH, w: 600, t: NOW.getTime() });
		expect(verifyCanonical(FALLBACK_PUBLIC, drainCanonical(drain), drain.sigF)).toBe(true);
	});

	test("moderation or a bad version: nothing pointed at it", async () => {
		const proj = gameProject({ kernelAssetId: 555 });
		const rejected = fakes(proj, { moderation: "Rejected" });
		expect((await quiet(() => assetDeploy(deployInput(proj), rejected.deps))).error?.message).toContain("moderation is Rejected; nothing was pointed at it");
		expect(rejected.cloud.values.settings).toBeUndefined();
		const bad = fakes(proj, { resolve: { versionId: "777002", hash: HASH, problems: ["ServerScriptService.TypeTorchKernel.Kernel is not disabled"] } });
		expect((await quiet(() => assetDeploy(deployInput(proj), bad.deps))).error?.message).toContain("is not disabled");
		expect(bad.cloud.values.settings).toBeUndefined();
	});

	test("no y/N without a terminal; a 'no' uploads nothing", async () => {
		const proj = gameProject();
		const noTerminal = fakes(proj, { interactive: false });
		expect((await quiet(() => assetDeploy(deployInput(proj, { yes: false }), noTerminal.deps))).error?.message).toContain("without --yes");
		const declined = fakes(proj, { confirm: false });
		expect((await quiet(() => assetDeploy(deployInput(proj, { yes: false }), declined.deps))).error).toBeUndefined();
		expect(declined.calls).toEqual([]);
	});
});

describe("promote, rollback, drain (fakes)", () => {
	const DEV: KernelPointer = { asset: 555, versionId: 777001, version: "0.4.1", hash: HASH, loaderApi: 1, at: "2026-10-09T10:00:00.000Z" };
	const fleet = (reports: { result: string; kernelVersion?: string; at?: number }[] = [], kernel = "0.4.1"): FleetClient => ({
		async servers() {
			return [{ jobId: "j1", accessCode: true, experiment: false, branch: "dev", channel: "dev", kernelVersion: kernel, health: "ok" }];
		},
		async reports() {
			return reports.map((r) => ({ seq: 1, branch: "dev", jobId: "j1", kernelVersion: "0.4.1", at: Date.parse("2026-10-09T11:00:00.000Z") / 1000, ...r }));
		},
		async alerts() {
			return [];
		},
		async postAlert() {
			return false;
		},
	});

	test("the health proof: old enough, servers on it, no failed or rolled back report from it", async () => {
		expect((await kernelHealth(fleet([{ result: "swapped" }]), DEV, { now: NOW })).proven).toBe(true);
		expect((await kernelHealth(fleet(), { ...DEV, at: "2026-10-09T11:30:00.000Z" }, { now: NOW })).reason).toContain("0.5 h, under 1 h");
		expect((await kernelHealth(undefined, DEV, { now: NOW })).reason).toContain("no fleet API");
		expect((await kernelHealth(fleet([], "0.4.0"), DEV, { now: NOW })).reason).toContain("no live server runs");
		expect((await kernelHealth(fleet([{ result: "rolled_back" }]), DEV, { now: NOW })).reason).toContain("1 deploy report(s)");
		// A failure from before the pointer, or from another kernel, doesn't count.
		expect((await kernelHealth(fleet([{ result: "failed", at: Date.parse("2026-10-09T09:00:00.000Z") / 1000 }, { result: "failed", kernelVersion: "0.4.0" }]), DEV, { now: NOW })).proven).toBe(true);
	});

	async function withDev(proj: Project, f: ReturnType<typeof fakes>) {
		const { error } = await quiet(() => assetDeploy(deployInput(proj), { ...f.deps, now: () => new Date(DEV.at) }));
		expect(error).toBeUndefined();
	}

	test("promote: proven -> prod = dev; unproven refused unless --force", async () => {
		const proj = gameProject();
		const unproven = fakes(proj, { fleet: fleet([{ result: "failed" }]) });
		await withDev(proj, unproven);
		expect((await quiet(() => kernelPromote({ proj, force: false, yes: true, dryRun: false }, unproven.deps))).error?.message).toContain("refusing to promote an unproven kernel");
		expect(pointerOf(unproven.body(), "prod")).toBeUndefined();
		const forced = await quiet(() => kernelPromote({ proj, force: true, yes: true, dryRun: false }, unproven.deps));
		expect(forced.error).toBeUndefined();
		expect(pointerOf(unproven.body(), "prod")?.versionId).toBe(777001);

		const proj2 = gameProject();
		const proven = fakes(proj2, { fleet: fleet([{ result: "swapped" }]) });
		await withDev(proj2, proven);
		const { json, error } = await quiet(() => kernelPromote({ proj: proj2, force: false, yes: true, dryRun: false, drainSeconds: 0 }, proven.deps));
		expect(error).toBeUndefined();
		expect(json).toMatchObject({ to: { versionId: 777001, at: NOW.toISOString() }, health: { proven: true } });
		expect(proven.cloud.published.map((m) => JSON.parse(m.message).k)).toEqual(["settings", "settings", "drain"]);
		expect(proven.records.at(-1)).toMatchObject({ action: "promote", channel: "prod", forced: false });
	});

	test("rollback: the channel's previous kernel from this machine's log, or --to", async () => {
		const proj = gameProject({ kernelAssetId: 555 });
		const f = fakes(proj, { resolve: { versionId: "777001", hash: HASH, problems: [] } });
		await quiet(() => assetDeploy(deployInput(proj, { channel: "prod" }), f.deps));
		const second = fakes(proj, { resolve: { versionId: "777002", hash: "b".repeat(64), problems: [] } });
		second.cloud.values.settings = f.cloud.values.settings;
		second.cloud.versions.settings = f.cloud.versions.settings;
		await quiet(() => assetDeploy(deployInput(proj, { channel: "prod", version: "0.4.2", hash: "b".repeat(64) }), second.deps));
		expect(pointerHistory(second.stateDir, 42, "prod").map((p) => p.versionId)).toEqual([777001, 777002]);
		const { error, json } = await quiet(() => kernelRollback({ proj, channel: "prod", yes: true, dryRun: false, stateDir: second.stateDir }, second.deps));
		expect(error).toBeUndefined();
		expect(json).toMatchObject({ from: { versionId: 777002 }, to: { versionId: 777001, version: "0.4.1" } });
		expect(pointerOf(second.body(), "prod")?.versionId).toBe(777001);
		expect((await quiet(() => kernelRollback({ proj, channel: "prod", to: "9.9.9", yes: true, dryRun: false, stateDir: second.stateDir }, second.deps))).error?.message).toContain('no kernel.prod pointer "9.9.9"');
	});

	test("drain: the signed message for the channel's kernel", async () => {
		const proj = gameProject();
		const f = fakes(proj);
		await quiet(() => assetDeploy(deployInput(proj, { channel: "prod" }), f.deps));
		const { error } = await quiet(() => kernelDrain({ proj, channel: "prod", windowSeconds: 1800, yes: true, dryRun: false }, f.deps));
		expect(error).toBeUndefined();
		const drain = f.cloud.published.map((m) => JSON.parse(m.message)).find((m) => m.k === "drain");
		expect(drain).toMatchObject({ v: "0.4.1", h: HASH, w: 1800 });
		expect(verifyCanonical(MAIN_PUBLIC, drainCanonical(drain), drain.sig)).toBe(true);
	});
});

describe("install-loader's slots", () => {
	test("the loader carries the trust roots, the identity and MinKernelVersion; the kernel is baked; the backup comes along", () => {
		const stamped = {
			tree: {
				$className: "DataModel",
				ServerScriptService: { $className: "ServerScriptService", TypeTorchKernel: { $className: "Folder", $attributes: { KernelVersion: "0.4.1", KernelHash: HASH, KeyAssetId: 9, FallbackPublicKey: "fb", BootstrapHeads: "{}" }, Kernel: { $path: "/k/src/server/Kernel.server.luau" } } },
				ReplicatedStorage: { $className: "ReplicatedStorage", TypeTorchKernelShared: { $className: "Folder" } },
				ReplicatedFirst: { $className: "ReplicatedFirst", TypeTorchKernelClient: { $path: "/k/src/client/KernelClient.client.luau" } },
				ServerStorage: { $className: "ServerStorage", TypeTorchBackup: { $path: "/game/backup.rbxm" } },
			},
		};
		const loaderProject = {
			tree: {
				ServerScriptService: { TypeTorchLoader: { $path: "src/loader/Loader.server.luau", $attributes: { KeyAssetId: "", MinKernelVersion: "" }, Core: { $path: "src/loader/LoaderCore.luau" } } },
				ReplicatedFirst: { TypeTorchLoaderClient: { $path: "src/loader/LoaderClient.client.luau" } },
			},
		};
		const { project, slots } = loaderSlotsProject({ stamped, kernelDir: "/k", identity: {} as never }, loaderProject, "0.4.1");
		expect(slots.map((s) => `${s.service}.${s.name}`)).toEqual(["ServerScriptService.TypeTorchLoader", "ReplicatedFirst.TypeTorchLoaderClient", `ServerStorage.${BAKED_FOLDER}`, "ServerStorage.TypeTorchBackup"]);
		const tree = (project as any).tree;
		const loader = tree.ServerScriptService.TypeTorchLoader;
		expect(loader.$path).toEndWith("/k/src/loader/Loader.server.luau");
		expect(loader.Core.$path).toEndWith("/k/src/loader/LoaderCore.luau");
		expect(loader.$attributes).toEqual({ KeyAssetId: 9, FallbackPublicKey: "fb", BootstrapHeads: "{}", KernelVersion: "0.4.1", KernelHash: HASH, MinKernelVersion: "0.4.1" });
		const baked = tree.ServerStorage[BAKED_FOLDER];
		expect(baked.ServerScriptService.TypeTorchKernel.Kernel.$properties).toEqual({ Disabled: true });
		expect(JSON.stringify(baked)).not.toContain("FallbackPublicKey");
		expect(tree.ServerStorage.TypeTorchBackup).toEqual({ $path: "/game/backup.rbxm" });
	});
});
