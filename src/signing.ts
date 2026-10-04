/**
 * Ed25519 signatures on prod deploy messages, heads and pins (decision D1, reopened; format in plans/03 "Signed prod
 * messages and heads" and "Signed pins"). Only messages to a prod-channel branch are signed; dev-channel ones stay
 * unsigned.
 *
 * Two independent keys sign every prod message and head, over the same canonical string:
 *   - `sig`  the MAIN key. Its public key is listed in the key asset's PublicKeys (a group-owned Model the kernel loads
 *            by the KeyAssetId stamped on it), so it can be rotated without a restart (`typetorch keys rotate`).
 *   - `sigF` the FALLBACK key. Its public key is baked into the place (FallbackPublicKey on the kernel), for servers
 *            that never managed to load the key asset. Replacing it needs a kernel deploy.
 * The kernel's rule (STRICT, user decision): once the key asset has loaded on a server, only `sig` counts (against
 * PublicKeys minus RevokedKeys; `sigF` is ignored); while it has never loaded, only `sigF` counts (against the baked
 * FallbackPublicKey). `verifySigned` is that rule as a reference.
 *
 * Keys are base64 (standard alphabet, padded) of raw 32-byte values: the private "seed" (RFC 8032) and the public key.
 * Seeds live only in key files (keyfiles.ts) and are never printed.
 *
 * Deploy canonical string (version tag "tt1"), UTF-8, fields joined with "\n", no trailing newline:
 *   tt1 \n b \n a \n i \n s \n c \n ch \n t \n r
 * Integers in base 10 (no sign, exponent, leading zeros or fraction); `r` is "1" for rollbacks, "resign" for heads
 * re-signed by `keys rotate`, and "" otherwise.
 * Pin canonical string: tt1pin \n b \n a \n jobs \n pct \n by \n t \n unpin (see `canonicalPinString`).
 * `sig` / `sigF` = base64 of the 64-byte Ed25519 signature of that string.
 *
 * node:crypto signs synchronously (Bun implements Ed25519 there); signing inside the registry's mutate callback needs
 * that.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const CANONICAL_VERSION = "tt1";
export const PIN_CANONICAL_VERSION = "tt1pin";
/** `r` on a head that `keys rotate` re-signed: same artifact, new seq, no swap. */
export const RESIGN = "resign";

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
	/** 1 for a rollback, "resign" for a re-signed head. */
	r?: 1 | typeof RESIGN;
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
		fields.r === 1 ? "1" : fields.r === RESIGN ? RESIGN : "",
	].join("\n");
}

/** The fields a pin signature covers (the `TypeTorch/pin` message without `sig`/`sigF`). */
export interface PinFields {
	b: string;
	/** Payload asset id; absent only for an unpin of every pin on the branch. */
	a?: number;
	/** JobIds, in the order sent. */
	j?: string[];
	/** 1-100: servers whose jobBucket is below it. */
	pct?: number;
	/** The owner's/admin's userId. */
	by: number;
	t: number;
	unpin?: true;
}

export const JOB_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The exact pin bytes: "tt1pin\n" .. b .. "\n" .. a .. "\n" .. jobs .. "\n" .. pct .. "\n" .. by .. "\n" .. t .. "\n" .. unpin
 * with jobs = the JobIds comma-joined in the order sent ("" if none), a and pct = integers or "", unpin = "1" or "".
 */
export function canonicalPinString(fields: PinFields): string {
	if (typeof fields.b !== "string" || fields.b.includes("\n")) throw new SigningError("b must be a string without newlines");
	for (const job of fields.j ?? []) if (!JOB_ID_PATTERN.test(job)) throw new SigningError(`not a JobId: ${job}`);
	return [
		PIN_CANONICAL_VERSION,
		fields.b,
		fields.a === undefined ? "" : decimal("a", fields.a),
		(fields.j ?? []).join(","),
		fields.pct === undefined ? "" : decimal("pct", fields.pct),
		decimal("by", fields.by),
		decimal("t", fields.t),
		fields.unpin === true ? "1" : "",
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

/** base64 Ed25519 signature of a canonical string. */
export function signCanonical(key: SigningKey, text: string): string {
	return sign(null, Buffer.from(text, "utf8"), key.privateKey).toString("base64");
}

/** Checks a signature of a canonical string against a base64 raw public key. */
export function verifyCanonical(publicKey: string, text: string, signature: string): boolean {
	try {
		const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, base64Bytes(publicKey, "public key")]), format: "der", type: "spki" });
		return verify(null, Buffer.from(text, "utf8"), key, base64Bytes(signature, "signature"));
	} catch {
		return false;
	}
}

