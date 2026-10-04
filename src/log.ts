/**
 * Output helpers. Human output goes to stdout; with --json, stdout carries exactly one JSON document and every human
 * line goes to stderr instead, so `typetorch deploy --json | jq` works.
 */

let jsonMode = false;
let verboseMode = false;

export function setOutputMode(options: { json: boolean; verbose: boolean }) {
	jsonMode = options.json;
	verboseMode = options.verbose || process.env.TYPETORCH_DEBUG === "1";
}

export function isJson(): boolean {
	return jsonMode;
}

export function isVerbose(): boolean {
	return verboseMode;
}

const useColor = !process.env.NO_COLOR && (process.stderr.isTTY ?? false);
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const dim = paint(2);
export const bold = paint(1);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

/** A normal human line (stdout, or stderr in --json mode). */
export function info(line = "") {
	if (jsonMode) console.error(line);
	else console.log(line);
}

export function warn(line: string) {
	console.error(yellow(`warning: ${line}`));
}

export function debug(line: string) {
	if (verboseMode) console.error(dim(`[debug] ${line}`));
}

/** The one JSON document of a --json run. */
export function emitJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

export function seconds(ms: number): number {
	return Math.round(ms) / 1000;
}

export function formatSeconds(s: number): string {
	return `${s.toFixed(2)} s`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** "build 3.41 s, upload 1.36 s, total 5.78 s" */
export function formatTimings(timings: Record<string, number>): string {
	return Object.entries(timings)
		.map(([stage, s]) => `${stage} ${formatSeconds(s)}`)
		.join(", ");
}

/** Measures named stages. */
export class Stopwatch {
	readonly started = performance.now();
	readonly timings: Record<string, number> = {};

	async stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
		const at = performance.now();
		try {
			return await fn();
		} finally {
			this.timings[name] = seconds(performance.now() - at);
		}
	}

	set(name: string, s: number) {
		this.timings[name] = s;
	}

	total(): Record<string, number> {
		return { ...this.timings, total: seconds(performance.now() - this.started) };
	}
}

/** Left-aligned text table; the last column is not padded. */
export function table(header: string[], rows: string[][]): string {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => (i === cells.length - 1 ? cell : (cell ?? "").padEnd(widths[i])))
			.join("  ")
			.trimEnd();
	return [line(header), ...rows.map(line)].join("\n");
}
