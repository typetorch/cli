/**
 * `typetorch kernel deploy`: check, identify, build and publish the kernel into the place.
 *   1. `lune run scripts/check.luau` in the kernel package (syntax check of every kernel Luau file), before anything.
 *   2. Identity (security audit S-L5): the version must agree in package.json and src/shared/Constants.luau
 *      (KERNEL_VERSION, KERNEL_API = package.json typetorch.kernelApi), and a content hash covers place.project.json
 *      and every file under src/ (LF line endings). A git checkout must be clean and tagged `v<version>`
 *      (--allow-dirty / --allow-untagged override); a packaged kernel is identified by its version, hash, and the
 *      commit the template's packages manifest recorded. Version and hash are printed and recorded.
 *   3. Build the place with the identity stamped on ServerScriptService.TypeTorchKernel (attributes KernelVersion,
 *      KernelHash, KernelCommit) and the signing trust roots (plans/03 "Key asset"): KeyAssetId (number) and
 *      FallbackPublicKey (string), from typetorch.json "keyAssetId" / "fallbackPublicKey". Publishing refuses without
 *      both (prod servers could not verify any deploy); a fallback key file that doesn't match is refused too.
 *      Also BootstrapHeads (string): the JSON of the current prod-channel heads at deploy time,
 *      {"<branch>":{"a":assetId,"s":seq,"i":"artifactId"}}, from the local log. The
 *      kernel trusts exactly those heads unsigned (heads stored before signing have no sig); anything newer must be
 *      signed (plans/03 "Bootstrap heads").
 *      Kernel 0.3.6 (never an empty server): the BACKUP BUILD. The prod head's payload, kept locally at upload
 *      (payloads.ts: `<state dir>/payloads/<artifactId>.rbxm`), stamped with BackupArtifactId/Seq/Branch/Channel/At,
 *      goes in as `ServerStorage.TypeTorchBackup`: a slot of the stamped project, so the patch replaces it (refreshed by
 *      every kernel deploy) and `--replace-place` ships it too. Without a kept payload the slot isn't declared: the
 *      place keeps the backup it has, with a warning (`doctor` shows its artifact and age). `--no-backup` skips it.
 *   4. Publish, in one of two modes:
 *      - PATCH (default, `--patch`; plans/13 "Kernel deploy = patch, not replace", spike S12): download the place's
 *        current version (`--place-file`, a copy downloaded in Studio; or Open Cloud Asset Delivery, whose scope
 *        legacy-asset:manage can't be granted to API keys today), save it to
 *        `.typetorch/place-backups/<placeId>-v<n>.rbxl`, replace ONLY the kernel slots (the TypeTorch* children of
 *        services in the kernel's place.project.json) and the service settings it declares, keep everything else byte
 *        for byte (placepatch.ts), verify twice (the CLI's binary reader and Lune), write
 *        `.typetorch/place-patches/<placeId>-v<n>-kernel-<version>.rbxl`, show a summary, ask y/N (or --yes), check
 *        that nobody published meanwhile, publish. A place without a kernel needs --install. `--dry-run` stops before
 *        the publish. `typetorch kernel restore <file>` publishes a backup (or any place file) back.
 *      - REPLACE (`--replace-place --yes`, for the template/test place only): publishes the whole kernel place, which
 *        wipes Studio/Team Create content.
 *      The place version before and after go to `<state dir>/kernel-deploys.jsonl`.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { luneBinary, OUT_DIR, rojoBinary } from "../build.ts";
import type { Project } from "../config.ts";
import { gitInfo } from "../git.ts";
import { interaction } from "../interact.ts";
import { isRecord, parseJsonc } from "../json.ts";
import { inspectKeyFile } from "../keyfiles.ts";
import { BACKUP_DIR, chooseBase, kernelLayout, LunePatchError, PATCH_DIR, runLunePatch, runLuneVerify, summaryLines, writeLuneScript, type LuneVerification } from "../kernelpatch.ts";
import { bold, dim, emitJson, formatBytes, formatSeconds, info, isJson, Stopwatch, warn } from "../log.ts";
import { ApiError, type OpenCloud } from "../opencloud.ts";
import { patchPlace, PlaceFile, PlacePatchError, sha256Hex, summarizePlace, verifyPatch, type PatchReport, type SlotRef } from "../placepatch.ts";
import { capture, query, run } from "../proc.ts";
import { branchChannel } from "../naming.ts";
import { RbxmError } from "../rbxm.ts";
import { KEY_FILE_FLAGS, openCloud, project, projectStateDir, noteRegistryFlags, readHistory, signingKeyPaths, type History } from "./common.ts";
import { addBackupToProject, BACKUP_FILE, BACKUP_SLOT, BackupError, backupHead, backupRbxm, findKeptPayload, PAYLOADS_DIR, type BackupInfo } from "../payloads.ts";

export const kernelFlags = {
	kernel: "string",
	"dry-run": "boolean",
	patch: "boolean",
	"replace-place": "boolean",
	install: "boolean",
	base: "string",
	engine: "string",
	"place-file": "string",
	yes: "boolean",
	"allow-dirty": "boolean",
	"allow-untagged": "boolean",
	"fallback-key-file": KEY_FILE_FLAGS["fallback-key-file"],
	"no-registry": "boolean",
	/** Kernel 0.3.6: don't bake the backup build (patch mode keeps the place's current one). */
	"no-backup": "boolean",
	/**
	 * Turn `loadstring` on in the place (ServerScriptService.LoadStringEnabled = true): only remote-claude's run_luau needs
	 * it (the test place). Without it a patch leaves the place's own value and --replace-place publishes it off.
	 */
	loadstring: "boolean",
} as const;

