/**
 * `typetorch init`: the guided installer (plans "typetorch init"). Eight phases, each ask, do, check: tools, the
 * project from the template, Roblox (experience, key, owner, typetorch.json), signing keys, the kernel place, the
 * backend (optional), the first deploy and a dev branch, and the prompt for a coding agent. Progress is kept in
 * `.typetorch/init.json` (never a secret), so a run that stops continues at the first unfinished phase. The phases
 * delegate to the commands that exist (`keys init`, `kernel deploy`, `deploy`, `access push`, `backend setup`) and
 * check with what `doctor` checks.
 *
 *   --answers <file>  replay answers from a JSON array (tests, agents); a secret is never read from it
 *   --dir <folder>    where to start (default: the working directory, or the game it is inside)
 *   --phase <name>    run again from this phase (preflight, project, roblox, keys, kernel, backend, deploy, agent)
 *   --agent           print AGENT_PROMPT.md again and stop
 *   --teardown        remove the backend the backend phase installed, after a y/N
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { findProjectRoot } from "../config.ts";
import { NotInteractiveError, PromptCancelledError } from "../interact.ts";
import { bold, dim, green, info, isJson, warn } from "../log.ts";
import { agentPhase, readAgentPrompt } from "../init/agent.ts";
import { backendPhase, backendTeardown } from "../init/backend.ts";
import { realDeps, type InitContext, type InitDeps } from "../init/common.ts";
import { deployPhase } from "../init/deploy.ts";
import { kernelPhase } from "../init/kernel.ts";
import { keysPhase } from "../init/keys.ts";
import { preflightPhase } from "../init/preflight.ts";
import { projectPhase } from "../init/project.ts";
import { robloxPhase } from "../init/roblox.ts";
import { emptyState, isDone, markDone, PHASES, readState, writeState, type PhaseName } from "../init/state.ts";
import { scriptedTui, terminalTui, type Tui } from "../tui.ts";

export const initFlags = { answers: "string", dir: "string", phase: "string", agent: "boolean", teardown: "boolean" } as const;

export const INIT_USAGE = `typetorch init [--dir <folder>] [--phase <name>] [--answers <file>] [--agent] [--teardown]

  The guided setup: from an empty folder to a live game that hot-swaps, one question at a time. Each step says why
  it exists and which doc it replaces, does the work, and checks it the way \`typetorch doctor\` would.
    1. tools        Bun, git, Rokit (offers to install Bun)
    2. project      the starter template, bun install, rokit install, a first build
    3. roblox       your experience (paste its URL), the Open Cloud key (probed, written to .env), the owner,
                    typetorch.json (shown before it is written)
    4. keys         the two prod signing keys and the key asset (\`keys init\`, \`keys init --fallback\`)
    5. kernel       the kernel place (\`kernel deploy --replace-place\` for an empty place, a patch otherwise)
    6. backend      optional: a VPS with Coolify (over SSH or on it; Coolify installed when missing; your domain or
                    a free sslip.io name), a VPS with no Docker (a systemd service with Caddy in front), this PC behind a free Cloudflare quick tunnel (\`backend run\` as a login
                    task), a backend you already run, or skip
    7. deploy       the first prod deploy, a dev branch, \`access push\`
    8. agent        AGENT_PROMPT.md for your coding agent (and starts Claude Code when it is installed)
  Stopped half way (Ctrl+C, a failed check)? Run it again: it continues at the first unfinished step
  (.typetorch/init.json; it holds no secret).
  --dir <folder>    start there instead of the working directory
  --phase <name>    run again from that step: preflight, project, roblox, keys, kernel, backend, deploy, agent
  --answers <file>  a JSON array of answers, one per question, for scripts and tests; secrets come from the
                    environment or .env, never from the file
  --agent           print AGENT_PROMPT.md again
  --teardown        remove the backend step 6 installed (asks first; its data only when you say so)`;

const RUNNERS: Record<PhaseName, (ctx: InitContext) => Promise<void>> = {
	preflight: preflightPhase,
	project: projectPhase,
	roblox: robloxPhase,
	keys: keysPhase,
	kernel: kernelPhase,
	backend: backendPhase,
	deploy: deployPhase,
	agent: agentPhase,
};

export interface InitOptions {
	dir?: string;
	phase?: PhaseName;
	tui?: Tui;
	deps?: Partial<InitDeps>;
	/** Only these phases run (tests). Default: all. */
	only?: PhaseName[];
	/** Remove the installed backend instead of running phases. */
	teardown?: boolean;
}

