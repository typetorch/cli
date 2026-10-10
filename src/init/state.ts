/**
 * `.typetorch/init.json`: where `typetorch init` got to, so a run that stopped (Ctrl+C, a failed check, a closed
 * terminal) continues at the first unfinished phase. Holds phase names, times and plain answers (a project name, a
 * choice), never a secret: keys live in the game repo's .env and key files, and nothing in this file is ever a key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../json.ts";

export const INIT_STATE_FILE = join(".typetorch", "init.json");

export const PHASES = ["preflight", "project", "roblox", "keys", "kernel", "backend", "deploy", "agent"] as const;
export type PhaseName = (typeof PHASES)[number];

export type Answer = string | number | boolean;

export interface InitState {
	version: 1;
	/** Phases finished, with when. */
	done: Partial<Record<PhaseName, { at: string }>>;
	/** Plain answers worth keeping across a resume (a name, a choice, an id). Never a secret. */
	answers: Record<string, Answer>;
}

export function emptyState(): InitState {
	return { version: 1, done: {}, answers: {} };
}

const SECRET_LIKE = /key|token|secret|password/i;

export function readState(dir: string): InitState {
	const file = join(dir, INIT_STATE_FILE);
	if (!existsSync(file)) return emptyState();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.done) || !isRecord(raw.answers)) return emptyState();
		const done: InitState["done"] = {};
		for (const name of PHASES) {
			const entry = raw.done[name];
			if (isRecord(entry) && typeof entry.at === "string") done[name] = { at: entry.at };
		}
		const answers: Record<string, Answer> = {};
		for (const [key, value] of Object.entries(raw.answers)) {
			if (SECRET_LIKE.test(key)) continue;
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") answers[key] = value;
		}
		return { version: 1, done, answers };
	} catch {
		return emptyState();
	}
}

export function writeState(dir: string, state: InitState) {
	const file = join(dir, INIT_STATE_FILE);
	for (const key of Object.keys(state.answers)) {
		if (SECRET_LIKE.test(key)) throw new Error(`init state: "${key}" looks like a secret and is never stored`);
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state, null, "\t") + "\n");
}

export function markDone(state: InitState, phase: PhaseName, now: () => Date = () => new Date()) {
	state.done[phase] = { at: now().toISOString() };
}

export function isDone(state: InitState, phase: PhaseName): boolean {
	return state.done[phase] !== undefined;
}

/** The first phase not done, in order. */
export function nextPhase(state: InitState): PhaseName | undefined {
	return PHASES.find((name) => !isDone(state, name));
}
