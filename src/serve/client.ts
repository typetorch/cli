/**
 * How the CLI's subcommands (`serve status`, `serve stop`, `studio ...`) and the MCP server find and call the running
 * `typetorch serve` of a game repo: `.typetorch/serve.json` names its control port; the server's own /tt/hello must
 * confirm it is this repo's server before anything else is sent.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HEADER, type Hello } from "./protocol.ts";

export const SERVE_FILE = join(".typetorch", "serve.json");

export interface ServeFile {
	port: number;
	pid: number;
	rojoPort: number;
	startedAt: string;
	root: string;
	logFile?: string;
}

export function serveFilePath(root: string): string {
	return join(root, SERVE_FILE);
}

export function writeServeFile(root: string, data: ServeFile) {
	const path = serveFilePath(root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
}

export function readServeFile(root: string): ServeFile | undefined {
	const path = serveFilePath(root);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ServeFile;
		return typeof parsed.port === "number" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function removeServeFile(root: string, pid: number) {
	const current = readServeFile(root);
	if (current && current.pid !== pid) return; // another server took over
	rmSync(serveFilePath(root), { force: true });
}

export class ServeClientError extends Error {
	override name = "ServeClientError";
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

/** One call to the control API on `port`. */
export async function call<T>(port: number, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers: { [HEADER]: "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new ServeClientError(`typetorch serve on port ${port} did not answer (${(error as Error).message})`);
	}
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		throw new ServeClientError(`port ${port} answered something that isn't typetorch serve`);
	}
	if (!res.ok) {
		const message = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
		throw new ServeClientError(message, res.status);
	}
	return parsed as T;
}

/** The running server of the repo at `root`, or undefined (stale serve.json files are removed). */
export async function findRunning(root: string): Promise<{ file: ServeFile; hello: Hello } | undefined> {
	const file = readServeFile(root);
	if (!file) return undefined;
	try {
		const hello = await call<Hello>(file.port, "GET", "/tt/hello", undefined, 3000);
		if (hello.app === "typetorch-serve" && hello.pid === file.pid) return { file, hello };
	} catch {
		// not running
	}
	if (!pidAlive(file.pid)) rmSync(serveFilePath(root), { force: true });
	return undefined;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
