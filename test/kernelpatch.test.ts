/**
 * Kernel patch (plans/13, spike S12): the splice engine (placepatch.ts), its two verifiers, the Lune engine, and the
 * pure helpers of kernelpatch.ts. Fixture places are made with Lune (test/fixtures/kernel-patch/make-fixtures.luau)
 * into a temp dir; the Lune-dependent tests are skipped when Lune (through Rokit, or TYPETORCH_LUNE) can't run.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { placeFileName } from "../src/commands/kernel";
import { placeDownloadProbe } from "../src/commands/doctor";
import { chooseBase, kernelLayout, runLunePatch, runLuneVerify, summaryLines, writeLuneScript } from "../src/kernelpatch";
import { encodeChunk, rawChunks, readRbxm, writeRbxm } from "../src/rbxm";
import { patchPlace, PlaceFile, PlacePatchError, summarizePlace, verifyPatch, type SlotRef } from "../src/placepatch";

const SLOTS: SlotRef[] = [
	{ service: "ServerScriptService", name: "TypeTorchKernel" },
	{ service: "ReplicatedStorage", name: "TypeTorchKernelShared" },
	{ service: "ReplicatedFirst", name: "TypeTorchKernelClient" },
];
const SETTINGS = [
	{ service: "HttpService", prop: "HttpEnabled" },
	{ service: "ServerScriptService", prop: "LoadStringEnabled" },
];

const dir = mkdtempSync(join(tmpdir(), "tt-kpatch-"));
const lune = process.env.TYPETORCH_LUNE || "lune";
writeFileSync(join(dir, "rokit.toml"), '[tools]\nlune = "lune-org/lune@0.10.5"\n');
const generated = Bun.spawnSync([lune, "run", resolve(import.meta.dir, "fixtures", "kernel-patch", "make-fixtures.luau"), dir], { cwd: dir, stdout: "pipe", stderr: "pipe" });
const hasLune = generated.exitCode === 0;
if (!hasLune) console.warn(`kernel patch tests skipped: Lune didn't run (${generated.stderr.toString().trim().split(/\r?\n/)[0]})`);
const fixture = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const save = (name: string, bytes: Uint8Array) => {
	writeFileSync(join(dir, name), bytes);
	return join(dir, name);
};
let script = "";
beforeAll(() => {
	if (hasLune) script = writeLuneScript(dir);
});

async function luneVerify(original: string, patched: string, kernel: string) {
	const spec = save("spec.json", new TextEncoder().encode(JSON.stringify({ slots: SLOTS, settings: SETTINGS })));
	return runLuneVerify(lune, dir, script, { original: join(dir, original), patched: join(dir, patched), kernel: join(dir, kernel), spec, out: join(dir, "verify.json") });
}

const patch = (original: string, kernel: string) => patchPlace({ original: fixture(original), kernel: fixture(kernel), slots: SLOTS, serviceProps: SETTINGS, seed: "seed" });
const isDense = (bytes: Uint8Array) => readRbxm(bytes).map((i) => i.referent).sort((a, b) => a - b).every((r, i) => r === i);

describe("kernelLayout and chooseBase", () => {
	test("the slots and settings come from the kernel's place project", () => {
		// The shape of kernel/place.project.json (0.3.1).
		const project = {
			name: "TypeTorchPlace",
			tree: {
				$className: "DataModel",
				HttpService: { $className: "HttpService", $properties: { HttpEnabled: true } },
				Workspace: { $className: "Workspace", Baseplate: { $className: "Part" } },
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: true },
					TypeTorchKernel: { $className: "Folder", $attributes: { KeyAssetId: "" }, Kernel: { $path: "src/server/Kernel.server.luau" } },
				},
				ReplicatedStorage: { $className: "ReplicatedStorage", TypeTorchKernelShared: { $className: "Folder" } },
				ReplicatedFirst: { $className: "ReplicatedFirst", TypeTorchKernelClient: { $path: "src/client/KernelClient.client.luau" } },
			},
		};
		const layout = kernelLayout(project);
		expect(layout.slots).toEqual(SLOTS);
		expect(layout.serviceProps.sort((a, b) => a.service.localeCompare(b.service))).toEqual(SETTINGS);
		expect(kernelLayout({ tree: { $className: "DataModel", Workspace: { $className: "Workspace", Baseplate: {} } } })).toEqual({ slots: [], serviceProps: [] });
	});
	test("base version: newest published by default; saves refuse; published/latest/number", () => {
		const v = (version: number, published: boolean) => ({ version, published, hasPublishedField: true });
		expect(chooseBase([v(15, true), v(14, true)])).toEqual({ ok: true, version: 15, published: true, skipped: [] });
		const refused = chooseBase([v(17, false), v(16, false), v(15, true)]);
		expect(refused.ok).toBe(false);
		expect(!refused.ok && refused.reason).toMatch(/v17 is not published: 2 saved version\(s\) after the last publish \(v15\) \(v17, v16\).*--base latest.*--base published to patch v15/);
		expect(chooseBase([v(17, false), v(16, false), v(15, true)], "published")).toEqual({ ok: true, version: 15, published: true, skipped: [17, 16] });
		expect(chooseBase([v(17, false), v(15, true)], "latest")).toEqual({ ok: true, version: 17, published: false, skipped: [] });
		expect(chooseBase([v(17, false), v(15, true)], "15")).toEqual({ ok: true, version: 15, published: true, skipped: [17] });
		expect(chooseBase([v(15, true)], "newest").ok).toBe(false);
		expect(chooseBase([]).ok).toBe(false);
	});
	test("backup names and the doctor probe", () => {
		expect(placeFileName("102504202680447-v15.rbxl")).toEqual({ placeId: 102504202680447, version: 15 });
		expect(placeFileName("102504202680447-v15-kernel-0.3.1.rbxl")).toEqual({ placeId: 102504202680447, version: 15 });
		expect(placeFileName("102504202680447-vlocal-kernel-0.3.1.rbxl")).toBeUndefined();
		expect(placeDownloadProbe(200, '{"location":"https://cdn.example/x?sig=secret"}')).toEqual(["ok", expect.stringContaining("legacy-asset:manage")]);
		expect(placeDownloadProbe(403, "Forbidden")).toEqual(["info", expect.stringContaining("--place-file <file> --base <version>")]);
		expect(placeDownloadProbe(204, "https://cdn.example/x?sig=secret")[1]).not.toContain("secret");
	});
});

describe.skipIf(!hasLune)("splice engine on Lune-made places", () => {
	test("first install: slots added, a missing service added, settings applied, everything else byte for byte", async () => {
		const original = fixture("game.rbxl");
		const before = summarizePlace(new PlaceFile(original), SLOTS);
		expect(before.slots.every((s) => s.copies === 0)).toBe(true);
		expect(before.kernel).toEqual({});
		const { bytes, report } = patch("game.rbxl", "kernel-v1.rbxl");
		expect(report.addedServices).toEqual(["ReplicatedFirst"]);
		expect(report.slots.map((s) => [s.slot, s.before, s.after])).toEqual([
			["ServerScriptService.TypeTorchKernel", 0, 7],
			["ReplicatedStorage.TypeTorchKernelShared", 0, 3],
			["ReplicatedFirst.TypeTorchKernelClient", 0, 1],
		]);
		expect(report.settings).toEqual([
			{ path: "HttpService.HttpEnabled", before: "false", after: "true", changed: true },
			{ path: "ServerScriptService.LoadStringEnabled", before: "false", after: "true", changed: true },
		]);
		const after = new PlaceFile(bytes);
		expect(summarizePlace(after, SLOTS).kernel).toMatchObject({ version: "1.0.0", versionSource: "attribute" });
		expect(isDense(bytes)).toBe(true);
		// Chunks of classes the kernel doesn't use are copied as stored.
		const raw = (b: Uint8Array) => rawChunks(b).chunks.map((c) => Buffer.from(b.subarray(c.start, c.end)).toString("base64"));
		const kept = new Set(raw(bytes));
		const place = new PlaceFile(original);
		for (const name of ["Part", "Model", "Frame", "TextLabel", "ImageLabel", "Lighting", "RemoteEvent"]) {
			const entry = place.classByName.get(name)!;
			for (const index of [entry.chunk, ...entry.props.map((p) => p.chunk)]) {
				const chunk = place.chunks[index];
				expect(kept.has(Buffer.from(original.subarray(chunk.start, chunk.end)).toString("base64"))).toBe(true);
			}
		}
		const verification = verifyPatch(original, bytes, fixture("kernel-v1.rbxl"), SLOTS);
		expect(verification).toMatchObject({ ok: true, problems: [], droppedProps: [] });
		expect(verification.outside.before).toBe(verification.outside.after);
		save("game+v1.rbxl", bytes);
		const checked = await luneVerify("game.rbxl", "game+v1.rbxl", "kernel-v1.rbxl");
		expect(checked.problems).toEqual([]);
		expect(checked.references).toEqual([]);
		expect(checked.ok).toBe(true);
		expect(checked.addedServices).toEqual(["ReplicatedFirst"]);
		expect(checked.identity.KernelVersion).toBe("1.0.0");
		expect(checked.slots.every((s) => s.equal)).toBe(true);
	});

	test("deterministic: the same inputs give the same bytes (a dry run shows what a deploy publishes)", () => {
		expect(Buffer.from(patch("game.rbxl", "kernel-v1.rbxl").bytes).equals(Buffer.from(patch("game.rbxl", "kernel-v1.rbxl").bytes))).toBe(true);
	});

	test("update: scripts diffed, duplicate copies replaced, references re-pointed by path or cleared", async () => {
		const { bytes, report } = patch("game-installed.rbxl", "kernel-v2.rbxl");
		const kernelSlot = report.slots[0];
		expect(kernelSlot.scripts.changed).toEqual(["Kernel (Script)"]);
		expect(kernelSlot.scripts.added).toEqual(["Extra (ModuleScript)"]);
		expect(kernelSlot.scripts.removed).toEqual(["Api (ModuleScript)"]);
		expect(report.slots[2]).toMatchObject({ slot: "ReplicatedFirst.TypeTorchKernelClient", copies: 2, before: 2, after: 1 });
		expect(report.references.remapped).toEqual(["Workspace/RefConstants.Value -> ReplicatedStorage/TypeTorchKernelShared/Constants"]);
		expect(report.references.cleared).toEqual(["Workspace/RefApi.Value -> ServerScriptService/TypeTorchKernel/Api"]);
		expect(report.oldKernel.version).toBe("1.0.0");
		expect(report.newKernel.version).toBe("1.1.0");
		expect(report.settings.every((s) => !s.changed)).toBe(false); // the game had them off
		expect(verifyPatch(fixture("game-installed.rbxl"), bytes, fixture("kernel-v2.rbxl"), SLOTS).ok).toBe(true);
		save("installed+v2.rbxl", bytes);
		const checked = await luneVerify("game-installed.rbxl", "installed+v2.rbxl", "kernel-v2.rbxl");
		expect(checked.problems).toEqual([]);
		// RefConstants points at the NEW Constants (same full name), RefApi was cleared: only that one is listed.
		expect(checked.references).toEqual(["Workspace.RefApi.Value: ServerScriptService.TypeTorchKernel.Api -> nil"]);
		const values = Bun.spawnSync(
			[lune, "run", save("refs.luau", new TextEncoder().encode(`local roblox = require("@lune/roblox")\nlocal fs = require("@lune/fs")\nlocal g = roblox.deserializePlace(fs.readFile("installed+v2.rbxl"))\nlocal w = g:GetService("Workspace")\nprint(w.RefConstants.Value and w.RefConstants.Value:GetFullName(), w.RefApi.Value, w.RefGame.Value and w.RefGame.Value:GetFullName())\n`))],
			{ cwd: dir, stdout: "pipe", stderr: "pipe" },
		);
		expect(values.stdout.toString().trim().split(/\s+/)).toEqual(["ReplicatedStorage.TypeTorchKernelShared.Constants", "nil", "Workspace.Lobby"]);
	});

	test("a shrinking kernel keeps referents dense: the game's highest ids move into the gaps, references follow", async () => {
		const { bytes, report } = patch("game-installed.rbxl", "kernel-v3.rbxl");
		expect(report.instances).toEqual({ before: 40, after: 35, removed: 12, added: 7 });
		expect(report.movedReferents).toBe(3);
		expect(report.references.remapped).toHaveLength(1);
		expect(report.references.cleared).toHaveLength(1);
		expect(isDense(bytes)).toBe(true);
		expect(verifyPatch(fixture("game-installed.rbxl"), bytes, fixture("kernel-v3.rbxl"), SLOTS).ok).toBe(true);
		save("installed+v3.rbxl", bytes);
		// Moved game instances keep every property (Lune: equal subtrees) and every reference to them (RefGame -> Lobby).
		const checked = await luneVerify("game-installed.rbxl", "installed+v3.rbxl", "kernel-v3.rbxl");
		expect(checked.problems).toEqual([]);
		expect(checked.references).toEqual(["Workspace.RefApi.Value: ServerScriptService.TypeTorchKernel.Api -> nil"]);
	});

	test("re-patching with the same kernel changes nothing outside the slots and no script", () => {
		const { bytes, report } = patch("game+v1.rbxl", "kernel-v1.rbxl");
		expect(report.slots.every((s) => s.scripts.changed.length === 0 && s.scripts.added.length === 0 && s.scripts.removed.length === 0)).toBe(true);
		expect(report.settings.every((s) => !s.changed)).toBe(true);
		expect(verifyPatch(fixture("game+v1.rbxl"), bytes, fixture("kernel-v1.rbxl"), SLOTS).ok).toBe(true);
	});

	test("the verifiers catch a patch of the wrong place", async () => {
		// game+v1 was made from game.rbxl, not from game-installed.rbxl (which has more Workspace content).
		const verification = verifyPatch(fixture("game-installed.rbxl"), fixture("game+v1.rbxl"), fixture("kernel-v1.rbxl"), SLOTS);
		expect(verification.ok).toBe(false);
		expect(verification.problems[0]).toMatch(/instances outside the slots changed/);
		const checked = await luneVerify("game-installed.rbxl", "game+v1.rbxl", "kernel-v1.rbxl");
		expect(checked.ok).toBe(false);
	});

	test("the Lune engine patches too (whole-place re-encode), and both verifiers accept it here", async () => {
		const spec = save("spec.json", new TextEncoder().encode(JSON.stringify({ slots: SLOTS, settings: SETTINGS })));
		const result = await runLunePatch(lune, dir, script, { original: join(dir, "game-installed.rbxl"), kernel: join(dir, "kernel-v2.rbxl"), spec, out: join(dir, "lune-engine.rbxl") });
		expect(result).toEqual({ removed: 7 + 3 + 2, added: 7 + 3 + 1 });
		const verification = verifyPatch(fixture("game-installed.rbxl"), fixture("lune-engine.rbxl"), fixture("kernel-v2.rbxl"), SLOTS);
		expect(verification.droppedProps).toEqual([]);
		const checked = await luneVerify("game-installed.rbxl", "lune-engine.rbxl", "kernel-v2.rbxl");
		expect(checked.slots.every((s) => s.equal)).toBe(true);
		// The Lune engine destroys the old kernel: both references into it become nil.
		expect(checked.references.sort()).toEqual(["Workspace.RefApi.Value: ServerScriptService.TypeTorchKernel.Api -> nil", "Workspace.RefConstants.Value: ReplicatedStorage.TypeTorchKernelShared.Constants -> nil"]);
	});

	test("the summary names the slots, settings, references and output", () => {
		const original = fixture("game-installed.rbxl");
		const { bytes, report } = patch("game-installed.rbxl", "kernel-v2.rbxl");
		const ts = verifyPatch(original, bytes, fixture("kernel-v2.rbxl"), SLOTS);
		const lines = summaryLines({
			where: "universe 1, place 2",
			base: { version: 15, published: true, skipped: [], source: "downloaded", bytes: original.length, seconds: 0.4 },
			backup: ".typetorch/place-backups/2-v15.rbxl",
			before: summarizePlace(new PlaceFile(original), SLOTS),
			engine: "splice",
			report,
			newKernel: report.newKernel,
			ts,
			lune: { ok: true, problems: [], references: [], stats: { services: 6, subtrees: 12, instances: 30, explicitDefaults: 0 }, addedServices: [], slots: [], settings: [], identity: {} },
			output: { path: ".typetorch/place-patches/2-v15-kernel-1.1.0.rbxl", bytes: bytes.length },
		}).join("\n");
		expect(lines).toContain("base      v15 (published)  downloaded");
		expect(lines).toContain("restore: typetorch kernel restore .typetorch/place-backups/2-v15.rbxl");
		expect(lines).toMatch(/kernel\s+1\.0\.0 \(hash 111111111111\) -> 1\.1\.0 \(hash 111111111111\)/);
		expect(lines).toMatch(/~ ServerScriptService\.TypeTorchKernel\s+7 -> 7 instances; changed: Kernel \(Script\); added: Extra \(ModuleScript\); removed: Api \(ModuleScript\)/);
		expect(lines).toContain("2 copies replaced by one");
		expect(lines).toContain("HttpService.HttpEnabled false -> true");
		expect(lines).toContain("into the old kernel: 1 re-pointed by path, 1 cleared");
		expect(lines).toMatch(/outside\s+\d+ instances outside the slots, unchanged/);
		expect(lines).toMatch(/engine\s+splice: \d+ of \d+ chunks copied byte for byte; re-encoded: /);
	});
});

describe("splice engine refusals", () => {
	test("a value type it can't move, in a class the kernel uses, is refused (use --engine lune)", () => {
		// A place with a Folder slot whose class also carries a CFrame-typed property chunk.
		const place = writeRbxm([
			{ className: "ServerScriptService", name: "ServerScriptService", parent: -1 },
			{ className: "Folder", name: "TypeTorchKernel", parent: 0 },
			{ className: "Folder", name: "GameFolder", parent: 0 },
		]);
		const { chunks } = rawChunks(place);
		const prnt = chunks.find((c) => c.name === "PRNT")!;
		const weird = new Uint8Array([1, 0, 0, 0, 5, 0, 0, 0, ...new TextEncoder().encode("Weird"), 0x10, 0, 0]);
		const tampered = new Uint8Array([...place.subarray(0, prnt.start), ...encodeChunk("PROP", weird, "none"), ...place.subarray(prnt.start)]);
		const kernel = writeRbxm([
			{ className: "ServerScriptService", name: "ServerScriptService", parent: -1 },
			{ className: "Folder", name: "TypeTorchKernel", parent: 0 },
		]);
		expect(() => patchPlace({ original: tampered, kernel, slots: [SLOTS[0]], serviceProps: [], seed: "s" })).toThrow(PlacePatchError);
		expect(() => patchPlace({ original: tampered, kernel, slots: [SLOTS[0]], serviceProps: [], seed: "s" })).toThrow(/Folder\.Weird \(CFrame\)/);
		// Without a kernel slot in the build, the patch refuses before touching anything.
		expect(() => patchPlace({ original: place, kernel, slots: SLOTS, serviceProps: [], seed: "s" })).toThrow(/the kernel build has 0 ReplicatedStorage\.TypeTorchKernelShared/);
	});
	test("models made by the CLI's own writer patch cleanly (no Lune needed)", () => {
		const place = writeRbxm([
			{ className: "ServerScriptService", name: "ServerScriptService", parent: -1 },
			{ className: "Folder", name: "TypeTorchKernel", parent: 0, attributes: { KernelVersion: "0.1.0" } },
			{ className: "Folder", name: "Old", parent: 1 },
			{ className: "Folder", name: "GameFolder", parent: 0, attributes: { Keep: true } },
		]);
		const kernel = writeRbxm([
			{ className: "ServerScriptService", name: "ServerScriptService", parent: -1 },
			{ className: "Folder", name: "TypeTorchKernel", parent: 0, attributes: { KernelVersion: "0.2.0" } },
		]);
		const { bytes, report } = patchPlace({ original: place, kernel, slots: [SLOTS[0]], serviceProps: [], seed: "s" });
		expect(report.oldKernel.version).toBe("0.1.0");
		expect(report.newKernel.version).toBe("0.2.0");
		expect(report.slots[0]).toMatchObject({ before: 2, after: 1, copies: 1 });
		const instances = readRbxm(bytes);
		expect(instances.map((i) => `${i.className}:${i.name}`).sort()).toEqual(["Folder:GameFolder", "Folder:TypeTorchKernel", "ServerScriptService:ServerScriptService"]);
		expect(instances.find((i) => i.name === "GameFolder")!.attributes).toEqual({ Keep: true });
		expect(isDense(bytes)).toBe(true);
		expect(verifyPatch(place, bytes, kernel, [SLOTS[0]]).ok).toBe(true);
	});
});
