/**
 * The guided installer's terminal UI (`typetorch init`), on top of interact.ts and with no dependencies: a select
 * list driven by the arrow keys (or a number), a text question with a validator, a masked secret, a y/N, a step
 * header with one line on why the step exists and the doc it replaces, a checklist whose lines turn green in place,
 * and a note. Prompts go to stderr and answers come from stdin, like interact.ts, so `--json` is never mixed in.
 *
 * Nothing here reads stdin unless stdin, stdout and stderr are all terminals (`isInteractiveTerminal`). Agents, pipes
 * and tests use `scriptedTui`, which answers from a list (`--answers <file>` replays one). A secret is never taken
 * from a script: it comes from the environment or the game repo's .env, so a replay file can hold no key.
 */

import { bold, cyan, dim, green, red, yellow } from "./log.ts";
import { isInteractiveTerminal, NotInteractiveError, PromptCancelledError } from "./interact.ts";
import { progress } from "./progress.ts";

export interface SelectOption<T extends string = string> {
	value: T;
	label: string;
	/** One dim line under the label. */
	hint?: string;
}

export interface TextOptions {
	/** Shown dim and returned when the answer is empty. */
	default?: string;
	/** The reason the answer is refused, or undefined when it is fine. Asked again on a reason. */
	validate?: (answer: string) => string | undefined;
}

export interface Checklist {
	/** Marks an item done (green) or failed (red) with a short detail. */
	done(index: number, detail?: string): void;
	fail(index: number, detail?: string): void;
	/** Replaces an item's detail while it runs. */
	update(index: number, detail: string): void;
}

export interface Tui {
	/** A person can answer. */
	readonly interactive: boolean;
	/** A numbered step header: the title, one line on why, and the doc it replaces. */
	step(number: number, total: number, title: string, why: string, doc?: string): void;
	/** A plain line, indented under the step. */
	note(line: string): void;
	/** A warning line under the step. */
	warn(line: string): void;
	select<T extends string>(question: string, options: SelectOption<T>[], defaultValue?: T): Promise<T>;
	text(question: string, options?: TextOptions): Promise<string>;
	/** Masked input; never echoed, never logged, never written to a replay file. */
	secret(question: string, options?: Pick<TextOptions, "validate">): Promise<string>;
	confirm(question: string, defaultYes?: boolean): Promise<boolean>;
	/** Prints the items and returns handles that recolour them in place (a TTY) or print a line each (otherwise). */
	checklist(items: string[]): Checklist;
}

export const DOCS = "https://github.com/typetorch/docs/blob/main";

const INDENT = "  ";

function ask(line: string) {
	process.stderr.write(line);
}

/** Reads one raw key from the terminal: arrows, enter, Ctrl+C, a printable character. */
async function readKey(): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		const wasRaw = stdin.isRaw;
		stdin.setRawMode?.(true);
		stdin.resume();
		const onData = (data: Buffer) => {
			stdin.off("data", onData);
			stdin.setRawMode?.(wasRaw ?? false);
			stdin.pause();
			const key = data.toString("utf8");
			if (key === "\u0003") return reject(new PromptCancelledError());
			resolve(key);
		};
		stdin.on("data", onData);
	});
}

/** A masked line: characters echo as dots, backspace works, Enter ends, Ctrl+C cancels. */
async function readMasked(): Promise<string> {
	let value = "";
	for (;;) {
		const key = await readKey();
		if (key === "\r" || key === "\n") {
			ask("\n");
			return value;
		}
		if (key === "\u007f" || key === "\b") {
			if (value.length) {
				value = value.slice(0, -1);
				ask("\b \b");
			}
			continue;
		}
		if (key.length === 1 && key >= " ") {
			value += key;
			ask("*");
		} else if (key.length > 1 && !key.startsWith("\u001b")) {
			// A paste: several characters in one read; a newline inside it ends the input.
			const end = key.search(/[\r\n]/);
			const part = end === -1 ? key : key.slice(0, end);
			value += part;
			ask("*".repeat(part.length));
			if (end !== -1) {
				ask("\n");
				return value;
			}
		}
	}
}

