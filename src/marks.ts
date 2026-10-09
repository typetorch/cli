/**
 * Chart marks on the backend: the explorer's Performance page draws a vertical line for every release, kernel publish
 * and backup refresh (like Creator Hub's "published change"). The CLI tells the backend's fleet API, with the game key
 * (TYPETORCH_API_KEY), the way it posts alerts:
 *
 *   POST /v1/fleet/deploy  { j: "cli", s, b, a, ch, t, k, fr?, m? }       after deploy / rollback / promote / resign
 *                          (also the deploy's start time for the backend's stuck-server check)
 *   POST /v1/fleet/mark    { j: "cli", k: "kernel", v, pv?, m, t }       after kernel deploy / kernel restore
 *                          { j: "cli", k: "backup", b, s, a, pv?, m, t }  after a backup refresh (manual or automatic)
 *
 * `t` is unix ms. Best effort: a mark never fails or slows down the command it follows (5 s timeout, one dim line when
 * it didn't go through). No backend in typetorch.json or no game key: nothing is sent, silently. Never prints the key.
 */
import type { Project } from "./config.ts";
import { backendCredentials, backendUrl } from "./backend.ts";
import { dim, info, isJson } from "./log.ts";

export interface ReleaseMark {
	seq: number;
	branch: string;
	artifactId: string;
	channel?: string;
	action: "deploy" | "rollback" | "promote" | "resign";
	/** The build the branch ran before. */
	fromArtifactId?: string;
	/** The release note (-m). */
	note?: string;
	/** Unix ms (default now). */
	at?: number;
}

export interface OtherMark {
	kind: "kernel" | "backup";
	/** kernel: the kernel version. */
	kernel?: string;
	/** The place version the publish made. */
	placeVersion?: number | null;
	/** backup: the build that became the place's backup. */
	branch?: string;
	seq?: number;
	artifactId?: string;
	channel?: string;
	message?: string;
	at?: number;
}

export interface MarkPoster {
	release(mark: ReleaseMark): Promise<void>;
	mark(mark: OtherMark): Promise<void>;
}

const clip = (text: string | undefined, max: number) => (text === undefined ? undefined : text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** POST /v1/fleet/deploy's body. */
export function releaseBody(m: ReleaseMark, now = Date.now()): Record<string, unknown> {
	return {
		j: "cli",
		s: m.seq,
		b: m.branch,
		a: m.artifactId,
		...(m.channel ? { ch: m.channel } : {}),
		k: m.action,
		...(m.fromArtifactId ? { fr: m.fromArtifactId } : {}),
		...(m.note ? { m: clip(m.note, 200) } : {}),
		t: m.at ?? now,
	};
}

/** POST /v1/fleet/mark's body. */
export function markBody(m: OtherMark, now = Date.now()): Record<string, unknown> {
	return {
		j: "cli",
		k: m.kind,
		...(m.kernel ? { v: clip(m.kernel, 32) } : {}),
		...(typeof m.placeVersion === "number" ? { pv: m.placeVersion } : {}),
		...(m.branch ? { b: m.branch } : {}),
		...(m.seq !== undefined ? { s: m.seq } : {}),
		...(m.artifactId ? { a: m.artifactId } : {}),
		...(m.channel ? { ch: m.channel } : {}),
		...(m.message ? { m: clip(m.message, 200) } : {}),
		t: m.at ?? now,
	};
}

export class MarkError extends Error {
	override name = "MarkError";
}

/** The backend's mark routes over fetch (tests pass `fetch`). Throws MarkError; callers go through `announce`. */
export function httpMarkPoster(options: { url: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; now?: () => number }): MarkPoster {
	const base = options.url.replace(/\/+$/, "");
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const post = async (path: string, body: unknown) => {
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
			});
		} catch (error) {
			throw new MarkError(`the backend didn't answer (${(error as Error).message})`);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			let reason = text.slice(0, 120);
			try {
				reason = String((JSON.parse(text) as { error?: unknown }).error ?? reason);
			} catch {}
			throw new MarkError(response.status === 404 ? "the backend has no marks route yet (update it)" : `the backend answered ${response.status}${reason ? `: ${reason}` : ""}`);
		}
	};
	return {
		release: (m) => post("/v1/fleet/deploy", releaseBody(m, now())),
		mark: (m) => post("/v1/fleet/mark", markBody(m, now())),
	};
}

/** The project's mark poster: typetorch.json `backend.url` and the game key, else undefined (nothing is sent). */
export function markPosterFor(proj: Pick<Project, "config">): MarkPoster | undefined {
	const url = backendUrl(proj);
	if (!url) return undefined;
	const key = backendCredentials().key;
	if (!key) return undefined;
	return httpMarkPoster({ url, apiKey: key.value });
}

/**
 * Sends one mark, never throws: returns whether it went through. A failure is one dim line (not in --json runs: the
 * command's JSON stays the only output).
 */
export async function announce(poster: MarkPoster | null | undefined, what: string, send: (poster: MarkPoster) => Promise<void>): Promise<boolean> {
	if (!poster) return false;
	try {
		await send(poster);
		return true;
	} catch (error) {
		if (!isJson()) info(dim(`  mark        no chart mark for ${what}: ${(error as Error).message}`));
		return false;
	}
}