/** One bootstrap head: what the kernel trusts unsigned for that branch (plans/03 "Bootstrap heads"). */
export interface BootstrapHead {
	a: number;
	s: number;
	i: string;
}

/** The current head of every prod-channel branch, keyed by branch (sorted), for the BootstrapHeads attribute. */
export function bootstrapHeads(proj: Pick<Project, "config">, history: Pick<History, "heads">): Record<string, BootstrapHead> {
	const out: Record<string, BootstrapHead> = {};
	for (const branch of [...history.heads.keys()].sort()) {
		const head = history.heads.get(branch)!;
		if (branchChannel(proj.config, branch) !== "prod") continue;
		out[branch] = { a: head.assetId, s: head.seq, i: head.artifactId };
	}
	return out;
}
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

/**
 * The signing attributes `kernel deploy` stamps (plans/03): KeyAssetId and FallbackPublicKey, plus the problems that
 * block a publish (missing values, a fallback key file that doesn't match typetorch.json).
 */
export function signingAttributes(proj: Pick<Project, "config">, fallbackKeyFile: string): { attributes: Record<string, string | number>; problems: string[]; warnings: string[] } {
	const c = proj.config;
	const attributes: Record<string, string | number> = {};
	const problems: string[] = [];
	const warnings: string[] = [];
	if (c.keyAssetId) attributes.KeyAssetId = c.keyAssetId;
	else problems.push('typetorch.json has no "keyAssetId" (run `typetorch keys init`): prod servers would have no main keys');
	if (c.fallbackPublicKey) attributes.FallbackPublicKey = c.fallbackPublicKey;
	else problems.push('typetorch.json has no "fallbackPublicKey" (run `typetorch keys init --fallback`): prod servers would have no fallback key');
	if (c.fallbackPublicKey) {
		if ((c.revokedKeys ?? []).includes(c.fallbackPublicKey)) problems.push(`the fallback key ${c.fallbackPublicKey} is in "revokedKeys"; run \`typetorch keys init --fallback --force\``);
		const file = inspectKeyFile(fallbackKeyFile, { role: "fallback", universeId: c.universeId });
		if (file.missing) warnings.push(`no fallback key file at ${fallbackKeyFile}: this machine can't sign prod deploys with the key being baked in`);
		else if (file.error) problems.push(file.error);
		else if (file.info?.publicKey !== c.fallbackPublicKey) {
			problems.push(`the fallback key file ${fallbackKeyFile} (public ${file.info?.publicKey}) doesn't match typetorch.json "fallbackPublicKey" ${c.fallbackPublicKey}`);
		}
	}
	return { attributes, problems, warnings };
}

/**
 * The place project with `ServerScriptService.$properties.LoadStringEnabled` set to `on` (a copy). The kernel build then
 * carries the value the patch copies (with --loadstring) and --replace-place publishes.
 */
export function withLoadstring(projectJson: unknown, on: boolean): unknown {
	const copy = JSON.parse(JSON.stringify(projectJson));
	const tree = isRecord(copy) ? copy.tree : undefined;
	if (!isRecord(tree)) return copy;
	const key = Object.keys(tree).find((name) => isRecord(tree[name]) && ((tree[name] as Record<string, unknown>).$className ?? name) === "ServerScriptService");
	const node = (key ? tree[key] : (tree.ServerScriptService = { $className: "ServerScriptService" })) as Record<string, unknown>;
	node.$properties = { ...(isRecord(node.$properties) ? node.$properties : {}), LoadStringEnabled: on };
	return copy;
}

/** The place project with the identity attributes on ServerScriptService.TypeTorchKernel. */
export function stampKernelProject(projectJson: any, kernelDir: string, attributes: Record<string, string | number>): { project: any; stamped: boolean } {
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

const PLACE_MAGIC = "<roblox!";

/** A path for messages: relative to the game root when inside it, else absolute; forward slashes. */
function displayPath(root: string, path: string): string {
	const rel = relative(root, path);
	return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path).replace(/\\/g, "/");
}

