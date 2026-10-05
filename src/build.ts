/**
 * `typetorch build`:
 *   git identity + sources -> (clean: `git clean -fdX` of out/ and include/) -> ignored-source check
 *   -> src/shared/build.ts -> rbxtsc (prod channel: debug macros stripped) -> outputs-from-tracked-sources check
 *   -> rojo build stamped with `<commit7>[-dirty]` -> hash -> rojo build stamped with the final id
 *   -> payload contents check (only Folders and ModuleScripts) -> .typetorch/payload.rbxm + payload.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { Project } from "./config";
import { debugMacrosFor, prodTsconfig, PROD_TSCONFIG, readTsconfig, scriptEndsWithRbxtsc, STRIP_TRANSFORMER_FILE, STRIP_TRANSFORMER_SOURCE } from "./debug-macros";
import { settings } from "./env";
import { gitInfo, isGeneratedPath, porcelainPaths, type GitInfo } from "./git";
import { isRecord, parseJsonc } from "./json";
import { debug, Stopwatch, warn } from "./log";
import {
	artifactId as makeArtifactId,
	branchChannel,
	branchFromGit,
	branchNameError,
	buildFileSource,
	compareEarlier,
	provisionalArtifactId,
	type BuildSources,
	type Channel,
	type EarlierArtifact,
	PACKAGES_MANIFEST,
} from "./naming";
import { query, run } from "./proc";
import { ASSETS_PAYLOAD_ATTRIBUTE, ASSETS_PAYLOAD_FOLDER, assetsAttribute, readAssetsLock } from "./assets";
import { checkPayloadContents } from "./rbxm";
import { payloadNotes, sourceChanges } from "./changes";
import { liveHeads, readLocalLog } from "./deployments";
import { stateDir } from "./state";

export const KERNEL_API = 1;
export const BUILD_FILE = "src/shared/build.ts";
/** The stamped copy of default.project.json. It must sit next to the original (Rojo resolves $path and
 * globIgnorePaths relative to the project file), and is deleted after the build. */
export const GEN_PROJECT = ".payload.gen.project.json";
export const OUT_DIR = ".typetorch";
export const PAYLOAD_FILE = `${OUT_DIR}/payload.rbxm`;
export const PAYLOAD_META = `${OUT_DIR}/payload.json`;
export { PACKAGES_MANIFEST };
/** Files TypeTorch writes inside the repo; they never make a build "dirty". */
export const GENERATED_PATHS = [BUILD_FILE, GEN_PROJECT, PROD_TSCONFIG, `${OUT_DIR}/`];
/** File types that can end up in a payload (compiled by rbxtsc, or synced by Rojo). */
const PAYLOAD_FILE_TYPES = /\.(ts|tsx|lua|luau|json|toml|ya?ml|txt|csv|rbxm|rbxmx|model\.json|meta\.json)$/i;

export interface PayloadMeta {
	artifactId: string;
	project: string;
	channel: Channel;
	/** TypeTorch branch the build is for. */
	branch: string;
	gitBranch: string;
	commit: string;
	commitHash: string;
	dirty: boolean;
	builtAt: string;
	bytes: number;
	/** sha256 of the uploaded bytes (they carry the final id). */
	sha256: string;
	kernelApi: number;
	/** Relative to the project root. */
	file: string;
	/** Commits of the game and the @typetorch packages. */
	sources?: BuildSources;
	/** False for prod-channel builds: rbxts-transform-debug's logging macros were compiled away. */
	debugMacros?: boolean;
	/** ModuleScripts in the payload. */
	modules?: number;
	/** What was stamped as the payload's Notes attribute (message + change lines). */
	notes?: { message?: string; changes: string[] };
	/** Hot assets stamped as the Assets attribute (typetorch.assets.lock.json; count 0, no placeVersion without one). */
	assets?: { count: number; placeVersion?: number };
}

