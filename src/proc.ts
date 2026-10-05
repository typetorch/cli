/**
 * Child processes. Output is captured and shown only on failure (or with --verbose), to keep the CLI concise.
 * Every child gets an explicit minimal environment (env.ts `childEnv`): no API keys, nothing loaded
 * from a .env file. `extra` adds the few variables a step needs (never a secret).
 * node:child_process through runtime.ts (PATH lookup, Windows .cmd scripts), so the same code runs under Bun and Node.
 */
import { childEnv } from "./env.ts";
import { debug, isVerbose } from "./log.ts";
import { captureAsync, captureSync } from "./runtime.ts";

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export class CommandError extends Error {
	override name = "CommandError";
	constructor(
		readonly cmd: string[],
		readonly result: RunResult,
	) {
		// Both streams: rbxtsc prints its errors on stdout while `bun run` reports the exit on stderr.
		const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").split(/\r?\n/).slice(-40).join("\n");
		super(`${cmd.join(" ")} failed (exit ${result.exitCode})${output ? `:\n${output}` : ""}`);
	}
}

/** Runs a command and captures its output. Never throws for a non-zero exit; a missing binary gives exit 127. */
export async function capture(cmd: string[], cwd: string, extra?: Record<string, string>): Promise<RunResult> {
	debug(`$ ${cmd.join(" ")}  (in ${cwd})`);
	const { exitCode, stdout, stderr } = await captureAsync(cmd, { cwd, env: childEnv(extra) });
	if (isVerbose()) {
		if (stdout.trim()) debug(stdout.trimEnd());
		if (stderr.trim()) debug(stderr.trimEnd());
	}
	return { exitCode, stdout, stderr };
}

/** Runs a command; throws CommandError (with the tail of its output) when it fails. */
export async function run(cmd: string[], cwd: string, extra?: Record<string, string>): Promise<RunResult> {
	const result = await capture(cmd, cwd, extra);
	if (result.exitCode !== 0) throw new CommandError(cmd, result);
	return result;
}

/** Synchronous variant for quick queries (git). Returns trimmed stdout, or undefined on failure. */
export function query(cmd: string[], cwd: string, trim = true): string | undefined {
	try {
		const result = captureSync(cmd, { cwd, env: childEnv() });
		if (result.exitCode !== 0) return undefined;
		return trim ? result.stdout.trim() : result.stdout;
	} catch {
		return undefined;
	}
}
