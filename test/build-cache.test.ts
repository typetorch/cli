import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceCandidates } from "../src/build";
import { BUILD_CACHE_DIR, buildCacheEnabled, cacheUnsupported, removeStrayBuildInfo, restoreBuildCache, saveBuildCache } from "../src/build-cache";
import { Settings, useSettings } from "../src/env";

afterEach(() => useSettings(undefined));

function project(compilerOptions: Record<string, unknown> = { incremental: true, tsBuildInfoFile: "out/tsconfig.tsbuildinfo" }) {
	const root = mkdtempSync(join(tmpdir(), "tt-cache-"));
	const layout = { rootDir: join(root, "src"), outDir: join(root, "out") };
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "out", ...compilerOptions } }));
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(join(root, "bun.lock"), "lock v1");
	mkdirSync(join(root, "src", "server"), { recursive: true });
	mkdirSync(join(root, "out", "server"), { recursive: true });
	writeFileSync(join(root, "src", "server", "boot.ts"), "export {};\n");
	writeFileSync(join(root, "src", "server", "old.ts"), "export {};\n");
	writeFileSync(join(root, "out", "server", "boot.luau"), "return 1\n");
	writeFileSync(join(root, "out", "server", "old.luau"), "return 2\n");
	writeFileSync(join(root, "out", "tsconfig.tsbuildinfo"), '{"version":"5.5.3"}');
	return { root, layout };
}

const clean = (outDir: string) => rmSync(outDir, { recursive: true, force: true });

describe("build cache", () => {
	test("a clean build gets the last checked out/ back, tsbuildinfo included", () => {
		const { root, layout } = project();
		expect(saveBuildCache(root, layout, "dev")).toBe(3);
		clean(layout.outDir);
		const result = restoreBuildCache(root, layout, "dev", sourceCandidates);
		expect(result).toEqual({ restored: true, files: 3, pruned: [] });
		expect(readFileSync(join(layout.outDir, "server", "boot.luau"), "utf8")).toBe("return 1\n");
		expect(existsSync(join(layout.outDir, "tsconfig.tsbuildinfo"))).toBe(true);
	});

	test("each channel has its own cache (prod never gets dev outputs)", () => {
		const { root, layout } = project();
		saveBuildCache(root, layout, "dev");
		clean(layout.outDir);
		expect(restoreBuildCache(root, layout, "prod", sourceCandidates)).toEqual({ restored: false, reason: "no cache yet" });
		expect(existsSync(layout.outDir)).toBe(false);
	});

	test("a changed tsconfig, package.json or lockfile drops the cache", () => {
		for (const file of ["tsconfig.json", "package.json", "bun.lock"]) {
			const { root, layout } = project();
			saveBuildCache(root, layout, "dev");
			writeFileSync(join(root, file), `${readFileSync(join(root, file), "utf8")} `);
			clean(layout.outDir);
			const result = restoreBuildCache(root, layout, "dev", sourceCandidates);
			expect(result.restored).toBe(false);
			expect(existsSync(join(root, BUILD_CACHE_DIR, "dev"))).toBe(false);
			expect(existsSync(layout.outDir)).toBe(false);
		}
	});

	test("an edited, added or missing cached file drops the whole cache", () => {
		const files = (root: string) => join(root, BUILD_CACHE_DIR, "dev", "files");
		const edits: ((root: string) => void)[] = [
			(root) => writeFileSync(join(files(root), "server", "boot.luau"), "return 666\n"),
			(root) => writeFileSync(join(files(root), "server", "stray.luau"), "return 3\n"),
			(root) => rmSync(join(files(root), "server", "old.luau")),
		];
		for (const edit of edits) {
			const { root, layout } = project();
			saveBuildCache(root, layout, "dev");
			edit(root);
			clean(layout.outDir);
			expect(restoreBuildCache(root, layout, "dev", sourceCandidates).restored).toBe(false);
			expect(existsSync(layout.outDir)).toBe(false);
		}
	});

	test("outputs whose source was deleted are removed (rbxtsc never deletes them)", () => {
		const { root, layout } = project();
		saveBuildCache(root, layout, "dev");
		rmSync(join(root, "src", "server", "old.ts"));
		clean(layout.outDir);
		const result = restoreBuildCache(root, layout, "dev", sourceCandidates);
		expect(result).toEqual({ restored: true, files: 3, pruned: ["server/old.luau"] });
		expect(existsSync(join(layout.outDir, "server", "old.luau"))).toBe(false);
	});

	test("projects rbxtsc can't build incrementally are not cached", () => {
		const ok = project();
		expect(cacheUnsupported(ok.root, ok.layout)).toBeUndefined();
		const plain = project({});
		expect(cacheUnsupported(plain.root, plain.layout)).toContain("incremental");
		const outside = project({ incremental: true, tsBuildInfoFile: "tsconfig.tsbuildinfo" });
		expect(cacheUnsupported(outside.root, outside.layout)).toContain("outside outDir");
	});

	test("a tsbuildinfo outside outDir goes with the clean, so rbxtsc can't skip the deleted outputs", () => {
		const { root, layout } = project({ incremental: true, tsBuildInfoFile: "cache/tsconfig.tsbuildinfo" });
		mkdirSync(join(root, "cache"));
		writeFileSync(join(root, "cache", "tsconfig.tsbuildinfo"), "{}");
		removeStrayBuildInfo(root, layout);
		expect(existsSync(join(root, "cache", "tsconfig.tsbuildinfo"))).toBe(false);
	});

	test("TYPETORCH_BUILD_CACHE=0 turns it off", () => {
		useSettings(new Settings({ startDir: tmpdir(), env: { TYPETORCH_BUILD_CACHE: "0" } }));
		expect(buildCacheEnabled()).toBe(false);
		useSettings(new Settings({ startDir: tmpdir(), env: {} }));
		expect(buildCacheEnabled()).toBe(true);
	});
});
