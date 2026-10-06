/**
 * The signed settings record (kernel 0.3.8, plans/20): ONE DataStore entry, `TypeTorch` / `settings`, that replaces
 * every ConfigService key TypeTorch used (`TypeTorch`, `TypeTorchFleet`, `TypeTorchAccess`, `TypeTorchAnalytics`).
 *
 *   { v: 1, seq, at, body, sig, sigF }
 *   body = JSON text: { defaultBranch?, channels?, access?, fleet?, analytics?, game? }
 *   sig / sigF = Ed25519 by the main and the fallback prod key over  tt1settings \n seq \n at \n body
 *
 * The body is signed as the exact text stored, so the kernel (Settings.luau) verifies the bytes it reads: no canonical
 * JSON on either side. Same keys, key files and signing code as prod deploys (signing.ts); only the version tag is new.
 *
 * Writes are read-modify-write guarded by the entry version (`updateEntry`, like durablehead.ts): verify the current
 * record with the local keys (sig with the main public key, or sigF with the fallback public key; `force` skips it),
 * change it, seq + 1, sign with both keys, write with matchVersion / exclusiveCreate, retried on conflicts. Then a ping
 * on TypeTorch/deploy, `{"k":"settings","s":seq}`, makes 0.3.8 servers read it within seconds (older kernels ignore a
 * message without a branch). Game code can write the DataStore but can't sign, so servers refuse anything else.
 * Server-only: the record holds tokens (fleet, analytics); nothing here prints them (`maskSecrets`).
 */
import { updateEntry, type KeyWrite } from "./durablehead.ts";
import type { OpenCloud } from "./opencloud.ts";
import { DEPLOY_TOPIC } from "./opencloud.ts";
import { SEQ_DATASTORE } from "./seqstore.ts";
import { signCanonical, verifyCanonical, type DualSigner } from "./signing.ts";

export const SETTINGS_KEY = "settings";
export const SETTINGS_CANONICAL_VERSION = "tt1settings";
/** Kernel Constants.SETTINGS_BODY_MAX / SETTINGS_GAME_MAX. */
export const SETTINGS_BODY_MAX = 32_768;
export const SETTINGS_GAME_MAX = 16_384;
export const SETTINGS_FIELDS = ["defaultBranch", "channels", "access", "fleet", "analytics", "game"] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];
/** A game key: what `TypeTorch.liveConfig(key)` reads. */
export const GAME_KEY_PATTERN = /^[A-Za-z0-9_.:/-]{1,64}$/;

export class SettingsError extends Error {
	override name = "SettingsError";
}

export interface AccessLists {
	members: Record<string, "owner" | "dev">;
	revoked: Record<string, true>;
	devBadgeId: number | null;
}

export interface SettingsBody {
	defaultBranch?: string;
	channels?: Record<string, "prod" | "dev">;
	access?: AccessLists;
	fleet?: { url: string; token: string };
	analytics?: Record<string, unknown>;
	game?: Record<string, unknown>;
}

export interface SettingsRecord {
	v: 1;
	seq: number;
	at: string;
	body: string;
	sig: string;
	sigF: string;
}

/** The signed string: tt1settings \n seq \n at \n body. Throws on a bad seq or an `at` with a newline. */
export function settingsCanonical(seq: number, at: string, body: string): string {
	if (!Number.isSafeInteger(seq) || seq < 1) throw new SettingsError(`seq must be a whole number >= 1, got ${seq}`);
	if (at.includes("\n")) throw new SettingsError("`at` can't hold a newline");
	return `${SETTINGS_CANONICAL_VERSION}\n${seq}\n${at}\n${body}`;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Keys sorted at every level, so the same settings always give the same text (stable diffs and hashes). */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	const object = plainObject(value);
	if (!object) return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(object).sort()) if (object[key] !== undefined) out[key] = sorted(object[key]);
	return out;
}

/** The body's JSON text (sorted keys, no spaces). */
export function encodeBody(body: SettingsBody): string {
	return JSON.stringify(sorted(body));
}

/** What is wrong with a body (the kernel's caps and shapes), or []. */
export function bodyProblems(body: SettingsBody): string[] {
	const problems: string[] = [];
	const text = encodeBody(body);
	if (Buffer.byteLength(text, "utf8") > SETTINGS_BODY_MAX) problems.push(`the settings are ${Buffer.byteLength(text, "utf8")} bytes of JSON, over ${SETTINGS_BODY_MAX}`);
	if (body.defaultBranch !== undefined && (typeof body.defaultBranch !== "string" || body.defaultBranch.length === 0 || body.defaultBranch.length > 64)) {
		problems.push("defaultBranch must be a branch name");
	}
	if (body.channels !== undefined) {
		for (const [branch, channel] of Object.entries(body.channels)) if (channel !== "prod" && channel !== "dev") problems.push(`channels.${branch} must be prod or dev`);
	}
	if (body.game !== undefined) {
		const size = Buffer.byteLength(JSON.stringify(body.game), "utf8");
		if (size > SETTINGS_GAME_MAX) problems.push(`game is ${size} bytes of JSON, over ${SETTINGS_GAME_MAX}`);
		for (const key of Object.keys(body.game)) if (!GAME_KEY_PATTERN.test(key)) problems.push(`game key "${key}" must be 1-64 characters of letters, digits and _ . : / -`);
	}
	return problems;
}

