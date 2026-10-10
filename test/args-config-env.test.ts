import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { validateConfig } from "../src/config";
import { childEnv, parseDotEnv, Settings } from "../src/env";
import { generateSigningKey, TEST_VECTOR_PUBLIC_KEYS } from "../src/signing";
import { isEditorTempFile, isGeneratedPath, porcelainPaths, untrackedEditorFiles } from "../src/git";
import { jsonEqual, parseJsonc, setJsonFields, topLevelValueSpan } from "../src/json";

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
	test("roles: owner and dev; CLI 0.9 refuses the old admin role (gone since kernel 0.3.4) with the fix", () => {
		const { config, errors, warnings } = validateConfig({ ...good, members: { "1": "owner", "3": "dev" } });
		expect(errors).toEqual([]);
		expect(warnings).toEqual([]);
		expect(config?.members).toEqual({ "1": "owner", "3": "dev" });
		const admin = validateConfig({ ...good, members: { "2": "admin" } });
		expect(admin.config).toBeUndefined();
		expect(admin.errors[0]).toMatch(/"members.2" must be one of owner, dev \(the admin role is gone since kernel 0.3.4: use "dev"/);
		expect(validateConfig({ ...good, members: { "4": "god" } }).errors[0]).toMatch(/must be one of owner, dev$/);
	});
	test("backend.url (CLI 0.9) and the old fleet.url, read with a warning; both: fleet ignored", () => {
		const backend = validateConfig({ ...good, backend: { url: "https://backend.example.com" } });
		expect(backend.config?.backend).toEqual({ url: "https://backend.example.com" });
		expect(backend.warnings).toEqual([]);
		const fleet = validateConfig({ ...good, fleet: { url: "https://old.example.com" } });
		expect(fleet.config?.backend).toEqual({ url: "https://old.example.com" });
		expect(fleet.warnings[0]).toMatch(/"fleet" is now "backend"/);
		const both = validateConfig({ ...good, backend: { url: "https://new.example.com" }, fleet: { url: "https://old.example.com" } });
		expect(both.config?.backend).toEqual({ url: "https://new.example.com" });
		expect(both.warnings[0]).toMatch(/"fleet" is ignored/);
		expect(validateConfig({ ...good, backend: { url: "http://backend.example.com" } }).errors[0]).toMatch(/backend.url.*https/);
		expect(validateConfig({ ...good, backend: { url: "https://user:pw@backend.example.com" } }).errors[0]).toMatch(/credentials/);
	});
	test("signing fields: base64 32-byte keys, no duplicates, a separate fallback, no test-vector keys, a numeric key asset", () => {
		const a = generateSigningKey().publicKey;
		const b = generateSigningKey().publicKey;
		const ok = validateConfig({ ...good, signingPublicKeys: [a], revokedKeys: [b], fallbackPublicKey: b, keyAssetId: "123" });
		expect(ok.errors).toEqual([]);
		expect(ok.config).toMatchObject({ signingPublicKeys: [a], revokedKeys: [b], fallbackPublicKey: b, keyAssetId: 123 });
		expect(validateConfig({ ...good, signingPublicKeys: a }).errors[0]).toMatch(/must be a list/);
		expect(validateConfig({ ...good, signingPublicKeys: [a, a] }).errors[0]).toMatch(/twice/);
		expect(validateConfig({ ...good, signingPublicKeys: ["AAAA"] }).errors[0]).toMatch(/32-byte/);
		expect(validateConfig({ ...good, signingPublicKeys: [a], fallbackPublicKey: a }).errors[0]).toMatch(/separate key pair/);
		expect(validateConfig({ ...good, fallbackPublicKey: TEST_VECTOR_PUBLIC_KEYS[1] }).errors[0]).toMatch(/test-vector/);
		expect(validateConfig({ ...good, keyAssetId: -4 }).errors[0]).toMatch(/keyAssetId/);
	});
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
	test("the game repo's .env (the folder with typetorch.json, found from a subfolder) is the only file; real env vars win; nothing is copied into process.env", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-env-"));
		const game = join(root, "game");
		const child = join(game, "src", "server");
		mkdirSync(child, { recursive: true });
		writeFileSync(join(game, "typetorch.json"), "{}");
		writeFileSync(join(root, ".env"), "TT_TEST_FAR=far\nOPENCLOUD_API_KEY=parent-key-0000\n");
		writeFileSync(join(game, ".env"), "TT_TEST_BOTH=game\nTT_TEST_REAL=file\n");
		writeFileSync(join(child, ".env"), "TT_TEST_BOTH=near\n");
		const settings = new Settings({ startDir: child, env: { TT_TEST_REAL: "real" } });
		expect(settings.gameDir).toBe(game);
		expect(settings.files).toEqual([join(game, ".env")]);
		expect(settings.get("TT_TEST_BOTH")).toEqual({ value: "game", source: join(game, ".env") });
		expect(settings.get("TT_TEST_FAR")).toBeUndefined(); // a parent folder's .env no longer counts (CLI 0.9)
		expect(settings.get("OPENCLOUD_API_KEY")).toBeUndefined();
		expect(settings.get("TT_TEST_REAL")).toEqual({ value: "real", source: "environment" });
		expect(settings.describeSources()).toContain(join(game, ".env"));
		expect(process.env.TT_TEST_FAR).toBeUndefined();
		expect(process.env.TT_TEST_BOTH).toBeUndefined();
		// --config's folder wins over the search.
		expect(new Settings({ gameDir: root, env: {} }).get("TT_TEST_FAR")?.value).toBe("far");
	});
	test("--env-file / TYPETORCH_ENV_FILE replace the game's .env; a TYPETORCH_ENV_FILE line inside .env still works for one release, with a warning", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-envfile-"));
		const repo = join(root, "repo");
		mkdirSync(join(root, "secrets"), { recursive: true });
		mkdirSync(repo);
		writeFileSync(join(repo, "typetorch.json"), "{}");
		writeFileSync(join(repo, ".env"), "TYPETORCH_ENV_FILE=../secrets/game.env\nOPENCLOUD_API_KEY=repo-key-0000\nTYPETORCH_ADMIN_TOKEN=repo-admin-0000\n");
		writeFileSync(join(root, "secrets", "game.env"), "OPENCLOUD_API_KEY=outside-key-0000\nOPENCLOUD_ASSETS_KEY=assets-key-0000\n");
		// The CLI 0.8 layout: the named file wins over the .env, and the .env still fills the rest.
		const declared = new Settings({ startDir: repo, env: {} });
		expect(declared.envFile).toBeUndefined();
		expect(declared.declaredEnvFile).toBe(join(root, "secrets", "game.env"));
		expect(declared.get("OPENCLOUD_API_KEY")?.value).toBe("outside-key-0000");
		expect(declared.get("TYPETORCH_ADMIN_TOKEN")?.value).toBe("repo-admin-0000");
		expect(declared.warnings.join("\n")).toMatch(/names another env file.*for this release only/);
		expect(declared.warnings.join("\n")).not.toContain("outside-key");
		// The override (flag or environment) replaces the .env entirely.
		writeFileSync(join(root, "other.env"), "OPENCLOUD_API_KEY=flag-key-0000\n");
		const flag = new Settings({ startDir: repo, env: {}, envFile: join(root, "other.env") });
		expect(flag.get("OPENCLOUD_API_KEY")?.value).toBe("flag-key-0000");
		expect(flag.get("TYPETORCH_ADMIN_TOKEN")).toBeUndefined();
		expect(flag.envFileFrom).toBe("--env-file");
		const fromEnv = new Settings({ startDir: repo, env: { TYPETORCH_ENV_FILE: join(root, "other.env") } });
		expect(fromEnv.envFileFrom).toBe("TYPETORCH_ENV_FILE");
		expect(fromEnv.get("OPENCLOUD_API_KEY")).toEqual({ value: "flag-key-0000", source: join(root, "other.env") });
		const missing = new Settings({ startDir: repo, env: { TYPETORCH_ENV_FILE: join(root, "nope.env") } });
		expect(missing.envFileMissing).toBe(true);
		expect(missing.get("OPENCLOUD_API_KEY")).toBeUndefined();
	});
	test("a key per job, falling back to the shared key", () => {
		const settings = new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-keys-")), env: { OPENCLOUD_ASSETS_KEY: "assets-key-0000", OPENCLOUD_API_KEY: "shared-key-0000" } });
		expect(settings.apiKey("assets")).toMatchObject({ key: "assets-key-0000", name: "OPENCLOUD_ASSETS_KEY", dedicated: true });
		expect(settings.apiKey("deploy")).toMatchObject({ key: "shared-key-0000", name: "OPENCLOUD_API_KEY", dedicated: false });
		expect(settings.apiKey("place")?.key).toBe("shared-key-0000");
		// CLI 0.9: TYPETORCH_API_KEY is the backend's game key, never an Open Cloud key; the error says to rename it.
		const old = new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-oldkey-")), env: { TYPETORCH_API_KEY: "old-roblox-key-0000" } });
		expect(old.apiKey("deploy")).toBeUndefined();
		expect(() => old.requireApiKey("deploy")).toThrow(/rename it to OPENCLOUD_API_KEY/);
		expect(new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-alias-")), env: { ROBLOX_API_KEY: "alias-key-0000" } }).apiKey("assets")?.name).toBe("ROBLOX_API_KEY");
		const none = new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-nokeys-")), env: { OPENCLOUD_DEPLOY_KEY: "deploy-key-0000" } });
		expect(none.apiKey("deploy")?.key).toBe("deploy-key-0000");
		expect(() => none.requireApiKey("place")).toThrow(/OPENCLOUD_PLACE_KEY/);
	});
	test("child processes get an allowlisted env: no keys, no signing key, no unknown variables", () => {
		const env = {
			PATH: "/bin",
			Path: "C:\\bin",
			HOME: "/home/me",
			SystemRoot: "C:\\Windows",
			OPENCLOUD_API_KEY: "shared-key-0000",
			OPENCLOUD_DEPLOY_KEY: "deploy-key-0000",
			TYPETORCH_SIGNING_KEY: "c2lnbmluZy1rZXktc2VlZA==",
			GITHUB_TOKEN: "ghs_secret_token",
			MY_SECRET: "x",
			NODE_ENV: "development",
		};
		const settings = new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-child-")), env });
		const child = childEnv({ TYPETORCH_CHANNEL: "prod" }, { env, settings });
		expect(child).toEqual({ PATH: "/bin", Path: "C:\\bin", HOME: "/home/me", SystemRoot: "C:\\Windows", GIT_TERMINAL_PROMPT: "0", TYPETORCH_CHANNEL: "prod" });
		// TYPETORCH_CHILD_ENV adds non-secret names; key names are never added
		const extended = { ...env, TYPETORCH_CHILD_ENV: "NODE_ENV, OPENCLOUD_API_KEY" };
		const withExtra = childEnv({}, { env: extended, settings: new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-child2-")), env: extended }) });
		expect(withExtra.NODE_ENV).toBe("development");
		expect(withExtra.OPENCLOUD_API_KEY).toBeUndefined();
	});
	test("the key file paths never reach a child, even when listed in TYPETORCH_CHILD_ENV", () => {
		const env = { PATH: "/bin", TYPETORCH_KEY_FILE: "/k/main.key", TYPETORCH_FALLBACK_KEY_FILE: "/k/fallback.key", TYPETORCH_CHILD_ENV: "TYPETORCH_KEY_FILE,TYPETORCH_FALLBACK_KEY_FILE,TYPETORCH_SIGNING_KEY" };
		const child = childEnv({}, { env, settings: new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-child4-")), env }) });
		expect(child).toEqual({ PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
	});
	test("a value equal to a secret never reaches a child, whatever its name", () => {
		const env = { PATH: "/bin", TERM: "shared-key-0000", OPENCLOUD_API_KEY: "shared-key-0000" };
		const child = childEnv({}, { env, settings: new Settings({ startDir: mkdtempSync(join(tmpdir(), "tt-child3-")), env }) });
		expect(child.TERM).toBeUndefined();
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
	test("editor temp files: only untracked ones are ignored", () => {
		for (const path of [".typetorch.json.swp", "src/.a.ts.swo", "src/a.ts~", "src/.#a.ts", "4913", "src/.b.ts.swn"]) {
			expect(isEditorTempFile(path)).toBe(true);
		}
		for (const path of ["src/swp.ts", "src/a.ts", ".typetorch.json", "src/a.swpx"]) expect(isEditorTempFile(path)).toBe(false);
		expect([...untrackedEditorFiles("?? .typetorch.json.swp\n M src/.a.ts.swp\n?? src/a.ts\n?? src/b.ts~\n")]).toEqual([
			".typetorch.json.swp",
			"src/b.ts~",
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
	test("setJsonFields: replaces values in place, appends new keys, keeps the rest of the text", () => {
		const text = '{\n\t"project": "p",\n\t"creator": { "groupId": 3 },\n\t"signingPublicKeys": ["x"],\n\t"s": "a,}\\"b"\n}\n';
		const next = setJsonFields(text, { signingPublicKeys: ["y", "z"], keyAssetId: 55 });
		expect(next).toBe('{\n\t"project": "p",\n\t"creator": { "groupId": 3 },\n\t"signingPublicKeys": ["y","z"],\n\t"s": "a,}\\"b",\n\t"keyAssetId": 55\n}\n');
		expect(JSON.parse(next)).toEqual({ project: "p", creator: { groupId: 3 }, signingPublicKeys: ["y", "z"], s: 'a,}"b', keyAssetId: 55 });
		expect(setJsonFields("{}", { a: 1 })).toBe('{\n\t"a": 1\n}');
		expect(topLevelValueSpan('{"a":{"b":1},"b":2}', "b")).toEqual([17, 18]);
	});
	test("parseJsonc", () => {
		expect(parseJsonc(`{ // c\n "a": "x//y", /* b */ "b": [1, 2,], }`)).toEqual({ a: "x//y", b: [1, 2] });
	});
	test("jsonEqual ignores key order", () => {
		expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
		expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonEqual([1, 2], [2, 1])).toBe(false);
	});
});