/** base64 Ed25519 signature of the deploy canonical string. */
export function signFields(key: SigningKey, fields: SignedFields): string {
	return signCanonical(key, canonicalString(fields));
}

/** Checks a deploy signature against a base64 raw public key. */
export function verifyFields(publicKey: string, fields: SignedFields, signature: string): boolean {
	try {
		return verifyCanonical(publicKey, canonicalString(fields), signature);
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
	const text = canonicalString(fields);
	return { sig: signCanonical(signer.main, text), sigF: signCanonical(signer.fallback, text) };
}

export function signPinDual(signer: DualSigner, fields: PinFields): Signatures {
	const text = canonicalPinString(fields);
	return { sig: signCanonical(signer.main, text), sigF: signCanonical(signer.fallback, text) };
}

/** What a kernel trusts (plans/03): the key asset's lists (once loaded) and the fallback key baked into the place. */
export interface TrustRoots {
	/** The key asset has loaded at least once on this server (its last good copy is below). */
	assetLoaded: boolean;
	/** The key asset's PublicKeys (last good copy). */
	publicKeys: readonly string[];
	/** The key asset's RevokedKeys (last good copy). */
	revokedKeys: readonly string[];
	/** FallbackPublicKey on the kernel. */
	fallbackPublicKey?: string;
}

/**
 * The kernel's STRICT rule over a canonical string, as a reference implementation (tests, docs):
 *   - the key asset has loaded (ever, on this server): valid only when `sig` verifies with a key in PublicKeys that is
 *     not in RevokedKeys; `sigF` is ignored;
 *   - it never loaded: valid only when `sigF` verifies with FallbackPublicKey (and RevokedKeys, which is then empty,
 *     doesn't list it).
 * Returns which signature was accepted, or undefined.
 */
export function verifyCanonicalStrict(trust: TrustRoots, text: string, signatures: Partial<Signatures>): "sig" | "sigF" | undefined {
	const revoked = new Set(trust.revokedKeys);
	if (trust.assetLoaded) {
		if (typeof signatures.sig !== "string") return undefined;
		for (const key of trust.publicKeys) if (!revoked.has(key) && verifyCanonical(key, text, signatures.sig)) return "sig";
		return undefined;
	}
	if (typeof signatures.sigF === "string" && trust.fallbackPublicKey && !revoked.has(trust.fallbackPublicKey)) {
		if (verifyCanonical(trust.fallbackPublicKey, text, signatures.sigF)) return "sigF";
	}
	return undefined;
}

/** The strict rule for a deploy message or head. */
export function verifySigned(trust: TrustRoots, fields: SignedFields, signatures: Partial<Signatures>): "sig" | "sigF" | undefined {
	let text: string;
	try {
		text = canonicalString(fields);
	} catch {
		return undefined;
	}
	return verifyCanonicalStrict(trust, text, signatures);
}

/** The strict rule for a pin message. */
export function verifySignedPin(trust: TrustRoots, fields: PinFields, signatures: Partial<Signatures>): "sig" | "sigF" | undefined {
	let text: string;
	try {
		text = canonicalPinString(fields);
	} catch {
		return undefined;
	}
	return verifyCanonicalStrict(trust, text, signatures);
}

/**
 * A key's short fingerprint, as the kernel shows it (dev menu, `api:keys()`): the first 8 hex digits of the SHA-256 of
 * the raw 32 key bytes. "?" for something that isn't a key.
 */
export function keyFingerprint(publicKey: string): string {
	if (publicKeyError(publicKey)) return "?";
	return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 8);
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
