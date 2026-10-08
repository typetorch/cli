/**
 * `typetorch backend setup`: points game servers at the TypeTorch backend (plans/21 B). It checks the endpoint first
 * (endpoints.ts: the URL, GET /healthz, the game key answers role "game" with the fleet and analytics parts running, the
 * admin token answers role "admin") and refuses a broken one unless --force, then writes the signed settings record's
 *
 *   backend   = { url, key, analytics?: { flushSeconds, recordShare } }
 *   fleet     = { url, token: key }                                   (kernels 0.3.8/0.3.9 read this one)
 *   analytics = { backend: "duckdb", events: url/v1/ingest, token: key, ... }   (frameworks before 0.4; other fields kept)
 *
 * with both prod keys, pings servers, sends the owner list to the backend (PUT /v1/access) and sets typetorch.json
 * `backend.url` (dropping CLI 0.8's `fleet`). The key is TYPETORCH_API_KEY and the admin token TYPETORCH_ADMIN_TOKEN,
 * from the environment or the game repo's .env (backend.ts); neither is printed or passed on a command line.
 *
 * Replaces `typetorch fleet setup` and `typetorch settings set analytics` (CLI 0.8).
 */
import { readFileSync } from "node:fs";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { backendCredentialsWarned } from "../backend.ts";
import { backendUrlError, updateProjectConfig, type Project } from "../config.ts";
import { checkBackendEndpoint, enforceEndpoints, reportsJson } from "../endpoints.ts";
import { ADMIN_TOKEN_VAR, BACKEND_KEY_VAR, settings } from "../env.ts";
import { bold, dim, emitJson, info, isJson } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import {
	describeFields,
	encodeBody,
	FLUSH_SECONDS_BOUNDS,
	maskSecrets,
	readSettings,
	RECORD_SHARE_BOUNDS,
	withBackend,
	type BackendAnalytics,
	type SettingsBody,
} from "../settings.ts";
import type { DualSigner } from "../signing.ts";
import { KEY_FILE_FLAGS, openCloud, project } from "./common.ts";
import { changeSettings, ENDPOINT_SECTIONS, reportChange, settingsSigner } from "./settings.ts";

export const backendFlags = {
	url: "string",
	"flush-seconds": "string",
	"record-share": "string",
	"dry-run": "boolean",
	"no-ping": "boolean",
	force: "boolean",
	...KEY_FILE_FLAGS,
} as const;

export const BACKEND_USAGE = `typetorch backend setup [--url <https url>] [--flush-seconds <5-300>] [--record-share <0-1>] [--dry-run] [--force]
                        [--no-ping] [--key-file <path>] [--fallback-key-file <path>]

  Points game servers at the TypeTorch backend (fleet status, analytics, error logs; one URL, one key). Checked first
  (--dry-run too), so a broken address or key never reaches game servers:
    url      parses, https, the server's base address, only the characters the kernel accepts
    healthz  GET <url>/healthz answers {"ok":true} within 5 s
    key      GET <url>/v1/auth/check with ${BACKEND_KEY_VAR} says role "game" (write-only) and that the fleet and
             analytics parts run
    admin    GET <url>/v1/auth/check with ${ADMIN_TOKEN_VAR} says role "admin" (the CLI's reads, the owner list)
  A failure prints what is wrong and how to fix it, writes nothing and exits 1; --force writes it anyway (the failures
  print as warnings). Then it writes the signed settings record's backend = {url, key, analytics?} and, for kernels
  before 0.4, the fleet and analytics sections derived from it (an existing analytics section keeps its experiments),
  pings servers, sends the owner list to the backend (PUT /v1/access) and sets typetorch.json backend.url.
  --url            the backend's public https address (default: typetorch.json backend.url)
  --flush-seconds  seconds between analytics sends (default: the record's, else the framework's ~15)
  --record-share   share (0-1) of new players whose first session is recorded in detail (default: the record's)
  Keys: ${BACKEND_KEY_VAR} (the backend's game key) and ${ADMIN_TOKEN_VAR} (its admin token), from the environment
  or the game repo's .env (never printed, never on a command line). Needs both signing keys and the deploy key's
  DataStore read/create/update scopes. Replaces \`fleet setup\` and \`settings set analytics\` (CLI 0.8).`;

function dial(args: ParsedArgs, flag: string, [low, high]: readonly [number, number]): number | undefined {
	const raw = flagString(args, flag);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(value) || value < low || value > high) throw new UsageError(`--${flag} must be a number from ${low} to ${high}, got "${raw}"`);
	return value;
}

/** The analytics dials to write: the flags, else what the record has (its backend section, else the old analytics). */
export function analyticsDials(body: SettingsBody, flags: BackendAnalytics): BackendAnalytics | undefined {
	const old = body.backend?.analytics ?? {
		...(typeof body.analytics?.flushSeconds === "number" ? { flushSeconds: body.analytics.flushSeconds } : {}),
		...(typeof body.analytics?.recordShare === "number" ? { recordShare: body.analytics.recordShare } : {}),
	};
	const dials: BackendAnalytics = { ...old, ...flags };
	return Object.keys(dials).length ? dials : undefined;
}