/** Scope hints for the place key's jobs in patch mode. */
const DOWNLOAD_SCOPE_HINT =
	"downloading the place needs the legacy-asset:manage scope, which can't be granted to API keys today (Roblox says universe.place:read is coming). Download a copy in Studio (File > Download a Copy) and pass --place-file <file> --base <version>";

export async function kernelCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub === "deploy") return kernelDeploy(args);
	if (sub === "restore") return kernelRestore(args);
	throw new UsageError(`unknown kernel subcommand "${sub ?? ""}" (deploy, restore)`);
}

interface PreparedKernel {
	proj: Project;
	kernelDir: string;
	identity: KernelIdentity;
	signing: ReturnType<typeof signingAttributes>;
	heads: Record<string, BootstrapHead>;
	stamped: unknown;
	bytes: Uint8Array;
	watch: Stopwatch;
	where: string;
	/** Kernel 0.3.6: the backup build baked into the place (null: none this time). */
	backup: BackupInfo | null;
}

/** Steps 1-3: check, identify, build the stamped kernel place (.typetorch/place.rbxl). */
async function prepareKernel(args: ParsedArgs): Promise<PreparedKernel> {
	const proj = project(args);
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

	// 3. Build, with the identity and the signing trust roots stamped on the kernel slot.
	const attributes: Record<string, string | number> = { KernelVersion: identity.version, KernelHash: identity.hash };
	if (identity.commit) attributes.KernelCommit = `${identity.commit}${identity.dirty ? "*" : ""}`;
	const signing = signingAttributes(proj, signingKeyPaths(proj, args).fallback);
	Object.assign(attributes, signing.attributes);
	for (const warning of signing.warnings) warn(warning);
	for (const problem of signing.problems) warn(problem);
	info(`  keys     KeyAssetId ${signing.attributes.KeyAssetId ?? "(none)"}  FallbackPublicKey ${signing.attributes.FallbackPublicKey ?? "(none)"}`);
	// The prod heads stored before signing (no sig): the kernel trusts exactly these unsigned.
	noteRegistryFlags(args);
	const history = await readHistory(proj);
	const heads = bootstrapHeads(proj, history);
	attributes.BootstrapHeads = JSON.stringify(heads);
	const listed = Object.entries(heads).map(([branch, head]) => `${branch}=#${head.s} ${head.i} (asset ${head.a})`);
	info(`  heads    BootstrapHeads ${listed.length ? listed.join(", ") : "{} (no prod-channel heads yet)"}  (this machine's log: deploys made from another machine are missing)`);
	mkdirSync(join(proj.root, OUT_DIR), { recursive: true });
	const placeProject = parseJsonc(readFileSync(join(kernelDir, "place.project.json"), "utf8"));
	const stampedKernel = stampKernelProject(placeProject, kernelDir, attributes);
	// Kernel 0.3.6: the prod head's kept payload becomes ServerStorage.TypeTorchBackup (a kernel slot, refreshed by
	// every kernel deploy). Without one the place keeps the backup it has.
	const backup = flagBool(args, "no-backup") ? { skipped: "--no-backup" } : prepareBackup(proj, history);
	if (backup.info) {
		info(`  backup   ${backup.info.artifactId} (#${backup.info.seq}, ${backup.info.branch}) from ${relative(proj.root, backup.source!).replace(/\\/g, "/")} -> ServerStorage.${BACKUP_SLOT.name}`);
	} else {
		warn(`no backup build baked: ${backup.skipped}. ${backup.skipped === "--no-backup" ? "" : "The place keeps the backup it has (doctor shows its age); "}a server that can load nothing else then has no backup and moves its players to another server`);
	}
	const { project: withBackup, stamped: didStamp } = backup.model ? { project: addBackupToProject(stampedKernel.project, backup.model), stamped: stampedKernel.stamped } : stampedKernel;
	// LoadStringEnabled: the flag decides (the kernel's own place.project.json says false from kernel 0.3.6). Patch mode
	// applies it only with --loadstring (kernelLayout); --replace-place publishes the stamped value either way.
	const loadstring = flagBool(args, "loadstring");
	const stamped = withLoadstring(withBackup, loadstring);
	info(`  loadstring ${loadstring ? "ON (--loadstring: ServerScriptService.LoadStringEnabled = true, for remote-claude's run_luau)" : "off (patch: the place keeps its own LoadStringEnabled; --replace-place: false)"}`);
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
	return { proj, kernelDir, identity, signing, heads, stamped, bytes, watch, where, backup: backup.info ?? null };
}

/**
 * Kernel 0.3.6: the backup build for the place. The prod head (the default branch's, else the newest prod-channel head)
 * whose payload this machine kept (`<state dir>/payloads/<artifactId>.rbxm`, written at upload), stamped with the
 * Backup* attributes into `.typetorch/backup.rbxm`. `skipped` says why there is none.
 */