/** A record signed with both keys. */
export function signSettings(signer: DualSigner, seq: number, at: string, body: SettingsBody | string): SettingsRecord {
	const text = typeof body === "string" ? body : encodeBody(body);
	const canonical = settingsCanonical(seq, at, text);
	return { v: 1, seq, at, body: text, sig: signCanonical(signer.main, canonical), sigF: signCanonical(signer.fallback, canonical) };
}

/** A stored value as a record, or why it isn't one. */
export function parseRecord(value: unknown): { record?: SettingsRecord; body?: SettingsBody; problem?: string } {
	const raw = plainObject(value);
	if (!raw) return { problem: "not a settings record" };
	if (raw.v !== 1) return { problem: "not a v1 settings record" };
	if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) return { problem: "bad seq" };
	if (typeof raw.at !== "string" || raw.at.includes("\n")) return { problem: "bad at" };
	if (typeof raw.body !== "string") return { problem: "the body isn't JSON text" };
	let body: unknown;
	try {
		body = JSON.parse(raw.body);
	} catch {
		return { problem: "the body isn't valid JSON" };
	}
	if (!plainObject(body)) return { problem: "the body isn't a JSON object" };
	const record: SettingsRecord = { v: 1, seq: raw.seq, at: raw.at, body: raw.body, sig: typeof raw.sig === "string" ? raw.sig : "", sigF: typeof raw.sigF === "string" ? raw.sigF : "" };
	return { record, body: body as SettingsBody };
}

/** Which of the local keys signed it ("sig": the main key, "sigF": the fallback key), or undefined. */
export function verifySettingsRecord(record: SettingsRecord, keys: { main?: string; fallback?: string }): "sig" | "sigF" | undefined {
	let canonical: string;
	try {
		canonical = settingsCanonical(record.seq, record.at, record.body);
	} catch {
		return undefined;
	}
	if (keys.main && record.sig && verifyCanonical(keys.main, canonical, record.sig)) return "sig";
	if (keys.fallback && record.sigF && verifyCanonical(keys.fallback, canonical, record.sigF)) return "sigF";
	return undefined;
}

const SECRET_KEY = /token|secret|password|apikey|api_key|key$/i;

/** A copy with every token-like value replaced by a short note (never the value). */
export function maskSecrets(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) return value.map((item) => maskSecrets(item));
	const object = plainObject(value);
	if (object) {
		const out: Record<string, unknown> = {};
		for (const [name, inner] of Object.entries(object)) out[name] = maskSecrets(inner, name);
		return out;
	}
	if (typeof value === "string" && SECRET_KEY.test(key) && key !== "devBadgeId") return `<hidden, ${value.length} characters>`;
	return value;
}

/** One line per field for `settings status` and doctor (no values that could be secret). */
export function describeFields(body: SettingsBody): string[] {
	const lines: string[] = [];
	if (body.defaultBranch !== undefined) lines.push(`defaultBranch  ${body.defaultBranch}`);
	if (body.channels) lines.push(`channels       ${Object.entries(body.channels).map(([b, c]) => `${b}=${c}`).join(", ") || "(none)"}`);
	if (body.access) {
		const members = Object.keys(body.access.members ?? {}).length;
		const owners = Object.values(body.access.members ?? {}).filter((role) => role === "owner").length;
		const revoked = Object.keys(body.access.revoked ?? {}).length;
		lines.push(`access         ${members} member${members === 1 ? "" : "s"} (${owners} owner${owners === 1 ? "" : "s"}), ${revoked} revoked${body.access.devBadgeId ? `, dev badge ${body.access.devBadgeId}` : ""}`);
	}
	if (body.fleet) {
		let host = "?";
		try {
			host = new URL(body.fleet.url).host;
		} catch {}
		lines.push(`fleet          ${host} (token hidden)`);
	}
	if (body.analytics) {
		const backend = typeof body.analytics.backend === "string" ? body.analytics.backend : "?";
		let host = "";
		try {
			host = typeof body.analytics.events === "string" ? ` ${new URL(body.analytics.events).host}` : "";
		} catch {}
		lines.push(`analytics      ${backend}${host}${body.analytics.token !== undefined ? " (token hidden)" : ""}`);
	}
	if (body.game) {
		const keys = Object.keys(body.game);
		lines.push(`game           ${keys.length} key${keys.length === 1 ? "" : "s"}${keys.length ? `: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}` : ""} (${Buffer.byteLength(JSON.stringify(body.game), "utf8")} bytes)`);
	}
	return lines;
}

// Open Cloud ------------------------------------------------------------------------------------------------------------

type Requester = Pick<OpenCloud, "request">;

function entryPath(universeId: number, key: string): string {
	return `/datastores/v1/universes/${universeId}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(SEQ_DATASTORE)}&entryKey=${encodeURIComponent(key)}`;
}

