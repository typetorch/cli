/**
 * `typetorch doctor`: tools, the Config section (every value the CLI reads and where it came from: typetorch.json, the
 * game repo's .env, the environment, the settings record; secrets only as set / unset), API keys per job (never
 * printed), the approval policy, the state dir, the prod signing keys (keycheck.ts: both key files vs typetorch.json, the
 * key asset and the place; mismatches warn), the backend, and Open Cloud scopes, each probed with its job's key through
 * harmless calls:
 *   assets       GET an operation that doesn't exist        404 = scope ok, 401/403 = missing
 *   messaging    publish to topic "TypeTorch/doctor"          200 = ok (no server listens to that topic)
 *   settings     GET DataStore TypeTorch entry "settings"    the signed settings record (kernel 0.3.8, plans/20): seq, age,
 *                                                             fields, and whether it verifies with your keys; missing or
 *                                                             not signed by your keys = warn
 *   backend      url, healthz, key, admin                    typetorch.json backend.url with TYPETORCH_API_KEY (role game)
 *                                                             and TYPETORCH_ADMIN_TOKEN (role admin) (endpoints.ts, the
 *                                                             checks `backend setup` runs before signing); the record's
 *                                                             backend section too when it differs (its own key), or the old
 *                                                             fleet / analytics sections of a record from CLI 0.8
 *   owners       GET /v1/access (admin)                      the backend's owner list vs the signed record's owners
 *   datastore    GET DataStore TypeTorch entry "heads"         200/404 = ok, 401/403 = missing universe-datastores.objects:read
 *                                                             (the shared seq; :create/:update are checked by a deploy)
 *   datastore write SET DataStore TypeTorch entry "doctor"     200 = ok (a tiny {doctor, t} value), 401/403 = missing
 *                                                             :create/:update: deploys can't store the branch head
 *                                                             durably (durablehead.ts), so they reach only running servers
 *   place publish POST an EMPTY body                         400 = scope ok (body rejected), 403 = info (only the splice
 *                                                             engine, `kernel restore <file>` and --replace-place publish
 *                                                             files)
 *   fleet API     GET /v1/fleet/servers with the admin token   ok, or a warning (servers, report, alerts, --wait)
 *   luau exec     GET a task that doesn't exist               404 = :read ok, 401/403 = missing (test --cloud; :write
 *                                                             is checked by the first task); probed with the assets key
 *                                                             and again with the place key ("scope luau (place)": kernel
 *                                                             deploy's luau engine, kernel restore --version)
 *   place download GET the place's Asset Delivery location    200 = ok, 403 = info, as expected: Roblox has no API-key
 *                                                             route for place files (legacy-asset:manage can't be granted;
 *                                                             universe.place:read only covers the version history), so
 *                                                             kernel deploy patches inside a Luau Execution task instead
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParsedArgs, flagString } from "../args.ts";
import { CONFIG_FILE, findProjectRoot, loadProject, type Project } from "../config.ts";
import { ADMIN_TOKEN_VAR, API_KEY_VARS, BACKEND_KEY_VAR, CHILD_ENV_VAR, FALLBACK_KEY_FILE_VAR, JOB_KEY_VARS, JOB_SCOPES, KEY_FILE_VAR, LEGACY_BACKEND_VARS, settings, type KeyJob, type Settings } from "../env.ts";
import { gitInfo } from "../git.ts";
import { bold, dim, emitJson, green, info, isJson, red, yellow } from "../log.ts";
import { OpenCloud } from "../opencloud.ts";
import { checkAnalyticsEndpoint, checkBackendEndpoint, checkFleetEndpoint, type EndpointOptions, type EndpointReport } from "../endpoints.ts";
import { backendCredentials, backendUrl, getAccessList, ownersOf, type BackendCredentials } from "../backend.ts";
import { httpFleetClient } from "../fleet.ts";
import { safeText } from "../httphints.ts";
import { describeRollbackSetting, rollbackSetting } from "./fleet.ts";
import { describeHealth, effectiveHealth, HEALTH_DEFAULTS, HEALTH_KERNEL } from "../health.ts";
import { withJob } from "../progress.ts";
import { capture } from "../proc.ts";
import { hasZstd, isBun, runtimeName } from "../runtime.ts";
import { rojoBinary } from "../build.ts";
import { describeFields, readSettings, verifySettingsRecord, type SettingsBody, type SettingsRead } from "../settings.ts";
import { DS_READ_SCOPE, DS_WRITE_SCOPES, HEADS_KEY, SEQ_DATASTORE } from "../seqstore.ts";
import { DURABLE_SCOPES, NOT_DURABLE } from "../durablehead.ts";
import { createHash } from "node:crypto";
import { stateDir } from "../state.ts";
import { gatherKeyFacts, keyChecks, type Check, type Status } from "../keycheck.ts";
import { KEY_FILE_FLAGS, signingKeyPaths } from "./common.ts";
import { accessStatus, accessWarning, describeAccess } from "../access.ts";
import { loadSigner } from "../keyfiles.ts";
import { declaresLoadstring } from "../kernelpatch.ts";
import { resolveKernelDir } from "./kernel.ts";
import { SAVE_SETTING_HELP } from "../kernel-luau.ts";

export const doctorFlags = { ...KEY_FILE_FLAGS } as const;

function mark(status: Status): string {
	return status === "ok" ? green("ok  ") : status === "info" ? "info" : status === "warn" ? yellow("warn") : red("FAIL");
}

/**
 * The signed settings record (kernel 0.3.8, plans/20): read with the deploy key, verified with your keys (when they load).
 * Never shows a value (keys). The record (when read) feeds the backend checks and the Config section.
 */