export interface BuildTarget {
	branch: string;
	channel: Channel;
	/** The channel the branch has by configuration (differs from `channel` only with --channel). */
	impliedChannel: Channel;
	git: GitInfo;
}

export class BuildError extends Error {
	override name = "BuildError";
}

/** Resolves the TypeTorch branch and channel for a build. */
export function resolveTarget(project: Project, git: GitInfo, options: { branch?: string; channel?: Channel }): BuildTarget {
	let branch = options.branch;
	if (!branch) {
		if (!git.gitBranch) {
			throw new BuildError(
				git.detached ? "detached HEAD: pass --branch <name>" : "can't tell the git branch: pass --branch <name>",
			);
		}
		branch = branchFromGit(git.gitBranch, project.config.branches);
	}
	const nameError = branchNameError(branch);
	if (nameError) {
		throw new BuildError(`${nameError}. Pass --branch, or map the git branch in typetorch.json "branches".`);
	}
	const impliedChannel = branchChannel(project.config, branch);
	return { branch, channel: options.channel ?? impliedChannel, impliedChannel, git };
}

/**
 * default.project.json with the payload identity stamped on the root (Rojo `$attributes`), and `children` attributes
 * on the root's direct child nodes that exist (e.g. `Assets` on `Server`; Rojo applies `$attributes` next to `$path`).
 */
export function stampProject(
	projectJson: any,
	attributes: Record<string, string | number>,
	children: Record<string, Record<string, string | number>> = {},
): any {
	if (!isRecord(projectJson) || !isRecord(projectJson.tree)) throw new BuildError("default.project.json has no tree");
	const tree = projectJson.tree as Record<string, unknown>;
	const existing = isRecord(tree.$attributes) ? tree.$attributes : {};
	const stamped: Record<string, unknown> = { ...tree, $attributes: { ...existing, ...attributes } };
	for (const [name, extra] of Object.entries(children)) {
		const node = tree[name];
		if (!isRecord(node)) continue;
		stamped[name] = { ...node, $attributes: { ...(isRecord(node.$attributes) ? node.$attributes : {}), ...extra } };
	}
	return { ...projectJson, tree: stamped };
}

/** Warns when the payload project doesn't look like a TypeTorch payload (plans/03). */
export function checkPayloadTree(projectJson: any): string[] {
	const problems: string[] = [];
	const tree = projectJson?.tree;
	if (tree?.$className !== "Model") problems.push(`the root is ${tree?.$className ?? "not set"}, expected Model (a roblox-ts Model project)`);
	for (const part of ["Server", "Shared", "Client", "include"]) {
		if (!isRecord(tree?.[part])) problems.push(`the root has no "${part}"`);
	}
	return problems;
}

/** Every `$path` in a Rojo project tree (relative to the project file). */
export function projectPaths(projectJson: any): string[] {
	const paths: string[] = [];
	const walk = (node: unknown) => {
		if (!isRecord(node)) return;
		if (typeof node.$path === "string") paths.push(node.$path.replace(/\\/g, "/").replace(/\/+$/, ""));
		for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) walk(child);
	};
	walk(projectJson?.tree);
	return paths;
}

function readJsonc(path: string): any {
	return parseJsonc(readFileSync(path, "utf8"));
}

interface TsLayout {
	rootDir: string;
	outDir: string;
}

function tsLayout(root: string): TsLayout {
	let options: Record<string, any> = {};
	try {
		options = readJsonc(join(root, "tsconfig.json"))?.compilerOptions ?? {};
	} catch (error) {
		debug(`tsconfig.json unreadable: ${error}`);
	}
	return { rootDir: resolve(root, options.rootDir ?? "src"), outDir: resolve(root, options.outDir ?? "out") };
}

/** A path relative to the project root with forward slashes, or undefined when it is outside the root. */
function inside(root: string, path: string): string | undefined {
	const rel = relative(root, path).replace(/\\/g, "/");
	return rel === "" || rel.startsWith("../") || rel === ".." || /^[a-z]:/i.test(rel) ? undefined : rel;
}

