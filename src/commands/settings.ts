/**
 * `typetorch settings`: the signed settings record (kernel 0.3.8, plans/20; settings.ts). Every write reads the record,
 * checks it was signed by your keys, changes one part, signs it with both prod keys, writes it back (guarded by the
 * entry version) and pings servers so they read it within seconds. Nothing here prints a token.
 */
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import { accessValue } from "../access.ts";
import type { Project } from "../config.ts";
import { checkAnalyticsEndpoint, enforceEndpoints, reportsJson, type EndpointReport } from "../endpoints.ts";
import { bold, dim, emitJson, info, isJson, warn } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import {
	describeFields,
	encodeBody,
	GAME_KEY_PATTERN,
	maskSecrets,
	pingSettings,
	readSettings,
	verifySettingsRecord,
	writeSettings,
	type SettingsBody,
	type SettingsWrite,
} from "../settings.ts";
import { keyFingerprint, type DualSigner } from "../signing.ts";
import { DS_READ_SCOPE, DS_WRITE_SCOPES } from "../seqstore.ts";
import { KEY_FILE_FLAGS, loadSignerOrExplain, openCloud, project, signingKeyPaths } from "./common.ts";

export const settingsFlags = { "dry-run": "boolean", force: "boolean", "no-ping": "boolean", ...KEY_FILE_FLAGS } as const;

export const SETTINGS_USAGE = `typetorch settings status
typetorch settings get [field | game.<key>]
typetorch settings set game.<key> <json | ->       (- reads the JSON from stdin)
typetorch settings set analytics <json | ->        (the analytics sink; use - so tokens never sit in a command line)
                                                   (checked first: URL, GET /healthz, the token; refused when broken)
typetorch settings unset game.<key> | analytics | fleet
typetorch settings push                            (defaultBranch, channels and dev access from typetorch.json)
  [--dry-run] [--force] [--no-ping] [--key-file <path>] [--fallback-key-file <path>]

  Kernel 0.3.8 reads ONE settings record from the game's DataStore (TypeTorch / settings), signed with both prod keys:
  defaultBranch, channels, access (members, revoked, devBadgeId), fleet, analytics, and game (your own live values,
  read with TypeTorch.liveConfig; at most 16 KB). It replaces every ConfigService key. Servers refuse a record that
  doesn't verify, so game code (which can write DataStores) can't change it.
  status  seq, age, whether it verifies with your keys, the fields (tokens hidden)
  get     one field as JSON (tokens hidden), or all of them
  set     change one field: read, check it was signed by your keys, change, sign (seq + 1), write, ping servers
  push    defaultBranch, channels and access from typetorch.json (access push writes access alone)
  --force     replace a record your keys didn't sign (lost both keys, or game code wrote junk); its fields are
              dropped, never re-signed, so write them again afterwards. For \`set analytics\` it also writes a
              value whose checks failed (the failures print as warnings)
  Before \`set analytics\` signs anything it checks the endpoint like \`typetorch doctor\` does: the URL parses, is
  https and (DuckDB) ends in /v1/ingest; GET <server>/healthz answers within 5 s; the token is accepted by
  GET /v1/auth/check as a write-only ingest token (never the admin token). A failure prints what is wrong and how to
  fix it, writes nothing and exits 1. Basin streams: the URLs must answer; the token can't be verified.
  --no-ping   don't ping servers (they still read it within about a minute)
  Needs both signing keys (\`typetorch keys init\`, \`typetorch keys init --fallback\`) and the deploy key's
  ${DS_READ_SCOPE} and ${DS_WRITE_SCOPES}, plus messaging for the ping. Fleet: \`typetorch fleet setup\`.`;

/** Loads both keys, or explains that the settings need them. */
export function settingsSigner(proj: Project, args: ParsedArgs): DualSigner {
	return loadSignerOrExplain(proj, signingKeyPaths(proj, args), "the settings record is signed with both prod keys");
}

