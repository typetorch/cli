/**
 * Questions on the user's own terminal: y/N confirmations and choices. Approving a
 * deploy needs a person at an interactive terminal: unless stdin, stdout AND stderr are all TTYs (agents, the
 * dev-server, CI, pipes, background shells, `< /dev/null`), `interactive` is false, nothing ever reads stdin, and the
 * commands that need a person refuse or write a proposal instead.
 * Prompts go to stderr, so `--json` output on stdout stays one document. Tests swap in a scripted Interaction.
 */

export interface Interaction {
	/** A person can answer: stdin, stdout and stderr are terminals. */
	interactive: boolean;
	/** y/N question; anything but y/yes is no. */
	confirm(question: string): Promise<boolean>;
	/** A line of text, echoed. */
	ask(question: string): Promise<string>;
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

/** Reads one echoed line from the terminal (node:readline; works in PowerShell, cmd and Unix terminals). */
async function readLine(question: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

/** True only when stdin, stdout and stderr are all TTYs. */
export function isInteractiveTerminal(streams: { stdin?: { isTTY?: boolean }; stdout?: { isTTY?: boolean }; stderr?: { isTTY?: boolean } } = process): boolean {
	return Boolean(streams.stdin?.isTTY && streams.stdout?.isTTY && streams.stderr?.isTTY);
}

export function terminalInteraction(): Interaction {
	// A person: stdin, stdout and stderr are all terminals (prompts go to stderr; answers come from stdin).
	const interactive = isInteractiveTerminal();
	return {
		interactive,
		async confirm(question) {
			if (!interactive) throw new NotInteractiveError("no interactive terminal");
			return /^(y|yes)$/i.test((await readLine(`${question} [y/N] `)).trim());
		},
		async ask(question) {
			if (!interactive) throw new NotInteractiveError("no interactive terminal");
			return (await readLine(question)).trim();
		},
	};
}

/** A scripted Interaction for tests: answers are taken in order. */
export function scriptedInteraction(options: { interactive?: boolean; answers?: string[] }): Interaction & { asked: string[] } {
	const answers = [...(options.answers ?? [])];
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
