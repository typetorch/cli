/**
 * The control API of `typetorch serve` (protocol.ts has the contract and the security rules). Plugins register and
 * report their sync state and Studio's Output here; the CLI's subcommands read status and logs and stop the server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CONTROL_PORTS, HEADER, type Hello, type LogLine, type ServeStatus, type StudioInfo } from "./protocol.ts";

/** Lines kept per source group (serve's own children, Studio). */
const RING_SIZE = 2000;
const MAX_BODY = 256 * 1024;
/** A plugin that hasn't been heard from for this long is dropped from the list. */
export const STUDIO_TIMEOUT_MS = 30_000;

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
}

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
		return new Promise((done) => (this.server ? this.server.close(() => done()) : done()));
	}

	/** The plugins heard from recently, newest first. */
	studioList(): StudioInfo[] {
		const now = Date.now();
		for (const [id, studio] of this.studios) {
			if (now - Date.parse(studio.lastSeen) > STUDIO_TIMEOUT_MS) this.studios.delete(id);
		}
		return [...this.studios.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((s) => ({ ...s, sync: { ...s.sync } }));
	}

	status(): ServeStatus {
		return { ...this.handlers.status(), studios: this.studioList() };
	}

	/** Marks a plugin as alive (any request from it). */
	protected touch(id: string): StudioInfo {
		const studio = this.studios.get(id);
		if (!studio) throw new HttpError(404, "unknown plugin id: send /tt/plugin/hello first");
		studio.lastSeen = new Date().toISOString();
		return studio;
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		try {
			this.checkRequest(req);
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const body = req.method === "POST" ? await readJson(req) : undefined;
			const result = await this.route(req.method ?? "GET", url, body as Record<string, unknown> | undefined);
			send(res, 200, result);
		} catch (error) {
			if (error instanceof HttpError) send(res, error.status, { error: error.message });
			else send(res, 500, { error: (error as Error).message ?? String(error) });
		}
	}

	/** Loopback callers only, with the header, without a browser Origin, and with a loopback Host (no DNS rebinding). */
	private checkRequest(req: IncomingMessage) {
		if (req.method === "OPTIONS") throw new HttpError(403, "no CORS");
		if (req.headers.origin !== undefined) throw new HttpError(403, "browser requests are refused");
		if (req.headers[HEADER] !== "1") throw new HttpError(403, `missing ${HEADER} header`);
		const host = (req.headers.host ?? "").toLowerCase();
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new HttpError(403, "bad Host");
	}

	protected async route(method: string, url: URL, body: Record<string, unknown> | undefined): Promise<unknown> {
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
			case "POST /tt/plugin/hello":
				return this.pluginHello(body ?? {});
			case "POST /tt/plugin/state": {
				const studio = this.touch(str(body?.id, "id", 64));
				const status = str(body?.status, "status", 20);
				if (!SYNC_STATES.has(status)) throw new HttpError(400, "status: unknown value");
				const detail = typeof body?.detail === "string" ? body.detail.slice(0, 500) : undefined;
				const changed = studio.sync.status !== status || studio.sync.detail !== detail;
				studio.sync = { status: status as StudioInfo["sync"]["status"], detail, at: new Date().toISOString() };
				if (changed) this.serveLogs.push("studio", "info", `${studio.mode} plugin (${studio.placeName}): ${status}${detail ? ` (${detail})` : ""}`);
				return { ok: true };
			}
			case "POST /tt/plugin/logs": {
				const studio = this.touch(str(body?.id, "id", 64));
				const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 200) : [];
				for (const entry of lines as Record<string, unknown>[]) {
					const level = typeof entry?.level === "string" && LEVELS.has(entry.level) ? (entry.level as LogLine["level"]) : "info";
					if (typeof entry?.text !== "string") continue;
					this.studioLogs.push(studio.mode, level, entry.text.slice(0, 4000));
				}
				return { ok: true };
			}
			default:
				throw new HttpError(404, `no route ${key}`);
		}
	}

	private pluginHello(body: Record<string, unknown>) {
		const id = str(body.id, "id", 64);
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
			firstSeen: existing?.firstSeen ?? now,
			lastSeen: now,
		};
		this.studios.set(id, studio);
		if (!existing) this.serveLogs.push("studio", "info", `${studio.mode} plugin attached (${studio.placeName || "unnamed place"}, place ${studio.placeId})`);
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

