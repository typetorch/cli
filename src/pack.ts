/**
 * The deploy build's production stages: what `rojo build` packs is a transformed copy of the project's `$path` folders
 * (.typetorch/pack/), so the artifact id, the signature and the upload all cover the final bytes. `typetorch serve`
 * syncs the project itself and never comes here.
 *
 * Stages, on by default for deploys; `"minify": false` in typetorch.json or --no-minify turns them off:
 *   1. strip: comments and whitespace, with darklua's parser. Lines stay where they are (generator retain_lines), so
 *      error traces and analytics fingerprints still point at the compiled source.
 *   2. define: `__DEV__` becomes false and its dead branches go, like Vite's define. React reads it from _G or
 *      ReactGlobals, defaulting to false; a game that sets it switches this stage off.
 *   3. shake: drops `*.story` modules no other module names (see shake for why packages stay).
 *
 * One darklua process per batch, never per file. A module's output is cached by the hash of its text, the stages'
 * settings and darklua's version (.typetorch/build-cache/pack/), so an unchanged rebuild only hashes.
 */
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { BUILD_CACHE_DIR } from "./build-cache.ts";

export const PACK_DIR = ".typetorch/pack";
const CACHE_SUBDIR = "pack";
const WORK_DIR = ".typetorch/pack-work";
const SCRIPT = /\.(luau|lua)$/;
/** Below this many changed modules another process doesn't pay for itself. */
const FILES_PER_PROCESS = 200;
const MAX_PROCESSES = 4;

export interface PackStages {
	strip: boolean;
	define: boolean;
	shake: boolean;
}
export const ALL_STAGES: PackStages = { strip: true, define: true, shake: true };

export interface PackResult {
	project: any;
	modules: number;
	/** Modules left out by the shake. */
	dropped: string[];
	/** Modules darklua had to process (the rest came from the cache). */
	processed: number;
	sourceBytes: number;
	packedBytes: number;
	/** Stages that ended up off, with why. */
	skipped: string[];
}

export type RunCommand = (command: string[], cwd: string) => Promise<unknown>;

function sha(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

/** darklua's settings for these stages. */
export function darkluaConfig(stages: PackStages): object {
	const rules: unknown[] = [];
	if (stages.strip) rules.push("remove_comments", "remove_spaces");
	if (stages.define) {
		rules.push({ rule: "inject_global_value", identifier: "__DEV__", value: false }, "compute_expression", "remove_unused_if_branch", "remove_unused_while", "remove_empty_do");
	}
	return { generator: "retain_lines", rules };
}

/**
 * Stage 2's text half, ahead of darklua: makes each `__DEV__` a global read, which darklua's parser then folds. A binding
 * goes only when the whole line is that binding and its value reads the flag; a field read only off a bare ReactGlobals
 * (`require(x).ReactGlobals.__DEV__` as part of a longer expression stays). The line stays, as an empty one.
 */
export function defineDev(source: string): string {
	if (!source.includes("__DEV__")) return source;
	return source
		.replace(/^[ \t]*local __DEV__(?:\s*:\s*boolean)?\s*=\s*[^\n]*\.__DEV__(?:\s*::\s*boolean)?[ \t]*(\r?)$/gm, "$1")
		.replace(/(^|[^\w.)])\(?\bReactGlobals(?:\s*::\s*any)?\)?\.__DEV__\b(?!\s*=[^=])/gm, "$1__DEV__");
}

