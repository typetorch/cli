/**
 * Follows `rbxtsc -w` output and keeps the current compile state for `typetorch serve status` and the plugin, so an
 * agent reads "2 errors in src/server/boot.ts" instead of scraping a terminal. The watch output is TypeScript's:
 *   [7:25:40 PM] File change detected. Starting incremental compilation...
 *   src/server/boot.ts:6:7 - error TS2322: Type 'string' is not assignable to type 'number'.
 *   [7:25:42 PM] Found 2 errors. Watching for file changes.
 */
import type { CompileError } from "./protocol.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const STARTED = /Starting (?:incremental )?compilation/i;
const FINISHED = /Found (\d+) errors?\b/i;
const ERROR = /^(.+?):(\d+):(\d+) - error(?: (TS\d+))?:?\s*(.*)$/;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

export class CompileTracker {
	state: "idle" | "compiling" | "ok" | "errors" = "idle";
	errors: CompileError[] = [];
	at?: string;
	private pending: CompileError[] = [];

	constructor(private readonly onChange?: () => void) {}

	/** Feeds one line of rbxtsc output. */
	line(raw: string) {
		const line = stripAnsi(raw).trimEnd();
		if (STARTED.test(line)) {
			this.pending = [];
			this.state = "compiling";
			this.onChange?.();
			return;
		}
		const error = ERROR.exec(line);
		if (error) {
			this.pending.push({
				file: error[1].replace(/\\/g, "/"),
				line: Number(error[2]),
				column: Number(error[3]),
				code: error[4],
				message: error[5].trim(),
			});
			return;
		}
		const finished = FINISHED.exec(line);
		if (finished) {
			this.errors = this.pending;
			this.pending = [];
			this.state = Number(finished[1]) === 0 ? "ok" : "errors";
			this.at = new Date().toISOString();
			this.onChange?.();
		}
	}

	snapshot() {
		return { state: this.state, errors: this.errors.map((e) => ({ ...e })), at: this.at };
	}
}
