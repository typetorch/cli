/**
 * `typetorch serve --remote`'s tunnel: a Cloudflare Quick Tunnel (TryCloudflare) to the remote gateway, as the
 * dev-server opens one for remote-claude. No account, no login: `cloudflared tunnel --url http://127.0.0.1:<port>`
 * prints a random https://<words>.trycloudflare.com address that lives as long as the process. The gateway does all
 * of its own auth (device tokens), so a public address is fine.
 *
 * cloudflared runs with an empty --config, because a named tunnel's ~/.cloudflared/config.yml would otherwise take
 * over the quick tunnel. When it dies it is started again, and the new address (quick tunnel URLs don't survive a
 * restart) goes to `onUrl` once it answers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tunnelUrlIn } from "../backendrun.ts";
import { childEnv } from "../env.ts";
import { cloudflaredInstall } from "../init/thispc.ts";
import { which } from "../runtime.ts";

type Log = (level: "info" | "warn" | "error", text: string) => void;

/** cloudflared on PATH, or where winget / the Linux install put it (a new install isn't on this process's PATH). */
export function locateCloudflared(): string | undefined {
	const onPath = which("cloudflared");
	if (onPath) return onPath;
	const places: string[] = [];
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA ?? "";
		places.push(
			join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "cloudflared", "cloudflared.exe"),
			join(process.env.ProgramFiles ?? "C:\\Program Files", "cloudflared", "cloudflared.exe"),
		);
		if (local) places.push(join(local, "Microsoft", "WinGet", "Links", "cloudflared.exe"));
	} else {
		places.push(join(homedir(), ".local", "bin", "cloudflared"), "/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/bin/cloudflared");
	}
	return places.find((path) => existsSync(path));
}

/** Finds cloudflared, installing it when it's missing (winget, brew, or the release binary in ~/.local/bin). */
export async function ensureCloudflared(log: Log): Promise<string> {
	const found = locateCloudflared();
	if (found) return found;
	const how = cloudflaredInstall(process.platform, process.arch, homedir());
	if (!how.cmd || !which(how.cmd[0])) throw new Error(`cloudflared isn't installed: ${how.show}`);
	log("info", `cloudflared isn't installed; installing it (${how.show})`);
	const code = await new Promise<number | null>((done) => {
		const child = spawn(how.cmd![0], how.cmd!.slice(1), { stdio: "ignore", windowsHide: true });
		child.on("error", () => done(-1));
		child.on("exit", done);
	});
	if (how.path && existsSync(how.path)) {
		try {
			chmodSync(how.path, 0o755);
		} catch {}
	}
	const after = locateCloudflared();
	if (!after) throw new Error(`installing cloudflared failed (exit ${code}); install it yourself (${how.show}) and start serve again`);
	log("info", `cloudflared installed: ${after}`);
	return after;
}

export interface QuickTunnelOptions {
	exe: string;
	/** The local port it forwards to (the remote gateway). */
	port: number;
	log: Log;
	/** Every new public address, once it answers (the first start and every restart). */
	onUrl: (url: string) => void;
	/** How long a new address may take to answer before serve says so (a new quick tunnel can take a minute). */
	reachTimeoutMs?: number;
	fetch?: typeof fetch;
}

export class QuickTunnel {
	url?: string;
	private child?: ChildProcess;
	private stopped = false;
	private restarts = 0;
	private readonly config: string;
	private readonly recent: string[] = [];
	private readonly fetch: typeof fetch;

	constructor(private readonly options: QuickTunnelOptions) {
		this.config = join(mkdtempSync(join(tmpdir(), "tt-serve-tunnel-")), "config.yml");
		writeFileSync(this.config, "# empty: a quick tunnel even when ~/.cloudflared/config.yml exists\n");
		this.fetch = options.fetch ?? fetch;
	}

	start() {
		this.stopped = false;
		this.spawn();
	}

	stop() {
		this.stopped = true;
		this.child?.kill();
		this.child = undefined;
		this.url = undefined;
	}

	private spawn() {
		const { exe, port, log } = this.options;
		const child = spawn(exe, ["tunnel", "--config", this.config, "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: childEnv(),
		});
		this.child = child;
		let found: string | undefined;
		const onText = (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				if (!line.trim()) continue;
				this.recent.push(line);
				if (this.recent.length > 20) this.recent.shift();
				const url = found ? undefined : tunnelUrlIn(line);
				if (url) {
					found = url;
					this.url = url;
					log("info", `tunnel ${url}: waiting for it to answer (a new quick tunnel can take a minute)`);
					void this.announce(child, url);
				}
			}
		};
		child.stdout?.on("data", onText);
		child.stderr?.on("data", onText);
		child.on("error", (error) => log("error", `cloudflared: ${error.message}`));
		child.on("exit", (code) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.url = undefined;
			if (this.stopped) return;
			this.restarts += 1;
			const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.restarts - 1, 5));
			const last = found ? "" : `; last output:\n${this.recent.slice(-6).join("\n")}`;
			log("warn", `cloudflared exited (${code}); a new tunnel in ${Math.round(delay / 1000)} s (its address changes: remote Studios pair again with the new link)${last}`);
			setTimeout(() => {
				if (!this.stopped) this.spawn();
			}, delay);
		});
	}

	/** Waits until the address reaches the gateway (GET /tt/ping), then hands it out. */
	private async announce(child: ChildProcess, url: string) {
		const deadline = Date.now() + (this.options.reachTimeoutMs ?? 120_000);
		let warned = false;
		while (this.child === child && !this.stopped) {
			try {
				const res = await this.fetch(`${url}/tt/ping`, { signal: AbortSignal.timeout(8_000) });
				const body = (await res.json().catch(() => undefined)) as { app?: string } | undefined;
				if (res.ok && body?.app === "typetorch-remote") {
					this.restarts = 0;
					this.options.onUrl(url);
					return;
				}
			} catch {}
			if (!warned && Date.now() > deadline) {
				warned = true;
				this.options.log("warn", `tunnel ${url} doesn't answer yet; still trying`);
			}
			await new Promise((done) => setTimeout(done, 1500));
		}
	}
}
