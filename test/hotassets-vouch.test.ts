/**
 * Hot assets across place saves (src/hotassets-vouch.ts; the 2026-10-13 incident and its recurrence through
 * `typetorch kernel deploy`): the outcome rules, the notes the commands print, and a guard that every CLI path that
 * publishes the place handles the lockfile. The Lune-backed flows are in kernel-luau.test.ts and backup-refresh.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ASSETS_LOCK_FILE } from "../src/assets";
import { fileAssetsNote, hotAssetsInput } from "../src/commands/kernel";
import type { Project } from "../src/config";
import { assetsMismatch, assetsNote, backupAssets, noBackupToVouch, publishedAssets } from "../src/hotassets-vouch";

const err = console.error;
const log = console.log;
function captured(fn: () => void): string {
	const lines: string[] = [];
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	try {
		fn();
	} finally {
		console.error = err;
		console.log = log;
	}
	return lines.join("\n");
}
afterEach(() => {
	console.error = err;
	console.log = log;
});

describe("the outcome of a save", () => {
	test("kept only when the save stamped, landed on the version it named, and the verify task found the stamp", () => {
		const stamped = { holds: true, lockPlaceVersion: 57, savedAs: 58 };
		expect(backupAssets(57, 57, stamped, 58)).toEqual({ kept: true, lockPlaceVersion: 57 });
		expect(backupAssets(57, 57, stamped, 58, false)).toMatchObject({ kept: false, reason: expect.stringContaining("found no HotAssetsSavedAs = 58 on v58's backup") });
		expect(backupAssets(57, 57, stamped, 59)).toMatchObject({ kept: false, reason: expect.stringContaining("the save became v59, not v58") });
		expect(backupAssets(57, 57, stamped, undefined)).toMatchObject({ kept: false, reason: expect.stringContaining("isn't known") });
	});

	test("no claim: a lock for another version, or no backup in the saved place to carry one", () => {
		expect(backupAssets(50, 57, { holds: false }, 58)).toEqual({ kept: false, lockPlaceVersion: 50, reason: assetsMismatch(50, 57) });
		expect(backupAssets(57, 57, undefined, 58)).toEqual({ kept: false, lockPlaceVersion: 57, reason: noBackupToVouch(57) });
	});

	test("a place file publish never vouches: kept only if the lock already names the new version", () => {
		expect(publishedAssets(58, 58)).toEqual({ kept: true, lockPlaceVersion: 58 });
		expect(publishedAssets(57, 58)).toMatchObject({ kept: false, reason: expect.stringContaining("the place is now v58 and the hot-asset lock") });
		expect(publishedAssets(57, null)).toMatchObject({ kept: false, reason: expect.stringContaining("the place is now a new version") });
	});

	test("the note: a warning naming the fix for the project's branch; a plain line when kept", () => {
		const warned = captured(() => assetsNote(backupAssets(57, 57, undefined, 58), "prod"));
		expect(warned).toContain("warning: hot assets: no backup build is in the saved place");
		expect(warned).toContain("Fix: typetorch assets sync --deploy prod");
		const kept = captured(() => assetsNote({ kept: true, lockPlaceVersion: 57 }, "prod"));
		expect(kept).toContain("keep adopting the place's copies (lock v57");
		expect(kept).not.toContain("warning");
		expect(captured(() => assetsNote(undefined, "prod"))).toBe("");
	});
});

describe("kernel commands read the lock", () => {
	const projectAt = (lock?: number): Project => {
		const root = mkdtempSync(join(tmpdir(), "tt-vouch-"));
		if (lock !== undefined) writeFileSync(join(root, ASSETS_LOCK_FILE), JSON.stringify({ v: 1, placeVersion: lock, assets: {} }));
		return { root, configPath: join(root, "typetorch.json"), config: { defaultBranch: "main" } as Project["config"], warnings: [] };
	};

	test("hotAssetsInput: the lock's placeVersion and the default branch; none without a lockfile", () => {
		expect(hotAssetsInput(projectAt(57))).toEqual({ lockPlaceVersion: 57, branch: "main" });
		expect(hotAssetsInput(projectAt())).toBeUndefined();
	});

	test("after a place file publish (--place-file, --replace-place, restore <file>): the warning with the fix", () => {
		const out = captured(() => fileAssetsNote(projectAt(57), 58));
		expect(out).toContain("the place is now v58 and the hot-asset lock (typetorch.assets.lock.json) is for v57");
		expect(out).toContain("Fix: typetorch assets sync --deploy main");
		expect(captured(() => fileAssetsNote(projectAt(), 58))).toBe("");
	});
});

// A new command that publishes the place must handle the lock too (the recurrence: kernel deploy saved without it).
describe("every path that publishes the place handles the hot-asset lock", () => {
	const src = join(import.meta.dir, "..", "src");
	const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));
	const sources = files(src).map((path) => ({ path: relative(src, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));
	const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

	test("place file publishes (Open Cloud publishPlace) all print the lock's outcome", () => {
		const callers = sources.filter((s) => s.path !== "opencloud.ts" && /\.publishPlace\(/.test(s.text));
		expect(callers.map((s) => s.path)).toEqual(["commands/kernel.ts"]);
		const kernel = callers[0].text;
		expect(count(kernel, /\.publishPlace\(/g)).toBe(3);
		expect(count(kernel, /fileAssetsNote\(proj, after\)/g)).toBe(count(kernel, /\.publishPlace\(/g));
	});

	test("SavePlaceAsync saves (kernel task mode save, restore task save) all pass the lock and judge the stamp", () => {
		const savers = sources.filter((s) => /mode: "save"|save: true/.test(s.text)).map((s) => s.path);
		expect(savers.sort()).toEqual(["commands/backup.ts", "kernel-luau.ts"]);
		for (const path of savers) {
			const text = sources.find((s) => s.path === path)!.text;
			expect(text).toContain("backupAssets(");
			expect(text).toMatch(/assets: \{ lockPlaceVersion: [^,]+, savedAs: [a-z.]*newest \+ 1 \}/);
		}
		// Both luau saves in kernel-luau.ts (deploy and restore) build their config with the lock.
		const luau = sources.find((s) => s.path === "kernel-luau.ts")!.text;
		expect(count(luau, /savedAs: [a-z.]*newest \+ 1/g)).toBe(2);
		expect(count(luau, /stampFound/g)).toBeGreaterThanOrEqual(3);
		const kernelCommand = sources.find((s) => s.path === "commands/kernel.ts")!.text;
		expect(count(kernelCommand, /assets: hotAssetsInput\(proj\)/g)).toBe(2);
	});
});
