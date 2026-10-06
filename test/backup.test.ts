/**
 * Kernel 0.3.6 ("never an empty server"): the backup build. Uploads keep their payload (`<state dir>/payloads`),
 * `kernel deploy` stamps the prod head's one and bakes it into the place as ServerStorage.TypeTorchBackup (a kernel
 * slot, so patches replace it), and `doctor` reports it. The fixture-place tests build a real kernel place with Rojo
 * and patch a Lune-made game place with it; they are skipped when Rojo or Lune can't run.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareBackup } from "../src/commands/kernel";
import type { LiveHead } from "../src/deployments";
import { backupChecks, lastKernelDeploy } from "../src/keycheck";
import { kernelLayout } from "../src/kernelpatch";
import {
	addBackupToProject,
	BACKUP_SLOT,
	BackupError,
	backupAge,
	backupHead,
	backupRbxm,
	findKeptPayload,
	keepPayload,
	keptPayloadName,
	keptPayloadPath,
	PAYLOADS_DIR,
} from "../src/payloads";
import { patchPlace, PlaceFile, summarizePlace, verifyPatch, type SlotRef } from "../src/placepatch";
import { readRbxm, setRootAttributes } from "../src/rbxm";

const fixtures = resolve(import.meta.dir, "fixtures");
const ok = new Uint8Array(readFileSync(join(fixtures, "payload-ok.rbxm")));
const scripts = new Uint8Array(readFileSync(join(fixtures, "payload-scripts.rbxm")));
/** payload-ok as a published prod build (the CLI stamps ArtifactId and Channel at build time). */
const prodPayload = (artifactId = "a1b2c3d-111111", channel = "prod") => setRootAttributes(ok, { ArtifactId: artifactId, Channel: channel });
const rootOf = (bytes: Uint8Array) => {
	const list = readRbxm(bytes);
	const referents = new Set(list.map((i) => i.referent));
	return list.find((i) => i.parent === -1 || !referents.has(i.parent))!;
};
const head = (branch: string, seq: number, artifactId: string): LiveHead => ({
	branch,
	seq,
	assetId: 1000 + seq,
	artifactId,
	channel: branch === "prod" ? "prod" : "dev",
	commit: artifactId.slice(0, 7),
	commitHash: "",
	deployedAt: "2026-10-06T10:00:00Z",
	by: "me",
});

describe("kept payloads", () => {
	test("every upload is kept as <state dir>/payloads/<artifactId>.rbxm; the oldest beyond the limit go", () => {
		const state = mkdtempSync(join(tmpdir(), "tt-kept-"));
		const first = keepPayload(state, "aaaaaaa-111111", ok, 3)!;
		expect(first).toBe(keptPayloadPath(state, "aaaaaaa-111111"));
		expect(new Uint8Array(readFileSync(first))).toEqual(ok);
		const old = Date.now() / 1000 - 1000;
		utimesSync(first, old, old);
		for (const [index, id] of ["bbbbbbb-222222", "ccccccc-333333", "ddddddd-444444"].entries()) {
			const path = keepPayload(state, id, ok, 3)!;
			utimesSync(path, old + 10 * (index + 1), old + 10 * (index + 1));
		}
		keepPayload(state, "eeeeeee-555555", ok, 3);
		expect(findKeptPayload(state, "aaaaaaa-111111")).toBeUndefined();
		expect(findKeptPayload(state, "bbbbbbb-222222")).toBeUndefined();
		expect(findKeptPayload(state, "eeeeeee-555555")).toBeDefined();
		expect(findKeptPayload(state, "ddddddd-444444")).toBeDefined();
	});
	test("names are file-safe; a write that can't happen never throws", () => {
		expect(keptPayloadName("a1b2c3d-dirty-0f0f0f")).toBe("a1b2c3d-dirty-0f0f0f.rbxm");
		expect(keptPayloadName("../x/y")).toBe(".._x_y.rbxm");
		const file = join(mkdtempSync(join(tmpdir(), "tt-kept-")), "not-a-dir");
		writeFileSync(file, "x");
		expect(keepPayload(file, "a", ok)).toBeUndefined();
	});
});

