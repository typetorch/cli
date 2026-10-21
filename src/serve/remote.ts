/**
 * `typetorch serve --remote`: one port for a Studio on another machine, meant to sit behind a tunnel the owner runs
 * (Cloudflare Tunnel: `service: http://localhost:<port>`). It listens on 127.0.0.1 only; the tunnel is what makes it
 * public, so every request but pairing needs a device token (pairing.ts):
 *
 *   POST /tt/pair          {code, name} -> {token, expiresAt}: a one-time code from `typetorch serve pair`
 *   /tt/...                the control API, `Authorization: Bearer <token>`, limited to what the plugin needs
 *                          (server.ts REMOTE_ROUTES)
 *   /r/<token>/api/...     Rojo, proxied to its local port. The token sits in the path because Rojo's client sends
 *                          no headers of its own; the plugin uses `<url>/r/<token>` as Rojo's address. Read-only:
 *                          `rojo`, `read`, `serialize`, `ref-patch` and the `socket` WebSocket; never `write` (two-way
 *                          sync onto the owner's disk) or `open` (opens a file on the owner's machine).
 */
import { createHash } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Pairing } from "./pairing.ts";
import type { ControlServer } from "./server.ts";

export const REMOTE_DEFAULT_PORT = 34890;
const ROJO_ROUTES = new Set(["rojo", "read", "serialize", "ref-patch"]);
const MAX_PAIR_BODY = 4096;

export interface RemoteOptions {
	control: ControlServer;
	pairing: Pairing;
	/** Rojo's local port (0 while it is down). */
	rojoPort: () => number;
	log: (level: "info" | "warn" | "error", text: string) => void;
}

/** A device's name plus a short hash of its token: distinct ids for two devices with the same name. */
function deviceLabel(name: string, token: string): string {
	return `${name.replace(/[^\w .-]/g, "_")}#${createHash("sha256").update(token).digest("hex").slice(0, 6)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/** `/r/<token>/api/<route>...` -> [token, "/api/<route>...", route] */
export function rojoPath(path: string): [string, string, string] | undefined {
	const match = /^\/r\/([A-Za-z0-9_-]{20,200})(\/api\/([a-z-]+)(?:\/.*)?)$/.exec(path);
	return match ? [match[1], match[2], match[3]] : undefined;
}

export class RemoteGateway {
	private server?: Server;
	/** Rojo WebSockets joined through: server.close() doesn't end upgraded sockets, so close() does. */
	private readonly sockets = new Set<Socket>();
	port = 0;

	constructor(private readonly options: RemoteOptions) {}

	listen(port = REMOTE_DEFAULT_PORT): Promise<number> {
		const server = createServer((req, res) => void this.handle(req, res));
		server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as Socket, head));
		return new Promise((done, fail) => {
			server.once("error", (error) => fail(new Error(`--remote: port ${port} is taken (${(error as Error).message}); pick another with --remote-port`)));
			server.listen(port, "127.0.0.1", () => {
				this.server = server;
				this.port = port;
				done(port);
			});
		});
	}

	close(): Promise<void> {
		return new Promise((done) => {
			if (!this.server) return done();
			this.server.close(() => done());
			this.server.closeAllConnections?.();
			for (const socket of this.sockets) socket.destroy();
			this.sockets.clear();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://remote");
		try {
			if (req.method === "OPTIONS" || req.headers.origin !== undefined) return sendJson(res, 403, { error: "browser requests are refused" });
			if (req.method === "POST" && url.pathname === "/tt/pair") return await this.pair(req, res);
			const rojo = rojoPath(url.pathname);
			if (rojo) return this.proxyRojo(req, res, rojo, url.search);
			if (url.pathname.startsWith("/tt/")) {
				const auth = req.headers.authorization ?? "";
				const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
				const device = this.options.pairing.check(token);
				if (!device || !token) return sendJson(res, 401, { error: "not paired: pair this Studio with a code from `typetorch serve pair`" });
				return await this.options.control.handleRemote(req, res, deviceLabel(device.name, token));
			}
			sendJson(res, 404, { error: "not found" });
		} catch (error) {
			if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
		}
	}

	private async pair(req: IncomingMessage, res: ServerResponse) {
		let text = "";
		for await (const chunk of req) {
			text += chunk;
			if (text.length > MAX_PAIR_BODY) return sendJson(res, 413, { error: "body too large" });
		}
		let body: { code?: unknown; name?: unknown };
		try {
			body = JSON.parse(text || "{}");
		} catch {
			return sendJson(res, 400, { error: "body: expected JSON" });
		}
		if (typeof body.code !== "string" || typeof body.name !== "string") return sendJson(res, 400, { error: "code and name: expected strings" });
		try {
			const paired = this.options.pairing.pair(body.code, body.name);
			this.options.log("info", `remote: paired "${body.name.slice(0, 60)}"`);
			sendJson(res, 200, paired);
		} catch (error) {
			this.options.log("warn", `remote: pairing refused (${(error as Error).message})`);
			sendJson(res, 403, { error: (error as Error).message });
		}
	}

	/** Checks a Rojo path's token and route; returns the local path or an error. */
	private rojoTarget(parsed: [string, string, string], socket: boolean): { path: string; port: number } | { status: number; error: string } {
		const [token, path, route] = parsed;
		if (!this.options.pairing.check(token)) return { status: 401, error: "not paired" };
		if (socket ? route !== "socket" : !ROJO_ROUTES.has(route)) return { status: 403, error: `Rojo's /api/${route} isn't available remotely` };
		const port = this.options.rojoPort();
		if (!port) return { status: 503, error: "Rojo isn't running" };
		return { path, port };
	}

	private proxyRojo(req: IncomingMessage, res: ServerResponse, parsed: [string, string, string], search: string) {
		const target = this.rojoTarget(parsed, false);
		if ("error" in target) return sendJson(res, target.status, { error: target.error });
		const upstream = request(
			{ host: "127.0.0.1", port: target.port, method: req.method, path: target.path + search, headers: { ...req.headers, host: `localhost:${target.port}` } },
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		upstream.on("error", (error) => {
			if (!res.headersSent) sendJson(res, 502, { error: `Rojo: ${error.message}` });
			else res.destroy();
		});
		req.pipe(upstream);
	}

	/** Rojo's WebSocket (`/api/socket/<cursor>`): the upgrade request is replayed to Rojo and the sockets are joined. */
	private upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
		const refuse = (status: number, text: string) => {
			socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		};
		const url = new URL(req.url ?? "/", "http://remote");
		const parsed = rojoPath(url.pathname);
		if (!parsed || req.headers.origin !== undefined) return refuse(404, "Not Found");
		const target = this.rojoTarget(parsed, true);
		if ("error" in target) return refuse(target.status, target.status === 401 ? "Unauthorized" : "Forbidden");
		this.sockets.add(socket);
		const upstream = connect(target.port, "127.0.0.1", () => {
			const headers = { ...req.headers, host: `localhost:${target.port}` };
			let raw = `${req.method} ${target.path}${url.search} HTTP/1.1\r\n`;
			for (const [name, value] of Object.entries(headers)) {
				for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) raw += `${name}: ${v}\r\n`;
			}
			upstream.write(raw + "\r\n");
			if (head.length) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		this.sockets.add(upstream);
		const close = () => {
			upstream.destroy();
			socket.destroy();
			this.sockets.delete(upstream);
			this.sockets.delete(socket);
		};
		upstream.on("error", close);
		socket.on("error", close);
		upstream.on("close", close);
		socket.on("close", close);
	}
}
