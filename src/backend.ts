/**
 * The TypeTorch backend (`@typetorch/backend`, plans/21): one server for fleet status, analytics, error logs, the owner
 * list and the explorer. Its address is typetorch.json `backend.url`; its two secrets live in the game repo's `.env`:
 *
 *   TYPETORCH_API_KEY      the GAME key, write-only. Game servers post heartbeats, events and errors with it (it sits in
 *                          the signed settings record, readable by every server script); the CLI posts alerts with it
 *                          (POST /v1/fleet/alert: auto_rollback, server_stuck).
 *   TYPETORCH_ADMIN_TOKEN  the admin token: reads (servers, reports, alerts) and the owner list (PUT /v1/access). It
 *                          never leaves this PC: refused in the settings record.
 *
 * CLI 0.8 names, read for one release with a warning: TYPETORCH_FLEET_TOKEN (the admin token), TYPETORCH_FLEET_INGEST_TOKEN
 * (the game key). CLI 0.8 also read TYPETORCH_API_KEY as the Roblox Open Cloud key, so a value that still looks like one
 * (the same as an Open Cloud key variable, or set next to a different TYPETORCH_FLEET_INGEST_TOKEN in an old layout) is
 * never used as the game key: it would be sent to the backend and signed into the record every game script can read.
 *
 * The owner list (plans/21 E): after every settings write the CLI sends the signed record's owners to the backend,
 * `PUT /v1/access { seq, owners }` with the admin token (only owners may Sign in with Roblox). A failed PUT is a warning,
 * never a failed settings write. `typetorch doctor` compares `GET /v1/access` with the signed record.
 *
 * Nothing here prints or returns a secret's value.
 */
import type { Project } from "./config.ts";
import { ADMIN_TOKEN_VAR, API_KEY_VARS, BACKEND_KEY_VAR, JOB_KEY_VARS, LEGACY_BACKEND_VARS, registerSecret, settings, type Settings } from "./env.ts";
import { fleetNetworkHint, shortBody } from "./httphints.ts";
import { warn } from "./log.ts";
import type { AccessLists, SettingsBody } from "./settings.ts";

export const OWNERS_MAX = 200;

export interface Credential {
	value: string;
	/** The variable it was read from (an old name when `legacy`). */
	name: string;
	/** "environment" or the env file path. */
	source: string;
	/** Read under a CLI 0.8 name. */
	legacy?: boolean;
}

export interface BackendCredentials {
	/** TYPETORCH_API_KEY: the game key (write-only). */
	key?: Credential;
	/** TYPETORCH_ADMIN_TOKEN: the admin token. */
	admin?: Credential;
	/** Old names in use and ignored values, one line each (names only). */
	notes: string[];
	/** Why TYPETORCH_API_KEY isn't used although it is set (it may still be a Roblox key). */
	refused?: string;
}

const legacyName = (target: string) => Object.keys(LEGACY_BACKEND_VARS).find((name) => LEGACY_BACKEND_VARS[name] === target)!;
const OLD_KEY = legacyName(BACKEND_KEY_VAR);
const OLD_ADMIN = legacyName(ADMIN_TOKEN_VAR);

