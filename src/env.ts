/**
 * Settings from the real environment and env files, held in an explicit object. Nothing read from a file is ever
 * copied into process.env (security audit S-H2), and child processes get an explicit, minimal environment
 * (`childEnv`): OS, PATH and home-type variables only, never a key.
 *
 * Where a value comes from, highest priority first:
 *   1. the real environment (CI secrets, `export ...`);
 *   2. the env file named by `--env-file` or TYPETORCH_ENV_FILE (recommended: outside the repo tree, e.g.
 *      ~/.config/typetorch/<game>.env, so no tool that reads the repo can see the keys);
 *   3. `.env` files in the working directory and every parent folder (the nearest file wins).
 * Values are never printed: only variable names and file paths.
 *
 * Open Cloud keys, one per job (decision D4; each falls back to the shared key):
 *   OPENCLOUD_ASSETS_KEY  asset uploads and moderation polling        asset:read, asset:write
 *   OPENCLOUD_DEPLOY_KEY  deploy messages and the ConfigService registry
 *                         universe-messaging-service:publish, universe:read (+ universe:write to write the registry)
 *   OPENCLOUD_PLACE_KEY   kernel deploy (place publish; manual only)  universe.place:write (+ asset:read to record the
 *                         place version before publishing)
 *   shared fallback: TYPETORCH_API_KEY, OPENCLOUD_API_KEY or ROBLOX_API_KEY
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseSigningKey, SIGNING_KEY_VAR, type SigningKey } from "./signing";

/** The shared key variables, in priority order (used by every job without its own key). */
export const API_KEY_VARS = ["TYPETORCH_API_KEY", "OPENCLOUD_API_KEY", "ROBLOX_API_KEY"] as const;

export type KeyJob = "assets" | "deploy" | "place";

export const JOB_KEY_VARS: Record<KeyJob, string> = {
	assets: "OPENCLOUD_ASSETS_KEY",
	deploy: "OPENCLOUD_DEPLOY_KEY",
	place: "OPENCLOUD_PLACE_KEY",
};

export const JOB_SCOPES: Record<KeyJob, string> = {
	assets: "asset:read, asset:write",
	deploy: "universe-messaging-service:publish, universe:read (+ universe:write for the registry)",
	place: "universe.place:write (+ asset:read to record the place version)",
};

export const ENV_FILE_VAR = "TYPETORCH_ENV_FILE";
/** Extra variable names (comma-separated) that child processes may inherit; keys are never passed. */
export const CHILD_ENV_VAR = "TYPETORCH_CHILD_ENV";

/** Variables holding secrets: never passed to a child, always redacted. */
export const SECRET_VARS: readonly string[] = [...API_KEY_VARS, ...Object.values(JOB_KEY_VARS), SIGNING_KEY_VAR];
/** CI opt-in for signing with TYPETORCH_SIGNING_KEY from the environment (see `Settings.ciSigningKey`). */
export const ALLOW_ENV_SIGNING_VAR = "TYPETORCH_ALLOW_ENV_SIGNING_KEY";

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

