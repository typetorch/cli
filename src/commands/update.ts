/**
 * `typetorch update [<version>] [--check] [--yes]`: updates this CLI (@typetorch/cli) where it is installed.
 *
 * Where this CLI runs from decides how (found from this file's path, symlinks resolved):
 *   - a game's dependency (<project>/node_modules/@typetorch/cli, listed in that package.json): the project's package
 *     manager (bun, pnpm, yarn or npm, from the lockfile) adds @typetorch/cli@<version> there, keeping it a
 *     devDependency when it was one;
 *   - a global install: `npm i -g`, `bun add -g` (~/.bun/install/global), `pnpm add -g` or `yarn global add`;
 *   - npx: nothing to update (`npx @typetorch/cli@latest` runs the newest);
 *   - a git checkout: `git pull` and `bun install` in it, printed and never run (the checkout may hold your work).
 * The newest version is the npm registry's `latest` tag. Updating asks y/N at a terminal; --yes skips it.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import { interaction } from "../interact.ts";
import { bold, emitJson, green, info, isJson, red, yellow } from "../log.ts";
import { resolveCommand } from "../runtime.ts";
import { cliRoot } from "./remote-claude.ts";

export const updateFlags = { check: "boolean", yes: "boolean" } as const;

export const CLI_PACKAGE = "@typetorch/cli";
const REGISTRY = "https://registry.npmjs.org/@typetorch%2fcli";

export const UPDATE_USAGE = `typetorch update [<version>] [--check] [--yes] [--json]

  Updates this CLI (${CLI_PACKAGE}) to the newest version on npm, or to <version>, the way it was installed: in the
  game's package.json (bun, pnpm, yarn or npm, from the lockfile), globally (npm, bun, pnpm, yarn), or not at all
  for npx (\`npx ${CLI_PACKAGE}@latest\` already runs the newest) and git checkouts (prints \`git pull\`).
  --check  only show the installed and newest versions and the command that would run
  --yes    don't ask before running it`;

export type InstallKind = "project" | "global" | "npx" | "checkout" | "unknown";
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface Install {
	kind: InstallKind;
	/** The CLI's package root. */
	root: string;
	/** project: the game folder; checkout: the checkout. */
	dir?: string;
	manager?: PackageManager;
	/** project: it is a devDependency there. */
	dev?: boolean;
}

const slashes = (path: string) => path.replace(/\\/g, "/");

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** The package manager a project uses, from its lockfile (npm when there is none). */
export function projectManager(dir: string): PackageManager {
	if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	return "npm";
}

