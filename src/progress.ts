/**
 * Long waits name what they wait on. A job tracker plus a renderer on stderr:
 *
 *   const done = progress().job("moderation of asset 123");   ...   done();
 *   await withJob("cloud test", () => runGate(...));
 *
 * - stderr is a TTY (and not --json): one line, redrawn about every 100 ms, once a job has run 250 ms:
 *     ⠹ 12s  waiting on: key asset (12s), scope messaging (4s)
 *   Jobs over 10 s are yellow. Braille frames, or `|/-\` on Windows consoles that may lack UTF-8 (no WT_SESSION,
 *   TERM_PROGRAM, ConEmu or xterm-like TERM). Log lines (log.ts) clear the line first and the next frame redraws it;
 *   prompts suspend it. The cursor is hidden while it draws and restored when idle, on exit and on Ctrl+C.
 * - not a TTY (CI, agents, pipes): no animation; a job running past 15 s prints one plain line every 15 s:
 *     still waiting on: Luau Execution task: PROCESSING (45s)
 * - --json: silent.
 * Several jobs can run at once (doctor's probes). Synchronous work blocks the timer; the line resumes after it.
 */

export interface ProgressStream {
	isTTY?: boolean;
	columns?: number;
	write(chunk: string): unknown;
}

export interface Timers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface ProgressOptions {
	stream?: ProgressStream;
	/** Animate (default: stream.isTTY). */
	tty?: boolean;
	/** --json: nothing at all. */
	silent?: boolean;
	unicode?: boolean;
	color?: boolean;
	now?: () => number;
	timers?: Timers;
	/** Hook process exit and SIGINT to restore the cursor (default true; tests pass false). */
	processHooks?: boolean;
}

export interface JobHandle {
	/** Ends the job (idempotent). */
	done(): void;
	/** Renames it ("Luau Execution task: PROCESSING"). */
	update(label: string): void;
}

interface Job {
	id: number;
	label: string;
	started: number;
}

export const FRAME_MS = 100;
/** A job shows once it has run this long (quick requests never flash). */
export const SHOW_AFTER_MS = 250;
export const SLOW_MS = 10_000;
/** Not a TTY: a job past this prints a "still waiting" line, then again every PLAIN_EVERY_MS. */
export const PLAIN_AFTER_MS = 15_000;
export const PLAIN_EVERY_MS = 15_000;

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII = ["|", "/", "-", "\\"];
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";

/** Whether the console likely renders braille (Windows' legacy console with a non-UTF-8 code page doesn't). */
export function supportsUnicode(env: Record<string, string | undefined> = process.env, platform = process.platform): boolean {
	if (platform !== "win32") return true;
	return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || /xterm|256color/i.test(env.TERM ?? ""));
}

function seconds(ms: number): string {
	return `${Math.floor(ms / 1000)}s`;
}

export class Progress {
	private readonly jobs = new Map<number, Job>();
	private nextId = 1;
	private timer: unknown;
	private frame = 0;
	private drawn = false;
	private cursorHidden = false;
	private suspended = 0;
	private lastPlain = new Map<number, number>();
	private readonly stream: ProgressStream;
	private readonly tty: boolean;
	private readonly silent: boolean;
	private readonly frames: string[];
	private readonly color: boolean;
	private readonly now: () => number;
	private readonly timers: Timers;
	private readonly hooks: boolean;
	private sigint?: () => void;

	constructor(options: ProgressOptions = {}) {
		this.stream = options.stream ?? process.stderr;
		this.tty = options.tty ?? Boolean(this.stream.isTTY);
		this.silent = options.silent ?? false;
		this.frames = (options.unicode ?? supportsUnicode()) ? BRAILLE : ASCII;
		this.color = options.color ?? (this.tty && !process.env.NO_COLOR);
		this.now = options.now ?? (() => performance.now());
		this.timers = options.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
		this.hooks = options.processHooks ?? true;
	}

	/** Starts a job; the handle ends or renames it. */
	job(label: string): JobHandle {
		const job: Job = { id: this.nextId++, label, started: this.now() };
		this.jobs.set(job.id, job);
		this.start();
		return {
			done: () => {
				if (!this.jobs.delete(job.id)) return;
				this.lastPlain.delete(job.id);
				if (this.jobs.size === 0) this.idle();
			},
			update: (next) => {
				job.label = next;
			},
		};
	}

	/** Runs `fn` as a job. */
	async withJob<T>(label: string, fn: (job: JobHandle) => Promise<T> | T): Promise<T> {
		const handle = this.job(label);
		try {
			return await fn(handle);
		} finally {
			handle.done();
		}
	}

	/** The jobs running now, oldest first. */
	active(): { label: string; ms: number }[] {
		const now = this.now();
		return [...this.jobs.values()].sort((a, b) => a.started - b.started).map((j) => ({ label: j.label, ms: now - j.started }));
	}

