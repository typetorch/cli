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
import { sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flagBool, flagString, parseArgs, UsageError, type ParsedArgs } from "../args.ts";
import { BACKEND_CONFIG_FILE, DEFAULT_PORT, readLocalBackendConfig, runLocalBackend, spawnChild } from "../backendrun.ts";
import { sleep, which } from "../runtime.ts";
import { backendCredentialsWarned, blessChallenge, blessMessage, syncBlessKeys } from "../backend.ts";
import { capture } from "../proc.ts";
import { backendUrlError, updateProjectConfig, type Project } from "../config.ts";
import { checkBackendEndpoint, enforceEndpoints, reportsJson } from "../endpoints.ts";
import { ADMIN_TOKEN_VAR, BACKEND_KEY_VAR, childEnv, settings } from "../env.ts";
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
	"no-open": "boolean",
	"backend-dir": "string",
	port: "string",
	cloudflared: "string",
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
  DataStore read/create/update scopes. Replaces \`fleet setup\` and \`settings set analytics\` (CLI 0.8).

typetorch backend run [--backend-dir <checkout>] [--port <n>] [--cloudflared <path>]

  The backend on this PC behind a Cloudflare quick tunnel (no account): starts the backend checkout's server with the
  two keys above, opens the tunnel, and runs \`backend setup --url <tunnel>\` each time the tunnel's address changes, so
  game servers follow it within seconds. Restarts the tunnel or the server when either drops; Ctrl+C stops both.
  \`typetorch init\` sets it up (.typetorch/backend.json holds the checkout folder and the port) and registers it as a
  login task. The current address is in .typetorch/backend-run.json. The explorer is http://localhost:<port> (sign in
  with the admin token; Roblox sign-in needs a fixed address, which a quick tunnel is not).
  --backend-dir    the typetorch/backend checkout (default: .typetorch/backend.json)
  --port           the local port (default 8787)
  --cloudflared    cloudflared's path when it is not on PATH

typetorch backend bless [--url <https url>] [--no-open] [--key-file <path>] [--fallback-key-file <path>]

  Trusts one browser for admin when you sign in with typetorch.dev (TYPETORCH_CENTRAL_LOGIN on the backend): an owner
  gets admin only on a trusted browser, so typetorch.dev alone can never make anyone an admin. Sends the game's two
  public signing keys to the backend (PUT /v1/access/keys with ${ADMIN_TOKEN_VAR}, when they changed), asks it for a
  one-time challenge, signs it with the main prod key (it never leaves this PC) and opens the single-use link
  <url>/auth/bless?challenge=...&sig=... in your browser; open it in the browser you want to trust within 5 minutes.
  --url       the backend (default: typetorch.json backend.url)
  --no-open   print the link instead of opening it`;

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