export function prepareBackup(
	proj: Pick<Project, "root" | "config">,
	history: Pick<History, "heads">,
	options: { stateDir?: string; now?: Date } = {},
): { info?: BackupInfo; model?: string; source?: string; skipped?: string } {
	const head = backupHead(proj.config, history.heads);
	if (!head) return { skipped: "no prod-channel head is known on this machine (deploy prod first)" };
	const stateDir = options.stateDir ?? projectStateDir(proj as Project);
	const source = findKeptPayload(stateDir, head.artifactId);
	if (!source) {
		return { skipped: `the prod head ${head.artifactId} (#${head.seq}) has no kept payload in ${relative(proj.root, join(stateDir, PAYLOADS_DIR)).replace(/\\/g, "/") || PAYLOADS_DIR} (it was uploaded from another machine, or by a CLI before 0.3.6: deploy prod from here once)` };
	}
	const info: BackupInfo = { artifactId: head.artifactId, seq: head.seq, branch: head.branch, channel: "prod", at: (options.now ?? new Date()).toISOString() };
	try {
		const bytes = backupRbxm(new Uint8Array(readFileSync(source)), info);
		const model = join(proj.root, OUT_DIR, BACKUP_FILE);
		mkdirSync(join(proj.root, OUT_DIR), { recursive: true });
		writeFileSync(model, bytes);
		return { info, model, source };
	} catch (error) {
		if (error instanceof BackupError) return { skipped: `the kept payload of ${head.artifactId} can't be the backup: ${error.message}` };
		throw error;
	}
}

async function kernelDeploy(args: ParsedArgs) {
	const replacePlace = flagBool(args, "replace-place");
	if (replacePlace && flagBool(args, "patch")) throw new UsageError("--patch and --replace-place are two different modes; pick one");
	if (replacePlace) {
		for (const flag of ["install", "base", "engine", "place-file"]) {
			if (args.flags[flag] !== undefined) throw new UsageError(`--${flag} belongs to patch mode, not --replace-place`);
		}
	}
	const engine = flagString(args, "engine") ?? "splice";
	if (engine !== "splice" && engine !== "lune") throw new UsageError(`--engine must be "splice" or "lune", got "${engine}"`);
	const placeFile = flagString(args, "place-file");
	const prepared = await prepareKernel(args);
	if (replacePlace) return replacePlaceFlow(args, prepared);
	return patchFlow(args, prepared, engine, placeFile);
}

