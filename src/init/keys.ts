/**
 * Phase 4, the prod signing keys: `keys init` and `keys init --fallback` (commands/keys.ts, which also creates the
 * key asset), the key file paths, and a confirm that they are backed up before anything depends on them.
 */
import { loadProject } from "../config.ts";
import { keyFilePaths } from "../keyfiles.ts";
import { DOCS } from "../tui.ts";
import { configFlag, type InitContext } from "./common.ts";

export async function keysPhase(ctx: InitContext): Promise<void> {
	const { tui } = ctx;
	tui.step(ctx.index("keys"), ctx.total, "Signing keys", "Public servers only run prod builds you signed. Two key pairs do it; the public halves go into typetorch.json and a key asset.", `${DOCS}/getting-started/fresh-setup.md#7-prod-signing-keys`);
	const list = tui.checklist(["main key (and the key asset on Roblox)", "fallback key"]);
	await ctx.deps.command("keys", ["init", ...configFlag(ctx)]);
	list.done(0);
	await ctx.deps.command("keys", ["init", "--fallback", ...configFlag(ctx)]);
	list.done(1);
	const proj = loadProject(undefined, ctx.dir);
	const paths = keyFilePaths(proj);
	tui.note(`key files: ${paths.main} and ${paths.fallback}`);
	tui.note("They are plaintext and never leave this PC. Copy both, and the game repo's .env, somewhere offline now");
	tui.note("(a password manager or an encrypted USB stick). A lost main key needs a rotation; a lost fallback key needs a kernel deploy.");
	if (!(await tui.confirm("Backed up both key files?", false))) {
		tui.warn("back them up before the game goes live; `typetorch doctor` keeps reminding you where they are");
	}
	await ctx.deps.capture(["git", "add", "typetorch.json"], ctx.dir);
	await ctx.deps.capture(["git", "commit", "-q", "-m", "Prod signing keys"], ctx.dir);
}
