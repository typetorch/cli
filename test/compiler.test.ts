import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildError, buildCompiler, compileCommand, sourceCandidates } from "../src/build";
import { BUILD_CACHE_VERSION, buildCacheKey, restoreBuildCache, saveBuildCache } from "../src/build-cache";
import { compilerChecks } from "../src/commands/doctor";
import {
	compilerVersion,
	gobloxBin,
	gobloxBinNames,
	pluginsIgnoredByGoblox,
	resolveCompiler,
	scriptCompiler,
	scriptEndsWith,
	type ResolvedCompiler,
} from "../src/compiler";
import { validateConfig } from "../src/config";
import { STRIP_TRANSFORMER_VERSION } from "../src/debug-macros";
import { Settings, useSettings } from "../src/env";

// No TYPETORCH_COMPILER from the machine running the tests.
beforeEach(() => useSettings(new Settings({ startDir: tmpdir(), env: {} })));
afterEach(() => useSettings(undefined));

function game(options: { goblox?: string | false; robloxTs?: boolean; scripts?: Record<string, string>; config?: Record<string, unknown> } = {}) {
	const root = mkdtempSync(join(tmpdir(), "tt-compiler-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: options.scripts ?? {} }));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "out", incremental: true } }));
	writeFileSync(join(root, "bun.lock"), "lock v1");
	if (options.config) writeFileSync(join(root, "typetorch.json"), JSON.stringify(options.config));
	if (options.robloxTs !== false) {
		mkdirSync(join(root, "node_modules", "roblox-ts"), { recursive: true });
		writeFileSync(join(root, "node_modules", "roblox-ts", "package.json"), JSON.stringify({ version: "3.0.0" }));
	}
	if (options.goblox !== undefined && options.goblox !== false) {
		mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", ".bin", options.goblox), "");
	}
	return root;
}

const RBXTSC: ResolvedCompiler = { name: "rbxtsc", reason: "default" };
const GOBLOX: ResolvedCompiler = { name: "goblox", reason: "test" };

describe("compiler resolution", () => {
	test("without goblox: rbxtsc, as before", () => {
		expect(resolveCompiler(game(), { env: undefined })).toEqual({ name: "rbxtsc", reason: "default" });
	});

	test("goblox installed: picked automatically", () => {
		const resolved = resolveCompiler(game({ goblox: "goblox" }), { env: undefined });
		expect(resolved.name).toBe("goblox");
		expect(resolved.problem).toBeUndefined();
		expect(resolved.reason).toContain("node_modules/.bin/goblox");
	});

	test('typetorch.json "compiler" wins over auto-detection, read from the root by default', () => {
		expect(resolveCompiler(game({ goblox: "goblox" }), { env: undefined, configured: "rbxtsc" })).toEqual({ name: "rbxtsc", reason: 'typetorch.json "compiler"' });
		expect(resolveCompiler(game({ goblox: "goblox", config: { compiler: "rbxtsc" } }), { env: undefined }).name).toBe("rbxtsc");
		expect(resolveCompiler(game({ goblox: "goblox" }), { env: undefined, configured: "goblox" }).name).toBe("goblox");
	});

	test("TYPETORCH_COMPILER wins over everything (from the settings layer)", () => {
		expect(resolveCompiler(game({ goblox: "goblox" }), { env: "rbxtsc", configured: "goblox" })).toEqual({ name: "rbxtsc", reason: "TYPETORCH_COMPILER" });
		expect(resolveCompiler(game({ goblox: "goblox" }), { env: "goblox", configured: "rbxtsc" }).name).toBe("goblox");
		useSettings(new Settings({ env: { TYPETORCH_COMPILER: "rbxtsc" }, startDir: tmpdir() }));
		expect(resolveCompiler(game({ goblox: "goblox" }), { configured: "goblox" }).name).toBe("rbxtsc");
		useSettings(new Settings({ env: { TYPETORCH_COMPILER: "" }, startDir: tmpdir() }));
		expect(resolveCompiler(game({ goblox: "goblox" }), { configured: "rbxtsc" }).name).toBe("rbxtsc"); // empty = unset
	});

	test("goblox requested but not installed: a BuildError naming the install command", () => {
		for (const options of [{ env: "goblox" }, { env: undefined, configured: "goblox" }]) {
			const resolved = resolveCompiler(game(), options);
			expect(resolved.problem).toContain("compiler goblox was requested");
			expect(resolved.problem).toContain("`bun add -d goblox`");
			expect(() => buildCompiler(game(), options)).toThrow(BuildError);
		}
		expect(() => buildCompiler(game(), { env: "goblox" })).toThrow(/bun add -d goblox/);
	});

	test("unknown values are refused (env and typetorch.json)", () => {
		expect(() => buildCompiler(game(), { env: "tsc" })).toThrow(/TYPETORCH_COMPILER must be one of goblox, rbxtsc/);
		expect(() => buildCompiler(game(), { env: undefined, configured: 3 })).toThrow(/typetorch.json "compiler" must be one of goblox, rbxtsc/);
		const base = { project: "g", universeId: 1, placeId: 2, creator: { userId: 3 } };
		expect(validateConfig({ ...base, compiler: "swc" }).errors).toEqual(['"compiler" must be one of goblox, rbxtsc (got "swc")']);
		expect(validateConfig({ ...base, compiler: "goblox" }).config?.compiler).toBe("goblox");
		const plain = validateConfig(base);
		expect(plain.config && "compiler" in plain.config).toBe(false);
		expect(plain.warnings).toEqual([]);
	});

	test("Windows bin names: goblox.exe (bun) and goblox.cmd (npm)", () => {
		expect(gobloxBinNames("linux")).toEqual(["goblox"]);
		expect(gobloxBinNames("win32")).toEqual(["goblox.exe", "goblox.cmd", "goblox"]);
		for (const name of ["goblox.exe", "goblox.cmd"]) {
			const root = game({ goblox: name });
			expect(gobloxBin(root, "win32")).toBe(join(root, "node_modules", ".bin", name));
			expect(gobloxBin(root, "linux")).toBeUndefined();
			expect(resolveCompiler(root, { env: undefined, platform: "win32" }).name).toBe("goblox");
			expect(resolveCompiler(root, { env: undefined, platform: "linux" }).name).toBe("rbxtsc");
		}
	});

	test("compilerVersion: the package's version (goblox, else the @typetorch/goblox alias; roblox-ts for rbxtsc)", () => {
		const root = game({ goblox: "goblox" });
		expect(compilerVersion(root, "rbxtsc")).toBe("3.0.0");
		mkdirSync(join(root, "node_modules", "@typetorch", "goblox"), { recursive: true });
		writeFileSync(join(root, "node_modules", "@typetorch", "goblox", "package.json"), JSON.stringify({ version: "0.0.9" }));
		expect(compilerVersion(root, "goblox")).toBe("0.0.9");
		mkdirSync(join(root, "node_modules", "goblox"), { recursive: true });
		writeFileSync(join(root, "node_modules", "goblox", "package.json"), JSON.stringify({ version: "0.1.0" }));
		expect(compilerVersion(root, "goblox")).toBe("0.1.0");
	});
});

describe("build scripts", () => {
	test("-p can be appended only to build scripts that end with the compiler", () => {
		for (const name of ["rbxtsc", "goblox"] as const) {
			expect(scriptEndsWith(name, name)).toBe(true);
			expect(scriptEndsWith(`bun scripts/build-info.ts && ${name}`, name)).toBe(true);
			expect(scriptEndsWith(`bun x.ts && ${name} --verbose`, name)).toBe(true);
			expect(scriptEndsWith(`bunx ${name} -p tsconfig.json`, name)).toBe(true);
			expect(scriptEndsWith(`${name} && bun post.ts`, name)).toBe(false);
			expect(scriptEndsWith("bun scripts/build.ts", name)).toBe(false);
		}
		expect(scriptEndsWith("goblox", "rbxtsc")).toBe(false);
		expect(scriptEndsWith("rbxtsc", "goblox")).toBe(false);
		expect(scriptCompiler("bun x.ts && goblox --verbose")).toBe("goblox");
		expect(scriptCompiler("rbxtsc")).toBe("rbxtsc");
		expect(scriptCompiler("bun scripts/build.ts")).toBeUndefined();
	});

	test("rbxtsc: the same commands as before goblox", () => {
		expect(compileCommand(game({ scripts: { build: "rbxtsc" } }), undefined, RBXTSC)).toEqual(["bun", "run", "build"]);
		expect(compileCommand(game({ scripts: { build: "rbxtsc" } }), ".tsconfig.typetorch.json", RBXTSC)).toEqual(["bun", "run", "build", "-p", ".tsconfig.typetorch.json"]);
		expect(compileCommand(game({ scripts: { build: "bun scripts/build.ts" } }), undefined, RBXTSC)).toEqual(["bun", "run", "build"]);
		expect(compileCommand(game({ scripts: { build: "bun scripts/build.ts" } }), "p.json", RBXTSC)).toEqual(["bun", "run", "rbxtsc", "-p", "p.json"]);
		expect(compileCommand(game(), "p.json", RBXTSC)).toEqual(["bun", "run", "rbxtsc", "-p", "p.json"]);
		expect(compileCommand(game())).toEqual(["bun", "run", "rbxtsc"]); // resolved by default: no goblox here
		expect(() => compileCommand(game({ robloxTs: false }), undefined, RBXTSC)).toThrow(/roblox-ts is not installed/);
	});

	test("goblox: a script ending with goblox takes -p; one ending with rbxtsc is bypassed", () => {
		expect(compileCommand(game({ goblox: "goblox", scripts: { build: "bun x.ts && goblox" } }), "p.json", GOBLOX)).toEqual(["bun", "run", "build", "-p", "p.json"]);
		expect(compileCommand(game({ goblox: "goblox", scripts: { build: "goblox" } }), undefined, GOBLOX)).toEqual(["bun", "run", "build"]);
		expect(compileCommand(game({ goblox: "goblox", scripts: { build: "rbxtsc" } }), undefined, GOBLOX)).toEqual(["bun", "run", "goblox"]);
		expect(compileCommand(game({ goblox: "goblox", scripts: { build: "rbxtsc" } }), "p.json", GOBLOX)).toEqual(["bun", "run", "goblox", "-p", "p.json"]);
		expect(compileCommand(game({ goblox: "goblox", scripts: { build: "bun scripts/build.ts" } }), "p.json", GOBLOX)).toEqual(["bun", "run", "goblox", "-p", "p.json"]);
		expect(compileCommand(game({ goblox: "goblox", robloxTs: false }), undefined, GOBLOX)).toEqual(["bun", "run", "goblox"]); // no roblox-ts check
		expect(compileCommand(game({ goblox: "goblox" }))).toEqual(["bun", "run", "goblox"]); // auto-detected
		// rbxtsc forced while the script ends with goblox: rbxtsc runs directly.
		expect(compileCommand(game({ goblox: "goblox", scripts: { build: "goblox" } }), undefined, RBXTSC)).toEqual(["bun", "run", "rbxtsc"]);
	});
});

describe("build cache key", () => {
	const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
	/** The key exactly as CLI 0.15.0 computed it (before goblox). */
	function keyBeforeGoblox(root: string, channel: string): string {
		const parts = [`v${BUILD_CACHE_VERSION}`, `channel ${channel}`, `strip ${STRIP_TRANSFORMER_VERSION}`];
		for (const file of ["tsconfig.json", "package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
			let hash = "-";
			try {
				hash = sha256(readFileSync(join(root, file)));
			} catch {}
			parts.push(`${file} ${hash}`);
		}
		return sha256(parts.join("\n"));
	}

	test("rbxtsc keys are unchanged (existing caches stay valid)", () => {
		const root = game();
		for (const channel of ["dev", "prod"] as const) {
			expect(buildCacheKey(root, channel)).toBe(keyBeforeGoblox(root, channel));
			expect(buildCacheKey(root, channel, { name: "rbxtsc", version: "3.0.0" })).toBe(keyBeforeGoblox(root, channel));
		}
	});

	test("goblox (and each goblox version) gets its own key", () => {
		const root = game();
		const rbxtsc = buildCacheKey(root, "dev", { name: "rbxtsc", version: "3.0.0" });
		const goblox = buildCacheKey(root, "dev", { name: "goblox", version: "0.1.0" });
		expect(goblox).not.toBe(rbxtsc);
		expect(buildCacheKey(root, "dev", { name: "goblox", version: "0.2.0" })).not.toBe(goblox);
	});

	test("switching compilers drops the cache (a full compile); a cache from before goblox restores under rbxtsc", () => {
		const root = game();
		const layout = { rootDir: join(root, "src"), outDir: join(root, "out") };
		mkdirSync(join(root, "src", "server"), { recursive: true });
		mkdirSync(join(root, "out", "server"), { recursive: true });
		writeFileSync(join(root, "src", "server", "boot.ts"), "export {};\n");
		writeFileSync(join(root, "out", "server", "boot.luau"), "return 1\n");
		saveBuildCache(root, layout, "dev"); // as CLI 0.15.0 saved it
		rmSync(layout.outDir, { recursive: true, force: true });
		expect(restoreBuildCache(root, layout, "dev", sourceCandidates, { name: "rbxtsc", version: "3.0.0" }).restored).toBe(true);
		rmSync(layout.outDir, { recursive: true, force: true });
		expect(restoreBuildCache(root, layout, "dev", sourceCandidates, { name: "goblox", version: "0.1.0" })).toEqual({
			restored: false,
			reason: "tsconfig, package.json, a lockfile, the compiler or the CLI changed",
		});
	});
});

describe("doctor", () => {
	test("rbxtsc: goblox mentioned as the optional fast compiler", () => {
		const checks = compilerChecks(game(), true, { env: undefined });
		expect(checks.find((c) => c.name === "compiler")).toMatchObject({ status: "ok" });
		expect(checks.find((c) => c.name === "compiler")!.detail).toContain("bun add -d goblox");
		expect(checks.find((c) => c.name === "rbxtsc")).toMatchObject({ status: "ok", detail: "roblox-ts 3.0.0" });
		expect(compilerChecks(game({ robloxTs: false }), true, { env: undefined }).find((c) => c.name === "rbxtsc")?.status).toBe("fail");
	});

	test("goblox selected: warns about JS plugins it won't run", () => {
		const root = game({ goblox: "goblox" });
		expect(compilerChecks(root, true, { env: undefined }).filter((c) => c.status !== "ok")).toEqual([]);
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { plugins: [{ transform: "@typetorch/transformer" }, { transform: "rbxts-transform-debug" }, { name: "x" }] } }),
		);
		const warning = compilerChecks(root, true, { env: undefined }).find((c) => c.status === "warn")!;
		expect(warning.detail).toContain("goblox ignores JS tsconfig plugins other than @typetorch/transformer");
		expect(warning.detail).toContain("rbxts-transform-debug, x");
		expect(pluginsIgnoredByGoblox({ compilerOptions: { plugins: [{ transform: "@typetorch/transformer" }] } })).toEqual([]);
		// An explicit rbxtsc keeps the plugins: no warning.
		expect(compilerChecks(root, true, { env: "rbxtsc" }).filter((c) => c.status !== "ok")).toEqual([]);
		// goblox doesn't need roblox-ts to run: only a warning.
		expect(compilerChecks(game({ goblox: "goblox", robloxTs: false }), true, { env: undefined }).find((c) => c.name === "rbxtsc")?.status).toBe("warn");
	});

	test("goblox requested but missing: fail", () => {
		expect(compilerChecks(game(), true, { env: "goblox" }).find((c) => c.name === "compiler")).toMatchObject({ status: "fail" });
	});
});
