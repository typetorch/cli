/** `typetorch serve`: the compile tracker, the control API's request rules and plugin registry, the supervisor. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CompileTracker } from "../src/serve/compile";
import { call, ServeClientError } from "../src/serve/client";
import { handleMessage, TOOLS } from "../src/commands/mcp";
import { RECONNECT_LUAU, type CommandResult, type Hello, type StudioCommand } from "../src/serve/protocol";
import { ControlServer } from "../src/serve/server";
import { Supervisor } from "../src/serve/supervisor";

const PORTS = [45880, 45881, 45882];

const hello = (): Hello => ({
	app: "typetorch-serve",
	api: 1,
	project: "test",
	universeId: 1,
	placeId: 2,
	rojoPort: 34872,
	projectFile: "studio.project.json",
	pid: process.pid,
	startedAt: "2026-10-20T00:00:00.000Z",
});

describe("CompileTracker", () => {
	test("follows rbxtsc -w: a compile with errors, then a clean one", () => {
		const t = new CompileTracker();
		t.line("[\x1b[90m7:25:35 PM\x1b[0m] Starting compilation in watch mode...");
		expect(t.state).toBe("compiling");
		t.line("\x1b[96msrc/server/boot.ts\x1b[0m:\x1b[93m6\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.");
		t.line("6 const x: number = \"a\";");
		t.line("[7:25:42 PM] Found 1 error. Watching for file changes.");
		expect(t.state).toBe("errors");
		expect(t.errors).toEqual([{ file: "src/server/boot.ts", line: 6, column: 7, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." }]);
		t.line("[7:26:00 PM] File change detected. Starting incremental compilation...");
		expect(t.errors).toHaveLength(1); // kept until the compile finishes
		t.line("[7:26:01 PM] Found 0 errors. Watching for file changes.");
		expect(t.state).toBe("ok");
		expect(t.errors).toEqual([]);
	});

	test("Windows paths are normalized", () => {
		const t = new CompileTracker();
		t.line("src\\client\\ui.tsx:1:2 - error TS1005: ';' expected.");
		t.line("Found 1 error. Watching for file changes.");
		expect(t.errors[0].file).toBe("src/client/ui.tsx");
	});
});

describe("ControlServer", () => {
	let stopped = 0;
	const server = new ControlServer({
		hello,
		status: () => ({ hello: hello(), children: [], compile: { state: "idle", errors: [] } }),
		stop: () => stopped++,
		restart: async (child) => child === "rojo",
	});
	let port = 0;
	afterAll(() => server.close());

	test("listens on the first free port", async () => {
		port = await server.listen(PORTS);
		expect(PORTS).toContain(port);
	});

	test("answers /tt/hello with the header", async () => {
		expect(await call<Hello>(port, "GET", "/tt/hello")).toEqual(hello());
	});

	test("refuses requests without the header, with an Origin, or with another Host", async () => {
		const base = `http://127.0.0.1:${port}/tt/hello`;
		expect((await fetch(base)).status).toBe(403);
		expect((await fetch(base, { headers: { "x-typetorch": "1", origin: "http://evil.example" } })).status).toBe(403);
		expect((await fetch(base, { headers: { "x-typetorch": "1", host: `evil.example:${port}` } })).status).toBe(403);
		expect((await fetch(base, { method: "OPTIONS", headers: { "x-typetorch": "1" } })).status).toBe(403);
	});

	test("plugins register, report state and logs, and show in status", async () => {
		await call(port, "POST", "/tt/plugin/hello", { id: "p1", mode: "edit", placeId: 2, gameId: 1, placeName: "Cecot" });
		await call(port, "POST", "/tt/plugin/state", { id: "p1", status: "connected", detail: "synced" });
		await call(port, "POST", "/tt/plugin/logs", { id: "p1", lines: [{ level: "warn", text: "hello from Studio" }, { text: 5 }] });
		const status = server.status();
		expect(status.studios).toHaveLength(1);
		expect(status.studios[0]).toMatchObject({ id: "p1", mode: "edit", placeName: "Cecot", sync: { status: "connected", detail: "synced" } });
		const logs = await call<{ lines: { text: string; level: string }[] }>(port, "GET", "/tt/logs?source=studio");
		expect(logs.lines.map((l) => [l.level, l.text])).toEqual([["warn", "hello from Studio"]]);
	});

	test("rejects bad plugin bodies and unknown plugins", async () => {
		await expect(call(port, "POST", "/tt/plugin/hello", { id: "p2", mode: "nope", placeId: 1, gameId: 1 })).rejects.toThrow(ServeClientError);
		await expect(call(port, "POST", "/tt/plugin/state", { id: "unknown", status: "connected" })).rejects.toThrow("unknown plugin id");
		await expect(call(port, "POST", "/tt/plugin/state", { id: "p1", status: "weird" })).rejects.toThrow("unknown value");
	});

	test("restart and stop", async () => {
		expect(await call<{ ok: boolean }>(port, "POST", "/tt/restart", { child: "rojo" })).toEqual({ ok: true });
		await expect(call(port, "POST", "/tt/restart", { child: "nope" })).rejects.toThrow("no child named nope");
		await call(port, "POST", "/tt/stop");
		await Bun.sleep(100);
		expect(stopped).toBe(1);
	});
});

describe("agent commands", () => {
	const server = new ControlServer({
		hello,
		status: () => ({ hello: hello(), children: [], compile: { state: "idle", errors: [] } }),
		stop: () => {},
		restart: async () => false,
	});
	let port = 0;
	afterAll(() => server.close());
	const poll = (id: string, wait = 2) => call<{ commands: StudioCommand[] }>(port, "GET", `/tt/plugin/poll?id=${id}&wait=${wait}`);
	const register = (id: string, mode: string) => call(port, "POST", "/tt/plugin/hello", { id, mode, placeId: 2, gameId: 1, placeName: "Cecot" });

	test("with no Studio attached, says how to unstick the plugin", async () => {
		port = await server.listen([45890, 45891, 45892]);
		const error = (await call(port, "POST", "/tt/command", { kind: "reconnect" }).catch((e) => e)) as ServeClientError;
		expect(error).toBeInstanceOf(ServeClientError);
		expect(error.status).toBe(409);
		expect(error.message).toContain(RECONNECT_LUAU);
		await expect(call(port, "POST", "/tt/command", { kind: "format-disk" })).rejects.toThrow("kind: one of");
	});

	test("a command reaches the polling plugin and its result comes back", async () => {
		await register("edit1", "edit");
		const polled = poll("edit1");
		await Bun.sleep(50);
		const sent = call<CommandResult>(port, "POST", "/tt/command", { kind: "reconnect", args: { anyway: true } });
		const { commands } = await polled;
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({ kind: "reconnect", args: { anyway: true } });
		await call(port, "POST", "/tt/plugin/result", { id: "edit1", command: commands[0].id, ok: true, result: { phase: "connected" } });
		expect(await sent).toEqual({ ok: true, studio: { id: "edit1", mode: "edit", placeName: "Cecot" }, result: { phase: "connected" } });
	});

	test("a command sent before the poll waits for it; stop goes to the playtest server", async () => {
		await register("server1", "server");
		const sent = call<CommandResult>(port, "POST", "/tt/command", { kind: "stop" });
		await Bun.sleep(50);
		expect((await poll("edit1", 0)).commands).toEqual([]);
		const { commands } = await poll("server1", 0);
		expect(commands.map((c) => c.kind)).toEqual(["stop"]);
		await call(port, "POST", "/tt/plugin/result", { id: "server1", command: commands[0].id, ok: false, error: "no test" });
		expect(await sent).toMatchObject({ ok: false, studio: { mode: "server" }, error: "no test" });
	});

	test("a plugin can't answer someone else's command, and a silent plugin times out", async () => {
		const sent = call<CommandResult>(port, "POST", "/tt/command", { kind: "ping", target: "edit1", timeoutMs: 1000 });
		const { commands } = await poll("edit1", 0.5);
		expect(await call<unknown>(port, "POST", "/tt/plugin/result", { id: "server1", command: commands[0].id, ok: true })).toEqual({ ok: true, late: true });
		expect(await sent).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
	});

	test("commands aren't handed to a poll whose caller hung up", async () => {
		const gone = new AbortController();
		const hung = fetch(`http://127.0.0.1:${port}/tt/plugin/poll?id=edit1&wait=5`, { headers: { "x-typetorch": "1" }, signal: gone.signal }).catch(() => undefined);
		await Bun.sleep(50);
		gone.abort();
		await hung;
		await Bun.sleep(50);
		const sent = call<CommandResult>(port, "POST", "/tt/command", { kind: "ping", target: "edit", timeoutMs: 3000 });
		await Bun.sleep(50);
		const { commands } = await poll("edit1", 0);
		expect(commands.map((c) => c.kind)).toEqual(["ping"]);
		await call(port, "POST", "/tt/plugin/result", { id: "edit1", command: commands[0].id, ok: true, result: {} });
		expect((await sent).ok).toBe(true);
	});

	test("unknown targets and unregistered pollers are refused", async () => {
		await expect(call(port, "POST", "/tt/command", { kind: "ping", target: "nobody" })).rejects.toThrow("no attached Studio");
		await expect(poll("stranger", 0)).rejects.toThrow("unknown plugin id");
	});
});

describe("typetorch mcp", () => {
	const ask = (method: string, params?: Record<string, unknown>, root = process.cwd()) =>
		handleMessage({ jsonrpc: "2.0", id: 1, method, params }, root, "9.9.9") as Promise<{ result?: any; error?: any }>;

	test("initializes and lists the serve and studio tools", async () => {
		const init = await ask("initialize", { protocolVersion: "2025-06-18" });
		expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "typetorch", version: "9.9.9" } });
		const list = await ask("tools/list");
		expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
		expect(list.result.tools.every((t: Record<string, unknown>) => !("run" in t) && (t.inputSchema as { type: string }).type === "object")).toBe(true);
	});

	test("tool errors come back as isError results; unknown methods as JSON-RPC errors", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-mcp-"));
		try {
			const called = await ask("tools/call", { name: "studio_reconnect", arguments: {} }, dir);
			expect(called.result.isError).toBe(true);
			expect(called.result.content[0].text).toContain("isn't running");
			expect(JSON.parse((await ask("tools/call", { name: "serve_status" }, dir)).result.content[0].text)).toEqual({ running: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect((await ask("tools/call", { name: "nope" })).error.code).toBe(-32602);
		expect((await ask("resources/list")).error.code).toBe(-32601);
		expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined, "1")).toBeUndefined();
	});
});

describe("Supervisor", () => {
	test("restarts a child that exits, and stops it", async () => {
		const lines: string[] = [];
		const supervisor = new Supervisor((source, _stream, line) => lines.push(`${source}: ${line}`));
		supervisor.add({ name: "blip", command: [process.execPath, "-e", "console.log('up'); process.exit(3)"], cwd: process.cwd() });
		await Bun.sleep(1500);
		const [status] = supervisor.status();
		expect(status.restarts).toBeGreaterThanOrEqual(1);
		expect(lines.filter((l) => l === "blip: up").length).toBeGreaterThanOrEqual(2);
		expect(lines.some((l) => l.includes("restarting"))).toBe(true);
		await supervisor.stopAll();
		expect(supervisor.status()[0].state).toBe("stopped");
	});

	test("a child that won't start is reported, not thrown", () => {
		const lines: string[] = [];
		const supervisor = new Supervisor((source, _stream, line) => lines.push(`${source}: ${line}`));
		supervisor.add({ name: "ghost", command: ["definitely-not-a-real-binary-tt"], cwd: process.cwd(), restart: false });
		expect(supervisor.status()[0].state).toBe("exited");
		expect(lines[0]).toContain("could not start");
	});
});

const rojo = Bun.which("rojo") ?? process.env.TYPETORCH_ROJO;
describe.skipIf(!rojo)("the Studio plugin", () => {
	test("builds with Rojo (what `typetorch studio install-plugin` does)", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-plugin-"));
		try {
			const out = join(dir, "TypeTorchSync.rbxm");
			const project = resolve(import.meta.dir, "..", "studio-plugin", "default.project.json");
			const built = Bun.spawnSync([rojo!, "build", project, "-o", out], { stdout: "pipe", stderr: "pipe" });
			expect(built.exitCode).toBe(0);
			expect(statSync(out).size).toBeGreaterThan(10_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
