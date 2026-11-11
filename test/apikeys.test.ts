/**
 * `typetorch keys create | list | revoke` (plans/31): validation, each request against a fake backend, the key shown
 * exactly once (plain and --json) and never in errors or other commands' output, built-in ids refused locally. Fake
 * keys only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { parseExpires, parseKeyName, parseRevokeId, parseRole, when } from "../src/commands/apikeys";
import { keysCommand, keysFlags } from "../src/commands/keys";
import { validateConfig, type Project } from "../src/config";
import { redact, Settings, useSettings } from "../src/env";
import { setOutputMode } from "../src/log";

const HOST = "https://backend.example.com";
const ADMIN = "admin-token-for-tests-0123456789ab";
const ID = "a1b2c3d4e5";
const KEY = `ttk_${ID}_${"S".repeat(20)}_secret-part_${"x".repeat(10)}`;

function project(patch: Record<string, unknown> = {}, env: Record<string, string> = { TYPETORCH_ADMIN_TOKEN: ADMIN }): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-apikeys-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, approval: "none", backend: { url: HOST }, ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings };
}

interface Call {
	method: string;
	path: string;
	auth: string | null;
	body: unknown;
}

function fakeBackend(routes: Record<string, [number, unknown]>) {
	const calls: Call[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push({ method, path: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		const [status, json] = routes[`${method} ${url.pathname}${url.search}`] ?? [404, { error: "no route" }];
		return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetch: fetcher, calls };
}

async function run(proj: Project, fn: () => Promise<unknown>, json = false): Promise<{ out: string; error?: Error }> {
	const lines: string[] = [];
	const log = console.log;
	const err = console.error;
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	const cwd = process.cwd();
	process.chdir(proj.root);
	setOutputMode({ json, verbose: false });
	try {
		await fn();
		return { out: lines.join("\n") };
	} catch (error) {
		return { error: error as Error, out: lines.join("\n") };
	} finally {
		setOutputMode({ json: false, verbose: false });
		process.chdir(cwd);
		console.log = log;
		console.error = err;
	}
}

const keys = (argv: string[]) => parseArgs(argv, keysFlags);
const count = (text: string, part: string) => text.split(part).length - 1;
const CREATED = { id: ID, key: KEY, name: "standard-bot", role: "support", scopes: ["identity:resolve", "players:read"], createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2027-11-11T10:00:00.000Z" };
const LISTED = {
	keys: [
		{ id: "env:admin", name: "TYPETORCH_ADMIN_TOKEN", role: "admin", scopes: ["admin"], createdAt: null, createdBy: null, expiresAt: null, lastUsedAt: 1762855200000, revokedAt: null, builtIn: true },
		{ id: ID, name: "standard-bot", role: "support", scopes: ["identity:resolve", "players:read"], createdAt: "2026-11-11T10:00:00.000Z", createdBy: "admin token", expiresAt: "2027-11-11T10:00:00.000Z", lastUsedAt: null, revokedAt: null, builtIn: false },
	],
};

describe("validation", () => {
	test("names, roles and expiry", () => {
		expect(parseKeyName("standard-bot")).toBe("standard-bot");
		expect(parseKeyName("a.b_c-9")).toBe("a.b_c-9");
		expect(parseKeyName("x".repeat(48))).toBe("x".repeat(48));
		for (const bad of [undefined, "", "Upper", "has space", "x".repeat(49), "slash/no"]) expect(() => parseKeyName(bad)).toThrow("--name must be");
		for (const role of ["game", "lookup", "support", "analyst", "admin"]) expect(parseRole(role)).toBe(role as never);
		for (const bad of [undefined, "owner", "Admin", ""]) expect(() => parseRole(bad)).toThrow("--role must be one of game, lookup, support, analyst, admin");
		expect(parseExpires(undefined)).toBeUndefined();
		expect(parseExpires("90d")).toBe(90);
		expect(parseExpires("365d")).toBe(365);
		expect(parseExpires("1y")).toBe(365);
		expect(parseExpires("10y")).toBe(3650);
		expect(parseExpires("1d")).toBe(1);
		for (const bad of ["0d", "3651d", "11y", "90", "90 days", "-1d", "1.5y", "2w"]) expect(() => parseExpires(bad)).toThrow("--expires must be 1-3650 days");
	});

	test("revoke ids: key ids only; built-ins and whole keys refused (the key scrubbed)", () => {
		expect(parseRevokeId(ID)).toBe(ID);
		expect(() => parseRevokeId(undefined)).toThrow("typetorch keys revoke <id>");
		expect(() => parseRevokeId("env:admin")).toThrow("built-in key");
		expect(() => parseRevokeId("env:api-previous")).toThrow("change the variable");
		expect(() => parseRevokeId("ABC")).toThrow("isn't a key id");
		const pasted = `ttk_${ID}_pasted-secret-${"q".repeat(30)}`;
		let message = "";
		try {
			parseRevokeId(pasted);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("whole key");
		expect(message).not.toContain(pasted);
		expect(redact(`oops ${pasted}`)).not.toContain(pasted);
	});

	test("timestamps: ISO, unix ms, unix seconds, none", () => {
		expect(when("2027-11-11T10:00:00.000Z", "never")).toBe("2027-11-11 10:00");
		expect(when(1762855200000, "never")).toBe("2025-11-11 10:00");
		expect(when(1762855200, "never")).toBe("2025-11-11 10:00");
		expect(when(null, "never")).toBe("never");
	});
});

describe("keys create", () => {
	test("POST /v1/admin/keys with the admin token; the key printed exactly once, with the store-it-now line", async () => {
		const proj = project();
		const backend = fakeBackend({ "POST /v1/admin/keys": [201, CREATED] });
		const { out, error } = await run(proj, () => keysCommand(keys(["create", "--name", "standard-bot", "--role", "support", "--expires", "1y"]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls).toEqual([{ method: "POST", path: "/v1/admin/keys", auth: `Bearer ${ADMIN}`, body: { name: "standard-bot", role: "support", expiresDays: 365 } }]);
		expect(count(out, KEY)).toBe(1);
		expect(out).toContain("not shown again");
		expect(out).toContain(`${ID} "standard-bot", role support (identity:resolve, players:read), expires 2027-11-11 10:00`);
		// From now on the key is a known secret: redacted wherever the CLI redacts (errors, child processes).
		expect(redact(`x ${KEY} y`)).not.toContain(KEY);
		// Nothing written next to the project (no state file, no log).
		for (const file of readdirSync(proj.root, { recursive: true }) as string[]) {
			if (!file.endsWith("typetorch.json")) expect(readFileSync(join(proj.root, file), "utf8")).not.toContain(KEY);
		}
	});

	test("no --expires sends no expiresDays; --json returns the key once, in `key`", async () => {
		const proj = project();
		const backend = fakeBackend({ "POST /v1/admin/keys": [201, { ...CREATED, expiresAt: null }] });
		const { out, error } = await run(proj, () => keysCommand(keys(["create", "--name", "ci", "--role", "game"]), { fetch: backend.fetch }), true);
		expect(error).toBeUndefined();
		expect(backend.calls[0].body).toEqual({ name: "ci", role: "game" });
		expect(count(out, KEY)).toBe(1);
		expect(JSON.parse(out)).toMatchObject({ id: ID, key: KEY, role: "support", scopes: ["identity:resolve", "players:read"], expiresAt: null });
	});

	test("bad input never reaches the backend", async () => {
		const proj = project();
		const backend = fakeBackend({ "POST /v1/admin/keys": [201, CREATED] });
		for (const [argv, message] of [
			[["create", "--role", "support"], "--name must be"],
			[["create", "--name", "Bot", "--role", "support"], "--name must be"],
			[["create", "--name", "bot"], "--role must be"],
			[["create", "--name", "bot", "--role", "root"], "--role must be"],
			[["create", "--name", "bot", "--role", "game", "--expires", "0d"], "--expires must be"],
			[["create", "--name", "bot", "--role", "game", "--all"], "--all belongs to `typetorch keys list`"],
			[["create", "extra", "--name", "bot", "--role", "game"], 'unexpected argument "extra"'],
		] as [string[], string][]) {
			const { error } = await run(proj, () => keysCommand(keys(argv), { fetch: backend.fetch }));
			expect(error?.message).toContain(message);
		}
		expect(backend.calls).toHaveLength(0);
	});

	test("no admin token or no backend.url: refused before any request", async () => {
		const backend = fakeBackend({ "POST /v1/admin/keys": [201, CREATED] });
		expect((await run(project({}, {}), () => keysCommand(keys(["create", "--name", "a", "--role", "game"]), { fetch: backend.fetch }))).error?.message).toContain("TYPETORCH_ADMIN_TOKEN");
		expect((await run(project({ backend: undefined }), () => keysCommand(keys(["create", "--name", "a", "--role", "game"]), { fetch: backend.fetch }))).error?.message).toContain("backend.url");
		expect(backend.calls).toHaveLength(0);
	});

	test("the backend's refusal is shown; a 2xx without an id never quotes its body (it may hold a key)", async () => {
		const proj = project();
		const taken = fakeBackend({ "POST /v1/admin/keys": [409, { error: "name in use: standard-bot" }] });
		const refused = await run(proj, () => keysCommand(keys(["create", "--name", "standard-bot", "--role", "support"]), { fetch: taken.fetch }));
		expect(refused.error?.message).toContain("POST /v1/admin/keys answered 409: name in use: standard-bot");
		const broken = fakeBackend({ "POST /v1/admin/keys": [201, { key: KEY }] });
		const odd = await run(proj, () => keysCommand(keys(["create", "--name", "x", "--role", "game"]), { fetch: broken.fetch }));
		expect(odd.error?.message).toContain("without an id");
		expect(odd.error?.message).not.toContain(KEY);
		expect(odd.out).not.toContain(KEY);
		const strange = fakeBackend({ "POST /v1/admin/keys": [500, { key: KEY, error: `boom ${KEY}` }] });
		const failed = await run(proj, () => keysCommand(keys(["create", "--name", "x", "--role", "game"]), { fetch: strange.fetch }));
		expect(failed.error?.message).toContain("answered 500");
		expect(failed.error?.message).not.toContain(KEY);
	});

	test("the key appears in no other command's output", async () => {
		const proj = project();
		const backend = fakeBackend({ "POST /v1/admin/keys": [201, CREATED], "GET /v1/admin/keys": [200, LISTED], "GET /v1/admin/keys?all=1": [200, LISTED], [`DELETE /v1/admin/keys/${ID}`]: [200, { ok: true, id: ID, revokedAt: "2026-11-11T11:00:00.000Z" }] });
		await run(proj, () => keysCommand(keys(["create", "--name", "standard-bot", "--role", "support"]), { fetch: backend.fetch }));
		for (const argv of [["list"], ["list", "--all"], ["revoke", ID]]) {
			for (const json of [false, true]) {
				const { out, error } = await run(proj, () => keysCommand(keys(argv), { fetch: backend.fetch }), json);
				expect(error).toBeUndefined();
				expect(out).not.toContain(KEY);
			}
		}
	});
});

describe("keys list", () => {
	test("GET /v1/admin/keys; a table with id, name, role, scopes, expiry, last use, state", async () => {
		const proj = project();
		const backend = fakeBackend({ "GET /v1/admin/keys": [200, LISTED] });
		const { out, error } = await run(proj, () => keysCommand(keys(["list"]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls).toEqual([{ method: "GET", path: "/v1/admin/keys", auth: `Bearer ${ADMIN}`, body: undefined }]);
		const lines = out.split("\n");
		expect(lines[0]).toMatch(/^id\s+name\s+role\s+scopes\s+expires\s+last used\s+state$/);
		expect(lines[1]).toMatch(/^env:admin\s+TYPETORCH_ADMIN_TOKEN\s+admin\s+admin\s+never\s+2025-11-11 10:00\s+built-in$/);
		expect(lines[2]).toMatch(/^a1b2c3d4e5\s+standard-bot\s+support\s+identity:resolve,players:read\s+2027-11-11 10:00\s+never\s+active$/);
	});

	test("--all asks for revoked ones too; --json returns the keys", async () => {
		const proj = project();
		const withRevoked = { keys: [...LISTED.keys, { ...LISTED.keys[1], id: "zzzzzzzzzz", name: "old", revokedAt: "2026-11-01T00:00:00.000Z" }] };
		const backend = fakeBackend({ "GET /v1/admin/keys?all=1": [200, withRevoked] });
		const plain = await run(proj, () => keysCommand(keys(["list", "--all"]), { fetch: backend.fetch }));
		expect(backend.calls[0].path).toBe("/v1/admin/keys?all=1");
		expect(plain.out).toContain("revoked 2026-11-01 00:00");
		const json = await run(proj, () => keysCommand(keys(["list", "--all"]), { fetch: backend.fetch }), true);
		expect(JSON.parse(json.out).keys).toHaveLength(3);
		expect(JSON.parse(json.out).keys[0]).toMatchObject({ id: "env:admin", builtIn: true });
	});

	test("create-only flags are refused", async () => {
		const { error } = await run(project(), () => keysCommand(keys(["list", "--role", "admin"]), { fetch: fakeBackend({}).fetch }));
		expect(error?.message).toContain("--role belongs to");
	});
});

describe("keys revoke", () => {
	test("DELETE /v1/admin/keys/{id}", async () => {
		const proj = project();
		const backend = fakeBackend({ [`DELETE /v1/admin/keys/${ID}`]: [200, { ok: true, id: ID, revokedAt: "2026-11-11T11:00:00.000Z" }] });
		const { out, error } = await run(proj, () => keysCommand(keys(["revoke", ID]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls).toEqual([{ method: "DELETE", path: `/v1/admin/keys/${ID}`, auth: `Bearer ${ADMIN}`, body: undefined }]);
		expect(out).toContain(`API key ${ID} revoked at 2026-11-11 11:00`);
	});

	test("built-in env:* ids, bad ids and whole keys are refused locally", async () => {
		const proj = project();
		const backend = fakeBackend({});
		for (const [arg, message] of [
			["env:admin", "built-in key"],
			["env:api", "change the variable"],
			["nope", "isn't a key id"],
			[KEY, "whole key"],
		] as [string, string][]) {
			const { error, out } = await run(proj, () => keysCommand(keys(["revoke", arg]), { fetch: backend.fetch }));
			expect(error?.message).toContain(message);
			expect(error?.message).not.toContain(KEY);
			expect(out).not.toContain(KEY);
		}
		expect(backend.calls).toHaveLength(0);
	});

	test("the backend's answer for an unknown id is shown", async () => {
		const backend = fakeBackend({ "DELETE /v1/admin/keys/zzzzzzzzzz": [404, { error: "no such key" }] });
		const { error } = await run(project(), () => keysCommand(keys(["revoke", "zzzzzzzzzz"]), { fetch: backend.fetch }));
		expect(error?.message).toContain("DELETE /v1/admin/keys/zzzzzzzzzz answered 404: no such key");
	});
});

describe("the signing-key subcommands are unchanged", () => {
	test("API-key flags are refused on them; an unknown subcommand names both groups", async () => {
		const proj = project();
		expect((await run(proj, () => keysCommand(keys(["rotate", "--name", "x"])))).error?.message).toContain("--name belongs to");
		expect((await run(proj, () => keysCommand(keys(["nope"])))).error?.message).toContain("API keys: create, list, revoke");
	});
});