export async function backendCommand(args: ParsedArgs, deps: { oc?: Pick<OpenCloud, "request" | "publishMessage">; signer?: DualSigner; fetch?: typeof fetch } = {}) {
	const [sub, extra] = args.positionals;
	if (sub !== "setup") throw new UsageError(`unknown backend subcommand "${sub ?? ""}" (setup)`);
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	const proj = project(args);
	const url = (flagString(args, "url") ?? proj.config.backend?.url)?.replace(/\/+$/, "");
	if (!url) throw new UsageError("which backend? pass --url https://<host> (it is then kept in typetorch.json backend.url)");
	const problem = backendUrlError(url);
	if (problem) throw new UsageError(`--url ${problem}`);
	const flags: BackendAnalytics = {};
	const flush = dial(args, "flush-seconds", FLUSH_SECONDS_BOUNDS);
	const share = dial(args, "record-share", RECORD_SHARE_BOUNDS);
	if (flush !== undefined) flags.flushSeconds = flush;
	if (share !== undefined) flags.recordShare = share;
	const dryRun = flagBool(args, "dry-run");
	const force = flagBool(args, "force");

	// The Open Cloud deploy key first: without it nothing can be written (and a CLI 0.8 env, where TYPETORCH_API_KEY was
	// the Roblox key, gets the rename hint here before anything is sent to the backend).
	const oc = deps.oc ?? openCloud("deploy")!;
	const creds = backendCredentialsWarned();
	if (!creds.key) {
		throw new Error(
			`${BACKEND_KEY_VAR} isn't usable: ${creds.refused ?? `put the backend's game key in ${settings().dotEnv} (${BACKEND_KEY_VAR}=...; the backend's own ${BACKEND_KEY_VAR})`}. Nothing was written`,
		);
	}
	const key = creds.key.value;
	// Game servers will post to this address with this key: test it before anything is signed or written.
	const report = await checkBackendEndpoint({ url, key, admin: creds.admin?.value, requireAdmin: true, kernelRules: true, fetch: deps.fetch });
	enforceEndpoints({ reports: [report], what: "settings.backend", force });

	const mutate = (body: SettingsBody): SettingsBody => withBackend(body, { url, key, analytics: analyticsDials(body, flags) });
	if (dryRun) {
		const read = await readSettings(oc, proj.config.universeId);
		if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
		const before = read.body ?? {};
		const next = mutate(JSON.parse(JSON.stringify(before)) as SettingsBody);
		const changed = encodeBody(next) !== encodeBody(before);
		if (isJson()) {
			return emitJson({ dryRun: true, url, changed, seq: read.record ? read.record.seq + (changed ? 1 : 0) : 1, after: maskSecrets(next), checks: reportsJson([report]) });
		}
		info(bold(`dry run: ${changed ? `would write settings #${read.record ? read.record.seq + 1 : 1} (backend ${new URL(url).host}, key from ${creds.key.name})` : "the record already holds this backend"}; then ping servers, send the owner list, set typetorch.json backend.url`));
		if (before.analytics?.backend === "basin") info(dim("  replaces the Basin analytics sink: events go to the backend (experiments and the other dials stay)"));
		for (const line of describeFields(next)) info(`  ${line}`);
		return;
	}
	const signer = deps.signer ?? settingsSigner(proj, args);
	const result = await changeSettings({
		proj,
		oc,
		signer,
		what: `backend setup ${new URL(url).host}`,
		noPing: flagBool(args, "no-ping"),
		checked: ENDPOINT_SECTIONS,
		fetch: deps.fetch,
		mutate,
	});
	const configChanged = setConfigUrl(proj, url);
	if (isJson()) {
		return emitJson({ field: "backend", url, settingsSeq: result.seq ?? null, outcome: result.outcome ?? null, pinged: result.pinged ?? false, owners: result.owners ?? null, configChanged, checks: reportsJson([report]) });
	}
	reportChange(result, `backend setup: game servers use ${new URL(url).host}`);
	info(dim(`  typetorch.json backend.url = ${url}${configChanged ? "" : " (unchanged)"}. The key sits in the signed settings record, never printed.`));
}

/** typetorch.json backend.url (and CLI 0.8's `fleet` dropped). Returns whether the file changed. */
function setConfigUrl(proj: Project, url: string): boolean {
	let raw: { backend?: { url?: unknown }; fleet?: unknown } = {};
	try {
		raw = JSON.parse(readFileSync(proj.configPath, "utf8")) as typeof raw;
	} catch {}
	if (raw.backend?.url === url && raw.fleet === undefined) return false;
	updateProjectConfig(proj, { backend: { url } });
	return true;
}
