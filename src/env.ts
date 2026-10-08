/**
 * Settings from the real environment and the game repo's `.env`, held in an explicit object. Nothing read from a file is
 * ever copied into process.env (security audit S-H2), and child processes get an explicit, minimal environment
 * (`childEnv`): OS, PATH and home-type variables only, never a key.
 *
 * Per game repo (plans/21 B): secrets in `.env` (gitignored, next to typetorch.json), everything else in typetorch.json.
 * Where a value comes from, highest priority first:
 *   1. the real environment (`export ...`, a shell, a container);
 *   2. the game repo's `.env`: the folder holding typetorch.json (`--config`'s folder, else the nearest one at or above
 *      the working directory, else the working directory). No other `.env` file is read (before CLI 0.9 every parent
 *      folder's `.env` counted too).
 * `--env-file <path>` or TYPETORCH_ENV_FILE (real environment) is an override: that file is read INSTEAD of the game's
 * `.env`. A `TYPETORCH_ENV_FILE=` line inside the game's `.env` (the CLI 0.8 layout) is still followed for one release
 * (that file wins over the `.env`), with a warning.
 * Values Bun auto-loads from the working directory's `.env*` files are not "the environment": they count as the file they
 * came from (and `.env.local` & co. don't count at all), so Bun and Node read the same values.
 * Values are never printed: only variable names and file paths.
 *
 * Open Cloud keys, one per job (decision D4; each falls back to the shared key):
 *   OPENCLOUD_ASSETS_KEY  asset uploads and moderation polling        asset:read, asset:write
 *                         hot assets (assets sync/status), the cloud test (typetorch test --cloud, the
 *                         pre-publish gate) and doctor's place check, also
 *                         universe.place.luau-execution-session:read + :write
 *   OPENCLOUD_DEPLOY_KEY  deploy messages, the shared seq (seqstore.ts), the durable heads and the signed settings
 *                         record (settings.ts: `settings`, `backend setup`, `access push`):
 *                         universe-messaging-service:publish; universe-datastores.objects:read, :create and :update
 *   OPENCLOUD_PLACE_KEY   kernel deploy / restore (manual only)      universe.place.luau-execution-session:read + :write
 *                         (the default luau engine: a task patches and saves the place), asset:read (place versions);
 *                         universe.place:write only to publish files (--place-file / restore <file> / --replace-place).
 *                         Roblox has no API-key route for downloading place files (legacy-asset:manage can't be
 *                         granted; universe.place:read only covers the version history)
 *   shared: OPENCLOUD_API_KEY (ROBLOX_API_KEY is an alias). Since CLI 0.9 TYPETORCH_API_KEY is never a Roblox key.
 *
 * The TypeTorch backend (backend.ts): TYPETORCH_API_KEY = the backend's GAME key (write-only: game servers and the CLI's
 * alerts post with it; it goes into the signed settings record), TYPETORCH_ADMIN_TOKEN = its admin token (reads, the
 * owner list; it never leaves this PC). Old names, read for one release with a warning: TYPETORCH_FLEET_TOKEN (the admin
 * token) and TYPETORCH_FLEET_INGEST_TOKEN (the game key).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The shared Open Cloud key variables, in priority order (used by every job without its own key). */
export const API_KEY_VARS = ["OPENCLOUD_API_KEY", "ROBLOX_API_KEY"] as const;

export type KeyJob = "assets" | "deploy" | "place";

export const JOB_KEY_VARS: Record<KeyJob, string> = {
	assets: "OPENCLOUD_ASSETS_KEY",
	deploy: "OPENCLOUD_DEPLOY_KEY",
	place: "OPENCLOUD_PLACE_KEY",
};

export const JOB_SCOPES: Record<KeyJob, string> = {
	assets: "asset:read, asset:write (+ universe.place.luau-execution-session:read/write for test --cloud, assets sync/status and doctor's place check)",
	deploy: "universe-messaging-service:publish, universe-datastores.objects:read, :create and :update (seqs, durable heads, the signed settings)",
	place: "universe.place.luau-execution-session:read/write, asset:read (+ universe.place:write to publish --place-file patches; no API key can download a place)",
};

export const ENV_FILE_VAR = "TYPETORCH_ENV_FILE";
/** Extra variable names (comma-separated) that child processes may inherit; keys are never passed. */
export const CHILD_ENV_VAR = "TYPETORCH_CHILD_ENV";

