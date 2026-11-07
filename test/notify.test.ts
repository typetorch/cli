/**
 * Experience notifications (plans/29, plans/29-contract.md): the typetorch.json `notifications` rules, the repeatable
 * --param flag, each `typetorch notify` request (a fake backend), key rotate (backend before record, previous carried,
 * other fields kept, the key never printed), pause / resume through the runtime-settings route, the settings record's
 * backend.notify (kept by backend setup, masked, validated) and doctor's scope probe. Fake keys only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flagList, parseArgs } from "../src/args";
import { notifyScopeProbe } from "../src/commands/doctor";
import { dashboardUrl, haltedLines, keyFingerprintOf, kindStub, NOTIFY_KINDS_DOCS, notificationsStub, paramMismatch, templateRows, newNotifyKey, notifyCommand, notifyFlags, parseData, parseParams, parseUserId } from "../src/commands/notify";
import { changeSettings } from "../src/commands/settings";
import { templatePlaceholders, validateConfig, validateNotifications, type Project } from "../src/config";
import { setJsonPath } from "../src/json";
import { Settings, useSettings } from "../src/env";
import { setOutputMode } from "../src/log";
import { backendProblems, describeFields, maskSecrets, signSettings, withBackend, type SettingsBody, type SettingsRecord } from "../src/settings";
import { generateSigningKey, parseSigningKey, type DualSigner } from "../src/signing";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";

const HOST = "https://backend.example.com";
const ADMIN = "admin-token-for-tests-0123456789ab";
const GAME_KEY = "game-key-for-tests-0123456789abcd";
const OLD_KEY = "o".repeat(43);
const PREV_KEY = "p".repeat(43);
const FIXED = Buffer.alloc(32, 7);
const NEW_KEY = FIXED.toString("base64url");

const KINDS = {
	gift_new: { template: "msg-gift", priority: 10, repeat: "per_key", send: "preferred_hour", maxWaitHours: 48 },
	streak: { template: "msg-streak", priority: 60, repeat: "daily", beats: { kinds: ["gift_new"], withinHours: 4 } },
	daily: { priority: 70, repeat: "daily", perWeek: 3 },
};
const NOTIFICATIONS = { dailyCap: 1, quietAfterLeaveMinutes: 120, lapse: [[14, 7], [30, 2], [60, 1]], unopenedBackoff: { after: 5, factor: 0.5, days: 14 }, kinds: KINDS };

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(patch: Record<string, unknown> = {}, env: Record<string, string> = { TYPETORCH_ADMIN_TOKEN: ADMIN }): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-notify-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, approval: "none", backend: { url: HOST }, notifications: NOTIFICATIONS, ...patch };
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

/** A fake backend: records each call (in `order` too) and answers from `routes` ("METHOD /path" -> [status, json]). */
function fakeBackend(routes: Record<string, [number, unknown]> = {}, order: string[] = []) {
	const calls: Call[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization"), body });
		order.push(`backend ${method} ${url.pathname}`);
		const [status, json] = routes[`${method} ${url.pathname}`] ?? (url.pathname === "/v1/access" ? [200, { changed: true }] : [404, { error: "no route" }]);
		return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetch: fetcher, calls };
}

async function run<T>(proj: Project, fn: () => Promise<T>, json = false): Promise<{ result?: T; out: string; error?: Error }> {
	const lines: string[] = [];
	const log = console.log;
	const err = console.error;
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	const cwd = process.cwd();
	process.chdir(proj.root);
	setOutputMode({ json, verbose: false });
	try {
		return { result: await fn(), out: lines.join("\n") };
	} catch (error) {
		return { error: error as Error, out: lines.join("\n") };
	} finally {
		setOutputMode({ json: false, verbose: false });
		process.chdir(cwd);
		console.log = log;
		console.error = err;
	}
}

const notify = (argv: string[]) => parseArgs(argv, notifyFlags);
const AT = () => new Date("2026-11-07T12:00:00.000Z");
const NOW_S = Math.floor(AT().getTime() / 1000);
const bodyOf = (cloud: ReturnType<typeof fakeDataStoreCloud>): SettingsBody => JSON.parse((cloud.values.settings as SettingsRecord).body);

