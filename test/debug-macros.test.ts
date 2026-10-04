import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { debugMacrosFor, prodTsconfig, scriptEndsWithRbxtsc, STRIP_TRANSFORMER_FILE, STRIP_TRANSFORMER_SOURCE } from "../src/debug-macros";

/** Runs the generated transformer on `code` the way roblox-ts does (program factory, `{ ts }` extras). */
function strip(code: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tt-strip-"));
	mkdirSync(join(dir, "node_modules", "rbxts-transform-debug"), { recursive: true });
	writeFileSync(
		join(dir, "node_modules", "rbxts-transform-debug", "index.d.ts"),
		[
			"export function $print(...params: unknown[]): void;",
			"export function $warn(...params: unknown[]): void;",
			"export function $dbg<T>(value: T): T;",
			"export function $assert<T>(condition: T, message?: string): asserts condition;",
			"export function $error(message: string, level?: number): never;",
		].join("\n"),
	);
	writeFileSync(join(dir, "node_modules", "rbxts-transform-debug", "package.json"), JSON.stringify({ name: "rbxts-transform-debug", types: "index.d.ts" }));
	const file = join(dir, "a.ts");
	writeFileSync(file, code);
	const program = ts.createProgram([file], { moduleResolution: ts.ModuleResolutionKind.Node10, noEmit: true, strict: true, target: ts.ScriptTarget.ESNext });
	const module = { exports: undefined as any };
	new Function("module", "require", STRIP_TRANSFORMER_SOURCE)(module, createRequire(import.meta.url));
	const factory = module.exports(program, {}, { ts });
	const result = ts.transform(program.getSourceFile(file)!, [factory]);
	return ts.createPrinter().printFile(result.transformed[0] as ts.SourceFile);
}

describe("prod builds strip debug macros (S-L7)", () => {
	test("dev keeps them, prod drops them", () => {
		expect(debugMacrosFor("dev")).toBe(true);
		expect(debugMacrosFor("prod")).toBe(false);
	});

	test("$print/$warn vanish, $dbg keeps its value, $assert/$error lose the source path", () => {
		const out = strip(
			[
				'import { $print, $warn, $dbg, $assert, $error } from "rbxts-transform-debug";',
				"declare function sideEffect(): number;",
				"declare function print(...a: unknown[]): void;",
				'$print("hello", 1);',
				"if (true) $warn(\"careful\");",
				"const x = $dbg(5);",
				"$dbg(sideEffect());",
				"$dbg(x);",
				'$assert(x > 1, "x too small");',
				'function fail(): never { return $error("boom", 2); }',
				'print("a real print stays");',
			].join("\n"),
		);
		expect(out).not.toMatch(/\$print\(|\$warn\(|\$dbg\(|\$assert\(|\$error\(/);
		expect(out).not.toContain("hello");
		expect(out).not.toContain("careful");
		expect(out).toContain("const x = 5;");
		expect(out).toContain("sideEffect();");
		expect(out).toContain('assert(x > 1, "x too small");');
		expect(out).toContain('return error("boom", 2);');
		expect(out).toContain('print("a real print stays");');
	});

	test("a local function that happens to be named $print is left alone", () => {
		const out = strip('function $print(...a: unknown[]) {}\n$print("mine");\n');
		expect(out).toContain('$print("mine");');
	});

	test("the prod tsconfig puts the stripper first and disables rbxts-transform-debug", () => {
		const original = {
			compilerOptions: {
				rootDir: "src",
				plugins: [{ transform: "rbxts-transform-debug", environmentRequires: {} }, { transform: "rbxts-transformer-flamework" }],
			},
			include: ["./src/**/*.ts"],
		};
		const prod = prodTsconfig(original);
		expect(prod.compilerOptions.plugins).toEqual([
			{ transform: `./${STRIP_TRANSFORMER_FILE}`, version: 1 },
			{ transform: "rbxts-transform-debug", environmentRequires: {}, enabled: false },
			{ transform: "rbxts-transformer-flamework" },
		]);
		expect(prod.include).toEqual(["./src/**/*.ts"]);
		expect(original.compilerOptions.plugins).toHaveLength(2); // not mutated
	});

	test("-p can be appended only to build scripts that end with rbxtsc", () => {
		expect(scriptEndsWithRbxtsc("rbxtsc")).toBe(true);
		expect(scriptEndsWithRbxtsc("bun scripts/build-info.ts && rbxtsc")).toBe(true);
		expect(scriptEndsWithRbxtsc("bun x.ts && rbxtsc --verbose")).toBe(true);
		expect(scriptEndsWithRbxtsc("rbxtsc && bun post.ts")).toBe(false);
		expect(scriptEndsWithRbxtsc("bun scripts/build.ts")).toBe(false);
	});
});
