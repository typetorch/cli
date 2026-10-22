/**
 * `typetorch serve` in the foreground: one process for the whole Studio dev loop.
 *   watch  the game's "watch" script (rbxtsc -w; the template's also writes build-info), else `bun run rbxtsc -w`
 *   rojo   `rojo serve <project> --port <p>` on Rojo's default port or the next free one
 *   extra  each `--with <script>`, and the game's "live" script (on by default, `--no-live` off): `bun run <script>`
 * plus the control API (server.ts) the TypeTorch Studio plugin attaches to by itself. Ctrl+C (or `typetorch serve
 * stop`) stops everything. `.typetorch/serve.json` tells the other commands where the control API is.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { rojoBinary } from "../build.ts";
import { readAssetsLock } from "../assets.ts";
import { loadProject } from "../config.ts";
import { branchChannel } from "../naming.ts";
import { removeServeFile, writeServeFile } from "./client.ts";
import { CompileTracker, stripAnsi } from "./compile.ts";
import { API_VERSION, ROJO_DEFAULT_PORT, type Hello, type ServeStatus } from "./protocol.ts";
import { ClaudeBridge } from "./claude.ts";
import { JobRunner } from "./jobs.ts";
import { Pairing } from "./pairing.ts";
import { RemoteGateway } from "./remote.ts";
import { ensureCloudflared, QuickTunnel } from "./tunnel.ts";
import { ControlServer } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

export interface ServeOptions {
	cwd: string;
	config?: string;
	/** Project file for Rojo (default studio.project.json, else default.project.json). */
	project?: string;
	/** Rojo's port (default: ROJO_DEFAULT_PORT or the next free one). */
	rojoPort?: number;
	/** Control API ports to try (tests). */
	controlPorts?: readonly number[];
	watch: boolean;
	/** package.json scripts to run next to the others (`--with`, `--live`). */
	extra: string[];
	/** Rojo's command (tests). */
	rojoCommand?: string[];
	/** The watch command (tests). */
	watchCommand?: string[];
	/** Every log line (human output or JSON lines). */
	print: (line: { source: string; level: "info" | "warn" | "error"; text: string }) => void;
	logFile?: string;
	/** serve's --env-file, passed on to the jobs (hot asset sync and deploy). */
	envFile?: string;
	/** The branch the plugin's "Sync + deploy" button deploys to (default "dev"; never a prod-channel branch). */
	devBranch?: string;
	/** The jobs' command line (tests). */
	jobCommand?: (args: string[]) => string[];
	/** --remote: the gateway's port for a Studio on another machine (remote.ts); absent: local only. */
	remotePort?: number;
	/**
	 * --remote's public address: "quick" (default) opens a Cloudflare quick tunnel (tunnel.ts) and prints a pairing link
	 * for it, `{url}` is a tunnel the owner runs (--url), "none" leaves it to them (--no-tunnel).
	 */
	remoteTunnel?: "quick" | "none" | { url: string };
	/** Finds or installs cloudflared (tests). */
	cloudflared?: () => Promise<string>;
	/**
	 * --claude: also runs remote-claude (@typetorch/dev-server) without a tunnel, for the plugin's Claude tab (claude.ts):
	 * its command line (the dev-server's entry, without arguments), the environment it gets, and --claude-users.
	 */
	claude?: { command: string[]; environment: Record<string, string>; users?: string };
}

export interface RunningServe {
	port: number;
	rojoPort: number;
	control: ControlServer;
	/** The remote gateway's port (--remote). */
	remotePort?: number;
	stop: () => Promise<void>;
	stopped: Promise<void>;
}

export function scripts(root: string): Record<string, string> {
	try {
		return JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.scripts ?? {};
	} catch {
		return {};
	}
}

function portFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer();
		server.once("error", () => done(false));
		server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
	});
}

export async function freePort(from: number, tries = 20): Promise<number> {
	for (let port = from; port < from + tries; port++) if (await portFree(port)) return port;
	throw new Error(`no free port in ${from}-${from + tries - 1}`);
}