describe("typetorch.json notifications (the contract's rules)", () => {
	const kind = (patch: Record<string, unknown>) => ({ kinds: { gift_new: { priority: 10, repeat: "per_key", ...patch } } });
	const cases: [string, unknown, string | null][] = [
		["the plan's example", NOTIFICATIONS, null],
		["no kinds at all", { kinds: {} }, null],
		["not an object", [], "must be an object"],
		["kinds missing", { dailyCap: 1 }, "kinds\" must map"],
		["unknown top-level field", { kinds: {}, dailyCaps: 1 }, "dailyCaps\" is not a setting"],
		["dailyCap 0", { kinds: {}, dailyCap: 0 }, "dailyCap\" must be a whole number from 1 to 3"],
		["dailyCap 4", { kinds: {}, dailyCap: 4 }, "from 1 to 3"],
		["dailyCap 1.5", { kinds: {}, dailyCap: 1.5 }, "from 1 to 3"],
		["dailyCap 3", { kinds: {}, dailyCap: 3 }, null],
		["quiet negative", { kinds: {}, quietAfterLeaveMinutes: -1 }, "quietAfterLeaveMinutes"],
		["lapse descending", { kinds: {}, lapse: [[30, 2], [14, 7]] }, "ascending days"],
		["lapse repeated day", { kinds: {}, lapse: [[14, 2], [14, 1]] }, "ascending days"],
		["lapse bad pair", { kinds: {}, lapse: [[14]] }, "must be [days, perWeek]"],
		["lapse not a list", { kinds: {}, lapse: { 14: 7 } }, "list of [days, perWeek]"],
		["backoff factor 0", { kinds: {}, unopenedBackoff: { after: 5, factor: 0, days: 14 } }, "factor"],
		["backoff unknown field", { kinds: {}, unopenedBackoff: { after: 5, factor: 0.5, days: 14, x: 1 } }, "unopenedBackoff.x"],
		["kind name upper case", { kinds: { GiftNew: { priority: 1, repeat: "daily" } } }, "a kind name is 1-24 characters"],
		["kind name 25 chars", { kinds: { ["a".repeat(25)]: { priority: 1, repeat: "daily" } } }, "a kind name is 1-24 characters"],
		["kind name 24 chars", { kinds: { ["a".repeat(24)]: { priority: 1, repeat: "daily" } } }, null],
		["custom is reserved", { kinds: { custom: { priority: 1, repeat: "daily" } } }, "\"custom\" is reserved"],
		["priority missing", kind({ priority: undefined }), "priority\" must be a whole number from 0 to 1000"],
		["priority 1001", kind({ priority: 1001 }), "0 to 1000"],
		["priority -1", kind({ priority: -1 }), "0 to 1000"],
		["priority 0", kind({ priority: 0 }), null],
		["priority 1000", kind({ priority: 1000 }), null],
		["priority 2.5", kind({ priority: 2.5 }), "0 to 1000"],
		["repeat unknown", kind({ repeat: "weekly" }), "repeat\" must be one of once_ever, per_key, daily"],
		["send unknown", kind({ send: "later" }), "send\" must be one of asap, preferred_hour"],
		["perWeek 0", kind({ perWeek: 0 }), "perWeek\" must be a whole number from 1 to 7"],
		["perWeek 8", kind({ perWeek: 8 }), "1 to 7"],
		["perWeek 7", kind({ perWeek: 7 }), null],
		["template 128", kind({ template: "t".repeat(128) }), null],
		["template 129", kind({ template: "t".repeat(129) }), "template\" must be the notification's message id (1-128"],
		["template empty", kind({ template: "" }), "template"],
		["maxWaitHours 0", kind({ maxWaitHours: 0 }), "maxWaitHours"],
		["category empty", kind({ category: "" }), "category"],
		["allowTemplate string", kind({ allowTemplate: "yes" }), "allowTemplate"],
		["beats bad", kind({ beats: { kinds: "streak", withinHours: 4 } }), "beats\" must be"],
		["beats ok", kind({ beats: { kinds: ["streak"], withinHours: 4 } }), null],
		["unknown kind field", kind({ prio: 1 }), "gift_new.prio\" is not a setting"],
		["kind not an object", { kinds: { gift_new: 3 } }, "must be { template, priority, repeat"],
	];
	for (const [name, raw, problem] of cases) {
		test(name, () => {
			const { notifications, errors } = validateNotifications(raw);
			if (problem === null) {
				expect(errors).toEqual([]);
				expect(notifications).toEqual(raw as never);
			} else {
				expect(notifications).toBeUndefined();
				expect(errors.join("\n")).toContain(problem);
			}
		});
	}

	test("typetorch.json reads it (no unknown-key warning) and refuses a bad one", () => {
		const base = { project: "g", universeId: 1, placeId: 2, creator: { userId: 3 } };
		const good = validateConfig({ ...base, notifications: NOTIFICATIONS });
		expect(good.warnings).toEqual([]);
		expect(good.config?.notifications).toEqual(NOTIFICATIONS as never);
		const bad = validateConfig({ ...base, notifications: { kinds: { custom: { priority: 1, repeat: "daily" } } } });
		expect(bad.config).toBeUndefined();
		expect(bad.errors.join()).toContain("reserved");
	});
});