async function readLine(question: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	try {
		return await rl.question(question);
	} catch (error) {
		// readline closes on Ctrl+C.
		if ((error as Error).name === "AbortError" || /closed/i.test(String((error as Error).message))) throw new PromptCancelledError();
		throw error;
	} finally {
		rl.close();
	}
}

export function terminalTui(): Tui {
	const interactive = isInteractiveTerminal();
	const need = (what: string) => {
		if (!interactive) throw new NotInteractiveError(`${what} needs a person at an interactive terminal (or --answers <file>)`);
	};
	const unicode = !process.env.NO_COLOR && process.platform !== "win32";
	const marks = { pointer: unicode ? "❯" : ">", done: unicode ? "✔" : "ok", fail: unicode ? "✖" : "x", todo: unicode ? "·" : "-" };
	return {
		interactive,
		step(number, total, title, why, doc) {
			ask(`\n${bold(`${number}/${total}  ${title}`)}\n${INDENT}${dim(why)}\n${doc ? `${INDENT}${dim(`replaces: ${doc}`)}\n` : ""}`);
		},
		note(line) {
			ask(`${INDENT}${line}\n`);
		},
		warn(line) {
			ask(`${INDENT}${yellow(line)}\n`);
		},
		async select(question, options, defaultValue) {
			need(question);
			return progress().suspend(async () => {
				let index = Math.max(0, options.findIndex((o) => o.value === defaultValue));
				const lines = () => options.map((o, i) => `${INDENT}${i === index ? cyan(marks.pointer) : " "} ${i === index ? bold(o.label) : o.label}${o.hint ? `\n${INDENT}    ${dim(o.hint)}` : ""}`).join("\n");
				const height = options.reduce((n, o) => n + (o.hint ? 2 : 1), 0);
				ask(`${INDENT}${question} ${dim("(arrows, Enter; or a number)")}\n${lines()}\n`);
				for (;;) {
					const key = await readKey();
					if (key === "\r" || key === "\n") {
						ask(`${INDENT}${dim("→")} ${options[index].label}\n`);
						return options[index].value;
					}
					if (key === "\u001b[A" || key === "k") index = (index + options.length - 1) % options.length;
					else if (key === "\u001b[B" || key === "j" || key === "\t") index = (index + 1) % options.length;
					else if (/^[1-9]$/.test(key) && Number(key) <= options.length) index = Number(key) - 1;
					else continue;
					ask(`\u001b[${height}A\u001b[0J${lines()}\n`);
				}
			});
		},
		async text(question, options = {}) {
			need(question);
			return progress().suspend(async () => {
				for (;;) {
					const raw = await readLine(`${INDENT}${question}${options.default !== undefined ? ` ${dim(`[${options.default}]`)}` : ""}: `);
					const answer = raw.trim() === "" && options.default !== undefined ? options.default : raw.trim();
					const problem = options.validate?.(answer);
					if (!problem) return answer;
					ask(`${INDENT}${red(problem)}\n`);
				}
			});
		},
		async secret(question, options = {}) {
			need(question);
			return progress().suspend(async () => {
				for (;;) {
					ask(`${INDENT}${question} ${dim("(typed characters are hidden)")}: `);
					const answer = (await readMasked()).trim();
					const problem = options.validate?.(answer);
					if (!problem) return answer;
					ask(`${INDENT}${red(problem)}\n`);
				}
			});
		},
		async confirm(question, defaultYes = false) {
			need(question);
			return progress().suspend(async () => {
				const raw = (await readLine(`${INDENT}${question} ${dim(defaultYes ? "[Y/n]" : "[y/N]")} `)).trim();
				if (raw === "") return defaultYes;
				return /^(y|yes)$/i.test(raw);
			});
		},
		checklist(items) {
			const tty = process.stderr.isTTY ?? false;
			const state = items.map((label) => ({ label, mark: marks.todo, colour: dim, detail: "" }));
			const line = (i: number) => `${INDENT}${state[i].colour(state[i].mark)} ${state[i].label}${state[i].detail ? dim(`  ${state[i].detail}`) : ""}`;
			ask(state.map((_, i) => line(i)).join("\n") + "\n");
			const redraw = (i: number) => {
				if (tty) ask(`\u001b[${items.length - i}A\u001b[2K${line(i)}\u001b[${items.length - i}B\r`);
				else ask(`${line(i)}\n`);
			};
			return {
				done(i, detail) {
					state[i] = { ...state[i], mark: marks.done, colour: green, detail: detail ?? state[i].detail };
					redraw(i);
				},
				fail(i, detail) {
					state[i] = { ...state[i], mark: marks.fail, colour: red, detail: detail ?? state[i].detail };
					redraw(i);
				},
				update(i, detail) {
					state[i] = { ...state[i], detail };
					redraw(i);
				},
			};
		},
	};
}

