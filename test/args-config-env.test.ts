import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { validateConfig } from "../src/config";
import { loadDotEnv, parseDotEnv } from "../src/env";
import { isGeneratedPath, porcelainPaths } from "../src/git";
import { jsonEqual, parseJsonc } from "../src/json";

describe("parseArgs", () => {
	const spec = { branch: "string", "dry-run": "boolean" } as const;
	test("flags and positionals", () => {
		expect(parseArgs(["ls", "--branch", "dev", "--dry-run", "--json"], spec)).toEqual({
			positionals: ["ls"],
			flags: { branch: "dev", "dry-run": true, json: true },
		});
	});
	test("--name=value", () => expect(parseArgs(["--branch=x"], spec).flags.branch).toBe("x"));
	test("unknown flag", () => expect(() => parseArgs(["--nope"], spec)).toThrow(UsageError));
	test("missing value", () => expect(() => parseArgs(["--branch"], spec)).toThrow(UsageError));
	test("value cannot be another flag", () => expect(() => parseArgs(["--branch", "--dry-run"], spec)).toThrow(UsageError));
	test("boolean with value", () => expect(() => parseArgs(["--dry-run=1"], spec)).toThrow(UsageError));
	test("-- ends flags", () => expect(parseArgs(["--", "--branch"], spec).positionals).toEqual(["--branch"]));
});

describe("validateConfig", () => {
	const good = {
		project: "template",
		universeId: 1234567890,
		placeId: 9876543210,
		creator: { groupId: 555 },
		defaultBranch: "prod",
		branches: { main: "prod" },
		channels: { prod: "prod" },
		members: { "123456789": "owner" },
		devBadgeId: null,
		kernel: "node_modules/@typetorch/kernel",
	};
	test("accepts the template config", () => {
		const { config, errors } = validateConfig(good);
		expect(errors).toEqual([]);
		expect(config?.creator).toEqual({ groupId: 555 });
		expect(config?.revoked).toBeUndefined();
	});
	test("defaults", () => {
		const { config } = validateConfig({ project: "p", universeId: "1", placeId: 2, creator: { userId: 3 } });
		expect(config).toMatchObject({ universeId: 1, defaultBranch: "prod", branches: {}, channels: {}, members: {}, devBadgeId: null });
	});
	test("reports every problem", () => {
		const { config, errors } = validateConfig({
			universeId: -1,
			creator: { groupId: 1, userId: 2 },
			channels: { dev: "staging" },
			members: { abc: "god" },
			branches: { main: "Not Valid" },
		});
		expect(config).toBeUndefined();
		expect(errors.length).toBeGreaterThanOrEqual(6);
	});
	test("revoked as list or map", () => {
		expect(validateConfig({ ...good, revoked: [1, "2"] }).config?.revoked).toEqual({ "1": true, "2": true });
		expect(validateConfig({ ...good, revoked: { "5": true, "6": false } }).config?.revoked).toEqual({ "5": true });
	});
	test("warns about unknown keys", () => expect(validateConfig({ ...good, extra: 1 }).warnings).toHaveLength(1));
});

describe("env", () => {
	test("parseDotEnv", () => {
		expect(parseDotEnv(`# c\nA=1\nexport B="two words"\nC='x # y'\nD=plain # comment\n\nbad line`)).toEqual({
			A: "1",
			B: "two words",
			C: "x # y",
			D: "plain",
		});
	});
	test("nearest .env wins, real env vars are kept", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-env-"));
		const child = join(root, "a", "b");
		mkdirSync(child, { recursive: true });
		writeFileSync(join(root, ".env"), "TT_TEST_FAR=far\nTT_TEST_BOTH=far\nTT_TEST_REAL=file\n");
		writeFileSync(join(child, ".env"), "TT_TEST_BOTH=near\n");
		process.env.TT_TEST_REAL = "real";
		loadDotEnv(child);
		expect(process.env.TT_TEST_FAR).toBe("far");
		expect(process.env.TT_TEST_BOTH).toBe("near");
		expect(process.env.TT_TEST_REAL).toBe("real");
	});
});

describe("git helpers", () => {
	test("porcelainPaths", () => {
		expect(porcelainPaths(' M src/a.ts\n?? .typetorch/x.json\nR  old.ts -> new.ts\n?? "with space.ts"\n')).toEqual([
			"src/a.ts",
			".typetorch/x.json",
			"new.ts",
			"with space.ts",
		]);
	});
	test("isGeneratedPath", () => {
		const generated = ["src/shared/build.ts", ".typetorch/"];
		expect(isGeneratedPath("src/shared/build.ts", generated)).toBe(true);
		expect(isGeneratedPath(".typetorch/payload.rbxm", generated)).toBe(true);
		expect(isGeneratedPath("src/shared/build.tsx", generated)).toBe(false);
	});
});

describe("json", () => {
	test("parseJsonc", () => {
		expect(parseJsonc(`{ // c\n "a": "x//y", /* b */ "b": [1, 2,], }`)).toEqual({ a: "x//y", b: [1, 2] });
	});
	test("jsonEqual ignores key order", () => {
		expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
		expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonEqual([1, 2], [2, 1])).toBe(false);
	});
});
