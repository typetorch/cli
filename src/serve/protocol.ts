/**
 * `typetorch serve`: the local dev server that replaces `bun run studio`, `bun run watch` and friends, and
 * the HTTP contract the TypeTorch Studio plugin (github.com/typetorch/studio-plugin) and the CLI's own subcommands speak with it.
 *
 * - The control API listens on 127.0.0.1, on the first free port of CONTROL_PORTS. The plugin probes the whole range
 *   every few seconds (`GET /tt/hello`) and attaches to the server whose universeId matches its place, so nobody
 *   clicks Connect. Rojo keeps its own port (ROJO_DEFAULT_PORT, Rojo's default, so the stock plugin still works);
 *   /tt/hello tells the plugin where it is.
 * - Every request needs the header `X-TypeTorch: 1` and must not carry an `Origin` header; the server never answers
 *   CORS preflights. A web page in a browser therefore can't call it (a custom header forces a preflight).
 * - Bodies are JSON. Errors are `{ "error": "<text>" }` with a 4xx/5xx status.
 */

export const API_VERSION = 1;

/** The control API's port range (Rojo's default 34872 is left to Rojo). */
export const CONTROL_PORTS = [34880, 34881, 34882, 34883, 34884, 34885, 34886, 34887] as const;

/** Rojo's own default port; `serve` uses it (or the next free one) so the stock Rojo plugin connects too. */
export const ROJO_DEFAULT_PORT = 34872;

export const HEADER = "x-typetorch";

/** What `GET /tt/hello` answers: enough for the plugin to pick the right server and reach Rojo. */
export interface Hello {
	app: "typetorch-serve";
	api: number;
	/** typetorch.json "project". */
	project: string;
	universeId: number;
	placeId: number;
	/** Rojo's port on 127.0.0.1, or 0 while Rojo isn't up. */
	rojoPort: number;
	/** The project file Rojo serves (relative to the game repo). */
	projectFile: string;
	pid: number;
	startedAt: string;
}

/** One running Studio plugin (a DataModel: edit, or a playtest's server or client). */
export interface StudioInfo {
	id: string;
	mode: "edit" | "server" | "client";
	placeId: number;
	gameId: number;
	placeName: string;
	pluginVersion: string;
	/** Rojo sync state as the plugin reports it. */
	sync: { status: "idle" | "connecting" | "connected" | "disconnected" | "paused"; detail?: string; at?: string };
	firstSeen: string;
	lastSeen: string;
	/** The paired device's name when this Studio came through `serve --remote`. */
	remote?: string;
}

export interface LogLine {
	seq: number;
	at: string;
	source: string;
	level: "info" | "warn" | "error";
	text: string;
}

/** A compile problem parsed from `rbxtsc -w`. */
export interface CompileError {
	file: string;
	line: number;
	column: number;
	code?: string;
	message: string;
}

export interface ChildStatus {
	name: string;
	command: string[];
	state: "starting" | "running" | "exited" | "restarting" | "stopped";
	pid?: number;
	restarts: number;
	exitCode?: number | null;
}

export interface ServeStatus {
	hello: Hello;
	children: ChildStatus[];
	compile: { state: "idle" | "compiling" | "ok" | "errors"; errors: CompileError[]; at?: string };
	studios: StudioInfo[];
	/**
	 * --remote: the gateway, its public address (serve's quick tunnel or `--url`) once it answers, and the pairing link
	 * serve printed for it (`<url>#<code>`, one use, until linkExpiresAt). Local callers only see the link.
	 */
	remote?: { port: number; tunnel: "quick" | "own" | "none"; url?: string; link?: string; linkExpiresAt?: string };
	/**
	 * `$path` folders deleted and recreated under Rojo (pathwatch.ts): those still missing, and the last time serve
	 * restarted Rojo for it. Absent while nothing happened.
	 */
	rojoPaths?: { missing: string[]; lastRestart?: { at: string; paths: string[] } };
}

/**
 * Commands for a Studio plugin. The CLI (or `typetorch mcp`) posts one to `POST /tt/command` and waits for the answer;
 * the plugin long-polls `GET /tt/plugin/poll` and answers with `POST /tt/plugin/result`. The plugin keeps polling
 * whatever its Rojo sync is doing (waiting for a click, paused, disconnected), so an agent can always reach it.
 *   ping       which DataModel answered and its sync state
 *   reconnect  turn auto-connect on and resync from scratch; `anyway: true` also accepts a server for another
 *              experience or an unpublished place (the panel's "Connect anyway")
 *   play       start a playtest (`mode: "play"`, default, or "run")
 *   stop       end the playtest
 */
export const COMMAND_KINDS = ["ping", "reconnect", "play", "stop"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface StudioCommand {
	id: string;
	kind: CommandKind;
	args: Record<string, unknown>;
}

/** What `POST /tt/command` answers once the plugin has run the command. */
export interface CommandResult {
	ok: boolean;
	/** The plugin that ran it. */
	studio: { id: string; mode: StudioInfo["mode"]; placeName: string };
	result?: Record<string, unknown>;
	error?: string;
}

/** The Luau line that asks a stuck plugin to reconnect (Studio command bar or the Roblox Studio MCP's execute_luau). */
export const RECONNECT_LUAU = `game:GetService("ServerStorage"):SetAttribute("TypeTorchReconnect", os.time())`;
