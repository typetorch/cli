/**
 * The build cache: rbxtsc's out/ (with its incremental state, the tsbuildinfo) kept between clean builds.
 *
 * Deploy and upload always `git clean` out/ (S-M3), which also deleted the tsbuildinfo, so every deploy was a full
 * rbxtsc compile (cecot: ~30 s instead of ~6 s for a one-file edit). After a successful build, out/ is copied to
 * .typetorch/build-cache/<channel>/ with a sha256 of every file. The next clean build still cleans out/, then copies
 * the cache back when it is intact and was made under the same inputs, and rbxtsc recompiles only what changed.
 *
 * What keeps a cached build as trustworthy as a clean one:
 *   - one cache per channel: prod compiles with a different plugin list (debug macros stripped, S-L7) that rbxtsc's
 *     buildinfo does not track, so a dev output must never be reused in a prod build;
 *   - the cache key hashes everything rbxtsc's buildinfo can't see: tsconfig.json, package.json, the lockfiles (the
 *     transformer plugins' code), the strip transformer version and the CLI's cache version; any change = full build;
 *   - every restored file must match its recorded sha256, or the whole cache is dropped;
 *   - restored outputs whose source no longer exists are removed before rbxtsc runs (rbxtsc never deletes them);
 *   - the post-compile checks (compiled build.ts carries the commit, every output has a tracked source) run as before.
 *
 * TYPETORCH_BUILD_CACHE=0 turns it off (every clean build is a full compile again).
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { STRIP_TRANSFORMER_VERSION } from "./debug-macros.ts";
import { settings } from "./env.ts";
import { parseJsonc } from "./json.ts";
import { debug } from "./log.ts";
import type { Channel } from "./naming.ts";

/** Bump when what the cache stores or how it is checked changes: older caches are then dropped. */
export const BUILD_CACHE_VERSION = 1;
export const BUILD_CACHE_DIR = ".typetorch/build-cache";
const MANIFEST = "manifest.json";
const FILES = "files";
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const KEY_FILES = ["tsconfig.json", "package.json", ...LOCKFILES];

interface Manifest {
	v: number;
	key: string;
	/** Paths relative to outDir (forward slashes) -> sha256 of the file. */
	files: Record<string, string>;
}

export interface CacheLayout {
	rootDir: string;
	outDir: string;
}

export type RestoreResult = { restored: true; files: number; pruned: string[] } | { restored: false; reason: string };