async function settingsCheck(oc: OpenCloud, proj: Project, args: ParsedArgs): Promise<{ checks: Check[]; read?: SettingsRead }> {
	const name = "settings";
	const read = await withJob(name, () => readSettings(oc, proj.config.universeId));
	if (read.scopeMissing) return { checks: [{ name, status: "warn", detail: `can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${short(read.error ?? "")})` }] };
	if (read.error) return { checks: [{ name, status: "warn", detail: `reading the settings record failed: ${short(read.error)}` }] };
	if (read.missing) {
		return { checks: [{ name, status: "warn", detail: "no settings record: servers (kernel 0.3.8) use the defaults. Run typetorch settings push (and backend setup, access push)" }], read };
	}
	if (!read.record) return { checks: [{ name, status: "warn", detail: `the settings entry isn't a usable record (${read.problem}); servers ignore it. typetorch settings push --force replaces it` }], read };
	const fields = describeFields(read.body ?? {}).map((line) => line.split(/\s+/)[0]).join(", ") || "none";
	let verified = "";
	// The record's endpoints are tested (backendChecks) whether or not it verifies: servers that trust other keys refuse
	// an unsigned one, but its address and key are still what a broken push would have left behind.
	try {
		const signer = loadSigner(proj, signingKeyPaths(proj, args));
		const by = verifySettingsRecord(read.record, { main: signer.main.publicKey, fallback: signer.fallback.publicKey });
		if (!by) {
			return { checks: [{ name, status: "warn", detail: `#${read.record.seq} (${read.record.at}) is NOT signed by your keys: servers that trust other keys refuse it. Rewrite it (typetorch settings push --force)` }], read };
		}
		verified = `, verified by your ${by === "sig" ? "main" : "fallback"} key`;
	} catch {
		verified = ", not checked (your signing keys don't load here)";
	}
	return { checks: [{ name, status: "ok", detail: `#${read.record.seq} written ${read.record.at}${verified}; fields: ${fields}` }], read };
}

export interface DoctorDeps extends EndpointOptions {}

