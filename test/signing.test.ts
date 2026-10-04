import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deployMessage, encodeDeployMessage, encodeRekeyMessage } from "../src/opencloud";
import {
	canonicalString,
	generateSigningKey,
	isTestVectorKey,
	parseSigningKey,
	publicKeyError,
	signDual,
	signFields,
	TEST_VECTOR_FALLBACK_LABEL,
	TEST_VECTOR_FALLBACK_SEED,
	TEST_VECTOR_MAIN_SEED,
	TEST_VECTOR_PUBLIC_KEYS,
	verifyFields,
	verifySigned,
	type SignedFields,
} from "../src/signing";

/**
 * The test vectors in plans/03 "Signed prod messages and heads". Throwaway keys made only for these vectors: they sign
 * nothing real, and the CLI refuses them as signing keys.
 */
const VECTOR = {
	main: { seed: "+YR5DRjMHSBmbLgmt3LewYocFNfHgl5nKv+CepjNM8Y=", publicKey: "ErlwbCHDCN4WvDHY6l3plaeihIONuatx2jjqoqXZiq4=" },
	fallback: { seed: "c6o85UhjlwURVlIRFHmEXbdhMZLOOOpiV6UtF9cyiag=", publicKey: "mb6ZhKXQSzn2N+Xzle+xv1IuOLNWfQrtvifYYBknu0E=" },
	deploy: {
		fields: { b: "dev", a: 134192491895548, i: "12b63b9-3fa91c", s: 17, c: "12b63b9", ch: "dev", t: 1759580000000 } as SignedFields,
		canonical: "tt1\ndev\n134192491895548\n12b63b9-3fa91c\n17\n12b63b9\ndev\n1759580000000\n",
		sig: "PGUNDeXnLquAaE67z6rObJxcbYEWFgHPFxqb4EM93auudYqZtTEYUc0yF4K4gJQn0nKr+bTBv2QjArxSUSHRAw==",
		sigF: "hmsNvZOG4myGw9fKa/JxDH44tWzFrRxMbmFXpn338kEGLenb7hewIS8PoAs2/wu+ulB2cjHaZR6p7c01mcGyAQ==",
	},
	rollback: {
		fields: { b: "prod", a: 138576381221184, i: "12b63b9-8be210", s: 18, c: "12b63b9", ch: "prod", t: 1759580060000, r: 1 } as SignedFields,
		canonical: "tt1\nprod\n138576381221184\n12b63b9-8be210\n18\n12b63b9\nprod\n1759580060000\n1",
		sig: "h4D9wxKwyj9ZiZEgEeje5bLXd62iH1Zqqbi6UCzNnGBu1SAPQq38g1zFWizogRTVumLr3OTz4T2hlSx/6fl9AQ==",
		sigF: "SJG++3eiXGCYmu35ADj79qI7M0n/NxlRS61uZXqa6V2ahdN0pMZHBc2OB31r//ve87pKEY8AUvTH/lbz4fx7Bw==",
	},
	prod: {
		fields: { b: "prod", a: 138576381221184, i: "12b63b9-8be210", s: 19, c: "12b63b9", ch: "prod", t: 1759580120000 } as SignedFields,
		canonical: "tt1\nprod\n138576381221184\n12b63b9-8be210\n19\n12b63b9\nprod\n1759580120000\n",
		sig: "phgDB7FGF1wuRZolNMKItmsUYwJzqFmvIFVOmlmWOxyDRG4lpk06KBQbBUkhczHktk+a7lUGGZjjy83liqK7Dw==",
		sigF: "ozGBMMk3xtBREeQkcP596zVthaJNtkdbjE+AlG9pD80kxNn6GzGNowGmyzwMtwpZ8SkXr+g/LBR9X5bPkaeSBQ==",
		message:
			'{"b":"prod","a":138576381221184,"i":"12b63b9-8be210","s":19,"c":"12b63b9","ch":"prod","t":1759580120000,"sig":"phgDB7FGF1wuRZolNMKItmsUYwJzqFmvIFVOmlmWOxyDRG4lpk06KBQbBUkhczHktk+a7lUGGZjjy83liqK7Dw==","sigF":"ozGBMMk3xtBREeQkcP596zVthaJNtkdbjE+AlG9pD80kxNn6GzGNowGmyzwMtwpZ8SkXr+g/LBR9X5bPkaeSBQ=="}',
	},
};
const CASES = [VECTOR.deploy, VECTOR.rollback, VECTOR.prod];
const signer = { main: parseSigningKey(VECTOR.main.seed), fallback: parseSigningKey(VECTOR.fallback.seed) };

