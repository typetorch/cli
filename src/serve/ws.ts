/**
 * The server side of a WebSocket (RFC 6455), just what serve's streams need: the handshake, text frames out, masked
 * text/close/ping frames in (no fragmentation, no extensions). Studio's WebStreamClient and Cloudflare quick tunnels
 * both speak it.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest frame a client may send (the streams only take small JSON commands). */
const MAX_IN = 64 * 1024;

export class WebSocketConnection {
	private buffer = Buffer.alloc(0);
	private closed = false;
	private readonly listeners: { message: ((text: string) => void)[]; close: (() => void)[] } = { message: [], close: [] };

	constructor(private readonly socket: Socket) {
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => this.read(chunk));
		socket.on("close", () => this.finish());
		socket.on("error", () => this.finish());
	}

	get open(): boolean {
		return !this.closed;
	}

	on(event: "message", listener: (text: string) => void): void;
	on(event: "close", listener: () => void): void;
	on(event: "message" | "close", listener: never) {
		(this.listeners[event] as unknown[]).push(listener);
	}

	send(text: string) {
		if (this.closed) return;
		this.socket.write(frame(0x1, Buffer.from(text, "utf8")));
	}

	ping() {
		if (!this.closed) this.socket.write(frame(0x9, Buffer.alloc(0)));
	}

	close(code = 1000) {
		if (this.closed) return;
		const payload = Buffer.alloc(2);
		payload.writeUInt16BE(code);
		this.socket.end(frame(0x8, payload));
		this.finish();
	}

	private finish() {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
		for (const listener of this.listeners.close) listener();
	}

	/** Bytes that came with the upgrade request (read before the socket's own). */
	feed(chunk: Buffer) {
		this.read(chunk);
	}

	private read(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.buffer.length < 2) return;
			const first = this.buffer[0];
			const second = this.buffer[1];
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				const big = this.buffer.readBigUInt64BE(2);
				length = big > BigInt(MAX_IN) ? MAX_IN + 1 : Number(big);
				offset = 10;
			}
			// clients must mask, and must not fragment or send more than a small command
			if (!masked || (first & 0x80) === 0 || length > MAX_IN) return this.close(1009);
			if (this.buffer.length < offset + 4 + length) return;
			const mask = this.buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			this.buffer = this.buffer.subarray(offset + 4 + length);
			if (opcode === 0x1) for (const listener of this.listeners.message) listener(payload.toString("utf8"));
			else if (opcode === 0x8) return this.close();
			else if (opcode === 0x9) this.socket.write(frame(0xa, payload));
			else if (opcode !== 0xa) return this.close(1003);
		}
	}
}

function frame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	const head = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
	head[0] = 0x80 | opcode;
	if (length < 126) head[1] = length;
	else if (length < 65536) {
		head[1] = 126;
		head.writeUInt16BE(length, 2);
	} else {
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([head, payload]);
}

/** Completes the handshake on an upgrade request, or answers `status` and returns undefined when it isn't one. */
export function acceptWebSocket(req: IncomingMessage, socket: Socket, head: Buffer): WebSocketConnection | undefined {
	const key = req.headers["sec-websocket-key"];
	if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13") {
		refuseUpgrade(socket, 400, "Bad Request");
		return undefined;
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	const connection = new WebSocketConnection(socket);
	if (head.length) setImmediate(() => connection.feed(head));
	return connection;
}

export function refuseUpgrade(socket: Socket, status: number, text: string) {
	socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
