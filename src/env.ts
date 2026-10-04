/**
 * Settings from the environment and `.env` files. `.env` files are read from the working directory and every parent
 * folder; the nearest file wins and real environment variables are never overridden. The API key is never printed:
 * only the variable name and the file it came from are ever shown.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Accepted API key variables, in priority order. */
export const API_KEY_VARS = ["TYPETORCH_API_KEY", "OPENCLOUD_API_KEY", "ROBLOX_API_KEY"] as const;

/** Where each variable we set came from (`.env` path); variables not listed came from the real environment. */
const sources = new Map<string, string>();
let loadedFiles: string[] = [];

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

/** Loads every `.env` from `startDir` upwards into process.env (nearest wins, real env vars untouched). */
export function loadDotEnv(startDir: string = process.cwd()): string[] {
	const real = new Set(Object.keys(process.env).filter((key) => !sources.has(key)));
	loadedFiles = dotEnvChain(startDir);
	for (const file of loadedFiles) {
		let values: Record<string, string>;
		try {
			values = parseDotEnv(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		for (const [key, value] of Object.entries(values)) {
			if (real.has(key) || sources.has(key)) continue; // a real var, or a nearer file already set it
			process.env[key] = value;
			sources.set(key, file);
		}
	}
	return loadedFiles;
}

export function dotEnvFiles(): string[] {
	return loadedFiles;
}

export interface ApiKeyInfo {
	key: string;
	/** Variable name. */
	name: string;
	/** `.env` path, or "environment". */
	source: string;
}

export function findApiKey(): ApiKeyInfo | undefined {
	for (const name of API_KEY_VARS) {
		const key = process.env[name]?.trim();
		if (key) return { key, name, source: sources.get(name) ?? "environment" };
	}
	return undefined;
}

export function requireApiKey(): ApiKeyInfo {
	const found = findApiKey();
	if (!found) {
		throw new Error(
			`no Open Cloud API key: set ${API_KEY_VARS.join(", ")} (environment or a .env file in this folder or a parent)`,
		);
	}
	return found;
}

/** Removes the API key from text before it is printed (defense in depth: responses should never echo it). */
export function redact(text: string): string {
	const found = findApiKey();
	if (!found || found.key.length < 8) return text;
	return text.split(found.key).join("<api key>");
}
