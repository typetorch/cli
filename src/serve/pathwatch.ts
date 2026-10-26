/**
 * Rojo never recovers a `$path` folder that is deleted and recreated under it (`git clean` of out/ by a deploy or upload
 * from the same checkout, an `rm -rf out`): its tree for that folder stays empty while the folder on disk fills up
 * again, and the plugin syncs the empty tree into Studio (CuceGame, 2026-10-26: a Play booted a payload without
 * Server.boot). PathWatch polls the identity (device, inode, birth time) of every directory `$path` in serve's project
 * file and reports the ones that changed once they exist again and have been quiet for `settleMs`; serve then restarts
 * Rojo.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { projectPaths } from "../build.ts";

export interface PathWatchOptions {
	root: string;
	/** `$path` values relative to `root` (files are ignored: Rojo follows a replaced file). */
	paths: string[];
	/** Called with the recreated paths; serve restarts Rojo. The new identities become the baseline. */
	onRecreated: (paths: string[]) => void;
	/** How long a changed path must stay unchanged (and exist) before onRecreated (default 3 s). */
	settleMs?: number;
	intervalMs?: number;
	now?: () => number;
}

/**
 * A directory's identity, or undefined when the path is missing or not a directory. The birth time is part of it: ext4
 * may hand a folder recreated right after the delete the same inode number.
 */
function identity(path: string): string | undefined {
	try {
		const st = statSync(path);
		return st.isDirectory() ? `${st.dev}:${st.ino}:${st.birthtimeMs}` : undefined;
	} catch {
		return undefined;
	}
}

/** The distinct `$path` values of a Rojo project (parsed JSON), in order. */
export function watchedPaths(projectJson: unknown): string[] {
	return [...new Set(projectPaths(projectJson))];
}

export class PathWatch {
	private readonly baseline = new Map<string, string | undefined>();
	private readonly seen = new Map<string, string | undefined>();
	private readonly pending = new Set<string>();
	private lastChange = 0;
	private timer?: ReturnType<typeof setInterval>;
	/** The last restart this watch asked for. */
	last?: { at: string; paths: string[] };

	constructor(private readonly options: PathWatchOptions) {
		for (const path of options.paths) {
			const id = identity(join(options.root, path));
			this.baseline.set(path, id);
			this.seen.set(path, id);
		}
	}

	private get now() {
		return (this.options.now ?? Date.now)();
	}

	/** One poll. Returns the paths reported this time (empty when nothing settled). */
	tick(): string[] {
		const now = this.now;
		for (const path of this.options.paths) {
			const id = identity(join(this.options.root, path));
			if (id !== this.seen.get(path)) {
				this.seen.set(path, id);
				this.lastChange = now;
			}
			if (id !== this.baseline.get(path)) this.pending.add(path);
			else this.pending.delete(path);
		}
		if (this.pending.size === 0) return [];
		// A folder that is still missing can't be served yet; wait for it (and for the burst of changes to end).
		if (this.missing().length > 0 || now - this.lastChange < (this.options.settleMs ?? 3000)) return [];
		const paths = [...this.pending];
		for (const path of paths) this.baseline.set(path, this.seen.get(path));
		this.pending.clear();
		this.last = { at: new Date(now).toISOString(), paths };
		this.options.onRecreated(paths);
		return paths;
	}

	/** Changed paths that are missing right now (deleted, not yet recreated). */
	missing(): string[] {
		return [...this.pending].filter((path) => this.seen.get(path) === undefined);
	}

	/** Forget pending changes and take the current identities as the baseline (Rojo was restarted by hand). */
	rebase() {
		for (const path of this.options.paths) {
			const id = identity(join(this.options.root, path));
			this.baseline.set(path, id);
			this.seen.set(path, id);
		}
		this.pending.clear();
	}

	start() {
		this.timer ??= setInterval(() => this.tick(), this.options.intervalMs ?? 2000);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