/**
 * Checks the compiled build.ts carries the current commit. rbxtsc's incremental compile skips files whose text is
 * unchanged (reproduced 2026-10-04: a new commit with identical build.ts text kept the old commit compiled in); the
 * timestamp line in build.ts prevents that, and this check catches anything that still slips through.
 */
function checkCompiledBuildFile(layout: TsLayout, root: string, commit: string) {
	const rel = relative(layout.rootDir, resolve(root, BUILD_FILE)).replace(/\.ts$/, "");
	const compiled = [".luau", ".lua"].map((ext) => join(layout.outDir, rel + ext)).find((p) => existsSync(p));
	if (!compiled) {
		warn(`compiled ${BUILD_FILE} not found under ${relative(root, layout.outDir) || "."}; can't verify the compiled git info`);
		return;
	}
	if (commit && !readFileSync(compiled, "utf8").includes(`"${commit}"`)) {
		throw new BuildError(
			`${relative(root, compiled)} does not contain commit ${commit}: rbxtsc kept a stale build.ts. Delete ${relative(root, layout.outDir)} and build again.`,
		);
	}
}

/**
 * The rbxtsc command: the repo's `build` script when it has one, else the local roblox-ts binary. With `tsconfig`
 * (prod builds), `-p <tsconfig>` is appended; a build script that doesn't end with rbxtsc can't take it, so rbxtsc
 * then runs directly (with a warning).
 */
export function compileCommand(root: string, tsconfig?: string): string[] {
	let scripts: Record<string, string> = {};
	try {
		scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.scripts ?? {};
	} catch {}
	const extra = tsconfig ? ["-p", tsconfig] : [];
	if (typeof scripts.build === "string") {
		if (!tsconfig || scriptEndsWithRbxtsc(scripts.build)) return ["bun", "run", "build", ...extra];
		warn(`the "build" script doesn't end with rbxtsc, so it can't take -p ${tsconfig}; running rbxtsc directly for this prod build (the script's other steps are skipped)`);
	}
	if (!existsSync(join(root, "node_modules", "roblox-ts"))) {
		throw new BuildError("roblox-ts is not installed here (no node_modules/roblox-ts): run `bun install`");
	}
	return ["bun", "run", "rbxtsc", ...extra];
}

export function rojoBinary(): string {
	return settings().get("TYPETORCH_ROJO")?.value || "rojo";
}

export function luneBinary(): string {
	return settings().get("TYPETORCH_LUNE")?.value || "lune";
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** `<commit7>` or `<commit7>*` for a dirty tree. */
function stamp(commit: string | undefined, dirty: boolean | undefined): string | undefined {
	if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) return undefined;
	return `${commit.slice(0, 7)}${dirty ? "*" : ""}`;
}

/**
 * Where the payload's code came from: the game repo's commit, plus the commits of the local @typetorch packages from
 * PACKAGES_MANIFEST (template/scripts/packages.ts records them when it packs), else `v<version>` of the installed
 * package (an npm release).
 */
export function readSources(root: string, git: Pick<GitInfo, "commit" | "dirty">): BuildSources {
	const sources: BuildSources = { template: git.commit ? `${git.commit}${git.dirty ? "*" : ""}` : "uncommitted*" };
	let manifest: any;
	try {
		manifest = JSON.parse(readFileSync(join(root, PACKAGES_MANIFEST), "utf8"));
	} catch {}
	for (const name of ["framework", "kernel"] as const) {
		const packed = isRecord(manifest?.packages) ? manifest.packages[name] : undefined;
		let value = isRecord(packed) ? stamp(packed.commit as string, packed.dirty as boolean) : undefined;
		if (!value) {
			try {
				const version = JSON.parse(readFileSync(join(root, "node_modules", "@typetorch", name, "package.json"), "utf8"))?.version;
				if (typeof version === "string" && /^[0-9A-Za-z.+-]+$/.test(version)) value = `v${version}`;
			} catch {}
		}
		if (value) sources[name] = value;
	}
	return sources;
}

