/**
 * The control API of `typetorch serve` (protocol.ts has the contract and the security rules). Plugins register and
 * report their sync state and Studio's Output here; the CLI's subcommands read status and logs and stop the server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
	COMMAND_KINDS,
	CONTROL_PORTS,
	HEADER,
	RECONNECT_LUAU,
	type CommandKind,
	type CommandResult,
	type Hello,
	type LogLine,
	type ServeStatus,
	type StudioCommand,
	type StudioInfo,
} from "./protocol.ts";
import { JOB_KINDS, type JobKind, type JobRunner } from "./jobs.ts";
import { ClaudeError, type ClaudeBridge } from "./claude.ts";
import type { Pairing } from "./pairing.ts";

/** Lines kept per source group (serve's own children, Studio). */
const RING_SIZE = 2000;
const MAX_BODY = 256 * 1024;
/** A plugin that hasn't been heard from for this long is dropped from the list. */
export const STUDIO_TIMEOUT_MS = 30_000;
/** How long `GET /tt/plugin/poll` holds an empty answer (well under Roblox's HTTP timeout and STUDIO_TIMEOUT_MS). */
export const POLL_HOLD_MS = 15_000;
/** `POST /tt/command`'s default and largest wait for the plugin's answer. */
export const COMMAND_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MAX_MS = 120_000;

/** Why a command found no plugin to run it, and the ways out (an agent reads this). */
export function noStudioMessage(mode: string): string {
	return [
		`no ${mode} Studio is attached to typetorch serve.`,
		"Open the place in Studio with the TypeTorch plugin (`typetorch studio install-plugin`) and allow its HTTP requests to localhost.",
		`If Studio is open and the plugin is stuck, run this in Studio's command bar or with the Roblox Studio MCP's execute_luau: ${RECONNECT_LUAU}`,
	].join(" ");
}

export class LogRing {
	private lines: LogLine[] = [];
	private seq = 0;

	push(source: string, level: LogLine["level"], text: string): LogLine {
		const line = { seq: ++this.seq, at: new Date().toISOString(), source, level, text };
		this.lines.push(line);
		if (this.lines.length > RING_SIZE) this.lines.splice(0, this.lines.length - RING_SIZE);
		return line;
	}

	since(seq: number, limit = 500): LogLine[] {
		const found = this.lines.filter((line) => line.seq > seq);
		return found.slice(-limit);
	}

	get last(): number {
		return this.seq;
	}
}

export interface ControlHandlers {
	hello: () => Hello;
	status: () => Omit<ServeStatus, "studios">;
	stop: () => void;
	restart: (child: string) => Promise<boolean>;
	/** Hot asset jobs for the plugin's buttons (absent in tests that don't need them). */
	jobs?: JobRunner;
	/** The hot assets the lockfile knows (GET /tt/assets). */
	assets?: () => unknown;
	/** Devices paired for --remote (absent without it). */
	pairing?: Pairing;
	/** The plugin's Claude tab (claude.ts; absent in tests that don't need it). */
	claude?: ClaudeBridge;
}

/**
 * What a paired device may call through the remote gateway (remote.ts): what the plugin needs to sync, report and run
 * hot asset jobs. Not stop, restart, agent commands (`/tt/command`) or serve's own logs.
 */
const REMOTE_ROUTES = new Set([
	"GET /tt/hello",
	"GET /tt/status",
	"GET /tt/assets",
	"POST /tt/jobs",
	"GET /tt/jobs",
	"POST /tt/plugin/hello",
	"POST /tt/plugin/state",
	"POST /tt/plugin/logs",
	"GET /tt/plugin/poll",
	"POST /tt/plugin/result",
	"GET /tt/claude",
	"POST /tt/claude/prompt",
	"GET /tt/claude/prompt",
	"POST /tt/claude/deploy",
	"POST /tt/claude/cancel",
	"GET /tt/claude/chat",
	"POST /tt/claude/chat",
]);

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const STRING_MAX = 200;

function str(value: unknown, name: string, max = STRING_MAX): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpError(400, `${name}: expected a string`);
	return value;
}

function num(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, `${name}: expected a number`);
	return value;
}

const MODES = new Set(["edit", "server", "client"]);
const SYNC_STATES = new Set(["idle", "connecting", "connected", "disconnected", "paused"]);
const LEVELS = new Set(["info", "warn", "error"]);

