/**
 * `typetorch serve` and `typetorch studio`: the Studio dev loop in one command (serve/run.ts), and the commands that
 * talk to it (serve/client.ts). Every subcommand answers with --json for agents.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { rojoBinary } from "../build.ts";
import { findProjectRoot, loadProject } from "../config.ts";
import { bold, cyan, dim, emitJson, info, isJson, red, yellow } from "../log.ts";
import { run } from "../proc.ts";
import { sleep } from "../runtime.ts";
import { findRunning } from "../serve/client.ts";
import { serveDevices, serveLogs, servePairCode, serveRestart, serveStatus, serveStop, serveUnpair, startDetached, studioSend } from "../serve/ops.ts";
import { REMOTE_DEFAULT_PORT } from "../serve/remote.ts";
import { RECONNECT_LUAU, type CommandKind, type CommandResult, type LogLine, type ServeStatus } from "../serve/protocol.ts";
import { startServe } from "../serve/run.ts";
import { cliRoot, DEV_SERVER_PACKAGE, devServerEnv, findDevServer } from "./remote-claude.ts";

export const serveFlags = {
	detach: "boolean",
	project: "string",
	port: "string",
	"no-watch": "boolean",
	live: "boolean",
	with: "string",
	since: "string",
	studio: "boolean",
	follow: "boolean",
	limit: "string",
	"dev-branch": "string",
	remote: "boolean",
	"remote-port": "string",
	name: "string",
	all: "boolean",
	claude: "boolean",
	"claude-users": "string",
	url: "string",
	"no-tunnel": "boolean",
} as const;

export const SERVE_USAGE = `typetorch serve [--detach] [--project <file>] [--port <n>] [--no-watch] [--live] [--with <script,...>] [--dev-branch <b>] [--remote [--remote-port <n>] [--url <your tunnel> | --no-tunnel]] [--claude [--claude-users <ids>]] [--json]
typetorch serve pair [--url <tunnel URL>] [--json]
typetorch serve devices [--json]
typetorch serve unpair (--name <device> | --all) [--json]
typetorch serve status [--json]
typetorch serve stop
typetorch serve restart <watch|rojo|<script>>
typetorch serve logs [--studio] [--since <seq>] [--limit <n>] [--follow] [--json]

  One process for the Studio dev loop, instead of \`bun run watch\` + \`bun run studio\` + more terminals:
    watch  the game's "watch" script (else rbxtsc -w); compile errors are kept for \`serve status\`
    rojo   rojo serve <project> on Rojo's default port 34872 (or the next free one), so the stock plugin still works
    --live / --with <a,b>  also runs those package.json scripts (\`bun run <script>\`)
  and a control API on 127.0.0.1:34880-34887. The TypeTorch Studio plugin (\`typetorch studio install-plugin\`) finds
  it by itself, attaches to the server whose universeId matches the open place and reconnects on its own: nobody
  clicks Connect. Children that exit are restarted. Ctrl+C or \`typetorch serve stop\` stops everything.
  --detach     start in the background (log: .typetorch/serve.log) and return once it answers; for agents
  --project    project file for Rojo (default studio.project.json, else default.project.json)
  --port       Rojo's port
  --no-watch   don't run rbxtsc -w (your editor or agent compiles)
  --dev-branch the branch the plugin's "Publish to dev" button deploys hot assets to (default dev; never prod-channel)
  --remote     also let a Studio on another machine in: serve opens a Cloudflare quick tunnel (cloudflared, installed
               if missing; no account) to a gateway on 127.0.0.1:${REMOTE_DEFAULT_PORT} (--remote-port) and prints a pairing link
               to send them. The address changes each time serve starts, so send the new link then. --url <address>: a
               tunnel you run yourself instead (service http://localhost:${REMOTE_DEFAULT_PORT}); --no-tunnel: just the gateway.
               Every request needs a device token from pairing; a remote Studio syncs code read-only, reports its state
               and runs hot asset jobs (dev only), but can't stop serve, drive other Studios or read serve's log
  --claude     also runs remote-claude (typetorch remote-claude, from @typetorch/dev-server) on this machine for the
               plugin's Claude tab: Studio users prompt Claude Code here in Code mode (edits on this branch, which must be
               dev-channel, then Deploy or Discard). --claude-users <ids>: the Roblox user ids allowed (remembered;
               default: the owners in typetorch.json; a remote helper's id goes there too). A remote-claude you run yourself in
               this repo works as well
  pair         another one-time pairing link (15 min): the tunnel's address with the code in it (serve's own tunnel, or
               --url once; remembered). The other person pastes it into the plugin's Remote card; their Studio stays
               paired for 30 days
  devices      the paired devices; unpair --name <device> (or --all) revokes them
  --json       foreground: one JSON line per log line; subcommands: one JSON document
  status       children, attached Studios (edit / playtest), sync state, last compile result and its errors
  logs         serve's log (children); --studio: Studio's Output as the plugin forwards it; --follow keeps printing
  .typetorch/serve.json (git-ignored) holds the control port while it runs.`;

export const studioFlags = {
	anyway: "boolean",
	run: "boolean",
	target: "string",
	timeout: "string",
	since: "string",
	follow: "boolean",
	limit: "string",
	from: "string",
} as const;

export const STUDIO_USAGE = `typetorch studio status [--json]
typetorch studio reconnect [--anyway] [--target <id|edit>] [--json]
typetorch studio play [--run] [--json]
typetorch studio stop [--json]
typetorch studio logs [--since <seq>] [--limit <n>] [--follow] [--json]
typetorch studio install-plugin [--from <dir>] [--json]

  Drives the Studio that the TypeTorch plugin attached to \`typetorch serve\` (which must be running). The plugin keeps
  listening for these even while its sync is down, waiting for a click or paused, so an agent can always get it back.
  status          attached Studios (edit, playtest server and client) and their sync state
  reconnect       turns the plugin's auto-connect on and resyncs from scratch; waits for the result
    --anyway      also sync into a place of another experience or an unpublished one (the panel's "Connect anyway")
  play            starts a playtest (Play); --run: Run mode (no player)
  stop            ends the playtest
  logs            Studio's Output (edit and playtest), as the plugin forwards it; --follow keeps printing
  --target        a plugin id from \`studio status\`, or edit / server / client (default: the edit DataModel; stop: the
                  playtest server)
  --timeout <s>   how long to wait for Studio's answer (default 20)
  install-plugin  builds the TypeTorch Studio plugin (github.com/typetorch/studio-plugin) with Rojo into Studio's
                  plugins folder as TypeTorchSync.rbxm, from the game's devDependency @typetorch/studio-plugin
                  (\`bun add -d @typetorch/studio-plugin\`) or --from a checkout. Restart Studio, or reload plugins, to
                  load it. Keep the stock Rojo plugin if you like, but connect only one of them at a time.

  When no Studio is attached and Studio is open, the plugin may be stuck: run this in Studio's command bar, or through
  the Roblox Studio MCP's execute_luau, to make it reconnect:
    ${RECONNECT_LUAU}`;

function gameRoot(args: ParsedArgs): string {
	const config = flagString(args, "config");
	if (config) return loadProject(config).root;
	const root = findProjectRoot();
	if (!root) throw new UsageError("run inside a TypeTorch game repo (no typetorch.json here or above)");
	return root;
}

function extraScripts(args: ParsedArgs): string[] {
	const names = (flagString(args, "with") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (flagBool(args, "live") && !names.includes("live")) names.push("live");
	return names;
}

function printLine(line: { source: string; level: string; text: string; at?: string }) {
	const color = line.level === "error" ? red : line.level === "warn" ? yellow : (s: string) => s;
	console.log(`${dim(`[${line.source}]`)} ${color(line.text)}`);
}

export async function serveCommand(args: ParsedArgs) {
	const [sub, ...rest] = args.positionals;
	switch (sub) {
		case undefined:
			return flagBool(args, "detach") ? detach(args) : foreground(args);
		case "status":
			return status(args);
		case "stop": {
			const result = await serveStop(gameRoot(args));
			if (isJson()) emitJson({ ok: true, running: false });
			else info(result.wasRunning ? "stopped" : "typetorch serve isn't running");
			return;
		}
		case "restart": {
			const child = rest[0];
			if (!child) throw new UsageError("restart needs a child name: watch, rojo or a --with script");
			await serveRestart(gameRoot(args), child);
			if (isJson()) emitJson({ ok: true });
			else info(`restarted ${child}`);
			return;
		}
		case "logs":
			return logs(args, flagBool(args, "studio") ? "studio" : "serve");
		case "pair": {
			const r = await servePairCode(gameRoot(args), flagString(args, "url"));
			if (isJson()) return emitJson(r);
			const until = new Date(r.expiresAt).toLocaleTimeString();
			if (r.link) {
				info(`pairing link: ${bold(r.link)} (works once, until ${until})`);
				info(dim("Send it to them; in Studio: TypeTorch panel > Remote server > paste it > Pair"));
			} else {
				info(`pairing code: ${bold(r.code)} (once, until ${until})`);
				info(dim("Add your tunnel's address once for a link to share: typetorch serve pair --url https://<your tunnel>"));
			}
			return;
		}
		case "devices": {
			const r = await serveDevices(gameRoot(args));
			if (isJson()) return emitJson(r);
			if (r.devices.length === 0) return info("no paired devices");
			for (const d of r.devices) info(`${d.name}  paired ${d.createdAt.slice(0, 10)}, expires ${d.expiresAt.slice(0, 10)}${d.lastSeen ? `, last seen ${d.lastSeen}` : ""}`);
			return;
		}
		case "unpair": {
			const name = flagString(args, "name");
			if (name === undefined && !flagBool(args, "all")) throw new UsageError("unpair needs --name <device> or --all");
			const r = await serveUnpair(gameRoot(args), name);
			if (isJson()) return emitJson(r);
			info(`revoked ${r.revoked} device${r.revoked === 1 ? "" : "s"}`);
			return;
		}
		default:
			throw new UsageError(`unknown serve subcommand "${sub}"`);
	}
}

async function foreground(args: ParsedArgs) {
	const root = gameRoot(args);
	const already = await findRunning(root);
	if (already) throw new UsageError(`typetorch serve is already running here (pid ${already.file.pid}, port ${already.file.port}); \`typetorch serve stop\` first`);
	const json = isJson();
	const portFlag = flagString(args, "port");
	const serve = await startServe({
		cwd: root,
		config: flagString(args, "config"),
		project: flagString(args, "project"),
		rojoPort: portFlag ? Number(portFlag) : undefined,
		watch: !flagBool(args, "no-watch"),
		extra: extraScripts(args),
		logFile: process.env.TYPETORCH_SERVE_LOG,
		envFile: flagString(args, "env-file"),
		devBranch: flagString(args, "dev-branch"),
		remotePort: flagBool(args, "remote") || flagString(args, "remote-port") ? flagInt(args, "remote-port", REMOTE_DEFAULT_PORT) : undefined,
		remoteTunnel: remoteTunnel(args),
		claude: flagBool(args, "claude") || flagString(args, "claude-users") ? claudeChild(root, flagString(args, "claude-users")) : undefined,
		print: (line) => (json ? console.log(JSON.stringify({ at: new Date().toISOString(), ...line })) : printLine(line)),
	});
	if (!json) {
		const remote = serve.remotePort ? `, remote gateway ${serve.remotePort}` : "";
		info(`${bold("typetorch serve")} running: ${cyan(`control 127.0.0.1:${serve.port}`)}, Rojo ${serve.rojoPort}${remote}. Ctrl+C stops.`);
	}
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	const onSignal = () => void serve.stop();
	for (const signal of signals) process.on(signal, onSignal);
	await serve.stopped;
	for (const signal of signals) process.off(signal, onSignal);
}

/** --claude: how serve runs the dev-server (found as `typetorch remote-claude` finds it). */
function claudeChild(root: string, users: string | undefined) {
	const found = findDevServer({ cwd: root, cliRoot: cliRoot() });
	if ("searched" in found) throw new UsageError(`--claude needs ${DEV_SERVER_PACKAGE}: \`bun add -d ${DEV_SERVER_PACKAGE}\` in the game repo (or npm i -g ${DEV_SERVER_PACKAGE})`);
	if (users !== undefined && !/^\d+(,\d+)*$/.test(users.replace(/\s/g, ""))) throw new UsageError("--claude-users: comma-separated Roblox user ids");
	return { command: found.cmd, environment: devServerEnv(), users: users?.replace(/\s/g, "") };
}

