/**
 * `typetorch doctor`: tools, config, env file, API keys per job (never printed), the approval policy, the state dir,
 * the prod signing keys (keycheck.ts: both key files vs typetorch.json, the key asset and the place; mismatches warn),
 * and Open Cloud scopes, each probed with its job's key through harmless calls:
 *   assets       GET an operation that doesn't exist        404 = scope ok, 401/403 = missing
 *   messaging    publish to topic "TypeTorch/doctor"          200 = ok (no server listens to that topic)
 *   settings     GET DataStore TypeTorch entry "settings"    the signed settings record (kernel 0.3.8, plans/20): seq, age,
 *                                                             fields, and whether it verifies with your keys; missing or
 *                                                             not signed by your keys = warn
 *   datastore    GET DataStore TypeTorch entry "heads"         200/404 = ok, 401/403 = missing universe-datastores.objects:read
 *                                                             (the shared seq; :create/:update are checked by a deploy)
 *   datastore write SET DataStore TypeTorch entry "doctor"     200 = ok (a tiny {doctor, t} value), 401/403 = missing
 *                                                             :create/:update: deploys can't store the branch head
 *                                                             durably (durablehead.ts), so they reach only running servers
 *   place publish POST an EMPTY body                         400 = scope ok (body rejected), 403 = missing
 *   fleet API     GET /v1/fleet/servers with the admin token   ok, or a warning (servers, report, alerts, --wait)
 *   luau exec     GET a task that doesn't exist               404 = :read ok, 401/403 = missing (test --cloud; :write
 *                                                             is checked by the first task)
 *   place download GET the place's Asset Delivery location    200 = ok, 403 = info: legacy-asset:manage can't be granted to
 *                                                             API keys today; kernel deploy takes --place-file instead
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParsedArgs, flagString } from "../args.ts";
import { CONFIG_FILE, findProjectRoot, loadProject, type Project } from "../config.ts";
import { JOB_KEY_VARS, JOB_SCOPES, settings, type KeyJob } from "../env.ts";
import { gitInfo } from "../git.ts";
import { emitJson, green, info, isJson, red, yellow } from "../log.ts";
import { OpenCloud } from "../opencloud.ts";
import { FLEET_INGEST_TOKEN_VAR, FLEET_TOKEN_VAR } from "../fleet.ts";
import { describeRollbackSetting, fleetFor, rollbackSetting } from "./fleet.ts";
import { describeHealth, effectiveHealth, HEALTH_DEFAULTS, HEALTH_KERNEL } from "../health.ts";
import { withJob } from "../progress.ts";
import { capture } from "../proc.ts";
import { hasZstd, isBun, runtimeName } from "../runtime.ts";
import { rojoBinary } from "../build.ts";
import { describeFields, readSettings, verifySettingsRecord } from "../settings.ts";
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

export const doctorFlags = { ...KEY_FILE_FLAGS } as const;

function mark(status: Status): string {
	return status === "ok" ? green("ok  ") : status === "info" ? "info" : status === "warn" ? yellow("warn") : red("FAIL");
}

/**
 * The signed settings record (kernel 0.3.8, plans/20): read with the deploy key, verified with your keys (when they load).
 * Never shows a value (tokens).
 */
async function settingsCheck(oc: OpenCloud, proj: Project, args: ParsedArgs): Promise<Check> {
	const name = "settings";
	const read = await withJob(name, () => readSettings(oc, proj.config.universeId));
	if (read.scopeMissing) return { name, status: "warn", detail: `can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${short(read.error ?? "")})` };
	if (read.error) return { name, status: "warn", detail: `reading the settings record failed: ${short(read.error)}` };
	if (read.missing) {
		return { name, status: "warn", detail: "no settings record: servers (kernel 0.3.8) use the defaults. Run typetorch settings push (and fleet setup, access push)" };
	}
	if (!read.record) return { name, status: "warn", detail: `the settings entry isn't a usable record (${read.problem}); servers ignore it. typetorch settings push --force replaces it` };
	const fields = describeFields(read.body ?? {}).map((line) => line.split(/\s+/)[0]).join(", ") || "none";
	let verified = "";
	try {
		const signer = loadSigner(proj, signingKeyPaths(proj, args));
		const by = verifySettingsRecord(read.record, { main: signer.main.publicKey, fallback: signer.fallback.publicKey });
		if (!by) return { name, status: "warn", detail: `#${read.record.seq} (${read.record.at}) is NOT signed by your keys: servers that trust other keys refuse it. Rewrite it (typetorch settings push --force)` };
		verified = `, verified by your ${by === "sig" ? "main" : "fallback"} key`;
	} catch {
		verified = ", not checked (your signing keys don't load here)";
	}
	return { name, status: "ok", detail: `#${read.record.seq} written ${read.record.at}${verified}; fields: ${fields}` };
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

const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 160);

