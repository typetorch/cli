/**
 * The two signing keys at rest (decision D1 reopened, plans/03 "Signed prod messages and heads"). Each Ed25519 seed
 * lives in its own PLAINTEXT key file outside every repo (user decision: no passphrase, no encryption; the user keeps
 * the files safe):
 *   main      ~/.config/typetorch/keys/<universeId>.key            (--key-file, TYPETORCH_KEY_FILE)
 *   fallback  ~/.config/typetorch/keys/<universeId>.fallback.key   (--fallback-key-file, TYPETORCH_FALLBACK_KEY_FILE)
 * The path variables are read from the REAL environment only (never from an env file), so a deploy started with an
 * env file (the remote-claude dev-server) never learns them.
 *
 * Key file (JSON, mode 0600 where the OS has modes):
 *   { "v": 2, "kind": "typetorch-signing-key", "role": "main" | "fallback", "alg": "Ed25519", "universeId": 123,
 *     "publicKey": "<base64 32 bytes>", "seed": "<base64 32 bytes>", "createdAt": "<ISO>" }
 *
 * No function here returns or prints a seed except `readKeyFile` (to sign with) and `newKeyFile` (to write it); errors
 * never contain one. Every seed read is registered for redaction (env.ts registerSecret).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Project } from "./config";
import { expandPath, FALLBACK_KEY_FILE_VAR, KEY_FILE_VAR, registerSecret, settings } from "./env";
import { isRecord } from "./json";
import { query } from "./proc";
import { generateSigningKey, isTestVectorKey, parseSigningKey, type DualSigner, type SigningKey } from "./signing";

export { FALLBACK_KEY_FILE_VAR, KEY_FILE_VAR, KEY_PATH_VARS } from "./env";
export const KEY_FILE_KIND = "typetorch-signing-key";

export type KeyRole = "main" | "fallback";

export class KeyFileError extends Error {
	override name = "KeyFileError";
}

export interface KeyFile {
	v: 2;
	kind: typeof KEY_FILE_KIND;
	role: KeyRole;
	alg: "Ed25519";
	universeId: number;
	publicKey: string;
	seed: string;
	createdAt: string;
}

/** What may be shown about a key file (no seed). */
export interface KeyFileInfo {
	path: string;
	role: KeyRole;
	universeId: number;
	publicKey: string;
	createdAt: string;
}

export function defaultKeyFile(universeId: number, role: KeyRole): string {
	return join(homedir(), ".config", "typetorch", "keys", role === "main" ? `${universeId}.key` : `${universeId}.fallback.key`);
}

/** A key-path variable from the real environment only (not from an env file, not from a .env Bun loaded). */
function realEnvPath(name: string): string | undefined {
	const setting = settings().get(name);
	return setting && setting.source === "environment" ? setting.value : undefined;
}

/** The key file for a role: the flag, else the real environment variable, else the default. */
export function keyFilePath(proj: Pick<Project, "config">, role: KeyRole, flag?: string): string {
	const configured = flag ?? realEnvPath(role === "main" ? KEY_FILE_VAR : FALLBACK_KEY_FILE_VAR);
	return resolve(configured ? expandPath(configured, process.cwd()) : defaultKeyFile(proj.config.universeId, role));
}

/** Both key files, from the command's --key-file / --fallback-key-file. */
export function keyFilePaths(proj: Pick<Project, "config">, flags: { keyFile?: string; fallbackKeyFile?: string } = {}): Record<KeyRole, string> {
	return { main: keyFilePath(proj, "main", flags.keyFile), fallback: keyFilePath(proj, "fallback", flags.fallbackKeyFile) };
}

/** True when `path` is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path)).replace(/\\/g, "/");
	return rel === "" || (!rel.startsWith("../") && rel !== ".." && !/^[a-z]:/i.test(rel));
}

function nearestExisting(path: string): string {
	let dir = resolve(path);
	while (!existsSync(dir)) {
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dir;
}

/** Seeds never go into a repo: refuses a key file inside the project or inside any git work tree. */
export function assertOutsideRepos(path: string, projectRoot: string) {
	if (isInside(projectRoot, path)) {
		throw new KeyFileError(`a key file must live outside the repo (${path} is inside ${projectRoot}); use the default path or pass a path outside it`);
	}
	const dir = nearestExisting(dirname(path));
	if (query(["git", "rev-parse", "--is-inside-work-tree"], dir) === "true") {
		const top = query(["git", "rev-parse", "--show-toplevel"], dir);
		throw new KeyFileError(`a key file must not live in a git work tree (${path} is inside ${top ?? dir}); pick a folder outside every repo`);
	}
}

/** A new key file for a role (the seed is fresh). */
export function newKeyFile(role: KeyRole, universeId: number): KeyFile {
	const { seed, publicKey } = generateSigningKey();
	return { v: 2, kind: KEY_FILE_KIND, role, alg: "Ed25519", universeId, publicKey, seed, createdAt: new Date().toISOString() };
}

/**
 * Writes a key file: creates the folder (0700), writes a temp file (0600) next to it and renames it into place, so a
 * crash never leaves half a key. Refuses to replace an existing file unless `replace`.
 */
