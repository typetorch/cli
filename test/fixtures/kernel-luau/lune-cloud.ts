/**
 * Test helpers for the luau engine (test/kernel-luau.test.ts, test/backup-refresh.test.ts): the kernel-patch fixture
 * places made with Lune in a temp dir, the kernel slots .rbxm files (make-slots.luau), the harness that runs a task
 * script against a mock DataModel (harness.luau), and a fake Open Cloud whose Luau Execution tasks run in that harness
 * (a save writes a new place version). No network. `hasLune` is false when Lune can't run (the tests skip then).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LuauCloud, LuauDeps } from "../../../src/kernel-luau";
import { captureJson, setOutputMode } from "../../../src/log";
import type { PlaceVersion } from "../../../src/opencloud";

export const dir = mkdtempSync(join(tmpdir(), "tt-kluau-"));
export const lune = process.env.TYPETORCH_LUNE || "lune";
const fixtures = resolve(import.meta.dir, "..");
writeFileSync(join(dir, "rokit.toml"), '[tools]\nlune = "lune-org/lune@0.10.5"\n');
const made = Bun.spawnSync([lune, "run", join(fixtures, "kernel-patch", "make-fixtures.luau"), dir], { cwd: dir, stdout: "pipe", stderr: "pipe" });
export const hasLune = made.exitCode === 0;
if (!hasLune) console.warn(`luau engine Lune tests skipped: Lune didn't run (${made.stderr.toString().trim().split(/\r?\n/)[0]})`);

export const place = (name: string) => join(dir, name);

/** The slots .rbxm of a kernel fixture place (`extra`: plus a non-slot, which the task refuses). */
export function slotsFile(kernel: string, extra = false): string {
	const out = join(dir, `${kernel}${extra ? "-extra" : ""}.slots.rbxm`);
	if (!existsSync(out)) {
		const r = Bun.spawnSync([lune, "run", join(fixtures, "kernel-luau", "make-slots.luau"), join(dir, `${kernel}.rbxl`), out, ...(extra ? ["extra"] : [])], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	}
	return out;
}

/** A backup-only slots .rbxm: ServerStorage.TypeTorchBackup, a prod payload stamped BackupArtifactId = artifactId. */
export function backupSlotsFile(artifactId: string): string {
	const out = join(dir, `backup-${artifactId}.slots.rbxm`);
	if (!existsSync(out)) {
		const r = Bun.spawnSync([lune, "run", join(fixtures, "kernel-luau", "make-slots.luau"), "-", out, "backup", artifactId], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	}
	return out;
}

let runs = 0;
export const nextRun = () => ++runs;

export interface HarnessOptions {
	placeId?: number;
	placeVersion?: number;
	saveError?: string;
	denySetting?: string;
	tamperOnSetting?: boolean;
	noEncoding?: boolean;
	unstableBytes?: boolean;
}

/** Runs a task script in the harness; returns the result, the engine calls, and the saved place (if any). */
export function harness(script: string, placePath: string, input: string | undefined, options: HarnessOptions = {}): { result: any; calls: any; saved?: string } {
	const n = nextRun();
	const scriptPath = join(dir, `task-${n}.luau`);
	const out = join(dir, `out-${n}.json`);
	const saved = join(dir, `saved-${n}.rbxl`);
	writeFileSync(scriptPath, script);
	writeFileSync(join(dir, `opts-${n}.json`), JSON.stringify({ placeId: 2, placeVersion: 57, ...options }));
	const r = Bun.spawnSync([lune, "run", join(fixtures, "kernel-luau", "harness.luau"), scriptPath, placePath, input ?? "-", join(dir, `opts-${n}.json`), out, saved], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`harness failed: ${r.stderr.toString()}`);
	const parsed = JSON.parse(readFileSync(out, "utf8"));
	return { result: parsed.result, calls: parsed.calls, saved: existsSync(saved) ? saved : undefined };
}

export interface FakeOptions extends HarnessOptions {
	/** The newest version jumps to this right after the check task (someone published). */
	raceTo?: number;
	/** The save task answers FAILED with this error instead of running. */
	failSave?: { code: string; message: string };
}

export type TaskKind = "check" | "save" | "verify" | "restore-check" | "restore-save";

/** A fake Open Cloud: versions 57 (published) and 56; tasks run in the harness on the version's place file. */
export function fakeCloud(basePlace: string, options: FakeOptions = {}) {
	const versions: PlaceVersion[] = [
		{ version: 57, published: true, hasPublishedField: true },
		{ version: 56, published: false, hasPublishedField: false },
	];
	const places = new Map<number, string>([
		[57, basePlace],
		[56, basePlace],
	]);
	const inputs = new Map<string, Uint8Array>();
	const tasks: { script: string; version?: number; binaryInput?: string; kind: TaskKind }[] = [];
	const createdInputs: number[] = [];
	const newest = () => Math.max(...versions.map((v) => v.version));
	const oc: LuauCloud = {
		async placeVersions() {
			return [...versions].sort((a, b) => b.version - a.version);
		},
		async latestPlaceVersion() {
			return newest();
		},
		async createBinaryInput(universeId, size) {
			createdInputs.push(size);
			return { path: `universes/${universeId}/luau-execution-session-task-binary-inputs/in${createdInputs.length}`, uploadUri: `https://upload.test.invalid/in${createdInputs.length}?sig=not-real` };
		},
		async uploadBinaryInput(uri, bytes) {
			inputs.set(new URL(uri).pathname.slice(1), bytes);
		},
		async runLuau(_universeId, _placeId, script, _timeout, opts = {}) {
			const kind: TaskKind = script.includes("kernel restore")
				? script.includes("SavePlaceAsync")
					? "restore-save"
					: "restore-check"
				: script.includes('["mode"] = "save"')
					? "save"
					: script.includes('["mode"] = "verify"')
						? "verify"
						: "check";
			tasks.push({ script, version: opts.version, binaryInput: opts.binaryInput, kind });
			const path = `universes/1/places/2/versions/${opts.version}/luau-execution-sessions/s/tasks/t${tasks.length}`;
			if (kind === "save" && options.failSave) return { state: "FAILED", results: [], error: options.failSave, path };
			let input: string | undefined;
			if (opts.binaryInput) {
				input = join(dir, `fake-input-${nextRun()}.rbxm`);
				writeFileSync(input, inputs.get(opts.binaryInput.split("/").pop()!)!);
			}
			const run = harness(script, places.get(opts.version!)!, input, { ...options, placeVersion: opts.version });
			if (run.result?.saved && run.saved) {
				const next = newest() + 1;
				versions.push({ version: next, published: true, hasPublishedField: true });
				places.set(next, run.saved);
			}
			if (kind === "check" && options.raceTo) versions.push({ version: options.raceTo, published: true, hasPublishedField: true });
			return { state: "COMPLETE", results: [run.result], path };
		},
		async taskLogs() {
			return ["log line"];
		},
	};
	return { oc, tasks, versions, places, createdInputs, inputs };
}

/** Engine deps with a fake clock (waits pass at once), recording y/N questions and kernel-deploys records. */
export function makeDeps(oc: LuauCloud, patch: Partial<LuauDeps> = {}): LuauDeps & { records: any[]; asked: string[] } {
	const records: any[] = [];
	const asked: string[] = [];
	let clock = 0;
	return {
		oc,
		interactive: true,
		confirm: async (question) => {
			asked.push(question);
			return true;
		},
		record: (entry) => records.push(entry),
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		findVersionSeconds: 0,
		records,
		asked,
		...patch,
	};
}

/** Runs fn in --json mode; returns its value or error and the one JSON document it emitted. */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ value?: T; json: any; error?: Error }> {
	setOutputMode({ json: true, verbose: false });
	let value: T | undefined;
	let error: Error | undefined;
	const json = await captureJson(async () => {
		try {
			value = await fn();
		} catch (e) {
			error = e as Error;
		}
	});
	return { value, json, error };
}
