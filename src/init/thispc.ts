/**
 * The backend on this PC (plans "typetorch init", backend phase): cloudflared (installed on request), a checkout of
 * the backend next to the game with its explorer built, `.typetorch/backend.json`, and `typetorch backend run` as a
 * login task. Then the wizard starts it and waits until the game is pointed at the quick tunnel. No account, no login,
 * no URL for the user to handle: the wrapper re-points the game whenever the tunnel's address changes.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { BACKEND_LOG_FILE, BACKEND_STATUS_FILE, DEFAULT_PORT, readLocalBackendConfig, readRunStatus, writeLocalBackendConfig } from "../backendrun.ts";
import { BACKEND_REPO_URL } from "./coolify.ts";
import { slugify, type InitContext } from "./common.ts";
import { loginTask } from "./logintask.ts";

/** Where cloudflared comes from, per OS. */
export function cloudflaredInstall(platform: NodeJS.Platform, arch: string, home: string): { show: string; cmd?: string[]; path?: string } {
	if (platform === "win32") return { show: "winget install --id Cloudflare.cloudflared -e", cmd: ["winget", "install", "--id", "Cloudflare.cloudflared", "-e", "--accept-source-agreements", "--accept-package-agreements"] };
	if (platform === "darwin") return { show: "brew install cloudflared", cmd: ["brew", "install", "cloudflared"] };
	const asset = arch === "arm64" ? "arm64" : arch === "arm" ? "arm" : "amd64";
	const path = posix.join(home, ".local", "bin", "cloudflared");
	const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${asset}`;
	return { show: `curl -fsSL ${url} -o ${path} && chmod +x ${path}`, cmd: ["curl", "-fsSL", "--create-dirs", url, "-o", path], path };
}

async function ensureCloudflared(ctx: InitContext): Promise<string | undefined> {
	const { tui, deps } = ctx;
	if (deps.which("cloudflared")) return undefined;
	const saved = readLocalBackendConfig(ctx.dir)?.cloudflared;
	if (saved && existsSync(saved)) return saved;
	const how = cloudflaredInstall(deps.platform, process.arch, deps.home);
	tui.note("cloudflared opens the tunnel game servers reach this PC through (Cloudflare's free quick tunnel: no account).");
	tui.note(`  ${how.show}`);
	if (how.cmd && deps.which(how.cmd[0]) && (await tui.confirm("Install it now?", true))) {
		const result = await deps.capture(how.cmd, ctx.dir);
		if (result.exitCode === 0) {
			if (how.path) {
				try {
					chmodSync(how.path, 0o755);
				} catch {}
			}
			if (deps.which("cloudflared")) return undefined;
			if (how.path && existsSync(how.path)) return how.path;
			throw new Error("cloudflared was installed but is not on PATH yet: open a new terminal and run `typetorch init` again; it continues here");
		}
		tui.warn(`the install exited with ${result.exitCode}`);
	}
	throw new Error(`install cloudflared (${how.show}), then run \`typetorch init\` again; it continues here`);
}

/** The status file says the game was pointed after `since`. */
async function waitPointed(ctx: InitContext, since: Date, timeoutMs: number): Promise<ReturnType<typeof readRunStatus>> {
	const deadline = since.getTime() + timeoutMs;
	for (;;) {
		const status = readRunStatus(ctx.dir);
		if (status && Date.parse(status.at) >= since.getTime() && (status.state === "pointed" || status.state === "refused")) return status;
		if (ctx.deps.now().getTime() > deadline) return status;
		await ctx.deps.sleep(2000);
	}
}

export async function thisPcBackend(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	const cloudflared = await ensureCloudflared(ctx);
	const saved = readLocalBackendConfig(ctx.dir);
	const project = (ctx.state.answers.project as string | undefined) ?? slugify(basename(ctx.dir));
	const backendDir = resolve(
		await tui.text("Where should the backend's code go?", {
			default: saved?.dir ?? join(dirname(ctx.dir), `${project}-backend`),
		}),
	);
	const list = tui.checklist(["get the backend's code", "bun install", "build the explorer (the web UI)", "save .typetorch/backend.json"]);
	if (existsSync(join(backendDir, "src", "server", "main.ts"))) {
		const pulled = await deps.capture(["git", "pull", "--ff-only", "-q"], backendDir);
		list.done(0, pulled.exitCode === 0 ? `updated ${backendDir}` : `kept ${backendDir} (git pull failed; using it as it is)`);
	} else {
		if (existsSync(backendDir)) throw new Error(`${backendDir} exists and is not a backend checkout; pick another folder`);
		await deps.run(["git", "clone", "--depth", "1", BACKEND_REPO_URL, backendDir], dirname(backendDir));
		list.done(0, backendDir);
	}
	await deps.run(["bun", "install"], backendDir);
	list.done(1);
	await deps.run(["bun", "run", "web:install"], backendDir);
	await deps.run(["bun", "run", "web:build"], backendDir);
	list.done(2);
	writeLocalBackendConfig(ctx.dir, { dir: backendDir, port: saved?.port ?? DEFAULT_PORT, ...(cloudflared ? { cloudflared } : {}) });
	list.done(3);
	ctx.state.answers.backendDir = backendDir;

	const bun = deps.which("bun");
	const task = bun ? loginTask({ platform: deps.platform, home: deps.home, appData: deps.env.APPDATA, slug: slugify(project) || "game", gameDir: ctx.dir, bun, path: deps.env.PATH ?? "" }) : undefined;
	const start = deps.now();
	if (task && (await tui.confirm(`Start the backend now and at every login? (${task.describe})`, true))) {
		for (const file of task.files) {
			mkdirSync(dirname(file.path), { recursive: true });
			writeFileSync(file.path, file.content);
		}
		mkdirSync(join(ctx.dir, ".typetorch"), { recursive: true });
		for (const [i, cmd] of task.install.entries()) {
			const result = await deps.capture(cmd, ctx.dir);
			// launchctl unload of a job that is not loaded yet fails; that is expected.
			if (result.exitCode !== 0 && !(deps.platform === "darwin" && i === 0)) throw new Error(`${cmd.join(" ")} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
		}
		ctx.state.answers.backendTask = true;
	} else {
		tui.note("Then start it yourself whenever you test: `bun run typetorch backend run` in the game folder (Ctrl+C stops it).");
		tui.note("Run it in another terminal now; the wizard waits for it to point the game at its tunnel.");
	}
	tui.note("starting: the backend, then a quick tunnel (up to a minute), then the game is pointed at it");
	const status = await waitPointed(ctx, start, 4 * 60_000);
	if (status?.state === "pointed") {
		tui.note(`game servers use ${status.url}; it changes when the tunnel restarts and the game follows by itself`);
		tui.note(`explorer: ${status.local} (sign in with TYPETORCH_ADMIN_TOKEN from the game's .env)`);
		tui.note("the tunnel is public: the explorer relies on the 32-character admin token and locks out after five wrong tries");
		return;
	}
	const log = join(ctx.dir, BACKEND_LOG_FILE);
	if (status?.state === "refused") throw new Error(`the backend runs, but \`backend setup\` refused the tunnel: ${status.error}. The log is ${log}; fix it and run \`typetorch init\` again`);
	throw new Error(`the backend did not report a pointed tunnel within 4 minutes (${join(ctx.dir, BACKEND_STATUS_FILE)}). Look at ${log}, then run \`typetorch init\` again; it continues here`);
}