/** The TypeTorch backend's game key (write-only; what game servers hold in the settings record). */
export const BACKEND_KEY_VAR = "TYPETORCH_API_KEY";
/** The TypeTorch backend's admin token (reads, the owner list). */
export const ADMIN_TOKEN_VAR = "TYPETORCH_ADMIN_TOKEN";
/** CLI 0.7-0.8 names of the backend's two secrets: still read in CLI 0.9 (one release), with a warning. */
export const LEGACY_BACKEND_VARS: Readonly<Record<string, typeof BACKEND_KEY_VAR | typeof ADMIN_TOKEN_VAR>> = {
	TYPETORCH_FLEET_TOKEN: ADMIN_TOKEN_VAR,
	TYPETORCH_FLEET_INGEST_TOKEN: BACKEND_KEY_VAR,
};

/** CLI 0.2's plaintext signing seed variable: no longer read, but still a secret wherever it is left. */
export const LEGACY_SIGNING_KEY_VAR = "TYPETORCH_SIGNING_KEY";
/** Variables holding secrets: never passed to a child, always redacted. */
export const SECRET_VARS: readonly string[] = [
	...API_KEY_VARS,
	...Object.values(JOB_KEY_VARS),
	BACKEND_KEY_VAR,
	ADMIN_TOKEN_VAR,
	...Object.keys(LEGACY_BACKEND_VARS),
	LEGACY_SIGNING_KEY_VAR,
];

/** The signing key files (keyfiles.ts). Read from the real environment only; never passed to a child process. */
export const KEY_FILE_VAR = "TYPETORCH_KEY_FILE";
export const FALLBACK_KEY_FILE_VAR = "TYPETORCH_FALLBACK_KEY_FILE";
export const KEY_PATH_VARS = [KEY_FILE_VAR, FALLBACK_KEY_FILE_VAR] as const;
/** Never inherited by a child process, even when listed in TYPETORCH_CHILD_ENV. */
export const NEVER_CHILD_VARS: readonly string[] = [...SECRET_VARS, ...KEY_PATH_VARS];

/** Secret values read at run time (signing seeds): redacted like the keys. Never printed. */
const runtimeSecrets = new Set<string>();

/** Registers a secret value (a seed read from a key file) so `redact` and `childEnv` treat it like a key. */
export function registerSecret(value: string | undefined) {
	if (value && value.length >= 8) runtimeSecrets.add(value);
}

export function parseDotEnv(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2];
		const quote = value[0];
		if ((quote === '"' || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) {
			value = value.slice(1, value.lastIndexOf(quote));
			if (quote === '"') value = value.replace(/\\n/g, "\n");
		} else {
			// Unquoted: strip a trailing " # comment".
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values[match[1]] = value;
	}
	return values;
}

