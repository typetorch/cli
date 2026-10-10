/**
 * `typetorch backend run`: the backend on this PC behind a Cloudflare quick tunnel, kept pointed at by the game
 * (plans "typetorch init", backend on This PC). It starts the backend checkout's server with the game's two keys, starts
 * `cloudflared tunnel --url` (no account, no login), reads the new trycloudflare.com address, waits until it answers,
 * and runs `backend setup --url <it>`, which signs the address into the settings record and pings the servers, so they
 * switch within seconds. When the tunnel drops it starts a new one and points the game at the new address; when the
 * backend exits it starts it again. `typetorch init` registers this as a login task, so a reboot needs no step.
 *
 * Where things are: `.typetorch/backend.json` in the game repo (written by init: the checkout folder, the port, a
 * cloudflared path); flags win. The current address and state go to `.typetorch/backend-run.json`, never a key.
 * The keys reach the server through its environment only; nothing here prints them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "./json.ts";

export const BACKEND_CONFIG_FILE = join(".typetorch", "backend.json");
export const BACKEND_STATUS_FILE = join(".typetorch", "backend-run.json");
export const BACKEND_LOG_FILE = ".typetorch/backend.log";
export const DEFAULT_PORT = 8787;

/** `.typetorch/backend.json`: where the local backend lives. Never a secret. */
export interface LocalBackendConfig {
	/** The backend repo checkout. */
	dir: string;
	port: number;
	/** cloudflared, when it is not on PATH. */
	cloudflared?: string;
}

export function readLocalBackendConfig(gameDir: string): LocalBackendConfig | undefined {
	const file = join(gameDir, BACKEND_CONFIG_FILE);
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(raw) || typeof raw.dir !== "string") return undefined;
		return { dir: raw.dir, port: typeof raw.port === "number" ? raw.port : DEFAULT_PORT, ...(typeof raw.cloudflared === "string" ? { cloudflared: raw.cloudflared } : {}) };
	} catch {
		return undefined;
	}
}

export function writeLocalBackendConfig(gameDir: string, config: LocalBackendConfig): void {
	const file = join(gameDir, BACKEND_CONFIG_FILE);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(config, null, "\t") + "\n");
}

export interface RunStatus {
	/** "starting", "pointed" (servers use `url`), "refused" (setup failed; `error` says why), "stopped". */
	state: "starting" | "pointed" | "refused" | "stopped";
	url?: string;
	/** The explorer on this PC. */
	local: string;
	pid: number;
	at: string;
	error?: string;
}

export function readRunStatus(gameDir: string): RunStatus | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(gameDir, BACKEND_STATUS_FILE), "utf8"));
		return isRecord(raw) && typeof raw.state === "string" ? (raw as unknown as RunStatus) : undefined;
	} catch {
		return undefined;
	}
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** The quick tunnel's address in cloudflared's output, if this chunk has it. */
export function tunnelUrlIn(text: string): string | undefined {
	return TUNNEL_URL.exec(text)?.[0];
}

/**
 * The server's environment: the OS basics (`base`), the two keys, and the local-run settings. Nothing else from
 * this process (other keys, the Open Cloud key) reaches it.
 */
export function serverEnv(base: Record<string, string>, o: { key: string; admin: string; port: number; dataDir: string }): Record<string, string> {
	return {
		...base,
		TYPETORCH_API_KEY: o.key,
		TYPETORCH_ADMIN_TOKEN: o.admin,
		TYPETORCH_DATA_DIR: o.dataDir,
		HOST: "127.0.0.1",
		PORT: String(o.port),
		// Roblox sign-in needs a fixed address, which a quick tunnel is not: the explorer takes the admin token.
		TYPETORCH_PUBLIC_URL: `http://localhost:${o.port}`,
		TYPETORCH_TOKEN_LOGIN: "on",
		// cloudflared is one proxy hop in front.
		TYPETORCH_TRUST_PROXY: "1",
	};
}

/** A child process as this module uses it (real ones come from node:child_process). */
export interface Child {
	onOutput(listener: (text: string) => void): void;
	onExit(listener: (code: number | null) => void): void;
	kill(): void;
}

export interface RunDeps {
	spawn: (cmd: string[], cwd: string, env: Record<string, string>) => Child;
	fetch: typeof fetch;
	/** `backend setup --url <url>` for this game; throws with the reason when it refuses. */
	setup: (url: string) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	now: () => Date;
	pid: number;
}

export interface RunOptions {
	gameDir: string;
	backendDir: string;
	port: number;
	cloudflared: string;
	bun: string;
	key: string;
	admin: string;
	/** The OS basics for the server's environment (PATH, HOME, ...). */
	baseEnv: Record<string, string>;
	/** Stops the loop (tests; Ctrl+C in real use). */
	signal?: AbortSignal;
	/** How long to wait for a new tunnel to answer (default 2 minutes). */
	tunnelWaitMs?: number;
}

async function answers(deps: RunDeps, url: string): Promise<boolean> {
	try {
		const response = await deps.fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
		return response.ok;
	} catch {
		return false;
	}
}

function writeStatus(gameDir: string, status: RunStatus) {
	const file = join(gameDir, BACKEND_STATUS_FILE);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(status, null, "\t") + "\n");
}

/**
 * The loop: backend up, tunnel up, game pointed; again whenever either drops. Resolves when `signal` aborts.
 */
