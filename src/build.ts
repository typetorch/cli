/**
 * `typetorch build`: git identity -> src/shared/build.ts -> rbxtsc -> rojo build (root stamped with $attributes)
 * -> .typetorch/payload.rbxm + payload.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Project } from "./config";
import { readLocalLog } from "./deployments";
import { gitInfo, type GitInfo } from "./git";
import { isRecord, parseJsonc } from "./json";
import { debug, Stopwatch, warn } from "./log";
import {
	artifactId as makeArtifactId,
	branchChannel,
	branchFromGit,
	branchNameError,
	buildFileSource,
	chooseRevision,
	compareEarlier,
	latestRevision,
	provisionalArtifactId,
	type Channel,
	type EarlierArtifact,
} from "./naming";
import { run } from "./proc";

export const KERNEL_API = 1;
export const BUILD_FILE = "src/shared/build.ts";
/** The stamped copy of default.project.json. It must sit next to the original (Rojo resolves $path and
 * globIgnorePaths relative to the project file), and is deleted after the build. */
export const GEN_PROJECT = ".payload.gen.project.json";
export const OUT_DIR = ".typetorch";
export const PAYLOAD_FILE = `${OUT_DIR}/payload.rbxm`;
export const PAYLOAD_META = `${OUT_DIR}/payload.json`;
/** Files TypeTorch writes inside the repo; they never make a build "dirty". */
export const GENERATED_PATHS = [BUILD_FILE, GEN_PROJECT, `${OUT_DIR}/`];

