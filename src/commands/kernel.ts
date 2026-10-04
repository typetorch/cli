/**
 * `typetorch kernel deploy`: check, identify and publish the kernel place.
 *   1. `lune run scripts/check.luau` in the kernel package (syntax check of every kernel Luau file), before anything.
 *   2. Identity (security audit S-L5): the version must agree in package.json and src/shared/Constants.luau
 *      (KERNEL_VERSION, KERNEL_API = package.json typetorch.kernelApi), and a content hash covers place.project.json
 *      and every file under src/ (LF line endings). A git checkout must be clean and tagged `v<version>`
 *      (--allow-dirty / --allow-untagged override); a packaged kernel is identified by its version, hash, and the
 *      commit the template's packages manifest recorded. Version and hash are printed and recorded.
 *   3. Build the place with the identity stamped on ServerScriptService.TypeTorchKernel (attributes KernelVersion,
 *      KernelHash, KernelCommit).
 *   4. Publish: only with --replace-place --yes, which REPLACES THE WHOLE PLACE (it wipes Studio/Team Create content).
 *      The place version before and after go to `<state dir>/kernel-deploys.jsonl`.
 *
 * TODO(plans/13 "Kernel deploy = patch, not replace"): the default mode should patch only the TypeTorch-owned slots
 * into an explicit base version (luau engine through a Luau Execution task + SavePlaceAsync, or the file engine), with
 * a dry-run diff, an outside-slot manifest check, a backup and a verify step. It needs spike S12 first; until then the
 * only publishing mode is --replace-place.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { luneBinary, OUT_DIR, rojoBinary } from "../build";
import type { Project } from "../config";
import { gitInfo } from "../git";
import { isRecord, parseJsonc } from "../json";
import { bold, dim, emitJson, formatBytes, formatSeconds, info, isJson, red, Stopwatch, warn } from "../log";
import { capture, query, run } from "../proc";
import { openCloud, project, projectStateDir } from "./common";

export const kernelFlags = {
	kernel: "string",
	"dry-run": "boolean",
	"replace-place": "boolean",
	yes: "boolean",
	"allow-dirty": "boolean",
	"allow-untagged": "boolean",
} as const;
export const PLACE_FILE = `${OUT_DIR}/place.rbxl`;
export const PLACE_GEN_PROJECT = `${OUT_DIR}/place.gen.project.json`;
export const KERNEL_LOG = "kernel-deploys.jsonl";
/** The folder the kernel's server scripts live in (plans/13 "owned slots"); identity attributes go on it. */
export const KERNEL_SLOT = ["ServerScriptService", "TypeTorchKernel"] as const;

export class KernelCheckError extends Error {
	override name = "KernelCheckError";
}

/** --kernel, else typetorch.json "kernel", else node_modules/@typetorch/kernel, else ../kernel (sibling checkout). */
export function resolveKernelDir(proj: Project, flag?: string): string {
	const candidates = flag
		? [flag]
		: proj.config.kernel
			? [proj.config.kernel]
			: ["node_modules/@typetorch/kernel", "../kernel"];
	for (const candidate of candidates) {
		const dir = resolve(proj.root, candidate);
		if (existsSync(join(dir, "place.project.json"))) return dir;
	}
	throw new UsageError(
		`no kernel place project found (looked for place.project.json in ${candidates.join(", ")}); pass --kernel <dir>`,
	);
}

export interface KernelIdentity {
	version: string;
	api?: number;
	/** sha256 (hex) of place.project.json and src/ (sorted paths, LF line endings). */
	hash: string;
	files: number;
	/** Where the identity came from: a git checkout, or a package (node_modules). */
	source: "git" | "package";
	commit?: string;
	dirty?: boolean;
	tag?: string;
}

function listFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(path, base));
		else out.push(relative(base, path).replace(/\\/g, "/"));
	}
	return out;
}

/** The kernel content hash: place.project.json + every file under src/, sorted by path, CRLF normalized to LF. */
export function kernelContentHash(kernelDir: string): { hash: string; files: number } {
	const files = ["place.project.json", ...listFiles(join(kernelDir, "src")).map((p) => `src/${p}`)].sort();
	const hash = createHash("sha256");
	for (const file of files) {
		const text = readFileSync(join(kernelDir, file), "utf8").replace(/\r\n/g, "\n");
		hash.update(`${file}\0${text}\0`);
	}
	return { hash: hash.digest("hex"), files: files.length };
}

