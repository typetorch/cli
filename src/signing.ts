/**
 * Ed25519 signatures on prod deploy messages and heads (decision D1, reopened; format in plans/03 "Signed prod
 * messages"). Only releases to a prod-channel branch are signed; dev-channel messages stay unsigned.
 *
 * Two independent keys sign every prod message and head, over the same canonical string:
 *   - `sig`  the MAIN key. Its public key is listed in the key asset's PublicKeys (a group-owned Model the kernel loads
 *            by the KeyAssetId stamped on it), so it can be rotated without a restart (`typetorch keys rotate`).
 *   - `sigF` the FALLBACK key. Its public key is baked into the place (FallbackPublicKey on the kernel), so it keeps
 *            working when the key asset breaks (moderation, deletion, permissions). Replacing it needs a kernel deploy.
 * A kernel accepts a prod message when `sig` verifies with a trusted main key OR `sigF` verifies with the fallback key
 * (neither revoked by the key asset's RevokedKeys).
 *
 * Keys are base64 (standard alphabet, padded) of raw 32-byte values: the private "seed" (RFC 8032) and the public key.
 * Seeds live only in key files (keyfiles.ts) and are never printed.
 *
 * Canonical string (version tag "tt1"), UTF-8, fields joined with "\n", no trailing newline:
 *   tt1 \n b \n a \n i \n s \n c \n ch \n t \n r
 * Integers in base 10 (no sign, exponent, leading zeros or fraction), `r` is "1" for rollbacks and "" otherwise.
 * `sig` / `sigF` = base64 of the 64-byte Ed25519 signature of that string.
 *
 * node:crypto signs synchronously (Bun implements Ed25519 there); signing inside the registry's mutate callback needs
 * that.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const CANONICAL_VERSION = "tt1";

/**
 * The throwaway test-vector keys in plans/03 (their seeds are public): never accepted for real signing.
 * Main: the CLI 0.2 vector seed. Fallback: seed = SHA-256 of TEST_VECTOR_FALLBACK_LABEL.
 */
export const TEST_VECTOR_MAIN_SEED = "+YR5DRjMHSBmbLgmt3LewYocFNfHgl5nKv+CepjNM8Y=";
export const TEST_VECTOR_FALLBACK_LABEL = "TypeTorch test vector: fallback key (public, never use)";
export const TEST_VECTOR_FALLBACK_SEED = createHash("sha256").update(TEST_VECTOR_FALLBACK_LABEL, "utf8").digest("base64");
/** The public keys of the two seeds above (the tests check that they derive from them). */
export const TEST_VECTOR_PUBLIC_KEYS: readonly string[] = ["ErlwbCHDCN4WvDHY6l3plaeihIONuatx2jjqoqXZiq4=", "mb6ZhKXQSzn2N+Xzle+xv1IuOLNWfQrtvifYYBknu0E="];

/** DER prefix that wraps a raw 32-byte seed as a PKCS#8 Ed25519 private key (RFC 8410). */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** DER prefix of an SPKI Ed25519 public key; the raw 32 bytes follow. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class SigningError extends Error {
	override name = "SigningError";
}

/** The fields a signature covers (the deploy message without `sig`/`sigF`). */
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
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) throw new SigningError(`${what} is not base64`);
	return Buffer.from(trimmed, "base64");
}

export interface SigningKey {
	privateKey: KeyObject;
	/** base64 of the raw 32-byte public key. */
	publicKey: string;
}

/** Parses a base64 32-byte seed. The error never contains the value. */
export function parseSigningKey(seedBase64: string, what = "the seed"): SigningKey {
	const seed = base64Bytes(seedBase64, what);
	if (seed.length !== 32) throw new SigningError(`${what} must be base64 of a 32-byte Ed25519 seed (got ${seed.length} bytes)`);
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
		if (base64Bytes(publicKey, "public key").length !== 32) return "must be base64 of a 32-byte Ed25519 public key";
	} catch {
		return "is not base64";
	}
	if (publicKey.trim() !== publicKey) return "has surrounding spaces";
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

// Two keys --------------------------------------------------------------------------------------------------------------

/** The two keys every prod message is signed with. */
export interface DualSigner {
	main: SigningKey;
	fallback: SigningKey;
}

export interface Signatures {
	/** Main key. */
	sig: string;
	/** Fallback key. */
	sigF: string;
}

export function signDual(signer: DualSigner, fields: SignedFields): Signatures {
	return { sig: signFields(signer.main, fields), sigF: signFields(signer.fallback, fields) };
}

/** What a kernel trusts (plans/03): the key asset's lists and the fallback key baked into the place. */
export interface TrustRoots {
	/** The key asset's PublicKeys (last good copy); empty when it was never loaded. */
	publicKeys: readonly string[];
	/** The key asset's RevokedKeys (last good copy). */
	revokedKeys: readonly string[];
	/** FallbackPublicKey on the kernel. */
	fallbackPublicKey?: string;
}

/**
 * The kernel's rule, as a reference implementation (tests, docs): valid when `sig` verifies with a main key that is in
 * PublicKeys and not in RevokedKeys, OR `sigF` verifies with the fallback key and the fallback key is not revoked.
 * Returns which signature was accepted, or undefined.
 */
export function verifySigned(trust: TrustRoots, fields: SignedFields, signatures: Partial<Signatures>): "sig" | "sigF" | undefined {
	const revoked = new Set(trust.revokedKeys);
	if (typeof signatures.sig === "string") {
		for (const key of trust.publicKeys) if (!revoked.has(key) && verifyFields(key, fields, signatures.sig)) return "sig";
	}
	if (typeof signatures.sigF === "string" && trust.fallbackPublicKey && !revoked.has(trust.fallbackPublicKey)) {
		if (verifyFields(trust.fallbackPublicKey, fields, signatures.sigF)) return "sigF";
	}
	return undefined;
}

/** True for the public test-vector keys from plans/03. */
export function isTestVectorKey(publicKey: string | undefined): boolean {
	return publicKey !== undefined && TEST_VECTOR_PUBLIC_KEYS.includes(publicKey);
}

/** Validates a list of base64 public keys from typetorch.json; returns the problems. */
export function publicKeyListProblems(name: string, value: unknown): string[] {
	if (!Array.isArray(value)) return [`"${name}" must be a list of base64 Ed25519 public keys`];
	const problems: string[] = [];
	const seen = new Set<string>();
	value.forEach((key, i) => {
		const problem = publicKeyError(key);
		if (problem) problems.push(`"${name}[${i}]" ${problem}`);
		else if (seen.has(key as string)) problems.push(`"${name}" lists ${key as string} twice`);
		else if (isTestVectorKey(key as string)) problems.push(`"${name}[${i}]" is a public test-vector key from plans/03`);
		seen.add(key as string);
	});
	return problems;
}
