/**
 * The state dir: where the deployment, upload and kernel-deploy logs live (security audit P-C1/S-L8: one seq source).
 * TYPETORCH_STATE_DIR (environment or env file; relative paths are against the project root), default
 * `<project root>/.typetorch`. The remote-claude dev-server points deploys it runs from its worktree at the main repo's
 * state dir, so both share one log and one seq.
 *
 * Build outputs (payload.rbxm, payload.json) stay in each checkout's own `.typetorch/`.
 *
 * Deploys hold `deploy.lock` in the state dir from choosing the seq until the deployment is logged, so two deploys
 * from one machine (the dev's terminal and remote-claude) never take the same seq.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expandPath, settings, type Settings } from "./env";
import { debug } from "./log";

export const STATE_DIR_VAR = "TYPETORCH_STATE_DIR";
export const LOCK_FILE = "deploy.lock";

export function stateDir(root: string, config: Settings = settings()): string {
	const configured = config.get(STATE_DIR_VAR)?.value;
	return configured ? expandPath(configured, root) : join(root, ".typetorch");
}

export class LockError extends Error {
	override name = "LockError";
}

/**
 * Runs `fn` while holding the state dir's deploy lock. Waits up to `waitMs` for another holder; a lock older than
 * `staleMs` (a crashed run) is taken over.
 */
export async function withStateLock<T>(
	dir: string,
	what: string,
	fn: () => Promise<T>,
	options: { waitMs?: number; staleMs?: number } = {},
): Promise<T> {
	const file = join(dir, LOCK_FILE);
	const waitMs = options.waitMs ?? 120_000;
	const staleMs = options.staleMs ?? 10 * 60_000;
	mkdirSync(dir, { recursive: true });
	const started = Date.now();
	while (true) {
		try {
			const fd = openSync(file, "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), what, at: new Date().toISOString() }));
			closeSync(fd);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let age = 0;
			let holder = "";
			try {
				age = Date.now() - statSync(file).mtimeMs;
				holder = readFileSync(file, "utf8");
			} catch {
				continue; // released meanwhile
			}
			if (age > staleMs) {
				debug(`taking over a stale ${file} (${Math.round(age / 1000)} s old): ${holder}`);
				rmSync(file, { force: true });
				continue;
			}
			if (Date.now() - started > waitMs) {
				throw new LockError(`another deploy holds ${file} (${holder.slice(0, 200)}); wait for it, or delete the file if that run is gone`);
			}
			await Bun.sleep(250);
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(file, { force: true });
	}
}