/** Step 4, patch mode (the default). */
async function patchFlow(args: ParsedArgs, prepared: PreparedKernel, engine: "splice" | "lune", placeFile: string | undefined) {
	const { proj, kernelDir, identity, signing, heads, watch, where } = prepared;
	const dryRun = flagBool(args, "dry-run");
	const yes = flagBool(args, "yes");
	const install = flagBool(args, "install");
	const baseFlag = flagString(args, "base");
	const { placeId, universeId } = proj.config;
	const outDir = join(proj.root, OUT_DIR);
	const layout = kernelLayout(prepared.stamped, { loadstring: flagBool(args, "loadstring") });
	if (layout.slots.length === 0) throw new KernelCheckError(`${join(kernelDir, "place.project.json")} declares no TypeTorch* slot under a service; nothing to patch`);
	info(`  slots    ${layout.slots.map((s) => `${s.service}.${s.name}`).join(", ")}${layout.serviceProps.length ? `  settings ${layout.serviceProps.map((p) => `${p.service}.${p.prop}`).join(", ")}` : ""}`);

	// The base place: downloaded (and backed up), or a local file.
	let oc: OpenCloud | undefined;
	let original: Uint8Array;
	let originalPath: string;
	let backup: string | undefined;
	// newest: the place's newest version when the base was chosen; the publish refuses if the place moved past it.
	let base: { version?: number; newest?: number; published?: boolean; skipped: number[]; source: string; bytes: number; seconds?: number };
	if (placeFile) {
		if (baseFlag !== undefined && !/^\d+$/.test(baseFlag)) throw new UsageError("with --place-file, --base is the version number the file was taken from");
		originalPath = resolve(process.cwd(), placeFile);
		if (!existsSync(originalPath)) throw new UsageError(`--place-file ${placeFile} does not exist`);
		original = new Uint8Array(readFileSync(originalPath));
		const claimed = baseFlag === undefined ? undefined : Number(baseFlag);
		base = { version: claimed, newest: claimed, skipped: [], source: `local file ${displayPath(proj.root, originalPath)}`, bytes: original.length };
	} else {
		oc = openCloud("place")!;
		let versions;
		try {
			versions = await watch.stage("versions", () => oc!.placeVersions(placeId, 1));
		} catch (error) {
			if (error instanceof ApiError && error.isScopeError) throw new KernelCheckError(`listing the place's versions needs asset:read on the place key: ${error.message}`);
			throw error;
		}
		const choice = chooseBase(versions, baseFlag);
		if (!choice.ok) throw new KernelCheckError(choice.reason);
		let download;
		try {
			download = await watch.stage("download", () => oc!.downloadPlace(placeId, choice.version));
		} catch (error) {
			if (error instanceof ApiError && error.isScopeError) throw new KernelCheckError(`${DOWNLOAD_SCOPE_HINT} (${error.status} from the Asset Delivery API)`);
			throw error;
		}
		original = download.bytes;
		mkdirSync(join(outDir, BACKUP_DIR), { recursive: true });
		originalPath = join(outDir, BACKUP_DIR, `${placeId}-v${choice.version}.rbxl`);
		if (!existsSync(originalPath) || sha256Hex(new Uint8Array(readFileSync(originalPath))) !== sha256Hex(original)) writeFileSync(originalPath, original);
		backup = displayPath(proj.root, originalPath);
		base = { version: choice.version, newest: versions[0].version, published: choice.published, skipped: choice.skipped, source: "downloaded", bytes: original.length, seconds: download.seconds };
	}
	if (new TextDecoder().decode(original.subarray(0, 8)) !== PLACE_MAGIC) {
		throw new KernelCheckError(`the base place is not a binary place file (.rbxl)${original.subarray(0, 7).every((b, i) => b === "<roblox".charCodeAt(i)) ? ": it is XML (.rbxlx); save it as .rbxl" : ""}`);
	}
	let parsed: PlaceFile;
	try {
		parsed = new PlaceFile(original);
	} catch (error) {
		if (error instanceof PlacePatchError || error instanceof RbxmError) throw new KernelCheckError(`the base place can't be read: ${error.message}`);
		throw error;
	}
	const before = summarizePlace(parsed, layout.slots);
	const hasKernel = before.slots.some((s) => s.copies > 0);

	// Patch.
	mkdirSync(join(outDir, PATCH_DIR), { recursive: true });
	const stem = `${placeId}-v${base.version ?? "local"}-kernel-${identity.version}${engine === "lune" ? "-lune" : ""}`;
	const patchedPath = join(outDir, PATCH_DIR, `${stem}.rbxl`);
	const specPath = join(outDir, PATCH_DIR, `${stem}.spec.json`);
	writeFileSync(specPath, JSON.stringify({ slots: layout.slots, settings: layout.serviceProps }));
	const kernelBuildPath = join(proj.root, PLACE_FILE);
	const lune = luneBinary();
	const script = writeLuneScript(outDir);
	let patched: Uint8Array;
	let report: PatchReport | undefined;
	let lunePatch: { removed: number; added: number } | undefined;
	try {
		if (engine === "splice") {
			const result = await watch.stage("patch", async () => patchPlace({ original, kernel: prepared.bytes, slots: layout.slots, serviceProps: layout.serviceProps, seed: identity.hash }));
			patched = result.bytes;
			report = result.report;
			writeFileSync(patchedPath, patched);
		} else {
			lunePatch = await watch.stage("patch", () => runLunePatch(lune, kernelDir, script, { original: originalPath, kernel: kernelBuildPath, spec: specPath, out: patchedPath }));
			patched = new Uint8Array(readFileSync(patchedPath));
		}
	} catch (error) {
		if (error instanceof PlacePatchError) throw new KernelCheckError(`the splice engine can't patch this place: ${error.message}\n  --engine lune re-encodes the whole place through rbx-dom instead (it migrates some properties; see \`typetorch help kernel\`)`);
		if (error instanceof LunePatchError) throw new KernelCheckError(error.message);
		throw error;
	}

	// Verify twice: the CLI's own binary reader, then Lune (rbx-dom).
	const ts = verifyPatch(original, patched, prepared.bytes, layout.slots);
	let luneResult: LuneVerification;
	try {
		luneResult = await watch.stage("verify", () => runLuneVerify(lune, kernelDir, script, { original: originalPath, patched: patchedPath, kernel: kernelBuildPath, spec: specPath, out: join(outDir, PATCH_DIR, `${stem}.lune.json`) }));
	} catch (error) {
		if (error instanceof LunePatchError) throw new KernelCheckError(error.message);
		throw error;
	}
	// The lune engine re-encodes everything: its property migrations are expected (shown), anything else is a failure.
	const tsProblems = engine === "lune" ? ts.problems.filter((p) => !p.startsWith("properties lost")) : ts.problems;
	const problems = [...tsProblems.map((p) => `binary check: ${p}`), ...luneResult.problems.map((p) => `Lune check: ${p}`)];
	// References re-pointed by path keep their target's full name; only the cleared ones may change (to nil).
	if (report && luneResult.references.length !== report.references.cleared.length) {
		problems.push(`Lune check: ${luneResult.references.length} reference(s) outside the slots point elsewhere, the patch cleared ${report.references.cleared.length}: ${luneResult.references.slice(0, 5).join("; ")}`);
	}
	const firstInstall = !hasKernel;

	const output = { path: displayPath(proj.root, patchedPath), bytes: patched.length, sha256: sha256Hex(patched) };
	const record = {
		universeId,
		placeId,
		mode: "patch",
		engine,
		base,
		backup,
		firstInstall,
		oldKernel: before.kernel,
		kernel: identity,
		slots: layout.slots,
		settings: layout.serviceProps,
		report,
		lunePatch,
		verification: { ok: problems.length === 0, problems, binary: ts, lune: luneResult },
		output,
		bootstrapHeads: heads,
		backupBuild: prepared.backup,
	};
	writeFileSync(join(outDir, PATCH_DIR, `${stem}.json`), JSON.stringify(record, null, "\t"));
	if (!isJson()) {
		info("");
		for (const line of summaryLines({ where, base, backup, before, engine, report, lunePatch, newKernel: { version: identity.version, hash: identity.hash, commit: identity.commit }, ts, lune: luneResult, output })) info(`  ${line}`);
		if (report?.filled.length) info(dim(`  filled   ${report.filled.length} value(s) the kernel build doesn't set (UniqueId, SourceAssetId, Tags...): see ${output.path.replace(/\.rbxl$/, ".json")}`));
		// A property only the kernel build has is now written explicitly (zero) for the game's own instances too.
		for (const line of report?.filled.filter((f) => f.includes("existing instance")) ?? []) warn(`game instances get an explicit default: ${line}`);
		info("");
	}
	if (problems.length > 0) {
		throw new KernelCheckError(`the patched place failed verification (nothing published; files in ${relative(proj.root, join(outDir, PATCH_DIR))}):\n  - ${problems.slice(0, 15).join("\n  - ")}`);
	}
	if (firstInstall && !install) {
		const text = `place ${placeId}${base.version !== undefined ? ` v${base.version}` : ""} has no TypeTorch kernel yet (none of ${layout.slots.map((s) => `${s.service}.${s.name}`).join(", ")}): a first install adds them; check the summary, then run again with --install`;
		if (!dryRun) throw new UsageError(text);
		warn(text);
	}
	if (hasKernel && before.slots.some((s) => s.copies === 0)) warn(`the place has only part of the kernel (${before.slots.filter((s) => s.copies > 0).map((s) => s.slot).join(", ")}); the patch adds the missing slots`);
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, ...record });
		info(bold(`dry run: kernel ${identity.version} patched into ${base.version !== undefined ? `v${base.version}` : "the local place file"}; nothing published`));
		info(dim(`  patched place: ${output.path} (sha256 ${output.sha256.slice(0, 16)}), report next to it`));
		info(dim(`  publish: typetorch kernel deploy${placeFile ? ` --place-file ${displayPath(proj.root, originalPath)}${base.version !== undefined ? ` --base ${base.version}` : " --base <version>"}` : base.version !== undefined && baseFlag ? ` --base ${baseFlag}` : ""}${firstInstall ? " --install" : ""} (patches again and asks y/N), or publish this exact file: typetorch kernel restore ${output.path}`));
		return;
	}
	if (signing.problems.length > 0) {
		throw new KernelCheckError(`refusing to publish a kernel that can't verify prod deploys:\n  - ${signing.problems.join("\n  - ")}`);
	}
	if (base.version === undefined) {
		throw new UsageError("--place-file needs --base <version> to publish: the version the file was taken from, so the deploy can check that nobody published since");
	}
	if (!yes) {
		const io = interaction();
		if (!io.interactive) throw new UsageError(`refusing to publish without --yes (no interactive terminal to ask); check the summary above, then run again with --yes`);
		if (!(await io.confirm(`Publish the patched place as the new live version of place ${placeId}?`))) {
			info("not published");
			return;
		}
	}
	oc ??= openCloud("place")!;
	let latest: number;
	try {
		latest = await oc.latestPlaceVersion(placeId);
	} catch (error) {
		throw new KernelCheckError(`can't read the place's current version (asset:read on the place key), so the deploy can't check that nobody published since v${base.version}: ${(error as Error).message}`);
	}
	if (latest !== base.newest) {
		throw new KernelCheckError(`the place changed since the patch was made (newest version then v${base.newest}, now v${latest}); nothing published. Run the deploy again to patch the new version`);
	}
	await publishPatched({ args, proj, identity, heads, watch, where, bytes: patched, base: base.version, extra: { mode: "patch", engine, backup, backupBuild: prepared.backup, firstInstall, patchedSha256: output.sha256, patchedFile: output.path, oldKernelVersion: before.kernel.version ?? null } });
	if (backup) info(dim(`  restore the previous version: typetorch kernel restore ${backup}`));
}

