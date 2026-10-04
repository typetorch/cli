/**
 * Ed25519 signatures on deploy messages (decision D1, plans/12; format in plans/03 "Deploy message").
 *
 * Keys:
 *   - private: TYPETORCH_SIGNING_KEY = base64 (standard alphabet, padded) of the raw 32-byte Ed25519 seed (RFC 8032
 *     "private key"). Kept in an env file, ideally outside the repo (TYPETORCH_ENV_FILE); never printed or logged.
 *   - public: typetorch.json "signingPublicKey" = base64 of the raw 32-byte public key. The kernel place build bakes it
 *     into the place (attribute SigningPublicKey on ServerScriptService.TypeTorchKernel).
 *
 * Canonical string (version tag "tt1"), UTF-8, fields joined with "\n", no trailing newline:
 *   tt1 \n b \n a \n i \n s \n c \n ch \n t \n r
 * Integers in base 10 (no sign, exponent, leading zeros or fraction), `r` is "1" for rollbacks and "" otherwise.
 * `sig` = base64 of the 64-byte Ed25519 signature of that string.
 *
 * node:crypto signs synchronously (Bun implements Ed25519 there and in WebCrypto); signing inside the registry's
 * mutate callback needs that.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const SIGNING_KEY_VAR = "TYPETORCH_SIGNING_KEY";
export const CANONICAL_VERSION = "tt1";
/** The public key of the throwaway test-vector key in plans/03 (its seed is public): never accepted for deploys. */
export const TEST_VECTOR_PUBLIC_KEY = "ErlwbCHDCN4WvDHY6l3plaeihIONuatx2jjqoqXZiq4=";

/** DER prefix that wraps a raw 32-byte seed as a PKCS#8 Ed25519 private key (RFC 8410). */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** DER prefix of an SPKI Ed25519 public key; the raw 32 bytes follow. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class SigningError extends Error {
	override name = "SigningError";
}

/** The fields a signature covers (the deploy message without `sig`). */
export interface SignedFields {
	b: string;
	a: number;
	i: string;
	s: number;
	c: string;
	ch: string;
	t: number;
	r?: 1;
}

function decimal(name: string, value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) throw new SigningError(`${name} must be a non-negative integer, got ${value}`);
	return String(value);
}

/** The exact bytes that are signed, as a string (see the module comment). */
export function canonicalString(fields: SignedFields): string {
	for (const [name, value] of [["b", fields.b], ["i", fields.i], ["c", fields.c], ["ch", fields.ch]] as const) {
		if (typeof value !== "string" || value.includes("\n")) throw new SigningError(`${name} must be a string without newlines`);
	}
	return [
		CANONICAL_VERSION,
		fields.b,
		decimal("a", fields.a),
		fields.i,
		decimal("s", fields.s),
		fields.c,
		fields.ch,
		decimal("t", fields.t),
		fields.r === 1 ? "1" : "",
	].join("\n");
}

function base64Bytes(text: string, what: string): Buffer {
	const trimmed = text.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new SigningError(`${what} is not base64`);
	return Buffer.from(trimmed, "base64");
}

export interface SigningKey {
	privateKey: KeyObject;
	/** base64 of the raw 32-byte public key. */
	publicKey: string;
}

/** Parses TYPETORCH_SIGNING_KEY (base64 of the 32-byte seed). The error never contains the value. */
export function parseSigningKey(seedBase64: string): SigningKey {
	const seed = base64Bytes(seedBase64, SIGNING_KEY_VAR);
	if (seed.length !== 32) throw new SigningError(`${SIGNING_KEY_VAR} must be base64 of a 32-byte Ed25519 seed (got ${seed.length} bytes)`);
	const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
	return { privateKey, publicKey: rawPublicKey(createPublicKey(privateKey)).toString("base64") };
}

function rawPublicKey(key: KeyObject): Buffer {
	const der = key.export({ format: "der", type: "spki" }) as Buffer;
	if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX)) throw new SigningError("unexpected Ed25519 public key encoding");
	return der.subarray(12);
}

/** Validates a base64 raw 32-byte public key; returns an error message or undefined. */
export function publicKeyError(publicKey: unknown): string | undefined {
	if (typeof publicKey !== "string") return "must be a base64 string";
	try {
		if (base64Bytes(publicKey, "signingPublicKey").length !== 32) return "must be base64 of a 32-byte Ed25519 public key";
	} catch {
		return "is not base64";
	}
	return undefined;
}

/** A new keypair: the base64 seed (secret) and the base64 raw public key. */
export function generateSigningKey(): { seed: string; publicKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
	if (der.length !== 48 || !der.subarray(0, 16).equals(PKCS8_PREFIX)) throw new SigningError("unexpected Ed25519 private key encoding");
	return { seed: der.subarray(16).toString("base64"), publicKey: rawPublicKey(publicKey).toString("base64") };
}

/** base64 Ed25519 signature of the canonical string. */
export function signFields(key: SigningKey, fields: SignedFields): string {
	return sign(null, Buffer.from(canonicalString(fields), "utf8"), key.privateKey).toString("base64");
}

/** Checks a signature against a base64 raw public key. */
export function verifyFields(publicKey: string, fields: SignedFields, signature: string): boolean {
	try {
		const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, base64Bytes(publicKey, "public key")]), format: "der", type: "spki" });
		return verify(null, Buffer.from(canonicalString(fields), "utf8"), key, base64Bytes(signature, "signature"));
	} catch {
		return false;
	}
}
