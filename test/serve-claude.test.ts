/** `typetorch serve --claude`: the Claude tab's bridge to remote-claude (claude.ts), locally and through the gateway. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_FILE, CLAUDE_SESSION_FILE, ClaudeBridge } from "../src/serve/claude";
import { call } from "../src/serve/client";
import { Pairing } from "../src/serve/pairing";
import type { Hello } from "../src/serve/protocol";
import { RemoteGateway } from "../src/serve/remote";
import { ControlServer } from "../src/serve/server";

const SID = "0123456789abcdef0123456789abcdef";

/** A stand-in for remote-claude's HTTP API: pairing codes, rotating refresh tokens, prompts. */
function fakeRemoteClaude() {
	const state = { code: "AAAA-BBBB", allowed: new Set([7, 8]), grants: [] as string[], prompts: [] as { user: number; body: Record<string, unknown> }[], headers: [] as Record<string, string | undefined>[] };
	const access = new Map<string, number>();
	const refresh = new Map<string, number>();
	let n = 0;
	const server: Server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const body = text ? JSON.parse(text) : {};
		const reply = (status: number, value?: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(value === undefined ? "" : JSON.stringify(value));
		};
		if (req.url === "/v1/token") {
			if (body.sid !== SID || body.job !== "" || body.branch !== "dev" || !state.allowed.has(body.user)) return reply(401);
			state.grants.push(`${body.grant} ${body.user}`);
			if (body.grant === "code") {
				if (body.code !== state.code) return reply(401);
				state.code = `CODE-${++n}`; // single use
			} else {
				if (refresh.get(body.refresh_token) !== body.user) return reply(401);
				refresh.delete(body.refresh_token);
			}
			const a = `a${++n}`;
			const r = `r${++n}`;
			access.set(a, body.user);
			refresh.set(r, body.user);
			return reply(200, { access_token: a, expires_in: 300, refresh_token: r, refresh_expires_in: 10800 });
		}
		const user = access.get((req.headers.authorization ?? "").replace("Bearer ", ""));
		if (user === undefined || req.headers["x-tt-job"] !== "") return reply(401);
		state.headers.push({ nonce: req.headers["x-tt-nonce"] as string | undefined, timestamp: req.headers["x-tt-timestamp"] as string | undefined });
		if (req.method === "POST" && req.url === "/v1/prompts") {
			state.prompts.push({ user, body });
			return reply(200, { id: `p${state.prompts.length}`, state: "queued", conversationId: "c1" });
		}
		const poll = /^\/v1\/prompts\/(\w+)\?since=(\d+)$/.exec(req.url ?? "");
		if (req.method === "GET" && poll) return reply(200, { id: poll[1], state: "done", events: [{ i: Number(poll[2]), kind: "assistant_text", text: `hi ${user}` }], next: Number(poll[2]) + 1 });
		if (req.method === "GET" && req.url === "/v1/conversations") return reply(200, { conversations: [{ id: "c1", user }] });
		if (req.method === "POST" && req.url === "/v1/attachments/capture") return reply(200, { id: "a1", width: 4, height: 2, got: body });
		if (req.method === "POST" && /^\/v1\/prompts\/\w+\/deploy$/.test(req.url ?? "")) return reply(body.decision === "deploy" ? 200 : 400, { ok: true });
		reply(404);
	});
	return { server, state, revokeAccess: () => access.clear() };
}

const hello = (): Hello => ({ app: "typetorch-serve", api: 1, project: "test", universeId: 1, placeId: 2, rojoPort: 0, projectFile: "studio.project.json", pid: process.pid, startedAt: "2026-10-21T00:00:00.000Z" });