export interface ChangeSettingsInput {
	proj: Project;
	oc: Pick<OpenCloud, "request" | "publishMessage">;
	signer: DualSigner;
	mutate: (body: SettingsBody) => SettingsBody | undefined;
	what: string;
	/**
	 * The sections whose endpoint the caller checked (endpoints.ts: URL, /healthz, token) or deliberately forced past.
	 * A change to `fleet` or `analytics` that isn't listed here is refused before anything is signed, so no new write
	 * path can push a URL or token nobody tested.
	 */
	checked?: readonly ("fleet" | "analytics")[];
	force?: boolean;
	/** Re-sign with a new seq even when nothing changed (keys rotate / resign). */
	resign?: boolean;
	noPing?: boolean;
	now?: () => Date;
}

export interface ChangeSettingsResult extends SettingsWrite {
	pinged?: boolean;
	pingError?: string;
}

/** One settings change, end to end (write + ping). Throws on refusals and failed writes with what to do. */
export async function changeSettings(input: ChangeSettingsInput): Promise<ChangeSettingsResult> {
	const { proj } = input;
	const checked = new Set(input.checked ?? []);
	let unchecked: string | undefined;
	const mutate = (body: SettingsBody): SettingsBody | undefined => {
		const before = { fleet: encodeBody({ fleet: body.fleet }), analytics: encodeBody({ analytics: body.analytics }) };
		const next = input.mutate(body);
		if (next === undefined) return undefined;
		for (const field of ["fleet", "analytics"] as const) {
			if (!checked.has(field) && encodeBody({ [field]: next[field] }) !== before[field]) unchecked = field;
		}
		return unchecked ? undefined : next;
	};
	const write = await writeSettings(input.oc, proj.config.universeId, input.signer, mutate, { force: input.force, resign: input.resign, now: input.now });
	if (unchecked) throw new Error(`${input.what}: internal error: this change writes settings.${unchecked} without checking its endpoint first (endpoints.ts); nothing was written`);
	if (write.scopeMissing) throw new Error(`can't write the settings record: the deploy key needs ${DS_READ_SCOPE} and ${DS_WRITE_SCOPES} (${write.error})`);
	if (write.error) throw new Error(`${input.what}: ${write.error}`);
	const result: ChangeSettingsResult = { ...write };
	if (write.outcome === "written" && write.seq !== undefined && !input.noPing) {
		try {
			await pingSettings(input.oc, proj.config.universeId, write.seq);
			result.pinged = true;
		} catch (error) {
			// Servers still read it on their own within about a minute.
			result.pingError = (error as Error).message;
		}
	}
	return result;
}

/** One line about a change (and the ping), or the "already there" note. */
export function reportChange(result: ChangeSettingsResult, what: string) {
	if (result.outcome === "unchanged") {
		info(`${what}: already set (settings #${result.seq ?? "-"}); nothing written`);
		return;
	}
	info(bold(`${what}: written as settings #${result.seq}`));
	if (result.untrusted) {
		const dropped = result.dropped?.length ? ` (dropped: ${result.dropped.join(", ")})` : "";
		warn(`replaced a record your keys didn't sign${dropped}: write those fields again (typetorch settings push, fleet setup, settings set analytics -)`);
	}
	if (result.pinged) info(dim("  servers pinged (kernel 0.3.8 reads it within seconds; older kernels ignore it)"));
	else if (result.pingError) warn(`the ping failed (${result.pingError}); servers still read the record within about a minute`);
	else info(dim("  not pinged (--no-ping); servers read it within about a minute"));
}

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new UsageError(`${what} isn't valid JSON: ${(error as Error).message}`);
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
	return Buffer.concat(chunks).toString("utf8");
}