/** Starts `typetorch serve` in the background with the same flags (minus --detach) and waits until it answers. */
/** --remote's public address: serve's quick tunnel (default), the owner's own (--url), or none (--no-tunnel). */
function remoteTunnel(args: ParsedArgs): "quick" | "none" | { url: string } {
	if (flagBool(args, "no-tunnel")) return "none";
	const url = flagString(args, "url");
	return url ? { url } : "quick";
}

async function detach(args: ParsedArgs) {
	const argv = process.argv.slice(2).filter((arg) => arg !== "--detach" && arg !== "--json");
	const root = gameRoot(args);
	const r = await startDetached(root, argv, process.cwd());
	// --remote: wait for the tunnel and its pairing link, the one thing to send the other person
	const remote = !r.alreadyRunning && (flagBool(args, "remote") || flagString(args, "remote-port")) && remoteTunnel(args) !== "none";
	let link: string | undefined;
	for (let i = 0; remote && i < 75 && !link; i++) {
		await sleep(2000);
		const s = await serveStatus(root).catch(() => undefined);
		if (!s?.running) break;
		link = s.remote?.link;
	}
	if (isJson()) return emitJson({ ...r, ...(link ? { link } : {}) });
	if (r.alreadyRunning) info(`already running (pid ${r.pid}, control port ${r.port})`);
	else info(`typetorch serve started in the background (pid ${r.pid}, control port ${r.port}, Rojo ${r.rojoPort}); log: ${r.log}`);
	if (link) info(`pairing link: ${bold(link)} (works once, 15 min; \`typetorch serve pair\` makes another)`);
	else if (remote) info(dim("the tunnel isn't up yet: `typetorch serve status` shows the pairing link once it is (or see the log)"));
}

