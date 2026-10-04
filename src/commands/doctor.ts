/**
 * `typetorch doctor`: tools, config, API key (never printed) and Open Cloud scopes, probed with harmless calls:
 *   assets       GET an operation that doesn't exist        404 = scope ok, 401/403 = missing
 *   messaging    publish to topic "TypeTorch/doctor"          200 = ok (no server listens to that topic)
 *   configs read GET the InExperienceConfig repository       200/404 = ok, 401/403 = missing universe:read
 *   configs write not probed (needs universe:write; a probe would have to touch the draft)
 *   place publish POST an EMPTY body                         400 = scope ok (body rejected), 403 = missing
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParsedArgs, flagString } from "../args";
import { CONFIG_FILE, findProjectRoot, loadProject, type Project } from "../config";
import { dotEnvFiles, findApiKey } from "../env";
import { gitInfo } from "../git";
import { emitJson, green, info, isJson, red, yellow } from "../log";
import { OpenCloud } from "../opencloud";
import { capture } from "../proc";
import { rojoBinary } from "../build";
import { REPOSITORY } from "../registry";

export const doctorFlags = {} as const;

type Status = "ok" | "warn" | "fail";
interface Check {
	name: string;
	status: Status;
	detail: string;
}

function mark(status: Status): string {
	return status === "ok" ? green("ok  ") : status === "warn" ? yellow("warn") : red("FAIL");
}

async function probe(
	name: string,
	fn: () => Promise<{ status: number; text: string }>,
	interpret: (status: number, text: string) => [Status, string],
): Promise<Check> {
	try {
		const { status, text } = await fn();
		const [result, detail] = interpret(status, text);
		return { name, status: result, detail };
	} catch (error) {
		return { name, status: "fail", detail: `request failed: ${(error as Error).message}` };
	}
}

const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 160);

export async function doctorCommand(args: ParsedArgs) {
	const checks: Check[] = [];
	const cwd = process.cwd();

	checks.push({ name: "bun", status: "ok", detail: Bun.version });

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

	// API key
	const key = findApiKey();
	checks.push(
		key
			? { name: "api key", status: "ok", detail: `${key.name} from ${key.source} (${key.key.length} chars)` }
			: {
					name: "api key",
					status: "fail",
					detail: `none (set TYPETORCH_API_KEY, OPENCLOUD_API_KEY or ROBLOX_API_KEY; .env files read: ${dotEnvFiles().join(", ") || "none"})`,
				},
	);

	// Scopes
	if (key && proj) {
		const oc = new OpenCloud(key.key);
		const { universeId, placeId } = proj.config;
		const configsBase = `/creator-configs-public-api/v1/configs/universes/${universeId}/repositories/${REPOSITORY}`;
		const scopeMissing = (status: number) => status === 401 || status === 403;
		const probes = await Promise.all([
			probe(
				"scope assets",
				() => oc.request("GET", "/assets/v1/operations/00000000-0000-0000-0000-000000000000"),
				(status, text) =>
					status === 404 || status === 400
						? ["ok", `asset:read (probe answered ${status})`]
						: scopeMissing(status)
							? ["fail", `missing asset:read/asset:write (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			probe(
				"scope messaging",
				() => oc.request("POST", `/cloud/v2/universes/${universeId}:publishMessage`, { json: { topic: "TypeTorch/doctor", message: JSON.stringify({ doctor: true, t: Date.now() }) } }),
				(status, text) =>
					status >= 200 && status < 300
						? ["ok", "universe-messaging-service:publish (published to TypeTorch/doctor)"]
						: scopeMissing(status)
							? ["fail", `missing universe-messaging-service:publish (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			probe(
				"scope configs read",
				() => oc.request("GET", configsBase),
				(status, text) =>
					status === 200 || status === 404
						? ["ok", `universe:read (${status === 404 ? "no published config yet" : "repository readable"})`]
						: scopeMissing(status)
							? ["warn", `missing universe:read: the registry is skipped, servers persist heads from deploy messages (${status} ${short(text)})`]
							: ["warn", `unexpected ${status} ${short(text)}`],
			),
			Promise.resolve<Check>({
				name: "scope configs write",
				status: "warn",
				detail: "not probed: registry writes need universe:write (checked by the first deploy; without it deploys skip the registry)",
			}),
			probe(
				"scope place publish",
				() =>
					oc.request("POST", `/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`, {
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
