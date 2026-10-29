/**
 * Which TypeScript-to-Luau compiler a build runs: rbxtsc (roblox-ts), or goblox (npm `goblox`: roblox-ts ported to
 * Go on typescript-go, a drop-in with rbxtsc's flags, out/ layout and tsbuildinfo-based incremental builds).
 *
 * Resolution, first match wins:
 *   1. TYPETORCH_COMPILER (environment or .env), then typetorch.json "compiler": "goblox" | "rbxtsc";
 *   2. goblox when node_modules/.bin/goblox (goblox.exe / goblox.cmd on Windows) exists;
 *   3. rbxtsc, as before goblox existed.
 * goblox asked for explicitly but not installed is an error, never a silent fallback.
 *
 * goblox runs @typetorch/transformer natively (a Go port, from the same tsconfig `plugins` entry, TYPETORCH_DEBUG_MACROS
 * included) and ignores every other JS plugin, so prod builds never need the CLI's strip transformer with it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TYPETORCH_TRANSFORM } from "./debug-macros.ts";
import { settings } from "./env.ts";
import { isRecord, parseJsonc } from "./json.ts";
import { query } from "./proc.ts";

export const COMPILERS = ["goblox", "rbxtsc"] as const;
export type CompilerName = (typeof COMPILERS)[number];
export const COMPILER_VAR = "TYPETORCH_COMPILER";
export const GOBLOX_PACKAGE = "goblox";
/** An alias package that depends on goblox (same bin); read for the version, never recommended. */
export const GOBLOX_ALIAS = "@typetorch/goblox";
export const GOBLOX_INSTALL = `bun add -d ${GOBLOX_PACKAGE}`;

export interface ResolvedCompiler {
	name: CompilerName;
	/** Why this one, for the [debug] output: "TYPETORCH_COMPILER", "typetorch.json", "node_modules/.bin/goblox", "default". */
	reason: string;
	/** Set when the build can't run: goblox requested but missing, or an unknown value. */
	problem?: string;
}

export function isCompilerName(value: unknown): value is CompilerName {
	return typeof value === "string" && (COMPILERS as readonly string[]).includes(value);
}

export function compilerValueError(value: unknown): string | undefined {
	return isCompilerName(value) ? undefined : `must be one of ${COMPILERS.join(", ")} (got ${JSON.stringify(value)})`;
}

/** node_modules/.bin names a package manager gives the goblox bin on each platform. */
export function gobloxBinNames(platform: NodeJS.Platform = process.platform): string[] {
	return platform === "win32" ? ["goblox.exe", "goblox.cmd", "goblox"] : ["goblox"];
}

/** The installed goblox bin, or undefined. */
export function gobloxBin(root: string, platform: NodeJS.Platform = process.platform): string | undefined {
	return gobloxBinNames(platform)
		.map((name) => join(root, "node_modules", ".bin", name))
		.find((path) => existsSync(path));
}

/** typetorch.json "compiler" as written (validated by config.ts; undefined when absent or unreadable). */
export function configuredCompiler(root: string): unknown {
	try {
		const raw = parseJsonc(readFileSync(join(root, "typetorch.json"), "utf8"));
		return isRecord(raw) ? raw.compiler : undefined;
	} catch {
		return undefined;
	}
}

export interface ResolveOptions {
	/** typetorch.json "compiler" (default: read from <root>/typetorch.json). */
	configured?: unknown;
	/** TYPETORCH_COMPILER (default: the settings layer). */
	env?: string;
	platform?: NodeJS.Platform;
}

export function resolveCompiler(root: string, options: ResolveOptions = {}): ResolvedCompiler {
	const env = "env" in options ? options.env : settings().get(COMPILER_VAR)?.value;
	const configured = "configured" in options ? options.configured : configuredCompiler(root);
	const installed = gobloxBin(root, options.platform) !== undefined;
	const explicit = (value: unknown, from: string): ResolvedCompiler => {
		if (!isCompilerName(value)) return { name: "rbxtsc", reason: from, problem: `${from} ${compilerValueError(value)}` };
		if (value === "goblox" && !installed) {
			return { name: value, reason: from, problem: `compiler goblox was requested (${from}) but ${GOBLOX_PACKAGE} is not installed: run \`${GOBLOX_INSTALL}\`` };
		}
		return { name: value, reason: from };
	};
	if (env !== undefined && env.trim() !== "") return explicit(env.trim(), COMPILER_VAR);
	if (configured !== undefined) return explicit(configured, 'typetorch.json "compiler"');
	if (installed) return { name: "goblox", reason: "node_modules/.bin/goblox is installed" };
	return { name: "rbxtsc", reason: "default" };
}

/** What the build cache key records about the compiler. */
export interface CompilerKey {
	name: CompilerName;
	version: string;
}

/** The compiler's version: the installed package's package.json, else `goblox --version`. "?" when unknown. */
export function compilerVersion(root: string, name: CompilerName): string {
	for (const pkg of name === "goblox" ? [GOBLOX_PACKAGE, GOBLOX_ALIAS] : ["roblox-ts"]) {
		try {
			const version = JSON.parse(readFileSync(join(root, "node_modules", pkg, "package.json"), "utf8"))?.version;
			if (typeof version === "string" && version) return version;
		} catch {}
	}
	if (name === "goblox") {
		const bin = gobloxBin(root);
		const out = bin ? query([bin, "--version"], root) : undefined;
		if (out) return out.split(/\r?\n/)[0];
	}
	return "?";
}

/** True when a package.json build script ends with a call to this compiler, so `-p <tsconfig>` can be appended to it. */
export function scriptEndsWith(script: string, name: CompilerName): boolean {
	return new RegExp(`(?:^|&&|\\|\\||;)\\s*(?:bunx\\s+|npx\\s+)?${name}(?:\\s+[^&|;]*)?\\s*$`).test(script.trim());
}

/** The compiler a build script ends with, if any. */
export function scriptCompiler(script: string): CompilerName | undefined {
	return COMPILERS.find((name) => scriptEndsWith(script, name));
}

/** tsconfig `plugins` goblox won't run (it runs only @typetorch/transformer, natively). */
export function pluginsIgnoredByGoblox(tsconfig: unknown): string[] {
	const options = isRecord(tsconfig) && isRecord(tsconfig.compilerOptions) ? tsconfig.compilerOptions : {};
	const plugins = Array.isArray(options.plugins) ? options.plugins : [];
	return plugins
		.map((plugin) => (isRecord(plugin) ? (plugin.transform ?? plugin.name) : undefined))
		.filter((name): name is string => typeof name === "string" && name !== TYPETORCH_TRANSFORM);
}