export function describeStatus(s: ServeStatus): string[] {
	const lines = [`${bold(s.hello.project)}  pid ${s.hello.pid}  Rojo ${s.hello.rojoPort || "down"} (${s.hello.projectFile})`];
	for (const child of s.children) {
		lines.push(`  ${child.name.padEnd(8)} ${child.state}${child.restarts ? `, ${child.restarts} restarts` : ""}`);
	}
	const c = s.compile;
	lines.push(`  compile  ${c.state}${c.errors.length ? `: ${c.errors.length} error${c.errors.length === 1 ? "" : "s"}` : ""}`);
	for (const e of c.errors.slice(0, 10)) lines.push(`    ${e.file}:${e.line}:${e.column} ${e.code ?? ""} ${e.message}`);
	if (s.remote) {
		const where = s.remote.url ?? (s.remote.tunnel === "quick" ? "tunnel starting" : "no tunnel (point yours at it)");
		lines.push(`  remote   127.0.0.1:${s.remote.port} -> ${where}${s.remote.link ? `\n           pairing link: ${s.remote.link} (once, until ${new Date(s.remote.linkExpiresAt!).toLocaleTimeString()})` : ""}`);
	}
	if (s.studios.length === 0) lines.push(`  studio   none attached (open the place in Studio with the TypeTorch plugin)`);
	for (const st of s.studios) {
		const from = st.remote ? ` [remote: ${st.remote}]` : "";
		lines.push(`  studio   ${st.mode} "${st.placeName}" (place ${st.placeId})${from}: ${st.sync.status}${st.sync.detail ? `, ${st.sync.detail}` : ""}`);
	}
	return lines;
}