/** The game repo for a folder: the nearest folder at or above it that holds typetorch.json, else the folder itself. */
export function gameDirFor(startDir: string): string {
	const start = resolve(startDir);
	let dir = start;
	while (true) {
		if (existsSync(join(dir, "typetorch.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** `~/x` → home; relative paths against `base`. */
export function expandPath(path: string, base: string): string {
	const home = path === "~" || path.startsWith("~/") || path.startsWith("~\\");
	if (home) return join(homedir(), path.slice(1));
	return isAbsolute(path) ? path : resolve(base, path);
}

export interface Setting {
	value: string;
	/** Env file path, or "environment". */
	source: string;
}

export interface ApiKeyInfo {
	key: string;
	/** Variable name. */
	name: string;
	/** Env file path, or "environment". */
	source: string;
	/** True when this is the job's own key, false for the shared fallback. */
	dedicated: boolean;
}

export interface SettingsOptions {
	/** The game repo whose `.env` is read (default: `gameDirFor(startDir)`). */
	gameDir?: string;
	/** Where the typetorch.json search starts (default: the working directory). */
	startDir?: string;
	/** `--env-file`; wins over TYPETORCH_ENV_FILE. Read instead of the game's `.env`. */
	envFile?: string;
	/** The real environment (default: process.env). */
	env?: Record<string, string | undefined>;
}

export class Settings {
	/** Every env file read, highest priority first. */
	readonly files: string[] = [];
	/** The game repo whose `.env` is the default env file. */
	readonly gameDir: string;
	/** The game repo's `.env` (read unless an override replaces it; it may not exist). */
	readonly dotEnv: string;
	/** The override (`--env-file`, else TYPETORCH_ENV_FILE from the real environment), resolved; it replaces `.env`. */
	readonly envFile?: string;
	/** Where the override came from. */
	readonly envFileFrom?: "--env-file" | typeof ENV_FILE_VAR;
	readonly envFileMissing: boolean = false;
	/** The CLI 0.8 layout: a `TYPETORCH_ENV_FILE=` line inside the game's `.env` (followed for one more release). */
	readonly declaredEnvFile?: string;
	readonly declaredEnvFileMissing: boolean = false;
	/** One-line notes about old layouts (names and paths, never values); the entry point prints them. */
	readonly warnings: string[] = [];
	private readonly values = new Map<string, Setting>();
	private readonly real: Record<string, string | undefined>;
	/** Values Bun auto-loaded from the working directory's .env files (they look like real env vars, but aren't). */
	private readonly autoLoaded = new Map<string, string[]>();

	constructor(options: SettingsOptions = {}) {
		this.real = options.env ?? process.env;
		if (!options.env) for (const [key, values] of autoLoadedDotEnv(process.cwd())) this.autoLoaded.set(key, values);
		this.gameDir = resolve(options.gameDir ?? gameDirFor(options.startDir ?? process.cwd()));
		this.dotEnv = join(this.gameDir, ".env");

		// The override: --env-file, else TYPETORCH_ENV_FILE from the real environment (both relative to the working dir).
		const fromEnv = this.realValue(ENV_FILE_VAR);
		let override: string | undefined;
		if (options.envFile?.trim()) {
			override = expandPath(options.envFile.trim(), process.cwd());
			this.envFileFrom = "--env-file";
		} else if (fromEnv) {
			override = expandPath(fromEnv, process.cwd());
			this.envFileFrom = ENV_FILE_VAR;
		}
		const sources: string[] = [];
		if (override) {
			this.envFile = override;
			if (existsSync(override)) sources.push(override);
			else this.envFileMissing = true;
		} else {
			const declared = readEnvFile(this.dotEnv)?.[ENV_FILE_VAR]?.trim();
			if (declared) {
				// CLI 0.8 recommended a repo .env holding only this line, pointing at a file outside the repo.
				this.declaredEnvFile = expandPath(declared, this.gameDir);
				if (existsSync(this.declaredEnvFile)) sources.push(this.declaredEnvFile);
				else this.declaredEnvFileMissing = true;
				this.warnings.push(
					`${this.dotEnv} names another env file (${ENV_FILE_VAR}=...${this.declaredEnvFileMissing ? ", which doesn't exist" : ""}). CLI 0.9 still reads it, for this release only: move its keys into the game repo's .env and delete that line (or set ${ENV_FILE_VAR} in the environment)`,
				);
			}
			sources.push(this.dotEnv);
		}
		for (const file of sources) {
			const values = readEnvFile(file);
			if (!values || this.files.includes(file)) continue;
			this.files.push(file);
			for (const [key, value] of Object.entries(values)) {
				if (key === ENV_FILE_VAR) continue;
				if (!this.values.has(key) && value !== "") this.values.set(key, { value, source: file });
			}
		}
	}

	/** A value from the real environment, unless Bun only auto-loaded it from a `.env*` file in the working directory. */
	private realValue(name: string): string | undefined {
		const real = this.real[name]?.trim();
		if (!real) return undefined;
		if (this.autoLoaded.get(name)?.some((value) => value.trim() === real)) return undefined;
		return real;
	}

	get(name: string): Setting | undefined {
		const real = this.realValue(name);
		if (real) return { value: real, source: "environment" };
		return this.values.get(name);
	}

	first(names: readonly string[]): (Setting & { name: string }) | undefined {
		for (const name of names) {
			const found = this.get(name);
			if (found) return { ...found, name };
		}
		return undefined;
	}

	/** Where values come from, in words: "the environment, then <file>". */
	describeSources(): string {
		if (this.envFile) return `the environment, then ${this.envFile}${this.envFileMissing ? " (missing)" : ""} (${this.envFileFrom}, read instead of ${this.dotEnv})`;
		const named = this.declaredEnvFile ? `${this.declaredEnvFile}${this.declaredEnvFileMissing ? " (missing)" : ""} (named in it), then ` : "";
		return `the environment, then ${named}${this.dotEnv}${existsSync(this.dotEnv) ? "" : " (missing)"}`;
	}

	/** The key for a job: its own variable, else the shared one. Without a job: the shared key only. */
	apiKey(job?: KeyJob): ApiKeyInfo | undefined {
		if (job) {
			const own = this.first([JOB_KEY_VARS[job]]);
			if (own) return { key: own.value, name: own.name, source: own.source, dedicated: true };
		}
		const shared = this.first(API_KEY_VARS);
		return shared ? { key: shared.value, name: shared.name, source: shared.source, dedicated: false } : undefined;
	}

	requireApiKey(job: KeyJob): ApiKeyInfo {
		const found = this.apiKey(job);
		if (found) return found;
		// CLI 0.8 read TYPETORCH_API_KEY as the shared Open Cloud key: say what changed instead of only "no key".
		const renamed = this.get(BACKEND_KEY_VAR)
			? `. ${BACKEND_KEY_VAR} is set, but since CLI 0.9 it is the TypeTorch backend's game key, never a Roblox key: if it holds your Open Cloud key, rename it to OPENCLOUD_API_KEY`
			: "";
		throw new Error(`no Open Cloud API key for ${job}: set ${JOB_KEY_VARS[job]} (scopes ${JOB_SCOPES[job]}) or ${API_KEY_VARS.join(" / ")} in ${this.describeSources()}${renamed}`);
	}

	/** Every secret value known (for redaction): the keys, and seeds read from key files. */
	secrets(): string[] {
		const out: string[] = [...runtimeSecrets];
		for (const name of SECRET_VARS) {
			const setting = this.get(name);
			if (setting) out.push(setting.value);
		}
		return out;
	}
}

function readEnvFile(file: string): Record<string, string> | undefined {
	try {
		return parseDotEnv(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Key -> values found in the working directory's `.env*` files (what Bun loads into process.env by itself). */
function autoLoadedDotEnv(cwd: string): Map<string, string[]> {
	const found = new Map<string, string[]>();
	let names: string[] = [];
	try {
		names = readdirSync(cwd).filter((name) => /^\.env(\..+)?$/.test(name));
	} catch {}
	for (const name of names) {
		for (const [key, value] of Object.entries(readEnvFile(join(cwd, name)) ?? {})) {
			if (!found.has(key)) found.set(key, []);
			found.get(key)!.push(value);
		}
	}
	return found;
}

// The settings of this run -------------------------------------------------------------------------------------------

let current: Settings | undefined;

/** The settings of this run (loaded on first use from the working directory). */
export function settings(): Settings {
	current ??= new Settings();
	return current;
}

/** Replaces the settings of this run (the entry point, with --env-file; tests). */
export function useSettings(next: Settings | undefined) {
	current = next;
}

/** Removes every known secret from text before it is printed (defense in depth: responses should never echo it). */
export function redact(text: string): string {
	let out = text;
	for (const secret of settings().secrets()) {
		if (secret.length >= 8) out = out.split(secret).join("<secret>");
	}
	return out;
}

// Child processes ------------------------------------------------------------------------------------------------------

/**
 * The only variables a child process (rbxtsc, rojo, lune, bun scripts, git) inherits: what the OS, git, Bun, Rokit and
 * the Roblox tools need to run. An allowlist, not a denylist, so a secret under an unexpected name never reaches a
 * build script or a dependency's postinstall. Compared case-insensitively (Windows). Mirrors dev-server/src/env.ts.
 */
export const CHILD_ENV_ALLOW: ReadonlySet<string> = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"TEMP",
	"TMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"USER",
	"LOGNAME",
	"USERNAME",
	"USERDOMAIN",
	"COMPUTERNAME",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"NUMBER_OF_PROCESSORS",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"SHELL",
	"NO_COLOR",
	"FORCE_COLOR",
	"CI",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"BUN_INSTALL",
	"ROKIT_ROOT",
]);

/**
 * The environment for a child process: CHILD_ENV_ALLOW plus the names listed in TYPETORCH_CHILD_ENV (secrets never),
 * minus anything Bun auto-loaded from a .env file and any value equal to a known secret; then `extra`.
 */
export function childEnv(extra: Record<string, string> = {}, options: { env?: Record<string, string | undefined>; settings?: Settings } = {}): Record<string, string> {
	const real = options.env ?? process.env;
	const config = options.settings ?? settings();
	const secretNames = new Set(NEVER_CHILD_VARS.map((name) => name.toUpperCase()));
	const allow = new Set(CHILD_ENV_ALLOW);
	for (const name of (config.get(CHILD_ENV_VAR)?.value ?? "").split(",")) {
		const upper = name.trim().toUpperCase();
		if (upper && !secretNames.has(upper)) allow.add(upper);
	}
	const secrets = new Set(config.secrets().filter((s) => s.length >= 8));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(real)) {
		if (value === undefined) continue;
		const upper = key.toUpperCase();
		if (!allow.has(upper) || secretNames.has(upper) || secrets.has(value)) continue;
		if (config.get(key)?.source !== "environment" && options.env === undefined) continue; // auto-loaded from a .env file
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return { ...env, ...extra };
}
