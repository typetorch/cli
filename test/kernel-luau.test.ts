/**
 * The luau engine of `kernel deploy` and `kernel restore --version` (kernelpatch-task.ts, kernel-luau.ts):
 *   - the pure parts: Luau literals, the scripts (no SavePlaceAsync outside the save scripts), the slots project, the
 *     settings, the CLI's reading of the slots .rbxm, the error explanations;
 *   - the generated task scripts run under Lune against a mock DataModel (test/fixtures/kernel-luau/harness.luau) on
 *     the kernel-patch fixture places; a saved place is checked by the splice engine's independent Lune verifier;
 *   - the whole flow (check, y/N, save, verify; restore) against a fake Open Cloud whose tasks run in that harness;
 *   - the Open Cloud calls (binary input create + upload, task creation with a binary input, 429 waits) through a
 *     mocked fetch.
 * No network; the Lune parts are skipped when Lune can't run.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { luauDeploy, luauRestore, type DeployInput } from "../src/kernel-luau";
import { runLuneVerify, writeLuneScript } from "../src/kernelpatch";
import {
	BINARY_INPUT_LIMIT,
	compareSlots,
	explainSaveError,
	explainTaskFailure,
	kernelTaskScript,
	luauString,
	parseKernelTaskResult,
	parseRestoreTaskResult,
	readSlotsRbxm,
	restoreTaskScript,
	saveSettingUrl,
	scriptLines,
	settingValues,
	slotsProject,
	SLOTS_ROOT,
	toLuau,
	type KernelTaskConfig,
	type SlotInventory,
} from "../src/kernelpatch-task";
import { setOutputMode } from "../src/log";
import { dir, fakeCloud, harness, hasLune, lune, makeDeps, nextRun, place, quiet, slotsFile } from "./fixtures/kernel-luau/lune-cloud";
import { OpenCloud, setLuauRetryDelay } from "../src/opencloud";
import { writeRbxm } from "../src/rbxm";
import { DOWNLOAD_SCOPE_HINT, taskTimeout } from "../src/commands/kernel";
import { placeLuauProbe } from "../src/commands/doctor";
import { parseArgs } from "../src/args";
import { kernelFlags } from "../src/commands/kernel";

const SLOTS = [
	{ service: "ServerScriptService", name: "TypeTorchKernel" },
	{ service: "ReplicatedStorage", name: "TypeTorchKernelShared" },
	{ service: "ReplicatedFirst", name: "TypeTorchKernelClient" },
];
const IDENTITY = SLOTS[0];
const HTTP = [{ service: "HttpService", prop: "HttpEnabled", value: true }];

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	setOutputMode({ json: false, verbose: false });
	setLuauRetryDelay(12_000);
});

function config(patch: Partial<KernelTaskConfig> = {}): KernelTaskConfig {
	return { mode: "check", placeId: 2, placeVersion: 57, slots: SLOTS, settings: HTTP, install: false, identitySlot: IDENTITY, expect: { KernelVersion: "1.1.0" }, ...patch };
}

// Pure parts -------------------------------------------------------------------------------------------------------------

describe("scripts and literals", () => {
	test("Luau literals: strings escaped byte by byte (three-digit escapes), nested tables, nil for undefined", () => {
		expect(luauString('a"b\\c')).toBe('"a\\"b\\\\c"');
		expect(luauString("\u00001")).toBe('"\\0001"');
		expect(luauString("é")).toBe('"\\195\\169"');
		expect(toLuau({ a: [1, true, "x"], b: undefined, c: null })).toBe('{ ["a"] = { 1, true, "x" }, ["c"] = nil }');
		expect(toLuau({})).toBe("{}");
		expect(() => toLuau(Number.NaN)).toThrow();
	});

	test("only the save scripts contain SavePlaceAsync (a dry run can't save)", () => {
		for (const mode of ["check", "verify"] as const) expect(kernelTaskScript(config({ mode }))).not.toContain("SavePlaceAsync");
		const save = kernelTaskScript(config({ mode: "save", expectOutside: "abc" }));
		expect(save.match(/SavePlaceAsync/g)).toHaveLength(1);
		expect(save).toContain('["expectOutside"] = "abc"');
		expect(save).toContain('["placeVersion"] = 57');
		expect(restoreTaskScript({ placeId: 2, placeVersion: 50, save: false, identitySlot: IDENTITY })).not.toContain("SavePlaceAsync");
		expect(restoreTaskScript({ placeId: 2, placeVersion: 50, save: true, identitySlot: IDENTITY }).match(/SavePlaceAsync/g)).toHaveLength(1);
	});

	test("the slots project holds only the slots, under a Folder per service", () => {
		const stamped = {
			name: "TypeTorchPlace",
			tree: {
				$className: "DataModel",
				HttpService: { $className: "HttpService", $properties: { HttpEnabled: true } },
				Workspace: { $className: "Workspace", Baseplate: { $className: "Part" } },
				ServerScriptService: { $className: "ServerScriptService", $properties: { LoadStringEnabled: false }, TypeTorchKernel: { $className: "Folder", $attributes: { KernelVersion: "0.3.8" }, Kernel: { $path: "/k/Kernel.server.luau" } } },
				ReplicatedStorage: { $className: "ReplicatedStorage", TypeTorchKernelShared: { $className: "Folder" } },
				ReplicatedFirst: { $className: "ReplicatedFirst", TypeTorchKernelClient: { $path: "/k/KernelClient.client.luau" } },
				ServerStorage: { $className: "ServerStorage", TypeTorchBackup: { $path: "/game/.typetorch/backup.rbxm" } },
			},
		};
		const slots = [...SLOTS, { service: "ServerStorage", name: "TypeTorchBackup" }];
		const project = slotsProject(stamped, slots);
		expect(project.name).toBe(SLOTS_ROOT);
		expect(Object.keys(project.tree).sort()).toEqual(["$className", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage"]);
		expect(project.tree.$className).toBe("Folder");
		expect(project.tree.ServerScriptService).toEqual({ $className: "Folder", TypeTorchKernel: stamped.tree.ServerScriptService.TypeTorchKernel });
		expect(project.tree.ServerStorage).toEqual({ $className: "Folder", TypeTorchBackup: { $path: "/game/.typetorch/backup.rbxm" } });
		expect(JSON.stringify(project)).not.toContain("Baseplate");
		expect(JSON.stringify(project)).not.toContain("$properties");
		expect(() => slotsProject(stamped, [{ service: "ServerScriptService", name: "Missing" }])).toThrow("no ServerScriptService.Missing");
	});

	test("settings take the project's values: implicit or explicit Rojo values; others are listed", () => {
		const stamped = { tree: { HttpService: { $properties: { HttpEnabled: true } }, ServerScriptService: { $className: "ServerScriptService", $properties: { LoadStringEnabled: { Bool: false }, Weird: [1, 2] } } } };
		const props = [
			{ service: "HttpService", prop: "HttpEnabled" },
			{ service: "ServerScriptService", prop: "LoadStringEnabled" },
			{ service: "ServerScriptService", prop: "Weird" },
		];
		expect(settingValues(stamped, props)).toEqual({
			settings: [
				{ service: "HttpService", prop: "HttpEnabled", value: true },
				{ service: "ServerScriptService", prop: "LoadStringEnabled", value: false },
			],
			unusable: ["ServerScriptService.Weird"],
		});
	});

	test("the CLI reads the slots .rbxm itself: instances, scripts, the script list hash, the identity", () => {
		const bytes = writeRbxm([
			{ className: "Folder", name: SLOTS_ROOT, parent: -1 },
			{ className: "Folder", name: "ServerScriptService", parent: 0 },
			{ className: "Folder", name: "TypeTorchKernel", parent: 1, attributes: { KernelVersion: "1.1.0", KernelHash: "ab" } },
			{ className: "Script", name: "Kernel", parent: 2 },
			{ className: "Folder", name: "vendor", parent: 2 },
			{ className: "ModuleScript", name: "Lib", parent: 4 },
			{ className: "Folder", name: "ReplicatedFirst", parent: 0 },
			{ className: "LocalScript", name: "TypeTorchKernelClient", parent: 6 },
			{ className: "Folder", name: "ReplicatedStorage", parent: 0 },
			{ className: "Folder", name: "TypeTorchKernelShared", parent: 8 },
		]);
		const read = readSlotsRbxm(bytes, SLOTS, IDENTITY);
		expect(read.identity).toEqual({ KernelVersion: "1.1.0", KernelHash: "ab" });
		expect(read.slots.map((s) => [s.slot, s.instances, s.scripts])).toEqual([
			["ServerScriptService.TypeTorchKernel", 4, 2],
			["ReplicatedStorage.TypeTorchKernelShared", 1, 0],
			["ReplicatedFirst.TypeTorchKernelClient", 1, 1],
		]);
		expect(scriptLines([{ rel: "vendor/Lib", className: "ModuleScript" }, { rel: "Kernel", className: "Script" }, { rel: "vendor", className: "Folder" }])).toEqual(["Kernel:Script", "vendor/Lib:ModuleScript"]);
		expect(() => readSlotsRbxm(writeRbxm([{ className: "Model", name: "X", parent: -1 }]), SLOTS, IDENTITY)).toThrow(`one root Folder ${SLOTS_ROOT}`);
		expect(() => readSlotsRbxm(writeRbxm([{ className: "Folder", name: SLOTS_ROOT, parent: -1 }]), SLOTS, IDENTITY)).toThrow("0 ServerScriptService.TypeTorchKernel");
	});

	test("compareSlots: copies, counts, and the hash only when the task used SHA-256", () => {
		const cli: SlotInventory[] = [{ slot: "A.B", instances: 3, scripts: 2, scriptsHash: "h1" }];
		expect(compareSlots([{ slot: "A.B", copies: 1, instances: 3, scripts: 2, scriptsHash: "h1" }], cli, "sha256")).toEqual([]);
		expect(compareSlots([{ slot: "A.B", copies: 1, instances: 3, scripts: 2, scriptsHash: "zz" }], cli, "fnv")).toEqual([]);
		expect(compareSlots([{ slot: "A.B", copies: 2, instances: 4, scripts: 2, scriptsHash: "zz" }], cli, "sha256")).toEqual([
			"A.B: 2 copies (expected 1)",
			"A.B: 4 instances, the kernel build has 3",
			"A.B: its script list differs from the kernel build's",
		]);
		expect(compareSlots([], cli, "sha256")).toEqual(["A.B: the task didn't report it"]);
	});

	test("SavePlaceAsync failures name the fix: the place setting (with its Creator Hub page), Team Create, or both", () => {
		const where = { universeId: 10, placeId: 20 };
		expect(saveSettingUrl(10, 20)).toBe("https://create.roblox.com/dashboard/creations/experiences/10/places/20/permissions");
		const setting = explainSaveError("HTTP 403 (Forbidden): Place is not allowed to be saved via Save Place API", where);
		expect(setting.kind).toBe("setting");
		expect(setting.text).toContain("Allow place to be updated using Save Place API");
		expect(setting.text).toContain(saveSettingUrl(10, 20));
		expect(setting.text).toContain("Roblox said: HTTP 403");
		const tc = explainSaveError("Save failed. Server is busy, Team Create session active", where);
		expect(tc.kind).toBe("team-create");
		expect(tc.text).toContain("close the place in Studio");
		const unknown = explainSaveError("something odd", where);
		expect(unknown.kind).toBe("unknown");
		expect(unknown.text).toContain("Allow place to be updated using Save Place API");
		expect(unknown.text).toContain("Team Create");
	});

	test("task failures name the fix", () => {
		expect(explainTaskFailure({ code: "DEADLINE_EXCEEDED", message: "x" }, 120)).toContain("--timeout 300");
		expect(explainTaskFailure({ code: "DEADLINE_EXCEEDED", message: "x" }, 300)).toContain("--place-file");
		expect(explainTaskFailure({ code: "INTERNAL_ERROR", message: "x" }, 300)).toContain("run again");
		expect(explainTaskFailure({ code: "SCRIPT_ERROR", message: "boom" }, 300)).toContain("(SCRIPT_ERROR): boom");
	});

	test("--timeout: 30 to 300 s, default 300; the download hint names the version history 403 and the luau engine", () => {
		expect(taskTimeout(parseArgs(["deploy"], kernelFlags))).toBe(300);
		expect(taskTimeout(parseArgs(["deploy", "--timeout", "120"], kernelFlags))).toBe(120);
		expect(() => taskTimeout(parseArgs(["deploy", "--timeout", "301"], kernelFlags))).toThrow("30 to 300");
		expect(() => taskTimeout(parseArgs(["deploy", "--timeout", "10"], kernelFlags))).toThrow();
		expect(DOWNLOAD_SCOPE_HINT).toContain("no API-key route");
		expect(DOWNLOAD_SCOPE_HINT).toContain("Scope must be configured to allow all resources");
		expect(DOWNLOAD_SCOPE_HINT).toContain("luau engine");
	});

	test("doctor's place-key Luau probe", () => {
		expect(placeLuauProbe(404, "", 1, 2)).toEqual(["ok", expect.stringContaining("Allow place to be updated using Save Place API")]);
		expect(placeLuauProbe(403, "Forbidden", 1, 2)).toEqual(["warn", expect.stringContaining("luau-execution-session")]);
	});

	test("parsers tolerate Lune's {} for empty lists and missing fields", () => {
		const parsed = parseKernelTaskResult([{ ok: true, problems: {}, slots: {}, refs: { remapped: {} }, outside: { changed: {} } }]);
		expect(parsed.problems).toEqual([]);
		expect(parsed.slots).toEqual([]);
		expect(parsed.refs).toEqual({ remapped: [], cleared: [], nRemapped: 0, nCleared: 0 });
		expect(parseKernelTaskResult([]).ok).toBe(false);
		expect(parseRestoreTaskResult([{ ok: true, saved: true, identity: { KernelVersion: "1.0.0" } }])).toMatchObject({ ok: true, saved: true, identity: { KernelVersion: "1.0.0" } });
	});
});

// The task scripts under Lune -------------------------------------------------------------------------------------------

describe.skipIf(!hasLune)("the deploy task under Lune (mock DataModel)", () => {
	let verifyScript = "";
	beforeAll(() => {
		verifyScript = writeLuneScript(dir);
	});

	test("check: replaces every copy of each slot, re-points or clears references, keeps everything else, never saves", () => {
		const { result, calls, saved } = harness(kernelTaskScript(config()), place("game-installed.rbxl"), slotsFile("kernel-v2"));
		const r = parseKernelTaskResult([result]);
		expect(r.problems).toEqual([]);
		expect(r.ok).toBe(true);
		expect(calls.save).toBe(0);
		expect(saved).toBeUndefined();
		expect(r.firstInstall).toBe(false);
		expect(r.oldKernel.KernelVersion).toBe("1.0.0");
		expect(r.identity.KernelVersion).toBe("1.1.0");
		expect(r.hashMode).toBe("sha256");
		const kernel = r.slots.find((s) => s.slot === "ServerScriptService.TypeTorchKernel")!;
		expect(kernel).toMatchObject({ copies: 1, changed: ["Kernel:Script"], added: ["Extra:ModuleScript"], removed: ["Api:ModuleScript"] });
		expect(r.slots.find((s) => s.slot === "ReplicatedFirst.TypeTorchKernelClient")).toMatchObject({ copies: 2, before: 2, after: 1 });
		expect(r.refs.remapped).toEqual(["Workspace.RefConstants.Value -> ReplicatedStorage/TypeTorchKernelShared/Constants"]);
		expect(r.refs.cleared).toEqual(["Workspace.RefApi.Value -> ServerScriptService/TypeTorchKernel/Api"]);
		expect(r.settings).toEqual([{ path: "HttpService.HttpEnabled", want: "true", before: "false", after: "true", changed: true, error: undefined }]);
		expect(r.outside).toMatchObject({ nChanged: 0, unstable: 0, unserializable: 0 });
		expect(r.outside.subtrees).toBeGreaterThan(5);
		expect(r.outside.afterD).toBe(r.outside.rootD!);
		// The task and the CLI agree on the new slots, script list hashes included (Luau sort = byte order).
		expect(compareSlots(r.newSlots, readSlotsRbxm(new Uint8Array(readFileSync(slotsFile("kernel-v2"))), SLOTS, IDENTITY).slots, r.hashMode)).toEqual([]);
	});

	test("save: SavePlaceAsync once; the saved place passes the splice engine's independent Lune verifier", async () => {
		const check = parseKernelTaskResult([harness(kernelTaskScript(config()), place("game-installed.rbxl"), slotsFile("kernel-v2")).result]);
		const { result, calls, saved } = harness(kernelTaskScript(config({ mode: "save", expectOutside: check.outside.rootD })), place("game-installed.rbxl"), slotsFile("kernel-v2"));
		expect(result.saved).toBe(true);
		expect(result.ok).toBe(true);
		expect(calls.save).toBe(1);
		expect(saved).toBeDefined();
		writeFileSync(join(dir, "spec.json"), JSON.stringify({ slots: SLOTS, settings: [{ service: "HttpService", prop: "HttpEnabled" }] }));
		const verified = await runLuneVerify(lune, dir, verifyScript, { original: place("game-installed.rbxl"), patched: saved!, kernel: place("kernel-v2.rbxl"), spec: join(dir, "spec.json"), out: join(dir, "verify.json") });
		expect(verified.problems).toEqual([]);
		expect(verified.slots.every((s) => s.equal)).toBe(true);
		expect(verified.references).toEqual(["Workspace.RefApi.Value: ServerScriptService.TypeTorchKernel.Api -> nil"]);

		// The verify task on the saved place: one copy per slot, the identity, the same outside descriptor.
		const verify = parseKernelTaskResult([harness(kernelTaskScript(config({ mode: "verify" })), saved!, undefined, { placeVersion: 57 }).result]);
		expect(verify.problems).toEqual([]);
		expect(verify.identity.KernelVersion).toBe("1.1.0");
		expect(verify.newSlots.every((s) => s.copies === 1)).toBe(true);
		expect(verify.outside.rootD).toBe(result.outside.afterD);
		expect(compareSlots(verify.newSlots, readSlotsRbxm(new Uint8Array(readFileSync(slotsFile("kernel-v2"))), SLOTS, IDENTITY).slots, verify.hashMode)).toEqual([]);
	});

	test("save refuses when the outside content differs from the check's (expectOutside)", () => {
		const { result, calls } = harness(kernelTaskScript(config({ mode: "save", expectOutside: "0".repeat(64) })), place("game-installed.rbxl"), slotsFile("kernel-v2"));
		expect(result.saved).toBe(false);
		expect(calls.save).toBe(0);
		expect(result.problems[0]).toContain("differs from what the check task saw");
	});

	test("a first install: reported by the check, refused by the save without --install, saved with it", () => {
		const check = parseKernelTaskResult([harness(kernelTaskScript(config()), place("game.rbxl"), slotsFile("kernel-v2")).result]);
		expect(check.ok).toBe(true);
		expect(check.firstInstall).toBe(true);
		expect(check.addedServices).toEqual(["ReplicatedFirst"]);
		const refused = harness(kernelTaskScript(config({ mode: "save" })), place("game.rbxl"), slotsFile("kernel-v2"));
		expect(refused.calls.save).toBe(0);
		expect(refused.result.problems.join(" ")).toContain("--install");
		const installed = harness(kernelTaskScript(config({ mode: "save", install: true })), place("game.rbxl"), slotsFile("kernel-v2"));
		expect(installed.calls.save).toBe(1);
		expect(installed.result.saved).toBe(true);
	});

	test("a setting the task can't write stops it before saving", () => {
		const { result, calls } = harness(kernelTaskScript(config({ mode: "save" })), place("game-installed.rbxl"), slotsFile("kernel-v2"), { denySetting: "HttpEnabled" });
		expect(calls.save).toBe(0);
		expect(result.saved).toBe(false);
		expect(result.problems.join(" ")).toContain("HttpService.HttpEnabled can't be set to true from a task");
		const r = parseKernelTaskResult([result]);
		expect(r.settings[0].error).toContain("cannot write");
	});

	test("anything outside the slots that changes during the patch stops it before saving", () => {
		const { result, calls } = harness(kernelTaskScript(config({ mode: "save" })), place("game-installed.rbxl"), slotsFile("kernel-v2"), { tamperOnSetting: true });
		expect(calls.save).toBe(0);
		const r = parseKernelTaskResult([result]);
		expect(r.outside.nChanged).toBe(1);
		expect(r.outside.changed[0]).toMatch(/^Workspace\|Workspace\/Lobby#1: structure, names, attributes/);
		expect(r.problems.join(" ")).toContain("outside the kernel slots changed");
	});

	test("a SavePlaceAsync error comes back as saveError (not saved)", () => {
		const { result, calls } = harness(kernelTaskScript(config({ mode: "save" })), place("game-installed.rbxl"), slotsFile("kernel-v2"), { saveError: "Place is not allowed to be saved: enable Save Place API" });
		expect(calls.save).toBe(1);
		const r = parseKernelTaskResult([result]);
		expect(r).toMatchObject({ saved: false, saveAttempted: true, ok: false, saveError: "Place is not allowed to be saved: enable Save Place API" });
		expect(explainSaveError(r.saveError!, { universeId: 1, placeId: 2 }).kind).toBe("setting");
	});

	test("bytes that differ between two reads: compared by descriptor only, still ok", () => {
		const r = parseKernelTaskResult([harness(kernelTaskScript(config()), place("game-installed.rbxl"), slotsFile("kernel-v2"), { unstableBytes: true }).result]);
		expect(r.problems).toEqual([]);
		expect(r.outside.unstable).toBe(r.outside.subtrees);
	});

	test("without EncodingService the task falls back to FNV and still works", () => {
		const r = parseKernelTaskResult([harness(kernelTaskScript(config()), place("game-installed.rbxl"), slotsFile("kernel-v2"), { noEncoding: true }).result]);
		expect(r.problems).toEqual([]);
		expect(r.hashMode).toBe("fnv");
		expect(r.outside.rootD).toMatch(/^fnv[0-9a-f]{16}$/);
	});

	test("refused inputs and places: a non-slot in the input, the wrong place version, no input", () => {
		const extra = harness(kernelTaskScript(config()), place("game-installed.rbxl"), slotsFile("kernel-v2", true));
		expect(extra.result.problems.join(" ")).toContain("ServerScriptService.NotASlot, which isn't a kernel slot");
		const wrong = harness(kernelTaskScript(config()), place("game-installed.rbxl"), slotsFile("kernel-v2"), { placeVersion: 56 });
		expect(wrong.result.problems.join(" ")).toContain("runs on place version 56");
		const none = harness(kernelTaskScript(config()), place("game-installed.rbxl"), undefined);
		expect(none.result.problems.join(" ")).toContain("no binary input");
	});

	test("the restore task reports the version's kernel; only its save script saves", () => {
		const check = harness(restoreTaskScript({ placeId: 2, placeVersion: 57, save: false, identitySlot: IDENTITY }), place("game-installed.rbxl"), undefined);
		expect(check.calls.save).toBe(0);
		const r = parseRestoreTaskResult([check.result]);
		expect(r).toMatchObject({ ok: true, saved: false, identity: { KernelVersion: "1.0.0" } });
		expect(r.instances).toBeGreaterThan(10);
		const save = harness(restoreTaskScript({ placeId: 2, placeVersion: 57, save: true, identitySlot: IDENTITY }), place("game-installed.rbxl"), undefined);
		expect(save.calls.save).toBe(1);
		expect(parseRestoreTaskResult([save.result])).toMatchObject({ ok: true, saved: true });
		const mismatch = harness(restoreTaskScript({ placeId: 2, placeVersion: 50, save: true, identitySlot: IDENTITY }), place("game-installed.rbxl"), undefined);
		expect(mismatch.calls.save).toBe(0);
		expect(parseRestoreTaskResult([mismatch.result]).problem).toContain("asked for v50");
	});
});

// The flow against a fake Open Cloud whose tasks run in the harness ---------------------------------------------------

function deployInput(patch: Partial<DeployInput> = {}): DeployInput {
	const slotsPath = slotsFile("kernel-v2");
	const slotsBytes = new Uint8Array(readFileSync(slotsPath));
	return {
		universeId: 1,
		placeId: 2,
		where: "universe 1, place 2",
		kernel: { version: "1.1.0", hash: "1".repeat(64), commit: "abc1234" },
		slots: SLOTS,
		settings: HTTP,
		identitySlot: IDENTITY,
		slotsBytes,
		slotsFile: ".typetorch/kernel-slots.rbxm",
		cliSlots: readSlotsRbxm(slotsBytes, SLOTS, IDENTITY).slots,
		install: false,
		dryRun: false,
		yes: false,
		timeoutSeconds: 300,
		blockers: [],
		reportPath: join(dir, `report-${nextRun()}.json`),
		reportDisplay: "report.json",
		logFields: { by: "test" },
		...patch,
	};
}

describe.skipIf(!hasLune)("kernel deploy --engine luau (fake Open Cloud, tasks in Lune)", () => {
	// The fixture's kernel-v2 says KernelVersion 1.1.0 and KernelHash 111...1.
	test("--dry-run: one binary input, one check task without SavePlaceAsync, the report, nothing saved", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const d = makeDeps(cloud.oc);
		const input = deployInput({ dryRun: true });
		const { json, error } = await quiet(() => luauDeploy(input, d));
		expect(error).toBeUndefined();
		expect(cloud.createdInputs).toEqual([input.slotsBytes.length]);
		expect(cloud.tasks.map((t) => [t.kind, t.version])).toEqual([["check", 57]]);
		expect(cloud.tasks[0].binaryInput).toBe("universes/1/luau-execution-session-task-binary-inputs/in1");
		expect(cloud.tasks[0].script).not.toContain("SavePlaceAsync");
		expect(cloud.versions.map((v) => v.version)).toEqual([57, 56]);
		expect(d.records).toEqual([]);
		expect(d.asked).toEqual([]);
		expect(json).toMatchObject({ dryRun: true, engine: "luau", base: { version: 57, published: true }, check: { ok: true, refs: { nRemapped: 1, nCleared: 1 } }, crossCheck: [] });
		expect(JSON.parse(readFileSync(input.reportPath, "utf8")).check.ok).toBe(true);
	});

	test("deploy: check, y/N, save (SavePlaceAsync on the base version), the new version, verify; records around it", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const d = makeDeps(cloud.oc);
		const { json, error } = await quiet(() => luauDeploy(deployInput(), d));
		expect(error).toBeUndefined();
		expect(d.asked).toHaveLength(1);
		expect(cloud.tasks.map((t) => [t.kind, t.version])).toEqual([["check", 57], ["save", 57], ["verify", 58]]);
		expect(cloud.createdInputs).toHaveLength(1); // reused by the save task
		expect(cloud.tasks[1].binaryInput).toBe(cloud.tasks[0].binaryInput);
		expect(cloud.tasks[1].script).toContain("SavePlaceAsync");
		expect(cloud.tasks[1].script).toContain('["expectOutside"]');
		expect(cloud.tasks[2].binaryInput).toBeUndefined();
		expect(d.records.map((r) => r.event)).toEqual(["kernel-publishing", "kernel-published"]);
		expect(d.records[1]).toMatchObject({ engine: "luau", placeVersionBefore: 57, placeVersionAfter: 58, publishedAfter: true, verify: { ok: true, problems: [] }, by: "test" });
		expect(json).toMatchObject({ placeVersionAfter: 58, verify: { ok: true } });
	});

	test("no y/N without a terminal: refused before the save; a 'no' saves nothing", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const refused = await quiet(() => luauDeploy(deployInput(), makeDeps(cloud.oc, { interactive: false })));
		expect(refused.error?.message).toContain("without --yes");
		const no = makeDeps(cloud.oc, { confirm: async () => false });
		const answered = await quiet(() => luauDeploy(deployInput(), no));
		expect(answered.error).toBeUndefined();
		expect(cloud.tasks.map((t) => t.kind)).toEqual(["check", "check"]);
		expect(no.records).toEqual([]);
	});

	test("someone published after the check: nothing saved", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"), { raceTo: 58 });
		const { error } = await quiet(() => luauDeploy(deployInput({ yes: true }), makeDeps(cloud.oc)));
		expect(error?.message).toContain("the place changed since the check (newest version then v57, now v58)");
		expect(cloud.tasks.map((t) => t.kind)).toEqual(["check"]);
	});

	test("SavePlaceAsync refused: the Creator Hub setting with its page; recorded as failed", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"), { saveError: "Save Place API is not enabled for this place" });
		const d = makeDeps(cloud.oc);
		const { error } = await quiet(() => luauDeploy(deployInput({ yes: true }), d));
		expect(error?.message).toContain('turn on "Allow place to be updated using Save Place API"');
		expect(error?.message).toContain(saveSettingUrl(1, 2));
		expect(d.records.map((r) => r.event)).toEqual(["kernel-publishing", "kernel-failed"]);
		expect(cloud.versions.map((v) => v.version)).toEqual([57, 56]);
	});

	test("a save task that times out: the --timeout fix, the task log, and whether a version appeared", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"), { failSave: { code: "DEADLINE_EXCEEDED", message: "too slow" } });
		const d = makeDeps(cloud.oc);
		const { error } = await quiet(() => luauDeploy(deployInput({ yes: true, timeoutSeconds: 120 }), d));
		expect(error?.message).toContain("--timeout 300");
		expect(error?.message).toContain("log line");
		expect(error?.message).toContain("no new version appeared: nothing was published");
		expect(d.records.at(-1)).toMatchObject({ event: "kernel-failed", placeVersionAfter: null });
	});

	test("check problems stop the deploy with the Studio fix for settings; a dry run still shows them", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"), { denySetting: "HttpEnabled" });
		const { error } = await quiet(() => luauDeploy(deployInput({ yes: true }), makeDeps(cloud.oc)));
		expect(error?.message).toContain("the check task found problems (nothing saved");
		expect(error?.message).toContain("Allow HTTP Requests");
		expect(cloud.tasks.map((t) => t.kind)).toEqual(["check"]);
	});

	test("signing blockers: a dry run warns, a deploy refuses before the y/N", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const d = makeDeps(cloud.oc);
		expect((await quiet(() => luauDeploy(deployInput({ dryRun: true, blockers: ["no keyAssetId"] }), d))).error).toBeUndefined();
		const { error } = await quiet(() => luauDeploy(deployInput({ blockers: ["no keyAssetId"] }), d));
		expect(error?.message).toContain("no keyAssetId");
		expect(d.asked).toEqual([]);
	});

	test("a first install needs --install (the dry run only warns)", async () => {
		const cloud = fakeCloud(place("game.rbxl"));
		expect((await quiet(() => luauDeploy(deployInput({ dryRun: true }), makeDeps(cloud.oc)))).error).toBeUndefined();
		const refused = await quiet(() => luauDeploy(deployInput({ yes: true }), makeDeps(cloud.oc)));
		expect(refused.error?.message).toContain("--install");
		const d = makeDeps(cloud.oc);
		const installed = await quiet(() => luauDeploy(deployInput({ yes: true, install: true }), d));
		expect(installed.error).toBeUndefined();
		expect(d.records.at(-1)).toMatchObject({ event: "kernel-published", firstInstall: true, placeVersionAfter: 58 });
	});

	test("an input over 100 MiB is refused before anything is sent", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const { error } = await quiet(() => luauDeploy(deployInput({ slotsBytes: new Uint8Array(BINARY_INPUT_LIMIT + 1) }), makeDeps(cloud.oc)));
		expect(error?.message).toContain("over Open Cloud's 100 MiB binary input limit");
		expect(error?.message).toContain("--no-backup");
		expect(cloud.createdInputs).toEqual([]);
	});

	test("the base: an unpublished newest version is refused (--base published patches the last publish)", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		// As the Assets API sends it: `published: true`, and false left out.
		cloud.versions.push({ version: 58, published: false, hasPublishedField: false });
		const { error } = await quiet(() => luauDeploy(deployInput({ dryRun: true }), makeDeps(cloud.oc)));
		expect(error?.message).toContain("v58 is not published");
		const ok = await quiet(() => luauDeploy(deployInput({ dryRun: true, baseFlag: "published" }), makeDeps(cloud.oc)));
		expect(ok.error).toBeUndefined();
		expect(ok.json).toMatchObject({ base: { version: 57, skipped: [58] } });
	});
});

describe.skipIf(!hasLune)("kernel restore --version (fake Open Cloud, tasks in Lune)", () => {
	const restoreInput = (patch: Partial<Parameters<typeof luauRestore>[0]> = {}) => ({ universeId: 1, placeId: 2, where: "universe 1, place 2", version: 56, identitySlot: IDENTITY, dryRun: false, yes: true, timeoutSeconds: 300, ...patch });

	test("dry run: one check task on that version, no SavePlaceAsync", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const { json, error } = await quiet(() => luauRestore(restoreInput({ dryRun: true }), makeDeps(cloud.oc)));
		expect(error).toBeUndefined();
		expect(cloud.tasks.map((t) => [t.kind, t.version])).toEqual([["restore-check", 56]]);
		expect(json).toMatchObject({ dryRun: true, version: 56, newest: 57, check: { identity: { KernelVersion: "1.0.0" } } });
	});

	test("restore: the save task on that version only calls SavePlaceAsync; recorded with the new version", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const d = makeDeps(cloud.oc);
		const { json, error } = await quiet(() => luauRestore(restoreInput(), d));
		expect(error).toBeUndefined();
		expect(cloud.tasks.map((t) => [t.kind, t.version])).toEqual([["restore-check", 56], ["restore-save", 56]]);
		expect(d.records.map((r) => r.event)).toEqual(["kernel-restoring", "kernel-restored"]);
		expect(json).toMatchObject({ mode: "restore", engine: "luau", fromVersion: 56, placeVersionAfter: 58 });
	});

	test("a version newer than the newest is refused", async () => {
		const cloud = fakeCloud(place("game-installed.rbxl"));
		const { error } = await quiet(() => luauRestore(restoreInput({ version: 99 }), makeDeps(cloud.oc)));
		expect(error?.message).toContain("has no v99 yet");
		expect(cloud.tasks).toEqual([]);
	});
});

// Open Cloud calls (mocked fetch) ---------------------------------------------------------------------------------------

describe("Open Cloud: binary inputs and task creation", () => {
	const KEY = "test-api-key-not-real-0000";
	test("createBinaryInput posts the size; uploadBinaryInput PUTs to the presigned URI without the key, then without a content type after a 4xx", async () => {
		const calls: { method: string; url: string; key: string | null; type: string | null; body?: string }[] = [];
		let puts = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			calls.push({ method: init?.method ?? "GET", url, key: headers.get("x-api-key"), type: headers.get("content-type"), body: typeof init?.body === "string" ? init.body : undefined });
			if (url.includes("luau-execution-session-task-binary-inputs")) return new Response(JSON.stringify({ path: "universes/1/luau-execution-session-task-binary-inputs/abc", size: 3, uploadUri: "https://storage.test.invalid/up?sig=x" }), { status: 200 });
			if (url.startsWith("https://storage.test.invalid/")) return new Response(++puts === 1 ? "SignatureDoesNotMatch" : "", { status: puts === 1 ? 403 : 200 });
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const oc = new OpenCloud(KEY);
		const input = await oc.createBinaryInput(1, 3);
		expect(input).toEqual({ path: "universes/1/luau-execution-session-task-binary-inputs/abc", uploadUri: "https://storage.test.invalid/up?sig=x" });
		expect(calls[0]).toMatchObject({ method: "POST", key: KEY, body: JSON.stringify({ size: 3 }) });
		await oc.uploadBinaryInput(input.uploadUri, new Uint8Array([1, 2, 3]));
		const uploads = calls.filter((c) => c.url.startsWith("https://storage.test.invalid/"));
		expect(uploads.map((c) => [c.method, c.key, c.type])).toEqual([
			["PUT", null, "application/octet-stream"],
			["PUT", null, null],
		]);
		await expect(oc.uploadBinaryInput("http://storage.test.invalid/x", new Uint8Array(1))).rejects.toThrow("isn't https");
	});

	test("runLuau passes the binary input; a 429 on creation waits and tries again", async () => {
		setLuauRetryDelay(1);
		const bodies: any[] = [];
		let creates = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "POST") {
				bodies.push(JSON.parse(String(init.body)));
				if (++creates === 1) return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
				return new Response(JSON.stringify({ path: "universes/1/places/2/versions/57/luau-execution-sessions/s/tasks/t", state: "COMPLETE", output: { results: [{ ok: true }] } }), { status: 200 });
			}
			return new Response("{}", { status: 404, headers: { url } });
		}) as typeof fetch;
		const run = await new OpenCloud(KEY).runLuau(1, 2, "return 1", 60, { version: 57, binaryInput: "universes/1/luau-execution-session-task-binary-inputs/abc" });
		expect(run.state).toBe("COMPLETE");
		expect(creates).toBe(2);
		expect(bodies[1]).toEqual({ script: "return 1", timeout: "60s", binaryInput: "universes/1/luau-execution-session-task-binary-inputs/abc" });
	});

	test("a refused task creation (403) is not retried", async () => {
		let creates = 0;
		globalThis.fetch = (async () => {
			creates++;
			return new Response(JSON.stringify({ message: "Scope not authorized" }), { status: 403 });
		}) as unknown as typeof fetch;
		await expect(new OpenCloud(KEY).runLuau(1, 2, "return 1", 60, { version: 57 })).rejects.toThrow("403");
		expect(creates).toBe(1);
	});
});