/** The project-root-relative dirs rbxtsc writes: tsconfig outDir and include/ (when inside the root). */
export function buildOutputDirs(root: string, layout: TsLayout = tsLayout(root)): string[] {
	return [inside(root, layout.outDir), "include"].filter((dir): dir is string => dir !== undefined);
}

/**
 * Removes ignored (build-output) files from out/ and include/ so nothing a previous build or a stray file left there
 * reaches the payload (security audit S-M3). `-X` deletes only git-ignored files; tracked files are kept.
 */
export async function cleanBuildOutputs(root: string, git: GitInfo, dirs = buildOutputDirs(root)): Promise<string[]> {
	if (!git.isRepo) {
		debug("not a git repository: skipping git clean of the build outputs");
		return [];
	}
	const existing = dirs.filter((dir) => existsSync(join(root, dir)));
	if (existing.length > 0) await run(["git", "clean", "-fdXq", "--", ...existing], root);
	return existing;
}

/**
 * Git-ignored files that could reach the payload: under the TypeScript rootDir and under the project's other `$path`
 * dirs (node_modules and the build outputs excluded; TypeTorch's own generated files allowed). A clean build must come
 * from tracked files only.
 */
export function ignoredSourceFiles(root: string, projectJson: any, layout: TsLayout = tsLayout(root)): string[] {
	const outputs = buildOutputDirs(root, layout);
	const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
	const dirs = new Set<string>();
	const rootDir = inside(root, layout.rootDir);
	if (rootDir) dirs.add(rootDir);
	for (const path of projectPaths(projectJson)) {
		const rel = inside(root, resolve(root, path));
		if (!rel || rel.split("/").includes("node_modules") || outputs.some((o) => under(rel, o) || under(o, rel))) continue;
		dirs.add(rel);
	}
	if (dirs.size === 0) return [];
	const prefix = query(["git", "rev-parse", "--show-prefix"], root) ?? "";
	const status = query(["git", "status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...dirs], root, false) ?? "";
	const ignored = status
		.split(/\r?\n/)
		.filter((line) => line.startsWith("!! "))
		.join("\n");
	return porcelainPaths(ignored)
		.map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
		.filter((path) => !isGeneratedPath(path, GENERATED_PATHS) && (path.endsWith("/") || PAYLOAD_FILE_TYPES.test(path)));
}

function listFiles(dir: string): string[] {
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(path);
		}
	};
	if (existsSync(dir)) walk(dir);
	return files;
}

/** Source files rbxtsc may have compiled `out/<rel>` from. */
export function sourceCandidates(rel: string): string[] {
	const ext = extname(rel).toLowerCase();
	if (ext !== ".luau" && ext !== ".lua") return [rel];
	const stem = rel.slice(0, -ext.length);
	const candidates = [".ts", ".tsx", ".lua", ".luau", ".json"].map((e) => stem + e);
	if (stem === "init" || stem.endsWith("/init")) {
		const dir = stem.slice(0, -"init".length);
		candidates.push(`${dir}index.ts`, `${dir}index.tsx`, `${dir}init.lua`, `${dir}init.luau`);
	}
	return candidates;
}

/**
 * Compiled files under outDir that no tracked source (or TypeTorch's generated build.ts) explains. After a clean
 * build this is always empty unless rbxtsc compiled an untracked file.
 */
export function unexplainedOutputs(root: string, layout: TsLayout = tsLayout(root)): string[] {
	const rootRel = inside(root, layout.rootDir);
	if (!rootRel || !existsSync(layout.outDir)) return [];
	// Without --full-name, ls-files prints paths relative to the working directory (the project root).
	const tracked = new Set(
		(query(["git", "-c", "core.quotepath=off", "ls-files", "--", rootRel], root, false) ?? "").split(/\r?\n/).filter(Boolean),
	);
	tracked.add(BUILD_FILE);
	const unexplained: string[] = [];
	for (const file of listFiles(layout.outDir)) {
		if (/\.tsbuildinfo$/.test(file)) continue;
		const rel = relative(layout.outDir, file).replace(/\\/g, "/");
		if (!sourceCandidates(rel).some((candidate) => tracked.has(`${rootRel}/${candidate}`))) unexplained.push(`${inside(root, file) ?? rel}`);
	}
	return unexplained;
}