describe("canonical string and test vectors (plans/03)", () => {
	test("the vector keys: the CLI 0.2 main seed, the fallback seed = SHA-256 of the label", () => {
		expect(TEST_VECTOR_MAIN_SEED).toBe(VECTOR.main.seed);
		expect(TEST_VECTOR_FALLBACK_SEED).toBe(VECTOR.fallback.seed);
		expect(createHash("sha256").update(TEST_VECTOR_FALLBACK_LABEL).digest("base64")).toBe(VECTOR.fallback.seed);
		expect(signer.main.publicKey).toBe(VECTOR.main.publicKey);
		expect(signer.fallback.publicKey).toBe(VECTOR.fallback.publicKey);
		expect(TEST_VECTOR_PUBLIC_KEYS).toEqual([VECTOR.main.publicKey, VECTOR.fallback.publicKey]);
		expect(isTestVectorKey(VECTOR.fallback.publicKey)).toBe(true);
		expect(isTestVectorKey(generateSigningKey().publicKey)).toBe(false);
	});
	test("canonical string: tt1 + 8 fields joined by \\n, empty r for deploys", () => {
		for (const c of CASES) expect(canonicalString(c.fields)).toBe(c.canonical);
		expect(VECTOR.deploy.canonical.split("\n")).toHaveLength(9);
	});
	test("sig (main) and sigF (fallback) for every vector; Ed25519 is deterministic", () => {
		for (const c of CASES) {
			expect(signFields(signer.main, c.fields)).toBe(c.sig);
			expect(signFields(signer.fallback, c.fields)).toBe(c.sigF);
			expect(signDual(signer, c.fields)).toEqual({ sig: c.sig, sigF: c.sigF });
			expect(verifyFields(VECTOR.main.publicKey, c.fields, c.sig)).toBe(true);
			expect(verifyFields(VECTOR.fallback.publicKey, c.fields, c.sigF)).toBe(true);
			// each signature fails with the other key
			expect(verifyFields(VECTOR.fallback.publicKey, c.fields, c.sig)).toBe(false);
			expect(verifyFields(VECTOR.main.publicKey, c.fields, c.sigF)).toBe(false);
		}
	});
	test("the full prod message of vector 3, field order b,a,i,s,c,ch,t,r?,sig,sigF", () => {
		const { fields } = VECTOR.prod;
		const message = deployMessage({ b: fields.b, a: fields.a, i: fields.i, s: fields.s, c: fields.c, ch: "prod", t: fields.t }, signer);
		expect(encodeDeployMessage(message)).toBe(VECTOR.prod.message);
		const rollback = deployMessage({ ...VECTOR.rollback.fields, ch: "prod", rollback: true }, signer);
		expect(Object.keys(rollback)).toEqual(["b", "a", "i", "s", "c", "ch", "t", "r", "sig", "sigF"]);
	});
	test("any changed field (or r added/removed) breaks both signatures", () => {
		const { fields, sig, sigF } = VECTOR.prod;
		const changes: Partial<SignedFields>[] = [{ b: "dev" }, { a: fields.a + 1 }, { i: "12b63b9-8be211" }, { s: 20 }, { c: "12b63b8" }, { ch: "dev" }, { t: fields.t + 1 }, { r: 1 }];
		for (const changed of changes) {
			expect(verifyFields(VECTOR.main.publicKey, { ...fields, ...changed }, sig)).toBe(false);
			expect(verifyFields(VECTOR.fallback.publicKey, { ...fields, ...changed }, sigF)).toBe(false);
		}
		const { r: _r, ...noR } = VECTOR.rollback.fields;
		expect(verifyFields(VECTOR.main.publicKey, noR, VECTOR.rollback.sig)).toBe(false);
		expect(verifyFields(generateSigningKey().publicKey, fields, sig)).toBe(false);
	});
	test("integers are plain base 10 and strings may not hold newlines", () => {
		expect(() => canonicalString({ ...VECTOR.deploy.fields, a: 1.5 })).toThrow();
		expect(() => canonicalString({ ...VECTOR.deploy.fields, a: -1 })).toThrow();
		expect(() => canonicalString({ ...VECTOR.deploy.fields, b: "a\nb" })).toThrow();
		expect(canonicalString({ ...VECTOR.deploy.fields, a: 1e14 })).toContain("\n100000000000000\n");
	});
	test("keys: 32-byte seeds only; public keys are 32 bytes; errors never echo the value", () => {
		expect(() => parseSigningKey("AAAA")).toThrow(/32-byte/);
		expect(() => parseSigningKey("not base64!")).toThrow(/base64/);
		const { seed, publicKey } = generateSigningKey();
		expect(Buffer.from(seed, "base64")).toHaveLength(32);
		expect(publicKeyError(publicKey)).toBeUndefined();
		expect(publicKeyError("AAAA")).toBeString();
		expect(publicKeyError(5)).toBeString();
		const truncated = seed.slice(0, 20);
		try {
			parseSigningKey(truncated);
		} catch (error) {
			expect((error as Error).message).not.toContain(truncated);
		}
	});
});