/** The backend's two secrets from the environment and the game repo's .env (see the module comment). */
export function backendCredentials(config: Settings = settings()): BackendCredentials {
	const notes: string[] = [];
	const credential = (name: string, legacy = false): Credential | undefined => {
		const found = config.get(name);
		if (!found) return undefined;
		registerSecret(found.value);
		return { value: found.value, name, source: found.source, ...(legacy ? { legacy: true } : {}) };
	};
	const key = credential(BACKEND_KEY_VAR);
	const oldKey = credential(OLD_KEY, true);
	const admin = credential(ADMIN_TOKEN_VAR);
	const oldAdmin = credential(OLD_ADMIN, true);
	const result: BackendCredentials = { notes };

	// The admin token: the new name, else the old one.
	if (admin) {
		result.admin = admin;
		if (oldAdmin) notes.push(oldAdmin.value === admin.value ? `${OLD_ADMIN} is the old name of ${ADMIN_TOKEN_VAR}: delete it` : `${OLD_ADMIN} is ignored (${ADMIN_TOKEN_VAR} is set): delete it`);
	} else if (oldAdmin) {
		result.admin = oldAdmin;
		notes.push(`${OLD_ADMIN} is now ${ADMIN_TOKEN_VAR}: rename it in ${oldAdmin.source === "environment" ? "your environment" : oldAdmin.source} (read under the old name until the next release)`);
	}

	// The game key. TYPETORCH_API_KEY was the Roblox Open Cloud key until CLI 0.8: never use one that still looks like it.
	if (key) {
		const sameAsRoblox = [...API_KEY_VARS, ...Object.values(JOB_KEY_VARS)].find((name) => config.get(name)?.value === key.value);
		if (sameAsRoblox) {
			result.refused = `${BACKEND_KEY_VAR} has the same value as ${sameAsRoblox}: since CLI 0.9 ${BACKEND_KEY_VAR} is the TypeTorch backend's game key, never a Roblox key. Put the backend's key there (or delete ${BACKEND_KEY_VAR})`;
		} else if (oldKey && oldKey.value !== key.value && !admin) {
			// The CLI 0.8 layout: TYPETORCH_API_KEY = Open Cloud, TYPETORCH_FLEET_INGEST_TOKEN = the backend's write key.
			result.refused = `${BACKEND_KEY_VAR} and ${OLD_KEY} are both set, with different values: that is the CLI 0.8 layout, where ${BACKEND_KEY_VAR} was the Roblox Open Cloud key. Rename ${BACKEND_KEY_VAR} to OPENCLOUD_API_KEY and ${OLD_KEY} to ${BACKEND_KEY_VAR}`;
		} else if (!admin && !oldAdmin && !config.first([...API_KEY_VARS, ...Object.values(JOB_KEY_VARS)])) {
			result.refused = `${BACKEND_KEY_VAR} is set, but no Open Cloud key and no ${ADMIN_TOKEN_VAR} are: in CLI 0.8 ${BACKEND_KEY_VAR} was the Roblox Open Cloud key. If it is one, rename it to OPENCLOUD_API_KEY; if it is the backend's game key, set ${ADMIN_TOKEN_VAR} next to it`;
		} else {
			result.key = key;
			if (oldKey) notes.push(oldKey.value === key.value ? `${OLD_KEY} is the old name of ${BACKEND_KEY_VAR}: delete it` : `${OLD_KEY} is ignored (${BACKEND_KEY_VAR} is set): delete it`);
		}
	}
	if (!result.key && oldKey) {
		result.key = oldKey;
		notes.push(`${OLD_KEY} is now ${BACKEND_KEY_VAR} (the backend's game key): rename it in ${oldKey.source === "environment" ? "your environment" : oldKey.source} (read under the old name until the next release)`);
	}
	if (result.key && result.admin && result.key.value === result.admin.value) {
		notes.push(`${result.key.name} and ${result.admin.name} hold the same value: they must differ (the game key sits in every game server, the admin token must not)`);
	}
	return result;
}

const warned = new Set<string>();

/** backendCredentials, printing each note (and a refusal) once per run. */
export function backendCredentialsWarned(config: Settings = settings()): BackendCredentials {
	const creds = backendCredentials(config);
	for (const line of [...creds.notes, ...(creds.refused ? [creds.refused] : [])]) {
		if (warned.has(line)) continue;
		warned.add(line);
		warn(line);
	}
	return creds;
}

/** typetorch.json `backend.url` (CLI 0.8: `fleet.url`, mapped by config.ts). */
export function backendUrl(proj: Pick<Project, "config">): string | undefined {
	return proj.config.backend?.url;
}

// Owners and the access list ------------------------------------------------------------------------------------------

/** The owners in a signed access list (UserIds, sorted), as the backend stores them. */
export function ownersOf(access: AccessLists | undefined): number[] {
	const ids = Object.entries(access?.members ?? {})
		.filter(([, role]) => role === "owner")
		.map(([id]) => Number(id))
		.filter((id) => Number.isSafeInteger(id) && id > 0);
	return [...new Set(ids)].sort((a, b) => a - b);
}

export class BackendError extends Error {
	override name = "BackendError";
	constructor(
		message: string,
		readonly status = 0,
		readonly body?: Record<string, unknown>,
	) {
		super(message);
	}
}

