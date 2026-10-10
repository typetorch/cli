/**
 * Phase 2, the project: the starter template cloned into this folder (when it is empty) or a new subfolder, the
 * template's origin dropped, `bun install`, `rokit install`, and a first `typetorch build` as the check.
 */
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DOCS } from "../tui.ts";
import { slugify, type InitContext } from "./common.ts";
import { folderKind } from "./preflight.ts";

export const TEMPLATE_URL = "https://github.com/typetorch/template";

export function nameProblem(name: string): string | undefined {
	if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return "use lowercase letters, digits and dashes (for example my-game)";
	return undefined;
}

export async function projectPhase(ctx: InitContext): Promise<void> {
	const { tui } = ctx;
	tui.step(ctx.index("project"), ctx.total, "Project", "A new game starts from the starter template (Target Rush); every TypeTorch package comes from npm.", `${DOCS}/getting-started/fresh-setup.md#2-get-the-code`);
	const kind = folderKind(ctx.dir);
	if (kind === "typetorch") {
		tui.note(`${ctx.dir} already has typetorch.json: continuing with it`);
		return;
	}
	if (kind === "roblox-ts") {
		throw new Error(
			`${ctx.dir} is an existing roblox-ts game. Moving a game to TypeTorch is a migration, which a coding agent does from the playbook: tell it "migrate this project to typetorch" (${DOCS}/agents/AGENTS.md; for Claude Code: /plugin marketplace add typetorch/claude-plugin). Run \`typetorch init\` in an empty folder for a new game.`,
		);
	}
	let target = ctx.dir;
	let name = ctx.state.answers.project as string | undefined;
	if (kind === "empty") {
		name ??= await tui.text("Project name", { default: slugify(basename(ctx.dir)) || "my-game", validate: nameProblem });
	} else {
		tui.note(`${ctx.dir} has files in it, so the game goes in a new subfolder.`);
		name ??= await tui.text("Project name (also the folder)", { default: "my-game", validate: nameProblem });
		target = resolve(ctx.dir, name);
		if (existsSync(target) && folderKind(target) !== "empty") throw new Error(`${target} exists and is not empty; pick another name or empty it`);
	}
	ctx.state.answers.project = name;
	const steps = ["clone the template", "drop the template's origin", "bun install", "rokit install (Rojo and Lune)", "typetorch build"];
	const list = tui.checklist(steps);
	await ctx.deps.run(["git", "clone", "--depth", "1", TEMPLATE_URL, target], ctx.dir);
	list.done(0, target);
	ctx.dir = target;
	await ctx.deps.run(["git", "remote", "remove", "origin"], target);
	list.done(1);
	await ctx.deps.run(["bun", "install"], target);
	list.done(2);
	await ctx.deps.run(["rokit", "install", "--no-trust-check"], target);
	list.done(3);
	const built = await ctx.deps.capture(["bun", "run", "typetorch", "build"], target);
	if (built.exitCode !== 0) {
		list.fail(4, `exit ${built.exitCode}`);
		throw new Error(`the first build failed in ${target}:\n${[built.stdout, built.stderr].join("\n").trim().split(/\r?\n/).slice(-20).join("\n")}`);
	}
	const line = built.stdout.split(/\r?\n/).find((l) => /^built /.test(l.trim()));
	list.done(4, line?.trim() ?? "ok");
	tui.note(`the game is in ${join(target)}: src/ holds the code, typetorch.json the settings (next step)`);
}