export async function backendCommand(args: ParsedArgs, deps: { oc?: Pick<OpenCloud, "request" | "publishMessage">; signer?: DualSigner; fetch?: typeof fetch; open?: (url: string) => Promise<void> } = {}) {
	const [sub, extra] = args.positionals;
	if (sub === "bless") {
		if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
		return backendBless(args, deps);
	}
	if (sub === "run") {
		if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
		return backendRun(args);
	}
	if (sub !== "setup") throw new UsageError(`unknown backend subcommand "${sub ?? ""}" (setup, run, bless)`);
	for (const flag of ["backend-dir", "port", "cloudflared"]) if (flagString(args, flag) !== undefined) throw new UsageError(`--${flag} belongs to \`backend run\``);
	if (flagBool(args, "no-open")) throw new UsageError("--no-open belongs to `backend bless`");
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

/** `backend run`: the local backend and its quick tunnel (backendrun.ts), until Ctrl+C. */
async function backendRun(args: ParsedArgs) {
	if (isJson()) throw new UsageError("backend run keeps running and has no --json");
	const proj = project(args);
	const gameDir = dirname(proj.configPath);
	const saved = readLocalBackendConfig(gameDir);
	const backendDir = flagString(args, "backend-dir") ?? saved?.dir;
	if (!backendDir) throw new UsageError(`which backend checkout? pass --backend-dir <folder> (\`typetorch init\` writes it to ${BACKEND_CONFIG_FILE})`);
	if (!existsSync(join(backendDir, "src", "server", "main.ts"))) throw new UsageError(`${backendDir} is not a typetorch/backend checkout (no src/server/main.ts)`);
	const portRaw = flagString(args, "port");
	const port = portRaw !== undefined ? Number(portRaw) : (saved?.port ?? DEFAULT_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--port must be a number from 1 to 65535, got "${portRaw}"`);
	const cloudflared = flagString(args, "cloudflared") ?? saved?.cloudflared ?? which("cloudflared");
	if (!cloudflared) throw new Error("cloudflared is not installed (Windows: winget install --id Cloudflare.cloudflared -e; macOS: brew install cloudflared; Linux: https://pkg.cloudflare.com)");
	const bun = which("bun") ?? process.execPath;
	const creds = backendCredentialsWarned();
	const key = creds.key?.value;
	const admin = creds.admin?.value;
	if (!key || !admin) throw new Error(`${BACKEND_KEY_VAR} and ${ADMIN_TOKEN_VAR} must both be in ${settings().dotEnv} (\`typetorch init\` writes them)`);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	const stamp = () => new Date().toTimeString().slice(0, 8);
	try {
		await runLocalBackend(
			{ gameDir, backendDir: resolve(backendDir), port, cloudflared, bun, key, admin, baseEnv: childEnv(), signal: controller.signal },
			{
				spawn: spawnChild,
				fetch: globalThis.fetch,
				setup: (url) => backendCommand(parseArgs(["setup", "--url", url, "--config", proj.configPath], backendFlags)),
				sleep,
				log: (line) => info(`${dim(stamp())} ${line}`),
				now: () => new Date(),
				pid: process.pid,
			},
		);
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

/** `backend bless`: a link signed by the main prod key that trusts the browser opening it (typetorch.dev login). */
async function backendBless(args: ParsedArgs, deps: { signer?: DualSigner; fetch?: typeof fetch; open?: (url: string) => Promise<void> }) {
	const proj = project(args);
	const url = (flagString(args, "url") ?? proj.config.backend?.url)?.replace(/\/+$/, "");
	if (!url) throw new UsageError("which backend? pass --url https://<host>, or run `typetorch backend setup` first");
	const problem = backendUrlError(url);
	if (problem) throw new UsageError(`--url ${problem}`);
	const admin = backendCredentialsWarned().admin?.value;
	if (!admin) throw new Error(`${ADMIN_TOKEN_VAR} must be in ${settings().dotEnv}: sending the signing keys to the backend needs the admin token`);
	const signer = deps.signer ?? settingsSigner(proj, args);
	const fetcher = deps.fetch ?? fetch;
	const changed = await syncBlessKeys({ url, adminToken: admin, fetch: fetcher }, [signer.main.publicKey, signer.fallback.publicKey]);
	const { challenge, fingerprint, expiresIn } = await blessChallenge(url, fetcher);
	const sig = sign(null, Buffer.from(blessMessage(fingerprint, challenge), "utf8"), signer.main.privateKey).toString("base64url");
	const link = `${url}/auth/bless?challenge=${encodeURIComponent(challenge)}&sig=${encodeURIComponent(sig)}`;
	if (isJson()) return emitJson({ url, fingerprint, keysUpdated: changed, link, expiresIn });
	if (changed) info(dim(`  sent the game's public signing keys to ${new URL(url).host}`));
	const open = flagBool(args, "no-open") ? undefined : (deps.open ?? openInBrowser);
	if (open) {
		try {
			await open(link);
			info(`opened the trust link in your browser (single use, ${Math.round(expiresIn / 60)} minutes). If it opened in the wrong browser, run this again with --no-open and paste the link there.`);
			return;
		} catch {}
	}
	info(`open this link in the browser to trust (single use, ${Math.round(expiresIn / 60)} minutes):`);
	info(link);
}

/** The system's default browser. */
async function openInBrowser(url: string): Promise<void> {
	const cmd = process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
	const result = await capture(cmd, process.cwd());
	if (result.exitCode !== 0) throw new Error(`${cmd[0]} exited with ${result.exitCode}`);
}