export interface SettingsRead {
	missing: boolean;
	record?: SettingsRecord;
	body?: SettingsBody;
	/** The stored value isn't a usable record. */
	problem?: string;
	error?: string;
	scopeMissing?: boolean;
}

/** Reads the record (universe-datastores.objects:read). Never throws. */
export async function readSettings(oc: Requester, universeId: number): Promise<SettingsRead> {
	try {
		const read = await oc.request("GET", entryPath(universeId, SETTINGS_KEY), { label: `DataStore ${SEQ_DATASTORE}/${SETTINGS_KEY}` });
		if (read.status === 401 || read.status === 403) return { missing: false, scopeMissing: true, error: `${read.status} ${read.text.slice(0, 160)}` };
		if (read.status === 404 || read.status === 204) return { missing: true };
		if (!read.ok) return { missing: false, error: `read ${SETTINGS_KEY}: ${read.status} ${read.text.slice(0, 160)}` };
		let value: unknown = read.body;
		if (typeof value === "string") {
			try {
				value = JSON.parse(value);
			} catch {}
		}
		const parsed = parseRecord(value);
		return { missing: false, ...parsed };
	} catch (error) {
		return { missing: false, error: (error as Error).message };
	}
}

export interface SettingsWrite {
	outcome?: "written" | "unchanged";
	seq?: number;
	before?: SettingsBody;
	after?: SettingsBody;
	error?: string;
	scopeMissing?: boolean;
	/** The current record isn't signed by these keys (refused unless `force`). */
	untrusted?: boolean;
	/** `force` replaced an untrusted record: its fields, dropped (never re-signed). */
	dropped?: string[];
}

export interface WriteSettingsOptions {
	/**
	 * Overwrite a record these keys didn't sign (after losing both keys, or over game-written junk). Its fields are
	 * dropped, never re-signed (they could be anyone's): only the change is written, at a seq above the stored one.
	 */
	force?: boolean;
	/** Re-sign with a new seq even when nothing changed (`keys rotate`). */
	resign?: boolean;
	now?: () => Date;
}

/**
 * Read, verify, change (`mutate` gets a copy of the current body, {} when there is none, and returns the new one, or
 * undefined for "no change"), sign, write, retried on conflicts. Never throws (problems come back in `error`).
 */
export async function writeSettings(
	oc: Requester,
	universeId: number,
	signer: DualSigner,
	mutate: (body: SettingsBody) => SettingsBody | undefined,
	options: WriteSettingsOptions = {},
): Promise<SettingsWrite> {
	const result: SettingsWrite = {};
	let refusal: string | undefined;
	const write: KeyWrite = await updateEntry(oc, universeId, SETTINGS_KEY, (value) => {
		refusal = undefined;
		let current: SettingsBody = {};
		let seq = 0;
		if (value !== undefined) {
			const parsed = parseRecord(value);
			if (parsed.record && parsed.body) {
				const by = verifySettingsRecord(parsed.record, { main: signer.main.publicKey, fallback: signer.fallback.publicKey });
				if (!by && !options.force) {
					refusal = "the stored settings record isn't signed by your keys (neither sig with your main key nor sigF with your fallback key); if you lost both keys, or game code wrote it, run again with --force to replace it (its fields are dropped)";
					result.untrusted = true;
					return undefined;
				}
				if (by) current = parsed.body;
				else {
					result.untrusted = true;
					result.dropped = Object.keys(parsed.body).sort();
				}
				seq = parsed.record.seq;
			} else if (!options.force) {
				refusal = `the stored settings entry isn't a usable record (${parsed.problem}); run again with --force to replace it`;
				result.untrusted = true;
				return undefined;
			} else result.untrusted = true;
		}
		result.before = current;
		const next = mutate(JSON.parse(JSON.stringify(current)) as SettingsBody);
		if (next === undefined || (!options.resign && encodeBody(next) === encodeBody(current) && value !== undefined)) {
			result.after = current;
			result.seq = seq || undefined;
			return undefined;
		}
		const problems = bodyProblems(next);
		if (problems.length) {
			refusal = problems.join("; ");
			return undefined;
		}
		result.after = next;
		result.seq = seq + 1;
		return signSettings(signer, seq + 1, (options.now ?? (() => new Date()))().toISOString(), next);
	});
	if (refusal) return { ...result, error: refusal };
	if (write.scopeMissing) return { ...result, scopeMissing: true, error: write.error };
	if (write.error) return { ...result, error: write.error };
	return { ...result, outcome: write.outcome };
}

/** The ping 0.3.8 kernels re-read the record on (DEPLOY_TOPIC: every kernel subscribes it). */
export function settingsPing(seq: number): string {
	return JSON.stringify({ k: "settings", s: seq });
}

export async function pingSettings(oc: Pick<OpenCloud, "publishMessage">, universeId: number, seq: number): Promise<void> {
	await oc.publishMessage(universeId, DEPLOY_TOPIC, settingsPing(seq));
}