export function defaultProjectFile(root: string): string {
	return existsSync(join(root, "studio.project.json")) ? "studio.project.json" : "default.project.json";
}

/** What the plugin's Hot assets card shows from the lockfile (the place itself is read in Studio). */
export function assetsSummary(root: string, devBranch: string) {
	let lock;
	try {
		lock = readAssetsLock(root);
	} catch (error) {
		return { lockfile: false, error: (error as Error).message, devBranch, assets: {} };
	}
	const assets: Record<string, { className: string; path: string }> = {};
	for (const [key, entry] of Object.entries(lock?.assets ?? {})) assets[key] = { className: entry.className, path: entry.path };
	return { lockfile: Boolean(lock), placeVersion: lock?.placeVersion, devBranch, assets };
}

export async function startServe(options: ServeOptions): Promise<RunningServe> {
	const project = loadProject(options.config, options.cwd);
	const root = project.root;
	const projectFile = options.project ?? defaultProjectFile(root);
	if (!existsSync(join(root, projectFile))) throw new Error(`${projectFile} not found in ${root}`);
	const known = scripts(root);
	for (const name of options.extra) {
		if (typeof known[name] !== "string") throw new Error(`package.json has no "${name}" script (--with ${name})`);
	}
	const rojoPort = options.rojoPort ?? (await freePort(ROJO_DEFAULT_PORT));
	const startedAt = new Date().toISOString();
	const supervisor = new Supervisor((source, stream, raw) => {
		const text = stripAnsi(raw);
		if (source === "watch") compile.line(raw);
		if (!text.trim()) return;
		const level = /\berror\b/i.test(text) ? "error" : stream === "stderr" ? "warn" : "info";
		log(source, level, text);
	});
	const compile = new CompileTracker();
	let stopping: Promise<void> | undefined;
	let markStopped!: () => void;
	const stopped = new Promise<void>((done) => (markStopped = done));

	const hello = (): Hello => ({
		app: "typetorch-serve",
		api: API_VERSION,
		project: project.config.project,
		universeId: project.config.universeId,
		placeId: project.config.placeId,
		rojoPort: supervisor.status().some((c) => c.name === "rojo" && c.state === "running") ? rojoPort : 0,
		projectFile,
		pid: process.pid,
		startedAt,
	});
	const baseArgs = [...(options.config ? ["--config", options.config] : []), ...(options.envFile ? ["--env-file", options.envFile] : [])];
	const jobs = new JobRunner({
		root,
		devBranch: options.devBranch ?? "dev",
		isProd: (branch) => branchChannel(project.config, branch) === "prod",
		baseArgs,
		log: (level, text) => log("assets", level, text),
		command: options.jobCommand,
	});
	let remoteState: NonNullable<ServeStatus["remote"]> | undefined;
	const control = new ControlServer({
		hello,
		status: () => ({ hello: hello(), children: supervisor.status(), compile: compile.snapshot(), ...(remoteState ? { remote: { ...remoteState } } : {}) }),
		stop: () => void stop(),
		restart: (child) => supervisor.restart(child),
		jobs,
		assets: () => assetsSummary(root, options.devBranch ?? "dev"),
		pairing: options.remotePort !== undefined ? new Pairing(root) : undefined,
		claude: new ClaudeBridge({ root }),
	});
	function log(source: string, level: "info" | "warn" | "error", text: string) {
		control.serveLogs.push(source, level, text);
		options.print({ source, level, text });
	}

	const port = await control.listen(options.controlPorts);
	let remote: RemoteGateway | undefined;
	if (options.remotePort !== undefined) {
		remote = new RemoteGateway({
			control,
			pairing: control.pairingStore!,
			rojoPort: () => hello().rojoPort,
			log: (level, text) => log("remote", level, text),
		});
		try {
			await remote.listen(options.remotePort);
		} catch (error) {
			await control.close();
			throw error;
		}
	}
	const watchCommand = options.watchCommand ?? (typeof known.watch === "string" ? ["bun", "run", "watch"] : ["bun", "run", "rbxtsc", "-w"]);
	if (options.watch) supervisor.add({ name: "watch", command: watchCommand, cwd: root });
	supervisor.add({
		name: "rojo",
		command: options.rojoCommand ?? [rojoBinary(), "serve", projectFile, "--port", String(rojoPort)],
		cwd: root,
	});
	for (const name of options.extra) supervisor.add({ name, command: ["bun", "run", name], cwd: root });
	if (options.claude) {
		const users = options.claude.users ? ["--users", options.claude.users] : [];
		supervisor.add({
			name: "claude",
			command: [...options.claude.command, "remote-claude", "--no-tunnel", "--no-announce", "--no-clipboard", ...users],
			cwd: root,
			environment: options.claude.environment,
			// A refusal (no --claude-users and no owner in typetorch.json, a prod branch, no Claude login) would only repeat: `serve restart claude`.
			restart: false,
		});
	}
	writeServeFile(root, { port, pid: process.pid, rojoPort, startedAt, root, logFile: options.logFile });
	log("serve", "info", `control API on 127.0.0.1:${port}, Rojo on ${rojoPort} (${projectFile}); the TypeTorch Studio plugin connects by itself`);
	if (relative(root, options.cwd)) log("serve", "info", `game repo: ${root}`);
	let tunnel: QuickTunnel | undefined;
	if (remote) {
		const gateway = remote;
		const pairing = control.pairingStore!;
		const tunnelMode = options.remoteTunnel ?? "quick";
		remoteState = { port: gateway.port, tunnel: tunnelMode === "quick" ? "quick" : tunnelMode === "none" ? "none" : "own" };
		// One link to share: the public address with a one-time code in it (pairing.ts); `serve pair` makes another.
		const share = (url: string) => {
			const code = pairing.newCode(url);
			remoteState = { ...remoteState!, url: code.url, link: code.link, linkExpiresAt: code.expiresAt };
			log("remote", "info", `pairing link: ${code.link} (works once, until ${new Date(code.expiresAt).toLocaleTimeString()}; \`typetorch serve pair\` makes another). In Studio: TypeTorch panel > Remote server > paste it > Pair`);
		};
		if (tunnelMode === "none") {
			log("serve", "info", `remote gateway on 127.0.0.1:${gateway.port}: point your tunnel at http://localhost:${gateway.port}, then \`typetorch serve pair --url <its address>\` for a pairing link`);
		} else if (tunnelMode !== "quick") {
			log("serve", "info", `remote gateway on 127.0.0.1:${gateway.port}, behind ${tunnelMode.url}`);
			share(tunnelMode.url);
		} else {
			log("serve", "info", `remote gateway on 127.0.0.1:${gateway.port}; opening a Cloudflare quick tunnel to it`);
			void (options.cloudflared ?? (() => ensureCloudflared((level, text) => log("remote", level, text))))()
				.then((exe) => {
					if (stopping) return;
					tunnel = new QuickTunnel({
						exe,
						port: gateway.port,
						log: (level, text) => log("remote", level, text),
						onUrl: (url) => {
							if (remoteState?.url && remoteState.url !== url) log("remote", "warn", "the tunnel restarted with a new address: remote Studios pair again with the new link");
							share(url);
						},
					});
					tunnel.start();
				})
				.catch((error) => log("remote", "error", `no tunnel: ${(error as Error).message}. Run your own and use \`typetorch serve pair --url <its address>\`, or start serve with --url <it>`));
		}
	}

	async function stop() {
		stopping ??= (async () => {
			log("serve", "info", "stopping");
			await supervisor.stopAll();
			tunnel?.stop();
			await remote?.close();
			await control.close();
			removeServeFile(root, process.pid);
			markStopped();
		})();
		return stopping;
	}
	return { port, rojoPort, control, remotePort: remote?.port, stop, stopped };
}
