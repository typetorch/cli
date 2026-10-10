/**
 * Phase 5, the kernel place: the only TypeTorch code baked into the place. An empty place takes the whole kernel
 * place (`kernel deploy --replace-place`); a place with Studio-built content gets only the kernel patched in
 * (`kernel deploy --install`, the luau engine). Then the person joins the game and checks `/tt status`.
 */
import { DOCS } from "../tui.ts";
import { configFlag, type InitContext } from "./common.ts";

export async function kernelPhase(ctx: InitContext): Promise<void> {
	const { tui } = ctx;
	tui.step(ctx.index("kernel"), ctx.total, "Kernel place", "A small loader is the only TypeTorch code in the place; it loads your builds and swaps them live.", `${DOCS}/getting-started/fresh-setup.md#8-publish-the-kernel-place-owner`);
	const empty = await tui.select("Is this place empty (a fresh baseplate), or does it already have content built in Studio?", [
		{ value: "empty", label: "Empty: a fresh baseplate", hint: "the kernel place replaces it (a baseplate, a spawn and the kernel)" },
		{ value: "content", label: "It has content", hint: "only the kernel is patched into the live place; nothing else changes (needs 'Allow place to be updated using Save Place API' in Creator Hub > Permissions)" },
	], (ctx.state.answers.placeContent as "empty" | "content" | undefined) ?? "empty");
	ctx.state.answers.placeContent = empty;
	tui.note("Studio must not have the place open in Team Create while this publishes.");
	if (empty === "empty") {
		tui.note("Dry run first: the kernel's syntax check, its version and hash, and your trust roots stamped.");
		await ctx.deps.command("kernel", ["deploy", "--dry-run", ...configFlag(ctx)]);
		if (!(await tui.confirm("Publish the kernel place now? This replaces the whole place (a fresh baseplate loses nothing)", true))) throw new Error("not published; run `typetorch init` again when ready");
		await ctx.deps.command("kernel", ["deploy", "--replace-place", "--yes", ...configFlag(ctx)]);
	} else {
		tui.note("The patch asks y/N itself after showing what changes.");
		await ctx.deps.command("kernel", ["deploy", "--install", ...configFlag(ctx)]);
	}
	tui.note("Check: join the game from the Roblox app, open the Developer Console (F9) > Server. You should see");
	tui.note("  [TypeTorch] kernel ... on a public server, branch prod, signed deploys only (keys: key asset)");
	tui.note("and `/tt status` in chat answers you (you are the owner, so you are a dev). Keep that server open for the first deploy.");
	if (!(await tui.confirm("Did the server print the TypeTorch kernel line?", true))) {
		tui.warn(`if not, see ${DOCS}/guides/troubleshooting.md and run \`typetorch doctor\`; \`typetorch init\` continues from here`);
		throw new Error("the kernel place is not confirmed; fix it and run `typetorch init` again");
	}
}
