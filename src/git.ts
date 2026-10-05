/** Git identity of the working tree: the same values `$git()` compiles in, plus the dirty flag it lacks. */
import { query } from "./proc.ts";

export interface GitInfo {
	/** First 7 hex digits of HEAD (same as `$git("Commit")`); "" before the first commit or outside a repo. */
	commit: string;
	/** Full hash; "" before the first commit. */
	commitHash: string;
	/** `git rev-parse --abbrev-ref HEAD` (CI ref name when detached); "" outside a repo. */
	gitBranch: string;
	detached: boolean;
	/** Uncommitted changes, ignoring the files TypeTorch itself writes. */
	dirty: boolean;
	dirtyFiles: string[];
	/** For deployment records: git user.name, else the CI actor, else the OS user. */
	userName: string;
	isRepo: boolean;
}

/** Paths from `git status --porcelain` lines (handles renames and quoted names). */
export function porcelainPaths(output: string): string[] {
	const paths: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		let path = line.slice(3);
		const arrow = path.indexOf(" -> ");
		if (arrow !== -1) path = path.slice(arrow + 4);
		if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, "$1");
		paths.push(path.replace(/\\/g, "/"));
	}
	return paths;
}

/** True when `path` (repo-relative, forward slashes) is one of TypeTorch's own outputs. */
export function isGeneratedPath(path: string, generated: string[]): boolean {
	return generated.some((g) => (g.endsWith("/") ? path === g.slice(0, -1) || path.startsWith(g) : path === g));
}

export function gitInfo(cwd: string, generated: string[] = []): GitInfo {
	const top = query(["git", "rev-parse", "--show-toplevel"], cwd);
	const userName =
		query(["git", "config", "user.name"], cwd) ||
		process.env.GITHUB_ACTOR ||
		process.env.USER ||
		process.env.USERNAME ||
		"unknown";
	if (top === undefined) {
		return { commit: "", commitHash: "", gitBranch: "", detached: false, dirty: true, dirtyFiles: [], userName, isRepo: false };
	}
	const commitHash = query(["git", "rev-parse", "HEAD"], cwd) ?? "";
	// The first 7 hex digits, exactly what `$git("Commit")` compiles in (rbxts-transform-debug: substring(0, 7));
	// `git rev-parse --short=7` can return more digits when 7 are ambiguous.
	const commit = commitHash.slice(0, 7);
	let gitBranch = query(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "";
	if (gitBranch === "" && commit === "") {
		// No commits yet: --abbrev-ref fails, but the symbolic ref still names the branch.
		gitBranch = query(["git", "symbolic-ref", "--short", "HEAD"], cwd) ?? "";
	}
	let detached = false;
	if (gitBranch === "HEAD") {
		detached = true;
		gitBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_REF_NAME || "";
	}
	// Paths from porcelain are relative to the repo top; `generated` is relative to the project root (cwd).
	const prefix = query(["git", "rev-parse", "--show-prefix"], cwd) ?? "";
	const status = query(["git", "status", "--porcelain", "--untracked-files=all"], cwd, false) ?? "";
	const dirtyFiles = porcelainPaths(status).filter(
		(path) => !isGeneratedPath(path, generated.map((g) => prefix + g)),
	);
	return {
		commit,
		commitHash,
		gitBranch,
		detached,
		dirty: commit === "" || dirtyFiles.length > 0,
		dirtyFiles,
		userName,
		isRepo: true,
	};
}
