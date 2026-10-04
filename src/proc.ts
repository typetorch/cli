/** Child processes. Output is captured and shown only on failure (or with --verbose), to keep the CLI concise. */
import { debug, isVerbose } from "./log";

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
		const output = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-40).join("\n");
		super(`${cmd.join(" ")} failed (exit ${result.exitCode})${output ? `:\n${output}` : ""}`);
	}
}

/** Runs a command and captures its output. Never throws for a non-zero exit; a missing binary gives exit 127. */
export async function capture(cmd: string[], cwd: string, env?: Record<string, string>): Promise<RunResult> {
	debug(`$ ${cmd.join(" ")}  (in ${cwd})`);
	let proc;
	try {
		proc = Bun.spawn(cmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: env ? { ...process.env, ...env } : process.env,
		});
	} catch (error) {
		return { exitCode: 127, stdout: "", stderr: String((error as Error).message ?? error) };
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (isVerbose()) {
		if (stdout.trim()) debug(stdout.trimEnd());
		if (stderr.trim()) debug(stderr.trimEnd());
	}
	return { exitCode, stdout, stderr };
}

/** Runs a command; throws CommandError (with the tail of its output) when it fails. */
export async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<RunResult> {
	const result = await capture(cmd, cwd, env);
	if (result.exitCode !== 0) throw new CommandError(cmd, result);
	return result;
}

/** Synchronous variant for quick queries (git). Returns trimmed stdout, or undefined on failure. */
export function query(cmd: string[], cwd: string, trim = true): string | undefined {
	try {
		const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		if (result.exitCode !== 0) return undefined;
		const text = result.stdout.toString();
		return trim ? text.trim() : text;
	} catch {
		return undefined;
	}
}