describe("the backup build", () => {
	const config = { defaultBranch: "prod", channels: {} as Record<string, "prod" | "dev"> };
	test("from the default branch's prod head, else the newest prod-channel head", () => {
		const heads = new Map([
			["prod", head("prod", 12, "aaaaaaa-111111")],
			["dev", head("dev", 30, "bbbbbbb-222222")],
		]);
		expect(backupHead(config, heads)?.artifactId).toBe("aaaaaaa-111111");
		const other = { defaultBranch: "main", channels: { live: "prod", eu: "prod" } as Record<string, "prod" | "dev"> };
		const live = new Map([
			["live", head("live", 5, "ccccccc-333333")],
			["eu", head("eu", 9, "ddddddd-444444")],
			["dev", head("dev", 50, "eeeeeee-555555")],
		]);
		expect(backupHead(other, live)?.artifactId).toBe("ddddddd-444444");
		expect(backupHead(config, new Map([["dev", head("dev", 1, "x")]]))).toBeUndefined();
	});
	test("the kept payload, stamped with BackupArtifactId/Seq/Branch/Channel/At; everything else kept", () => {
		const info = { artifactId: "a1b2c3d-111111", seq: 12, branch: "prod", channel: "prod" as const, at: "2026-10-06T10:00:00.000Z" };
		const bytes = backupRbxm(prodPayload(), info);
		const root = rootOf(bytes);
		expect(root.className).toBe("Model");
		expect(root.attributes).toMatchObject({ ArtifactId: "a1b2c3d-111111", Channel: "prod", BackupArtifactId: "a1b2c3d-111111", BackupSeq: 12, BackupBranch: "prod", BackupChannel: "prod", BackupAt: "2026-10-06T10:00:00.000Z" });
		expect(readRbxm(bytes).map((i) => `${i.className}:${i.name}`).sort()).toEqual(readRbxm(ok).map((i) => `${i.className}:${i.name}`).sort());
	});
	test("refused: scripts in the payload, a dev-channel payload, another artifact", () => {
		const info = { artifactId: "a1b2c3d-111111", seq: 12, branch: "prod", channel: "prod" as const, at: "t" };
		expect(() => backupRbxm(setRootAttributes(scripts, { Channel: "prod" }), info)).toThrow(BackupError);
		expect(() => backupRbxm(setRootAttributes(scripts, { Channel: "prod" }), info)).toThrow(/more than Folders and ModuleScripts/);
		expect(() => backupRbxm(prodPayload("a1b2c3d-111111", "dev"), info)).toThrow(/dev-channel/);
		expect(() => backupRbxm(prodPayload("zzzzzzz-999999"), info)).toThrow(/not a1b2c3d-111111/);
	});
	test("the stamped project gets ServerStorage.TypeTorchBackup, a kernel slot (the patch replaces it)", () => {
		const project = { name: "P", tree: { $className: "DataModel", ServerScriptService: { $className: "ServerScriptService", TypeTorchKernel: { $className: "Folder" } } } };
		const withBackup = addBackupToProject(project, "C:\\game\\.typetorch\\backup.rbxm") as any;
		expect(withBackup.tree.ServerStorage).toEqual({ $className: "ServerStorage", TypeTorchBackup: { $path: "C:/game/.typetorch/backup.rbxm" } });
		expect((project.tree as any).ServerStorage).toBeUndefined();
		expect(kernelLayout(withBackup).slots).toContainEqual(BACKUP_SLOT);
	});
	test("prepareBackup: the kept payload of the prod head, or why there is none", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-backup-"));
		const state = join(root, ".typetorch");
		const proj = { root, config: { defaultBranch: "prod", channels: {} } } as any;
		const history = { heads: new Map([["prod", head("prod", 12, "a1b2c3d-111111")]]), snapshot: undefined };
		const missing = prepareBackup(proj, history, { stateDir: state });
		expect(missing.info).toBeUndefined();
		expect(missing.skipped).toMatch(/a1b2c3d-111111 \(#12\) has no kept payload in \.typetorch\/payloads/);
		keepPayload(state, "a1b2c3d-111111", prodPayload());
		const made = prepareBackup(proj, history, { stateDir: state, now: new Date("2026-10-06T12:00:00Z") });
		expect(made.info).toEqual({ artifactId: "a1b2c3d-111111", seq: 12, branch: "prod", channel: "prod", at: "2026-10-06T12:00:00.000Z" });
		expect(made.source).toBe(join(state, PAYLOADS_DIR, "a1b2c3d-111111.rbxm"));
		expect(rootOf(new Uint8Array(readFileSync(made.model!))).attributes?.BackupSeq).toBe(12);
		expect(prepareBackup(proj, { heads: new Map(), snapshot: undefined }, { stateDir: state }).skipped).toMatch(/no prod-channel head/);
	});
});

describe("doctor: the place's backup", () => {
	const now = Date.parse("2026-10-06T12:00:00Z");
	test("fresh: ok; old: warn; missing: warn; dev channel: warn; not checked: nothing", () => {
		const source = "the place (Luau Execution)";
		expect(backupChecks({ present: true, artifactId: "a1b2c3d-111111", seq: 12, branch: "prod", channel: "prod", at: "2026-10-06T09:00:00Z", modules: 40, source }, now)).toEqual([
			{ name: "place backup", status: "ok", detail: "the place (Luau Execution): a1b2c3d-111111 #12 (prod), baked 3 h ago, 40 modules" },
		]);
		expect(backupChecks({ present: true, artifactId: "a", channel: "prod", at: "2026-08-01T00:00:00Z", source }, now)[0]).toMatchObject({ status: "warn", detail: expect.stringMatching(/67 d ago.*older than 30 days.*data version guard/) });
		expect(backupChecks({ present: false, source }, now)[0]).toMatchObject({ status: "warn", detail: expect.stringMatching(/no ServerStorage.TypeTorchBackup/) });
		expect(backupChecks({ present: true, artifactId: "a", channel: "dev", at: "2026-10-06T09:00:00Z", source }, now)[0]).toMatchObject({ status: "warn", detail: expect.stringMatching(/dev-channel/) });
		expect(backupChecks(undefined, now)).toEqual([]);
		expect(backupAge("2026-10-06T11:58:00Z", now)?.text).toBe("2 min");
	});
	test("the last kernel deploy's record carries the backup it baked", () => {
		const state = mkdtempSync(join(tmpdir(), "tt-kdlog-"));
		const backup = { artifactId: "a1b2c3d-111111", seq: 12, branch: "prod", channel: "prod", at: "2026-10-06T10:00:00Z" };
		writeFileSync(join(state, "kernel-deploys.jsonl"), `${JSON.stringify({ event: "kernel-published", at: "2026-10-06T10:00:01Z", backupBuild: backup })}\n`);
		expect(lastKernelDeploy(state)?.backupBuild).toEqual(backup);
	});
});

// The place: a real kernel build with Rojo (the stamped project kernel deploy writes), then the splice patch.
const lune = process.env.TYPETORCH_LUNE || "lune";
const rojo = process.env.TYPETORCH_ROJO || "rojo";
const dir = mkdtempSync(join(tmpdir(), "tt-backup-place-"));
writeFileSync(join(dir, "rokit.toml"), '[tools]\nlune = "lune-org/lune@0.10.5"\nrojo = "rojo-rbx/rojo@7.6.1"\n');
const made = Bun.spawnSync([lune, "run", resolve(fixtures, "kernel-patch", "make-fixtures.luau"), dir], { cwd: dir, stdout: "pipe", stderr: "pipe" });
const rojoRuns = Bun.spawnSync([rojo, "--version"], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
const canBuild = made.exitCode === 0 && rojoRuns;
if (!canBuild) console.warn("backup place tests skipped: Lune or Rojo didn't run");

const SLOTS: SlotRef[] = [{ service: "ServerScriptService", name: "TypeTorchKernel" }, BACKUP_SLOT];

function kernelPlace(name: string, backupArtifact?: string, seq = 12): Uint8Array {
	let project: unknown = {
		name: "Kernel",
		tree: {
			$className: "DataModel",
			ServerScriptService: { $className: "ServerScriptService", TypeTorchKernel: { $className: "Folder", $attributes: { KernelVersion: "0.3.6" } } },
		},
	};
	if (backupArtifact) {
		const model = join(dir, `${name}.backup.rbxm`);
		writeFileSync(model, backupRbxm(prodPayload(backupArtifact), { artifactId: backupArtifact, seq, branch: "prod", channel: "prod", at: "2026-10-06T10:00:00Z" }));
		project = addBackupToProject(project, model);
	}
	writeFileSync(join(dir, `${name}.project.json`), JSON.stringify(project));
	const built = Bun.spawnSync([rojo, "build", `${name}.project.json`, "-o", `${name}.rbxl`], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	if (built.exitCode !== 0) throw new Error(`rojo build failed: ${built.stderr.toString()}`);
	return new Uint8Array(readFileSync(join(dir, `${name}.rbxl`)));
}

function backupIn(place: Uint8Array) {
	const list = readRbxm(place);
	const byReferent = new Map(list.map((i) => [i.referent, i]));
	return list.filter((i) => i.name === "TypeTorchBackup" && byReferent.get(i.parent)?.className === "ServerStorage").map((i) => ({
		className: i.className,
		attributes: i.attributes,
		modules: list.filter((child) => child.className === "ModuleScript" && (() => {
			let node = byReferent.get(child.parent);
			while (node && node !== i) node = byReferent.get(node.parent);
			return node === i;
		})()).length,
	}));
}

describe.skipIf(!canBuild)("the backup in fixture places (Rojo build + splice patch)", () => {
	test("Rojo bakes the stamped backup as ServerStorage.TypeTorchBackup: Model, modules, attributes", () => {
		const place = kernelPlace("k1", "a1b2c3d-111111");
		expect(backupIn(place)).toEqual([
			{ className: "Model", modules: 2, attributes: expect.objectContaining({ ArtifactId: "a1b2c3d-111111", Channel: "prod", BackupArtifactId: "a1b2c3d-111111", BackupSeq: 12, BackupBranch: "prod", BackupChannel: "prod", BackupAt: "2026-10-06T10:00:00Z" }) },
		]);
	});
	test("a patch adds the backup to a game place, and the next one replaces it (one copy, everything else kept)", () => {
		const game = new Uint8Array(readFileSync(join(dir, "game.rbxl")));
		const k1 = kernelPlace("k1", "a1b2c3d-111111");
		const first = patchPlace({ original: game, kernel: k1, slots: SLOTS, serviceProps: [], seed: "s" });
		expect(first.report.slots.find((s) => s.slot === "ServerStorage.TypeTorchBackup")).toMatchObject({ before: 0, after: 4 });
		expect(backupIn(first.bytes).map((b) => b.attributes?.BackupArtifactId)).toEqual(["a1b2c3d-111111"]);
		expect(verifyPatch(game, first.bytes, k1, SLOTS).problems).toEqual([]);
		const k2 = kernelPlace("k2", "b2c3d4e-222222", 14);
		const second = patchPlace({ original: first.bytes, kernel: k2, slots: SLOTS, serviceProps: [], seed: "s" });
		expect(backupIn(second.bytes).map((b) => [b.attributes?.BackupArtifactId, b.attributes?.BackupSeq])).toEqual([["b2c3d4e-222222", 14]]);
		expect(verifyPatch(first.bytes, second.bytes, k2, SLOTS).problems).toEqual([]);
		// A deploy without a kept payload doesn't declare the slot: the place keeps its backup (listed as kept).
		const k3 = kernelPlace("k3");
		const kept = patchPlace({ original: second.bytes, kernel: k3, slots: [SLOTS[0]], serviceProps: [], seed: "s" });
		expect(backupIn(kept.bytes).map((b) => b.attributes?.BackupArtifactId)).toEqual(["b2c3d4e-222222"]);
		expect(summarizePlace(new PlaceFile(kept.bytes), [SLOTS[0]]).otherTypeTorch).toContain("ServerStorage.TypeTorchBackup");
		expect(existsSync(join(dir, "k3.backup.rbxm"))).toBe(false);
	});
});

mkdirSync(dir, { recursive: true });