export class ControlServer {
	readonly serveLogs = new LogRing();
	readonly studioLogs = new LogRing();
	private readonly studios = new Map<string, StudioInfo>();
	/** Commands waiting for each plugin's next poll, and the poll waiting for them. */
	private readonly queues = new Map<string, { commands: StudioCommand[]; waiter?: () => void }>();
	/** Commands sent and waiting for their result. */
	private readonly pending = new Map<string, { studio: string; done: (result: CommandResult) => void }>();
	private server?: Server;
	port = 0;

	constructor(private readonly handlers: ControlHandlers) {}

	/** Listens on the first free port of `ports` (default CONTROL_PORTS). */
	async listen(ports: readonly number[] = CONTROL_PORTS): Promise<number> {
		for (const port of ports) {
			const server = createServer((req, res) => void this.handle(req, res));
			const ok = await new Promise<boolean>((done) => {
				server.once("error", () => done(false));
				server.listen(port, "127.0.0.1", () => done(true));
			});
			if (ok) {
				this.server = server;
				this.port = port;
				return port;
			}
			server.close();
		}
		throw new Error(`no free port for the control API in ${ports[0]}-${ports[ports.length - 1]} (another typetorch serve per project is running?)`);
	}

	close(): Promise<void> {
		for (const queue of this.queues.values()) queue.waiter?.();
		return new Promise((done) => {
			if (!this.server) return done();
			this.server.close(() => done());
			this.server.closeAllConnections?.();
		});
	}