/** A line of a replay file: one answer per question, in order. A select takes a value or a label; a confirm y/n. */
export type ScriptedAnswer = string;

export interface ScriptedTui extends Tui {
	/** Every question asked, in order. */
	readonly asked: string[];
	/** Every line printed (steps, notes, checklist lines). */
	readonly output: string[];
}

/**
 * A Tui that answers from a list, for tests and `--answers`. A secret question is never answered from the list: it
 * throws, so the caller falls back to the environment or the game repo's .env.
 */
export function scriptedTui(answers: ScriptedAnswer[], options: { interactive?: boolean } = {}): ScriptedTui {
	const queue = [...answers];
	const asked: string[] = [];
	const output: string[] = [];
	const take = (question: string) => {
		asked.push(question);
		if (options.interactive === false) throw new NotInteractiveError(`${question}: no interactive terminal`);
		const next = queue.shift();
		if (next === undefined) throw new PromptCancelledError();
		return next;
	};
	return {
		interactive: options.interactive ?? true,
		asked,
		output,
		step: (number, total, title) => void output.push(`${number}/${total} ${title}`),
		note: (line) => void output.push(line),
		warn: (line) => void output.push(`warning: ${line}`),
		async select(question, choices, defaultValue) {
			const answer = take(question).trim();
			if (answer === "" && defaultValue !== undefined) return defaultValue;
			const found = choices.find((o) => o.value === answer || o.label === answer) ?? (/^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined);
			if (!found) throw new Error(`replay: "${answer}" is not an option of "${question}" (${choices.map((o) => o.value).join(", ")})`);
			output.push(`${question} -> ${found.value}`);
			return found.value;
		},
		async text(question, opts = {}) {
			const raw = take(question).trim();
			const answer = raw === "" && opts.default !== undefined ? opts.default : raw;
			const problem = opts.validate?.(answer);
			if (problem) throw new Error(`replay: "${answer}" for "${question}": ${problem}`);
			output.push(`${question} -> ${answer}`);
			return answer;
		},
		async secret(question) {
			asked.push(question);
			throw new NotInteractiveError(`${question}: a secret is never read from a replay file; put it in the environment or the game repo's .env`);
		},
		async confirm(question, defaultYes = false) {
			const raw = take(question).trim();
			const yes = raw === "" ? defaultYes : /^(y|yes|true)$/i.test(raw);
			output.push(`${question} -> ${yes ? "yes" : "no"}`);
			return yes;
		},
		checklist(items) {
			output.push(...items.map((label) => `- ${label}`));
			return {
				done: (i, detail) => void output.push(`ok ${items[i]}${detail ? ` (${detail})` : ""}`),
				fail: (i, detail) => void output.push(`fail ${items[i]}${detail ? ` (${detail})` : ""}`),
				update: () => {},
			};
		},
	};
}