describe("serve --claude", () => {
	const root = mkdtempSync(join(tmpdir(), "tt-claude-"));
	const fake = fakeRemoteClaude();
	const bridge = new ClaudeBridge({ root });
	const pairing = new Pairing(root);
	const control = new ControlServer({ hello, status: () => ({ hello: hello(), children: [], compile: { state: "idle", errors: [] } }), stop: () => {}, restart: async () => false, pairing, claude: bridge });
	const gateway = new RemoteGateway({ control, pairing, rojoPort: () => 0, log: () => {} });
	let controlPort = 0;
	let base = "";
	const writeSession = (port: number) => {
		mkdirSync(join(root, ".typetorch"), { recursive: true });
		writeFileSync(join(root, CLAUDE_SESSION_FILE), JSON.stringify({ v: 1, sid: SID, branch: "dev", port, url: null, pid: process.pid }));
	};
	const syncCode = () => writeFileSync(join(root, CLAUDE_CODE_FILE), `${fake.state.code}\nexpires 2026-10-21T03:00:00.000Z\n`);

	beforeAll(async () => {
		await new Promise<void>((done) => fake.server.listen(0, "127.0.0.1", done));
		controlPort = await control.listen([45990, 45991, 45992]);
		base = `http://127.0.0.1:${await gateway.listen(45993)}`;
	});
	afterAll(async () => {
		await gateway.close();
		await control.close();
		fake.server.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("without a session the tab says how to start one", async () => {
		expect(await call<unknown>(controlPort, "GET", "/tt/claude")).toEqual({ available: false, hint: expect.stringContaining("typetorch serve --claude") });
		// a stale file from a dead session doesn't count
		writeSession(1);
		expect(new ClaudeBridge({ root, alive: () => false }).status().available).toBe(false);
	});

	test("a local Studio prompts in Code mode; serve pairs with the current code, then refreshes", async () => {
		writeSession((fake.server.address() as { port: number }).port);
		syncCode();
		expect(await call<unknown>(controlPort, "GET", "/tt/claude")).toEqual({ available: true, branch: "dev" });
		const started = await call<{ id: string }>(controlPort, "POST", "/tt/claude/prompt", { user: 7, prompt: "make the door red" });
		expect(started.id).toBe("p1");
		expect(fake.state.prompts[0]).toEqual({ user: 7, body: { prompt: "make the door red", mode: "code" } });
		expect(fake.state.headers.at(-1)?.nonce).toMatch(/^[0-9a-f-]{36}$/);
		const polled = await call<{ events: { text: string }[] }>(controlPort, "GET", "/tt/claude/prompt?id=p1&since=0&user=7");
		expect(polled.events[0].text).toBe("hi 7");
		expect(fake.state.grants).toEqual(["code 7"]); // one pairing, the token reused
		// the access token dies: a refresh, not a new code
		fake.revokeAccess();
		await call(controlPort, "POST", "/tt/claude/deploy", { user: 7, id: "p1", decision: "deploy" });
		expect(fake.state.grants).toEqual(["code 7", "refresh 7"]);
		await expect(call(controlPort, "POST", "/tt/claude/deploy", { user: 7, id: "p1", decision: "nope" })).rejects.toThrow("decision");
	});

	test("a user remote-claude doesn't allow gets told how to add them", async () => {
		syncCode();
		await expect(call(controlPort, "POST", "/tt/claude/prompt", { user: 99, prompt: "hi" })).rejects.toThrow("--users");
	});

	test("a remote Studio prompts as the Roblox user it paired with, whatever it sends", async () => {
		const { code } = await call<{ code: string }>(controlPort, "POST", "/tt/remote/code");
		const remote = (path: string, init: RequestInit = {}, bearer?: string) =>
			fetch(base + path, { ...init, headers: { "x-typetorch": "1", "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
		const paired = await remote("/tt/pair", { method: "POST", body: JSON.stringify({ code, name: "asset guy", userId: 8 }) });
		const { token } = (await paired.json()) as { token: string };
		syncCode();
		const res = await remote("/tt/claude/prompt", { method: "POST", body: JSON.stringify({ user: 7, prompt: "add a lamp" }) }, token);
		expect(res.status).toBe(200);
		expect(fake.state.prompts.at(-1)).toEqual({ user: 8, body: { prompt: "add a lamp", mode: "code" } });
		expect(((await (await remote("/tt/claude", {}, token)).json()) as { available: boolean }).available).toBe(true);
		// paired before the Claude tab existed (no user id): asked to pair again
		const old = await call<{ code: string }>(controlPort, "POST", "/tt/remote/code");
		const { token: oldToken } = (await (await remote("/tt/pair", { method: "POST", body: JSON.stringify({ code: old.code, name: "old" }) })).json()) as { token: string };
		const refused = await remote("/tt/claude/prompt", { method: "POST", body: JSON.stringify({ prompt: "x" }) }, oldToken);
		expect(refused.status).toBe(403);
	});

	test("the chat is shared by every copy of the plugin, per user, for this session", async () => {
		expect(await call<unknown>(controlPort, "GET", "/tt/claude/chat?user=7")).toEqual({ prompts: [] });
		await call(controlPort, "POST", "/tt/claude/chat", { user: 7, conversationId: "c1", prompts: ["p1", "p2"] });
		expect(await call<unknown>(controlPort, "GET", "/tt/claude/chat?user=7")).toEqual({ conversationId: "c1", prompts: ["p1", "p2"], texts: { p1: "make the door red" }, updatedAt: expect.any(String) });
		expect(await call<unknown>(controlPort, "GET", "/tt/claude/chat?user=8")).toEqual({ prompts: [] });
		await expect(call(controlPort, "POST", "/tt/claude/chat", { user: 7, prompts: "p1" })).rejects.toThrow("prompts");
		// a new remote-claude session: its prompts are gone, so is the chat
		const port = (fake.server.address() as { port: number }).port;
		writeFileSync(join(root, CLAUDE_SESSION_FILE), JSON.stringify({ v: 1, sid: "f".repeat(32), branch: "dev", port, url: null, pid: process.pid }));
		expect(await call<unknown>(controlPort, "GET", "/tt/claude/chat?user=7")).toEqual({ prompts: [] });
		writeSession(port);
	});

	test("Live mode, Toolbox, screenshots and context reach remote-claude as the in-game tab sends them", async () => {
		syncCode();
		await call(controlPort, "POST", "/tt/claude/prompt", { user: 7, prompt: "spin the door", mode: "live", toolbox: true, attachments: ["a1"], context: { path: "Workspace.Door" } });
		expect(fake.state.prompts.at(-1)).toEqual({ user: 7, body: { prompt: "spin the door", mode: "live", toolbox: true, attachments: ["a1"], context: { path: "Workspace.Door" } } });
		await expect(call(controlPort, "POST", "/tt/claude/prompt", { user: 7, prompt: "x", mode: "god" })).rejects.toThrow("mode");
	});

	test("the rest of the tab's API passes through for that user, game-server and token routes don't", async () => {
		syncCode();
		expect(await call<unknown>(controlPort, "POST", "/tt/claude/v1", { user: 7, method: "GET", path: "/v1/conversations" })).toEqual({ conversations: [{ id: "c1", user: 7 }] });
		expect(await call<unknown>(controlPort, "POST", "/tt/claude/v1", { user: 7, method: "POST", path: "/v1/attachments/capture", body: { captureTime: 1 } })).toEqual({ id: "a1", width: 4, height: 2, got: { captureTime: 1 } });
		for (const [method, path] of [["GET", "/v1/game/pending"], ["POST", "/v1/token"], ["POST", "/v1/conversations"], ["GET", "/v1/conversations/../token"]])
			await expect(call(controlPort, "POST", "/tt/claude/v1", { user: 7, method, path })).rejects.toThrow("not allowed");
	});

	test("the stream pushes a prompt's events over a WebSocket, locally and through the gateway", async () => {
		syncCode();
		const first = (ws: WebSocket) =>
			new Promise<Record<string, unknown>[]>((done, fail) => {
				const got: Record<string, unknown>[] = [];
				ws.onmessage = (event) => {
					got.push(JSON.parse(String(event.data)));
					if (got[0]?.type === "ready" && got.length === 1) ws.send(JSON.stringify({ watch: "p1", since: 3 }));
					if (got.length === 3) done(got);
				};
				ws.onerror = () => fail(new Error("socket error"));
				ws.onclose = (event) => fail(new Error(`closed ${event.code}`));
			});
		const local = new WebSocket(`ws://127.0.0.1:${controlPort}/tt/claude/stream?user=7`, { headers: { "x-typetorch": "1" } } as never);
		const got = await first(local);
		local.close();
		expect(got[1]).toMatchObject({ type: "prompt", id: "p1", since: 3, state: "done", events: [{ i: 3, text: "hi 7" }] });
		expect(got[2]).toMatchObject({ type: "prompt", since: 4 });
		// without the header (a browser page can't set it): refused
		const refused = new WebSocket(`ws://127.0.0.1:${controlPort}/tt/claude/stream?user=7`);
		await expect(first(refused)).rejects.toThrow();
		// a paired device: its own user, whatever ?user= says
		const { code } = await call<{ code: string }>(controlPort, "POST", "/tt/remote/code");
		const paired = await fetch(base + "/tt/pair", { method: "POST", headers: { "x-typetorch": "1", "content-type": "application/json" }, body: JSON.stringify({ code, name: "asset guy", userId: 8 }) });
		const { token } = (await paired.json()) as { token: string };
		const remote = new WebSocket(`${base.replace("http", "ws")}/tt/claude/stream?user=7`, { headers: { "x-typetorch": "1", authorization: `Bearer ${token}` } } as never);
		const remoteGot = await first(remote);
		remote.close();
		expect(remoteGot[1]).toMatchObject({ type: "prompt", events: [{ text: "hi 8" }] });
		await expect(first(new WebSocket(`${base.replace("http", "ws")}/tt/claude/stream`, { headers: { "x-typetorch": "1" } } as never))).rejects.toThrow();
	});

	test("concurrent requests share one token exchange (refresh tokens rotate)", async () => {
		fake.revokeAccess();
		const before = fake.state.grants.length;
		await Promise.all([1, 2, 3].map(() => call(controlPort, "GET", "/tt/claude/prompt?id=p1&since=0&user=7")));
		expect(fake.state.grants.slice(before)).toEqual(["refresh 7"]);
	});
});