describe("the kernel's rule: sig with a trusted main key OR sigF with the fallback key (plans/03)", () => {
	const { fields, sig, sigF } = VECTOR.prod;
	const trust = { publicKeys: [VECTOR.main.publicKey], revokedKeys: [] as string[], fallbackPublicKey: VECTOR.fallback.publicKey };
	test("either signature is enough", () => {
		expect(verifySigned(trust, fields, { sig, sigF })).toBe("sig");
		expect(verifySigned(trust, fields, { sigF })).toBe("sigF");
		expect(verifySigned({ ...trust, publicKeys: [] }, fields, { sig, sigF })).toBe("sigF"); // key asset never loaded
		expect(verifySigned({ ...trust, fallbackPublicKey: undefined }, fields, { sig })).toBe("sig");
	});
	test("after a rotation (main revoked) old heads stay valid through sigF; revoking both makes them invalid", () => {
		const rotated = { publicKeys: [generateSigningKey().publicKey], revokedKeys: [VECTOR.main.publicKey], fallbackPublicKey: VECTOR.fallback.publicKey };
		expect(verifySigned(rotated, fields, { sig, sigF })).toBe("sigF");
		expect(verifySigned({ ...rotated, revokedKeys: [VECTOR.main.publicKey, VECTOR.fallback.publicKey] }, fields, { sig, sigF })).toBeUndefined();
		// a revoked key stays untrusted even if it is still listed in PublicKeys
		expect(verifySigned({ ...trust, revokedKeys: [VECTOR.main.publicKey], fallbackPublicKey: undefined }, fields, { sig })).toBeUndefined();
	});
	test("unsigned, swapped or forged signatures are invalid", () => {
		expect(verifySigned(trust, fields, {})).toBeUndefined();
		expect(verifySigned(trust, fields, { sig: sigF, sigF: sig })).toBeUndefined();
		const forger = parseSigningKey(generateSigningKey().seed);
		expect(verifySigned(trust, fields, { sig: signFields(forger, fields), sigF: signFields(forger, fields) })).toBeUndefined();
	});
});

describe("message size and shape", () => {
	test("a signed prod rollback with the longest branch stays under 500 bytes (1 KiB limit)", () => {
		const message = deployMessage(
			{ b: "b".repeat(64), a: 999999999999999, i: "uncommitted-dirty-abcdef", s: 9999999, c: "abcdef0", ch: "prod", rollback: true },
			signer,
		);
		const text = encodeDeployMessage(message);
		expect(new TextEncoder().encode(text).length).toBeLessThan(500);
		expect(() => encodeDeployMessage({ ...message, b: "x".repeat(1100) })).toThrow(/1024-byte/);
	});
	test("unsigned without a signer (dev); field order is fixed", () => {
		const message = deployMessage({ b: "dev", a: 1, i: "x", s: 1, c: "c", ch: "dev", t: 5 });
		expect(JSON.stringify(message)).toBe('{"b":"dev","a":1,"i":"x","s":1,"c":"c","ch":"dev","t":5}');
	});
	test("the rekey hint is {t}", () => {
		expect(encodeRekeyMessage(1759580000000)).toBe('{"t":1759580000000}');
	});
});
