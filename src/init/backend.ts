/**
 * Phase 6, the backend (optional). This release offers two answers: a backend that already runs (its URL and two
 * keys, then `backend setup`), or skip. The installers (Coolify, a Linux service, this PC behind a quick tunnel) are
 * the next milestones of plans "typetorch init"; until then the backend repo's README has the steps.
 */
import { join } from "node:path";
import { ADMIN_TOKEN_VAR, BACKEND_KEY_VAR, Settings, registerSecret, useSettings } from "../env.ts";
import { DOCS } from "../tui.ts";
import { configFlag, upsertDotEnv, type InitContext } from "./common.ts";

export const BACKEND_README = "https://github.com/typetorch/backend#readme";

export async function backendPhase(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	tui.step(ctx.index("backend"), ctx.total, "Backend (optional)", "A self-hosted server: live servers, deploy reports, alerts, automatic rollback and your own analytics.", `${DOCS}/guides/fleet-and-alerts.md`);
	const choice = await tui.select("Where does the backend run?", [
		{ value: "skip", label: "Skip for now", hint: "everything else works; you lose alerts, the automatic rollback after a bad deploy, and analytics" },
		{ value: "existing", label: "I already run one", hint: `its https address and its two keys (${BACKEND_README})` },
	], (ctx.state.answers.backend as "skip" | "existing" | undefined) ?? "skip");
	ctx.state.answers.backend = choice;
	if (choice === "skip") {
		tui.note(`later: ${BACKEND_README} (Coolify or a small VPS), then \`typetorch backend setup --url https://...\``);
		return;
	}
	const url = await tui.text("The backend's public https address", {
		default: ctx.state.answers.backendUrl as string | undefined,
		validate: (text) => (/^https:\/\/[^/\s]+$/.test(text) ? undefined : "an https:// address with no path, for example https://backend.example.com"),
	});
	ctx.state.answers.backendUrl = url;
	const current = new Settings({ gameDir: ctx.dir, env: deps.env });
	const values: Record<string, string> = {};
	for (const [name, what] of [
		[BACKEND_KEY_VAR, "the backend's game key (TYPETORCH_API_KEY on the server)"],
		[ADMIN_TOKEN_VAR, "the backend's admin token (TYPETORCH_ADMIN_TOKEN on the server)"],
	] as const) {
		if (current.get(name)) {
			tui.note(`${name} is already set in ${current.get(name)!.source}`);
			continue;
		}
		const value = await tui.secret(`Paste ${what}`, { validate: (t) => (t.length < 32 ? "32 characters or more" : undefined) });
		registerSecret(value);
		values[name] = value;
	}
	if (Object.keys(values).length) {
		upsertDotEnv(join(ctx.dir, ".env"), values);
		useSettings(new Settings({ gameDir: ctx.dir, env: deps.env }));
	}
	tui.note("Checking the address and both keys, then writing the signed settings record (servers follow it within seconds).");
	await deps.command("backend", ["setup", "--url", url, ...configFlag(ctx)]);
	await deps.capture(["git", "add", "typetorch.json"], ctx.dir);
	await deps.capture(["git", "commit", "-q", "-m", "Backend"], ctx.dir);
}
