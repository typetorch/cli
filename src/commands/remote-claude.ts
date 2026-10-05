/**
 * `typetorch remote-claude ...`: runs `typetorch-dev-server remote-claude ...` (@typetorch/dev-server, plans/11) with the
 * same arguments, in this terminal (stdin, stdout and stderr are shared, so its terminal commands and Ctrl+C work), and
 * exits with its exit code.
 *
 * Where the dev-server comes from, first found:
 *   1. TYPETORCH_DEV_SERVER (the real environment only): a dev-server entry (.ts or .js) or executable;
 *   2. installed in the game repo: node_modules/@typetorch/dev-server in the working directory or a parent;
 *   3. next to this CLI: the npm layout (node_modules/@typetorch/{cli,dev-server}, global installs, or both packages in
 *      one `npx -p @typetorch/cli -p @typetorch/dev-server typetorch remote-claude ...`) or a sibling `../dev-server`
 *      checkout.
 * A package's entry: its bin (dist/index.js for 0.2+); a checkout without a build runs src/index.ts with Bun. Under Bun a
 * checkout's src/index.ts is preferred (no build needed).
 *
 * The child gets the real environment (the dev-server needs the Open Cloud key and reads `.env` files and
 * TYPETORCH_ENV_FILE itself), minus values Bun auto-loaded into process.env from this folder's .env files.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settings } from "../env.ts";
import { red } from "../log.ts";
import { isBun, resolveCommand, which } from "../runtime.ts";

export const DEV_SERVER_PACKAGE = "@typetorch/dev-server";
export const DEV_SERVER_BIN = "typetorch-dev-server";
export const DEV_SERVER_VAR = "TYPETORCH_DEV_SERVER";

export interface DevServerCommand {
	/** The command (runtime + entry, or an executable), without the dev-server's arguments. */
	cmd: string[];
	/** Where it was found, for messages. */
	label: string;
}

export interface FindOptions {
	/** The working directory (the game repo). */
	cwd: string;
	/** This CLI's package root (its node_modules neighbours and a sibling ../dev-server checkout). */
	cliRoot: string;
	/** The real environment (TYPETORCH_DEV_SERVER). */
	env?: Record<string, string | undefined>;
}

/** This CLI's package root: one level above src/ (Bun) and dist/ (Node). */
export function cliRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function bun(): string | undefined {
	return isBun ? process.execPath : which("bun");
}

/** How to run one entry file: .ts with Bun (none = unusable), .js with this runtime, anything else as is. */
function entryCommand(path: string): string[] | undefined {
	if (!existsSync(path)) return undefined;
	if (/\.(ts|tsx)$/i.test(path)) {
		const b = bun();
		return b ? [b, path] : undefined;
	}
	if (/\.(js|mjs|cjs)$/i.test(path)) return [process.execPath, path];
	return [path];
}

/** The dev-server in one package folder (a node_modules install or a checkout), if it is one. */
function fromPackage(dir: string): DevServerCommand | undefined {
	let pkg: { name?: string; bin?: string | Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (pkg.name !== DEV_SERVER_PACKAGE) return undefined;
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[DEV_SERVER_BIN];
	const entries = [bin ? join(dir, bin) : undefined, join(dir, "dist", "index.js"), join(dir, "src", "index.ts")].filter((e): e is string => Boolean(e));
	const ordered = isBun ? [join(dir, "src", "index.ts"), ...entries] : entries;
	for (const entry of ordered) {
		const cmd = entryCommand(entry);
		if (cmd) return { cmd, label: entry };
	}
	return undefined;
}

/** Folders `node_modules/@typetorch/dev-server` is looked for in: `from` and every parent. */
function installedFrom(from: string): string[] {
	const dirs: string[] = [];
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		dirs.push(join(dir, "node_modules", "@typetorch", "dev-server"));
		if (dirname(dir) === dir) break;
	}
	return dirs;
}

