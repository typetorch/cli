/**
 * The deploy-signing key at rest (decision: "approve each deploy myself"). The Ed25519 seed is stored ENCRYPTED with a
 * passphrase in a key file outside the repo, by default `~/.config/typetorch/keys/<universeId>.key`
 * (`TYPETORCH_KEY_FILE` or `--key-file` override it). Signing needs the passphrase typed on an interactive terminal;
 * agents, the dev-server and CI can't sign.
 *
 * Key file (JSON, mode 0600):
 *   { "v": 1, "kind": "typetorch-signing-key", "alg": "Ed25519", "publicKey": "<base64 raw 32 bytes>",
 *     "universeId": 123, "createdAt": "<ISO>",
 *     "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64 16 bytes>" },
 *     "cipher": { "name": "aes-256-gcm", "iv": "<base64 12 bytes>", "tag": "<base64 16 bytes>" },
 *     "ciphertext": "<base64 of the encrypted 32-byte seed>" }
 * The AES-GCM additional data binds the format, the KDF parameters and the public key, so editing any of them makes
 * decryption fail; after decrypting, the seed must also reproduce the public key.
 *
 * CI escape hatch (off by default): TYPETORCH_SIGNING_KEY (base64 seed, plaintext) is used only when the REAL
 * environment also sets TYPETORCH_ALLOW_ENV_SIGNING_KEY=1 (see env.ts `ciSigningKey`). Never set it on a dev machine.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./json";
import { parseSigningKey, type SigningKey } from "./signing";

export const KEY_FILE_VAR = "TYPETORCH_KEY_FILE";
export const KEY_FILE_KIND = "typetorch-signing-key";
/** scrypt cost: N = 2^17 (about 0.2 s and 128 MiB here), r = 8, p = 1. */
export const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
export const MIN_PASSPHRASE = 12;

export class KeyFileError extends Error {
	override name = "KeyFileError";
}

/** The passphrase did not decrypt the key file (or the file was tampered with). */
export class WrongPassphraseError extends Error {
	override name = "WrongPassphraseError";
	constructor() {
		super("wrong passphrase (or the key file was modified)");
	}
}

export interface KeyFile {
	v: 1;
	kind: typeof KEY_FILE_KIND;
	alg: "Ed25519";
	publicKey: string;
	universeId?: number;
	createdAt: string;
	kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
	cipher: { name: "aes-256-gcm"; iv: string; tag: string };
	ciphertext: string;
}

export function defaultKeyFile(universeId: number): string {
	return join(homedir(), ".config", "typetorch", "keys", `${universeId}.key`);
}

function derive(passphrase: string, kdf: KeyFile["kdf"]): Buffer {
	return scryptSync(passphrase.normalize("NFC"), Buffer.from(kdf.salt, "base64"), 32, {
		N: kdf.N,
		r: kdf.r,
		p: kdf.p,
		maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024,
	});
}

function additionalData(file: Pick<KeyFile, "v" | "kind" | "alg" | "publicKey" | "kdf">): Buffer {
	const { kdf } = file;
	return Buffer.from(`${file.kind}|v${file.v}|${file.alg}|${file.publicKey}|scrypt:${kdf.N}:${kdf.r}:${kdf.p}:${kdf.salt}`, "utf8");
}

/** Encrypts a base64 seed with a passphrase. `scrypt` overrides the cost (tests only). */
export function encryptSeed(
	seedBase64: string,
	passphrase: string,
	options: { universeId?: number; scrypt?: { N: number; r: number; p: number } } = {},
): KeyFile {
	const key = parseSigningKey(seedBase64); // validates the seed
	const cost = options.scrypt ?? SCRYPT;
	const header = {
		v: 1 as const,
		kind: KEY_FILE_KIND as typeof KEY_FILE_KIND,
		alg: "Ed25519" as const,
		publicKey: key.publicKey,
		kdf: { name: "scrypt" as const, N: cost.N, r: cost.r, p: cost.p, salt: randomBytes(16).toString("base64") },
	};
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", derive(passphrase, header.kdf), iv);
	cipher.setAAD(additionalData(header));
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(seedBase64, "base64")), cipher.final()]);
	return {
		...header,
		...(options.universeId !== undefined ? { universeId: options.universeId } : {}),
		createdAt: new Date().toISOString(),
		cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
		ciphertext: ciphertext.toString("base64"),
	};
}

/** Decrypts a key file. Throws WrongPassphraseError for a wrong passphrase or a modified file. */
export function decryptKeyFile(file: KeyFile, passphrase: string): SigningKey {
	let seed: Buffer;
	try {
		const decipher = createDecipheriv("aes-256-gcm", derive(passphrase, file.kdf), Buffer.from(file.cipher.iv, "base64"));
		decipher.setAAD(additionalData(file));
		decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
		seed = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]);
	} catch {
		throw new WrongPassphraseError();
	}
	const key = parseSigningKey(seed.toString("base64"));
	seed.fill(0);
	if (key.publicKey !== file.publicKey) throw new WrongPassphraseError();
	return key;
}

/** Validates a parsed key file. */
export function validateKeyFile(raw: unknown, path = "key file"): KeyFile {
	const bad = (why: string) => new KeyFileError(`${path} is not a TypeTorch signing key file (${why})`);
	if (!isRecord(raw) || raw.v !== 1 || raw.kind !== KEY_FILE_KIND || raw.alg !== "Ed25519") throw bad("unknown format");
	const kdf = raw.kdf;
	const cipher = raw.cipher;
	if (!isRecord(kdf) || kdf.name !== "scrypt" || typeof kdf.salt !== "string") throw bad("kdf");
	for (const name of ["N", "r", "p"] as const) if (!Number.isSafeInteger(kdf[name])) throw bad(`kdf.${name}`);
	const N = kdf.N as number;
	if (N < MIN_N || N > MAX_N || (N & (N - 1)) !== 0 || (kdf.r as number) < 1 || (kdf.r as number) > 32 || (kdf.p as number) < 1 || (kdf.p as number) > 16) {
		throw bad("kdf parameters out of range");
	}
	if (!isRecord(cipher) || cipher.name !== "aes-256-gcm" || typeof cipher.iv !== "string" || typeof cipher.tag !== "string") throw bad("cipher");
	if (typeof raw.ciphertext !== "string" || typeof raw.publicKey !== "string") throw bad("ciphertext");
	return raw as unknown as KeyFile;
}

export function readKeyFile(path: string): KeyFile {
	if (!existsSync(path)) throw new KeyFileError(`no signing key file at ${path}: run \`typetorch keys init\``);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new KeyFileError(`${path} is not valid JSON`);
	}
	return validateKeyFile(raw, path);
}

export function writeKeyFile(path: string, file: KeyFile) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(file, null, "\t") + "\n", { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {}
}

/** Problems with a new passphrase (empty when it is acceptable). */
export function passphraseProblems(passphrase: string): string[] {
	const problems: string[] = [];
	if (passphrase.length < MIN_PASSPHRASE) problems.push(`at least ${MIN_PASSPHRASE} characters`);
	if (passphrase.trim() !== passphrase) problems.push("no spaces at the start or end");
	if (new Set(passphrase).size < 5) problems.push("more than 4 different characters");
	return problems;
}
