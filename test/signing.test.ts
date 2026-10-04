import { describe, expect, test } from "bun:test";
import { deployMessage, encodeDeployMessage } from "../src/opencloud";
import {
	canonicalString,
	generateSigningKey,
	parseSigningKey,
	publicKeyError,
	signFields,
	TEST_VECTOR_PUBLIC_KEY,
	verifyFields,
} from "../src/signing";

/**
 * The test vector in plans/03 "Deploy message signatures". A throwaway key made only for this vector: it signs nothing
 * real, and the CLI refuses it as a signing key.
 */
const VECTOR = {
	seed: "+YR5DRjMHSBmbLgmt3LewYocFNfHgl5nKv+CepjNM8Y=",
	publicKey: "ErlwbCHDCN4WvDHY6l3plaeihIONuatx2jjqoqXZiq4=",
	deploy: {
		fields: { b: "dev", a: 134192491895548, i: "12b63b9-3fa91c", s: 17, c: "12b63b9", ch: "dev", t: 1759580000000 },
		canonical: "tt1\ndev\n134192491895548\n12b63b9-3fa91c\n17\n12b63b9\ndev\n1759580000000\n",
		sig: "PGUNDeXnLquAaE67z6rObJxcbYEWFgHPFxqb4EM93auudYqZtTEYUc0yF4K4gJQn0nKr+bTBv2QjArxSUSHRAw==",
	},
	rollback: {
		fields: { b: "prod", a: 138576381221184, i: "12b63b9-8be210", s: 18, c: "12b63b9", ch: "prod", t: 1759580060000, r: 1 as const },
		canonical: "tt1\nprod\n138576381221184\n12b63b9-8be210\n18\n12b63b9\nprod\n1759580060000\n1",
		sig: "h4D9wxKwyj9ZiZEgEeje5bLXd62iH1Zqqbi6UCzNnGBu1SAPQq38g1zFWizogRTVumLr3OTz4T2hlSx/6fl9AQ==",
	},
};

describe("deploy message signatures (plans/03)", () => {
	test("canonical string: tt1 + 8 fields joined by \\n, empty r for deploys", () => {
		expect(canonicalString(VECTOR.deploy.fields)).toBe(VECTOR.deploy.canonical);
		expect(canonicalString(VECTOR.rollback.fields)).toBe(VECTOR.rollback.canonical);
		expect(VECTOR.deploy.canonical.split("\n")).toHaveLength(9);
	});
	test("the test vector: public key and signatures", () => {
		const key = parseSigningKey(VECTOR.seed);
		expect(key.publicKey).toBe(VECTOR.publicKey);
		expect(TEST_VECTOR_PUBLIC_KEY).toBe(VECTOR.publicKey);
		expect(signFields(key, VECTOR.deploy.fields)).toBe(VECTOR.deploy.sig); // Ed25519 is deterministic
		expect(signFields(key, VECTOR.rollback.fields)).toBe(VECTOR.rollback.sig);
		expect(verifyFields(VECTOR.publicKey, VECTOR.deploy.fields, VECTOR.deploy.sig)).toBe(true);
	});
	test("any changed field breaks the signature", () => {
		const { fields, sig } = VECTOR.deploy;
		for (const changed of [{ b: "prod" }, { a: fields.a + 1 }, { i: "12b63b9-3fa91d" }, { s: 18 }, { c: "12b63b8" }, { ch: "prod" }, { t: fields.t + 1 }, { r: 1 as const }]) {
			expect(verifyFields(VECTOR.publicKey, { ...fields, ...changed }, sig)).toBe(false);
		}
		expect(verifyFields(generateSigningKey().publicKey, fields, sig)).toBe(false);
	});
	test("integers are plain base 10 and strings may not hold newlines", () => {
		expect(() => canonicalString({ ...VECTOR.deploy.fields, a: 1.5 })).toThrow();
		expect(() => canonicalString({ ...VECTOR.deploy.fields, a: -1 })).toThrow();
		expect(() => canonicalString({ ...VECTOR.deploy.fields, b: "a\nb" })).toThrow();
		expect(canonicalString({ ...VECTOR.deploy.fields, a: 1e14 })).toContain("\n100000000000000\n");
	});
	test("keys: 32-byte seeds only; public keys are 32 bytes", () => {
		expect(() => parseSigningKey("AAAA")).toThrow(/32-byte/);
		expect(() => parseSigningKey("not base64!")).toThrow(/base64/);
		const { seed, publicKey } = generateSigningKey();
		expect(Buffer.from(seed, "base64")).toHaveLength(32);
		expect(publicKeyError(publicKey)).toBeUndefined();
		expect(publicKeyError("AAAA")).toBeString();
		expect(publicKeyError(5)).toBeString();
	});
	test("a signed message with the longest branch name stays under 1 KiB", () => {
		const key = parseSigningKey(generateSigningKey().seed);
		const message = deployMessage(
			{ b: "b".repeat(64), a: 999999999999999, i: "uncommitted-dirty-abcdef", s: 9999999, c: "abcdef0", ch: "prod", rollback: true },
			key,
		);
		const text = encodeDeployMessage(message);
		expect(new TextEncoder().encode(text).length).toBeLessThan(400);
		expect(() => encodeDeployMessage({ ...message, b: "x".repeat(1100) })).toThrow(/1024-byte/);
	});
	test("unsigned without a key; field order is fixed", () => {
		const message = deployMessage({ b: "dev", a: 1, i: "x", s: 1, c: "c", ch: "dev", t: 5 });
		expect(JSON.stringify(message)).toBe('{"b":"dev","a":1,"i":"x","s":1,"c":"c","ch":"dev","t":5}');
	});
});