export interface BuildResult {
	meta: PayloadMeta;
	timings: Record<string, number>;
	target: BuildTarget;
}

export interface BuildOptions {
	branch?: string;
	channel?: Channel;
	/** `git clean -fdX` out/ and include/ first (deploy and upload always do; `build --clean`). */
	clean?: boolean;
	/**
	 * The deploy message and the branch's previous head, for the Notes attribute. Called after rbxtsc (so a registry
	 * read started with the build has usually finished). Default: no message, the previous head from the local log.
	 */
	notes?: (branch: string) => Promise<NotesInput> | NotesInput;
}

export interface NotesInput {
	message?: string;
	previous?: { commit?: string; commitHash?: string; sources?: Partial<BuildSources> };
}

/**
 * `deploy --no-build`: refuses a payload whose id was already deployed with other bytes. With hash ids that means two
 * payloads share their first 6 hash digits (a collision; rebuild). Entries without a recorded sha256 are legacy ids,
 * which never equal a new id.
 */
export function assertNoIdCollision(meta: PayloadMeta, earlier: EarlierArtifact[]) {
	const recorded = earlier.filter((e) => e.sha256 !== undefined);
	if (compareEarlier(meta.artifactId, meta.sha256, recorded) !== "different") return;
	throw new BuildError(
		`${meta.artifactId} was already deployed with a different payload (a 6-digit hash collision); build again to get a new id`,
	);
}

function tooMany(list: string[], max = 25): string {
	return list.slice(0, max).map((line) => `\n  - ${line}`).join("") + (list.length > max ? `\n  ... and ${list.length - max} more` : "");
}