async function status(args: ParsedArgs) {
	const s = await serveStatus(gameRoot(args));
	if (isJson()) emitJson(s);
	else if (!s.running) info("typetorch serve isn't running here (`typetorch serve`, or `typetorch serve --detach` for agents)");
	else for (const line of describeStatus(s)) info(line);
}

/** `serve logs` and `studio logs`. */
async function logs(args: ParsedArgs, source: "serve" | "studio") {
	const root = gameRoot(args);
	const limit = flagInt(args, "limit", 200);
	const follow = flagBool(args, "follow");
	const first = await serveLogs(root, source, Number(flagString(args, "since") ?? 0) || 0, limit);
	if (isJson() && !follow) {
		emitJson(first);
		return;
	}
	const show = (lines: LogLine[]) => {
		for (const line of lines) isJson() ? console.log(JSON.stringify(line)) : printLine(line);
	};
	show(first.lines);
	let since = first.last;
	while (follow) {
		await sleep(1000);
		const next = await serveLogs(root, source, since, limit);
		show(next.lines);
		since = next.last;
	}
}

export async function studioCommand(args: ParsedArgs) {
	const [sub] = args.positionals;
	switch (sub) {
		case "install-plugin":
			return installPlugin(args);
		case "status": {
			const s = await serveStatus(gameRoot(args));
			if (!s.running) throw new UsageError("typetorch serve isn't running here: start it with `typetorch serve` (agents: `typetorch serve --detach`)");
			if (isJson()) emitJson({ studios: s.studios });
			else if (s.studios.length === 0) info(`no Studio attached. Studio open? Install the plugin (\`typetorch studio install-plugin\`), or if it's stuck run in Studio: ${RECONNECT_LUAU}`);
			else for (const st of s.studios) info(`${st.mode.padEnd(6)} "${st.placeName}" (place ${st.placeId})  ${st.sync.status}${st.sync.detail ? `: ${st.sync.detail}` : ""}  ${dim(st.id)}`);
			return;
		}
		case "reconnect":
			return studioRun(args, "reconnect", { anyway: flagBool(args, "anyway") }, (r) => {
				const phase = String(r.result?.phase ?? "");
				return phase === "connected" ? `connected: ${r.result?.detail ?? ""}` : `not connected yet (${phase}${r.result?.detail ? `: ${r.result.detail}` : ""})`;
			}, (r) => r.result?.phase === "connected");
		case "play":
			return studioRun(args, "play", { mode: flagBool(args, "run") ? "run" : "play" }, () => `playtest started (${flagBool(args, "run") ? "run" : "play"})`);
		case "stop":
			return studioRun(args, "stop", {}, () => "playtest stopped");
		case "logs":
			return logs(args, "studio");
		default:
			throw new UsageError(sub ? `unknown studio subcommand "${sub}"` : "studio needs a subcommand");
	}
}