export function writeKeyFile(path: string, file: KeyFile, options: { replace?: boolean } = {}) {
	if (existsSync(path) && !options.replace) throw new KeyFileError(`${path} already exists`);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(file, null, "\t") + "\n", { mode: 0o600 });
	try {
		chmodSync(temp, 0o600);
	} catch {}
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Reads and checks a key file. Errors name the file, never the seed. */
export function readKeyFile(path: string, expected: { role: KeyRole; universeId?: number }): { info: KeyFileInfo; key: SigningKey } {
	if (!existsSync(path)) throw new KeyFileError(`no ${expected.role} key file at ${path}`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new KeyFileError(`${path} is not a TypeTorch key file (not JSON)`);
	}
	if (!isRecord(raw) || raw.kind !== KEY_FILE_KIND) throw new KeyFileError(`${path} is not a TypeTorch key file`);
	if ("ciphertext" in raw || "kdf" in raw) {
		throw new KeyFileError(
			`${path} is an encrypted key file from CLI 0.3 (passphrase-protected); CLI 0.5 keys are plaintext files. Move it away (or delete it) and run \`typetorch keys init\` again`,
		);
	}
	if (raw.v !== 2 || raw.alg !== "Ed25519" || typeof raw.seed !== "string" || typeof raw.publicKey !== "string") {
		throw new KeyFileError(`${path} is not a version 2 Ed25519 key file`);
	}
	registerSecret(raw.seed);
	if (raw.role !== expected.role) throw new KeyFileError(`${path} holds the ${String(raw.role)} key, not the ${expected.role} key`);
	if (expected.universeId !== undefined && raw.universeId !== expected.universeId) {
		throw new KeyFileError(`${path} is for universe ${String(raw.universeId)}, not ${expected.universeId}`);
	}
	let key: SigningKey;
	try {
		key = parseSigningKey(raw.seed, `the seed in ${path}`);
	} catch (error) {
		throw new KeyFileError((error as Error).message);
	}
	if (key.publicKey !== raw.publicKey) throw new KeyFileError(`${path}: the seed does not match its publicKey (the file was edited?)`);
	if (isTestVectorKey(key.publicKey)) throw new KeyFileError(`${path} holds a public test-vector key from plans/03; make a real one`);
	return {
		info: { path, role: expected.role, universeId: raw.universeId as number, publicKey: key.publicKey, createdAt: String(raw.createdAt ?? "") },
		key,
	};
}

/** The public facts of a key file, or why it can't be used (doctor). */
export function inspectKeyFile(path: string, expected: { role: KeyRole; universeId?: number }): { info?: KeyFileInfo; error?: string; missing: boolean } {
	if (!existsSync(path)) return { missing: true, error: `no ${expected.role} key file at ${path}` };
	try {
		return { info: readKeyFile(path, expected).info, missing: false };
	} catch (error) {
		return { error: (error as Error).message, missing: false };
	}
}

export class SigningSetupError extends Error {
	override name = "SigningSetupError";
}

/**
 * The two keys a prod release is signed with, checked against typetorch.json: the main key must be one of
 * `signingPublicKeys`, the fallback key must be `fallbackPublicKey`, neither revoked, and they must differ.
 */
export function loadSigner(proj: Pick<Project, "config">, paths: Record<KeyRole, string>): DualSigner & { files: Record<KeyRole, KeyFileInfo> } {
	const c = proj.config;
	const setup = "prod-channel deploys are signed with two keys; set them up with `typetorch keys init` and `typetorch keys init --fallback` (then `typetorch kernel deploy`)";
	if (!c.signingPublicKeys?.length) throw new SigningSetupError(`typetorch.json has no "signingPublicKeys": ${setup}`);
	if (!c.fallbackPublicKey) throw new SigningSetupError(`typetorch.json has no "fallbackPublicKey": ${setup}`);
	const read = (role: KeyRole) => {
		try {
			return readKeyFile(paths[role], { role, universeId: c.universeId });
		} catch (error) {
			throw new SigningSetupError(`${(error as Error).message}. ${role === "main" ? "A lost main key is replaced with `typetorch keys rotate`" : "A lost fallback key is replaced with `typetorch keys init --fallback --force` + `typetorch kernel deploy`"}; another path: ${role === "main" ? "--key-file / TYPETORCH_KEY_FILE" : "--fallback-key-file / TYPETORCH_FALLBACK_KEY_FILE"}`);
		}
	};
	const main = read("main");
	const fallback = read("fallback");
	const revoked = new Set(c.revokedKeys ?? []);
	if (!c.signingPublicKeys.includes(main.info.publicKey)) {
		throw new SigningSetupError(`the main key (${main.info.path}) is not in typetorch.json "signingPublicKeys"; servers would not trust its \`sig\`. Use the matching key file, or \`typetorch keys rotate\``);
	}
	if (fallback.info.publicKey !== c.fallbackPublicKey) {
		throw new SigningSetupError(`the fallback key (${fallback.info.path}) is not typetorch.json "fallbackPublicKey"; servers would not trust its \`sigF\``);
	}
	if (revoked.has(main.info.publicKey)) throw new SigningSetupError(`the main key (${main.info.path}) is revoked in typetorch.json "revokedKeys"; run \`typetorch keys rotate\``);
	if (revoked.has(fallback.info.publicKey)) throw new SigningSetupError(`the fallback key (${fallback.info.path}) is revoked; run \`typetorch keys init --fallback --force\` and \`typetorch kernel deploy\``);
	if (main.info.publicKey === fallback.info.publicKey) throw new SigningSetupError("the main and fallback keys are the same key; they must be two separate pairs");
	return { main: main.key, fallback: fallback.key, files: { main: main.info, fallback: fallback.info } };
}
