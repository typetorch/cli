/** `typetorch serve --remote`: pairing, the gateway's token checks and route limits, and the Rojo proxy. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../src/serve/client";
import { MAX_BAD_CODES, newCode, normalizeCode, normalizeUrl, Pairing, PAIRING_FILE } from "../src/serve/pairing";
import type { Hello } from "../src/serve/protocol";
import { RemoteGateway, rojoPath } from "../src/serve/remote";
import { ControlServer, HttpError } from "../src/serve/server";

const hello = (): Hello => ({
	app: "typetorch-serve",
	api: 1,
	project: "test",
	universeId: 1,
	placeId: 2,
	rojoPort: 0,
	projectFile: "studio.project.json",
	pid: process.pid,
	startedAt: "2026-10-20T00:00:00.000Z",
});

describe("pairing", () => {
	test("a code works once, ignores case and dashes, and expires", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-pair-"));
		let now = 1_000_000;
		try {
			const pairing = new Pairing(root, () => now);
			expect(() => pairing.pair("ABCD", "x")).toThrow("no pairing code is active");
			const { code } = pairing.newCode();
			expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
			const { token } = pairing.pair(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`, "asset guy");
			expect(pairing.check(token)?.name).toBe("asset guy");
			expect(() => pairing.pair(code, "again")).toThrow("no pairing code is active");
			// kept as a hash only, and survives a restart
			const saved = readFileSync(join(root, PAIRING_FILE), "utf8");
			expect(saved).not.toContain(token);
			expect(new Pairing(root, () => now).check(token)?.name).toBe("asset guy");
			const late = pairing.newCode();
			now += 16 * 60_000;
			expect(() => pairing.pair(late.code, "late")).toThrow("no pairing code is active");
			now += 31 * 86_400_000;
			expect(pairing.check(token)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("wrong codes lock pairing until a new code; revoke drops devices", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-pair-"));
		try {
			const pairing = new Pairing(root);
			const { code } = pairing.newCode();
			for (let i = 0; i < MAX_BAD_CODES; i++) expect(() => pairing.pair("WRONGWRO", "x")).toThrow();
			expect(() => pairing.pair(code, "x")).toThrow();
			const fresh = pairing.newCode();
			const a = pairing.pair(fresh.code, "a").token;
			pairing.newCode();
			expect(pairing.list().map((d) => d.name)).toEqual(["a"]);
			expect(pairing.revoke("a")).toBe(1);
			expect(pairing.check(a)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("with the tunnel URL, a code comes as one link; the URL is remembered", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-pair-"));
		try {
			const pairing = new Pairing(root);
			expect(pairing.newCode().link).toBeUndefined();
			const first = pairing.newCode("serve.example.com/");
			expect(first.link).toBe(`https://serve.example.com#${first.code}`);
			const later = new Pairing(root).newCode();
			expect(later.link).toBe(`https://serve.example.com#${later.code}`);
			expect(normalizeUrl("http://127.0.0.1:34890/")).toBe("http://127.0.0.1:34890");
			expect(() => normalizeUrl("https://x.example?a=1")).toThrow("just the tunnel");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("codes come from the unambiguous alphabet", () => {
		expect(newCode(() => Buffer.from([0, 1, 30, 31, 62, 200, 255, 7]))).toHaveLength(8);
		expect(normalizeCode(" ab-cd ef ")).toBe("ABCDEF");
		expect(rojoPath("/r/abcdefghijklmnopqrstuvwxyz/api/read/1,2")).toEqual(["abcdefghijklmnopqrstuvwxyz", "/api/read/1,2", "read"]);
		expect(rojoPath("/r/short/api/read")).toBeUndefined();
	});
});

describe("remote gateway", () => {
	const root = mkdtempSync(join(tmpdir(), "tt-remote-"));
	const pairing = new Pairing(root);
	const control = new ControlServer({ hello, status: () => ({ hello: hello(), children: [], compile: { state: "idle", errors: [] }, remote: { port: 1, tunnel: "quick", url: "https://a-b.trycloudflare.com", link: "https://a-b.trycloudflare.com#ABCDEFGH", linkExpiresAt: "2026-10-21T00:00:00.000Z" } }), stop: () => {}, restart: async () => false, pairing });
	let rojoPort = 0;
	const rojoHits: string[] = [];
	// A stand-in for rojo serve: answers HTTP, and echoes on an upgraded socket.
	const rojo: Server = createHttpServer((req, res) => {
		rojoHits.push(`${req.method} ${req.url} host=${req.headers.host}`);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ rojo: req.url }));
	});
	rojo.on("upgrade", (req, socket) => {
		rojoHits.push(`UPGRADE ${req.url}`);
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		socket.on("data", (data) => socket.write(data));
	});
	const gateway = new RemoteGateway({ control, pairing, rojoPort: () => rojoPort, log: () => {} });
	let base = "";
	let controlPort = 0;
	let token = "";

	beforeAll(async () => {
		controlPort = await control.listen([45890, 45891, 45892]);
		await new Promise<void>((done) => rojo.listen(0, "127.0.0.1", done));
		rojoPort = (rojo.address() as { port: number }).port;
		const port = await gateway.listen(45893);
		base = `http://127.0.0.1:${port}`;
	});
	afterAll(async () => {
		await gateway.close();
		await control.close();
		rojo.close();
		rmSync(root, { recursive: true, force: true });
	});

	const remote = (path: string, init: RequestInit = {}, bearer = token) =>
		fetch(base + path, { ...init, headers: { "x-typetorch": "1", "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(init.headers ?? {}) } });

	test("/tt/ping answers without a token (the tunnel's reachability check), and says nothing else", async () => {
		const res = await fetch(`${base}/tt/ping`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ app: "typetorch-remote" });
	});

	test("nothing but pairing works without a token; a code from the owner pairs", async () => {
		expect((await remote("/tt/hello", {}, "")).status).toBe(401);
		expect((await remote("/tt/hello", {}, "x".repeat(43))).status).toBe(401);
		expect((await remote("/tt/pair", { method: "POST", body: JSON.stringify({ code: "NOPE", name: "x" }) }, "")).status).toBe(403);
		// the owner asks for a code through the local control API only
		const { code } = await call<{ code: string }>(controlPort, "POST", "/tt/remote/code");
		const paired = await remote("/tt/pair", { method: "POST", body: JSON.stringify({ code, name: "asset guy" }) }, "");
		expect(paired.status).toBe(200);
		token = ((await paired.json()) as { token: string }).token;
		expect((await (await remote("/tt/hello")).json()) as Hello).toMatchObject({ app: "typetorch-serve", project: "test" });
		expect((await call<{ devices: { name: string }[] }>(controlPort, "GET", "/tt/remote/devices")).devices.map((d) => d.name)).toEqual(["asset guy"]);
		// pairing is never reachable remotely, nor is a browser
		expect((await remote("/tt/remote/code", { method: "POST" })).status).toBe(403);
		expect((await remote("/tt/hello", { headers: { origin: "https://evil.example" } })).status).toBe(403);
	});

	test("a remote Studio can sync and report, not stop serve or drive Studios; its ids are its own", async () => {
		for (const [method, path] of [["POST", "/tt/stop"], ["POST", "/tt/restart"], ["POST", "/tt/command"], ["GET", "/tt/logs"]]) {
			expect((await remote(path, { method, body: method === "POST" ? "{}" : undefined })).status).toBe(403);
		}
		const studio = { id: "local-1", mode: "edit", placeId: 2, gameId: 1, placeName: "Game" };
		expect((await remote("/tt/plugin/hello", { method: "POST", body: JSON.stringify(studio) })).status).toBe(200);
		const studios = control.studioList();
		expect(studios).toHaveLength(1);
		expect(studios[0].id).toMatch(/^remote\/asset guy#[0-9a-f]{6}\/local-1$/);
		expect(studios[0].remote).toMatch(/^asset guy#/);
		expect((await remote("/tt/plugin/state", { method: "POST", body: JSON.stringify({ id: "local-1", status: "connected" }) })).status).toBe(200);
		expect(control.studioList()[0].sync.status).toBe("connected");
		// an agent here doesn't reach it without naming it
		await expect(control.command("play")).rejects.toBeInstanceOf(HttpError);
	});

	test("the pairing link in serve's status is for the owner only", async () => {
		expect((await call<{ remote: { link?: string } }>(controlPort, "GET", "/tt/status")).remote.link).toBe("https://a-b.trycloudflare.com#ABCDEFGH");
		const seen = (await (await remote("/tt/status")).json()) as { remote: { url?: string; link?: string; linkExpiresAt?: string } };
		expect(seen.remote.url).toBe("https://a-b.trycloudflare.com");
		expect(seen.remote.link).toBeUndefined();
		expect(seen.remote.linkExpiresAt).toBeUndefined();
	});

	test("Rojo is proxied read-only through /r/<token>", async () => {
		const ok = await fetch(`${base}/r/${token}/api/rojo`);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ rojo: "/api/rojo" });
		expect(rojoHits.at(-1)).toBe(`GET /api/rojo host=localhost:${rojoPort}`);
		expect((await fetch(`${base}/r/${token}/api/read/1,2`)).status).toBe(200);
		expect((await fetch(`${base}/r/${token}/api/write`, { method: "POST", body: "{}" })).status).toBe(403);
		expect((await fetch(`${base}/r/${token}/api/open/1`, { method: "POST" })).status).toBe(403);
		expect((await fetch(`${base}/r/${"y".repeat(43)}/api/rojo`)).status).toBe(401);
	});

	test("Rojo's WebSocket is joined through, and refused without a token", async () => {
		const port = Number(new URL(base).port);
		const exchange = (path: string) =>
			new Promise<string>((done) => {
				const socket = connect(port, "127.0.0.1", () => {
					socket.write(`GET ${path} HTTP/1.1\r\nHost: tunnel.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
				});
				let text = "";
				socket.on("data", (data) => {
					text += data.toString();
					if (text.includes("\r\n\r\n") && !text.includes("ping") && text.startsWith("HTTP/1.1 101")) socket.write("ping");
					if (text.includes("ping") || !text.startsWith("HTTP/1.1 101")) {
						socket.destroy();
						done(text);
					}
				});
				socket.on("close", () => done(text));
			});
		const answer = await exchange(`/r/${token}/api/socket/0`);
		expect(answer.startsWith("HTTP/1.1 101")).toBe(true);
		expect(answer).toContain("ping");
		expect(rojoHits).toContain("UPGRADE /api/socket/0");
		expect((await exchange(`/r/${"z".repeat(43)}/api/socket/0`)).startsWith("HTTP/1.1 401")).toBe(true);
		expect((await exchange(`/r/${token}/api/write`)).startsWith("HTTP/1.1 403")).toBe(true);
	});
});