/** KERNEL_VERSION and KERNEL_API from src/shared/Constants.luau. */
export function kernelConstants(text: string): { version?: string; api?: number } {
	const version = /KERNEL_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1];
	const api = /KERNEL_API\s*=\s*(\d+)/.exec(text)?.[1];
	return { version, api: api === undefined ? undefined : Number(api) };
}

/** Version agreement between package.json and Constants.luau; returns the problems. */
export function versionProblems(pkg: any, constants: { version?: string; api?: number }): string[] {
	const problems: string[] = [];
	const version = typeof pkg?.version === "string" ? pkg.version : undefined;
	if (!version) problems.push("package.json has no version");
	if (!constants.version) problems.push("src/shared/Constants.luau has no KERNEL_VERSION");
	if (version && constants.version && version !== constants.version) {
		problems.push(`package.json version ${version} != Constants.luau KERNEL_VERSION ${constants.version}`);
	}
	const api = pkg?.typetorch?.kernelApi;
	if (typeof api === "number" && constants.api !== undefined && api !== constants.api) {
		problems.push(`package.json typetorch.kernelApi ${api} != Constants.luau KERNEL_API ${constants.api}`);
	}
	return problems;
}

/** Reads and checks the kernel's identity (version, hash, provenance). Throws KernelCheckError on problems. */
export function kernelIdentity(proj: Project, kernelDir: string, options: { allowDirty: boolean; allowUntagged: boolean }): KernelIdentity {
	let pkg: any;
	try {
		pkg = JSON.parse(readFileSync(join(kernelDir, "package.json"), "utf8"));
	} catch {
		throw new KernelCheckError(`${kernelDir}/package.json is missing or invalid`);
	}
	const constantsPath = join(kernelDir, "src", "shared", "Constants.luau");
	const constants = existsSync(constantsPath) ? kernelConstants(readFileSync(constantsPath, "utf8")) : {};
	const problems = versionProblems(pkg, constants);
	if (problems.length > 0) throw new KernelCheckError(`kernel version check failed:\n  - ${problems.join("\n  - ")}`);
	const { hash, files } = kernelContentHash(kernelDir);
	const identity: KernelIdentity = { version: pkg.version, api: constants.api, hash, files, source: "package" };

	// A git checkout of the kernel (its own repo, with the place project tracked): clean and tagged.
	const tracked = query(["git", "ls-files", "--error-unmatch", "place.project.json"], kernelDir) !== undefined;
	if (tracked) {
		const git = gitInfo(kernelDir);
		identity.source = "git";
		identity.commit = git.commit;
		identity.dirty = (query(["git", "status", "--porcelain", "--", "."], kernelDir) ?? "") !== "";
		const tags = (query(["git", "tag", "--points-at", "HEAD"], kernelDir) ?? "").split(/\r?\n/).filter(Boolean);
		identity.tag = tags.find((tag) => tag === `v${identity.version}` || tag === `kernel-v${identity.version}`);
		if (identity.dirty && !options.allowDirty) {
			throw new KernelCheckError(`the kernel checkout ${kernelDir} has uncommitted changes; commit them (or pass --allow-dirty)`);
		}
		if (!identity.tag && !options.allowUntagged) {
			throw new KernelCheckError(
				`kernel ${identity.version} @ ${identity.commit} is not tagged v${identity.version}; publish only tagged kernels (git tag v${identity.version}), or pass --allow-untagged`,
			);
		}
		return identity;
	}
	// A package (node_modules): the template's packages manifest says which commit it was packed from.
	try {
		const manifest = JSON.parse(readFileSync(join(proj.root, OUT_DIR, "packages", "manifest.json"), "utf8"));
		const packed = manifest?.packages?.kernel;
		if (isRecord(packed) && typeof packed.commit === "string") {
			identity.commit = packed.commit.slice(0, 7);
			identity.dirty = packed.dirty === true;
		}
	} catch {}
	if (identity.dirty && !options.allowDirty) {
		throw new KernelCheckError(`the kernel package was packed from a dirty checkout (${identity.commit}*); repack from a clean commit (or pass --allow-dirty)`);
	}
	return identity;
}