export async function runLocalBackend(o: RunOptions, deps: RunDeps): Promise<void> {
	const local = `http://127.0.0.1:${o.port}`;
	const status = (patch: Omit<RunStatus, "local" | "pid" | "at">) => writeStatus(o.gameDir, { ...patch, local: `http://localhost:${o.port}`, pid: deps.pid, at: deps.now().toISOString() });
	const stopped = () => o.signal?.aborted === true;
	let server: Child | undefined;
	/** A backend this loop did not start (already answering on the port): watched through /healthz. */
	let external = false;
	let tunnel: Child | undefined;
	o.signal?.addEventListener("abort", () => {
		tunnel?.kill();
		server?.kill();
	});
	status({ state: "starting" });

	const startServer = async (): Promise<void> => {
		if (await answers(deps, local)) {
			deps.log(`backend already running on ${local} (it keeps the keys it started with)`);
			external = true;
			return;
		}
		const env = serverEnv(o.baseEnv, { key: o.key, admin: o.admin, port: o.port, dataDir: join(o.backendDir, "data") });
		const child = deps.spawn([o.bun, "src/server/main.ts"], o.backendDir, env);
		server = child;
		child.onOutput((text) => {
			for (const line of text.split(/\r?\n/)) if (line.trim()) deps.log(line.startsWith("[backend]") ? line : `[backend] ${line}`);
		});
		child.onExit((code) => {
			if (server === child) server = undefined;
			if (!stopped()) deps.log(`backend exited (${code}); starting it again`);
		});
		for (let i = 0; i < 120 && !(await answers(deps, local)); i++) {
			if (server !== child) throw new Error("the backend exited while starting (see the [backend] lines above)");
			await deps.sleep(250);
		}
		if (!(await answers(deps, local))) throw new Error(`the backend didn't answer on ${local} within 30 s`);
		deps.log(`backend running on ${local}`);
	};

	const startTunnel = async (): Promise<string> => {
		const config = join(mkdtempSync(join(tmpdir(), "tt-tunnel-")), "config.yml");
		// An empty config, so a ~/.cloudflared/config.yml cannot override --url.
		writeFileSync(config, "# empty: quick tunnel only\n");
		const child = deps.spawn([o.cloudflared, "tunnel", "--config", config, "--no-autoupdate", "--url", local], o.backendDir, o.baseEnv);
		tunnel = child;
		const url = await new Promise<string>((done, fail) => {
			let found = false;
			child.onOutput((text) => {
				const match = tunnelUrlIn(text);
				if (match && !found) {
					found = true;
					done(match);
				}
			});
			child.onExit((code) => {
				if (tunnel === child) tunnel = undefined;
				if (!found) fail(new Error(`cloudflared exited (${code}) before it printed a trycloudflare.com address`));
			});
		});
		deps.log(`tunnel ${url}`);
		const deadline = deps.now().getTime() + (o.tunnelWaitMs ?? 120_000);
		while (!(await answers(deps, url))) {
			if (stopped() || tunnel !== child) throw new Error("the tunnel stopped before it answered");
			if (deps.now().getTime() > deadline) throw new Error("the tunnel didn't answer within 2 minutes");
			await deps.sleep(2000);
		}
		return url;
	};

	let failures = 0;
	while (!stopped()) {
		try {
			if (!server && !external) await startServer();
			const url = await startTunnel();
			try {
				await deps.setup(url);
				status({ state: "pointed", url });
				deps.log(`ready: game servers use ${url}; the explorer is http://localhost:${o.port} (sign in with the admin token)`);
			} catch (error) {
				const reason = (error as Error).message;
				status({ state: "refused", url, error: reason.split("\n")[0] });
				deps.log(`the game was NOT pointed at ${url}: ${reason}`);
			}
			failures = 0;
			// Wait until the tunnel or the server drops (or a stop).
			for (let tick = 1; !stopped() && tunnel && (server || external); tick++) {
				await deps.sleep(1000);
				if (external && tick % 10 === 0 && !(await answers(deps, local))) external = false;
			}
			if (stopped()) break;
			tunnel?.kill();
			tunnel = undefined;
			deps.log("the tunnel or the backend stopped; starting again");
		} catch (error) {
			if (stopped()) break;
			failures++;
			const wait = Math.min(60_000, 2000 * 2 ** Math.min(failures, 5));
			deps.log(`${(error as Error).message}; trying again in ${Math.round(wait / 1000)} s`);
			tunnel?.kill();
			tunnel = undefined;
			await deps.sleep(wait);
		}
	}
	tunnel?.kill();
	server?.kill();
	status({ state: "stopped" });
}

/** A real child process, its output as text, for `runLocalBackend`. */
export function spawnChild(cmd: string[], cwd: string, env: Record<string, string>): Child {
	const child: ChildProcess = spawn(cmd[0], cmd.slice(1), { cwd: resolve(cwd), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const outputs: ((text: string) => void)[] = [];
	const exits: ((code: number | null) => void)[] = [];
	let exited: { code: number | null } | undefined;
	const emit = (chunk: Buffer) => outputs.forEach((listener) => listener(chunk.toString("utf8")));
	child.stdout?.on("data", emit);
	child.stderr?.on("data", emit);
	child.on("error", (error) => outputs.forEach((listener) => listener(String(error.message))));
	child.on("close", (code) => {
		exited = { code };
		exits.forEach((listener) => listener(code));
	});
	return {
		onOutput: (listener) => void outputs.push(listener),
		onExit: (listener) => {
			if (exited) listener(exited.code);
			else exits.push(listener);
		},
		kill: () => {
			if (!exited) child.kill();
		},
	};
}