/** How the CLI at `root` (its package root, symlinks resolved) was installed. */
export function detectInstall(root: string, env: Record<string, string | undefined> = process.env): Install {
	const path = slashes(root);
	if (existsSync(join(root, ".git"))) return { kind: "checkout", root, dir: root };
	if (/\/_npx\//.test(path) || /\/npm-cache\//i.test(path)) return { kind: "npx", root };
	const match = /^(.*)\/node_modules\/@typetorch\/cli$/.exec(path);
	if (!match) return { kind: "unknown", root };
	const parent = match[1]!;
	const pkg = readJson(join(parent, "package.json"));
	if (pkg) {
		const dev = Object.hasOwn((pkg.devDependencies as object) ?? {}, CLI_PACKAGE);
		const prod = Object.hasOwn((pkg.dependencies as object) ?? {}, CLI_PACKAGE);
		if (dev || prod) return { kind: "project", root, dir: parent, manager: projectManager(parent), dev };
	}
	const bunGlobal = slashes(join(env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "global"));
	if (parent.toLowerCase() === bunGlobal.toLowerCase()) return { kind: "global", root, manager: "bun" };
	if (/\/pnpm\/global\//i.test(path)) return { kind: "global", root, manager: "pnpm" };
	if (/\/yarn\/global\//i.test(path) || /\/\.config\/yarn\//i.test(path)) return { kind: "global", root, manager: "yarn" };
	// A package.json that doesn't list the CLI (e.g. hoisted from a workspace member): don't guess.
	if (pkg) return { kind: "unknown", root };
	return { kind: "global", root, manager: "npm" };
}

/** The command that installs `spec` (e.g. @typetorch/cli@0.7.0) for this install, or undefined when there is none. */
export function updateCommand(install: Install, spec: string): string[] | undefined {
	const { kind, manager, dev } = install;
	if (kind === "project") {
		if (manager === "bun") return ["bun", "add", ...(dev ? ["-d"] : []), spec];
		if (manager === "pnpm") return ["pnpm", "add", ...(dev ? ["-D"] : []), spec];
		if (manager === "yarn") return ["yarn", "add", ...(dev ? ["-D"] : []), spec];
		return ["npm", "install", ...(dev ? ["-D"] : []), spec];
	}
	if (kind === "global") {
		if (manager === "bun") return ["bun", "add", "-g", spec];
		if (manager === "pnpm") return ["pnpm", "add", "-g", spec];
		if (manager === "yarn") return ["yarn", "global", "add", spec];
		return ["npm", "install", "-g", spec];
	}
	return undefined;
}

/** -1, 0 or 1. Plain x.y.z with an optional pre-release (lower than the release). */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
		return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	if (x.pre === y.pre) return 0;
	if (x.pre === undefined) return 1;
	if (y.pre === undefined) return -1;
	return x.pre < y.pre ? -1 : 1;
}

/** The registry's `latest` version of the CLI. */
export async function latestVersion(fetcher: typeof fetch = fetch): Promise<string> {
	const response = await fetcher(REGISTRY, {
		headers: { Accept: "application/vnd.npm.install-v1+json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`the npm registry answered ${response.status} for ${CLI_PACKAGE}`);
	const body = (await response.json()) as { "dist-tags"?: { latest?: unknown } };
	const latest = body["dist-tags"]?.latest;
	if (typeof latest !== "string") throw new Error(`the npm registry has no "latest" version of ${CLI_PACKAGE}`);
	return latest;
}

function installedVersion(root: string): string | undefined {
	const version = readJson(join(root, "package.json"))?.version;
	return typeof version === "string" ? version : undefined;
}

function run(cmd: string[], cwd: string): Promise<number> {
	let resolved: ReturnType<typeof resolveCommand>;
	try {
		resolved = resolveCommand(cmd);
	} catch (error) {
		console.error(red(`error: ${(error as Error).message}`));
		return Promise.resolve(1);
	}
	return new Promise((resolveExit) => {
		const child = spawn(resolved.file, resolved.args, { cwd, stdio: "inherit", windowsVerbatimArguments: resolved.windowsVerbatimArguments });
		child.on("error", (error) => {
			console.error(red(`error: ${error.message}`));
			resolveExit(1);
		});
		child.on("exit", (code) => resolveExit(code ?? 1));
	});
}

export async function updateCommandRun(args: ParsedArgs) {
	const wanted = args.positionals[0];
	if (args.positionals.length > 1) throw new UsageError("typetorch update takes at most one version");
	if (wanted !== undefined && !/^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(wanted)) throw new UsageError(`"${wanted}" is not a version (x.y.z)`);
	let root = cliRoot();
	try {
		root = realpathSync(root);
	} catch {}
	const install = detectInstall(root);
	const current = installedVersion(root) ?? "?";
	const target = wanted?.replace(/^v/, "") ?? (await latestVersion());
	const spec = `${CLI_PACKAGE}@${target}`;
	const cmd = updateCommand(install, spec);
	const cwd = install.kind === "project" ? install.dir! : process.cwd();
	const upToDate = wanted === undefined && current !== "?" && compareVersions(current, target) >= 0;

	if (isJson() && flagBool(args, "check")) {
		return emitJson({ current, target, upToDate, install: install.kind, dir: install.dir, manager: install.manager, command: cmd });
	}
	info(`typetorch ${current} (${describe(install)}); ${wanted ? "requested" : "newest"} ${target}`);
	if (upToDate) return info(green("already up to date"));
	if (install.kind === "npx") return info(`npx runs the version you ask for: ${bold(`npx ${CLI_PACKAGE}@latest <command>`)}`);
	if (install.kind === "checkout") {
		return info(`this CLI runs from a git checkout: update it there with ${bold(`git -C "${install.dir}" pull`)} then ${bold("bun install")}`);
	}
	if (!cmd) {
		process.exitCode = 1;
		return info(yellow(`can't tell how ${root} was installed: update ${CLI_PACKAGE} with the package manager that installed it`));
	}
	const line = `${cmd.join(" ")}${install.kind === "project" ? `  (in ${cwd})` : ""}`;
	if (flagBool(args, "check")) return info(`would run: ${line}`);
	if (!flagBool(args, "yes")) {
		const ask = interaction();
		if (!ask.interactive) {
			process.exitCode = 1;
			return info(`run it yourself: ${bold(line)}, or pass --yes`);
		}
		if (!(await ask.confirm(`update to ${target} with: ${line}? [y/N] `))) return info("not updated");
	}
	const code = await run(cmd, cwd);
	if (code !== 0) {
		process.exitCode = code;
		return info(red(`${cmd[0]} exited with ${code}; ${CLI_PACKAGE} is still ${current}`));
	}
	const after = installedVersion(root) ?? "?";
	if (after === target) info(green(`typetorch ${current} -> ${after}`));
	else info(yellow(`installed ${spec}, but ${root} still reports ${after}: another copy may come first on PATH`));
}

function describe(install: Install): string {
	if (install.kind === "project") return `installed in ${install.dir} with ${install.manager}`;
	if (install.kind === "global") return `installed globally with ${install.manager}`;
	if (install.kind === "npx") return "run through npx";
	if (install.kind === "checkout") return `git checkout ${install.dir}`;
	return dirname(install.root);
}
