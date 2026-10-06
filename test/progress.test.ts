import { afterEach, describe, expect, test } from "bun:test";
import { commandLabel } from "../src/proc";
import { describeRequest } from "../src/opencloud";
import { info, setOutputMode, Stopwatch } from "../src/log";
import { PLAIN_AFTER_MS, Progress, progress, supportsUnicode, useProgress, type Timers } from "../src/progress";

afterEach(() => {
	useProgress(undefined);
	setOutputMode({ json: false, verbose: false });
});

function setup(options: { tty: boolean; silent?: boolean; unicode?: boolean; columns?: number }) {
	let clock = 0;
	const writes: string[] = [];
	let ticker: (() => void) | undefined;
	const timers: Timers = {
		setInterval: (fn) => ((ticker = fn), 1),
		clearInterval: () => void (ticker = undefined),
	};
	const stream = { isTTY: options.tty, columns: options.columns ?? 120, write: (chunk: string) => void writes.push(chunk) };
	const tracker = new Progress({ stream, tty: options.tty, silent: options.silent, unicode: options.unicode ?? true, color: false, now: () => clock, timers, processHooks: false });
	return {
		tracker,
		writes,
		advance(ms: number) {
			clock += ms;
			ticker?.();
		},
		running: () => ticker !== undefined,
	};
}

describe("TTY", () => {
	test("draws after 250 ms, names every job with its time, redraws in place, clears when idle", () => {
		const t = setup({ tty: true });
		const keyAsset = t.tracker.job("key asset");
		t.advance(100);
		expect(t.writes).toEqual([]); // quick jobs never flash
		const scope = t.tracker.job("scope messaging");
		t.advance(12_000);
		expect(t.writes[0]).toBe("\x1b[?25l"); // cursor hidden while drawing
		expect(t.writes[1]).toBe("\r\x1b[2K⠋ 12s  waiting on: key asset (12s), scope messaging (12s)");
		scope.done();
		t.advance(100);
		expect(t.writes.at(-1)).toBe("\r\x1b[2K⠙ 12s  waiting on: key asset (12s)");
		keyAsset.done();
		expect(t.writes.slice(-2)).toEqual(["\r\x1b[2K", "\x1b[?25h"]); // line cleared, cursor back
		expect(t.running()).toBe(false);
	});
	test("log lines clear the line first; the next frame redraws it", () => {
		const t = setup({ tty: true });
		t.tracker.job("upload asset");
		t.advance(300);
		const printed: string[] = [];
		t.tracker.print(() => printed.push(`${t.writes.length}`));
		expect(t.writes.at(-1)).toBe("\r\x1b[2K");
		t.tracker.print(() => {}); // nothing drawn now: no second clear
		expect(t.writes.filter((w) => w === "\r\x1b[2K")).toHaveLength(1);
		t.advance(100);
		expect(t.writes.at(-1)).toContain("upload asset");
	});
	test("slow jobs are yellow (with color); ASCII frames without unicode", () => {
		let clock = 0;
		const writes: string[] = [];
		let ticker: () => void = () => {};
		const tracker = new Progress({ stream: { isTTY: true, columns: 120, write: (c: string) => void writes.push(c) }, tty: true, unicode: false, color: true, now: () => clock, timers: { setInterval: (fn) => ((ticker = fn), 1), clearInterval: () => {} }, processHooks: false });
		tracker.job("moderation of asset 1");
		clock = 11_000;
		ticker();
		expect(writes.at(-1)).toBe("\r\x1b[2K| 11s  waiting on: \x1b[33mmoderation of asset 1 (11s)\x1b[39m");
	});
	test("fits the terminal width: drops labels from the end, then cuts", () => {
		const t = setup({ tty: true, columns: 60 });
		for (const label of ["first job with a long name", "second job", "third job"]) t.tracker.job(label);
		t.advance(1000);
		const line = t.writes.at(-1)!.replace("\r\x1b[2K", "");
		expect(line.length).toBeLessThanOrEqual(59);
		expect(line).toContain("first job with a long name (1s)");
		expect(line).toContain("more");
	});
	test("suspend (a prompt) clears the line and draws nothing until it returns", async () => {
		const t = setup({ tty: true });
		t.tracker.job("x");
		t.advance(300);
		let during = 0;
		await t.tracker.suspend(async () => {
			const before = t.writes.length;
			t.advance(500);
			during = t.writes.length - before;
		});
		expect(during).toBe(0);
		t.advance(100);
		expect(t.writes.at(-1)).toContain("waiting on: x");
	});
	test("withJob ends the job even when it throws; update renames", async () => {
		const t = setup({ tty: true });
		await expect(t.tracker.withJob("boom", async () => { throw new Error("x"); })).rejects.toThrow("x");
		expect(t.tracker.active()).toEqual([]);
		const job = t.tracker.job("Luau Execution task: creating");
		job.update("Luau Execution task: processing");
		t.advance(400);
		expect(t.writes.at(-1)).toContain("Luau Execution task: processing");
		job.done();
		job.done(); // idempotent
	});
});

