/**
 * Phase 1, preflight: the tools (Bun, git, Rokit) and what kind of folder this is. Bun is installed on request with
 * its official script after a y/N that shows the command; Rokit and git are pointed at, then re-checked until they
 * are on PATH. An existing roblox-ts game is a migration (the agent playbook does that), not an init; a folder that
 * already has typetorch.json is resumed or repaired.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS } from "../tui.ts";
import type { InitContext } from "./common.ts";

export type FolderKind = "empty" | "typetorch" | "roblox-ts" | "other";

/** What is in `dir`: nothing (or only dotfiles and a README), a TypeTorch game, a roblox-ts game, or something else. */
export function folderKind(dir: string): FolderKind {
	if (!existsSync(dir)) return "empty";
	if (existsSync(join(dir, "typetorch.json"))) return "typetorch";
	const pkg = join(dir, "package.json");
	if (existsSync(pkg)) {
		try {
			const parsed = JSON.parse(readFileSync(pkg, "utf8"));
			const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
			if ("roblox-ts" in deps || "@rbxts/types" in deps) return "roblox-ts";
		} catch {}
		return "other";
	}
	const entries = readdirSync(dir).filter((name) => !name.startsWith(".") && !/^(readme|license)(\..*)?$/i.test(name));
	return entries.length === 0 ? "empty" : "other";
}

export interface ToolCheck {
	name: "bun" | "git" | "rokit";
	found: boolean;
	version?: string;
}

export async function checkTools(ctx: InitContext): Promise<ToolCheck[]> {
	const out: ToolCheck[] = [];
	for (const name of ["bun", "git", "rokit"] as const) {
		if (!ctx.deps.which(name)) {
			out.push({ name, found: false });
			continue;
		}
		const result = await ctx.deps.capture([name, "--version"], ctx.dir);
		out.push({ name, found: result.exitCode === 0, version: result.stdout.trim().replace(/^(git version|rokit)\s*/i, "") || undefined });
	}
	return out;
}

const INSTALL: Record<ToolCheck["name"], { why: string; how: (platform: NodeJS.Platform) => string; url: string }> = {
	bun: {
		why: "the package manager that installs TypeTorch and runs the builds",
		how: (platform) => (platform === "win32" ? 'powershell -c "irm bun.sh/install.ps1 | iex"' : "curl -fsSL https://bun.sh/install | bash"),
		url: "https://bun.sh",
	},
	git: {
		why: "every build is identified by its commit",
		how: (platform) => (platform === "win32" ? "winget install Git.Git" : platform === "darwin" ? "xcode-select --install   (or: brew install git)" : "sudo apt-get install -y git   (or your distribution's package manager)"),
		url: "https://git-scm.com",
	},
	rokit: {
		why: "pins Rojo and Lune per project",
		how: () => "download the release for your OS from the releases page, run it once (`rokit self-install`), then open a new terminal",
		url: "https://github.com/rojo-rbx/rokit/releases",
	},
};

export async function preflightPhase(ctx: InitContext): Promise<void> {
	const { tui } = ctx;
	tui.step(ctx.index("preflight"), ctx.total, "Tools", "Bun, git and Rokit are the three tools TypeTorch needs on this machine.", `${DOCS}/getting-started/fresh-setup.md#1-install-the-tools`);
	for (;;) {
		const checks = await checkTools(ctx);
		const list = tui.checklist(checks.map((c) => `${c.name}${INSTALL[c.name] ? `  ${INSTALL[c.name].why}` : ""}`));
		checks.forEach((c, i) => (c.found ? list.done(i, c.version ?? "found") : list.fail(i, "not found on PATH")));
		const missing = checks.filter((c) => !c.found);
		if (missing.length === 0) break;
		for (const tool of missing) {
			const how = INSTALL[tool.name];
			if (tool.name === "bun") {
				tui.note(`Bun installs with its official script:  ${how.how(ctx.deps.platform)}`);
				if (await tui.confirm("Run it now?", true)) {
					const cmd = ctx.deps.platform === "win32" ? ["powershell", "-c", "irm bun.sh/install.ps1 | iex"] : ["bash", "-c", "curl -fsSL https://bun.sh/install | bash"];
					const result = await ctx.deps.capture(cmd, ctx.dir);
					if (result.exitCode !== 0) tui.warn(`the installer exited with ${result.exitCode}; install Bun from ${how.url} and run \`typetorch init\` again`);
					else tui.note("installed. If the next check still misses it, open a new terminal and run `typetorch init` again: it continues here.");
				}
				continue;
			}
			tui.note(`${tool.name}: ${how.how(ctx.deps.platform)}  (${how.url})`);
		}
		if (!(await tui.confirm("Installed them? Check again", true))) throw new Error(`missing tools: ${missing.map((m) => m.name).join(", ")}. Install them and run \`typetorch init\` again; it continues here`);
	}
}
