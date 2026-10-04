import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deployMessage, encodeDeployMessage, encodePinMessage, encodeRekeyMessage, pinMessage } from "../src/opencloud";
import {
	canonicalPinString,
	canonicalString,
	generateSigningKey,
	isTestVectorKey,
	parseSigningKey,
	publicKeyError,
	signDual,
	signFields,
	signPinDual,
	TEST_VECTOR_FALLBACK_LABEL,
	TEST_VECTOR_FALLBACK_SEED,
	TEST_VECTOR_MAIN_SEED,
	TEST_VECTOR_PUBLIC_KEYS,
	verifyFields,
	verifySigned,
	verifySignedPin,
	type PinFields,
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

describe("the kernel's STRICT rule (plans/03): sig once the key asset has loaded, else sigF", () => {
	const { fields, sig, sigF } = VECTOR.prod;
	const loaded = { assetLoaded: true, publicKeys: [VECTOR.main.publicKey], revokedKeys: [] as string[], fallbackPublicKey: VECTOR.fallback.publicKey };
	const never = { assetLoaded: false, publicKeys: [] as string[], revokedKeys: [] as string[], fallbackPublicKey: VECTOR.fallback.publicKey };
	test("key asset loaded: only sig counts, sigF is ignored", () => {
		expect(verifySigned(loaded, fields, { sig, sigF })).toBe("sig");
		expect(verifySigned(loaded, fields, { sigF })).toBeUndefined();
		expect(verifySigned({ ...loaded, publicKeys: [] }, fields, { sig, sigF })).toBeUndefined();
		// revoked: untrusted even if still listed in PublicKeys, and sigF doesn't rescue it
		expect(verifySigned({ ...loaded, revokedKeys: [VECTOR.main.publicKey] }, fields, { sig, sigF })).toBeUndefined();
		// after a rotation the old head is invalid (keys rotate re-signs heads), the re-signed one is valid
		const fresh = parseSigningKey(generateSigningKey().seed);
		const rotated = { ...loaded, publicKeys: [fresh.publicKey], revokedKeys: [VECTOR.main.publicKey] };
		expect(verifySigned(rotated, fields, { sig, sigF })).toBeUndefined();
		const resigned = { ...fields, s: fields.s + 1, r: "resign" as const };
		expect(verifySigned(rotated, resigned, { sig: signFields(fresh, resigned) })).toBe("sig");
	});
	test("key asset never loaded: only sigF against the baked fallback key counts", () => {
		expect(verifySigned(never, fields, { sig, sigF })).toBe("sigF");
		expect(verifySigned(never, fields, { sig })).toBeUndefined();
		expect(verifySigned({ ...never, fallbackPublicKey: undefined }, fields, { sig, sigF })).toBeUndefined();
		expect(verifySigned({ ...never, revokedKeys: [VECTOR.fallback.publicKey] }, fields, { sig, sigF })).toBeUndefined();
	});
	test("unsigned, swapped or forged signatures are invalid", () => {
		for (const trust of [loaded, never]) {
			expect(verifySigned(trust, fields, {})).toBeUndefined();
			expect(verifySigned(trust, fields, { sig: sigF, sigF: sig })).toBeUndefined();
			const forger = parseSigningKey(generateSigningKey().seed);
			expect(verifySigned(trust, fields, { sig: signFields(forger, fields), sigF: signFields(forger, fields) })).toBeUndefined();
		}
	});
});

describe("re-signed heads (r = resign, plans/03 vector 4)", () => {
	const v = {
		fields: { b: "prod", a: 138576381221184, i: "12b63b9-8be210", s: 20, c: "12b63b9", ch: "prod", t: 1759580180000, r: "resign" } as SignedFields,
		canonical: "tt1\nprod\n138576381221184\n12b63b9-8be210\n20\n12b63b9\nprod\n1759580180000\nresign",
		sig: "HHni5U92bF9gQOYzm4/yPHi2fw0d6kqEt/zem9XHGOBcdfDnh9ty8Djl1NDPVuzlNx9xr60dzQNogtNyoa+pAw==",
		sigF: "YTwE+4JbN9R63AxJCSjmfp/rNKCqV6ORZjvcr5lYB9Zv7FLg09jofDDYodkKjyYfKLCurS1G9oRlKPPDqMIoAw==",
	};
	test("canonical string ends with resign; both signatures; the message carries r: \"resign\"", () => {
		expect(canonicalString(v.fields)).toBe(v.canonical);
		expect(signDual(signer, v.fields)).toEqual({ sig: v.sig, sigF: v.sigF });
		const message = deployMessage({ b: "prod", a: 138576381221184, i: "12b63b9-8be210", s: 20, c: "12b63b9", ch: "prod", t: 1759580180000, resign: true }, signer);
		expect(message).toMatchObject({ r: "resign", sig: v.sig, sigF: v.sigF });
		expect(verifyFields(VECTOR.main.publicKey, { ...v.fields, r: undefined }, v.sig)).toBe(false);
		expect(verifyFields(VECTOR.main.publicKey, { ...v.fields, r: 1 }, v.sig)).toBe(false);
	});
});

describe("signed pins (plans/03 \"Signed pins\")", () => {
	const PIN = {
		jobs: {
			fields: { b: "prod", a: 134192491895548, j: ["5f0c1a2b-0000-4000-8000-000000000001", "5f0c1a2b-0000-4000-8000-000000000002"], by: 12345, t: 1759580240000 } as PinFields,
			canonical: "tt1pin\nprod\n134192491895548\n5f0c1a2b-0000-4000-8000-000000000001,5f0c1a2b-0000-4000-8000-000000000002\n\n12345\n1759580240000\n",
			sig: "h3gbOZ3rrFWZA7u/7RdBf8VmwaPzahnR6r5E1Tx67MUWgbruDpZpER1iosmQdfvbfXwAfwPwfiUil9xTY2g+Cg==",
			sigF: "4VDOk9Uvr2fA6gBZaBnR5cNdnSQCFm/eXlO6HPapckNEAu0RfdHLbG9/ppmhJowp7p9RMe3u0xAtljUjuIQrAQ==",
			message:
				'{"j":["5f0c1a2b-0000-4000-8000-000000000001","5f0c1a2b-0000-4000-8000-000000000002"],"a":134192491895548,"b":"prod","by":12345,"t":1759580240000,"sig":"h3gbOZ3rrFWZA7u/7RdBf8VmwaPzahnR6r5E1Tx67MUWgbruDpZpER1iosmQdfvbfXwAfwPwfiUil9xTY2g+Cg==","sigF":"4VDOk9Uvr2fA6gBZaBnR5cNdnSQCFm/eXlO6HPapckNEAu0RfdHLbG9/ppmhJowp7p9RMe3u0xAtljUjuIQrAQ=="}',
		},
		pct: {
			fields: { b: "prod", a: 134192491895548, pct: 10, by: 12345, t: 1759580300000 } as PinFields,
			canonical: "tt1pin\nprod\n134192491895548\n\n10\n12345\n1759580300000\n",
			sig: "/DY1Wv/FusH1mnlcPjCYR+ps4O5IvIRUyhpAjOO9WYbMYyZZMhHSBRw1fJjgmU/H+RdGJBHHtZ/BahrphqRuBw==",
			sigF: "gkELYitaulVNd/oAVtLCfXAgJdTLwNTqlysNDU5iISPg61/6hDEnVRBqDOpzCx1SWuKWmH4yVZcKWLMrv5d7Cw==",
		},
		unpinAll: {
			fields: { b: "prod", pct: 100, by: 12345, t: 1759580360000, unpin: true } as PinFields,
			canonical: "tt1pin\nprod\n\n\n100\n12345\n1759580360000\n1",
			sig: "ZQjBKNEzYxD4e6oms1hERX/C7KC5wG6oTk3Vu/WfWEOvrPAWeFhMyfLxNgh/ZJ2Zd7eJb6PkHvMFAE2BXoHqBg==",
			sigF: "3eF+apTrzSXaxKfGkCVMUYPj5vkCwlA1JNf9MjZkVf4ivjTlmBiX7gZ0TIyNEBqCsbNMjnU9vfCzEFs2/5H1BQ==",
		},
	};
	test("canonical strings and signatures for the vectors", () => {
		for (const v of Object.values(PIN)) {
			expect(canonicalPinString(v.fields)).toBe(v.canonical);
			expect(signPinDual(signer, v.fields)).toEqual({ sig: v.sig, sigF: v.sigF });
		}
	});
	test("the full message of pin vector 1 (field order j, pct, a, b, by, t, unpin, sig, sigF)", () => {
		const message = pinMessage({ ...PIN.jobs.fields }, signer);
		expect(encodePinMessage(message)).toBe(PIN.jobs.message);
		expect(Object.keys(pinMessage({ ...PIN.unpinAll.fields }, signer))).toEqual(["pct", "b", "by", "t", "unpin", "sig", "sigF"]);
		expect(JSON.stringify(pinMessage({ b: "dev", a: 5, pct: 10, by: 1, t: 2 }))).toBe('{"pct":10,"a":5,"b":"dev","by":1,"t":2}');
	});
	test("the strict rule applies to pins too; any changed field (or the job order) breaks them", () => {
		const loaded = { assetLoaded: true, publicKeys: [VECTOR.main.publicKey], revokedKeys: [] as string[], fallbackPublicKey: VECTOR.fallback.publicKey };
		const { fields, sig, sigF } = PIN.jobs;
		expect(verifySignedPin(loaded, fields, { sig, sigF })).toBe("sig");
		expect(verifySignedPin({ ...loaded, assetLoaded: false, publicKeys: [] }, fields, { sig, sigF })).toBe("sigF");
		expect(verifySignedPin(loaded, { ...fields, j: [...fields.j!].reverse() }, { sig })).toBeUndefined();
		for (const changed of [{ b: "dev" }, { a: 1 }, { pct: 5 }, { by: 1 }, { t: fields.t + 1 }, { unpin: true as const }]) {
			expect(verifySignedPin(loaded, { ...fields, ...changed }, { sig })).toBeUndefined();
		}
		// a deploy signature never verifies as a pin (different version tag)
		expect(verifySignedPin(loaded, fields, { sig: VECTOR.prod.sig })).toBeUndefined();
		expect(() => canonicalPinString({ ...fields, j: ["bad,id"] })).toThrow(/JobId/);
	});
	test("a signed pin with 15 JobIds and the longest branch fits in 1 KiB; one with 30 is refused (the pin command splits)", () => {
		const jobs = (n: number) => Array.from({ length: n }, (_, i) => `5f0c1a2b-0000-4000-8000-${String(i).padStart(12, "0")}`);
		expect(new TextEncoder().encode(encodePinMessage(pinMessage({ b: "b".repeat(64), a: 999999999999999, j: jobs(15), by: 999999999999, t: 1759580240000 }, signer))).length).toBeLessThanOrEqual(1024);
		expect(() => encodePinMessage(pinMessage({ b: "prod", a: 1, j: jobs(30), by: 1 }, signer))).toThrow(/1024-byte/);
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
