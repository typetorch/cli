/**
 * `typetorch serve` and `typetorch studio`: the Studio dev loop in one command (serve/run.ts), and the commands that
 * talk to it (serve/client.ts). Every subcommand answers with --json for agents.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { rojoBinary } from "../build.ts";
import { findProjectRoot, loadProject } from "../config.ts";
import { bold, cyan, dim, emitJson, info, isJson, red, yellow } from "../log.ts";
import { run } from "../proc.ts";
import { sleep } from "../runtime.ts";
import { call, findRunning, ServeClientError } from "../serve/client.ts";
import type { LogLine, ServeStatus } from "../serve/protocol.ts";
import { startServe } from "../serve/run.ts";
import { cliRoot } from "./remote-claude.ts";

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
} as const;

export const SERVE_USAGE = `typetorch serve [--detach] [--project <file>] [--port <n>] [--no-watch] [--live] [--with <script,...>] [--json]
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
  --json       foreground: one JSON line per log line; subcommands: one JSON document
  status       children, attached Studios (edit / playtest), sync state, last compile result and its errors
  logs         serve's log (children); --studio: Studio's Output as the plugin forwards it; --follow keeps printing
  .typetorch/serve.json (git-ignored) holds the control port while it runs.`;

export const studioFlags = {
	from: "string",
} as const;

export const STUDIO_USAGE = `typetorch studio install-plugin [--from <dir>] [--json]

  install-plugin  builds the TypeTorch Studio plugin (github.com/typetorch/studio-plugin) with Rojo into Studio's
                  plugins folder as TypeTorchSync.rbxm, from the game's devDependency @typetorch/studio-plugin
                  (\`bun add -d @typetorch/studio-plugin\`) or --from a checkout. Restart Studio, or reload plugins, to
                  load it. Keep the stock Rojo plugin if you like, but connect only one of them at a time.`;

function gameRoot(args: ParsedArgs): string {
	const config = flagString(args, "config");
	if (config) return loadProject(config).root;
	const root = findProjectRoot();
	if (!root) throw new UsageError("run inside a TypeTorch game repo (no typetorch.json here or above)");
	return root;
}

async function requireRunning(root: string) {
	const running = await findRunning(root);
	if (!running) throw new ServeClientError("typetorch serve isn't running in this repo: start it with `typetorch serve` (agents: `typetorch serve --detach`)");
	return running;
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
			const root = gameRoot(args);
			const running = await findRunning(root);
			if (!running) {
				if (isJson()) emitJson({ ok: true, running: false });
				else info("typetorch serve isn't running");
				return;
			}
			await call(running.file.port, "POST", "/tt/stop");
			for (let i = 0; i < 50 && (await findRunning(root)); i++) await sleep(200);
			if (isJson()) emitJson({ ok: true, running: false });
			else info("stopped");
			return;
		}
		case "restart": {
			const child = rest[0];
			if (!child) throw new UsageError("restart needs a child name: watch, rojo or a --with script");
			const running = await requireRunning(gameRoot(args));
			await call(running.file.port, "POST", "/tt/restart", { child });
			if (isJson()) emitJson({ ok: true });
			else info(`restarted ${child}`);
			return;
		}
		case "logs":
			return logs(args);
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
		print: (line) => (json ? console.log(JSON.stringify({ at: new Date().toISOString(), ...line })) : printLine(line)),
	});
	if (!json) info(`${bold("typetorch serve")} running: ${cyan(`control 127.0.0.1:${serve.port}`)}, Rojo ${serve.rojoPort}. Ctrl+C stops.`);
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	const onSignal = () => void serve.stop();
	for (const signal of signals) process.on(signal, onSignal);
	await serve.stopped;
	for (const signal of signals) process.off(signal, onSignal);
}

/** Starts `typetorch serve` in the background with the same flags (minus --detach) and waits until it answers. */
async function detach(args: ParsedArgs) {
	const root = gameRoot(args);
	const already = await findRunning(root);
	if (already) {
		if (isJson()) emitJson({ ok: true, alreadyRunning: true, port: already.file.port, rojoPort: already.file.rojoPort, pid: already.file.pid });
		else info(`already running (pid ${already.file.pid}, control port ${already.file.port})`);
		return;
	}
	const logFile = join(root, ".typetorch", "serve.log");
	mkdirSync(dirname(logFile), { recursive: true });
	const out = openSync(logFile, "a");
	const argv = process.argv.slice(1).filter((arg) => arg !== "--detach" && arg !== "--json");
	const child = spawn(process.execPath, argv, {
		cwd: process.cwd(),
		detached: true,
		stdio: ["ignore", out, out],
		windowsHide: true,
		env: { ...process.env, TYPETORCH_SERVE_LOG: logFile, NO_COLOR: "1", TYPETORCH_UPDATE_CHECK: "off" },
	});
	child.unref();
	closeSync(out);
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		const running = await findRunning(root);
		if (running) {
			if (isJson()) emitJson({ ok: true, port: running.file.port, rojoPort: running.file.rojoPort, pid: running.file.pid, log: logFile });
			else info(`typetorch serve started in the background (pid ${running.file.pid}, control port ${running.file.port}, Rojo ${running.file.rojoPort}); log: ${logFile}`);
			return;
		}
		if (child.exitCode !== null) break;
	}
	throw new Error(`typetorch serve did not start; see ${logFile}`);
}