/** The Asset Delivery probe (kernel deploy downloads the place to patch it): 200 = legacy-asset:manage present. */
export function placeDownloadProbe(status: number, text: string): [Status, string] {
	if (status === 200) return ["ok", "legacy-asset:manage (the place file can be downloaded for `kernel deploy`)"];
	if (status === 401 || status === 403) {
		return [
			"info",
			`no place download (${status}): it needs legacy-asset:manage, which can't be granted to API keys today. \`typetorch kernel deploy\` takes a copy instead: download one in Studio (File > Download a Copy) and pass --place-file <file> --base <version>`,
		];
	}
	// Never echo a 2xx body: it holds a presigned URL.
	return ["warn", `unexpected ${status}${status >= 300 ? ` ${short(text)}` : ""}`];
}

export async function doctorCommand(args: ParsedArgs) {
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

	// Env file, keys (one per job, else the shared key), approval, state dir
	const config = settings();
	if (config.envFile) {
		checks.push({
			name: "env file",
			status: config.envFileMissing ? "fail" : "ok",
			detail: `${config.envFile}${config.envFileMissing ? " does not exist" : ""}`,
		});
	} else {
		checks.push({ name: "env file", status: "warn", detail: `none (TYPETORCH_ENV_FILE); keys come from .env files here or above: ${config.files.join(", ") || "none"}. A file outside the repo is safer` });
	}
	const keys: Record<KeyJob, ReturnType<typeof config.apiKey>> = { assets: config.apiKey("assets"), deploy: config.apiKey("deploy"), place: config.apiKey("place") };
	for (const job of ["assets", "deploy", "place"] as const) {
		const key = keys[job];
		checks.push(
			key
				? { name: `key ${job}`, status: "ok", detail: `${key.name} from ${key.source}${key.dedicated ? "" : ` (shared; ${JOB_KEY_VARS[job]} would separate it)`}` }
				: { name: `key ${job}`, status: job === "place" ? "warn" : "fail", detail: `none: set ${JOB_KEY_VARS[job]} (${JOB_SCOPES[job]}) or the shared TYPETORCH_API_KEY` },
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

	// The fleet API (servers, report, alerts, --wait and auto-rollback); tokens are never printed.
	if (proj) {
		const setup = fleetFor(proj);
		if (!setup.client) {
			checks.push({ name: "fleet API", status: "info", detail: `${setup.missing}; servers/report/alerts and --wait (with auto-rollback) are off until then` });
		} else {
			try {
				const servers = await withJob("fleet API", () => setup.client!.servers({}));
				const ingest = setup.ingest ? "" : `; no ${FLEET_INGEST_TOKEN_VAR}: the CLI can't post alerts (auto_rollback, server_stuck) or run fleet setup`;
				checks.push({ name: "fleet API", status: "ok", detail: `${new URL(setup.url).host}: ${servers.length} live server(s)${ingest}` });
			} catch (error) {
				checks.push({ name: "fleet API", status: "warn", detail: (error as Error).message });
			}
		}
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
			!deployKey ? skipped("settings", "deploy") : settingsCheck(client(deployKey), proj, args),
			!deployKey ? skipped("scope datastore", "deploy") : probe(
				"scope datastore",
				() => client(deployKey).request("GET", `/cloud/v2/universes/${universeId}/data-stores/${SEQ_DATASTORE}/entries/${HEADS_KEY}`),
				(status, text) =>
					status === 200 || status === 404
						? ["ok", `${DS_READ_SCOPE} (the shared seq: the kernel's DataStore heads; ${DS_WRITE_SCOPES} for the seq counter are checked by the first deploy)`]
						: scopeMissing(status)
							? ["warn", `missing ${DS_READ_SCOPE} on the deploy key: other machines and CI can't share the seq, and CI deploys (--require-shared-seq) stop (${status} ${short(text)})`]
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
							? ["warn", `missing universe.place:write: \`typetorch kernel deploy\` won't work (${status} ${short(text)})`]
							: status >= 500
								? ["ok", `universe.place:write probably present (an empty body answered ${status}, not 403)`]
								: ["warn", `unexpected ${status} ${short(text)}`],
			),
			!placeKey ? skipped("scope place download", "place") : probe(
				"scope place download",
				// Read-only: answers a presigned location for the place file (not fetched, never printed).
				() => client(placeKey).request("GET", `/asset-delivery-api/v1/assetId/${placeId}`, { retry: false }),
				(status, text) => placeDownloadProbe(status, text),
			),
		]);
		checks.push(...probes);
	}

	const failed = checks.filter((c) => c.status === "fail").length;
	if (isJson()) {
		emitJson({ ok: failed === 0, checks });
	} else {
		for (const check of checks) info(`${mark(check.status)}  ${check.name.padEnd(20)} ${check.detail}`);
		info(failed ? red(`${failed} problem(s)`) : green("all required checks passed"));
	}
	if (failed) process.exitCode = 1;
}
