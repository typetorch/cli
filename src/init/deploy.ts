/**
 * Phase 7, the first deploy and a dev branch: commit, `deploy` on main (prod: cloud test, y/N, signed), the check in
 * game, then `git switch -c dev`, `deploy` again (unsigned, no y/N) and `access push` so members get the dev menu.
 */
import { DOCS } from "../tui.ts";
import { configFlag, type InitContext } from "./common.ts";

export async function deployPhase(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	tui.step(ctx.index("deploy"), ctx.total, "First deploy", "Build, upload, cloud test, your y/N, then every live server swaps to it in a few seconds.", `${DOCS}/getting-started/fresh-setup.md#9-first-deploy`);
	await deps.capture(["git", "add", "-A"], ctx.dir);
	await deps.capture(["git", "commit", "-q", "-m", "First build"], ctx.dir);
	const branch = (await deps.capture(["git", "branch", "--show-current"], ctx.dir)).stdout.trim();
	if (branch !== "main") {
		tui.note(`you are on git branch ${branch || "(detached)"}; main maps to the prod branch`);
		await deps.run(["git", "switch", "-c", "main"], ctx.dir).catch(() => deps.run(["git", "switch", "main"], ctx.dir));
	}
	tui.note("Keep a game server open (you joined it in the last step): the first deploy is stored by the servers that receive it.");
	await deps.command("deploy", [...configFlag(ctx)]);
	tui.note("Check: in game, within a few seconds, the Target Rush pad and the lobby coins appear and you stay connected.");
	tui.note("`/tt status` shows the generation; `bun run typetorch deployments` lists #1 as live.");
	if (!(await tui.confirm("Did the game change in front of you?", true))) tui.warn(`see ${DOCS}/guides/troubleshooting.md; \`bun run typetorch report latest\` shows what each server did`);

	tui.note("A dev branch: unsigned, no y/N, ignored by public servers. `/tt new dev` in game opens a private server on it.");
	if (await tui.confirm("Create a dev branch and deploy it?", true)) {
		const exists = (await deps.capture(["git", "rev-parse", "--verify", "dev"], ctx.dir)).exitCode === 0;
		await deps.run(exists ? ["git", "switch", "dev"] : ["git", "switch", "-c", "dev"], ctx.dir);
		await deps.command("deploy", [...configFlag(ctx)]);
		tui.note("In game: `/tt new dev` teleports you to a reserved server running dev. Change a value in src/shared/rush/config.ts,");
		tui.note("commit, `bun run typetorch deploy`, and watch it change while you play.");
	}
	tui.note("Publishing who gets the dev menu (typetorch.json members), signed, so servers apply it within seconds.");
	await deps.command("access", ["push", ...configFlag(ctx)]);
}