/** Publishes a patched place, with the kernel-deploys.jsonl records around it. */
async function publishPatched(input: {
	args: ParsedArgs;
	proj: Project;
	identity: KernelIdentity;
	heads: Record<string, BootstrapHead>;
	watch: Stopwatch;
	where: string;
	bytes: Uint8Array;
	base: number;
	extra: Record<string, unknown>;
}) {
	const { proj, identity, watch, where } = input;
	const oc = openCloud("place")!;
	const stateDir = projectStateDir(proj);
	const record = {
		universeId: proj.config.universeId,
		placeId: proj.config.placeId,
		...input.extra,
		kernelVersion: identity.version,
		kernelApi: identity.api,
		kernelHash: identity.hash,
		kernelCommit: identity.commit,
		kernelDirty: identity.dirty,
		kernelTag: identity.tag,
		kernelSource: identity.source,
		keyAssetId: proj.config.keyAssetId ?? null,
		fallbackPublicKey: proj.config.fallbackPublicKey ?? null,
		bootstrapHeads: input.heads,
		placeVersionBefore: input.base,
		by: gitInfo(proj.root).userName,
	};
	logKernel(stateDir, { event: "kernel-publishing", ...record });
	let response: any;
	try {
		response = await watch.stage("publish", () => oc.publishPlace(proj.config.universeId, proj.config.placeId, input.bytes));
	} catch (error) {
		logKernel(stateDir, { event: "kernel-failed", ...record, error: (error as Error).message.slice(0, 500) });
		if (error instanceof ApiError && error.status === 409) {
			throw new KernelCheckError(`the place didn't take the publish (409): an active Team Create session blocks it. Ask everyone to close the place in Studio, then run again (nothing was published): ${error.message}`);
		}
		throw error;
	}
	const after = typeof response?.versionNumber === "number" ? response.versionNumber : null;
	const timings = watch.total();
	logKernel(stateDir, { event: "kernel-published", ...record, placeVersionAfter: after, timings });
	if (isJson()) return emitJson({ ...record, placeVersionAfter: after, timings });
	info(`  publish  ${formatSeconds(timings.publish)}  place version ${input.base} -> ${after ?? "?"}`);
	info(bold(`published kernel ${identity.version} (hash ${identity.hash.slice(0, 16)}) into ${where}; servers run it after they restart`));
	info(dim(`  recorded in ${join(stateDir, KERNEL_LOG)}`));
}