export function describeStatus(s: ServeStatus): string[] {
	const lines = [`${bold(s.hello.project)}  pid ${s.hello.pid}  Rojo ${s.hello.rojoPort || "down"} (${s.hello.projectFile})`];
	for (const child of s.children) {
		lines.push(`  ${child.name.padEnd(8)} ${child.state}${child.restarts ? `, ${child.restarts} restarts` : ""}`);
	}
	const c = s.compile;
	lines.push(`  compile  ${c.state}${c.errors.length ? `: ${c.errors.length} error${c.errors.length === 1 ? "" : "s"}` : ""}`);
	for (const e of c.errors.slice(0, 10)) lines.push(`    ${e.file}:${e.line}:${e.column} ${e.code ?? ""} ${e.message}`);
	if (s.studios.length === 0) lines.push(`  studio   none attached (open the place in Studio with the TypeTorch plugin)`);
	for (const st of s.studios) {
		lines.push(`  studio   ${st.mode} "${st.placeName}" (place ${st.placeId}): ${st.sync.status}${st.sync.detail ? `, ${st.sync.detail}` : ""}`);
	}
	return lines;
}

async function status(args: ParsedArgs) {
	const root = gameRoot(args);
	const running = await findRunning(root);
	if (!running) {
		if (isJson()) emitJson({ running: false });
		else info("typetorch serve isn't running here (`typetorch serve`, or `typetorch serve --detach` for agents)");
		return;
	}
	const s = await call<ServeStatus>(running.file.port, "GET", "/tt/status");
	if (isJson()) emitJson({ running: true, port: running.file.port, ...s });
	else for (const line of describeStatus(s)) info(line);
}

async function logs(args: ParsedArgs) {
	const running = await requireRunning(gameRoot(args));
	const source = flagBool(args, "studio") ? "studio" : "serve";
	let since = Number(flagString(args, "since") ?? 0) || 0;
	const limit = flagInt(args, "limit", 200);
	const fetchLines = () => call<{ last: number; lines: LogLine[] }>(running.file.port, "GET", `/tt/logs?source=${source}&since=${since}&limit=${limit}`);
	const first = await fetchLines();
	if (isJson() && !flagBool(args, "follow")) {
		emitJson(first);
		return;
	}
	const show = (lines: LogLine[]) => {
		for (const line of lines) isJson() ? console.log(JSON.stringify(line)) : printLine(line);
	};
	show(first.lines);
	since = first.last;
	while (flagBool(args, "follow")) {
		await sleep(1000);
		const next = await fetchLines();
		show(next.lines);
		since = next.last;
	}
}

export async function studioCommand(args: ParsedArgs) {
	const [sub] = args.positionals;
	switch (sub) {
		case "install-plugin":
			return installPlugin(args);
		default:
			throw new UsageError(sub ? `unknown studio subcommand "${sub}"` : "studio needs a subcommand");
	}
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