describe("inputs", () => {
	test("--param is repeatable; other flags keep the last value", () => {
		const args = notify(["test", "1", "k", "--param", "a=1", "--param=b=x=y", "--data", "d"]);
		expect(flagList(args, "param")).toEqual(["a=1", "b=x=y"]);
		expect(args.flags.param).toBe("b=x=y");
		expect(flagList(notify(["status"]), "param")).toEqual([]);
	});

	test("params, data and user ids follow the contract's caps", () => {
		expect(parseParams([])).toBeUndefined();
		expect(parseParams(["gift=5 Z-Coins", "days=5", "empty="])).toEqual({ gift: "5 Z-Coins", days: "5", empty: "" });
		expect(() => parseParams(["noequals"])).toThrow("name=value");
		expect(() => parseParams(["bad.name=1"])).toThrow("a-z A-Z 0-9 _ -");
		expect(() => parseParams([`${"n".repeat(33)}=1`])).toThrow("1-32 characters");
		// Dashes: Roblox templates use {user-streak-remaining}.
		expect(parseParams(["user-streak-remaining=4", "days_left=2"])).toEqual({ "user-streak-remaining": "4", days_left: "2" });
		expect(() => parseParams(["a=1", "a=2"])).toThrow("twice");
		expect(() => parseParams([`a=${"v".repeat(65)}`])).toThrow("over 64");
		expect(parseParams([`a=${"v".repeat(64)}`])).toEqual({ a: "v".repeat(64) });
		expect(() => parseParams(Array.from({ length: 9 }, (_, i) => `p${i}=1`))).toThrow("at most 8");
		expect(parseData("mail:42")).toBe("mail:42");
		expect(() => parseData("é".repeat(33))).toThrow("66 bytes");
		expect(parseUserId("123456789")).toBe(123456789);
		for (const bad of ["0", "-1", "1.5", "abc", undefined, "99999999999999999999"]) expect(() => parseUserId(bad)).toThrow("UserId");
	});

	test("a new key is 43 base64url characters of 32 random bytes; the fingerprint is 8 hex", () => {
		expect(newNotifyKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(newNotifyKey(() => FIXED)).toBe(NEW_KEY);
		expect(keyFingerprintOf("k".repeat(43))).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("notify commands (each request)", () => {
	test("push: PUT /v1/notify/config with typetorch.json's notifications as-is and the admin token", async () => {
		const proj = project();
		const backend = fakeBackend({ "PUT /v1/notify/config": [200, { ok: true }] });
		const { error, out } = await run(proj, () => notifyCommand(notify(["push"]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls).toHaveLength(1);
		expect(backend.calls[0]).toEqual({ method: "PUT", path: "/v1/notify/config", auth: `Bearer ${ADMIN}`, body: NOTIFICATIONS });
		expect(out).toContain("3 kinds");
		expect(out).toContain("no template for daily");
	});

	test("push --dry-run sends nothing; no notifications section or no admin token = refused", async () => {
		const backend = fakeBackend();
		expect((await run(project(), () => notifyCommand(notify(["push", "--dry-run"]), { fetch: backend.fetch }))).error).toBeUndefined();
		expect(backend.calls).toHaveLength(0);
		const none = await run(project({ notifications: undefined }), () => notifyCommand(notify(["push"]), { fetch: backend.fetch }));
		expect(none.error?.message).toContain('no "notifications" section');
		const noAdmin = await run(project({}, {}), () => notifyCommand(notify(["push"]), { fetch: backend.fetch }));
		expect(noAdmin.error?.message).toContain("TYPETORCH_ADMIN_TOKEN");
		expect(backend.calls).toHaveLength(0);
	});

	test("push: the backend's refusal is shown", async () => {
		const backend = fakeBackend({ "PUT /v1/notify/config": [400, { error: "kinds.x.priority must be 0..1000" }] });
		const { error } = await run(project(), () => notifyCommand(notify(["push"]), { fetch: backend.fetch }));
		expect(error?.message).toContain("PUT /v1/notify/config answered 400: kinds.x.priority must be 0..1000");
	});

	const STATUS = {
		enabled: true,
		dryRun: true,
		rate: 10,
		clock: "rolling24",
		keys: { current: true, previous: false, since: NOW_S },
		kinds: [
			{ kind: "gift_new", enabled: true, template: true, pending: 3 },
			{ kind: "streak", enabled: false, template: true, pending: 2, halted: "bad_template" },
			{ kind: "daily", enabled: true, template: false, pending: 0 },
		],
		queue: { pending: 5, due1h: 1, sending: 0 },
		bucket: { rate: 10, tokens: 10, last429At: null },
		sends24h: { sent: 4, failed: 1, dry: 7 },
	};

	test("status: GET /v1/notify/status and /v1/notify/config; a halted kind stands out with the way back", async () => {
		const backend = fakeBackend({ "GET /v1/notify/status": [200, STATUS], "GET /v1/notify/config": [200, { config: NOTIFICATIONS, updatedAt: "2026-11-07T10:00:00Z", by: "admin token" }] });
		const { error, out } = await run(project(), () => notifyCommand(notify(["status"]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/notify/status", "GET /v1/notify/config"]);
		expect(out).toContain("dry run");
		expect(out).toContain("HALTED (bad_template)");
		expect(out).toContain("streak is HALTED");
		expect(out).toContain("typetorch notify push");
		expect(out).toContain("typetorch notify resume streak");
		expect(out).toContain("pushed config matches typetorch.json");
		expect(out).toContain("5 pending, 1 due within 1 h");
	});

	test("status: a differing pushed config warns; --json carries the halted kinds", async () => {
		const backend = fakeBackend({ "GET /v1/notify/status": [200, STATUS], "GET /v1/notify/config": [200, { config: { kinds: {} }, updatedAt: null, by: null }] });
		const plain = await run(project(), () => notifyCommand(notify(["status"]), { fetch: backend.fetch }));
		expect(plain.out).toContain("differs from typetorch.json");
		const json = await run(project(), () => notifyCommand(notify(["status"]), { fetch: backend.fetch }), true);
		const parsed = JSON.parse(json.out) as { haltedKinds: unknown; haltedAll: unknown; config: { matches: boolean } };
		expect(parsed.haltedKinds).toEqual([{ kind: "streak", why: "bad_template" }]);
		expect(parsed.haltedAll).toBeNull();
		expect(parsed.config.matches).toBe(false);
	});

	test("haltedLines: only halted kinds, bad_template with the fix", () => {
		expect(haltedLines({ kinds: [{ kind: "a", enabled: true, template: true, pending: 0 }] })).toEqual([]);
		const [line] = haltedLines({ kinds: [{ kind: "a", enabled: false, template: true, pending: 1, halted: "bad_template" }] });
		expect(line).toContain("notifications.kinds.a.template");
		expect(line).toContain("1 pending intent wait");
	});

	test("status: all sending halted for auth stands out (a top-level string, or a halted entry without a kind)", async () => {
		for (const halted of ["auth", [{ why: "auth", at: 1 }], [{ kind: "streak", why: "bad_template", at: 1 }, { why: "auth", at: 2 }]]) {
			const backend = fakeBackend({ "GET /v1/notify/status": [200, { ...STATUS, halted }], "GET /v1/notify/config": [200, { config: NOTIFICATIONS, updatedAt: null, by: null }] });
			const { out } = await run(project(), () => notifyCommand(notify(["status"]), { fetch: backend.fetch }));
			expect(out).toContain("ALL SENDING HALTED (auth)");
			expect(out).toContain("user.user-notification:write");
		}
		// The backend's per-kind halted list alone is not a global halt.
		const perKind = fakeBackend({ "GET /v1/notify/status": [200, { ...STATUS, halted: [{ kind: "streak", why: "bad_template", at: 1 }] }], "GET /v1/notify/config": [200, { config: NOTIFICATIONS, updatedAt: null, by: null }] });
		const { out } = await run(project(), () => notifyCommand(notify(["status"]), { fetch: perKind.fetch }));
		expect(out).not.toContain("ALL SENDING HALTED");
	});

	test("test: POST /v1/notify/test { userId, kind, params, data }", async () => {
		const backend = fakeBackend({ "POST /v1/notify/test": [200, { nid: "abc0123xyz", status: "planned" }] });
		const { error, out } = await run(project(), () => notifyCommand(notify(["test", "123456789", "gift_new", "--param", "gift=5 Z-Coins", "--param", "n=2", "--data", "mail:42"]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls[0]).toEqual({ method: "POST", path: "/v1/notify/test", auth: `Bearer ${ADMIN}`, body: { userId: 123456789, kind: "gift_new", params: { gift: "5 Z-Coins", n: "2" }, data: "mail:42" } });
		expect(out).toContain("planned (nid abc0123xyz)");
	});

	test("test: no params or data = none sent; a bad kind or user id never reaches the backend", async () => {
		const backend = fakeBackend({ "POST /v1/notify/test": [200, { nid: "n", status: "planned" }] });
		await run(project(), () => notifyCommand(notify(["test", "5", "streak"]), { fetch: backend.fetch }));
		expect(backend.calls[0].body).toEqual({ userId: 5, kind: "streak" });
		const bad = await run(project(), () => notifyCommand(notify(["test", "5", "Bad-Kind"]), { fetch: backend.fetch }));
		expect(bad.error?.message).toContain("isn't a kind name");
		const badUser = await run(project(), () => notifyCommand(notify(["test", "me", "streak"]), { fetch: backend.fetch }));
		expect(badUser.error?.message).toContain("UserId");
		expect(backend.calls).toHaveLength(1);
	});

	test("send: POST /v1/notify/send { userId, template, params, data }; skipped is shown", async () => {
		const backend = fakeBackend({ "POST /v1/notify/send": [200, { skipped: "capped_day" }] });
		const { error, out } = await run(project(), () => notifyCommand(notify(["send", "42", "msg-event", "--param", "x=1", "--data", "ev"]), { fetch: backend.fetch }));
		expect(error).toBeUndefined();
		expect(backend.calls[0]).toEqual({ method: "POST", path: "/v1/notify/send", auth: `Bearer ${ADMIN}`, body: { userId: 42, template: "msg-event", params: { x: "1" }, data: "ev" } });
		expect(out).toContain("not sent: capped_day");
	});

	test("pause / resume: PATCH /v1/admin/settings notify.enabled; with a kind, notify.kinds.<kind>.enabled", async () => {
		const backend = fakeBackend({ "PATCH /v1/admin/settings": [200, { changed: ["notify.enabled"] }] });
		const paused = await run(project(), () => notifyCommand(notify(["pause"]), { fetch: backend.fetch }));
		expect(paused.error).toBeUndefined();
		expect(backend.calls[0]).toEqual({ method: "PATCH", path: "/v1/admin/settings", auth: `Bearer ${ADMIN}`, body: { "notify.enabled": false } });
		expect(paused.out).toContain("notifications paused");
		const resumed = await run(project(), () => notifyCommand(notify(["resume"]), { fetch: backend.fetch }));
		expect(backend.calls[1].body).toEqual({ "notify.enabled": true });
		expect(resumed.out).toContain("notifications resumed");
		const kind = await run(project(), () => notifyCommand(notify(["resume", "streak"]), { fetch: backend.fetch }));
		expect(backend.calls[2].body).toEqual({ "notify.kinds.streak.enabled": true });
		expect(kind.out).toContain("already on");
		await run(project(), () => notifyCommand(notify(["pause", "gift_new"]), { fetch: backend.fetch }));
		expect(backend.calls[3].body).toEqual({ "notify.kinds.gift_new.enabled": false });
	});

	test("pause: the backend's refusal (runtime settings off) is an error", async () => {
		const backend = fakeBackend({ "PATCH /v1/admin/settings": [409, { error: "runtime settings are off (TYPETORCH_RUNTIME_SETTINGS)" }] });
		const { error } = await run(project(), () => notifyCommand(notify(["pause"]), { fetch: backend.fetch }));
		expect(error?.message).toContain("PATCH /v1/admin/settings answered 409: runtime settings are off");
	});

	test("usage errors", async () => {
		const backend = fakeBackend();
		for (const [argv, message] of [
			[["nope"], "unknown notify subcommand"],
			[["key"], "unknown notify key subcommand"],
			[["key", "rotate", "now"], 'unexpected argument "now"'],
			[["status", "--param", "a=1"], "--param and --data belong"],
			[["push", "extra"], 'unexpected argument "extra"'],
			[["send", "1"], "typetorch notify send <userId> <template>"],
		] as [string[], string][]) {
			const { error } = await run(project(), () => notifyCommand(notify(argv), { fetch: backend.fetch }));
			expect(error?.message).toContain(message);
		}
		expect(backend.calls).toHaveLength(0);
	});
});

describe("notify key rotate", () => {
	const signer = newSigner();
	const recordBody = (notifyKeys?: { current: string; previous?: string; since: number }): SettingsBody => ({
		...withBackend({ game: { coins: 5 }, access: { members: { "1": "owner" }, revoked: {}, devBadgeId: null } }, { url: HOST, key: GAME_KEY, analytics: { flushSeconds: 15 } }),
		...(notifyKeys ? { backend: { url: HOST, key: GAME_KEY, analytics: { flushSeconds: 15 }, notify: { keys: notifyKeys } } } : {}),
	});
	const seeded = (body: SettingsBody, by: DualSigner = signer) => fakeDataStoreCloud({ settings: signSettings(by, 4, "2026-11-01T00:00:00.000Z", body) });

	/** The cloud with every DataStore call and ping also written to `order`. */
	function ordered(cloud: ReturnType<typeof fakeDataStoreCloud>, order: string[]) {
		return {
			request: async (method: string, path: string, opts?: unknown) => {
				order.push(`datastore ${method}`);
				return cloud.oc.request(method, path, opts as never);
			},
			publishMessage: async (universeId: number, topic: string, message: string) => {
				order.push("ping");
				return cloud.oc.publishMessage(universeId, topic, message);
			},
		} as never;
	}

	test("the record first (pinged), then the backend; previous = the old current; every other field kept; the key never printed", async () => {
		const proj = project();
		const order: string[] = [];
		const cloud = seeded(recordBody({ current: OLD_KEY, since: NOW_S - 30 * 86_400 }));
		const before = bodyOf(cloud);
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] }, order);
		const { error, out } = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: ordered(cloud, order), signer, now: AT, random: () => FIXED }));
		expect(error).toBeUndefined();
		const keysCall = backend.calls.find((c) => c.path === "/v1/notify/keys")!;
		expect(keysCall).toEqual({ method: "PUT", path: "/v1/notify/keys", auth: `Bearer ${ADMIN}`, body: { current: NEW_KEY, previous: OLD_KEY, since: NOW_S } });
		// Order: read the record, write it (GET + POST), ping the servers, and only then PUT the backend.
		const putAt = order.indexOf("backend PUT /v1/notify/keys");
		expect(order[0]).toBe("datastore GET");
		expect(order.slice(0, putAt)).toContain("datastore POST");
		expect(order.slice(0, putAt)).toContain("ping");
		expect(order.indexOf("ping")).toBeGreaterThan(order.indexOf("datastore POST"));
		expect(order.slice(putAt + 1).filter((step) => step.startsWith("datastore") || step === "ping")).toEqual([]);
		const after = bodyOf(cloud);
		expect(after.backend?.notify).toEqual({ keys: { current: NEW_KEY, previous: OLD_KEY, since: NOW_S } });
		const { notify: _, ...restAfter } = after.backend!;
		const { notify: __, ...restBefore } = before.backend!;
		expect(restAfter).toEqual(restBefore);
		expect({ ...after, backend: undefined }).toEqual({ ...before, backend: undefined });
		expect((cloud.values.settings as SettingsRecord).seq).toBe(5);
		expect(out).not.toContain(NEW_KEY);
		expect(out).not.toContain(OLD_KEY);
		expect(out).toContain(keyFingerprintOf(NEW_KEY));
		expect(out).toContain(keyFingerprintOf(OLD_KEY));
		expect(out).toContain("accepted for 14 days");
		expect(out).toContain("backend: stored");
	});

	test("--json carries fingerprints only", async () => {
		const proj = project();
		const cloud = seeded(recordBody({ current: OLD_KEY, previous: PREV_KEY, since: NOW_S - 30 * 86_400 }));
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const { error, out } = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: cloud.oc, signer, now: AT, random: () => FIXED }), true);
		expect(error).toBeUndefined();
		expect(out).not.toContain(NEW_KEY);
		expect(out).not.toContain(OLD_KEY);
		expect(out).not.toContain(PREV_KEY);
		expect(JSON.parse(out)).toMatchObject({ current: keyFingerprintOf(NEW_KEY), previous: keyFingerprintOf(OLD_KEY), seq: 5, outcome: "written", backend: "sent" });
		// The old previous is gone: one previous at a time.
		expect(bodyOf(cloud).backend?.notify?.keys).toEqual({ current: NEW_KEY, previous: OLD_KEY, since: NOW_S });
	});

	test("the first rotation has no previous", async () => {
		const proj = project();
		const cloud = seeded(recordBody());
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const { error } = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: cloud.oc, signer, now: AT, random: () => FIXED }));
		expect(error).toBeUndefined();
		expect(backend.calls.find((c) => c.path === "/v1/notify/keys")!.body).toEqual({ current: NEW_KEY, since: NOW_S });
		expect(bodyOf(cloud).backend?.notify).toEqual({ keys: { current: NEW_KEY, since: NOW_S } });
	});

	test("a rotation within 14 days of the last warns that the previous key is dropped; after 14 days it doesn't", async () => {
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const recent = await run(project(), () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: seeded(recordBody({ current: OLD_KEY, previous: PREV_KEY, since: NOW_S - 13 * 86_400 })).oc, signer, now: AT, random: () => FIXED }));
		expect(recent.out).toContain("under 14 days");
		const old = await run(project(), () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: seeded(recordBody({ current: OLD_KEY, previous: PREV_KEY, since: NOW_S - 15 * 86_400 })).oc, signer, now: AT, random: () => FIXED }));
		expect(old.out).not.toContain("under 14 days");
	});

	test("the backend refuses: the record keeps the new key (safe), exit 1, and the --backend-only way back", async () => {
		const proj = project();
		const cloud = seeded(recordBody({ current: OLD_KEY, since: NOW_S - 30 * 86_400 }));
		const backend = fakeBackend({ "PUT /v1/notify/keys": [500, { error: "disk full" }] });
		const { error, out } = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: cloud.oc, signer, now: AT, random: () => FIXED }));
		const exit = process.exitCode;
		process.exitCode = 0;
		expect(error).toBeUndefined();
		expect(exit).toBe(1);
		expect(out).toContain("disk full");
		expect(out).toContain("servers accept both keys and the backend keeps signing with the old one");
		expect(out).toContain("typetorch notify key rotate --backend-only");
		expect(out).not.toContain(NEW_KEY);
		expect(bodyOf(cloud).backend?.notify).toEqual({ keys: { current: NEW_KEY, previous: OLD_KEY, since: NOW_S } });

		// --backend-only: the record's keys (read back, verified) to the backend; the record is not written again.
		const fixed = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const seq = (cloud.values.settings as SettingsRecord).seq;
		const retry = await run(proj, () => notifyCommand(notify(["key", "rotate", "--backend-only"]), { fetch: fixed.fetch, oc: cloud.oc, signer, now: AT }));
		expect(retry.error).toBeUndefined();
		expect(fixed.calls).toEqual([{ method: "PUT", path: "/v1/notify/keys", auth: `Bearer ${ADMIN}`, body: { current: NEW_KEY, previous: OLD_KEY, since: NOW_S } }]);
		expect((cloud.values.settings as SettingsRecord).seq).toBe(seq);
		expect(retry.out).toContain(keyFingerprintOf(NEW_KEY));
		expect(retry.out).not.toContain(NEW_KEY);
	});

	test("--no-ping: the record only; the backend step waits for --backend-only", async () => {
		const proj = project();
		const cloud = seeded(recordBody({ current: OLD_KEY, since: NOW_S - 30 * 86_400 }));
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const { error, out } = await run(proj, () => notifyCommand(notify(["key", "rotate", "--no-ping"]), { fetch: backend.fetch, oc: cloud.oc, signer, now: AT, random: () => FIXED }));
		expect(error).toBeUndefined();
		expect(cloud.published).toHaveLength(0);
		expect(backend.calls.filter((c) => c.path === "/v1/notify/keys")).toHaveLength(0);
		expect(bodyOf(cloud).backend?.notify?.keys.current).toBe(NEW_KEY);
		expect(out).toContain("servers pick up the new key on their next settings read");
		expect(out).toContain("--backend-only");
	});

	test("--backend-only with no key in the record, or with --no-ping, is refused", async () => {
		const proj = project();
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const none = await run(proj, () => notifyCommand(notify(["key", "rotate", "--backend-only"]), { fetch: backend.fetch, oc: seeded(recordBody()).oc, signer }));
		expect(none.error?.message).toContain("holds no notify key yet");
		const flags = await run(proj, () => notifyCommand(notify(["key", "rotate", "--backend-only", "--no-ping"]), { fetch: backend.fetch, oc: seeded(recordBody()).oc, signer }));
		expect(flags.error?.message).toContain("--backend-only takes no");
		expect(backend.calls.filter((c) => c.path === "/v1/notify/keys")).toHaveLength(0);
	});

	test("no backend section, or a record your keys didn't sign: refused before the backend is called", async () => {
		const proj = project();
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const bare = seeded({ game: { coins: 1 } });
		const noBackend = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: bare.oc, signer, now: AT }));
		expect(noBackend.error?.message).toContain("typetorch backend setup");
		const foreign = seeded(recordBody({ current: OLD_KEY, since: 1 }), newSigner());
		const untrusted = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: foreign.oc, signer, now: AT }));
		expect(untrusted.error?.message).toContain("isn't signed by your keys");
		expect(backend.calls.filter((c) => c.path === "/v1/notify/keys")).toHaveLength(0);
	});

	test("another machine rotated between the read and the write: an error, nothing written, the backend untouched", async () => {
		const proj = project();
		const cloud = seeded(recordBody({ current: OLD_KEY, since: NOW_S - 30 * 86_400 }));
		const other = signSettings(signer, 5, "2026-11-07T11:00:00.000Z", recordBody({ current: PREV_KEY, since: NOW_S - 10 }));
		// The record moves just before our write (a conflict); the retry sees another key.
		cloud.serverWrites("settings", () => other);
		const backend = fakeBackend({ "PUT /v1/notify/keys": [200, { ok: true }] });
		const { error } = await run(proj, () => notifyCommand(notify(["key", "rotate"]), { fetch: backend.fetch, oc: cloud.oc, signer, now: AT, random: () => FIXED }));
		expect(error?.message).toContain("another machine rotated");
		expect(bodyOf(cloud).backend?.notify?.keys.current).toBe(PREV_KEY);
		expect(backend.calls.filter((c) => c.path === "/v1/notify/keys")).toHaveLength(0);
	});

	test("--dry-run calls nothing and writes nothing", async () => {
		const proj = project();
		const cloud = seeded(recordBody({ current: OLD_KEY, since: 1 }));
		const before = cloud.values.settings;
		const backend = fakeBackend();
		const { error, out } = await run(proj, () => notifyCommand(notify(["key", "rotate", "--dry-run"]), { fetch: backend.fetch, oc: cloud.oc, signer, now: AT }));
		expect(error).toBeUndefined();
		expect(backend.calls).toHaveLength(0);
		expect(cloud.values.settings).toEqual(before);
		expect(out).toContain("dry run");
	});
});

