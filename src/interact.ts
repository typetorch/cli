/**
 * Questions on the user's own terminal: y/N confirmations, choices and passphrases (typed without echo). Approving a
 * deploy needs a person at an interactive terminal: when stdin or the terminal output isn't a TTY (agents, the
 * dev-server, CI, pipes), `interactive` is false and the commands that need a person refuse.
 * Prompts go to stderr, so `--json` output on stdout stays one document. Tests swap in a scripted Interaction.
 */

export interface Interaction {
	/** A person can answer: stdin and stderr are terminals. */
	interactive: boolean;
	/** y/N question; anything but y/yes is no. */
	confirm(question: string): Promise<boolean>;
	/** A line of text, echoed. */
	ask(question: string): Promise<string>;
	/** A secret, not echoed. */
	secret(question: string): Promise<string>;
}

export class NotInteractiveError extends Error {
	override name = "NotInteractiveError";
}

export class PromptCancelledError extends Error {
	override name = "PromptCancelledError";
	constructor() {
		super("cancelled");
	}
}

/** Reads one line from the terminal in raw mode; `hidden` echoes nothing. Ctrl+C cancels. */
function readLine(question: string, hidden: boolean): Promise<string> {
	const stdin = process.stdin;
	if (typeof stdin.setRawMode !== "function") {
		return Promise.reject(new NotInteractiveError("this terminal can't read keys without echo (no raw mode); run the command in PowerShell or Windows Terminal"));
	}
	process.stderr.write(question);
	return new Promise((resolve, reject) => {
		let value = "";
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		const finish = (error?: Error) => {
			stdin.removeListener("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: string) => {
			if (chunk.startsWith("\u001b")) return; // arrow keys and other escape sequences
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") return finish();
				if (ch === "\u0003") return finish(new PromptCancelledError()); // Ctrl+C
				if (ch === "\u0004") {
					if (value === "") return finish(new PromptCancelledError()); // Ctrl+D on an empty line
					continue;
				}
				if (ch === "\u007f" || ch === "\b") {
					if (value.length > 0) {
						value = Array.from(value).slice(0, -1).join("");
						if (!hidden) process.stderr.write("\b \b");
					}
					continue;
				}
				if (ch < " ") continue;
				value += ch;
				if (!hidden) process.stderr.write(ch);
			}
		};
		stdin.on("data", onData);
	});
}

export function terminalInteraction(): Interaction {
	// A person: stdin and stderr are terminals. (Raw mode, for the no-echo prompts, is checked when reading.)
	const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
	return {
		interactive,
		async confirm(question) {
			if (!interactive) throw new NotInteractiveError("no interactive terminal");
			return /^(y|yes)$/i.test((await readLine(`${question} [y/N] `, false)).trim());
		},
		async ask(question) {
			if (!interactive) throw new NotInteractiveError("no interactive terminal");
			return (await readLine(question, false)).trim();
		},
		async secret(question) {
			if (!interactive) throw new NotInteractiveError("no interactive terminal");
			return readLine(question, true);
		},
	};
}

/** A scripted Interaction for tests: answers are taken in order; `secrets` for secret(). */
export function scriptedInteraction(options: { interactive?: boolean; answers?: string[]; secrets?: string[] }): Interaction & { asked: string[] } {
	const answers = [...(options.answers ?? [])];
	const secrets = [...(options.secrets ?? [])];
	const asked: string[] = [];
	const take = (list: string[], question: string) => {
		asked.push(question);
		if (options.interactive === false) throw new NotInteractiveError("no interactive terminal");
		const next = list.shift();
		if (next === undefined) throw new PromptCancelledError();
		return next;
	};
	return {
		interactive: options.interactive ?? true,
		asked,
		async confirm(question) {
			return /^(y|yes)$/i.test(take(answers, question).trim());
		},
		async ask(question) {
			return take(answers, question).trim();
		},
		async secret(question) {
			return take(secrets, question);
		},
	};
}

let current: Interaction | undefined;

export function interaction(): Interaction {
	current ??= terminalInteraction();
	return current;
}

/** Replaces the interaction of this run (tests). */
export function useInteraction(next: Interaction | undefined) {
	current = next;
}