/** Step 4, --replace-place: the whole kernel place (template/test place only). */
async function replacePlaceFlow(args: ParsedArgs, prepared: PreparedKernel) {
	const { proj, kernelDir, identity, signing, heads, bytes, watch, where } = prepared;
	const dryRun = flagBool(args, "dry-run");
	const yes = flagBool(args, "yes");
	const summary = {
		kernelDir,
		kernel: identity,
		file: PLACE_FILE,
		bytes: bytes.length,
		universeId: proj.config.universeId,
		placeId: proj.config.placeId,
		keyAssetId: proj.config.keyAssetId ?? null,
		fallbackPublicKey: proj.config.fallbackPublicKey ?? null,
		bootstrapHeads: heads,
		backupBuild: prepared.backup,
	};
	warn(`--replace-place REPLACES THE WHOLE PLACE (${where}) with the kernel place: every Studio/Team Create edit (maps, UI, builders' work) is wiped from the live version. It stays in the place's version history. Real games: use the default patch mode.`);
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, mode: "replace-place", ...summary });
		info(bold(`dry run: would publish ${PLACE_FILE} to ${where}, replacing the place`));
		return;
	}
	if (!yes) {
		throw new UsageError(`refusing to publish without --yes (this replaces the whole place at ${where}); check the output above, then run again with --yes`);
	}
	if (signing.problems.length > 0) {
		throw new KernelCheckError(`refusing to publish a kernel that can't verify prod deploys:\n  - ${signing.problems.join("\n  - ")}`);
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
		keyAssetId: proj.config.keyAssetId ?? null,
		fallbackPublicKey: proj.config.fallbackPublicKey ?? null,
		bootstrapHeads: heads,
		backupBuild: prepared.backup,
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

/** The default slots, for describing a place file outside a deploy (restore). */
export const DEFAULT_SLOTS: SlotRef[] = [
	{ service: "ServerScriptService", name: "TypeTorchKernel" },
	{ service: "ReplicatedStorage", name: "TypeTorchKernelShared" },
	{ service: "ReplicatedFirst", name: "TypeTorchKernelClient" },
];

/** `<placeId>-v<n>` at the start of a backup's or patched file's name. */
export function placeFileName(name: string): { placeId: number; version: number } | undefined {
	const match = /^(\d+)-v(\d+)\b/.exec(name);
	return match ? { placeId: Number(match[1]), version: Number(match[2]) } : undefined;
}

/**
 * `typetorch kernel restore <file>`: publishes a place file as the new live version: a backup from
 * .typetorch/place-backups/ (undo a kernel deploy), or a dry run's patched file from .typetorch/place-patches/.
 */
async function kernelRestore(args: ParsedArgs) {
	const file = args.positionals[1];
	if (!file || args.positionals.length > 2) throw new UsageError("usage: typetorch kernel restore <file.rbxl> [--dry-run] [--yes]");
	const proj = project(args);
	const path = resolve(process.cwd(), file);
	if (!existsSync(path)) throw new UsageError(`${file} does not exist`);
	const bytes = new Uint8Array(readFileSync(path));
	if (new TextDecoder().decode(bytes.subarray(0, 8)) !== PLACE_MAGIC) throw new KernelCheckError(`${file} is not a binary place file (.rbxl)`);
	let summary;
	try {
		summary = summarizePlace(new PlaceFile(bytes), DEFAULT_SLOTS);
	} catch (error) {
		throw new KernelCheckError(`${file} can't be read as a place: ${(error as Error).message}`);
	}
	const { placeId, universeId } = proj.config;
	const named = placeFileName(basename(path));
	if (named && named.placeId !== placeId) {
		throw new KernelCheckError(`${basename(path)} is a file of place ${named.placeId}, but typetorch.json is place ${placeId}`);
	}
	const where = `universe ${universeId}, place ${placeId}`;
	const sha = sha256Hex(bytes);
	const kernel = summary.kernel.version ? `kernel ${summary.kernel.version}${summary.kernel.commit ? ` @ ${summary.kernel.commit}` : ""}` : "no TypeTorch kernel";
	info(`  file     ${displayPath(proj.root, path)}  ${formatBytes(bytes.length)}  sha256 ${sha.slice(0, 16)}${named ? `  (taken from v${named.version})` : ""}`);
	info(`  content  ${summary.instances} instances in ${summary.services} services, ${kernel}`);
	const dryRun = flagBool(args, "dry-run");
	// A dry run works without a key (it only can't show the current version); a publish needs one.
	const oc = openCloud("place", dryRun);
	let latest: number | undefined;
	if (!oc) warn("no place key: the place's current version isn't shown");
	else {
		try {
			latest = await oc.latestPlaceVersion(placeId);
			info(`  place    ${where}, now at v${latest}`);
		} catch (error) {
			warn(`could not read the place's current version (asset:read): ${(error as Error).message}`);
		}
	}
	const since = named && latest !== undefined && latest > named.version ? ` (versions v${named.version + 1}..v${latest} were saved after the version this file comes from)` : "";
	warn(`this publishes ${basename(path)} as the new live version of place ${placeId}: everything published after it (Studio work, other kernel deploys) leaves the live place (it stays in version history)${since}`);
	if (dryRun || !oc) {
		if (isJson()) return emitJson({ dryRun: true, file: path, bytes: bytes.length, sha256: sha, placeId, latest: latest ?? null, kernel: summary.kernel });
		info(bold("dry run: nothing published"));
		return;
	}
	if (!flagBool(args, "yes")) {
		const io = interaction();
		if (!io.interactive) throw new UsageError("refusing to publish without --yes (no interactive terminal to ask)");
		if (!(await io.confirm(`Publish ${basename(path)} as the new live version of place ${placeId}?`))) {
			info("not published");
			return;
		}
	}
	const stateDir = projectStateDir(proj);
	const record = { universeId, placeId, mode: "restore", file: displayPath(proj.root, path), sha256: sha, fileKernel: summary.kernel.version ?? null, placeVersionBefore: latest ?? null, by: gitInfo(proj.root).userName };
	logKernel(stateDir, { event: "kernel-restoring", ...record });
	let response: any;
	const watch = new Stopwatch();
	try {
		response = await watch.stage("publish", () => oc.publishPlace(universeId, placeId, bytes));
	} catch (error) {
		logKernel(stateDir, { event: "kernel-restore-failed", ...record, error: (error as Error).message.slice(0, 500) });
		throw error;
	}
	const after = typeof response?.versionNumber === "number" ? response.versionNumber : null;
	logKernel(stateDir, { event: "kernel-restored", ...record, placeVersionAfter: after });
	if (isJson()) return emitJson({ ...record, placeVersionAfter: after });
	info(`  publish  ${formatSeconds(watch.timings.publish)}  place version ${latest ?? "?"} -> ${after ?? "?"}`);
	info(bold(`published ${basename(path)} to ${where}; servers run it after they restart`));
}