describe("the settings record's backend.notify", () => {
	const keys = { current: OLD_KEY, previous: PREV_KEY, since: 1_762_500_000 };

	test("backend setup (withBackend) keeps the notify keys", () => {
		const body: SettingsBody = { backend: { url: HOST, key: GAME_KEY, notify: { keys } } };
		expect(withBackend(body, { url: "https://other.example.com", key: GAME_KEY }).backend?.notify).toEqual({ keys });
		expect(withBackend({}, { url: HOST, key: GAME_KEY }).backend?.notify).toBeUndefined();
	});

	test("masked everywhere it is shown", () => {
		const masked = JSON.stringify(maskSecrets({ backend: { url: HOST, key: GAME_KEY, notify: { keys } } }, "backend"));
		expect(masked).not.toContain(OLD_KEY);
		expect(masked).not.toContain(PREV_KEY);
		expect(masked).toContain('"since":1762500000');
		const lines = describeFields({ backend: { url: HOST, key: GAME_KEY, notify: { keys } } }).join("\n");
		expect(lines).toContain("notify keys    set (hidden)");
		expect(lines).not.toContain(OLD_KEY);
	});

	test("validated (shape only, never the value in the message)", () => {
		const base = { url: HOST, key: GAME_KEY };
		expect(backendProblems({ ...base, notify: { keys } })).toEqual([]);
		expect(backendProblems({ ...base, notify: { keys: { current: "short", since: 1 } } }).join()).toContain("43 base64url");
		expect(backendProblems({ ...base, notify: { keys: { current: OLD_KEY, previous: OLD_KEY, since: 1 } } }).join()).toContain("must differ");
		expect(backendProblems({ ...base, notify: { keys: { current: OLD_KEY } } }).join()).toContain("since");
		expect(backendProblems({ ...base, notify: {} }).join()).toContain("backend.notify must be");
		expect(backendProblems({ ...base, notify: { keys: { current: "short", since: 1 } } }).join()).not.toContain("short");
	});

	test("a notify change needs no endpoint check (it holds no address or backend key)", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = fakeDataStoreCloud({ settings: signSettings(signer, 1, "2026-11-01T00:00:00.000Z", withBackend({}, { url: HOST, key: GAME_KEY })) });
		const backend = fakeBackend();
		const result = await changeSettings({ proj, oc: cloud.oc, signer, what: "t", fetch: backend.fetch, mutate: (b) => ({ ...b, backend: { ...b.backend!, notify: { keys } } }) });
		expect(result.outcome).toBe("written");
		// A changed address is still refused without its check.
		await expect(changeSettings({ proj, oc: cloud.oc, signer, what: "t", fetch: backend.fetch, mutate: (b) => ({ ...b, backend: { ...b.backend!, url: "https://evil.example.com" } }) })).rejects.toThrow("without checking its endpoint");
	});
});