/** `game.<key>`'s key, or undefined for another field. */
function gameKey(path: string): string | undefined {
	if (!path.startsWith("game.")) return undefined;
	const key = path.slice(5);
	if (!GAME_KEY_PATTERN.test(key)) throw new UsageError(`game key "${key}" must be 1-64 characters of letters, digits and _ . : / -`);
	return key;
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function settingsCommand(
	args: ParsedArgs,
	deps: { oc?: Pick<OpenCloud, "request" | "publishMessage">; signer?: DualSigner; stdin?: () => Promise<string>; now?: () => Date; fetch?: typeof fetch } = {},
) {
	const [sub, path, valueArg, extra] = args.positionals;
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");
	const noPing = flagBool(args, "no-ping");
	let cloud: Pick<OpenCloud, "request" | "publishMessage"> | undefined = deps.oc;
	// The deploy key is only needed once the record is read: `set analytics` tests its endpoint first (no key needed).
	const client = () => (cloud ??= openCloud("deploy")!);

	if (sub === "status" || sub === "get") {
		if (sub === "status" && path !== undefined) throw new UsageError(`unexpected argument "${path}"`);
		const read = await readSettings(client(), proj.config.universeId);
		if (read.scopeMissing) throw new Error(`can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${read.error})`);
		if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
		if (sub === "get") {
			const body = read.body ?? {};
			const key = path !== undefined ? gameKey(path) : undefined;
			const value = path === undefined ? body : key !== undefined ? body.game?.[key] : (body as Record<string, unknown>)[path];
			const masked = maskSecrets(value, path ?? "");
			if (isJson()) return emitJson({ seq: read.record?.seq ?? null, field: path ?? null, value: masked ?? null });
			info(masked === undefined ? "(not set)" : JSON.stringify(masked, null, 2));
			return;
		}
		let by: "sig" | "sigF" | undefined;
		let keysNote = "";
		try {
			const signer = deps.signer ?? settingsSigner(proj, args);
			if (read.record) by = verifySettingsRecord(read.record, { main: signer.main.publicKey, fallback: signer.fallback.publicKey });
			keysNote = `main ${keyFingerprint(signer.main.publicKey)}, fallback ${keyFingerprint(signer.fallback.publicKey)}`;
		} catch (error) {
			keysNote = `not checked: ${(error as Error).message.split("\n")[0]}`;
		}
		const ageSeconds = read.record ? Math.max(0, Math.round((Date.now() - Date.parse(read.record.at)) / 1000)) : undefined;
		if (isJson()) {
			return emitJson({
				exists: !read.missing,
				problem: read.problem ?? null,
				seq: read.record?.seq ?? null,
				at: read.record?.at ?? null,
				ageSeconds: ageSeconds ?? null,
				verifiedBy: by ?? null,
				fields: read.body ? Object.keys(read.body).sort() : [],
				bytes: read.record ? Buffer.byteLength(read.record.body, "utf8") : 0,
			});
		}
		if (read.missing) {
			info("no settings record yet: servers use the defaults (defaultBranch prod, only the creator as a dev, no fleet API)");
			info(dim("  start one with: typetorch settings push (and typetorch fleet setup, typetorch access push)"));
			return;
		}
		if (!read.record) {
			warn(`the settings entry isn't a usable record (${read.problem}); servers ignore it. \`typetorch settings push --force\` replaces it`);
			return;
		}
		info(bold(`settings #${read.record.seq}, written ${read.record.at}${ageSeconds !== undefined ? ` (${formatAge(ageSeconds)} ago)` : ""}`));
		if (by) info(`  signature  verified by your ${by === "sig" ? "main key (sig)" : "fallback key (sigF)"}  (${keysNote})`);
		else warn(`  signature  NOT signed by your keys (${keysNote}); servers that trust other keys may refuse it`);
		for (const line of describeFields(read.body ?? {})) info(`  ${line}`);
		return;
	}

	if (sub !== "set" && sub !== "unset" && sub !== "push") throw new UsageError(`unknown settings subcommand "${sub ?? ""}" (status, get, set, unset, push)`);
	let mutate: (body: SettingsBody) => SettingsBody | undefined;
	let what: string;
	let checks: EndpointReport[] = [];
	if (sub === "push") {
		if (path !== undefined) throw new UsageError(`unexpected argument "${path}"`);
		const access = accessValue(proj.config);
		mutate = (body) => ({
			...body,
			defaultBranch: proj.config.defaultBranch,
			channels: { ...proj.config.channels },
			access: { members: access.members, revoked: access.revoked, devBadgeId: access.devBadgeId },
		});
		what = "settings push (defaultBranch, channels, access from typetorch.json)";
	} else if (sub === "unset") {
		if (path === undefined) throw new UsageError("typetorch settings unset game.<key> | analytics | fleet");
		if (valueArg !== undefined) throw new UsageError(`unexpected argument "${valueArg}"`);
		const key = gameKey(path);
		if (key === undefined && path !== "analytics" && path !== "fleet") throw new UsageError(`can unset game.<key>, analytics or fleet, not "${path}"`);
		mutate = (body) => {
			if (key !== undefined) {
				if (body.game?.[key] === undefined) return undefined;
				const nextGame = { ...body.game };
				delete nextGame[key];
				return { ...body, game: nextGame };
			}
			if ((body as Record<string, unknown>)[path] === undefined) return undefined;
			const next = { ...body } as Record<string, unknown>;
			delete next[path];
			return next as SettingsBody;
		};
		what = `settings unset ${path}`;
	} else {
		if (path === undefined || valueArg === undefined) throw new UsageError("typetorch settings set game.<key> <json | ->  /  typetorch settings set analytics <json | ->");
		const key = gameKey(path);
		if (key === undefined && path !== "analytics") throw new UsageError(`can set game.<key> or analytics (fleet: typetorch fleet setup; access: typetorch access push), not "${path}"`);
		const text = valueArg === "-" ? await (deps.stdin ?? readStdin)() : valueArg;
		const value = parseJson(text, valueArg === "-" ? "stdin" : "the value");
		if (key === undefined && !plainObject(value)) throw new UsageError("analytics must be a JSON object (the sink settings)");
		mutate = (body) => (key !== undefined ? { ...body, game: { ...(body.game ?? {}), [key]: value } } : { ...body, analytics: value as Record<string, unknown> });
		what = `settings set ${path}`;
		// The analytics sink goes to every game server: test the URL, /healthz and the token before anything is signed.
		if (key === undefined) {
			checks = [await checkAnalyticsEndpoint(value, { fetch: deps.fetch })];
			enforceEndpoints({ reports: checks, what: "settings.analytics", force });
		}
	}
	if (dryRun) {
		const read = await readSettings(client(), proj.config.universeId);
		if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
		const next = mutate(JSON.parse(JSON.stringify(read.body ?? {})) as SettingsBody);
		const changed = next !== undefined && encodeBody(next) !== encodeBody(read.body ?? {});
		if (isJson()) return emitJson({ dryRun: true, seq: read.record ? read.record.seq + 1 : 1, changed, after: maskSecrets(next ?? read.body ?? {}), ...(checks.length ? { checks: reportsJson(checks) } : {}) });
		info(bold(`dry run: ${changed ? `would write settings #${read.record ? read.record.seq + 1 : 1}` : "nothing to change"}`));
		for (const line of describeFields(next ?? read.body ?? {})) info(`  ${line}`);
		return;
	}
	const signer = deps.signer ?? settingsSigner(proj, args);
	const result = await changeSettings({ proj, oc: client(), signer, mutate, what, force, noPing, now: deps.now, checked: checks.map((report) => report.target) });
	if (isJson()) {
		return emitJson({ outcome: result.outcome ?? null, seq: result.seq ?? null, pinged: result.pinged ?? false, fields: result.after ? Object.keys(result.after).sort() : [], ...(checks.length ? { checks: reportsJson(checks) } : {}) });
	}
	reportChange(result, what);
}

function formatAge(seconds: number): string {
	if (seconds < 120) return `${seconds} s`;
	if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
	if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
	return `${Math.round(seconds / 86_400)} days`;
}
