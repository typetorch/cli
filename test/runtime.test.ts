/** runtime.ts: PATH lookup, Windows .cmd handling, child processes and zstd (the parts that differ between Bun and Node). */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureAsync,
	captureSync,
	ExecutableNotFoundError,
	hasZstd,
	isBun,
	npmShimTarget,
	resolveCommand,
	runtimeName,
	which,
	zstdCompress,
	zstdDecompress,
} from "../src/runtime";

const win = process.platform === "win32";
const dir = mkdtempSync(join(tmpdir(), "tt-runtime-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NPM_SHIM = (target: string) =>
	`@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

describe("runtime", () => {
	test("runtime name", () => {
		expect(isBun).toBe(true);
		expect(runtimeName()).toBe(`bun ${process.versions.bun}`);
	});

	test("which: PATH (and PATHEXT on Windows), never the current folder", () => {
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const file = join(bin, win ? "tt-tool.cmd" : "tt-tool");
		writeFileSync(file, win ? "@echo off\r\n" : "#!/bin/sh\n");
		if (!win) chmodSync(file, 0o755);
		if (win) writeFileSync(join(bin, "tt-tool"), "#!/bin/sh\n"); // a Git Bash script: not a Windows program
		expect(which("tt-tool", { PATH: bin, PATHEXT: ".EXE;.CMD" })?.toLowerCase()).toBe(file.toLowerCase());
		expect(which("tt-tool", { PATH: join(dir, "nowhere") })).toBeUndefined();
		expect(which(file)?.toLowerCase()).toBe(file.toLowerCase());
		expect(which("git")).toBeTruthy();
	});

	test("a missing executable throws at once (Bun.spawn's ENOENT); capture gives exit 127", async () => {
		expect(() => resolveCommand(["tt-no-such-binary-x"])).toThrow(ExecutableNotFoundError);
		expect((await captureAsync(["tt-no-such-binary-x"], { cwd: dir, env: {} })).exitCode).toBe(127);
		expect(captureSync(["tt-no-such-binary-x"], { cwd: dir, env: {} }).exitCode).toBe(127);
	});

	test("an env without PATH still finds git (this process's PATH)", async () => {
		const result = await captureAsync(["git", "--version"], { cwd: dir, env: {} as Record<string, string> });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toStartWith("git version");
	});

	test.if(win)("npm .cmd shims run their JS target with node: arguments pass unchanged, no cmd.exe", async () => {
		const shimDir = join(dir, "shim");
		mkdirSync(join(shimDir, "node_modules", "fake"), { recursive: true });
		const target = join(shimDir, "node_modules", "fake", "cli.js");
		writeFileSync(target, "console.log(JSON.stringify(process.argv.slice(2)));\n");
		writeFileSync(join(shimDir, "fake.cmd"), NPM_SHIM("node_modules\\fake\\cli.js"));
		expect(npmShimTarget(join(shimDir, "fake.cmd"))?.toLowerCase()).toBe(target.toLowerCase());
		const resolved = resolveCommand([join(shimDir, "fake.cmd"), "x"]);
		expect(resolved.args[0].toLowerCase()).toBe(target.toLowerCase());
		expect(resolved.windowsVerbatimArguments).toBeUndefined();
		const hostile = ["a b", "c&echo INJECTED", 'x"y', "%PATH%", "^caret", "trail\\", "(p)|<x>;"];
		const result = await captureAsync([join(shimDir, "fake.cmd"), ...hostile], { cwd: shimDir, env: { ...process.env } as Record<string, string> });
		expect(JSON.parse(result.stdout)).toEqual(hostile);
	});

	test.if(win)("other .cmd scripts run through cmd.exe, quoted and escaped; quotes and line breaks are refused", async () => {
		const file = join(dir, "plain.cmd");
		writeFileSync(file, "@echo off\r\necho ARGS %*\r\n");
		const args = ["a b", "c&echo INJECTED", "%PATH%", "^caret", "100%", "(p)|<x>;"];
		const resolved = resolveCommand([file, ...args]);
		expect(resolved.windowsVerbatimArguments).toBe(true);
		expect(resolved.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		const result = await captureAsync([file, ...args], { cwd: dir, env: { ...process.env } as Record<string, string> });
		expect(result.stdout.trim()).toBe(`ARGS ${args.map((a) => `"${a}"`).join(" ")}`);
		expect(() => resolveCommand([file, 'x"y'])).toThrow(/double quote/);
		expect(() => resolveCommand([file, "a\nb"])).toThrow(/line break/);
	});

	test("zstd round trip", () => {
		expect(hasZstd()).toBe(true);
		const data = new TextEncoder().encode("typetorch ".repeat(200));
		const packed = zstdCompress(data);
		expect(packed.length).toBeLessThan(data.length);
		expect(zstdDecompress(packed, data.length)).toEqual(data);
	});
});