describe("template texts and dashed placeholders", () => {
	test("placeholders: names [a-zA-Z0-9_-]{1,32}, balanced braces, at most 99 characters", () => {
		expect(templatePlaceholders("{name} sent you {gift}! {name}")).toEqual({ names: ["name", "gift"] });
		expect(templatePlaceholders("Your {user-streak-remaining} day streak ends in {hours}h")).toEqual({ names: ["user-streak-remaining", "hours"] });
		expect(templatePlaceholders("No placeholders here")).toEqual({ names: [] });
		expect(templatePlaceholders("x".repeat(99)).problem).toBeUndefined();
		expect(templatePlaceholders("x".repeat(100)).problem).toContain("100 characters; Roblox allows 99");
		expect(templatePlaceholders("").problem).toContain("empty");
		expect(templatePlaceholders("open {name").problem).toContain('"{" without its "}"');
		expect(templatePlaceholders("close name}").problem).toContain('"}" without its "{"');
		expect(templatePlaceholders("{a{b}}").problem).toContain("inside another placeholder");
		expect(templatePlaceholders("{}").problem).toContain("placeholder {}");
		expect(templatePlaceholders("{bad name}").problem).toContain("a-z A-Z 0-9 _ -");
		expect(templatePlaceholders(`{${"n".repeat(33)}}`).problem).toContain("1-32 characters");
	});

	test("the config validator checks text", () => {
		const kind = (text: unknown) => ({ kinds: { streak: { priority: 1, repeat: "daily", text } } });
		expect(validateNotifications(kind("Your {user-streak-remaining} day streak!")).errors).toEqual([]);
		expect(validateNotifications(kind("y".repeat(100))).errors.join()).toContain('"notifications.kinds.streak.text" is 100 characters');
		expect(validateNotifications(kind("broken {x")).errors.join()).toContain("without its");
		expect(validateNotifications(kind(5)).errors.join()).toContain("text\" must be a string");
	});

	test("params vs the kind's text", () => {
		expect(paramMismatch(undefined, { a: "1" })).toEqual([]);
		expect(paramMismatch("{a} {b-c}", { a: "1", "b-c": "2" })).toEqual([]);
		expect(paramMismatch("{a} {b-c}", { a: "1" }).join()).toContain("{b-c}");
		expect(paramMismatch("{a}", { a: "1", z: "2" }).join()).toContain("unknown_param");
	});

	test("setJsonPath changes one nested value and keeps the rest of the file as written", () => {
		const text = '{\n\t"project": "g",\n\t"notifications": {\n\t\t"kinds": {\n\t\t\t"streak": {\n\t\t\t\t"text": "hi",\n\t\t\t\t"priority": 1\n\t\t\t}\n\t\t}\n\t}\n}\n';
		const added = setJsonPath(text, ["notifications", "kinds", "streak", "template"], "abc");
		expect(added).toBe(text.replace('"priority": 1', '"priority": 1,\n\t\t\t\t"template": "abc"'));
		const replaced = setJsonPath(added, ["notifications", "kinds", "streak", "template"], "def");
		expect(replaced).toBe(added.replace('"abc"', '"def"'));
		expect(setJsonPath('{"a": {"b": {}}}', ["a", "b", "c"], 1)).toBe('{"a": {"b": { "c": 1 }}}');
		expect(setJsonPath('{"a": {"x": 1}}', ["a", "c"], 2)).toBe('{"a": {"x": 1, "c": 2}}');
		expect(() => setJsonPath('{"a": {}}', ["a", "missing", "c"], 1)).toThrow("doesn't exist");
	});
});

