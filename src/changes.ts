/**
 * "What changed" lines for an artifact (the dev menu shows them; they go into the payload asset's description after a
 * `---` line, see naming.ts `assetDescription` and plans/03):
 *   1. the deploy `--message`, if given;
 *   2. the game repo's commits since the branch's previous deploy, newest first ("template: <subject>");
 *   3. framework and kernel commits since the previous deploy's recorded sources ("framework: ...", "kernel: ...");
 *   4. nothing new at all: "rebuild, no source changes".
 * At most 5 per source and 8 in all (the largest group gives way first).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PACKAGES_MANIFEST } from "./build";
import { isRecord } from "./json";
import type { BuildSources } from "./naming";
import { query } from "./proc";

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

export function changeLines(input: ChangeInput): string[] {
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
