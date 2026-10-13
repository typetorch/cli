/**
 * The update notice: AFTER a command finishes (never before, so it can't slow or block the command), at most once a
 * day, the CLI asks the npm registry for @typetorch/cli's `latest` (a short timeout; any failure is silent). When it is
 * newer than this CLI, a person at a terminal is asked once per new version whether to update now (`typetorch update`
 * with that version); a "no" turns later runs into a one-line reminder (once a day) until the next version comes out.
 *
 * Never in CI, non-interactive runs (agents, pipes, the dev-server), --json output, `typetorch update` itself, or with
 * TYPETORCH_UPDATE_CHECK=off. The answer is cached per user in ~/.typetorch/update-check.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions, latestVersion } from "./commands/update.ts";
import { bold, info, yellow } from "./log.ts";
import type { Interaction } from "./interact.ts";

/** Seconds between registry checks (and between reminders for a version that was declined). */
export const CHECK_EVERY_MS = 24 * 3_600_000;
/** How long the check may hold the exit. */
export const CHECK_TIMEOUT_MS = 1_500;

export interface UpdateCache {
	/** Unix ms of the last registry answer (or failure). */
	checkedAt?: number;
	latest?: string;
	/** The newest version the person said no to (asked again only for a newer one). */
	declined?: string;
	/** Unix ms of the last reminder for a declined version. */
	remindedAt?: number;
}

export function updateCachePath(home = homedir()): string {
	return join(home, ".typetorch", "update-check.json");
}

export function readUpdateCache(path: string): UpdateCache {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return raw && typeof raw === "object" ? (raw as UpdateCache) : {};
	} catch {
		return {};
	}
}

function writeUpdateCache(path: string, cache: UpdateCache) {
	try {
		if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cache));
	} catch {}
}

/** Why the check doesn't run here, or undefined when it does. */
export function updateCheckSkip(input: { command: string; interactive: boolean; json: boolean; env: Record<string, string | undefined> }): string | undefined {
	const { env } = input;
	if (input.command === "update") return "the update command itself";
	if (input.json) return "--json";
	if (!input.interactive) return "not an interactive terminal";
	if (env.CI && env.CI !== "false" && env.CI !== "0") return "CI";
	if (/^(off|0|false|no)$/i.test(env.TYPETORCH_UPDATE_CHECK ?? "")) return "TYPETORCH_UPDATE_CHECK=off";
	return undefined;
}

export type UpdateNotice =
	| { kind: "none" }
	/** A version this person wasn't asked about yet: ask. */
	| { kind: "ask"; latest: string }
	/** Declined before: a one-line reminder. */
	| { kind: "remind"; latest: string };

/** What to show for `current`, given the cache (already refreshed when it was due). Pure. */
export function decideNotice(current: string, cache: UpdateCache, now: number): UpdateNotice {
	const latest = cache.latest;
	if (!latest || current === "?" || compareVersions(current, latest) >= 0) return { kind: "none" };
	if (cache.declined && compareVersions(cache.declined, latest) >= 0) {
		return now - (cache.remindedAt ?? 0) >= CHECK_EVERY_MS ? { kind: "remind", latest } : { kind: "none" };
	}
	return { kind: "ask", latest };
}

export interface UpdateCheckDeps {
	current: string;
	interaction: Interaction;
	/** Runs `typetorch update <version> --yes`. */
	update: (version: string) => Promise<void>;
	fetchLatest?: () => Promise<string>;
	cachePath?: string;
	now?: number;
}

/** The post-command check. Never throws; returns what it showed (tests). */
export async function afterCommandUpdateCheck(deps: UpdateCheckDeps): Promise<UpdateNotice> {
	try {
		const now = deps.now ?? Date.now();
		const path = deps.cachePath ?? updateCachePath();
		const cache = readUpdateCache(path);
		if (now - (cache.checkedAt ?? 0) >= CHECK_EVERY_MS) {
			const fetchLatest = deps.fetchLatest ?? (() => latestVersion(fetch, CHECK_TIMEOUT_MS));
			try {
				cache.latest = await fetchLatest();
			} catch {}
			// A failed check waits a day too: an offline machine isn't slowed on every run.
			cache.checkedAt = now;
			writeUpdateCache(path, cache);
		}
		const notice = decideNotice(deps.current, cache, now);
		if (notice.kind === "none") return notice;
		if (notice.kind === "remind") {
			info(yellow(`typetorch ${notice.latest} is out (you have ${deps.current}): ${bold("typetorch update")}`));
			writeUpdateCache(path, { ...cache, remindedAt: now });
			return notice;
		}
		info("");
		info(yellow(`typetorch ${notice.latest} is out (you have ${deps.current}).`));
		if (await deps.interaction.confirm(`Update now?`)) {
			await deps.update(notice.latest);
		} else {
			info(`not updated; ${bold("typetorch update")} does it later`);
			writeUpdateCache(path, { ...cache, declined: notice.latest, remindedAt: now });
		}
		return notice;
	} catch {
		return { kind: "none" };
	}
}