/** Runs the installer; returns the phases that ran. Throws on a failed phase (the message says how to continue). */
export async function runInit(options: InitOptions = {}): Promise<{ ran: PhaseName[]; dir: string }> {
	const start = resolve(options.dir ?? process.cwd());
	const tui = options.tui ?? terminalTui();
	const deps: InitDeps = { ...realDeps(tui), ...options.deps, tui };
	const dir = findProjectRoot(start) ?? start;
	const state = existsSync(dir) ? readState(dir) : emptyState();
	if (options.phase) for (const name of PHASES.slice(PHASES.indexOf(options.phase))) delete state.done[name];
	const phases = options.only ?? [...PHASES];
	const ctx: InitContext = {
		deps,
		tui,
		dir,
		state,
		total: PHASES.length,
		index: (phase) => PHASES.indexOf(phase) + 1,
		save: () => {
			// Nothing to keep before the project folder exists; from then on every finished phase is recorded.
			if (existsSync(resolve(ctx.dir, "typetorch.json")) || isDone(ctx.state, "project")) writeState(ctx.dir, ctx.state);
		},
	};
	const ran: PhaseName[] = [];
	if (options.teardown) {
		await backendTeardown(ctx);
		return { ran, dir };
	}
	const pending = phases.filter((name) => !isDone(state, name));
	if (pending.length === 0) {
		tui.note(`every step is done for ${dir}. \`typetorch init --phase <name>\` runs one again; \`typetorch init --agent\` prints the agent prompt`);
		return { ran, dir };
	}
	if (pending.length < phases.length) tui.note(`continuing at step ${ctx.index(pending[0])} (${pending[0]}); ${phases.length - pending.length} already done`);
	for (const name of pending) {
		try {
			await RUNNERS[name](ctx);
		} catch (error) {
			ctx.save();
			if (error instanceof PromptCancelledError) throw new PromptCancelledError();
			throw error;
		}
		markDone(ctx.state, name, deps.now);
		ctx.save();
		ran.push(name);
	}
	return { ran, dir: ctx.dir };
}

export async function initCommand(args: ParsedArgs): Promise<void> {
	if (isJson()) throw new UsageError("init is interactive and has no --json");
	const dir = flagString(args, "dir");
	if (flagBool(args, "agent")) {
		const root = findProjectRoot(resolve(dir ?? process.cwd()));
		if (!root) throw new UsageError("not inside a TypeTorch game (no typetorch.json): run `typetorch init` first");
		info(readAgentPrompt(root));
		return;
	}
	const phaseFlag = flagString(args, "phase");
	if (phaseFlag !== undefined && !(PHASES as readonly string[]).includes(phaseFlag)) throw new UsageError(`--phase must be one of ${PHASES.join(", ")}`);
	let tui: Tui | undefined;
	const answersFile = flagString(args, "answers");
	if (answersFile) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(answersFile, "utf8"));
		} catch (error) {
			throw new UsageError(`--answers ${answersFile}: ${(error as Error).message}`);
		}
		if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) throw new UsageError(`--answers ${answersFile}: a JSON array of strings`);
		tui = scriptedTui(parsed);
	}
	info(bold("typetorch init") + dim("  the guided setup; Ctrl+C stops, running it again continues"));
	try {
		const { ran, dir: finalDir } = await runInit({ dir, phase: phaseFlag as PhaseName | undefined, tui, teardown: flagBool(args, "teardown") });
		if (ran.length) {
			info("");
			info(green(bold("done.")) + ` ${finalDir}`);
			info(`  deploy:      bun run typetorch deploy          (on main: prod; on dev: a private-server branch)`);
			info(`  live:        bun run typetorch deployments, servers, report latest`);
			info(`  check:       bun run typetorch doctor`);
			info(`  agent:       AGENT_PROMPT.md (typetorch init --agent prints it)`);
		}
	} catch (error) {
		if (error instanceof PromptCancelledError) {
			warn("stopped. Run `typetorch init` again to continue where you were");
			process.exitCode = 130;
			return;
		}
		if (error instanceof NotInteractiveError) throw new UsageError(`${error.message}. \`typetorch init\` asks questions at a terminal; scripts use --answers <file>`);
		throw error;
	}
}