/** Whether game code sets the flag: then it isn't false at runtime and stage 2 must not run. */
export function setsDev(source: string): boolean {
	return /(?:_G|ReactGlobals)\s*(?:\.__DEV__|\[\s*["']__DEV__["']\s*\])\s*=[^=]/.test(source);
}

interface Entry {
	/** Relative to the project root, with forward slashes. */
	path: string;
	source: string;
}

function listTree(root: string, path: string): { scripts: Entry[]; others: string[] } {
	const scripts: Entry[] = [];
	const others: string[] = [];
	const walk = (rel: string) => {
		const full = join(root, rel);
		if (!existsSync(full)) return;
		if (statSync(full).isDirectory()) {
			for (const name of readdirSync(full).sort()) walk(`${rel}/${name}`);
		} else if (SCRIPT.test(rel)) {
			scripts.push({ path: rel, source: readFileSync(full, "utf8") });
		} else if (!/\.(ts|tsx|map|md)$/.test(rel)) {
			others.push(rel);
		}
	};
	walk(path);
	return { scripts, others };
}

/**
 * Stage 3: `*.story` modules no other module names. Packages aren't shaken: a folder's name isn't the name code uses
 * (`luau-polyfill` is required as `LuauPolyfill`, through a local), so telling a package is unused takes a real import
 * graph over parsed Luau. Stories sit outside the folders the framework's boot walks (Server/services, Client/controllers).
 */
export function shake(entries: Entry[]): Set<string> {
	const isStory = (path: string) => /\.story\.(luau|lua)$/.test(path);
	const kept = entries.filter((entry) => !isStory(entry.path)).map((entry) => entry.source).join("\n");
	const dropped = new Set<string>();
	for (const entry of entries) {
		if (!isStory(entry.path) || entry.path.includes("node_modules/")) continue;
		if (!kept.includes(entry.path.split("/").pop()!.replace(SCRIPT, ""))) dropped.add(entry.path);
	}
	return dropped;
}

/** The project with every `$path` pointing into the copy. */
export function remapProject(project: any, dir: string): any {
	const walk = (node: any): any => {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
		const copy: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			if (key === "$path" && typeof value === "string") copy[key] = `${dir}/${value.replace(/\\/g, "/").replace(/^\.\//, "")}`;
			else copy[key] = key.startsWith("$") ? value : walk(value);
		}
		return copy;
	};
	return { ...project, tree: walk(project.tree) };
}

/**
 * Writes the transformed copy of `paths` under .typetorch/pack and returns the project to build it with. Throws when
 * darklua fails on any module: a payload that doesn't parse must not get as far as an upload.
 */
export async function packProject(options: {
	root: string;
	project: any;
	paths: string[];
	darklua: string;
	darkluaVersion: string;
	stages?: PackStages;
	run: RunCommand;
}): Promise<PackResult> {
	const { root, project, paths, darklua, run } = options;
	const stages = { ...(options.stages ?? ALL_STAGES) };
	const skipped: string[] = [];
	const scripts: Entry[] = [];
	const others: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		const listed = listTree(root, path.replace(/^\.\//, ""));
		for (const entry of listed.scripts) {
			if (seen.has(entry.path)) continue;
			seen.add(entry.path);
			scripts.push(entry);
		}
		others.push(...listed.others);
	}
	if (stages.define && scripts.some((entry) => !entry.path.includes("node_modules/") && setsDev(entry.source))) {
		stages.define = false;
		skipped.push("define: the game sets __DEV__, so it isn't false at runtime");
	}
	const dropped = stages.shake ? shake(scripts) : new Set<string>();
	const live = scripts.filter((entry) => !dropped.has(entry.path));

	const settings = sha(JSON.stringify({ config: darkluaConfig(stages), define: stages.define, version: options.darkluaVersion, v: 1 }));
	const cacheDir = join(root, BUILD_CACHE_DIR, CACHE_SUBDIR, settings.slice(0, 16));
	const outDir = join(root, PACK_DIR);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(cacheDir, { recursive: true });

	const wanted = live.map((entry) => {
		const input = stages.define ? defineDev(entry.source) : entry.source;
		return { entry, input, cached: join(cacheDir, sha(input)) };
	});
	const missing = new Map<string, (typeof wanted)[number]>();
	for (const item of wanted) if (!existsSync(item.cached)) missing.set(item.cached, item);

	if (missing.size > 0) {
		const work = join(root, WORK_DIR);
		rmSync(work, { recursive: true, force: true });
		const configPath = join(work, "darklua.json");
		mkdirSync(work, { recursive: true });
		writeFileSync(configPath, JSON.stringify(darkluaConfig(stages)));
		const items = [...missing.values()];
		const processes = Math.min(MAX_PROCESSES, availableParallelism(), Math.max(1, Math.ceil(items.length / FILES_PER_PROCESS)));
		try {
			await Promise.all(
				Array.from({ length: processes }, async (_, index) => {
					const batch = items.filter((_, at) => at % processes === index);
					const input = join(work, `in${index}`);
					const output = join(work, `out${index}`);
					batch.forEach((item, at) => {
						mkdirSync(input, { recursive: true });
						writeFileSync(join(input, `${at}.luau`), item.input);
					});
					await run([darklua, "process", "-c", relative(root, configPath), relative(root, input), relative(root, output)], root);
					batch.forEach((item, at) => {
						const made = join(output, `${at}.luau`);
						if (!existsSync(made)) throw new Error(`darklua produced nothing for ${item.entry.path}`);
						writeFileSync(item.cached, readFileSync(made));
					});
				}),
			);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	let packedBytes = 0;
	let sourceBytes = 0;
	for (const item of wanted) {
		const target = join(outDir, item.entry.path);
		mkdirSync(dirname(target), { recursive: true });
		const text = readFileSync(item.cached);
		writeFileSync(target, text);
		packedBytes += text.length;
		sourceBytes += Buffer.byteLength(item.entry.source);
	}
	// Everything else rojo reads (.meta.json, .txt, model files) as it is.
	for (const path of others) {
		const target = join(outDir, path);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(root, path), target);
	}
	return {
		project: remapProject(project, PACK_DIR.split(sep).join("/")),
		modules: wanted.length,
		dropped: [...dropped].sort(),
		processed: missing.size,
		sourceBytes,
		packedBytes,
		skipped,
	};
}