/** An endpoint report as doctor lines: ok / FAIL (with the fix) / info for steps that could not run. */
export function reportChecks(report: EndpointReport, label: string = report.target): Check[] {
	return report.steps.map((step) => ({
		name: `${label} ${step.step}`,
		status: step.skipped ? "info" : step.ok ? "ok" : "fail",
		detail: step.ok ? step.detail : `${step.detail}. Fix: ${step.hint ?? "see the detail"}`,
	}));
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
const hostOf = (url: string) => {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

export interface BackendCheckInput extends EndpointOptions {
	/** typetorch.json backend.url (what the CLI talks to). */
	configUrl?: string;
	creds: BackendCredentials;
	/** The live settings record's body and seq, when it was read. */
	body?: SettingsBody;
	seq?: number;
}

/**
 * The backend, end to end (plans/21 B and E): typetorch.json backend.url with your keys (url, healthz, the game key's
 * role, the admin token's role, the fleet API's server count); the live record's backend section (its own key, when
 * it differs from yours) or the old fleet / analytics sections of a CLI 0.8 record; and the backend's owner list
 * (GET /v1/access) against the signed record's owners. The same checks `backend setup` runs before it signs anything,
 * so a record written some other way (an old CLI, a backend whose tunnel restarted since) still gets caught.
 */
export async function backendChecks(input: BackendCheckInput): Promise<Check[]> {
	const options: EndpointOptions = { fetch: input.fetch, timeoutMs: input.timeoutMs };
	const { creds, body, configUrl } = input;
	const checks: Check[] = [];
	let adminOk = false;
	if (configUrl) {
		const report = await checkBackendEndpoint({ url: configUrl, key: creds.key?.value, admin: creds.admin?.value, requireKey: false, kernelRules: false, ...options });
		for (const check of reportChecks(report, "backend")) {
			if (check.name === "backend key" && !creds.key) check.detail = `no ${BACKEND_KEY_VAR}${creds.refused ? ` (${creds.refused})` : ""}: the CLI posts no alerts (auto_rollback, server_stuck) and backend setup can't run`;
			if (check.name === "backend admin" && !creds.admin) {
				check.status = "warn";
				check.detail = `no ${ADMIN_TOKEN_VAR}: servers, report, alerts, --wait (auto-rollback) and the owner list are off`;
			}
			checks.push(check);
		}
		adminOk = report.steps.some((step) => step.step === "admin" && step.ok && !step.skipped);
		if (adminOk && creds.admin) {
			try {
				const servers = await withJob("fleet API", () => httpFleetClient({ url: configUrl, adminToken: creds.admin!.value, fetch: input.fetch }).servers({}));
				checks.push({ name: "fleet API", status: "ok", detail: `${hostOf(configUrl)}: ${servers.length} live server(s)` });
			} catch (error) {
				checks.push({ name: "fleet API", status: "warn", detail: (error as Error).message });
			}
		}
	} else {
		checks.push({ name: "backend", status: "info", detail: "typetorch.json has no backend.url: servers, report, alerts and --wait (auto-rollback) are off (typetorch backend setup --url <url>)" });
	}

	if (body) {
		const record = body.backend;
		if (record) {
			const sameAddress = configUrl !== undefined && sameUrl(record.url, configUrl);
			const sameKey = creds.key !== undefined && record.key === creds.key.value;
			if (sameAddress && sameKey) {
				checks.push({ name: "record backend", status: "ok", detail: `the settings record's backend is typetorch.json backend.url with your ${BACKEND_KEY_VAR} (checked above)` });
			} else {
				// Its own address and key, with the kernel's rules (game servers use these); no admin token goes there.
				const report = await checkBackendEndpoint({ url: record.url, key: record.key, requireAdmin: false, kernelRules: true, ...options });
				checks.push(...reportChecks(report, "record backend").filter((check) => check.name !== "record backend admin"));
				if (configUrl && !sameAddress) {
					checks.push({ name: "record backend url", status: "warn", detail: `typetorch.json backend.url (${hostOf(configUrl)}) differs from the settings record's (${hostOf(record.url)}): game servers use the record's, the CLI the file's. Run typetorch backend setup --url <the right one>` });
				}
				if (creds.key && !sameKey) checks.push({ name: "record backend key", status: "warn", detail: `the settings record's backend key differs from your ${BACKEND_KEY_VAR}: run typetorch backend setup` });
			}
			if (!body.fleet || body.fleet.url !== record.url || body.fleet.token !== record.key) {
				checks.push({ name: "record fleet", status: "warn", detail: "the record's fleet section (what kernels before 0.4 read) doesn't match its backend section: run typetorch backend setup" });
			}
		} else if (body.fleet || body.analytics) {
			// A record from CLI 0.8: fleet and analytics written separately.
			const [fleet, analytics] = await Promise.all([
				body.fleet ? checkFleetEndpoint({ url: body.fleet.url, token: body.fleet.token, ...options }) : undefined,
				body.analytics ? checkAnalyticsEndpoint(body.analytics, options) : undefined,
			]);
			if (fleet) checks.push(...reportChecks(fleet, "record fleet"));
			if (analytics) checks.push(...reportChecks(analytics, "record analytics"));
			checks.push({ name: "record backend", status: "warn", detail: "the settings record has no backend section (written by CLI 0.8: fleet and analytics apart): run typetorch backend setup (kernel 0.4 reads backend)" });
		} else {
			checks.push({
				name: "record backend",
				status: configUrl ? "warn" : "info",
				detail: `the settings record has no backend section: game servers post no heartbeats, events or errors${configUrl ? ` although typetorch.json lists ${hostOf(configUrl)}` : ""}. Run typetorch backend setup`,
			});
		}
	}

	// The owner list (only owners may Sign in with Roblox): the backend's copy vs the signed record.
	const ownersUrl = configUrl ?? body?.backend?.url;
	if (ownersUrl && creds.admin && (adminOk || !configUrl)) {
		if (!body) checks.push({ name: "owners", status: "info", detail: "not compared: the settings record wasn't read (the deploy key)" });
		else {
			const signed = ownersOf(body.access);
			try {
				const copy = await withJob("owner list", () => getAccessList({ url: ownersUrl, adminToken: creds.admin!.value, fetch: input.fetch, timeoutMs: input.timeoutMs }));
				const same = copy.owners.join(",") === signed.join(",");
				if (copy.seq === null) {
					checks.push({ name: "owners", status: "warn", detail: `the backend has no owner list yet (the signed record has ${signed.length}): run typetorch access push (until then nobody can Sign in with Roblox)` });
				} else if (!same) {
					checks.push({ name: "owners", status: "warn", detail: `the backend's owner list (${copy.owners.length}, from settings #${copy.seq}) differs from the signed record's (${signed.length}, #${input.seq ?? "?"}): run typetorch access push` });
				} else {
					const behind = input.seq !== undefined && copy.seq < input.seq ? ` (sent with settings #${copy.seq}; the record is #${input.seq}: same owners)` : "";
					checks.push({ name: "owners", status: "ok", detail: `the backend's ${copy.owners.length} owner(s) match the signed record${behind}` });
				}
			} catch (error) {
				checks.push({ name: "owners", status: "warn", detail: `GET /v1/access: ${(error as Error).message}` });
			}
		}
	}
	return checks;
}

// The Config section --------------------------------------------------------------------------------------------------

export interface ConfigRow {
	name: string;
	/** A path, a URL, a non-secret value, or "set" / "unset" for secrets. */
	value: string;
	/** Where it came from: "typetorch.json", "environment", an env file path, "settings record #n", "-". */
	source: string;
	note?: string;
	status?: Status;
}

/** Non-secret variables shown with their value when set. */
const PLAIN_VARS = ["TYPETORCH_STATE_DIR", "TYPETORCH_PROPOSED_BY", "TYPETORCH_ROJO", "TYPETORCH_LUNE", "TYPETORCH_DEV_SERVER", CHILD_ENV_VAR, KEY_FILE_VAR, FALLBACK_KEY_FILE_VAR];

/** Every value the CLI reads, where it came from; secrets only as set / unset. */
export function configRows(input: { proj?: Project; config: Settings; creds: BackendCredentials; read?: SettingsRead; configFlag?: string }): ConfigRow[] {
	const { proj, config, creds, read } = input;
	const rows: ConfigRow[] = [];
	const where = (source: string) => (source === "environment" ? "environment" : source);
	rows.push(proj ? { name: "typetorch.json", value: proj.configPath, source: input.configFlag ? "--config" : "found from the working directory" } : { name: "typetorch.json", value: "(not found)", source: "-", status: "fail" });
	if (config.envFile) {
		rows.push({ name: "env file", value: config.envFile, source: `${config.envFileFrom}, read instead of the game repo's .env`, status: config.envFileMissing ? "fail" : "ok", ...(config.envFileMissing ? { note: "does not exist" } : {}) });
	} else {
		const exists = config.files.includes(config.dotEnv);
		rows.push({ name: "env file", value: config.dotEnv, source: "the game repo's .env", status: exists ? "ok" : "info", ...(exists ? {} : { note: "not there: secrets come from the environment only" }) });
		if (config.declaredEnvFile) {
			rows.push({ name: "env file (named)", value: config.declaredEnvFile, source: `${config.dotEnv} (TYPETORCH_ENV_FILE line)`, status: "warn", note: "CLI 0.9 still reads it, for one release: move its keys into the game repo's .env" });
		}
	}
	if (proj) {
		let legacy = false;
		try {
			const raw = JSON.parse(readFileSync(proj.configPath, "utf8")) as Record<string, unknown>;
			legacy = raw.backend === undefined && raw.fleet !== undefined;
		} catch {}
		const url = backendUrl(proj);
		rows.push({ name: "backend.url", value: url ?? "(not set)", source: url ? (legacy ? 'typetorch.json "fleet" (the old name)' : "typetorch.json") : "-", status: legacy ? "warn" : url ? "ok" : "info" });
	}
	const secret = (name: string, note?: string, status?: Status) => {
		const found = config.get(name);
		rows.push({ name, value: found ? "set" : "unset", source: found ? where(found.source) : "-", ...(note ? { note } : {}), ...(status ? { status } : {}) });
	};
	for (const name of API_KEY_VARS) if (name === "OPENCLOUD_API_KEY" || config.get(name)) secret(name, name === "OPENCLOUD_API_KEY" ? "the shared Open Cloud key" : "alias of OPENCLOUD_API_KEY");
	for (const job of ["assets", "deploy", "place"] as const) if (config.get(JOB_KEY_VARS[job])) secret(JOB_KEY_VARS[job], `the ${job} job's own Open Cloud key`);
	secret(BACKEND_KEY_VAR, creds.refused ?? "the backend's game key (write-only)", creds.refused ? "warn" : undefined);
	secret(ADMIN_TOKEN_VAR, "the backend's admin token");
	for (const [old, current] of Object.entries(LEGACY_BACKEND_VARS)) if (config.get(old)) secret(old, `old name of ${current} (read until the next release)`, "warn");
	for (const name of PLAIN_VARS) {
		const found = config.get(name);
		if (found) rows.push({ name, value: found.value, source: where(found.source) });
	}
	if (read?.record && read.body) {
		const seq = `settings record #${read.record.seq}`;
		const backend = read.body.backend;
		rows.push({ name: "record backend.url", value: backend?.url ?? read.body.fleet?.url ?? "(not set)", source: backend ? seq : read.body.fleet ? `${seq} (fleet section)` : "-" });
		const key = backend?.key ?? read.body.fleet?.token;
		rows.push({
			name: "record backend.key",
			value: key ? "set" : "unset",
			source: key ? seq : "-",
			...(key && creds.key ? { note: key === creds.key.value ? `= your ${BACKEND_KEY_VAR}` : `differs from your ${BACKEND_KEY_VAR}` } : {}),
		});
		const dials = backend?.analytics;
		if (dials && Object.keys(dials).length) rows.push({ name: "record analytics", value: JSON.stringify(dials), source: seq });
		rows.push({ name: "record owners", value: String(ownersOf(read.body.access).length), source: read.body.access ? seq : "-" });
	} else if (read?.missing) rows.push({ name: "settings record", value: "(none)", source: "-" });
	return rows;
}

function printConfig(rows: ConfigRow[]) {
	info(bold("Config") + dim("  (secrets only as set / unset)"));
	const width = Math.max(...rows.map((row) => row.name.length), 10);
	for (const row of rows) {
		const value = row.status === "warn" ? yellow(row.value) : row.status === "fail" ? red(row.value) : row.value;
		info(`  ${row.name.padEnd(width)}  ${value}${row.source !== "-" ? dim(`  (${row.source})`) : ""}${row.note ? dim(`  ${row.note}`) : ""}`);
	}
	info("");
}

/**
 * The place key's Luau Execution probe (kernel deploy's luau engine and `kernel restore --version` run their tasks with
 * it). The place setting SavePlaceAsync needs can't be read through Open Cloud: it is named so the owner can check it.
 */
export function placeLuauProbe(status: number, text: string, universeId: number, placeId: number): [Status, string] {
	if (status === 404) {
		return ["ok", `universe.place.luau-execution-session:read (kernel deploy's luau engine; :write is checked by its first task). Saving also needs the place setting ${SAVE_SETTING_HELP(universeId, placeId)}, which no API can read`];
	}
	if (status === 401 || status === 403) {
		return ["warn", `missing universe.place.luau-execution-session:read/:write on the place key: \`typetorch kernel deploy\` (luau engine) and \`kernel restore --version\` can't run their tasks; only --place-file works (${status} ${short(text)})`];
	}
	return ["warn", `unexpected ${status} ${short(text)}`];
}

async function probe(
	name: string,
	fn: () => Promise<{ status: number; text: string }>,
	interpret: (status: number, text: string) => [Status, string],
): Promise<Check> {
	try {
		const { status, text } = await withJob(name, fn);
		const [result, detail] = interpret(status, text);
		return { name, status: result, detail };
	} catch (error) {
		return { name, status: "fail", detail: `request failed: ${(error as Error).message}` };
	}
}

const short = (text: string) => safeText(text).slice(0, 160);

/**
 * The Asset Delivery probe: 200 = legacy-asset:manage present (`kernel deploy --engine splice` could download the
 * place). Expected today: 403. Roblox has no API-key route for place files, and the default luau engine needs none.
 */
export function placeDownloadProbe(status: number, text: string): [Status, string] {
	if (status === 200) return ["ok", "legacy-asset:manage (the place file can be downloaded: `kernel deploy --engine splice` works without --place-file)"];
	if (status === 401 || status === 403) {
		return [
			"info",
			`no place download (${status}), as expected: Roblox has no API-key route for place files (legacy-asset:manage can't be granted to API keys; universe.place:read only covers the version history). \`typetorch kernel deploy\` patches the place inside a Luau Execution task instead (the luau engine); the splice engine takes a Studio copy: --place-file <file> --base <version>`,
		];
	}
	// Never echo a 2xx body: it holds a presigned URL.
	return ["warn", `unexpected ${status}${status >= 300 ? ` ${short(text)}` : ""}`];
}

export async function doctorCommand(args: ParsedArgs, deps: DoctorDeps = {}) {
	const checks: Check[] = [];
	const cwd = process.cwd();

	// The runtime running this CLI (Bun or Node), and zstd (Roblox-serialized hot-asset exports need it).
	checks.push({ name: "runtime", status: "ok", detail: runtimeName() });
	if (!hasZstd()) checks.push({ name: "zstd", status: "warn", detail: `${runtimeName()} has no zstd: \`typetorch assets sync/status\` need Node 22.15+ (or Bun)` });

	// Project
	let proj: Project | undefined;
	const configFlag = flagString(args, "config");
	const root = configFlag ? undefined : findProjectRoot(cwd);
	if (!configFlag && !root) {
		checks.push({ name: CONFIG_FILE, status: "fail", detail: `not found in ${cwd} or a parent folder` });
	} else {
		try {
			proj = loadProject(configFlag, cwd);
			const c = proj.config;
			checks.push({
				name: CONFIG_FILE,
				status: proj.warnings.length ? "warn" : "ok",
				detail: `${c.project}: universe ${c.universeId}, place ${c.placeId}, creator ${JSON.stringify(c.creator)}, default branch ${c.defaultBranch}${proj.warnings.length ? ` (${proj.warnings.join("; ")})` : ""}`,
			});
		} catch (error) {
			checks.push({ name: CONFIG_FILE, status: "fail", detail: (error as Error).message });
		}
	}
	const base = proj?.root ?? cwd;

	// Bun: game repos are Bun projects, and `typetorch build` runs `bun run build` (or `bun run rbxtsc`) in them.
	const bunVersion = isBun ? { exitCode: 0, stdout: process.versions.bun ?? "" } : await capture(["bun", "--version"], base);
	if (bunVersion.exitCode === 0) checks.push({ name: "bun", status: "ok", detail: bunVersion.stdout.trim() });
	else checks.push({ name: "bun", status: proj ? "fail" : "warn", detail: "not found on PATH: `typetorch build` runs `bun run build` in the game repo (install Bun: https://bun.sh)" });

	// git
	const gitVersion = await capture(["git", "--version"], base);
	if (gitVersion.exitCode !== 0) checks.push({ name: "git", status: "fail", detail: "git not found on PATH" });
	else {
		const git = gitInfo(base);
		checks.push({
			name: "git",
			status: git.isRepo ? "ok" : "warn",
			detail: `${gitVersion.stdout.trim().replace(/^git version /, "")}${git.isRepo ? `, ${git.gitBranch || "detached"}@${git.commit || "no commits"}${git.dirty ? " (dirty)" : ""}` : ", not a git repository"}`,
		});
	}

	// rojo (through Rokit: the version comes from the nearest rokit.toml)
	const rojo = await capture([rojoBinary(), "--version"], base);
	if (rojo.exitCode !== 0) {
		checks.push({ name: "rojo", status: "fail", detail: `${rojoBinary()} not found (install Rokit and run \`rokit install\`)` });
	} else {
		const version = /(\d+\.\d+\.\d+\S*)/.exec(rojo.stdout)?.[1] ?? rojo.stdout.trim();
		const ok = version.startsWith("7.7.");
		checks.push({
			name: "rojo",
			status: ok ? "ok" : "fail",
			detail: ok ? version : `${version}; needs 7.7.x (pin rojo-rbx/rojo@7.7.0-rc.1 in rokit.toml, matching the Studio plugin)`,
		});
	}
	const rokitToml = join(base, "rokit.toml");
	if (proj && !existsSync(rokitToml)) checks.push({ name: "rokit.toml", status: "warn", detail: "missing: the rojo version isn't pinned for this repo" });

	// roblox-ts
	const rbxtsPackage = join(base, "node_modules", "roblox-ts", "package.json");
	if (existsSync(rbxtsPackage)) {
		const version = JSON.parse(readFileSync(rbxtsPackage, "utf8")).version;
		checks.push({ name: "rbxtsc", status: "ok", detail: `roblox-ts ${version}` });
	} else {
		checks.push({ name: "rbxtsc", status: proj ? "fail" : "warn", detail: "node_modules/roblox-ts not installed (run `bun install`)" });
	}

	// The env file (the Config section lists every value), keys (one per job, else the shared key), approval, state dir
	const config = settings();
	if (config.envFileMissing) checks.push({ name: "env file", status: "fail", detail: `${config.envFile} (${config.envFileFrom}) does not exist` });
	for (const warning of config.warnings) checks.push({ name: "env file", status: "warn", detail: warning });
	const creds = backendCredentials(config);
	for (const note of creds.notes) checks.push({ name: "backend keys", status: "warn", detail: note });
	const keys: Record<KeyJob, ReturnType<typeof config.apiKey>> = { assets: config.apiKey("assets"), deploy: config.apiKey("deploy"), place: config.apiKey("place") };
	for (const job of ["assets", "deploy", "place"] as const) {
		const key = keys[job];
		checks.push(
			key
				? { name: `key ${job}`, status: "ok", detail: `${key.name} from ${key.source}${key.dedicated ? "" : ` (shared; ${JOB_KEY_VARS[job]} would separate it)`}` }
				: {
						name: `key ${job}`,
						status: job === "place" ? "warn" : "fail",
						detail: `none: set ${JOB_KEY_VARS[job]} (${JOB_SCOPES[job]}) or the shared ${API_KEY_VARS[0]} in ${config.dotEnv}${config.get(BACKEND_KEY_VAR) && !config.apiKey() ? ` (${BACKEND_KEY_VAR} is the backend's game key since CLI 0.9, not a Roblox key: rename it if it holds your Open Cloud key)` : ""}`,
					},
		);
	}
	if (proj) {
		checks.push({ name: "approval", status: "ok", detail: `"${proj.config.approval}" (${proj.config.approval === "none" ? "deploys publish without approval" : "deploys wait for typetorch approve"})` });
	}
	if (proj) checks.push({ name: "state dir", status: "ok", detail: stateDir(proj.root) });

	// Safety thresholds (health.ts; plans/17 blocker 5): the health window each build carries, per channel, and deploy
	// --wait's auto-rollback threshold.
	if (proj) {
		const prod = effectiveHealth(proj.config.health, "prod");
		const dev = effectiveHealth(proj.config.health, "dev");
		const custom = prod.source !== "default" || dev.source !== "default";
		const line = (h: typeof prod) => describeHealth({ errors: h.errors, window: h.window, rollback: h.rollback });
		const values = line(prod) === line(dev) ? `prod and dev builds: ${line(prod)}` : `prod builds: ${line(prod)}; dev builds: ${line(dev)}`;
		checks.push({
			name: "health window",
			status: "ok",
			detail: custom
				? `${values}. From typetorch.json "health", stamped on each build; kernel ${HEALTH_KERNEL}+ reads it (older kernels: ${HEALTH_DEFAULTS.errors} errors in ${HEALTH_DEFAULTS.window} s)`
				: `${values} (the defaults; a game with noisy errors sets typetorch.json "health")`,
		});
		const rollback = rollbackSetting({ positionals: [], flags: {} }, proj.config);
		checks.push({ name: "auto-rollback", status: "ok", detail: `deploy --wait: ${describeRollbackSetting(rollback)}; --rollback-at <pct> or --no-auto-rollback per deploy` });
	}

	// Dev access lists (security audit 2026-10-06): typetorch.json's members/revoked/devBadgeId reach servers only through
	// `typetorch access push` (CLI 0.8: the signed settings record's `access`; kernel 0.3.8).
	if (proj) {
		const access = accessStatus(proj.config, stateDir(proj.root));
		const problem = accessWarning(access);
		if (!access.configured) checks.push({ name: "dev access", status: "info", detail: "typetorch.json lists no members, revoked users or dev badge: only the experience creator is a dev" });
		else if (problem) checks.push({ name: "dev access", status: "warn", detail: problem });
		else checks.push({ name: "dev access", status: "ok", detail: `${describeAccess(access.value)} pushed ${access.record?.at}${access.record?.settingsSeq !== undefined ? ` (settings #${access.record.settingsSeq})` : ""}; kernel 0.3.8+ reads it` });
	}

	// loadstring (security audit 2026-10-06): `kernel deploy` (patch) leaves the place's LoadStringEnabled alone, so
	// installing the kernel never turns `loadstring` on in a real game; --replace-place still publishes whatever the
	// kernel's place.project.json says. Only remote-claude's run_luau needs it.
	if (proj) {
		try {
			const kernelDir = resolveKernelDir(proj);
			const projectFile = join(kernelDir, "place.project.json");
			if (existsSync(projectFile)) {
				const declares = declaresLoadstring(JSON.parse(readFileSync(projectFile, "utf8")));
				checks.push({
					name: "loadstring",
					status: declares ? "info" : "ok",
					detail: declares
						? `the kernel's place.project.json sets ServerScriptService.LoadStringEnabled = true (a kernel before 0.3.6): \`kernel deploy\` (patch) leaves the place's own value unless --loadstring; \`--replace-place\` publishes it off unless --loadstring. Only remote-claude's run_luau needs it`
						: "loadstring stays off: `kernel deploy` turns ServerScriptService.LoadStringEnabled on only with --loadstring (patch and --replace-place; for remote-claude's run_luau, e.g. on a test place)",
				});
			}
		} catch {
			// no kernel dir: `kernel deploy` reports that itself
		}
	}

	// Prod signing: key files, the key asset, the place (seeds are never printed; public keys are)
	if (proj) {
		const facts = await withJob("signing keys (key files, key asset, place)", () => gatherKeyFacts({
			config: proj.config,
			paths: signingKeyPaths(proj, args),
			stateDir: stateDir(proj.root),
			assets: keys.assets ? new OpenCloud(keys.assets.key) : undefined,
		}));
		checks.push(...keyChecks(facts));
	}

	// The settings record (deploy key) feeds the backend checks (its backend section, the signed owners) and the Config
	// section; the backend is checked with typetorch.json backend.url and your keys whether or not the record could be read.
	let read: SettingsRead | undefined;
	if (proj) {
		const settingsPart = keys.deploy ? await settingsCheck(new OpenCloud(keys.deploy.key), proj, args) : { checks: [{ name: "settings", status: "warn" as Status, detail: "not read: no deploy key" }] };
		read = "read" in settingsPart ? settingsPart.read : undefined;
		checks.push(...settingsPart.checks);
		checks.push(...(await withJob("backend", () => backendChecks({ configUrl: backendUrl(proj!), creds, body: read?.body, seq: read?.record?.seq, ...deps }))));
	}

	// Scopes, each with its job's key
	const assetsKey = keys.assets;
	const deployKey = keys.deploy;
	const placeKey = keys.place;
	if (proj && (assetsKey || deployKey || placeKey)) {
		const client = (key: typeof assetsKey) => new OpenCloud(key?.key ?? "");
		const { universeId, placeId } = proj.config;
		const scopeMissing = (status: number) => status === 401 || status === 403;
		const skipped = (name: string, job: KeyJob): Promise<Check> => Promise.resolve({ name, status: "warn", detail: `not probed: no ${job} key` });
		const probes = await Promise.all([
			!assetsKey ? skipped("scope assets", "assets") : probe(
				"scope assets",
				() => client(assetsKey).request("GET", "/assets/v1/operations/00000000-0000-0000-0000-000000000000"),
				(status, text) =>
					status === 404 || status === 400
						? ["ok", `asset:read (probe answered ${status})`]
						: scopeMissing(status)
							? ["fail", `missing asset:read/asset:write (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!deployKey ? skipped("scope messaging", "deploy") : probe(
				"scope messaging",
				() => client(deployKey).request("POST", `/cloud/v2/universes/${universeId}:publishMessage`, { json: { topic: "TypeTorch/doctor", message: JSON.stringify({ doctor: true, t: Date.now() }) } }),
				(status, text) =>
					status >= 200 && status < 300
						? ["ok", "universe-messaging-service:publish (published to TypeTorch/doctor)"]
						: scopeMissing(status)
							? ["fail", `missing universe-messaging-service:publish (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!assetsKey ? skipped("scope luau execution", "assets") : probe(
				"scope luau execution",
				() =>
					client(assetsKey).request(
						"GET",
						`/cloud/v2/universes/${universeId}/places/${placeId}/versions/1/luau-execution-sessions/00000000-0000-0000-0000-000000000000/tasks/00000000-0000-0000-0000-000000000000`,
					),
				(status, text) =>
					status === 404
						? ["ok", "universe.place.luau-execution-session:read (typetorch test --cloud; :write is checked by the first task)"]
						: scopeMissing(status)
							? ["fail", `missing universe.place.luau-execution-session:read/:write on the assets key: the cloud test (always on for prod deploys) can't run (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!deployKey ? skipped("scope datastore", "deploy") : probe(
				"scope datastore",
				() => client(deployKey).request("GET", `/cloud/v2/universes/${universeId}/data-stores/${SEQ_DATASTORE}/entries/${HEADS_KEY}`),
				(status, text) =>
					status === 200 || status === 404
						? ["ok", `${DS_READ_SCOPE} (the shared seq: the kernel's DataStore heads; ${DS_WRITE_SCOPES} for the seq counter are checked by the first deploy)`]
						: scopeMissing(status)
							? ["warn", `missing ${DS_READ_SCOPE} on the deploy key: other machines can't share the seq, and the settings record can't be read (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!deployKey ? skipped("scope datastore write", "deploy") : probe(
				"scope datastore write",
				() => {
					// A tiny value under its own key: the durable head write (and the seq counter) need :create and :update.
					const body = JSON.stringify({ doctor: true, t: Date.now() });
					return client(deployKey).request(
						"POST",
						`/datastores/v1/universes/${universeId}/standard-datastores/datastore/entries/entry?datastoreName=${SEQ_DATASTORE}&entryKey=doctor`,
						{ headers: { "content-type": "application/json", "content-md5": createHash("md5").update(body, "utf8").digest("base64") }, body },
					);
				},
				(status, text) =>
					status >= 200 && status < 300
						? ["ok", `${DURABLE_SCOPES} (wrote ${SEQ_DATASTORE}/doctor): deploys store the branch head, so new servers boot it with none running (kernel 0.3.5)`]
						: scopeMissing(status)
							? ["warn", `missing universe-datastores.objects:create/:update on the deploy key: ${NOT_DURABLE}, and the seq counter isn't claimed (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!placeKey ? skipped("scope place publish", "place") : probe(
				"scope place publish",
				() =>
					client(placeKey).request("POST", `/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`, {
						headers: { "content-type": "application/octet-stream" },
						body: new Uint8Array(0),
					}),
				(status, text) =>
					status === 400
						? ["ok", "universe.place:write (empty body rejected with 400, as expected)"]
						: scopeMissing(status)
							? ["info", `no universe.place:write (${status}): only \`kernel deploy --place-file\` (splice engine), \`kernel restore <file>\` and --replace-place publish files; the default luau engine saves through a Luau Execution task (${short(text)})`]
							: status >= 500
								? ["ok", `universe.place:write probably present (an empty body answered ${status}, not 403)`]
								: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!placeKey ? skipped("scope luau (place)", "place") : probe(
				"scope luau (place)",
				() =>
					client(placeKey).request(
						"GET",
						`/cloud/v2/universes/${universeId}/places/${placeId}/versions/1/luau-execution-sessions/00000000-0000-0000-0000-000000000000/tasks/00000000-0000-0000-0000-000000000000`,
					),
				(status, text) => placeLuauProbe(status, text, universeId, placeId),
			),
			!placeKey ? skipped("scope place download", "place") : probe(
				"scope place download",
				// Read-only: answers a presigned location for the place file (not fetched, never printed).
				() => client(placeKey).request("GET", `/asset-delivery-api/v1/assetId/${placeId}`, { retry: false }),
				(status, text) => placeDownloadProbe(status, text),
			),
		]);
		checks.push(...probes.flat());
	}

	const rows = configRows({ proj, config, creds, read, configFlag });
	const failed = checks.filter((c) => c.status === "fail").length;
	if (isJson()) {
		emitJson({ ok: failed === 0, config: rows, checks });
	} else {
		printConfig(rows);
		for (const check of checks) info(`${mark(check.status)}  ${check.name.padEnd(20)} ${check.detail}`);
		info(failed ? red(`${failed} problem(s)`) : green("all required checks passed"));
	}
	if (failed) process.exitCode = 1;
}
