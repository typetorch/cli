/** `typetorch serve`: the compile tracker, the control API's request rules and plugin registry, the supervisor. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginProject } from "../src/commands/serve";
import { CompileTracker } from "../src/serve/compile";
import { call, ServeClientError } from "../src/serve/client";
import type { Hello } from "../src/serve/protocol";
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

describe("studio install-plugin", () => {
	test("finds the plugin package in the game repo, or a --from checkout", () => {
		const game = mkdtempSync(join(tmpdir(), "tt-game-"));
		try {
			expect(() => pluginProject(undefined, game)).toThrow("bun add -d @typetorch/studio-plugin");
			const pkg = join(game, "node_modules", "@typetorch", "studio-plugin");
			mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "default.project.json"), "{}");
			expect(pluginProject(undefined, game)).toBe(join(pkg, "default.project.json"));
			expect(pluginProject(pkg, undefined)).toBe(join(pkg, "default.project.json"));
			expect(() => pluginProject(join(game, "nope"), game)).toThrow("has no default.project.json");
		} finally {
			rmSync(game, { recursive: true, force: true });
		}
	});
});