describe("not a TTY", () => {
	test("no animation; one plain line once a job passes 15 s, then every 15 s", () => {
		const t = setup({ tty: false });
		const done = t.tracker.job("Luau Execution task: processing");
		t.tracker.job("quick one").done();
		t.advance(14_000);
		expect(t.writes).toEqual([]);
		t.advance(PLAIN_AFTER_MS - 14_000);
		expect(t.writes).toEqual(["still waiting on: Luau Execution task: processing (15s)\n"]);
		t.advance(5000);
		expect(t.writes).toHaveLength(1);
		t.advance(10_000);
		expect(t.writes[1]).toBe("still waiting on: Luau Execution task: processing (30s)\n");
		done.done();
		expect(t.writes.join("")).not.toContain("\x1b");
	});
});

describe("--json", () => {
	test("silent: no timer, nothing written", () => {
		const t = setup({ tty: true, silent: true });
		t.tracker.job("anything");
		t.advance(60_000);
		expect(t.running()).toBe(false);
		expect(t.writes).toEqual([]);
	});
	test("setOutputMode installs a silent tracker for --json", () => {
		setOutputMode({ json: true, verbose: false });
		const job = progress().job("x");
		expect(progress().line()).toBeUndefined(); // nothing old enough, and silent anyway
		job.done();
	});
});

describe("wiring", () => {
	test("log lines go through the tracker; stages are jobs", async () => {
		const t = setup({ tty: true });
		useProgress(t.tracker);
		t.tracker.job("build");
		t.advance(300);
		const log = console.log;
		console.log = () => {};
		try {
			info("hello");
		} finally {
			console.log = log;
		}
		expect(t.writes.at(-1)).toBe("\r\x1b[2K");
		const watch = new Stopwatch();
		let seen: string[] = [];
		await watch.stage("upload", async () => {
			seen = t.tracker.active().map((j) => j.label);
		});
		expect(seen).toContain("upload");
	});
	test("labels: commands and requests", () => {
		expect(commandLabel(["C:\\tools\\rojo.exe", "build", "default.project.json", "-o", "x"])).toBe("rojo build");
		expect(commandLabel(["bun", "run", "build"])).toBe("bun run build");
		expect(commandLabel(["lune", "run", "scripts/check.luau"])).toBe("lune run");
		expect(commandLabel(["rbxtsc", "-p", "x"])).toBe("rbxtsc");
		expect(describeRequest("POST", "/cloud/v2/universes/1:publishMessage")).toBe("publish message");
		expect(describeRequest("GET", "/cloud/v2/universes/1/memory-store/sorted-maps/TypeTorchServers/items?maxPageSize=100")).toBe("MemoryStore TypeTorchServers");
		expect(describeRequest("POST", "/cloud/v2/universes/1/places/2/versions/3/luau-execution-session-tasks")).toBe("create Luau Execution task");
		expect(describeRequest("GET", "/assets/v1/assets/123456?readMask=moderationResult")).toBe("asset 123456");
		expect(describeRequest("GET", "/assets/v1/assets/102504202680447/versions?maxPageSize=50")).toBe("place versions");
		expect(describeRequest("POST", "/assets/v1/assets")).toBe("upload asset");
		expect(describeRequest("DELETE", "/x/v1/things/123456")).toBe("DELETE /x/v1/things/…");
	});
	test("unicode detection: braille except on legacy Windows consoles", () => {
		expect(supportsUnicode({}, "linux")).toBe(true);
		expect(supportsUnicode({}, "win32")).toBe(false);
		expect(supportsUnicode({ WT_SESSION: "x" }, "win32")).toBe(true);
		expect(supportsUnicode({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
	});
});
