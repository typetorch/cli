/**
 * Repair mode (plans "typetorch init", section 1): `typetorch init` in a game that is already set up (every step done,
 * or a game set up by hand before init existed) checks what each step left behind instead of running them all again,
 * lists what is missing or broken, and offers to run that one step. Cheap local checks only, plus the backend's
 * /healthz; `typetorch doctor` remains the full check against Roblox.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProject, type Project } from "../config.ts";
import { ADMIN_TOKEN_VAR, API_KEY_VARS, BACKEND_KEY_VAR, Settings } from "../env.ts";
import { keyFilePaths } from "../keyfiles.ts";
import { AGENT_PROMPT_FILE } from "./agent.ts";
import type { InitContext } from "./common.ts";
import { isDone, markDone, PHASES, type PhaseName } from "./state.ts";

export interface RepairItem {
	phase: PhaseName;
	label: string;
	/** ok; broken (the step should run again); optional (left out on purpose, the step adds it); unknown (init can't check it). */
	status: "ok" | "broken" | "optional" | "unknown";
	detail: string;
}

const LABELS: Record<PhaseName, string> = {
	preflight: "tools",
	project: "project",
	roblox: "Roblox",
	keys: "signing keys",
	kernel: "kernel place",
	backend: "backend",
	deploy: "deploys",
	agent: "agent prompt",
};

async function answers(ctx: InitContext, url: string): Promise<boolean> {
	try {
		return (await ctx.deps.fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).ok;
	} catch {
		return false;
	}
}

/** One line per step: what it should have left behind, checked. */
export async function repairChecks(ctx: InitContext): Promise<RepairItem[]> {
	const { deps, dir } = ctx;
	const item = (phase: PhaseName, status: RepairItem["status"], detail: string): RepairItem => ({ phase, label: LABELS[phase], status, detail });
	const out: RepairItem[] = [];

	const missingTools = (["bun", "git", "rokit"] as const).filter((name) => !deps.which(name));
	out.push(missingTools.length ? item("preflight", "broken", `not on PATH: ${missingTools.join(", ")}`) : item("preflight", "ok", "bun, git and rokit found"));

	const noModules = !existsSync(join(dir, "node_modules", "roblox-ts"));
	out.push(noModules ? item("project", "broken", "node_modules is missing (bun install)") : item("project", "ok", "dependencies installed"));

	let proj: Project | undefined;
	try {
		proj = loadProject(undefined, dir);
	} catch (error) {
		out.push(item("roblox", "broken", `typetorch.json: ${(error as Error).message.split("\n")[0]}`));
	}
	const settings = new Settings({ gameDir: dir, env: deps.env });
	if (proj) {
		const key = API_KEY_VARS.find((name) => settings.get(name));
		out.push(key ? item("roblox", "ok", `universe ${proj.config.universeId}, place ${proj.config.placeId}, ${key} in ${settings.get(key)!.source}`) : item("roblox", "broken", `no Open Cloud key (${API_KEY_VARS[0]}) in .env or the environment`));
		const paths = keyFilePaths(proj);
		const missingKeys = (["main", "fallback"] as const).filter((role) => !existsSync(paths[role]));
		out.push(missingKeys.length ? item("keys", "broken", `no ${missingKeys.join(" or ")} key file on this PC (${missingKeys.map((r) => paths[r]).join(", ")}): restore it from your backup, or make new ones`) : item("keys", "ok", "both key files on this PC"));
	}

	out.push(isDone(ctx.state, "kernel") ? item("kernel", "ok", "published by init") : item("kernel", "unknown", "not published by init here; `typetorch doctor` checks it"));

	const url = proj?.config.backend?.url;
	if (!url) out.push(item("backend", "optional", "none (alerts, automatic rollback and analytics are off)"));
	else {
		const missing = [BACKEND_KEY_VAR, ADMIN_TOKEN_VAR].filter((name) => !settings.get(name));
		if (missing.length) out.push(item("backend", "broken", `${url}, but ${missing.join(" and ")} missing from .env`));
		else out.push((await answers(ctx, url)) ? item("backend", "ok", `${url} answers`) : item("backend", "broken", `${url} does not answer /healthz`));
	}

	const dev = (await deps.capture(["git", "rev-parse", "--verify", "--quiet", "dev"], dir)).exitCode === 0;
	out.push(dev ? item("deploy", "ok", "a dev branch exists") : item("deploy", "broken", "no dev branch yet"));

	out.push(existsSync(join(dir, AGENT_PROMPT_FILE)) ? item("agent", "ok", AGENT_PROMPT_FILE) : item("agent", "optional", `no ${AGENT_PROMPT_FILE}`));
	return out.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
}

/** The repair menu: the checks, then one step to run again, until the person picks "nothing". Returns the steps run. */
export async function repairMenu(ctx: InitContext, run: (phase: PhaseName) => Promise<void>): Promise<PhaseName[]> {
	const { tui } = ctx;
	const ran: PhaseName[] = [];
	tui.note("this game is already set up: checking what each step left behind (`typetorch doctor` checks it against Roblox too)");
	for (;;) {
		const items = await repairChecks(ctx);
		const list = tui.checklist(items.map((i) => i.label));
		items.forEach((i, n) => (i.status === "ok" ? list.done(n, i.detail) : i.status === "broken" ? list.fail(n, i.detail) : list.update(n, i.detail)));
		const broken = items.filter((i) => i.status === "broken");
		const rest = items.filter((i) => i.status !== "broken");
		const choice = await tui.select<PhaseName | "nothing">(
			broken.length ? `${broken.length} step(s) need attention. Run one again?` : "Everything init checks is in place. Run a step again anyway?",
			[
				...broken.map((i) => ({ value: i.phase, label: `Fix the ${i.label}`, hint: i.detail })),
				{ value: "nothing" as const, label: broken.length ? "Not now" : "No, I'm done", hint: "`typetorch init --phase <name>` runs one later" },
				...rest.map((i) => ({ value: i.phase, label: `Run the ${i.label} step again`, hint: i.detail })),
			],
			broken[0]?.phase ?? "nothing",
		);
		if (choice === "nothing") return ran;
		await run(choice);
		markDone(ctx.state, choice, ctx.deps.now);
		ctx.save();
		ran.push(choice);
	}
}
