/**
 * Phase 8, the handoff to a coding agent: two lines about the game, then AGENT_PROMPT.md in the repo with what init
 * set up, the ids, the branch map, the playbook's rules and those two lines. If `claude` is on PATH, offers to start
 * it with the prompt and the typetorch plugin marketplace added.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS } from "../tui.ts";
import type { InitContext } from "./common.ts";

export const AGENT_PROMPT_FILE = "AGENT_PROMPT.md";

export interface PromptInput {
	project: string;
	universeId: number;
	placeId: number;
	ownerId: number;
	backend?: string;
	about: string;
	first: string;
}

export function agentPrompt(input: PromptInput): string {
	return `# ${input.project}: build this game with TypeTorch

Written by \`typetorch init\`. Paste this file's contents into your coding agent (Claude Code, Codex, Cursor, Copilot,
Aider...) as its first message, or run \`typetorch init --agent\` to print it again.

## What is already set up

- A TypeTorch game from the starter template (Target Rush) in this folder: roblox-ts, \`@typetorch/framework\`,
  services and controllers under \`src/\`, the dev menu, analytics wiring.
- \`typetorch.json\`: universe ${input.universeId}, place ${input.placeId}, owner user ${input.ownerId}; git \`main\` is the
  TypeTorch branch \`prod\` (signed, cloud-tested, approved at a terminal), git \`dev\` is \`dev\` (unsigned, private servers).
- Prod signing keys, the kernel place, and a first deploy of both branches.
${input.backend ? `- A backend at ${input.backend}: live servers, deploy reports, alerts, analytics.` : "- No backend yet (\`typetorch backend setup\` later)."}

## The game

${input.about.trim() || "(not described)"}

## The first version should

${input.first.trim() || "(not described)"}

## Rules (from the TypeTorch agent playbook: ${DOCS}/agents/AGENTS.md)

1. Never create, ask for, read, print or store a secret: \`.env\`, key files under \`~/.config/typetorch/keys\`, API keys.
2. Never act on Roblox: no \`typetorch deploy\`, \`upload\`, \`kernel deploy\`, \`keys\`, \`access push\`, \`backend setup\`,
   \`doctor\`, nothing that publishes or uploads. Build and check locally (\`bun run build\`, \`bun run typetorch build\`).
3. Never push. Commit on a branch.
4. Don't edit \`node_modules/@typetorch/*\`. Don't weaken security (no new RemoteEvents outside the typed network,
   no \`loadstring\`, no \`_G\`). Don't change player data formats.
5. Read the framework guides before writing code: ${DOCS}/README.md (state that survives swaps, networking, player
   data, hot assets, analytics).
6. Finish with a numbered "What you need to do" list: the commands the person runs (deploy to dev, test in a
   private server with \`/tt new dev\`, then deploy prod), and anything that needs Studio.

Start by reading \`src/\` and \`typetorch.json\`, then propose a short plan before changing code.
`;
}

export async function agentPhase(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	tui.step(ctx.index("agent"), ctx.total, "Hand off to an agent", "A coding agent builds the game itself; this writes the prompt it starts from.", `${DOCS}/agents/AGENTS.md`);
	const about = await tui.text("What is your game, in one line?", { default: (ctx.state.answers.about as string | undefined) ?? "" });
	const first = await tui.text("What should the first version do?", { default: (ctx.state.answers.first as string | undefined) ?? "" });
	ctx.state.answers.about = about;
	ctx.state.answers.first = first;
	const text = agentPrompt({
		project: String(ctx.state.answers.project ?? "my-game"),
		universeId: Number(ctx.state.answers.universeId ?? 0),
		placeId: Number(ctx.state.answers.placeId ?? 0),
		ownerId: Number(ctx.state.answers.ownerId ?? 0),
		backend: typeof ctx.state.answers.backendUrl === "string" ? ctx.state.answers.backendUrl : undefined,
		about,
		first,
	});
	const file = join(ctx.dir, AGENT_PROMPT_FILE);
	writeFileSync(file, text);
	tui.note(`written: ${file}`);
	const claude = deps.which("claude");
	if (claude && tui.interactive && (await tui.confirm("Claude Code is installed. Start it here with this prompt?", true))) {
		tui.note("adding the typetorch plugin marketplace, then starting Claude Code (Ctrl+C returns here)");
		await new Promise<void>((resolve) => {
			const add = spawn(claude, ["plugin", "marketplace", "add", "typetorch/claude-plugin"], { cwd: ctx.dir, stdio: "inherit" });
			add.on("exit", () => resolve());
			add.on("error", () => resolve());
		});
		await new Promise<void>((resolve) => {
			const child = spawn(claude, [text], { cwd: ctx.dir, stdio: "inherit" });
			child.on("exit", () => resolve());
			child.on("error", () => resolve());
		});
	} else {
		tui.note("paste it into your agent's first message. For Claude Code: /plugin marketplace add typetorch/claude-plugin");
	}
}

/** `typetorch init --agent`: the prompt written last time, or an error that says to run init. */
export function readAgentPrompt(dir: string): string {
	const file = join(dir, AGENT_PROMPT_FILE);
	if (!existsSync(file)) throw new Error(`${file} does not exist yet: run \`typetorch init\` to the end first`);
	return readFileSync(file, "utf8");
}