export async function buildPayload(project: Project, options: BuildOptions = {}): Promise<BuildResult> {
	const root = project.root;
	const watch = new Stopwatch();
	const git = gitInfo(root, GENERATED_PATHS);
	if (!git.isRepo) warn("not a git repository: the build is marked dirty and uncommitted");
	const target = resolveTarget(project, git, options);
	const builtAt = new Date().toISOString();
	const sources = readSources(root, git);
	const debugMacros = debugMacrosFor(target.channel);
	debug(`target ${JSON.stringify({ ...target, git: { ...git, dirtyFiles: git.dirtyFiles.slice(0, 20) } })}`);

	const defaultProjectPath = join(root, "default.project.json");
	if (!existsSync(defaultProjectPath)) throw new BuildError(`no default.project.json in ${root}`);
	const projectJson = readJsonc(defaultProjectPath);
	for (const problem of checkPayloadTree(projectJson)) warn(`default.project.json: ${problem}`);
	const layout = tsLayout(root);
	// Hot assets (plans/13): the lockfile rides the payload as the Assets attribute, on the root and on Server (the
	// kernel drops the root; the framework reads Server), always ({"v":1,"assets":{}} without a lockfile). Read
	// first, so an invalid lockfile stops the build before rbxtsc.
	const assetsLock = readAssetsLock(root);
	const assetsJson = assetsAttribute(assetsLock);

	// 1. Clean state (S-M3): no stale or stray output, and no ignored file in a source dir, can reach a clean id.
	if (options.clean) {
		const cleaned = await watch.stage("clean", () => cleanBuildOutputs(root, git, buildOutputDirs(root, layout)));
		debug(`cleaned ${cleaned.join(", ") || "nothing"}`);
	}
	if (git.isRepo) {
		const ignored = ignoredSourceFiles(root, projectJson, layout);
		if (ignored.length > 0 && !git.dirty) {
			throw new BuildError(
				`git-ignored files in the payload's source dirs would ship in a "clean" artifact:${tooMany(ignored)}\nRemove them, or stop ignoring and commit them.`,
			);
		}
		if (ignored.length > 0) warn(`git-ignored files in the payload's source dirs (allowed only in a dirty build):${tooMany(ignored, 10)}`);
	}

	// 2. build.ts: the only file with $git()/$compileTime(); its text changes every build (timestamp line).
	const buildFile = join(root, BUILD_FILE);
	mkdirSync(dirname(buildFile), { recursive: true });
	writeFileSync(buildFile, buildFileSource({ dirty: git.dirty, channel: target.channel, builtAt, sources }));

	// 3. rbxtsc. TYPETORCH_SKIP_BUILD_INFO tells a repo build script that writes build.ts itself (the template's
	// scripts/build-info.ts, for builds without the CLI) to keep ours. Prod: debug macros stripped (S-L7).
	const compileEnv = {
		TYPETORCH_SKIP_BUILD_INFO: "1",
		TYPETORCH_CHANNEL: target.channel,
		TYPETORCH_DEBUG_MACROS: debugMacros ? "1" : "0",
	};
	const prodConfig = join(root, PROD_TSCONFIG);
	if (!debugMacros) {
		mkdirSync(join(root, OUT_DIR), { recursive: true });
		writeFileSync(join(root, STRIP_TRANSFORMER_FILE), STRIP_TRANSFORMER_SOURCE);
		writeFileSync(prodConfig, JSON.stringify(prodTsconfig(readTsconfig(root)), null, "\t"));
	}
	try {
		await watch.stage("rbxtsc", () => run(compileCommand(root, debugMacros ? undefined : PROD_TSCONFIG), root, compileEnv));
	} finally {
		rmSync(prodConfig, { force: true });
	}
	checkCompiledBuildFile(layout, root, git.commit);
	if (git.isRepo) {
		const unexplained = unexplainedOutputs(root, layout);
		if (unexplained.length > 0 && !git.dirty) {
			throw new BuildError(
				`compiled files that no tracked source explains would ship in a "clean" artifact:${tooMany(unexplained)}\nBuild with a clean out/ (deploy and upload always clean; \`typetorch build --clean\`).`,
			);
		}
		if (unexplained.length > 0) debug(`outputs without a tracked source (dirty build): ${unexplained.slice(0, 10).join(", ")}`);
	}

	// 4. Notes: the message and what changed since the branch's previous deploy (the dev menu reads this attribute;
	// asset descriptions get censored by Roblox's text filter).
	const notesInput: NotesInput = options.notes
		? await options.notes(target.branch)
		: { previous: liveHeads(undefined, readLocalLog(stateDir(root), project.config.universeId)).get(target.branch) };
	const changes = sourceChanges({
		root,
		branch: target.branch,
		git: { commitHash: git.commitHash, commit: git.commit, dirty: git.dirty },
		sources,
		previous: notesInput.previous,
	});
	const notes = payloadNotes({ message: notesInput.message, changes, sources, built: builtAt, branch: target.branch });

	// 5. rojo build, root stamped with the identity. The id's hash is the sha256 of the payload stamped with the id
	// without its hash (`<commit7>[-dirty]`); the final payload is stamped with the full id.
	const outDir = join(root, OUT_DIR);
	mkdirSync(outDir, { recursive: true });
	const genPath = join(root, GEN_PROJECT);
	const payloadPath = join(root, PAYLOAD_FILE);
	const attributes = (id: string): Record<string, string | number> => {
		const stamped: Record<string, string | number> = {
			ArtifactId: id,
			KernelApi: KERNEL_API,
			Channel: target.channel,
			Commit: git.commit,
			BuiltAt: Math.floor(Date.parse(builtAt) / 1000), // unix seconds, like $compileTime()
			SourceTemplate: sources.template,
		};
		if (sources.framework) stamped.SourceFramework = sources.framework;
		if (sources.kernel) stamped.SourceKernel = sources.kernel;
		stamped.Notes = notes;
		stamped[ASSETS_PAYLOAD_ATTRIBUTE] = assetsJson;
		return stamped;
	};
	const rojoBuild = async (id: string): Promise<Uint8Array> => {
		debug(`rojo build stamped ArtifactId=${id}`);
		const children = { [ASSETS_PAYLOAD_FOLDER]: { [ASSETS_PAYLOAD_ATTRIBUTE]: assetsJson } };
		writeFileSync(genPath, JSON.stringify(stampProject(projectJson, attributes(id), children), null, "\t"));
		try {
			await run([rojoBinary(), "build", GEN_PROJECT, "-o", PAYLOAD_FILE], root);
		} finally {
			rmSync(genPath, { force: true });
		}
		return new Uint8Array(readFileSync(payloadPath));
	};
	let id = "";
	let bytes: Uint8Array = new Uint8Array();
	await watch.stage("rojo", async () => {
		const provisional = await rojoBuild(provisionalArtifactId({ commit: git.commit, dirty: git.dirty }));
		id = makeArtifactId({ commit: git.commit, dirty: git.dirty, sha256: sha256(provisional) });
		bytes = await rojoBuild(id);
	});

	// 6. Only Folders and ModuleScripts under one Model (S-L4): nothing in an upload can run by itself.
	const contents = await watch.stage("check", () => checkPayloadContents(bytes));
	const problems = [...contents.rootProblems, ...contents.disallowed];
	if (problems.length > 0) {
		rmSync(payloadPath, { force: true });
		throw new BuildError(
			`the payload may hold only Folders and ModuleScripts under one Model root; found:${tooMany(problems, 40)}\nRemove them from the synced folders (or from default.project.json).`,
		);
	}

	const meta: PayloadMeta = {
		artifactId: id,
		project: project.config.project,
		channel: target.channel,
		branch: target.branch,
		gitBranch: git.gitBranch,
		commit: git.commit,
		commitHash: git.commitHash,
		dirty: git.dirty,
		builtAt,
		bytes: bytes.length,
		sha256: sha256(bytes),
		kernelApi: KERNEL_API,
		file: PAYLOAD_FILE,
		sources,
		debugMacros,
		modules: contents.modules,
		notes: { ...(notesInput.message ? { message: notesInput.message } : {}), changes: JSON.parse(notes).changes },
		assets: { count: Object.keys(assetsLock?.assets ?? {}).length, ...(assetsLock ? { placeVersion: assetsLock.placeVersion } : {}) },
	};
	writeFileSync(join(root, PAYLOAD_META), JSON.stringify(meta, null, "\t") + "\n");
	return { meta, timings: watch.total(), target };
}

/** Reads the last build's metadata and checks the .rbxm still matches it. */
export function readBuiltPayload(root: string): { meta: PayloadMeta; bytes: Uint8Array } {
	const metaPath = join(root, PAYLOAD_META);
	const payloadPath = join(root, PAYLOAD_FILE);
	if (!existsSync(metaPath) || !existsSync(payloadPath)) {
		throw new BuildError(`no build in ${OUT_DIR}/ (run \`typetorch build\` first, or drop --no-build)`);
	}
	const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PayloadMeta;
	const bytes = new Uint8Array(readFileSync(payloadPath));
	if (sha256(bytes) !== meta.sha256) {
		throw new BuildError(`${PAYLOAD_FILE} does not match ${PAYLOAD_META} (sha256 differs): build again`);
	}
	const contents = checkPayloadContents(bytes);
	if (contents.rootProblems.length + contents.disallowed.length > 0) {
		throw new BuildError(`${PAYLOAD_FILE} holds more than Folders and ModuleScripts: build again`);
	}
	return { meta, bytes };
}

export function payloadBytes(root: string): Uint8Array {
	return new Uint8Array(readFileSync(join(root, PAYLOAD_FILE)));
}
