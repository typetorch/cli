/**
 * "What changed" for an artifact. The dev menu shows it from the payload's `Notes` attribute (payloadNotes below,
 * stamped on the root Model at build time; plans/03 "Notes"):
 *   - message: the deploy `--message` (remote-claude passes Claude's summary), or "";
 *   - changes: the game repo's commits since the branch's previous deploy, newest first ("template: <subject>"), then
 *     framework and kernel commits since the previous deploy's recorded sources ("framework: ...", "kernel: ..."), or
 *     "first deploy of <branch>", or "rebuild, no source changes" when nothing is new.
 * At most 5 per source and 8 in all (the largest group gives way first).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord } from "./json.ts";
import { PACKAGES_MANIFEST, SOURCE_NAMES, type BuildSources } from "./naming.ts";
import { query } from "./proc.ts";

export const MAX_PER_SOURCE = 5;
export const MAX_CHANGE_LINES = 8;
const LINE_CHARS = 120;

/** One printable line: control characters become spaces, at most LINE_CHARS. */
export function cleanLine(text: string, max = LINE_CHARS): string {
	const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Commit subjects in `from..to` (newest first), or undefined when git can't tell (unknown commit, no repo). */
export function commitSubjects(repo: string, from: string, to = "HEAD", max = MAX_PER_SOURCE + 1): string[] | undefined {
	if (!/^[0-9a-f]{4,40}$/i.test(from) || !(to === "HEAD" || /^[0-9a-f]{4,40}$/i.test(to))) return undefined;
	const out = query(["git", "-c", "core.quotepath=off", "log", "--no-merges", `-n${max}`, "--format=%s", `${from}..${to}`], repo, false);
	if (out === undefined) return undefined;
	return out.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** `9a6547f*` -> { commit: "9a6547f", dirty: true }; `v0.2.0` -> undefined (an npm release has no commit). */
export function parseStamp(stamp: string | undefined): { commit: string; dirty: boolean } | undefined {
	const match = stamp ? /^([0-9a-f]{7,40})(\*)?$/.exec(stamp) : null;
	return match ? { commit: match[1], dirty: match[2] === "*" } : undefined;
}

/** Where the framework and kernel repos are: the packages manifest's `path`, else `<root>/../<name>`. */
export function packageRepos(root: string): Record<"framework" | "kernel", string | undefined> {
	let manifest: any;
	try {
		manifest = JSON.parse(readFileSync(join(root, PACKAGES_MANIFEST), "utf8"));
	} catch {}
	const repo = (name: "framework" | "kernel") => {
		const recorded = isRecord(manifest?.packages) && isRecord(manifest.packages[name]) ? manifest.packages[name].path : undefined;
		for (const candidate of [typeof recorded === "string" ? recorded : undefined, resolve(root, "..", name)]) {
			if (candidate && existsSync(join(candidate, ".git"))) return candidate;
		}
		return undefined;
	};
	return { framework: repo("framework"), kernel: repo("kernel") };
}

export interface ChangeInput {
	root: string;
	branch: string;
	message?: string;
	/** The game repo now. */
	git: { commitHash: string; commit: string; dirty: boolean };
	sources?: BuildSources;
	/** The branch's live head before this deploy (undefined: first deploy). */
	previous?: { commit?: string; commitHash?: string; sources?: Partial<BuildSources> };
	/** For tests: where the package repos are. */
	repos?: Partial<Record<"framework" | "kernel", string>>;
}

function limitGroups(groups: string[][], max: number): string[][] {
	const out = groups.map((group) => [...group]);
	while (out.reduce((n, g) => n + g.length, 0) > max) {
		const largest = out.reduce((best, g, i) => (g.length >= out[best].length ? i : best), 0); // ties: the later group gives way
		if (out[largest].length === 0) break;
		out[largest].pop();
	}
	return out;
}

/** The message line plus the change lines (proposal and dry-run output). */
export function changeLines(input: ChangeInput): string[] {
	const message = input.message ? cleanLine(input.message) : "";
	const changes = sourceChanges({ ...input, message: undefined });
	return message ? [message, ...changes.slice(0, MAX_CHANGE_LINES - 1)] : changes;
}

/** The change lines without the message (the Notes attribute's `changes`). */
export function sourceChanges(input: ChangeInput): string[] {
	const message = input.message ? cleanLine(input.message) : "";
	const template: string[] = [];
	const packages: Record<"framework" | "kernel", string[]> = { framework: [], kernel: [] };

	const previousCommit = input.previous?.commitHash || input.previous?.commit;
	if (!input.previous) template.push(`first deploy of ${cleanLine(input.branch, 64)}`);
	else if (previousCommit && input.git.commitHash) {
		const subjects = commitSubjects(input.root, previousCommit, input.git.commitHash);
		if (subjects === undefined) template.push(`commits since ${previousCommit.slice(0, 7)} unknown here`);
		else template.push(...subjects.map((s) => `template: ${cleanLine(s)}`));
	}
	if (input.git.dirty) template.push("template: uncommitted changes");

	const repos = { ...packageRepos(input.root), ...input.repos };
	for (const name of ["framework", "kernel"] as const) {
		const now = parseStamp(input.sources?.[name]);
		const before = parseStamp(input.previous?.sources?.[name]);
		const repo = repos[name];
		if (now && before && repo && !now.commit.startsWith(before.commit) && !before.commit.startsWith(now.commit)) {
			const subjects = commitSubjects(repo, before.commit, now.commit);
			if (subjects) packages[name].push(...subjects.map((s) => `${name}: ${cleanLine(s)}`));
		} else if (!now && input.sources?.[name] && input.sources[name] !== input.previous?.sources?.[name] && input.previous?.sources?.[name]) {
			packages[name].push(`${name}: ${input.previous.sources[name]} -> ${input.sources[name]}`);
		}
		if (now?.dirty) packages[name].push(`${name}: uncommitted changes`);
	}

	const capped = [template, packages.framework, packages.kernel].map((group) => group.slice(0, MAX_PER_SOURCE));
	const [t, f, k] = limitGroups(capped, MAX_CHANGE_LINES - (message ? 1 : 0));
	const lines = [...(message ? [message] : []), ...t, ...f, ...k];
	return lines.length > 0 ? lines : ["rebuild, no source changes"];
}

/** The payload root's `Notes` attribute (JSON). Keep this exact shape: the framework parses it. */
export interface PayloadNotes {
	v: 1;
	message: string;
	changes: string[];
	sources: Partial<BuildSources>;
	built: string;
	branch: string;
}

/** The Notes JSON stays under this many UTF-8 bytes (change lines are dropped first, then the message is cut). */
export const NOTES_MAX_BYTES = 4000;

/** The Notes attribute value: JSON, at most NOTES_MAX_BYTES, control characters removed. */
export function payloadNotes(input: { message?: string; changes: string[]; sources?: Partial<BuildSources>; built: string; branch: string }): string {
	const sources: Partial<BuildSources> = {};
	for (const name of SOURCE_NAMES) if (input.sources?.[name]) sources[name] = cleanLine(input.sources[name]!, 40);
	const notes: PayloadNotes = {
		v: 1,
		message: input.message ? cleanLine(input.message, 500) : "",
		changes: input.changes.map((line) => cleanLine(line)).filter(Boolean),
		sources,
		built: input.built,
		branch: cleanLine(input.branch, 64),
	};
	const size = () => new TextEncoder().encode(JSON.stringify(notes)).length;
	while (size() > NOTES_MAX_BYTES && notes.changes.length > 0) notes.changes.pop();
	while (size() > NOTES_MAX_BYTES && notes.message.length > 0) notes.message = notes.message.slice(0, Math.max(0, notes.message.length - 50));
	return JSON.stringify(notes);
}
