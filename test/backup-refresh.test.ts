/**
 * Fresh backups (commands/backup.ts) and `deploy --reupload` (commands/reupload.ts):
 *   - typetorch.json "backup", the health proof (a fake fleet API), what this machine last put in the place;
 *   - the refresh through the luau engine with only the backup slot (tasks in the Lune harness, a fake Open Cloud):
 *     refreshed, already, no kernel, unpublished saves, the setting off, a dry run;
 *   - the automatic refresh after a prod release: when it runs, every reason it doesn't (one line, never an error);
 *   - --reupload: the kept bytes go up as a NEW asset (uploads.jsonl reuploadOf) and are deployed with a new seq.
 * No network; the Lune parts skip when Lune can't run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/args";
import { autoRefreshBackup, lastBackupHere, provenHealthy, refreshBackup, type BuildRef } from "../src/commands/backup";
import { deployCommand, deployFlags } from "../src/commands/deploy";
import { loadProject, validateBackup } from "../src/config";
import { appendUpload, readUploads } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { scriptedInteraction, useInteraction } from "../src/interact";
import type { FleetClient, ReportRow, ServerRow } from "../src/fleet";
import { parseKernelTaskResult, readSlotsRbxm, kernelTaskScript } from "../src/kernelpatch-task";
import { captureJson, setOutputMode } from "../src/log";
import { BACKUP_SLOT, keepPayload } from "../src/payloads";
import { backupSlotsFile, fakeCloud, harness, hasLune, makeDeps, place, quiet } from "./fixtures/kernel-luau/lune-cloud";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
	process.exitCode = 0;
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const build = (patch: Partial<BuildRef> = {}): BuildRef => ({ branch: "prod", seq: 7, artifactId: "abc1234-aaaaaa", assetId: 111, at: new Date(NOW - 5 * HOUR).toISOString(), ...patch });

function fleet(reports: Partial<ReportRow>[], servers: Partial<ServerRow>[] = [], fail = false): FleetClient {
	return {
		async reports() {
			if (fail) throw new Error("530 tunnel down");
			return reports.map((r) => ({ seq: 7, branch: "prod", jobId: "j1", result: "swapped", ...r }));
		},
		async servers() {
			return servers.map((s) => ({ jobId: "j1", accessCode: false, experiment: false, branch: "prod", ...s }));
		},
		async alerts() {
			return [];
		},
		async postAlert() {
			return false;
		},
	};
}

function gameRoot(patch: Record<string, unknown> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "tt-backup-"));
	writeFileSync(join(root, "typetorch.json"), JSON.stringify({ project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, defaultBranch: "prod", ...patch }, null, "\t"));
	mkdirSync(join(root, ".typetorch"), { recursive: true });
	useSettings(new Settings({ startDir: root, env: { OPENCLOUD_API_KEY: "test-api-key-not-real-0000" } }));
	return root;
}

describe("settings, the health proof, what this machine knows", () => {
	test('typetorch.json "backup": refresh auto|off, healthyHours 0-168, defaults', () => {
		expect(validateBackup({})).toEqual({ backup: { refresh: "auto", healthyHours: 3 }, errors: [] });
		expect(validateBackup({ refresh: "off", healthyHours: 0.5 })).toEqual({ backup: { refresh: "off", healthyHours: 0.5 }, errors: [] });
		expect(validateBackup({ refresh: "sometimes" }).errors[0]).toContain('"auto" or "off"');
		expect(validateBackup({ healthyHours: 500 }).errors[0]).toContain("0 to 168");
		expect(validateBackup({ every: 1 }).errors[0]).toContain('"backup.every" is not a setting');
		expect(validateBackup(3).errors[0]).toContain("must be an object");
		const root = gameRoot({ backup: { healthyHours: 6 } });
		expect(loadProject(join(root, "typetorch.json")).config.backup).toEqual({ refresh: "auto", healthyHours: 6 });
	});

	test("proven healthy: old enough, reported, no failure, no sick server, and a fleet API", async () => {
		expect(await provenHealthy(fleet([{}]), build(), 3, NOW)).toMatchObject({ proven: true, reason: expect.stringContaining("live 5.0 h, 1 swapped, no failures") });
		expect((await provenHealthy(fleet([{}]), build({ at: new Date(NOW - HOUR).toISOString() }), 3, NOW)).reason).toContain("live 1.0 h, under the 3 h");
		expect((await provenHealthy(fleet([{}]), build({ at: undefined }), 3, NOW)).reason).toContain("isn't in this machine's deployment log");
		expect((await provenHealthy(undefined, build(), 3, NOW)).reason).toContain("no fleet API");
		expect((await provenHealthy(fleet([]), build(), 3, NOW)).reason).toContain("no server reported");
		expect((await provenHealthy(fleet([{}, { jobId: "j2", result: "rolled_back" }]), build(), 3, NOW)).reason).toContain("failed or rolled back");
		expect((await provenHealthy(fleet([{}], [{ artifactId: "abc1234-aaaaaa", health: "degraded" }]), build(), 3, NOW)).reason).toContain("1 server(s) running #7 abc1234-aaaaaa are degraded");
		expect((await provenHealthy(fleet([{}], [], true), build(), 3, NOW)).reason).toContain("530 tunnel down");
	});

	test("the last backup this machine put into the place: kernel deploy's backupBuild or a refresh", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-backup-log-"));
		expect(lastBackupHere(dir, 2)).toBeUndefined();
		const log = (record: unknown) => appendFileSync(join(dir, "kernel-deploys.jsonl"), JSON.stringify(record) + "\n");
		log({ event: "kernel-published", placeId: 2, backupBuild: { artifactId: "a-1" } });
		log({ event: "kernel-published", placeId: 9, backupBuild: { artifactId: "other-place" } });
		expect(lastBackupHere(dir, 2)).toBe("a-1");
		log({ event: "backup-failed", placeId: 2, artifactId: "a-2" });
		expect(lastBackupHere(dir, 2)).toBe("a-1");
		log({ event: "backup-refreshed", placeId: 2, artifactId: "a-3" });
		expect(lastBackupHere(dir, 2)).toBe("a-3");
	});
});

describe.skipIf(!hasLune)("backup refresh through the luau engine (fake Open Cloud, tasks in Lune)", () => {
	const input = (artifactId: string, patch: Partial<Parameters<typeof refreshBackup>[0]> = {}) => {
		const bytes = new Uint8Array(readFileSync(backupSlotsFile(artifactId)));
		return { universeId: 1, placeId: 2, build: build({ artifactId }), slotsBytes: bytes, cliSlots: readSlotsRbxm(bytes, [BACKUP_SLOT], BACKUP_SLOT).slots, dryRun: false, yes: true, timeoutSeconds: 300, ...patch };
	};

	test("refreshed: only the backup slot changes (check, save, verify); the same build again is 'already'", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const d = makeDeps(cloud.oc);
		const outcome = await refreshBackup(input("abc1234-aaaaaa"), d);
		expect(outcome).toMatchObject({ status: "refreshed", artifactId: "abc1234-aaaaaa", placeVersionBefore: 57, placeVersionAfter: 58, verified: true });
		expect(cloud.tasks.map((t) => [t.kind, t.version])).toEqual([["check", 57], ["save", 57], ["verify", 58]]);
		expect(cloud.tasks[1].script).toContain('["slots"] = { { ["service"] = "ServerStorage", ["name"] = "TypeTorchBackup" } }');
		expect(d.records.map((r) => r.event)).toEqual(["backup-refreshing", "backup-refreshed"]);
		// The saved place: the backup is there; the kernel and everything else are as before (the verify task's view).
		const saved = cloud.places.get(58)!;
		const view = parseKernelTaskResult([harness(kernelTaskScript({ mode: "verify", placeId: 2, placeVersion: 58, slots: [{ service: "ServerScriptService", name: "TypeTorchKernel" }], settings: [], install: false, identitySlot: { service: "ServerScriptService", name: "TypeTorchKernel" }, expect: {} }), saved, undefined, { placeVersion: 58 }).result]);
		expect(view.identity).toMatchObject({ KernelVersion: "1.0.0", BackupArtifactId: "abc1234-aaaaaa" });
		// Again: nothing to do.
		const again = await refreshBackup(input("abc1234-aaaaaa"), makeDeps(cloud.oc));
		expect(again).toMatchObject({ status: "skipped", already: true });
	});

	test("skipped, never thrown: no kernel, unpublished saves, the place setting off; a dry run saves nothing", async () => {
		const bare = fakeCloud(place("game.rbxl"));
		expect(await refreshBackup(input("abc1234-bbbbbb"), makeDeps(bare.oc))).toMatchObject({ status: "skipped", reason: expect.stringContaining("has no TypeTorch kernel") });

		const saves = fakeCloud(place("game-installed.rbxl"));
		saves.versions.push({ version: 58, published: false, hasPublishedField: false });
		expect(await refreshBackup(input("abc1234-bbbbbb"), makeDeps(saves.oc))).toMatchObject({ status: "skipped", reason: expect.stringContaining("refresh after the next publish") });
		expect(saves.tasks).toEqual([]);

		const off = fakeCloud(place("game-installed.rbxl"), { saveError: "Save Place API is not enabled for this place" });
		const offDeps = makeDeps(off.oc);
		expect(await refreshBackup(input("abc1234-bbbbbb"), offDeps)).toMatchObject({ status: "skipped", reason: expect.stringContaining("Allow place to be updated using Save Place API") });
		expect(offDeps.records.map((r) => r.event)).toEqual(["backup-refreshing", "backup-failed"]);

		const dry = fakeCloud(place("game-installed.rbxl"));
		expect(await refreshBackup(input("abc1234-bbbbbb", { dryRun: true }), makeDeps(dry.oc))).toMatchObject({ status: "dry-run", placeVersion: 57 });
		expect(dry.tasks.map((t) => t.kind)).toEqual(["check"]);
	});

	test("the manual y/N: a 'no' saves nothing", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const d = makeDeps(cloud.oc, { confirm: async () => false });
		expect(await refreshBackup(input("abc1234-cccccc", { yes: false }), d)).toEqual({ status: "declined" });
		expect(cloud.tasks.map((t) => t.kind)).toEqual(["check"]);
	});
});

describe("the automatic refresh after a prod release", () => {
	const previous = { artifactId: "abc1234-aaaaaa", assetId: 111, seq: 7, deployedAt: new Date(NOW - 5 * HOUR).toISOString() };
	const run = async (patch: Partial<Parameters<typeof autoRefreshBackup>[0]>, config: Record<string, unknown> = {}) => {
		const root = gameRoot(config);
		const proj = loadProject(join(root, "typetorch.json"));
		const result = await quiet(() => autoRefreshBackup({ proj, action: "deploy", branch: "prod", branchChannel: "prod", previous, interactive: true, deps: { fleet: fleet([{}]), now: NOW }, ...patch }));
		return { ...result, root };
	};

	test("silent when it doesn't apply: dev channel, a rollback, refresh off, another prod branch than the default", async () => {
		expect((await run({ branchChannel: "dev" })).value).toBeUndefined();
		expect((await run({ action: "rollback" })).value).toBeUndefined();
		expect((await run({}, { backup: { refresh: "off" } })).value).toBeUndefined();
		expect((await run({ branch: "prod-eu" }, { channels: { prod: "prod", "prod-eu": "prod" } })).value).toBeUndefined();
	});

	test("skipped with one line: not interactive, no previous build, not proven, no kept payload or key", async () => {
		expect((await run({ interactive: false })).value).toMatchObject({ status: "skipped", reason: expect.stringContaining("not an interactive run (later: typetorch backup refresh --build #7)") });
		expect((await run({ previous: undefined })).value).toMatchObject({ status: "skipped", reason: "no previous build on this branch" });
		expect((await run({ deps: { fleet: fleet([{ result: "failed" }]), now: NOW } })).value).toMatchObject({ status: "skipped", reason: expect.stringContaining("failed or rolled back") });
		expect((await run({ deps: { fleet: null, now: NOW } })).value).toMatchObject({ status: "skipped", reason: expect.stringContaining("no fleet API") });
		// Proven, but neither a place key path nor a kept payload here: the slot build fails, as a line.
		const missing = await run({ deps: { fleet: fleet([{}]), now: NOW, luau: makeDeps(fakeCloud(place("game-installed.rbxl")).oc) } });
		expect(missing.value).toMatchObject({ status: "skipped", reason: expect.stringContaining("no kept payload") });
	});

	test.skipIf(!hasLune)("proven: refreshes the place's backup to the build the release replaced", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const bytes = new Uint8Array(readFileSync(backupSlotsFile("abc1234-aaaaaa")));
		const slots = async () => ({ bytes, cliSlots: readSlotsRbxm(bytes, [BACKUP_SLOT], BACKUP_SLOT).slots });
		const { value, error } = await run({ deps: { fleet: fleet([{}]), now: NOW, luau: makeDeps(cloud.oc), slots } });
		expect(error).toBeUndefined();
		expect(value).toMatchObject({ status: "refreshed", artifactId: "abc1234-aaaaaa", placeVersionAfter: 58 });
	});
});

// deploy --reupload --------------------------------------------------------------------------------------------------------

describe("typetorch deploy --reupload", () => {
	const payload = new Uint8Array(readFileSync(resolve(import.meta.dir, "fixtures", "payload-ok.rbxm")));
	const sha = createHash("sha256").update(payload).digest("hex");

	function mockCloud() {
		const calls: { method: string; path: string; body?: any; file?: Uint8Array }[] = [];
		let counter = 40;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			const call: (typeof calls)[number] = { method, path: url.pathname };
			if (init?.body instanceof FormData) {
				call.body = JSON.parse(String(init.body.get("request")));
				const file = init.body.get("fileContent") as Blob | null;
				if (file) call.file = new Uint8Array(await file.arrayBuffer());
			} else if (typeof init?.body === "string") call.body = JSON.parse(init.body);
			calls.push(call);
			if (method === "POST" && url.pathname === "/assets/v1/assets") return json({ operationId: "op-re" });
			if (url.pathname === "/assets/v1/operations/op-re") return json({ done: true, response: { assetId: "222222222222", displayName: "tt-dev-abc1234", moderationResult: { moderationState: "Approved" } } });
			if (method === "GET" && url.pathname === "/assets/v1/assets/222222222222") return json({ displayName: "tt-dev-abc1234", description: "artifact=x" });
			if (url.pathname.endsWith(":publishMessage")) return json({});
			if (url.pathname.startsWith("/cloud/v2/universes/42/data-stores/TypeTorch/entries/")) {
				if (method === "POST" && url.pathname.endsWith("/seq:increment")) return json({ id: "seq", value: ++counter });
				return json({ code: 5, message: "NOT_FOUND" }, 404);
			}
			if (url.pathname === "/datastores/v1/universes/42/standard-datastores/datastore/entries/entry") {
				return method === "GET" ? json({ error: "NOT_FOUND" }, 404) : json({ version: "v1", deleted: false });
			}
			return json({ message: `not faked: ${method} ${url.pathname}` }, 404);
		}) as unknown as typeof fetch;
		return calls;
	}

	function withUpload(root: string, patch: Record<string, unknown> = {}) {
		const stateDir = join(root, ".typetorch");
		keepPayload(stateDir, "abc1234-0f0f0f", payload);
		appendUpload(stateDir, { artifactId: "abc1234-0f0f0f", assetId: 111111111111, moderation: "Approved", branch: "dev", channel: "dev", commit: "abc1234", commitHash: "abc1234".padEnd(40, "0"), dirty: false, sha256: sha, universeId: 42, ...patch });
		return stateDir;
	}

	const deploy = async (root: string, argv: string[]) => {
		setOutputMode({ json: true, verbose: false });
		let error: Error | undefined;
		const json = await captureJson(async () => {
			try {
				await deployCommand(parseArgs([...argv, "--config", join(root, "typetorch.json")], deployFlags));
			} catch (e) {
				error = e as Error;
			}
		});
		return { json: json as any, error };
	};

	test("uploads the exact kept bytes as a NEW asset (reuploadOf), then deploys them with a new seq", async () => {
		const root = gameRoot({ approval: "none" });
		const stateDir = withUpload(root);
		const calls = mockCloud();
		const { json, error } = await deploy(root, ["--reupload", "111111111111", "--branch", "dev"]);
		expect(error).toBeUndefined();
		const upload = calls.find((c) => c.method === "POST" && c.path === "/assets/v1/assets")!;
		expect(upload.file).toEqual(payload);
		expect(upload.body).toMatchObject({ assetType: "Model", creationContext: { creator: { groupId: "3" } } });
		expect(readUploads(stateDir).at(-1)).toMatchObject({ artifactId: "abc1234-0f0f0f", assetId: 222222222222, reuploadOf: 111111111111, sha256: sha });
		const published = calls.find((c) => c.path.endsWith(":publishMessage"))!;
		expect(JSON.parse(published.body.message)).toMatchObject({ b: "dev", a: 222222222222, i: "abc1234-0f0f0f" });
		expect(json).toMatchObject({ reuploadOf: 111111111111, deployment: { artifactId: "abc1234-0f0f0f", assetId: 222222222222, reuploadOf: 111111111111 } });
	});

	test("refused: no kept payload, changed bytes, a dev build on a prod branch; a dry run sends nothing", async () => {
		const root = gameRoot({ approval: "none" });
		const calls = mockCloud();
		expect((await deploy(root, ["--reupload", "111111111111"])).error?.message).toContain('nothing matches "111111111111"');
		appendUpload(join(root, ".typetorch"), { artifactId: "abc1234-1f1f1f", assetId: 333333333333, moderation: "Approved", branch: "dev", channel: "dev", commit: "abc1234", commitHash: "x", dirty: false, sha256: sha });
		expect((await deploy(root, ["--reupload", "333333333333"])).error?.message).toContain("has no kept payload on this machine");
		withUpload(root, { sha256: "0".repeat(64) });
		expect((await deploy(root, ["--reupload", "111111111111"])).error?.message).toContain("sha256 differs");
		const root2 = gameRoot({ approval: "none" });
		withUpload(root2);
		expect((await deploy(root2, ["--reupload", "111111111111", "--branch", "prod"])).error?.message).toContain("prod branches only take prod-channel builds");
		const dry = await deploy(root2, ["--reupload", "111111111111", "--dry-run"]);
		expect(dry.json).toMatchObject({ dryRun: true, reupload: { artifactId: "abc1234-0f0f0f", oldAssetId: 111111111111 } });
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});

	test("prod-channel branches keep the approval rule: without a person, a proposal (nothing published)", async () => {
		const root = gameRoot({ approval: "prod" });
		withUpload(root, { channel: "prod", branch: "prod" });
		const calls = mockCloud();
		// "Without a person", even when the tests run in a terminal (npm publish runs them there).
		useInteraction(scriptedInteraction({ interactive: false }));
		const { json, error } = await deploy(root, ["--reupload", "111111111111", "--skip-test", "moderation took the asset down"]).finally(() => useInteraction(undefined));
		expect(error).toBeUndefined();
		expect(json).toMatchObject({ proposal: { kind: "deploy", branch: "prod", artifact: { assetId: 222222222222 } }, reuploadOf: 111111111111 });
		expect(calls.some((c) => c.path.endsWith(":publishMessage"))).toBe(false);
	});
});