export interface BackendRequestOptions {
	url: string;
	adminToken: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

async function adminRequest(options: BackendRequestOptions, method: "GET" | "PUT", path: string, body?: unknown): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
	const base = options.url.replace(/\/+$/, "");
	const host = new URL(base).host;
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(`${base}${path}`, {
			method,
			headers: { accept: "application/json", authorization: `Bearer ${options.adminToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			// A redirect would carry the admin token to wherever it points.
			redirect: "manual",
			signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		});
	} catch (error) {
		throw new BackendError(fleetNetworkHint(error as Error, host) ?? `the backend at ${host} didn't answer: ${(error as Error).message}`);
	}
	const text = (await response.text()).slice(0, 4000);
	let json: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
	} catch {}
	if (response.status >= 300 && response.status < 400) throw new BackendError(`the backend at ${host} redirects (${response.status}): use the final address in typetorch.json backend.url`, response.status);
	if (response.status === 401 || response.status === 403) throw new BackendError(`the backend refused the admin token (${response.status}): ${ADMIN_TOKEN_VAR} must be the backend's admin token`, response.status, json);
	return { status: response.status, json, text };
}

export interface AccessListCopy {
	seq: number | null;
	owners: number[];
	updatedAt: string | null;
}

/** GET /v1/access (admin): the backend's copy of the owner list. */
export async function getAccessList(options: BackendRequestOptions): Promise<AccessListCopy> {
	const reply = await adminRequest(options, "GET", "/v1/access");
	if (reply.status !== 200 || !reply.json) throw new BackendError(`GET /v1/access answered ${reply.status} ${shortBody(reply.text)}`, reply.status, reply.json);
	const { seq, owners, updatedAt } = reply.json;
	return {
		seq: typeof seq === "number" ? seq : null,
		owners: Array.isArray(owners) ? owners.filter((o): o is number => typeof o === "number").sort((a, b) => a - b) : [],
		updatedAt: typeof updatedAt === "string" ? updatedAt : null,
	};
}

export type OwnerSync =
	| { state: "updated" | "same"; seq: number; owners: number; sessionsEnded: number }
	| { state: "conflict"; seq: number; backendSeq: number | null; message: string }
	| { state: "failed"; seq: number; message: string }
	| { state: "skipped"; reason: string };

/**
 * PUT /v1/access { seq, owners } with the admin token. 200 = stored (or the same seq and list again), 409 = the backend
 * holds a newer seq (or this seq with another list), 400 = a bad body. Never throws: the outcome is returned.
 */
export async function putAccessList(options: BackendRequestOptions & { seq: number; owners: number[] }): Promise<OwnerSync> {
	const { seq } = options;
	if (!Number.isSafeInteger(seq) || seq < 0) return { state: "failed", seq, message: `seq ${seq} isn't a whole number >= 0` };
	if (options.owners.length > OWNERS_MAX) return { state: "failed", seq, message: `${options.owners.length} owners; the backend keeps at most ${OWNERS_MAX}` };
	try {
		const reply = await adminRequest(options, "PUT", "/v1/access", { seq, owners: options.owners });
		if (reply.status === 200 && reply.json) {
			const ended = typeof reply.json.sessionsEnded === "number" ? reply.json.sessionsEnded : 0;
			return { state: reply.json.changed === false ? "same" : "updated", seq, owners: options.owners.length, sessionsEnded: ended };
		}
		const error = shortBody(reply.text);
		if (reply.status === 409) {
			const backendSeq = typeof reply.json?.seq === "number" ? reply.json.seq : null;
			return { state: "conflict", seq, backendSeq, message: error };
		}
		return { state: "failed", seq, message: `PUT /v1/access answered ${reply.status}: ${error}` };
	} catch (error) {
		return { state: "failed", seq, message: (error as Error).message };
	}
}

/**
 * After a settings write: the signed record's owners to the backend (PUT /v1/access), so Sign in with Roblox lets
 * exactly them in. `url`: typetorch.json backend.url, else the record's backend.url. Skipped (with the reason) when
 * there is no backend or no admin token. Never throws.
 */
export async function syncOwnerList(input: { proj: Pick<Project, "config">; seq: number | undefined; body: SettingsBody | undefined; fetch?: typeof fetch; config?: Settings }): Promise<OwnerSync> {
	const url = backendUrl(input.proj) ?? input.body?.backend?.url;
	if (!url) return { state: "skipped", reason: "no backend (typetorch.json backend.url)" };
	if (input.seq === undefined) return { state: "skipped", reason: "no settings record" };
	const admin = backendCredentialsWarned(input.config).admin;
	if (!admin) return { state: "skipped", reason: `no ${ADMIN_TOKEN_VAR} in the environment or the game repo's .env` };
	return putAccessList({ url, adminToken: admin.value, seq: input.seq, owners: ownersOf(input.body?.access), fetch: input.fetch });
}

/** One line about an owner-list sync (for reportChange and access push), or undefined when there is nothing to say. */
export function describeOwnerSync(sync: OwnerSync): { level: "info" | "warn"; text: string } | undefined {
	switch (sync.state) {
		case "updated":
			return { level: "info", text: `backend owner list: ${sync.owners} owner${sync.owners === 1 ? "" : "s"} at settings #${sync.seq}${sync.sessionsEnded ? ` (${sync.sessionsEnded} explorer session${sync.sessionsEnded === 1 ? "" : "s"} ended)` : ""}` };
		case "same":
			return { level: "info", text: `backend owner list: already at settings #${sync.seq}` };
		case "conflict":
			return { level: "warn", text: `the backend refused the owner list for settings #${sync.seq} (${sync.message}${sync.backendSeq !== null ? `; it holds #${sync.backendSeq}` : ""}): another machine wrote newer settings, or the backend's copy is ahead; run \`typetorch access push\` again after the next settings write` };
		case "failed":
			return { level: "warn", text: `the backend's owner list wasn't updated (${sync.message}); the settings record is written. Run \`typetorch access push\` once the backend answers` };
		case "skipped":
			return sync.reason.startsWith("no backend") ? undefined : { level: "info", text: `backend owner list not sent: ${sync.reason}` };
	}
}
