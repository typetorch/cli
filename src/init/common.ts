/**
 * What every `typetorch init` phase shares: the terminal UI, the project folder, the resumable state, and the
 * outside world (PATH lookups, child processes, fetch, the other CLI commands), all injectable so tests run a phase
 * against fakes. Helpers for the files init writes (.env, .gitignore) live here too.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, type FlagSpec, type ParsedArgs } from "../args.ts";
import { accessCommand, accessFlags } from "../commands/access.ts";
import { backendCommand, backendFlags } from "../commands/backend.ts";
import { deployCommand, deployFlags } from "../commands/deploy.ts";
import { kernelCommand, kernelFlags } from "../commands/kernel.ts";
import { keysCommand, keysFlags } from "../commands/keys.ts";
import { capture, run, type RunResult } from "../proc.ts";
import { which } from "../runtime.ts";
import type { Tui } from "../tui.ts";
import type { InitState, PhaseName } from "./state.ts";

export type CommandName = "keys" | "kernel" | "deploy" | "access" | "backend";

export interface InitDeps {
	tui: Tui;
	which: (name: string) => string | undefined;
	/** A child process whose exit code is returned. */
	capture: (cmd: string[], cwd: string) => Promise<RunResult>;
	/** A child process that must succeed. */
	run: (cmd: string[], cwd: string) => Promise<RunResult>;
	fetch: typeof fetch;
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	/** Runs another CLI command in this process, with its own argument parsing. */
	command: (name: CommandName, argv: string[]) => Promise<void>;
	now: () => Date;
}

export interface InitContext {
	deps: InitDeps;
	tui: Tui;
	/** The project folder: where init started, or the folder phase 2 created. */
	dir: string;
	state: InitState;
	/** Persists the state (a no-op until the project folder exists). */
	save: () => void;
	/** The number of phases shown in step headers. */
	total: number;
	/** Where this phase sits (1-based). */
	index: (phase: PhaseName) => number;
}

const FLAGS: Record<CommandName, FlagSpec> = { keys: keysFlags, kernel: kernelFlags, deploy: deployFlags, access: accessFlags, backend: backendFlags };

/** The real command table: parses argv as the command line would and runs the command. */
export async function runCliCommand(name: CommandName, argv: string[]): Promise<void> {
	const args: ParsedArgs = parseArgs(argv, FLAGS[name]);
	switch (name) {
		case "keys":
			return keysCommand(args);
		case "kernel":
			return kernelCommand(args);
		case "deploy":
			return deployCommand(args);
		case "access":
			return accessCommand(args);
		case "backend":
			return backendCommand(args);
	}
}

export function realDeps(tui: Tui): InitDeps {
	return {
		tui,
		which: (name) => which(name),
		capture: (cmd, cwd) => capture(cmd, cwd),
		run: (cmd, cwd) => run(cmd, cwd),
		fetch: globalThis.fetch,
		env: process.env,
		platform: process.platform,
		command: runCliCommand,
		now: () => new Date(),
	};
}

/** The `--config <path>` every delegated command gets, so it works whatever the working directory is. */
export function configFlag(ctx: InitContext): string[] {
	return ["--config", join(ctx.dir, "typetorch.json")];
}

/**
 * Sets or replaces `KEY=value` lines in an env file, keeping every other line as it is. A missing file is created.
 * Values are written as they are (no quotes), which is what env.ts reads back.
 */
export function upsertDotEnv(file: string, values: Record<string, string>): { created: boolean; changed: string[] } {
	const created = !existsSync(file);
	const lines = created ? [] : readFileSync(file, "utf8").split(/\r?\n/);
	const changed: string[] = [];
	const seen = new Set<string>();
	const out = lines.map((line) => {
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
		if (!match || !(match[1] in values)) return line;
		seen.add(match[1]);
		const next = `${match[1]}=${values[match[1]]}`;
		if (next !== line) changed.push(match[1]);
		return next;
	});
	while (out.length && out[out.length - 1] === "") out.pop();
	for (const [key, value] of Object.entries(values)) {
		if (seen.has(key)) continue;
		out.push(`${key}=${value}`);
		changed.push(key);
	}
	writeFileSync(file, out.join("\n") + "\n");
	return { created, changed };
}

/** Makes sure `.gitignore` lists `.env` (the template already does; a migrated game may not). */
export function ensureGitignored(dir: string, entry = ".env"): boolean {
	const file = join(dir, ".gitignore");
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (text.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `/${entry}`)) return false;
	writeFileSync(file, `${text.trimEnd()}${text.trim() ? "\n\n" : ""}# secrets (typetorch init)\n${entry}\n`);
	return true;
}

/** `my-game` from "My Game!": lowercase, dashes, nothing else. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}