export interface PayloadMeta {
	artifactId: string;
	/** 2+ when the id carries a `.r<N>` suffix (this commit was deployed before with other bytes); absent otherwise. */
	revision?: number;
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
	sha256: string;
	kernelApi: number;
	/** Relative to the project root. */
	file: string;
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

/** default.project.json with the payload identity stamped on the root (Rojo `$attributes`). */
export function stampProject(projectJson: any, attributes: Record<string, string | number>): any {
	if (!isRecord(projectJson) || !isRecord(projectJson.tree)) throw new BuildError("default.project.json has no tree");
	const tree = projectJson.tree as Record<string, unknown>;
	const existing = isRecord(tree.$attributes) ? tree.$attributes : {};
	return { ...projectJson, tree: { ...tree, $attributes: { ...existing, ...attributes } } };
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

/** The rbxtsc command: the repo's `build` script when it has one, else the local roblox-ts binary. */
export function compileCommand(root: string): string[] {
	let scripts: Record<string, string> = {};
	try {
		scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.scripts ?? {};
	} catch {}
	if (typeof scripts.build === "string") return ["bun", "run", "build"];
	if (!existsSync(join(root, "node_modules", "roblox-ts"))) {
		throw new BuildError("roblox-ts is not installed here (no node_modules/roblox-ts): run `bun install`");
	}
	return ["bun", "run", "rbxtsc"];
}

export function rojoBinary(): string {
	return process.env.TYPETORCH_ROJO || "rojo";
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface BuildResult {
	meta: PayloadMeta;
	timings: Record<string, number>;
	target: BuildTarget;
}

export interface BuildOptions {
	branch?: string;
	channel?: Channel;
	/**
	 * Earlier deployed artifacts, to pick a clean build's revision (default: the local log). Called after rbxtsc, so
	 * a registry read started with the build has usually finished by then. Not called for dirty builds.
	 */
	earlier?: () => Promise<EarlierArtifact[]> | EarlierArtifact[];
}

/** Refuses to reuse a built payload whose clean id was already deployed with other bytes (`--no-build`). */
export function assertNotRedeployedWithOtherBytes(meta: PayloadMeta, earlier: EarlierArtifact[]) {
	if (meta.dirty) return; // a dirty id is named by the payload's own hash
	if (compareEarlier(meta.artifactId, meta.sha256, earlier) !== "different") return;
	throw new BuildError(
		`${meta.artifactId} was already deployed with a different payload (or one logged without a sha256); build again (drop --no-build) to give it a new revision`,
	);
}

export async function buildPayload(project: Project, options: BuildOptions = {}): Promise<BuildResult> {
	const root = project.root;
	const watch = new Stopwatch();
	const git = gitInfo(root, GENERATED_PATHS);
	if (!git.isRepo) warn("not a git repository: the build is marked dirty and uncommitted");
	const target = resolveTarget(project, git, options);
	const builtAt = new Date().toISOString();
	debug(`target ${JSON.stringify({ ...target, git: { ...git, dirtyFiles: git.dirtyFiles.slice(0, 20) } })}`);

	const defaultProjectPath = join(root, "default.project.json");
	if (!existsSync(defaultProjectPath)) throw new BuildError(`no default.project.json in ${root}`);
	const projectJson = readJsonc(defaultProjectPath);
	for (const problem of checkPayloadTree(projectJson)) warn(`default.project.json: ${problem}`);

	// 1. build.ts: the only file with $git()/$compileTime(); its text changes every build (timestamp line).
	const buildFile = join(root, BUILD_FILE);
	mkdirSync(dirname(buildFile), { recursive: true });
	writeFileSync(buildFile, buildFileSource({ dirty: git.dirty, channel: target.channel, builtAt }));
	const layout = tsLayout(root);

	// 2. rbxtsc. TYPETORCH_SKIP_BUILD_INFO tells a repo build script that writes build.ts itself (the template's
	// scripts/build-info.ts, for builds without the CLI) to keep ours.
	await watch.stage("rbxtsc", () => run(compileCommand(root), root, { TYPETORCH_SKIP_BUILD_INFO: "1" }));
	checkCompiledBuildFile(layout, root, git.commit);

	// 3. rojo build, root stamped with the artifact identity
	const outDir = join(root, OUT_DIR);
	mkdirSync(outDir, { recursive: true });
	const genPath = join(root, GEN_PROJECT);
	const payloadPath = join(root, PAYLOAD_FILE);
	const attributes = (id: string) => ({
		ArtifactId: id,
		KernelApi: KERNEL_API,
		Channel: target.channel,
		Commit: git.commit,
		BuiltAt: Math.floor(Date.parse(builtAt) / 1000), // unix seconds, like $compileTime()
	});
	const rojoBuild = async (id: string): Promise<Uint8Array> => {
		debug(`rojo build stamped ArtifactId=${id}`);
		writeFileSync(genPath, JSON.stringify(stampProject(projectJson, attributes(id)), null, "\t"));
		try {
			await run([rojoBinary(), "build", GEN_PROJECT, "-o", PAYLOAD_FILE], root);
		} finally {
			rmSync(genPath, { force: true });
		}
		return new Uint8Array(readFileSync(payloadPath));
	};
	// Earlier artifacts (clean builds only): the registry read a deploy starts alongside the build is awaited here.
	const earlier = git.dirty ? [] : options.earlier ? await options.earlier() : readLocalLog(root, project.config.universeId);
	let id: string;
	let revision = 1;
	let bytes: Uint8Array;
	await watch.stage("rojo", async () => {
		if (git.dirty) {
			// A dirty id names the payload by its hash, which depends on the id stamped inside: hash a build stamped
			// with the provisional id, then stamp the final id.
			const provisional = await rojoBuild(provisionalArtifactId({ channel: target.channel, commit: git.commit }));
			id = makeArtifactId({ channel: target.channel, commit: git.commit, dirty: true, sha256: sha256(provisional) });
			bytes = await rojoBuild(id);
			return;
		}
		// A clean id gets a revision when this commit was deployed before with other bytes. Stamp the newest known id
		// of the family (else the base id) and hash: identical bytes keep that id, anything else is restamped with the
		// next revision.
		const base = makeArtifactId({ channel: target.channel, commit: git.commit, dirty: false });
		const stampedId = latestRevision(base, earlier)?.artifactId ?? base;
		bytes = await rojoBuild(stampedId);
		const chosen = chooseRevision({ base, stampedId, sha256: sha256(bytes), earlier });
		id = chosen.artifactId;
		revision = chosen.revision;
		if (id !== stampedId) {
			debug(`${stampedId} was deployed before with other bytes; building ${id}`);
			bytes = await rojoBuild(id);
		}
	});

	const meta: PayloadMeta = {
		artifactId: id!,
		...(revision > 1 ? { revision } : {}),
		project: project.config.project,
		channel: target.channel,
		branch: target.branch,
		gitBranch: git.gitBranch,
		commit: git.commit,
		commitHash: git.commitHash,
		dirty: git.dirty,
		builtAt,
		bytes: bytes!.length,
		sha256: sha256(bytes!),
		kernelApi: KERNEL_API,
		file: PAYLOAD_FILE,
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
	return { meta, bytes };
}

export function payloadBytes(root: string): Uint8Array {
	return new Uint8Array(readFileSync(join(root, PAYLOAD_FILE)));
}
