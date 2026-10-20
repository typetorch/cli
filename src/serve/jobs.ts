/**
 * Jobs `typetorch serve` runs for the Studio plugin's buttons, so nobody types a CLI command: hot asset checks, syncs
 * and a sync with a deploy to a dev branch. Each job is this CLI run again in the game repo with --json (same
 * runtime, entry point and env file), its stderr in serve's log, its JSON answer kept as the result. One at a time.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HttpError } from "./server.ts";

export const JOB_KINDS = ["assets-status", "assets-sync", "assets-deploy-dev"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Job {
	id: string;
	kind: JobKind;
	state: "running" | "done" | "failed";
	startedAt: string;
	endedAt?: string;
	/** The command's JSON answer (stdout). */
	result?: unknown;
	/** The last lines of its stderr (progress, errors). */
	tail: string[];
	error?: string;
}

const TAIL_LINES = 40;
const KEEP_JOBS = 20;

export interface JobRunnerOptions {
	root: string;
	/** The dev branch "assets-deploy-dev" deploys to (refused when it is a prod-channel branch). */
	devBranch: string;
	/** Whether a branch is prod-channel (typetorch.json). */
	isProd: (branch: string) => boolean;
	/** CLI arguments every job gets (e.g. --env-file). */
	baseArgs: string[];
	log: (level: "info" | "warn" | "error", text: string) => void;
	/** The command line for a job (tests). Default: this CLI's runtime and entry point. */
	command?: (args: string[]) => string[];
}

export function jobArgs(kind: JobKind, devBranch: string): string[] {
	switch (kind) {
		case "assets-status":
			return ["assets", "status", "--json"];
		case "assets-sync":
			return ["assets", "sync", "--json"];
		case "assets-deploy-dev":
			return ["assets", "sync", "--deploy", devBranch, "--proposed-by", "studio-plugin", "--json"];
	}
}

export class JobRunner {
	private readonly jobs: Job[] = [];

	constructor(private readonly options: JobRunnerOptions) {}

	get running(): Job | undefined {
		return this.jobs.find((job) => job.state === "running");
	}

	get(id: string): Job | undefined {
		return this.jobs.find((job) => job.id === id);
	}

	list(): Job[] {
		return [...this.jobs];
	}

	start(kind: JobKind): Job {
		const busy = this.running;
		if (busy) throw new HttpError(409, `a ${busy.kind} job is still running`);
		if (kind === "assets-deploy-dev" && this.options.isProd(this.options.devBranch)) {
			throw new HttpError(403, `${this.options.devBranch} is a prod-channel branch: deploy it from the CLI`);
		}
		const job: Job = { id: randomUUID(), kind, state: "running", startedAt: new Date().toISOString(), tail: [] };
		this.jobs.push(job);
		if (this.jobs.length > KEEP_JOBS) this.jobs.splice(0, this.jobs.length - KEEP_JOBS);
		const args = [...jobArgs(kind, this.options.devBranch), ...this.options.baseArgs];
		const [bin, ...rest] = (this.options.command ?? defaultCommand)(args);
		this.options.log("info", `${kind}: typetorch ${args.join(" ")}`);
		let stdout = "";
		let partial = "";
		const child = spawn(bin, rest, {
			cwd: this.options.root,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, NO_COLOR: "1", TYPETORCH_UPDATE_CHECK: "off" },
		});
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			partial += chunk;
			const lines = partial.split(/\r?\n/);
			partial = lines.pop() ?? "";
			for (const line of lines) this.line(job, line);
		});
		const finish = (code: number | null, error?: Error) => {
			if (job.state !== "running") return;
			if (partial) this.line(job, partial);
			job.endedAt = new Date().toISOString();
			try {
				job.result = stdout.trim() ? JSON.parse(stdout) : undefined;
			} catch {
				job.result = undefined;
			}
			if (error || code !== 0) {
				job.state = "failed";
				job.error = error?.message ?? job.tail.findLast((l) => l.startsWith("error:"))?.slice(7) ?? `exited with ${code}`;
				this.options.log("error", `${kind} failed: ${job.error}`);
			} else {
				job.state = "done";
				this.options.log("info", `${kind} done`);
			}
		};
		child.on("error", (error) => finish(null, error));
		child.on("close", (code) => finish(code));
		return job;
	}

	private line(job: Job, raw: string) {
		const text = raw.trimEnd();
		if (!text) return;
		job.tail.push(text);
		if (job.tail.length > TAIL_LINES) job.tail.splice(0, job.tail.length - TAIL_LINES);
		this.options.log(text.startsWith("error:") ? "error" : "info", text);
	}
}

function defaultCommand(args: string[]): string[] {
	return [process.execPath, ...process.execArgv, process.argv[1], ...args];
}
