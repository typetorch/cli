/**
 * The child processes of `typetorch serve`: started in order, their output prefixed and kept in the log ring, restarted
 * with backoff when they exit unexpectedly, and stopped together. Children get the CLI's minimal environment
 * (env.ts `childEnv`): no API keys reach rbxtsc, Rojo or the game's scripts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { childEnv } from "../env.ts";
import { resolveCommand } from "../runtime.ts";
import type { ChildStatus } from "./protocol.ts";

export interface ChildSpec {
	name: string;
	command: string[];
	cwd: string;
	/** Extra environment for this child (never a secret). */
	env?: Record<string, string>;
	/** The whole environment instead of the minimal one (remote-claude needs the user's own: Claude's login, the key). */
	environment?: Record<string, string>;
	/** Restart when it exits (default true). */
	restart?: boolean;
}

export type LineSink = (source: string, stream: "stdout" | "stderr", line: string) => void;

const MAX_BACKOFF_MS = 10_000;
/** A child that ran this long is considered healthy again: its next crash restarts it at once. */
const HEALTHY_MS = 30_000;

class Child {
	status: ChildStatus;
	private process?: ChildProcess;
	private stopped = false;
	private backoff = 500;
	private timer?: ReturnType<typeof setTimeout>;
	private startedAt = 0;

	constructor(
		readonly spec: ChildSpec,
		private readonly sink: LineSink,
	) {
		this.status = { name: spec.name, command: spec.command, state: "starting", restarts: 0 };
	}

	private env(): Record<string, string> {
		return this.spec.environment ?? childEnv(this.spec.env);
	}

	start() {
		this.stopped = false;
		this.status.state = "starting";
		let resolved;
		try {
			resolved = resolveCommand(this.spec.command, this.env());
		} catch (error) {
			this.sink(this.spec.name, "stderr", `could not start: ${(error as Error).message}`);
			this.status.state = "exited";
			this.status.exitCode = 127;
			return;
		}
		const child = spawn(resolved.file, resolved.args, {
			cwd: this.spec.cwd,
			env: this.env(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: resolved.windowsVerbatimArguments,
		});
		this.process = child;
		this.startedAt = Date.now();
		this.status.pid = child.pid;
		this.status.state = "running";
		pipeLines(child.stdout, (line) => this.sink(this.spec.name, "stdout", line));
		pipeLines(child.stderr, (line) => this.sink(this.spec.name, "stderr", line));
		child.on("error", (error) => this.sink(this.spec.name, "stderr", `error: ${error.message}`));
		child.on("exit", (code, signal) => {
			this.process = undefined;
			this.status.pid = undefined;
			this.status.exitCode = code ?? (signal ? null : 1);
			if (this.stopped) {
				this.status.state = "stopped";
				return;
			}
			if (this.spec.restart === false) {
				this.status.state = "exited";
				this.sink(this.spec.name, "stderr", `exited (${code ?? signal})`);
				return;
			}
			if (Date.now() - this.startedAt > HEALTHY_MS) this.backoff = 500;
			this.status.state = "restarting";
			this.sink(this.spec.name, "stderr", `exited (${code ?? signal}); restarting in ${Math.round(this.backoff / 100) / 10} s`);
			this.timer = setTimeout(() => {
				this.status.restarts++;
				this.start();
			}, this.backoff);
			this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
		});
	}

	/** Stops the child (and its tree on Windows); resolves once it exited. */
	stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		const child = this.process;
		if (!child || child.exitCode !== null) {
			this.status.state = "stopped";
			return Promise.resolve();
		}
		return new Promise((done) => {
			const force = setTimeout(() => killTree(child, true), 5000);
			child.once("exit", () => {
				clearTimeout(force);
				done();
			});
			killTree(child, false);
		});
	}

	async restart() {
		await this.stop();
		this.backoff = 500;
		this.start();
	}
}

function killTree(child: ChildProcess, force: boolean) {
	if (process.platform === "win32" && child.pid) {
		// rbxtsc and bun run spawn grandchildren; taskkill /T takes the whole tree.
		spawn("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
		if (!force) return;
	}
	child.kill(force ? "SIGKILL" : "SIGTERM");
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void) {
	if (!stream) return;
	let rest = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		rest += chunk;
		const lines = rest.split(/\r?\n/);
		rest = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	});
	stream.on("end", () => {
		if (rest) onLine(rest);
		rest = "";
	});
}

export class Supervisor {
	private readonly children: Child[] = [];

	constructor(private readonly sink: LineSink) {}

	add(spec: ChildSpec) {
		const child = new Child(spec, this.sink);
		this.children.push(child);
		child.start();
	}

	status(): ChildStatus[] {
		return this.children.map((child) => ({ ...child.status }));
	}

	has(name: string): boolean {
		return this.children.some((child) => child.spec.name === name);
	}

	/** Restarts one child by name; false when there is none. */
	async restart(name: string): Promise<boolean> {
		const child = this.children.find((c) => c.spec.name === name);
		if (!child) return false;
		await child.restart();
		return true;
	}

	async stopAll() {
		await Promise.all(this.children.map((child) => child.stop()));
	}
}