	/** The plugins heard from recently, newest first. */
	studioList(): StudioInfo[] {
		const now = Date.now();
		for (const [id, studio] of this.studios) {
			if (now - Date.parse(studio.lastSeen) <= STUDIO_TIMEOUT_MS) continue;
			this.studios.delete(id);
			this.queues.get(id)?.waiter?.();
			this.queues.delete(id);
		}
		return [...this.studios.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((s) => ({ ...s, sync: { ...s.sync } }));
	}

	status(): ServeStatus {
		return { ...this.handlers.status(), studios: this.studioList() };
	}

	/**
	 * Sends a command to a plugin and waits for its answer. `target`: a plugin id, or a mode (edit, server, client);
	 * default: `stop` goes to a playtest server when one is attached, everything else to the edit DataModel.
	 */
	async command(kind: CommandKind, args: Record<string, unknown> = {}, target?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
		const studios = this.studioList();
		let studio: StudioInfo | undefined;
		if (target && !MODES.has(target)) {
			studio = studios.find((s) => s.id === target);
			if (!studio) throw new HttpError(404, `no attached Studio with id ${target}`);
		} else {
			// a paired remote Studio only by its id: an agent here never drives someone else's Studio by accident
			const modes = target ? [target] : kind === "stop" ? ["server", "edit"] : ["edit"];
			for (const mode of modes) studio ??= studios.find((s) => s.mode === mode && !s.remote);
			if (!studio) throw new HttpError(409, noStudioMessage(modes.join(" or ")));
		}
		const command: StudioCommand = { id: randomUUID(), kind, args };
		const queue = this.queueFor(studio.id);
		const info = { id: studio.id, mode: studio.mode, placeName: studio.placeName };
		return new Promise<CommandResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(command.id);
				const at = queue.commands.indexOf(command);
				if (at !== -1) queue.commands.splice(at, 1);
				resolve({ ok: false, studio: info, error: `Studio (${studio.mode}) didn't answer within ${Math.round(timeoutMs / 1000)} s` });
			}, timeoutMs);
			this.pending.set(command.id, {
				studio: studio.id,
				done: (result) => {
					clearTimeout(timer);
					this.pending.delete(command.id);
					resolve(result);
				},
			});
			queue.commands.push(command);
			queue.waiter?.();
		});
	}

	private queueFor(id: string) {
		let queue = this.queues.get(id);
		if (!queue) this.queues.set(id, (queue = { commands: [] }));
		return queue;
	}

	/** Answers a plugin's poll with its queued commands, holding the request up to `holdMs` while there are none. */
	private async poll(id: string, holdMs: number, gone?: AbortSignal): Promise<{ commands: StudioCommand[] }> {
		const queue = this.queueFor(id);
		if (queue.commands.length === 0 && holdMs > 0) {
			queue.waiter?.(); // one poll per plugin: an older one answers empty
			await new Promise<void>((done) => {
				const timer = setTimeout(finish, holdMs);
				gone?.addEventListener("abort", finish);
				function finish() {
					clearTimeout(timer);
					gone?.removeEventListener("abort", finish);
					if (queue.waiter === finish) queue.waiter = undefined;
					done();
				}
				queue.waiter = finish;
			});
		}
		if (gone?.aborted) return { commands: [] }; // keep them for the next poll
		if (this.studios.has(id)) this.touch(id);
		return { commands: queue.commands.splice(0) };
	}

	/** Marks a plugin as alive (any request from it). */
	protected touch(id: string): StudioInfo {
		const studio = this.studios.get(id);
		if (!studio) throw new HttpError(404, "unknown plugin id: send /tt/plugin/hello first");
		studio.lastSeen = new Date().toISOString();
		return studio;
	}

	/**
	 * A request a paired device sent through the remote gateway (remote.ts checked its token): REMOTE_ROUTES only, and
	 * its plugin ids live under `remote/<device>/` so they can't take over a local Studio's.
	 */
	handleRemote(req: IncomingMessage, res: ServerResponse, device: string, userId?: number) {
		return this.handle(req, res, device, userId);
	}

	private async handle(req: IncomingMessage, res: ServerResponse, remote?: string, remoteUser?: number) {
		try {
			this.checkRequest(req, remote !== undefined);
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (remote !== undefined && !REMOTE_ROUTES.has(`${req.method} ${url.pathname}`)) throw new HttpError(403, "not available to a remote Studio");
			const body = req.method === "POST" ? await readJson(req) : undefined;
			if (remote !== undefined) {
				const prefix = `remote/${remote}/`;
				const own = (id: unknown) => {
					if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new HttpError(400, "id: expected a string");
					return prefix + id;
				};
				if (body && "id" in (body as Record<string, unknown>)) (body as Record<string, unknown>).id = own((body as Record<string, unknown>).id);
				const id = url.searchParams.get("id");
				if (id && url.pathname.startsWith("/tt/plugin/")) url.searchParams.set("id", String(own(id)));
				if (url.pathname === "/tt/plugin/hello" && body) (body as Record<string, unknown>).remote = remote;
			}
			const gone = new AbortController();
			res.on("close", () => gone.abort());
			const result = await this.route(req.method ?? "GET", url, body as Record<string, unknown> | undefined, gone.signal, remote === undefined ? undefined : { userId: remoteUser });
			send(res, 200, result);
		} catch (error) {
			if (error instanceof HttpError || error instanceof ClaudeError) send(res, error.status, { error: error.message });
			else send(res, 500, { error: (error as Error).message ?? String(error) });
		}
	}

	/**
	 * Loopback callers only, with the header, without a browser Origin, and with a loopback Host (no DNS rebinding). A
	 * remote request came through a tunnel (its Host is the tunnel's) and was checked by its token instead.
	 */
	private checkRequest(req: IncomingMessage, remote = false) {
		if (req.method === "OPTIONS") throw new HttpError(403, "no CORS");
		if (req.headers.origin !== undefined) throw new HttpError(403, "browser requests are refused");
		if (req.headers[HEADER] !== "1") throw new HttpError(403, `missing ${HEADER} header`);
		if (remote) return;
		const host = (req.headers.host ?? "").toLowerCase();
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new HttpError(403, "bad Host");
	}

	/**
	 * `gone`: the caller hung up (a long poll must not hand its commands to a closed connection). `remote`: the paired
	 * device a remote request came from (absent: a local caller).
	 */
	protected async route(method: string, url: URL, body: Record<string, unknown> | undefined, gone?: AbortSignal, remote?: { userId?: number }): Promise<unknown> {
		const key = `${method} ${url.pathname}`;
		switch (key) {
			case "GET /tt/hello":
				return this.handlers.hello();
			case "GET /tt/status":
				return this.status();
			case "GET /tt/logs": {
				const since = Number(url.searchParams.get("since") ?? 0) || 0;
				const ring = url.searchParams.get("source") === "studio" ? this.studioLogs : this.serveLogs;
				return { last: ring.last, lines: ring.since(since, Number(url.searchParams.get("limit") ?? 500) || 500) };
			}
			case "POST /tt/stop":
				setTimeout(() => this.handlers.stop(), 50);
				return { ok: true };
			case "POST /tt/restart": {
				const child = str(body?.child, "child", 40);
				if (!(await this.handlers.restart(child))) throw new HttpError(404, `no child named ${child}`);
				return { ok: true };
			}
			case "POST /tt/command": {
				const kind = str(body?.kind, "kind", 20);
				if (!(COMMAND_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind: one of ${COMMAND_KINDS.join(", ")}`);
				const args = body?.args;
				if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) throw new HttpError(400, "args: expected an object");
				const target = body?.target === undefined ? undefined : str(body.target, "target", 64);
				const timeout = body?.timeoutMs === undefined ? COMMAND_TIMEOUT_MS : num(body.timeoutMs, "timeoutMs");
				return this.command(kind as CommandKind, (args as Record<string, unknown>) ?? {}, target, Math.min(Math.max(timeout, 1000), COMMAND_TIMEOUT_MAX_MS));
			}
			case "GET /tt/plugin/poll": {
				const id = str(url.searchParams.get("id") ?? undefined, "id", 140);
				this.touch(id);
				const hold = Number(url.searchParams.get("wait") ?? POLL_HOLD_MS / 1000);
				return this.poll(id, Math.min(Math.max(Number.isFinite(hold) ? hold * 1000 : 0, 0), POLL_HOLD_MS), gone);
			}
			case "POST /tt/plugin/result": {
				const studio = this.touch(str(body?.id, "id", 140));
				const entry = this.pending.get(str(body?.command, "command", 64));
				// Late (timed out) or someone else's: nothing waits for it.
				if (!entry || entry.studio !== studio.id) return { ok: true, late: true };
				const result = body?.result;
				entry.done({
					ok: body?.ok === true,
					studio: { id: studio.id, mode: studio.mode, placeName: studio.placeName },
					result: result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined,
					error: typeof body?.error === "string" ? body.error.slice(0, 2000) : undefined,
				});
				return { ok: true };
			}
			case "GET /tt/assets":
				if (!this.handlers.assets) throw new HttpError(404, "no assets here");
				return this.handlers.assets();
			case "POST /tt/jobs": {
				const jobs = this.handlers.jobs;
				if (!jobs) throw new HttpError(404, "no jobs here");
				const kind = str(body?.kind, "kind", 40);
				if (!(JOB_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind: one of ${JOB_KINDS.join(", ")}`);
				return jobs.start(kind as JobKind);
			}
			case "GET /tt/jobs": {
				const jobs = this.handlers.jobs;
				if (!jobs) throw new HttpError(404, "no jobs here");
				const id = url.searchParams.get("id");
				if (!id) return { jobs: jobs.list() };
				const job = jobs.get(id);
				if (!job) throw new HttpError(404, `no job ${id}`);
				return job;
			}
			case "POST /tt/plugin/hello":
				return this.pluginHello(body ?? {});
			case "POST /tt/remote/code": {
				const url = body?.url === undefined ? undefined : str(body.url, "url", 300);
				try {
					return this.pairing().newCode(url);
				} catch (error) {
					throw new HttpError(400, (error as Error).message);
				}
			}
			case "GET /tt/remote/devices":
				return { devices: this.pairing().list() };
			case "POST /tt/remote/revoke": {
				const name = body?.name === undefined ? undefined : str(body.name, "name", 60);
				return { revoked: this.pairing().revoke(name) };
			}
			case "POST /tt/plugin/state": {
				const studio = this.touch(str(body?.id, "id", 140));
				const status = str(body?.status, "status", 20);
				if (!SYNC_STATES.has(status)) throw new HttpError(400, "status: unknown value");
				const detail = typeof body?.detail === "string" ? body.detail.slice(0, 500) : undefined;
				const changed = studio.sync.status !== status || studio.sync.detail !== detail;
				studio.sync = { status: status as StudioInfo["sync"]["status"], detail, at: new Date().toISOString() };
				if (changed) this.serveLogs.push("studio", "info", `${studio.mode} plugin (${studio.placeName}): ${status}${detail ? ` (${detail})` : ""}`);
				return { ok: true };
			}
			case "POST /tt/plugin/logs": {
				const studio = this.touch(str(body?.id, "id", 140));
				const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 200) : [];
				for (const entry of lines as Record<string, unknown>[]) {
					const level = typeof entry?.level === "string" && LEVELS.has(entry.level) ? (entry.level as LogLine["level"]) : "info";
					if (typeof entry?.text !== "string") continue;
					this.studioLogs.push(studio.mode, level, entry.text.slice(0, 4000));
				}
				return { ok: true };
			}
			case "GET /tt/claude":
				return this.claude().status();
			case "POST /tt/claude/prompt": {
				const prompt = str(body?.prompt, "prompt", 20_000);
				const conversationId = body?.conversationId === undefined ? undefined : str(body.conversationId, "conversationId", 64);
				return this.claude().prompt(this.claudeUser(remote, body?.user), prompt, conversationId);
			}
			case "GET /tt/claude/prompt": {
				const id = str(url.searchParams.get("id") ?? undefined, "id", 64);
				const since = Math.max(0, Math.floor(Number(url.searchParams.get("since") ?? 0) || 0));
				return this.claude().poll(this.claudeUser(remote, url.searchParams.get("user")), id, since);
			}
			case "POST /tt/claude/deploy": {
				const decision = str(body?.decision, "decision", 10);
				if (decision !== "deploy" && decision !== "discard") throw new HttpError(400, "decision: deploy or discard");
				return this.claude().deploy(this.claudeUser(remote, body?.user), str(body?.id, "id", 64), decision);
			}
			case "POST /tt/claude/cancel":
				return this.claude().cancel(this.claudeUser(remote, body?.user), str(body?.id, "id", 64));
			case "GET /tt/claude/chat":
				return this.claude().chat(this.claudeUser(remote, url.searchParams.get("user")));
			case "POST /tt/claude/chat": {
				const conversationId = body?.conversationId === undefined || body.conversationId === null ? undefined : str(body.conversationId, "conversationId", 64);
				if (!Array.isArray(body?.prompts) || body.prompts.length > 500) throw new HttpError(400, "prompts: a list of prompt ids");
				const prompts = (body.prompts as unknown[]).map((id) => str(id, "prompts[]", 64));
				return this.claude().saveChat(this.claudeUser(remote, body?.user), conversationId, prompts);
			}
			default:
				throw new HttpError(404, `no route ${key}`);
		}
	}

	get pairingStore(): Pairing | undefined {
		return this.handlers.pairing;
	}

	private claude(): ClaudeBridge {
		if (!this.handlers.claude) throw new HttpError(404, "no Claude here");
		return this.handlers.claude;
	}

	/**
	 * Whose prompts these are (a Roblox user id, which remote-claude's --users must allow): a remote device's is the one it
	 * paired with, and can't be changed per request; a local caller names it.
	 */
	private claudeUser(remote: { userId?: number } | undefined, given: unknown): number {
		if (remote) {
			if (remote.userId === undefined) throw new HttpError(403, "this Studio paired without its Roblox user: pair it again for the Claude tab");
			return remote.userId;
		}
		const user = typeof given === "string" ? Number(given) : given;
		if (typeof user !== "number" || !Number.isSafeInteger(user) || user <= 0) throw new HttpError(400, "user: expected a Roblox user id");
		return user;
	}

	private pairing(): Pairing {
		if (!this.handlers.pairing) throw new HttpError(404, "typetorch serve runs without --remote");
		return this.handlers.pairing;
	}

	private pluginHello(body: Record<string, unknown>) {
		const id = str(body.id, "id", 140);
		const mode = str(body.mode, "mode", 10);
		if (!MODES.has(mode)) throw new HttpError(400, "mode: edit, server or client");
		const now = new Date().toISOString();
		const existing = this.studios.get(id);
		const studio: StudioInfo = {
			id,
			mode: mode as StudioInfo["mode"],
			placeId: num(body.placeId, "placeId"),
			gameId: num(body.gameId, "gameId"),
			placeName: typeof body.placeName === "string" ? body.placeName.slice(0, 100) : "",
			pluginVersion: typeof body.pluginVersion === "string" ? body.pluginVersion.slice(0, 40) : "",
			sync: existing?.sync ?? { status: "idle" },
			...(typeof body.remote === "string" ? { remote: body.remote } : {}),
			firstSeen: existing?.firstSeen ?? now,
			lastSeen: now,
		};
		this.studios.set(id, studio);
		if (!existing) {
			const from = studio.remote ? `, remote: ${studio.remote}` : "";
			this.serveLogs.push("studio", "info", `${studio.mode} plugin attached (${studio.placeName || "unnamed place"}, place ${studio.placeId}${from})`);
		}
		return { ok: true, hello: this.handlers.hello() };
	}
}

function send(res: ServerResponse, status: number, body: unknown) {
	const text = JSON.stringify(body ?? null);
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((done, fail) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				fail(new HttpError(413, "body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text) return done({});
			try {
				const parsed = JSON.parse(text);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
				done(parsed);
			} catch {
				fail(new HttpError(400, "body: expected a JSON object"));
			}
		});
		req.on("error", fail);
	});
}