export function buildCacheEnabled(): boolean {
	return settings().get("TYPETORCH_BUILD_CACHE")?.value !== "0";
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function cacheDir(root: string, channel: Channel): string {
	return join(root, BUILD_CACHE_DIR, channel);
}

function listFiles(dir: string): string[] {
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	if (existsSync(dir)) walk(dir);
	return files;
}

const posix = (path: string) => path.replace(/\\/g, "/");

/**
 * Why rbxtsc's incremental state can't be cached for this project (undefined: it can). Without `incremental`, rbxtsc
 * recompiles everything anyway; a tsbuildinfo outside outDir would survive the clean without its outputs.
 */
export function cacheUnsupported(root: string, layout: CacheLayout): string | undefined {
	let options: Record<string, any> = {};
	try {
		options = parseJsonc(readFileSync(join(root, "tsconfig.json"), "utf8"))?.compilerOptions ?? {};
	} catch {
		return "tsconfig.json unreadable";
	}
	if (options.incremental !== true && options.composite !== true) return 'tsconfig.json has no "incremental": true';
	const buildInfo = buildInfoOutsideOutDir(root, layout, options);
	if (buildInfo) return `tsBuildInfoFile ${posix(relative(root, buildInfo))} is outside outDir`;
	return undefined;
}

function buildInfoOutsideOutDir(root: string, layout: CacheLayout, options: Record<string, any>): string | undefined {
	if (typeof options.tsBuildInfoFile !== "string") return undefined;
	const path = resolve(root, options.tsBuildInfoFile);
	const rel = relative(layout.outDir, path);
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : undefined;
}

/**
 * A tsbuildinfo outside outDir survives `git clean` of out/ (when it isn't ignored there) and then tells rbxtsc that
 * nothing changed, so the clean build would emit nothing. Removed with the clean.
 */
export function removeStrayBuildInfo(root: string, layout: CacheLayout) {
	try {
		const options = parseJsonc(readFileSync(join(root, "tsconfig.json"), "utf8"))?.compilerOptions ?? {};
		const path = buildInfoOutsideOutDir(root, layout, options);
		if (path && existsSync(path)) {
			rmSync(path, { force: true });
			debug(`removed ${posix(relative(root, path))} (tsBuildInfoFile outside outDir) with the clean`);
		}
	} catch {}
}

/** Hash of everything that changes rbxtsc's output but is not in its buildinfo. */
export function buildCacheKey(root: string, channel: Channel): string {
	const parts = [`v${BUILD_CACHE_VERSION}`, `channel ${channel}`, `strip ${STRIP_TRANSFORMER_VERSION}`];
	for (const file of KEY_FILES) {
		const path = join(root, file);
		parts.push(`${file} ${existsSync(path) ? sha256(readFileSync(path)) : "-"}`);
	}
	return sha256(parts.join("\n"));
}

/** Source files that could have produced `out/<rel>` (same mapping as build.ts's sourceCandidates). */
function hasSource(layout: CacheLayout, rel: string, candidates: (rel: string) => string[]): boolean {
	return candidates(rel).some((candidate) => existsSync(join(layout.rootDir, candidate)));
}

/**
 * Copies the channel's cache into outDir (which the caller has just cleaned). Drops the cache when its key differs or
 * any file fails its hash. Removes restored outputs whose source file is gone.
 */
export function restoreBuildCache(
	root: string,
	layout: CacheLayout,
	channel: Channel,
	candidates: (rel: string) => string[],
): RestoreResult {
	const dir = cacheDir(root, channel);
	const manifestPath = join(dir, MANIFEST);
	if (!existsSync(manifestPath)) return { restored: false, reason: "no cache yet" };
	const drop = (reason: string): RestoreResult => {
		rmSync(dir, { recursive: true, force: true });
		return { restored: false, reason };
	};
	let manifest: Manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return drop("unreadable manifest");
	}
	if (manifest?.v !== BUILD_CACHE_VERSION || typeof manifest.files !== "object" || manifest.files === null) return drop("old cache format");
	if (manifest.key !== buildCacheKey(root, channel)) return drop("tsconfig, package.json, a lockfile or the CLI changed");
	const entries = Object.entries(manifest.files);
	const files = join(dir, FILES);
	const onDisk = listFiles(files).map((path) => posix(relative(files, path)));
	if (onDisk.length !== entries.length) return drop("file count differs from the manifest");
	for (const [rel, hash] of entries) {
		const path = join(files, rel);
		if (rel.split("/").includes("..") || !existsSync(path) || sha256(readFileSync(path)) !== hash) return drop(`${rel} doesn't match the manifest`);
	}
	mkdirSync(layout.outDir, { recursive: true });
	cpSync(files, layout.outDir, { recursive: true });
	const pruned: string[] = [];
	for (const [rel] of entries) {
		if (/\.tsbuildinfo$/.test(rel) || hasSource(layout, rel, candidates)) continue;
		rmSync(join(layout.outDir, rel), { force: true });
		pruned.push(rel);
	}
	return { restored: true, files: entries.length, pruned };
}

/** Replaces the channel's cache with the current outDir (call after a successful, checked build). */
export function saveBuildCache(root: string, layout: CacheLayout, channel: Channel): number {
	const dir = cacheDir(root, channel);
	const files = join(dir, FILES);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(files, { recursive: true });
	const manifest: Manifest = { v: BUILD_CACHE_VERSION, key: buildCacheKey(root, channel), files: {} };
	for (const path of listFiles(layout.outDir)) {
		const rel = posix(relative(layout.outDir, path));
		const bytes = readFileSync(path);
		const target = join(files, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		manifest.files[rel] = sha256(bytes);
	}
	writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest));
	return Object.keys(manifest.files).length;
}