/** Rewrites every `$path` to an absolute path, so the stamped copy can live outside the kernel dir. */
export function absolutePaths(node: unknown, base: string): unknown {
	if (Array.isArray(node)) return node.map((child) => absolutePaths(child, base));
	if (!isRecord(node)) return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		out[key] = key === "$path" && typeof value === "string" ? resolve(base, value).replace(/\\/g, "/") : absolutePaths(value, base);
	}
	return out;
}

/** The place project with the identity attributes on ServerScriptService.TypeTorchKernel. */
export function stampKernelProject(projectJson: any, kernelDir: string, attributes: Record<string, string>): { project: any; stamped: boolean } {
	const copy = absolutePaths(projectJson, kernelDir) as any;
	let node = copy?.tree;
	for (const name of KERNEL_SLOT) node = isRecord(node) ? node[name] : undefined;
	if (!isRecord(node)) return { project: copy, stamped: false };
	node.$attributes = { ...(isRecord(node.$attributes) ? node.$attributes : {}), ...attributes };
	return { project: copy, stamped: true };
}

function logKernel(dir: string, record: Record<string, unknown>) {
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, KERNEL_LOG), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

export async function kernelCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub !== "deploy") throw new UsageError(`unknown kernel subcommand "${sub ?? ""}" (only "deploy")`);
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const replacePlace = flagBool(args, "replace-place");
	const yes = flagBool(args, "yes");
	const kernelDir = resolveKernelDir(proj, flagString(args, "kernel"));
	const watch = new Stopwatch();
	const where = `universe ${proj.config.universeId}, place ${proj.config.placeId}`;

	// 1. Syntax check, before anything else.
	if (!existsSync(join(kernelDir, "scripts", "check.luau"))) {
		throw new KernelCheckError(
			`${kernelDir} has no scripts/check.luau; the kernel package must ship it (or pass --kernel <kernel checkout>)`,
		);
	}
	const check = await watch.stage("check", () => capture([luneBinary(), "run", "scripts/check.luau"], kernelDir));
	const checkSummary = check.stdout.trim().split(/\r?\n/).pop() ?? "";
	if (check.exitCode !== 0) {
		const failed = check.stdout.split(/\r?\n/).filter((line) => line.startsWith("FAIL") || line.startsWith("      "));
		throw new KernelCheckError(
			`kernel check failed (lune run scripts/check.luau in ${kernelDir}, exit ${check.exitCode}): ${checkSummary || check.stderr.trim().split(/\r?\n/).slice(-5).join(" ")}${failed.length ? `\n${failed.slice(0, 20).join("\n")}` : ""}`,
		);
	}
	info(`  check    ${formatSeconds(watch.timings.check)}  ${checkSummary}`);

	// 2. Identity.
	const identity = kernelIdentity(proj, kernelDir, { allowDirty: flagBool(args, "allow-dirty"), allowUntagged: flagBool(args, "allow-untagged") });
	const provenance =
		identity.source === "git"
			? `git ${identity.commit}${identity.dirty ? "*" : ""}${identity.tag ? ` (tag ${identity.tag})` : " (untagged)"}`
			: `package${identity.commit ? ` packed from ${identity.commit}${identity.dirty ? "*" : ""}` : ""}`;
	info(`  kernel   ${identity.version} (api ${identity.api ?? "?"})  hash ${identity.hash.slice(0, 16)}  ${identity.files} files  ${provenance}`);

	// 3. Build, with the identity stamped on the kernel slot.
	const attributes: Record<string, string> = { KernelVersion: identity.version, KernelHash: identity.hash };
	if (identity.commit) attributes.KernelCommit = `${identity.commit}${identity.dirty ? "*" : ""}`;
	mkdirSync(join(proj.root, OUT_DIR), { recursive: true });
	const placeProject = parseJsonc(readFileSync(join(kernelDir, "place.project.json"), "utf8"));
	const { project: stamped, stamped: didStamp } = stampKernelProject(placeProject, kernelDir, attributes);
	if (!didStamp) warn(`place.project.json has no ${KERNEL_SLOT.join(".")}; the kernel identity attributes were not stamped`);
	const genPath = join(proj.root, PLACE_GEN_PROJECT);
	writeFileSync(genPath, JSON.stringify(stamped, null, "\t"));
	try {
		await watch.stage("build", () => run([rojoBinary(), "build", PLACE_GEN_PROJECT, "-o", PLACE_FILE], proj.root));
	} finally {
		rmSync(genPath, { force: true });
	}
	const bytes = new Uint8Array(readFileSync(join(proj.root, PLACE_FILE)));
	info(`  build    ${formatSeconds(watch.timings.build)}  ${relative(proj.root, join(kernelDir, "place.project.json"))} -> ${PLACE_FILE}  ${formatBytes(bytes.length)}`);

	const summary = {
		kernelDir,
		kernel: identity,
		file: PLACE_FILE,
		bytes: bytes.length,
		universeId: proj.config.universeId,
		placeId: proj.config.placeId,
	};

	// 4. Publish mode. Patching (plans/13) is not built yet: see the TODO at the top.
	if (!replacePlace) {
		const text = "patching only the kernel slots (plans/13) is not implemented yet (it needs spike S12); --replace-place publishes the whole kernel place instead, which WIPES Studio/Team Create content";
		if (dryRun) {
			if (isJson()) return emitJson({ dryRun: true, mode: "patch (not implemented)", ...summary });
			info(bold(`dry run: kernel ${identity.version} checked and built; nothing published`));
			info(dim(`  ${text}`));
			return;
		}
		throw new UsageError(text);
	}
	warn(`--replace-place REPLACES THE WHOLE PLACE (${where}) with the kernel place: every Studio/Team Create edit (maps, UI, builders' work) is wiped from the live version. It stays in the place's version history.`);
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, mode: "replace-place", ...summary });
		info(bold(`dry run: would publish ${PLACE_FILE} to ${where}, replacing the place`));
		return;
	}
	if (!yes) {
		throw new UsageError(`refusing to publish without --yes (this replaces the whole place at ${where}); check the output above, then run again with --yes`);
	}

	const oc = openCloud("place")!;
	const stateDir = projectStateDir(proj);
	let before: number | undefined;
	let beforeError: string | undefined;
	try {
		before = await oc.latestPlaceVersion(proj.config.placeId);
	} catch (error) {
		beforeError = (error as Error).message;
		warn(`could not read the place's current version (the place key needs asset:read): ${beforeError}`);
	}
	const by = gitInfo(proj.root).userName;
	const record = {
		universeId: proj.config.universeId,
		placeId: proj.config.placeId,
		mode: "replace-place",
		kernelVersion: identity.version,
		kernelApi: identity.api,
		kernelHash: identity.hash,
		kernelCommit: identity.commit,
		kernelDirty: identity.dirty,
		kernelTag: identity.tag,
		kernelSource: identity.source,
		placeVersionBefore: before ?? null,
		...(beforeError ? { placeVersionBeforeError: beforeError.slice(0, 300) } : {}),
		by,
	};
	logKernel(stateDir, { event: "kernel-publishing", ...record });
	let response: any;
	try {
		response = await watch.stage("publish", () => oc.publishPlace(proj.config.universeId, proj.config.placeId, bytes));
	} catch (error) {
		logKernel(stateDir, { event: "kernel-failed", ...record, error: (error as Error).message.slice(0, 500) });
		throw error;
	}
	const after = typeof response?.versionNumber === "number" ? response.versionNumber : null;
	logKernel(stateDir, { event: "kernel-published", ...record, placeVersionAfter: after, timings: watch.total() });
	const timings = watch.total();
	if (isJson()) return emitJson({ ...summary, placeVersionBefore: before ?? null, placeVersionAfter: after, timings });
	info(`  publish  ${formatSeconds(timings.publish)}  place version ${before ?? "?"} -> ${after ?? "?"}`);
	info(bold(`published kernel ${identity.version} (hash ${identity.hash.slice(0, 16)}) to ${where}; servers run it after they restart`));
	info(dim(`  recorded in ${join(stateDir, KERNEL_LOG)}; revert from the place's version history in Creator Hub if needed`));
}