/** Finds the dev-server (see the header), or returns the places searched. */
export function findDevServer(options: FindOptions): DevServerCommand | { searched: string[] } {
	const env = options.env ?? process.env;
	const override = env[DEV_SERVER_VAR]?.trim();
	if (override) {
		const path = resolve(options.cwd, override);
		const cmd = entryCommand(path);
		return cmd ? { cmd, label: path } : { searched: [`${DEV_SERVER_VAR}=${path} (missing, or a .ts entry without Bun)`] };
	}
	const candidates = [...installedFrom(options.cwd), join(dirname(options.cliRoot), "dev-server"), ...installedFrom(options.cliRoot)];
	const seen = new Set<string>();
	for (const dir of candidates) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		const found = fromPackage(dir);
		if (found) return found;
	}
	return { searched: [...seen] };
}

export const REMOTE_CLAUDE_USAGE = `typetorch remote-claude --users <id,id,...> [options]

  Runs \`${DEV_SERVER_BIN} remote-claude\` (${DEV_SERVER_PACKAGE}) with the same arguments, in this terminal: the
  in-game DEV > Claude tab prompts Claude Code on this machine (dev-channel branches only; plans/11). Every option is
  the dev-server's (\`typetorch remote-claude --help\` prints them): --users (required), --branch, --env-file, --cli, ...
  Found in: ${DEV_SERVER_VAR} (an entry or executable), node_modules/${DEV_SERVER_PACKAGE} in the game repo or a parent,
  next to this CLI (npm installs it there: npm i -g ${DEV_SERVER_PACKAGE}), or a sibling ../dev-server checkout.
  With npx: npx -p @typetorch/cli -p ${DEV_SERVER_PACKAGE} typetorch remote-claude --users ...`;

/** The environment for the dev-server: the real one, minus what Bun auto-loaded from .env files here. */
function devServerEnv(): Record<string, string> {
	const config = settings();
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		const source = config.get(key)?.source;
		if (source !== undefined && source !== "environment") continue;
		env[key] = value;
	}
	return env;
}

/** Runs the dev-server with `argv`; resolves with its exit code. */
export async function remoteClaudeCommand(argv: string[], options: Partial<FindOptions> = {}): Promise<number> {
	const found = findDevServer({ cwd: options.cwd ?? process.cwd(), cliRoot: options.cliRoot ?? cliRoot(), env: options.env });
	if ("searched" in found) {
		console.error(red(`error: ${DEV_SERVER_PACKAGE} is not installed (typetorch remote-claude runs it)`));
		console.error(
			[
				"install it next to the CLI or in the game repo, then run this again:",
				`  npm i -g ${DEV_SERVER_PACKAGE}          (with npm i -g @typetorch/cli)`,
				`  bun add -d ${DEV_SERVER_PACKAGE}        (in the game repo)`,
				`  npx -p @typetorch/cli -p ${DEV_SERVER_PACKAGE} typetorch remote-claude ...`,
				`or point ${DEV_SERVER_VAR} at a dev-server entry. Looked in:`,
				...found.searched.map((dir) => `  ${dir}`),
			].join("\n"),
		);
		return 1;
	}
	const env = devServerEnv();
	const resolved = resolveCommand([...found.cmd, "remote-claude", ...argv], env);
	const child = spawn(resolved.file, resolved.args, {
		stdio: "inherit",
		env,
		windowsVerbatimArguments: resolved.windowsVerbatimArguments,
	});
	// Ctrl+C reaches both processes: the dev-server closes the session itself; this one waits for it.
	const ignore = () => {};
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) process.on(signal, ignore);
	try {
		return await new Promise<number>((done) => {
			child.once("error", (error) => {
				console.error(red(`error: could not start ${found.label}: ${error.message}`));
				done(1);
			});
			child.once("exit", (code, signal) => done(code ?? (signal ? 130 : 1)));
		});
	} finally {
		for (const signal of signals) process.off(signal, ignore);
	}
}
