/**
 * The few places where Bun and Node differ, behind one small API built only on Node's own modules (Bun implements them
 * too), so the CLI runs the same under `bun src/index.ts` (development) and `node dist/index.js` (npm / npx):
 *   - child processes: PATH lookup (PATHEXT on Windows) and Windows .cmd scripts, which Node refuses to spawn directly;
 *   - zstd (node:zlib has it from Node 22.15 / 23.8; Bun always);
 *   - sleep and the runtime's name.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as zlib from "node:zlib";

/** True when running under Bun (development: `bun src/index.ts`); false under Node (the npm package). */
export const isBun = typeof process.versions.bun === "string";

/** "bun 1.3.14" or "node v22.17.1". */
export function runtimeName(): string {
	return isBun ? `bun ${process.versions.bun}` : `node ${process.version}`;
}

export function sleep(ms: number): Promise<void> {
	return delay(ms).then(() => undefined);
}

type Env = Record<string, string | undefined>;

/** An environment variable, case-insensitively on Windows (a child env object may spell it "Path"). */
function envValue(env: Env, name: string): string | undefined {
	if (process.platform !== "win32") return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The executable `name` resolves to, like Bun.which: a path is checked as is; a bare name is searched in PATH (from
 * `env`, default the real environment), on Windows with each PATHEXT extension (extensionless files there are shell
 * scripts for Git Bash, not programs). The current directory is never searched.
 */
export function which(name: string, env: Env = process.env): string | undefined {
	if (!name) return undefined;
	const win = process.platform === "win32";
	const exts = win ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
	const named = (base: string) => (win && !exts.some((e) => base.toLowerCase().endsWith(e)) ? exts.map((e) => base + e) : [base]);
	if (name.includes("/") || (win && name.includes("\\"))) return named(resolve(name)).find(isExecutableFile);
	for (const dir of (envValue(env, "PATH") ?? "").split(win ? ";" : ":")) {
		if (!dir) continue;
		const found = named(resolve(dir.replace(/^"(.*)"$/, "$1"), name)).find(isExecutableFile);
		if (found) return found;
	}
	return undefined;
}

/** The target of an npm (cmd-shim) .cmd script: `"%dp0%\node_modules\pkg\cli.js" %*`, resolved next to it. */
export function npmShimTarget(cmdFile: string): string | undefined {
	let text: string;
	try {
		if (statSync(cmdFile).size > 64 * 1024) return undefined;
		text = readFileSync(cmdFile, "utf8");
	} catch {
		return undefined;
	}
	const matches = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"\s+%\*/g)];
	const rel = matches.at(-1)?.[1];
	if (!rel || /[\r\n]/.test(rel)) return undefined;
	const target = resolve(dirname(cmdFile), rel);
	return isExecutableFile(target) ? target : undefined;
}

// cmd.exe metacharacters (cross-spawn's set): each is escaped with ^ when a .cmd script runs through cmd.exe.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for `cmd /d /s /c "<script> <args>"`: quoted, then every metacharacter caret-escaped for cmd's own
 * parse. The script parses its %* again, where only the quotes protect & | < > ( ): an argument holding a double quote
 * would unbalance them (BatBadBut), so it is refused, like a line break (cmd can't pass one at all).
 */
function cmdQuote(arg: string): string {
	if (/["\r\n\0]/.test(arg)) throw new Error("an argument with a double quote or a line break can't be passed to a .cmd/.bat script safely");
	return `"${arg.replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1");
}

export class ExecutableNotFoundError extends Error {
	override name = "ExecutableNotFoundError";
	readonly code = "ENOENT";
	constructor(readonly executable: string) {
		super(`Executable not found in $PATH: "${executable}"`);
	}
}

export interface ResolvedCommand {
	file: string;
	args: string[];
	/** cmd.exe gets its command line exactly as built (already quoted and escaped). */
	windowsVerbatimArguments?: boolean;
}

/**
 * How to start `cmd` with node:child_process, without a shell: the executable is looked up first (a missing one throws
 * ExecutableNotFoundError at once, as Bun.spawn does). On Windows a .cmd/.bat file can't be spawned directly: an npm
 * shim runs its JavaScript target with node (or its .exe target); any other script runs through cmd.exe with every
 * argument quoted and its metacharacters escaped (arguments holding a double quote or a line break are refused).
 */
export function resolveCommand(cmd: readonly string[], env: Env = process.env): ResolvedCommand {
	const [exe, ...args] = cmd;
	// The child's PATH first, then this process's (an env without PATH still finds git, as with Bun.spawn).
	const found = exe ? (which(exe, env) ?? (env === process.env ? undefined : which(exe))) : undefined;
	if (!found) throw new ExecutableNotFoundError(exe ?? "");
	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
		const target = npmShimTarget(found);
		if (target && /\.[cm]?js$/i.test(target)) {
			const local = resolve(dirname(found), "node.exe");
			const node = isExecutableFile(local) ? local : (which("node", env) ?? process.execPath);
			return { file: node, args: [target, ...args] };
		}
		if (target && /\.exe$/i.test(target)) return { file: target, args };
		const line = [found.replace(CMD_META, "^$1"), ...args.map(cmdQuote)].join(" ");
		return { file: envValue(process.env, "COMSPEC") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
	}
	return { file: found, args };
}

export interface CaptureResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CaptureOptions {
	cwd: string;
	/** The child's whole environment (PATH is looked up in it). */
	env: Record<string, string>;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
	if (code !== null) return code;
	return signal ? 128 + (osConstants.signals[signal] ?? 1) : 1;
}

/** Runs a command to completion and captures both streams. A missing executable gives exit 127, never a throw. */
export function captureAsync(cmd: readonly string[], options: CaptureOptions): Promise<CaptureResult> {
	let resolved: ResolvedCommand;
	try {
		resolved = resolveCommand(cmd, options.env);
	} catch (error) {
		return Promise.resolve({ exitCode: 127, stdout: "", stderr: String((error as Error).message ?? error) });
	}
	return new Promise((done) => {
		const child = spawn(resolved.file, resolved.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: resolved.windowsVerbatimArguments,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
		let failure: Error | undefined;
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (code, signal) => {
			const stderr = Buffer.concat(err).toString("utf8");
			done({
				exitCode: failure && code === null ? 127 : exitCodeOf(code, signal),
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: failure && !stderr ? String(failure.message) : stderr,
			});
		});
	});
}

/** The synchronous variant (quick git queries). */
export function captureSync(cmd: readonly string[], options: CaptureOptions): CaptureResult {
	let resolved: ResolvedCommand;
	try {
		resolved = resolveCommand(cmd, options.env);
	} catch (error) {
		return { exitCode: 127, stdout: "", stderr: String((error as Error).message ?? error) };
	}
	const result = spawnSync(resolved.file, resolved.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		windowsVerbatimArguments: resolved.windowsVerbatimArguments,
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error && result.status === null) return { exitCode: 127, stdout: "", stderr: String(result.error.message) };
	return { exitCode: exitCodeOf(result.status, result.signal), stdout: result.stdout?.toString("utf8") ?? "", stderr: result.stderr?.toString("utf8") ?? "" };
}

export class ZstdUnavailableError extends Error {
	override name = "ZstdUnavailableError";
	constructor() {
		super(`zstd needs Node 22.15+ (or Bun); this is ${runtimeName()}`);
	}
}

type ZstdFn = (data: Uint8Array, options?: { maxOutputLength?: number }) => Buffer;
const zstd = zlib as unknown as { zstdCompressSync?: ZstdFn; zstdDecompressSync?: ZstdFn };

/** True when this runtime can (de)compress zstd. */
export function hasZstd(): boolean {
	return typeof zstd.zstdDecompressSync === "function" && typeof zstd.zstdCompressSync === "function";
}

export function zstdDecompress(data: Uint8Array, maxOutputLength?: number): Uint8Array {
	if (typeof zstd.zstdDecompressSync !== "function") throw new ZstdUnavailableError();
	return new Uint8Array(zstd.zstdDecompressSync(data, maxOutputLength ? { maxOutputLength } : undefined));
}

export function zstdCompress(data: Uint8Array): Uint8Array {
	if (typeof zstd.zstdCompressSync !== "function") throw new ZstdUnavailableError();
	return new Uint8Array(zstd.zstdCompressSync(data));
}
