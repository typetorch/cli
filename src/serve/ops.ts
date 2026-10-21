/**
 * What `typetorch serve <sub>`, `typetorch studio <sub>` and `typetorch mcp` do, as functions that return data (the
 * commands print it, the MCP server sends it as JSON). `root` is the game repo.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { sleep } from "../runtime.ts";
import { call, findRunning, ServeClientError } from "./client.ts";
import type { CommandKind, CommandResult, LogLine, ServeStatus } from "./protocol.ts";
import { COMMAND_TIMEOUT_MS } from "./server.ts";

export async function requireRunning(root: string) {
	const running = await findRunning(root);
	if (!running) throw new ServeClientError("typetorch serve isn't running in this repo: start it with `typetorch serve` (agents: `typetorch serve --detach`)");
	return running;
}

export type StatusResult = { running: false } | ({ running: true; port: number } & ServeStatus);

export async function serveStatus(root: string): Promise<StatusResult> {
	const running = await findRunning(root);
	if (!running) return { running: false };
	const status = await call<ServeStatus>(running.file.port, "GET", "/tt/status");
	return { running: true, port: running.file.port, ...status };
}

export interface StartResult {
	ok: true;
	alreadyRunning?: boolean;
	port: number;
	rojoPort: number;
	pid: number;
	log?: string;
}

/**
 * Starts `typetorch serve` in the background and waits until it answers. `argv`: this CLI's arguments for the
 * foreground server (`serve ...` without --detach), run in `cwd` with the same runtime and entry point as this process.
 */
export async function startDetached(root: string, argv: string[], cwd = root): Promise<StartResult> {
	const already = await findRunning(root);
	if (already) return { ok: true, alreadyRunning: true, port: already.file.port, rojoPort: already.file.rojoPort, pid: already.file.pid };
	const logFile = join(root, ".typetorch", "serve.log");
	mkdirSync(dirname(logFile), { recursive: true });
	const out = openSync(logFile, "a");
	const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...argv], {
		cwd,
		detached: true,
		stdio: ["ignore", out, out],
		windowsHide: true,
		env: { ...process.env, TYPETORCH_SERVE_LOG: logFile, NO_COLOR: "1", TYPETORCH_UPDATE_CHECK: "off" },
	});
	child.unref();
	closeSync(out);
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		const running = await findRunning(root);
		if (running) return { ok: true, port: running.file.port, rojoPort: running.file.rojoPort, pid: running.file.pid, log: logFile };
		if (child.exitCode !== null) break;
	}
	throw new Error(`typetorch serve did not start; see ${logFile}`);
}

export async function serveStop(root: string): Promise<{ ok: true; wasRunning: boolean }> {
	const running = await findRunning(root);
	if (!running) return { ok: true, wasRunning: false };
	await call(running.file.port, "POST", "/tt/stop");
	for (let i = 0; i < 50 && (await findRunning(root)); i++) await sleep(200);
	return { ok: true, wasRunning: true };
}

export async function serveRestart(root: string, child: string): Promise<{ ok: true }> {
	const running = await requireRunning(root);
	await call(running.file.port, "POST", "/tt/restart", { child });
	return { ok: true };
}

export interface LogsResult {
	last: number;
	lines: LogLine[];
}

/** `source`: "serve" (its children) or "studio" (Studio's Output). */
export async function serveLogs(root: string, source: "serve" | "studio", since = 0, limit = 200): Promise<LogsResult> {
	const running = await requireRunning(root);
	return call<LogsResult>(running.file.port, "GET", `/tt/logs?source=${source}&since=${since}&limit=${limit}`);
}

/** Runs a command in an attached Studio (protocol.ts COMMAND_KINDS) and returns the plugin's answer. */
export async function studioSend(
	root: string,
	kind: CommandKind,
	args: Record<string, unknown> = {},
	target?: string,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
	const running = await requireRunning(root);
	return call<CommandResult>(running.file.port, "POST", "/tt/command", { kind, args, target, timeoutMs }, timeoutMs + 5000);
}

/** `typetorch serve pair`: a new one-time pairing code for a remote Studio (serve must run with --remote). */
/** A one-time pairing code; `url` (the tunnel's address) is remembered, and with one the result has a shareable `link`. */
export async function servePairCode(root: string, url?: string): Promise<{ code: string; expiresAt: string; url?: string; link?: string }> {
	const running = await requireRunning(root);
	return call(running.file.port, "POST", "/tt/remote/code", url === undefined ? {} : { url });
}

export async function serveDevices(root: string): Promise<{ devices: { name: string; createdAt: string; expiresAt: string; lastSeen?: string }[] }> {
	const running = await requireRunning(root);
	return call(running.file.port, "GET", "/tt/remote/devices");
}

/** Revokes the paired devices called `name`, or all of them. */
export async function serveUnpair(root: string, name?: string): Promise<{ revoked: number }> {
	const running = await requireRunning(root);
	return call(running.file.port, "POST", "/tt/remote/revoke", name === undefined ? {} : { name });
}