describe("notify templates", () => {
	const kinds = {
		gift_new: { text: "{sender} sent you {gift}!", template: "msg-gift", priority: 10, repeat: "per_key" },
		streak: { text: "Your {user-streak-remaining} day streak ends soon", priority: 60, repeat: "daily" },
		daily: { priority: 70, repeat: "daily" },
	};

	test("lists each kind's text copy-ready, its placeholders, its id, the dashboard link and the steps", async () => {
		const proj = project({ notifications: { kinds } });
		expect(templateRows(proj)).toEqual([
			{ kind: "gift_new", text: "{sender} sent you {gift}!", placeholders: ["sender", "gift"], template: "msg-gift" },
			{ kind: "streak", text: "Your {user-streak-remaining} day streak ends soon", placeholders: ["user-streak-remaining"], template: null },
			{ kind: "daily", text: null, placeholders: [], template: null },
		]);
		const { error, out } = await run(proj, () => notifyCommand(notify(["templates"])));
		expect(error).toBeUndefined();
		expect(out.split("\n")).toContain("Your {user-streak-remaining} day streak ends soon"); // its own line, nothing around it
		expect(out).toContain("1 made, 1 to make");
		expect(out).toContain("template msg-gift");
		expect(out).toContain("no template id yet");
		expect(out).toContain("{user-streak-remaining}");
		expect(out).toContain(dashboardUrl(42));
		expect(out).toContain("Engagement > Notifications");
		expect(out).toContain("typetorch notify templates set <kind> <message_id>");
		const json = await run(proj, () => notifyCommand(notify(["templates"])), true);
		expect(JSON.parse(json.out)).toMatchObject({ dashboard: "https://create.roblox.com/dashboard/creations/experiences/42/overview", kinds: [{ kind: "gift_new" }, { kind: "streak" }, { kind: "daily" }] });
	});

	test("set writes only the template id into typetorch.json", async () => {
		const proj = project({ notifications: { kinds } });
		const before = readFileSync(proj.configPath, "utf8");
		const { error, out } = await run(proj, () => notifyCommand(notify(["templates", "set", "streak", "a1b2-c3"])));
		expect(error).toBeUndefined();
		expect(out).toContain("streak: template a1b2-c3 written");
		const after = readFileSync(proj.configPath, "utf8");
		const parsed = JSON.parse(after);
		expect(parsed.notifications.kinds.streak.template).toBe("a1b2-c3");
		expect({ ...parsed, notifications: undefined }).toEqual({ ...JSON.parse(before), notifications: undefined });
		expect(after.split("\n").length).toBe(before.split("\n").length + 1);
		// Replacing an id changes only that value.
		await run(proj, () => notifyCommand(notify(["templates", "set", "gift_new", "msg-gift-2"])));
		expect(readFileSync(proj.configPath, "utf8")).toBe(after.replace('"msg-gift"', '"msg-gift-2"'));
	});

	test("set refuses an unknown kind or a bad id, and changes nothing", async () => {
		const proj = project({ notifications: { kinds } });
		const before = readFileSync(proj.configPath, "utf8");
		expect((await run(proj, () => notifyCommand(notify(["templates", "set", "nope", "x"])))).error?.message).toContain("isn't a kind in typetorch.json");
		expect((await run(proj, () => notifyCommand(notify(["templates", "set", "streak", "has space"])))).error?.message).toContain("isn't a message id");
		expect((await run(proj, () => notifyCommand(notify(["templates", "set", "streak"])))).error?.message).toContain("templates set <kind> <message_id>");
		expect((await run(proj, () => notifyCommand(notify(["templates", "bogus"])))).error?.message).toContain("unknown notify templates subcommand");
		expect(readFileSync(proj.configPath, "utf8")).toBe(before);
	});

	test("no notifications section / an undeclared kind: the error shows how to start, with a block to paste", async () => {
		const bare = project({ notifications: undefined });
		const before = readFileSync(bare.configPath, "utf8");
		const missing = (await run(bare, () => notifyCommand(notify(["templates", "set", "test", "msg-1"])))).error?.message ?? "";
		expect(missing).toContain('typetorch.json has no "notifications" section');
		expect(missing).toContain(NOTIFY_KINDS_DOCS);
		expect(NOTIFY_KINDS_DOCS).toEndWith("/guides/notifications.md#kinds");
		// The pasted block is valid as it is, and names the kind the user asked for.
		const pasted = JSON.parse(`{${missing.slice(missing.indexOf('"notifications": {'), missing.indexOf("\n\nKinds"))}}`);
		expect(Object.keys(pasted.notifications.kinds)).toEqual(["test"]);
		expect(pasted.notifications).toMatchObject({ dailyCap: 1, quietAfterLeaveMinutes: 120, unopenedBackoff: { after: 5 } });
		expect(pasted.notifications.kinds.test).toMatchObject({ priority: 50, repeat: "daily", send: "preferred_hour" });
		expect(validateNotifications(pasted.notifications).errors).toEqual([]);
		expect(validateNotifications(notificationsStub("gift_new")).errors).toEqual([]);
		// push and templates say the same.
		expect((await run(bare, () => notifyCommand(notify(["templates"])))).error?.message).toContain(NOTIFY_KINDS_DOCS);
		expect((await run(bare, () => notifyCommand(notify(["push"])))).error?.message).toContain('"notifications": {');
		expect(readFileSync(bare.configPath, "utf8")).toBe(before);

		const proj = project({ notifications: { kinds } });
		const unknown = (await run(proj, () => notifyCommand(notify(["templates", "set", "test", "msg-1"])))).error?.message ?? "";
		expect(unknown).toContain(`"test" isn't a kind in typetorch.json (declared: ${Object.keys(kinds).join(", ")})`);
		expect(unknown).toContain(`"test": ${JSON.stringify(kindStub())}`);
		expect(unknown).toContain(NOTIFY_KINDS_DOCS);
		const withStub = { ...kinds, test: kindStub() };
		expect(validateNotifications({ kinds: withStub }).errors).toEqual([]);
	});

	test("push warns about kinds with a text but no template id", async () => {
		const proj = project({ notifications: { kinds } });
		const backend = fakeBackend({ "PUT /v1/notify/config": [200, { ok: true }] });
		const { out } = await run(proj, () => notifyCommand(notify(["push"]), { fetch: backend.fetch }));
		expect(out).toContain("streak has a text but no template id yet");
		expect(out).toContain("no template for daily");
		expect(backend.calls[0].body).toEqual({ kinds });
	});

	test("test warns when the params don't match the kind's text", async () => {
		const proj = project({ notifications: { kinds } });
		const backend = fakeBackend({ "POST /v1/notify/test": [200, { nid: "n", status: "planned" }] });
		const { out } = await run(proj, () => notifyCommand(notify(["test", "5", "gift_new", "--param", "gift=x"]), { fetch: backend.fetch }));
		expect(out).toContain("{sender}");
		expect(backend.calls).toHaveLength(1);
	});
});

describe("doctor's notifications scope probe", () => {
	test("400 = ok (empty body refused after the scope check), 401/403 = missing scope, else unexpected", () => {
		expect(notifyScopeProbe(400, '{"code":"INVALID_ARGUMENT"}', "OPENCLOUD_API_KEY")).toEqual(["ok", expect.stringContaining("user.user-notification:write on OPENCLOUD_API_KEY")]);
		expect(notifyScopeProbe(403, "Insufficient scope", "OPENCLOUD_NOTIFY_KEY")[0]).toBe("warn");
		expect(notifyScopeProbe(403, "Insufficient scope", "OPENCLOUD_NOTIFY_KEY")[1]).toContain("missing user.user-notification:write");
		expect(notifyScopeProbe(401, "", "K")[0]).toBe("warn");
		expect(notifyScopeProbe(200, "{}", "K")).toEqual(["warn", expect.stringContaining("unexpected 200")]);
	});
});