	/** The animated line for this moment (undefined: nothing to show yet). */
	line(): string | undefined {
		const visible = this.active().filter((j) => j.ms >= SHOW_AFTER_MS);
		if (visible.length === 0) return undefined;
		const total = visible[0].ms;
		const parts = visible.map((j) => {
			const text = `${j.label} (${seconds(j.ms)})`;
			return j.ms >= SLOW_MS && this.color ? `\x1b[33m${text}\x1b[39m` : text;
		});
		const head = `${this.frames[this.frame % this.frames.length]} ${seconds(total)}  waiting on: `;
		const width = Math.max(20, (this.stream.columns ?? 100) - 1);
		// Fit the width (a wrapped line can't be redrawn with \r): drop labels from the end, then cut.
		const plain = (list: string[]) => head.length + list.map((p) => p.replace(/\x1b\[\d+m/g, "")).join(", ").length;
		let shown = parts;
		let more = 0;
		while (shown.length > 1 && plain(shown) + (more ? ` +${more} more`.length : 0) > width) {
			shown = shown.slice(0, -1);
			more++;
		}
		let text = `${head}${shown.join(", ")}${more ? ` +${more} more` : ""}`;
		if (plain(shown) > width) text = `${head}${shown.join(", ").replace(/\x1b\[\d+m/g, "")}`.slice(0, width);
		return text;
	}

	/** Prints something (a log line): clears the animated line first; the next frame redraws it. */
	print(write: () => void) {
		this.clear();
		write();
	}

	/** Runs `fn` (a prompt) with the line cleared and not redrawn. */
	async suspend<T>(fn: () => Promise<T>): Promise<T> {
		this.suspended++;
		this.clear();
		this.restoreCursor();
		try {
			return await fn();
		} finally {
			this.suspended--;
		}
	}

	/** One timer tick: redraw (TTY) or the plain "still waiting" line. Public for tests. */
	tick() {
		if (this.silent || this.jobs.size === 0) return;
		if (this.tty) {
			if (this.suspended) return;
			const text = this.line();
			if (text === undefined) return;
			this.frame++;
			if (!this.cursorHidden) {
				this.stream.write(HIDE_CURSOR);
				this.cursorHidden = true;
				this.hookSigint();
			}
			this.stream.write(`${CLEAR_LINE}${text}`);
			this.drawn = true;
			return;
		}
		const now = this.now();
		const due = [...this.jobs.values()].filter((j) => now - j.started >= PLAIN_AFTER_MS && now - (this.lastPlain.get(j.id) ?? j.started) >= PLAIN_EVERY_MS);
		if (due.length === 0) return;
		for (const job of due) this.lastPlain.set(job.id, now);
		const slow = this.active().filter((j) => j.ms >= PLAIN_AFTER_MS);
		this.stream.write(`still waiting on: ${slow.map((j) => `${j.label} (${seconds(j.ms)})`).join(", ")}\n`);
	}

	/** Clears the line and restores the cursor (before an error message, at exit). */
	stop() {
		this.clear();
		this.restoreCursor();
	}

	private start() {
		if (this.silent || this.timer !== undefined) return;
		this.timer = this.timers.setInterval(() => this.tick(), this.tty ? FRAME_MS : 1000);
		(this.timer as { unref?: () => void })?.unref?.();
		if (this.hooks && !exitHooked) {
			exitHooked = true;
			process.once("exit", () => current?.stop());
		}
	}

	private idle() {
		if (this.timer !== undefined) this.timers.clearInterval(this.timer);
		this.timer = undefined;
		this.stop();
	}

	private clear() {
		if (!this.drawn) return;
		this.stream.write(CLEAR_LINE);
		this.drawn = false;
	}

	private restoreCursor() {
		if (!this.cursorHidden) return;
		this.stream.write(SHOW_CURSOR);
		this.cursorHidden = false;
		if (this.sigint) {
			process.removeListener("SIGINT", this.sigint);
			this.sigint = undefined;
		}
	}

	/** While the cursor is hidden, Ctrl+C restores it and exits 130 (a SIGINT listener replaces Node's default exit). */
	private hookSigint() {
		if (!this.hooks || this.sigint) return;
		this.sigint = () => {
			this.stop();
			process.exit(130);
		};
		process.once("SIGINT", this.sigint);
	}
}

let exitHooked = false;
let current: Progress | undefined;

/** The tracker of this run (stderr, TTY detection; configured by the entry point). */
export function progress(): Progress {
	current ??= new Progress();
	return current;
}

/** Replaces the tracker (the entry point after reading --json; tests). */
export function useProgress(next: Progress | undefined) {
	current?.stop();
	current = next;
}

/** Runs `fn` as a named job of this run's tracker. */
export function withJob<T>(label: string, fn: (job: JobHandle) => Promise<T> | T): Promise<T> {
	return progress().withJob(label, fn);
}