/** Sends one command to Studio; prints the answer, exit code 1 when it failed (or `success` says it didn't work). */
async function studioRun(
	args: ParsedArgs,
	kind: CommandKind,
	commandArgs: Record<string, unknown>,
	describe: (r: CommandResult) => string,
	success: (r: CommandResult) => boolean = () => true,
) {
	const timeout = flagInt(args, "timeout", 20);
	const r = await studioSend(gameRoot(args), kind, commandArgs, flagString(args, "target"), timeout * 1000);
	const worked = r.ok && success(r);
	if (!worked) process.exitCode = 1;
	if (isJson()) emitJson(r);
	else if (!r.ok) console.error(red(`${kind} failed in Studio (${r.studio.mode}): ${r.error ?? "unknown error"}`));
	else info(describe(r));
}

export const PLUGIN_FILE = "TypeTorchSync.rbxm";

export const PLUGIN_PACKAGE = "@typetorch/studio-plugin";

/** The plugin's Rojo project: --from <dir>, else the package in the game repo's node_modules, else in this CLI's. */
export function pluginProject(from: string | undefined, root: string | undefined): string {
	const candidates = from ? [resolve(from)] : [...(root ? [join(root, "node_modules", PLUGIN_PACKAGE)] : []), join(cliRoot(), "node_modules", PLUGIN_PACKAGE)];
	for (const dir of candidates) {
		const project = join(dir, "default.project.json");
		if (existsSync(project)) return project;
	}
	if (from) throw new UsageError(`${from} has no default.project.json (a checkout of github.com/typetorch/studio-plugin?)`);
	throw new UsageError(`${PLUGIN_PACKAGE} isn't installed: \`bun add -d ${PLUGIN_PACKAGE}\` in the game repo (or --from <checkout>)`);
}

async function installPlugin(args: ParsedArgs) {
	const project = pluginProject(flagString(args, "from"), findProjectRoot());
	await run([rojoBinary(), "build", project, "--plugin", PLUGIN_FILE], process.cwd());
	if (isJson()) emitJson({ ok: true, plugin: PLUGIN_FILE, from: dirname(project) });
	else info(`installed ${PLUGIN_FILE} in Studio's plugins folder; restart Studio (or reload plugins) to load it`);
}