/** The `.env` files from `startDir` up to the filesystem root, nearest first. */
export function dotEnvChain(startDir: string): string[] {
	const files: string[] = [];
	let dir = resolve(startDir);
	while (true) {
		const file = join(dir, ".env");
		if (existsSync(file)) files.push(file);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return files;
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
	/** Where the `.env` search starts (default: the working directory). */
	startDir?: string;
	/** `--env-file`; wins over TYPETORCH_ENV_FILE. */
	envFile?: string;
	/** The real environment (default: process.env). */
	env?: Record<string, string | undefined>;
}

export class Settings {
	/** Every env file read, highest priority first. */
	readonly files: string[] = [];
	/** The explicit env file (flag or TYPETORCH_ENV_FILE), resolved; undefined when none is configured. */
	readonly envFile?: string;
	readonly envFileMissing: boolean = false;
	private readonly values = new Map<string, Setting>();
	private readonly real: Record<string, string | undefined>;
	/** Values Bun auto-loaded from the working directory's .env files (they look like real env vars). */
	private readonly autoLoaded = new Map<string, Setting>();

	constructor(options: SettingsOptions = {}) {
		const startDir = resolve(options.startDir ?? process.cwd());
		this.real = options.env ?? process.env;
		const chain = dotEnvChain(startDir);
		const chainValues = chain.map((file) => ({ file, values: readEnvFile(file) }));

		// The explicit env file: --env-file, else TYPETORCH_ENV_FILE from the environment or the nearest .env.
		let envFile: string | undefined;
		if (options.envFile) envFile = expandPath(options.envFile, process.cwd());
		else if (this.real[ENV_FILE_VAR]?.trim()) envFile = expandPath(this.real[ENV_FILE_VAR]!.trim(), process.cwd());
		else {
			const declared = chainValues.find((c) => c.values?.[ENV_FILE_VAR]?.trim());
			if (declared) envFile = expandPath(declared.values![ENV_FILE_VAR].trim(), dirname(declared.file));
		}
		this.envFile = envFile;
		const sources: { file: string; values?: Record<string, string> }[] = [];
		if (envFile) {
			if (existsSync(envFile)) sources.push({ file: envFile, values: readEnvFile(envFile) });
			else this.envFileMissing = true;
		}
		sources.push(...chainValues);
		for (const { file, values } of sources) {
			if (!values || this.files.includes(file)) continue;
			this.files.push(file);
			for (const [key, value] of Object.entries(values)) {
				if (!this.values.has(key) && value !== "") this.values.set(key, { value, source: file });
			}
		}
		// Bun loads .env, .env.local, ... from the working directory into process.env by itself. Those are local
		// secrets, not environment: remember them so they are reported by file and never passed to children.
		if (!options.env) {
			for (const [key, setting] of autoLoadedDotEnv(process.cwd())) this.autoLoaded.set(key, setting);
		}
	}

	get(name: string): Setting | undefined {
		const real = this.real[name]?.trim();
		if (real) {
			const auto = this.autoLoaded.get(name);
			return { value: real, source: auto && auto.value === real ? auto.source : "environment" };
		}
		return this.values.get(name);
	}

	first(names: readonly string[]): (Setting & { name: string }) | undefined {
		for (const name of names) {
			const found = this.get(name);
			if (found) return { ...found, name };
		}
		return undefined;
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
		const where = this.envFile
			? `${this.envFile}${this.envFileMissing ? " (missing)" : ""}, the environment, or a .env file here or in a parent folder`
			: `the environment, a ${ENV_FILE_VAR} file, or a .env file here or in a parent folder`;
		throw new Error(`no Open Cloud API key for ${job}: set ${JOB_KEY_VARS[job]} (scopes ${JOB_SCOPES[job]}) or ${API_KEY_VARS.join(", ")} in ${where}`);
	}

	/**
	 * A plaintext TYPETORCH_SIGNING_KEY wherever it is (environment or an env file): only for migrating it into an
	 * encrypted key file, and for warnings. Never used to sign except through `ciSigningKey`. Throws (without the value)
	 * when it is malformed.
	 */
	plaintextSigningKey(): (SigningKey & { source: string; seed: string }) | undefined {
		const setting = this.get(SIGNING_KEY_VAR);
		if (!setting) return undefined;
		return { ...parseSigningKey(setting.value), source: setting.source, seed: setting.value.trim() };
	}

	/**
	 * The CI escape hatch: TYPETORCH_SIGNING_KEY signs without a person only when BOTH it and
	 * TYPETORCH_ALLOW_ENV_SIGNING_KEY=1 come from the real environment (not from any file, not from a .env Bun loaded).
	 * Off by default; meant for a CI secret, never for a dev machine.
	 */
	ciSigningKey(): (SigningKey & { source: string }) | undefined {
		const allow = this.get(ALLOW_ENV_SIGNING_VAR);
		const setting = this.get(SIGNING_KEY_VAR);
		if (allow?.value !== "1" || allow.source !== "environment" || setting?.source !== "environment") return undefined;
		return { ...parseSigningKey(setting.value), source: "environment" };
	}

	/** Every secret value known (for redaction). */
	secrets(): string[] {
		const out: string[] = [];
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

function autoLoadedDotEnv(cwd: string): Map<string, Setting> {
	const found = new Map<string, Setting>();
	let names: string[] = [];
	try {
		names = readdirSync(cwd).filter((name) => /^\.env(\..+)?$/.test(name));
	} catch {}
	for (const name of names) {
		const values = readEnvFile(join(cwd, name)) ?? {};
		for (const [key, value] of Object.entries(values)) if (!found.has(key)) found.set(key, { value, source: join(cwd, name) });
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
	const secretNames = new Set(SECRET_VARS.map((name) => name.toUpperCase()));
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
