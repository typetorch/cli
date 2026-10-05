/**
 * Hot assets (plans/13 "Hot assets"): keys, the lockfile, export parsing, the no-scripts refusal, diff/hash, create vs
 * PATCH, version resolve, lockfile writing, --dry-run, --deploy. Open Cloud and Luau Execution are mocked through
 * fetch: no real network, and the API key is a fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ParsedArgs } from "../src/args";
import {
	assetHash,
	assetKeyError,
	assetsAttribute,
	AssetsError,
	ASSETS_LOCK_FILE,
	diffAssets,
	EXPORT_MAGIC,
	exportScript,
	formatAssetsLock,
	latestPublishedVersion,
	nextLock,
	parseExport,
	parseResolve,
	readAssetsLock,
	realmFor,
	resolveScript,
	validateAssetsLock,
	type AssetsLock,
	type ExportedAsset,
} from "../src/assets";
import { assetsCommand, assetsFlags } from "../src/commands/assets";
import { Settings, useSettings } from "../src/env";
import { captureJson, setOutputMode } from "../src/log";
import { OpenCloud } from "../src/opencloud";
import { readRbxm, writeRbxm, type RbxmWriteInstance } from "../src/rbxm";

const FAKE_API_KEY = "test-api-key-not-real-0000";
const BINARY_HOST = "storage.test.invalid";
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
	process.exitCode = 0;
});

// Fixtures ----------------------------------------------------------------------------------------------------------

interface FakeAsset {
	key: string;
	path: string[];
	name?: string;
	className?: string;
	/** Extra instances under the root (parent indexes are relative to the root = 0). */
	children?: RbxmWriteInstance[];
	/** What the task reports as scripts inside (the Luau side of the no-scripts check). */
	scripts?: string[];
	nestedIn?: string;
	keyType?: string;
	/** Changes the bytes (and the hash) without changing anything else. */
	salt?: string;
}

function assetBytes(asset: FakeAsset): Uint8Array {
	return writeRbxm([
		{ className: asset.className ?? "Folder", name: asset.name ?? asset.key.split("/").pop()!, parent: -1, attributes: { TypeTorchAsset: asset.key, ...(asset.salt ? { Salt: asset.salt } : {}) } },
		...(asset.children ?? []),
	]);
}

/** The export task's return value and binary output, the way the Luau script builds them. */
function fakeExport(assets: FakeAsset[], options: { placeVersion?: number; services?: string[]; noBytes?: boolean } = {}) {
	const parts: Uint8Array[] = [new TextEncoder().encode(EXPORT_MAGIC)];
	let offset = EXPORT_MAGIC.length;
	const meta = assets.map((asset) => {
		const bytes = assetBytes(asset);
		const entry: Record<string, unknown> = {
			key: asset.key,
			keyType: asset.keyType ?? "string",
			path: asset.path,
			name: asset.name ?? asset.key.split("/").pop(),
			className: asset.className ?? "Folder",
			scripts: asset.scripts ?? [],
			scriptCount: asset.scripts?.length ?? 0,
			...(asset.nestedIn ? { nestedIn: asset.nestedIn } : {}),
		};
		if (!options.noBytes) {
			entry.offset = offset;
			entry.size = bytes.length;
			parts.push(bytes);
			offset += bytes.length;
		}
		return entry;
	});
	const binary = new Uint8Array(offset);
	let at = 0;
	for (const part of parts) {
		binary.set(part, at);
		at += part.length;
	}
	return { meta: { v: 1, placeVersion: options.placeVersion ?? 57, placeId: "2", services: options.services ?? [], assets: meta, ok: true }, binary };
}

const hashOf = (asset: FakeAsset) => assetHash(assetBytes(asset));

function exported(asset: FakeAsset): ExportedAsset {
	const bytes = assetBytes(asset);
	const path = asset.path.join("/");
	return { key: asset.key, path, name: asset.name ?? "x", className: asset.className ?? "Folder", realm: realmFor(path), bytes, hash: assetHash(bytes) };
}

interface Call {
	method: string;
	host: string;
	path: string;
	apiKey: string | null;
	json?: any;
	request?: any;
	rbxm?: Uint8Array;
}

interface MockOptions {
	exportAssets?: FakeAsset[];
	exportOptions?: Parameters<typeof fakeExport>[1];
	versions?: unknown[];
	/** Asset id the next create returns (then +1 each). */
	createId?: number;
	/** Moderation state per asset id (default Approved). */
	moderation?: Record<number, string>;
	/** Hash the resolve task reports per key (default: the uploaded one). */
	servedHash?: Record<string, string>;
	/** Status for creating Luau Execution tasks (e.g. 403). */
	taskStatus?: number;
	/** Wraps the export results as {ReturnValues = ...} and starts the task QUEUED (exercises polling). */
	queued?: boolean;
}

/** A fake apis.roblox.com plus a fake presigned binary-output host. */
function mockCloud(options: MockOptions = {}) {
	const calls: Call[] = [];
	const scripts: { kind: "export" | "resolve"; script: string; body: any; path: string }[] = [];
	const exportData = fakeExport(options.exportAssets ?? [], options.exportOptions);
	let nextId = options.createId ?? 9000;
	const revisions = new Map<number, number>();
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const call: Call = { method, host: url.hostname, path: url.pathname, apiKey: headers.get("x-api-key") };
		if (init?.body instanceof FormData) {
			call.request = JSON.parse(String(init.body.get("request")));
			const file = init.body.get("fileContent") as Blob | null;
			if (file) call.rbxm = new Uint8Array(await file.arrayBuffer());
		} else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
		calls.push(call);
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url.hostname === BINARY_HOST) return new Response(exportData.binary, { status: 200 });
		if (url.hostname !== "apis.roblox.com") throw new Error(`unexpected host ${url.hostname}`);

		if (method === "GET" && url.pathname === "/assets/v1/assets/2/versions") {
			return json(200, { assetVersions: options.versions ?? [{ path: "assets/2/versions/58" }, { path: "assets/2/versions/57", published: true }] });
		}
		const task = /^\/cloud\/v2\/universes\/42\/places\/2(?:\/versions\/(\d+))?\/luau-execution-session-tasks$/.exec(url.pathname);
		if (method === "POST" && task) {
			if (options.taskStatus) return json(options.taskStatus, { message: "Scope not authorized" });
			const script: string = call.json.script;
			const kind = script.includes("SerializeInstancesAsync") ? "export" : "resolve";
			const path = `universes/42/places/2/versions/${task[1] ?? "57"}/luau-execution-sessions/s1/tasks/${kind}`;
			scripts.push({ kind, script, body: call.json, path });
			if (kind === "export") {
				const results = options.queued ? [{ ReturnValues: [exportData.meta] }] : [exportData.meta];
				const done = { path, state: "COMPLETE", output: { results }, binaryOutputUri: `https://${BINARY_HOST}/out/1?signature=not-a-real-signature` };
				return json(200, options.queued ? { path, state: "QUEUED" } : done);
			}
			const rows = [...script.matchAll(/\{ key = "([^"]+)", id = (\d+), hash = "([0-9a-f]+)" \}/g)].map(([, key, id, hash]) => ({
				key,
				id,
				ver: String(70_000_000_000_000 + Number(id)),
				hash: options.servedHash?.[key] ?? hash,
				tries: 1,
			}));
			return json(200, { path, state: "COMPLETE", output: { results: [rows] } });
		}
		if (method === "GET" && url.pathname === "/cloud/v2/universes/42/places/2/versions/57/luau-execution-sessions/s1/tasks/export") {
			return json(200, { path: "universes/42/places/2/versions/57/luau-execution-sessions/s1/tasks/export", state: "COMPLETE", output: { results: [{ ReturnValues: [exportData.meta] }] }, binaryOutputUri: `https://${BINARY_HOST}/out/1?signature=x` });
		}
		if (method === "POST" && url.pathname === "/assets/v1/assets") return json(200, { operationId: `op-create-${nextId++}` });
		const created = /^\/assets\/v1\/operations\/op-create-(\d+)$/.exec(url.pathname);
		if (method === "GET" && created) return json(200, { done: true, response: { assetId: created[1], revisionId: "1", moderationResult: { moderationState: "Approved" } } });
		const patch = /^\/assets\/v1\/assets\/(\d+)$/.exec(url.pathname);
		if (method === "PATCH" && patch) {
			const id = Number(patch[1]);
			revisions.set(id, (revisions.get(id) ?? (id >= (options.createId ?? 9000) ? 1 : 3)) + 1);
			return json(200, { operationId: `op-patch-${id}` });
		}
		const patched = /^\/assets\/v1\/operations\/op-patch-(\d+)$/.exec(url.pathname);
		if (method === "GET" && patched) {
			const id = Number(patched[1]);
			const state = options.moderation?.[id] ?? "Approved";
			return json(200, { done: true, response: { assetId: String(id), revisionId: String(revisions.get(id)), moderationResult: { moderationState: state === "Approved" ? "Approved" : "Reviewing" } } });
		}
		if (method === "GET" && patch) return json(200, { moderationResult: { moderationState: options.moderation?.[Number(patch[1])] ?? "Approved" } });
		return json(404, { message: `not mocked: ${method} ${url.pathname}` });
	}) as typeof fetch;
	return { calls, scripts, exportData };
}

function gameProject(lock?: AssetsLock, patch: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "tt-assets-game-"));
	const raw = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t") + "\n");
	if (lock) writeFileSync(join(root, ASSETS_LOCK_FILE), formatAssetsLock(lock));
	useSettings(new Settings({ startDir: root, env: { TYPETORCH_API_KEY: FAKE_API_KEY } }));
	return root;
}

function args(root: string, argv: string[]): ParsedArgs {
	return parseArgs([...argv, "--config", join(root, "typetorch.json")], assetsFlags);
}

/** Runs the command in --json mode and returns its one JSON document. */
async function run(root: string, argv: string[], deps: Parameters<typeof assetsCommand>[1] = {}): Promise<any> {
	setOutputMode({ json: true, verbose: false });
	return captureJson(() => assetsCommand(args(root, argv), { assets: new OpenCloud(FAKE_API_KEY), ...deps }));
}

const SHOP: FakeAsset = { key: "ui/shop", path: ["ReplicatedStorage", "Assets", "UI"], name: "Shop", className: "ScreenGui", children: [{ className: "Frame", name: "Card", parent: 0 }] };
const CRATE: FakeAsset = { key: "props/crate", path: ["ServerStorage", "Props"], name: "Crate", className: "Model" };
const COIN: FakeAsset = { key: "fx/coin-burst", path: ["ReplicatedStorage", "Assets", "FX"], name: "CoinBurst", className: "Model" };

function lockOf(entries: Record<string, Partial<AssetsLock["assets"][string]>>, placeVersion = 50): AssetsLock {
	const assets: AssetsLock["assets"] = {};
	for (const [key, e] of Object.entries(entries)) {
		assets[key] = { id: 1, ver: 2, n: 3, hash: "000000000000", realm: "replicated", path: "ReplicatedStorage", className: "Folder", ...e };
	}
	return { v: 1, placeVersion, assets };
}

// Pure parts --------------------------------------------------------------------------------------------------------

describe("keys, realms and hashes", () => {
	test("key validation: lowercase a-z 0-9 / - _, at most 64 characters", () => {
		for (const ok of ["ui/shop", "fx/coin-burst", "props/crate_2", "a", "x".repeat(64)]) expect(assetKeyError(ok)).toBeUndefined();
		expect(assetKeyError("UI/Shop")).toContain("lowercase");
		expect(assetKeyError("ui shop")).toContain("lowercase");
		expect(assetKeyError("ui.shop")).toContain("lowercase");
		expect(assetKeyError("")).toBe("is empty");
		expect(assetKeyError("x".repeat(65))).toContain("65 characters");
		expect(assetKeyError(5)).toContain("must be a string");
	});
	test("realm comes from the path", () => {
		expect(realmFor("ServerStorage/Props")).toBe("server");
		expect(realmFor("ServerScriptService")).toBe("server");
		expect(realmFor("ReplicatedStorage/Assets/UI")).toBe("replicated");
		expect(realmFor("Workspace/ServerStorage")).toBe("replicated");
	});
	test("hash = first 12 hex of SHA-256", () => {
		expect(assetHash(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01");
	});
});

describe("lockfile", () => {
	test("format: sorted keys, one line per asset, spec field order; reads back", () => {
		const lock = lockOf({ "ui/shop": { id: 11, ver: 44838191841145, n: 2, hash: "abc123def456", path: "ReplicatedStorage/Assets/UI" }, "fx/a": { realm: "server", path: "ServerStorage" } }, 57);
		const text = formatAssetsLock(lock);
		expect(text).toBe(
			`{\n\t"v": 1,\n\t"placeVersion": 57,\n\t"assets": {\n` +
				`\t\t"fx/a": {"id":1,"ver":2,"n":3,"hash":"000000000000","realm":"server","path":"ServerStorage","className":"Folder"},\n` +
				`\t\t"ui/shop": {"id":11,"ver":44838191841145,"n":2,"hash":"abc123def456","realm":"replicated","path":"ReplicatedStorage/Assets/UI","className":"Folder"}\n\t}\n}\n`,
		);
		expect(validateAssetsLock(JSON.parse(text)).lock).toEqual(lock);
		expect(formatAssetsLock({ v: 1, placeVersion: 3, assets: {} })).toBe(`{\n\t"v": 1,\n\t"placeVersion": 3,\n\t"assets": {}\n}\n`);
	});
	test("invalid lockfiles are refused with every problem", () => {
		const { errors } = validateAssetsLock({ v: 2, placeVersion: 0, assets: { "Bad Key": { id: 1, ver: 2, n: 3, hash: "abc", realm: "client", path: "", className: "Folder" } } });
		expect(errors.join("\n")).toContain('"v" must be 1');
		expect(errors.join("\n")).toContain("placeVersion");
		expect(errors.join("\n")).toContain('key "Bad Key"');
		expect(errors.join("\n")).toContain("invalid hash, realm, path");
		const root = mkdtempSync(join(tmpdir(), "tt-lock-"));
		expect(readAssetsLock(root)).toBeUndefined();
		writeFileSync(join(root, ASSETS_LOCK_FILE), "{ nope");
		expect(() => readAssetsLock(root)).toThrow(AssetsError);
	});
	test("the payload attribute is the asset map without placeVersion", () => {
		const lock = lockOf({ "ui/shop": { id: 11 }, "fx/a": {} }, 57);
		const attribute = JSON.parse(assetsAttribute(lock));
		expect(attribute).toEqual({ v: 1, assets: lock.assets });
		expect(Object.keys(attribute.assets)).toEqual(["fx/a", "ui/shop"]);
		expect(attribute.placeVersion).toBeUndefined();
	});
});

describe("export parsing", () => {
	test("slices the binary output into assets with path, realm and hash", () => {
		const { meta, binary } = fakeExport([SHOP, CRATE]);
		const result = parseExport([meta], binary);
		expect(result.reportedPlaceVersion).toBe(57);
		expect(result.assets.map((a) => [a.key, a.path, a.realm, a.className, a.hash])).toEqual([
			["props/crate", "ServerStorage/Props", "server", "Model", hashOf(CRATE)],
			["ui/shop", "ReplicatedStorage/Assets/UI", "replicated", "ScreenGui", hashOf(SHOP)],
		]);
		expect(readRbxm(result.assets[1].bytes).map((i) => i.name).sort()).toEqual(["Card", "Shop"]);
		// also when the return values come back wrapped
		expect(parseExport([{ ReturnValues: [meta] }], binary).assets).toHaveLength(2);
	});
	test("an empty place: no assets, the binary output is just the magic", () => {
		const { meta, binary } = fakeExport([]);
		expect(parseExport([meta], binary).assets).toEqual([]);
		expect(parseExport([meta], undefined).assets).toEqual([]);
		expect(() => parseExport([meta], new TextEncoder().encode("NOPE"))).toThrow(/TTA1/);
		expect(() => parseExport([{ hello: 1 }], binary)).toThrow(/no TypeTorch metadata/);
	});
	test("invalid and duplicate keys, nesting, a marked service and bad names are all listed", () => {
		const { meta, binary } = fakeExport(
			[
				{ key: "UI/Shop", path: ["ReplicatedStorage"] },
				{ key: "props/crate", path: ["ServerStorage"] },
				{ key: "props/crate", path: ["ReplicatedStorage", "Copy"] },
				{ key: "ui/shop/button", path: ["ReplicatedStorage", "Shop"], nestedIn: "ui/shop" },
				{ key: "5", keyType: "number", path: ["Workspace"] },
				{ key: "ok/name", path: ["ReplicatedStorage", "a/b"] },
			],
			{ services: ["Lighting"], noBytes: true },
		);
		let message = "";
		try {
			parseExport([meta], binary);
		} catch (error) {
			expect(error).toBeInstanceOf(AssetsError);
			message = (error as Error).message;
		}
		expect(message).toContain("refusing to sync: 6 problem(s)");
		expect(message).toContain('TypeTorchAsset "UI/Shop" may only use lowercase');
		expect(message).toContain('the key "props/crate" is used 2 times: ServerStorage/crate (Folder), ReplicatedStorage/Copy/crate (Folder)');
		expect(message).toContain('ui/shop/button (ReplicatedStorage/Shop/button (Folder)) is inside hot asset "ui/shop"');
		expect(message).toContain("must be a string, got number");
		expect(message).toContain("the service Lighting has a TypeTorchAsset attribute");
		expect(message).toContain('a parent\'s name is empty or contains "/"');
	});
	test("no scripts: the task's list is refused with every script named", () => {
		const { meta, binary } = fakeExport(
			[{ ...SHOP, scripts: ["ReplicatedStorage/Assets/UI/Shop/Buy (LocalScript)", "ReplicatedStorage/Assets/UI/Shop/Card/Tween (ModuleScript)"] }, CRATE],
			{ noBytes: true },
		);
		expect(() => parseExport([meta], binary)).toThrow(/hot assets can't contain scripts \(LuaSourceContainer\)[\s\S]*ui\/shop \(ReplicatedStorage\/Assets\/UI\/Shop \(ScreenGui\)\): ReplicatedStorage\/Assets\/UI\/Shop\/Buy \(LocalScript\), ReplicatedStorage\/Assets\/UI\/Shop\/Card\/Tween \(ModuleScript\)/);
		const many = fakeExport([{ ...CRATE, scripts: ["a (Script)"] }], { noBytes: true });
		(many.meta.assets[0] as any).scriptCount = 60;
		expect(() => parseExport([many.meta], many.binary)).toThrow(/a \(Script\), and 59 more/);
	});
	test("no scripts: also checked in the exported bytes", () => {
		const { meta, binary } = fakeExport([{ ...CRATE, children: [{ className: "Script", name: "Evil", parent: 0 }] }]);
		expect(() => parseExport([meta], binary)).toThrow(/props\/crate contains scripts: Evil \(Script\)/);
	});
	test("bytes that don't match the metadata are refused", () => {
		const { meta, binary } = fakeExport([CRATE]);
		(meta.assets[0] as any).size += 100;
		expect(() => parseExport([meta], binary)).toThrow(/outside the/);
		const other = fakeExport([CRATE]);
		(other.meta.assets[0] as any).className = "Folder";
		expect(() => parseExport([other.meta], other.binary)).toThrow(/expected one Folder root/);
		const relabeled = fakeExport([{ ...CRATE }]);
		(relabeled.meta.assets[0] as any).key = "props/other";
		expect(() => parseExport([relabeled.meta], relabeled.binary)).toThrow(/marked "props\/crate"/);
	});
	test("the export script: read-only checks, stamps stripped, binary output", () => {
		const script = exportScript();
		for (const part of ["SerializeInstancesAsync", 'IsA("LuaSourceContainer")', "TypeTorchAssetId", "TypeTorchAssetHash", "TypeTorchAssetVersion", "__typetorch_asset:", 'local MAGIC = "TTA1"', "BinaryOutput = out", "game.PlaceVersion", "^[a-z0-9/_%-]+$", "#raw <= 64"]) {
			expect(script).toContain(part);
		}
		expect(script).not.toContain("SavePlaceAsync");
	});
});

describe("diff, versions and the next lockfile", () => {
	test("added / updated / unchanged / removed / moved", () => {
		const lock = lockOf({
			"ui/shop": { id: 700, hash: "111111111111" },
			"props/crate": { id: 701, hash: hashOf(CRATE), path: "ServerStorage/Old" },
			"fx/gone": { id: 702 },
		});
		const changes = diffAssets(lock, [exported(SHOP), exported(CRATE), exported(COIN)]);
		expect(changes.map((c) => [c.key, c.status, Boolean(c.moved)])).toEqual([
			["fx/coin-burst", "added", false],
			["fx/gone", "removed", false],
			["props/crate", "unchanged", true],
			["ui/shop", "updated", false],
		]);
		expect(diffAssets(undefined, [exported(SHOP)]).map((c) => c.status)).toEqual(["added"]);
	});
	test("the latest published version is the base; newer saves are counted", () => {
		expect(latestPublishedVersion([{ version: 60, published: false }, { version: 59, published: false }, { version: 58, published: true }])).toEqual({ version: 58, newerSaves: 2 });
		expect(() => latestPublishedVersion([{ version: 3, published: false }])).toThrow(/--place-version/);
	});
	test("next lockfile: uploads replace, failures keep the old entry, unchanged follows a move", () => {
		const lock = lockOf({ "ui/shop": { id: 700, ver: 5, n: 4, hash: "111111111111" }, "props/crate": { id: 701, hash: hashOf(CRATE), path: "ServerStorage/Old", realm: "server" } });
		const changes = diffAssets(lock, [exported(SHOP), exported(CRATE), exported(COIN)]);
		const failedShop = nextLock({ placeVersion: 57, changes, uploaded: new Map([["fx/coin-burst", { id: 9000, ver: 77, n: 2 }]]) });
		expect(failedShop.placeVersion).toBe(57);
		expect(failedShop.assets["ui/shop"]).toEqual(lock.assets["ui/shop"]);
		expect(failedShop.assets["props/crate"]).toMatchObject({ id: 701, path: "ServerStorage/Props", realm: "server" });
		expect(failedShop.assets["fx/coin-burst"]).toEqual({ id: 9000, ver: 77, n: 2, hash: hashOf(COIN), realm: "replicated", path: "ReplicatedStorage/Assets/FX", className: "Model" });
		const failedNew = nextLock({ placeVersion: 57, changes, uploaded: new Map() });
		expect(failedNew.assets["fx/coin-burst"]).toBeUndefined();
	});
	test("resolve: the script lists every asset; a lagging or wrong version is an error", () => {
		const items = [
			{ key: "ui/shop", id: 700, hash: "abcabcabcabc" },
			{ key: "fx/a", id: 701, hash: "defdefdefdef" },
			{ key: "fx/b", id: 702, hash: "012301230123" },
		];
		const script = resolveScript(items);
		expect(script).toContain('{ key = "ui/shop", id = 700, hash = "abcabcabcabc" },');
		expect(script).toContain("GetLatestAssetVersionAsync(item.id)");
		expect(script).toContain("LoadAssetVersion(version)");
		expect(() => resolveScript([{ key: 'x"; os.exit()', id: 1, hash: "abcabcabcabc" }])).toThrow(AssetsError);
		const resolved = parseResolve(
			[
				[
					{ key: "ui/shop", id: "700", ver: "44838191841145", hash: "abcabcabcabc" },
					{ key: "fx/a", id: "701", ver: "44838191841146", hash: "999999999999" },
				],
			],
			items,
		);
		expect(resolved.get("ui/shop")).toEqual({ ver: 44838191841145 });
		expect(resolved.get("fx/a")?.error).toContain("hash 999999999999");
		expect(resolved.get("fx/b")?.error).toContain("returned nothing");
	});
});

// The command, against a fake Open Cloud ------------------------------------------------------------------------------

describe("typetorch assets sync", () => {
	test("first sync: creates (placeholder, then PATCH) each new asset, resolves versions, writes the lockfile", async () => {
		const root = gameProject();
		const { calls, scripts } = mockCloud({ exportAssets: [SHOP, CRATE], createId: 9000 });
		const json = await run(root, ["sync"]);

		// export on the latest PUBLISHED version (58 is a newer save), with binary output
		expect(scripts[0]).toMatchObject({ kind: "export", path: expect.stringContaining("/versions/57/") });
		expect(scripts[0].body.enableBinaryOutput).toBe(true);
		expect(calls.some((c) => c.method === "POST" && c.path === "/cloud/v2/universes/42/places/2/versions/57/luau-execution-session-tasks")).toBe(true);
		expect(json).toMatchObject({ placeVersion: 57, base: "latest published", newerSaves: 1, counts: { added: 2, updated: 0, removed: 0, unchanged: 0 } });

		// the presigned binary output host never sees the key; every Open Cloud call carries it
		const download = calls.find((c) => c.host === BINARY_HOST)!;
		expect(download.apiKey).toBeNull();
		expect(calls.filter((c) => c.host === "apis.roblox.com").every((c) => c.apiKey === FAKE_API_KEY)).toBe(true);

		// a group-owned placeholder per new key, then the stamped export as the next version of the SAME asset
		const creates = calls.filter((c) => c.method === "POST" && c.path === "/assets/v1/assets");
		expect(creates).toHaveLength(2);
		expect(creates[0].request).toMatchObject({ assetType: "Model", creationContext: { creator: { groupId: "3" } } });
		expect(creates.map((c) => c.request.displayName).sort()).toEqual(["tt-asset-props-crate", "tt-asset-ui-shop"]);
		const patches = calls.filter((c) => c.method === "PATCH");
		expect(patches.map((c) => c.path).sort()).toEqual(["/assets/v1/assets/9000", "/assets/v1/assets/9001"]);
		for (const patch of patches) {
			const id = Number(patch.path.split("/").pop());
			const root = readRbxm(patch.rbxm!).find((i) => i.parent === -1)!;
			const key = String(root.attributes?.TypeTorchAsset);
			expect(root.attributes?.TypeTorchAssetId).toBe(id);
			expect(root.attributes?.TypeTorchAssetHash).toBe(key === "ui/shop" ? hashOf(SHOP) : hashOf(CRATE));
		}

		// the resolve task asks for both new versions and checks the hash
		expect(scripts[1].kind).toBe("resolve");
		expect(scripts[1].path).toContain("/versions/57/");
		expect(scripts[1].script).toContain(`hash = "${hashOf(SHOP)}"`);
		expect(scripts[1].script).toContain(`hash = "${hashOf(CRATE)}"`);

		// the lockfile
		const lock = readAssetsLock(root)!;
		expect(lock.placeVersion).toBe(57);
		const shopId = Number(patches.find((p) => readRbxm(p.rbxm!).some((i) => i.attributes?.TypeTorchAsset === "ui/shop"))!.path.split("/").pop());
		expect(lock.assets["ui/shop"]).toEqual({ id: shopId, ver: 70_000_000_000_000 + shopId, n: 2, hash: hashOf(SHOP), realm: "replicated", path: "ReplicatedStorage/Assets/UI", className: "ScreenGui" });
		expect(lock.assets["props/crate"]).toMatchObject({ realm: "server", path: "ServerStorage/Props", className: "Model", n: 2 });
		expect(json.lock).toEqual({ placeVersion: 57, assets: 2, changed: true });

		// the log in the state dir
		const log = readFileSync(join(root, ".typetorch", "assets.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(log.filter((r) => r.event === "created")).toHaveLength(2);
		expect(log.filter((r) => r.event === "uploaded").map((r) => [r.key, r.moderation, r.placeVersion]).sort()).toEqual([
			["props/crate", "Approved", 57],
			["ui/shop", "Approved", 57],
		]);
		expect(log.at(-1)).toMatchObject({ event: "synced", universeId: 42, placeVersion: 57, added: 2 });
		expect(existsSync(join(root, ".typetorch", "assets-sync.lock"))).toBe(false);
	});

	test("next sync: a changed key is PATCHed onto its existing asset, unchanged ones aren't uploaded, removed ones leave", async () => {
		const shopV2: FakeAsset = { ...SHOP, salt: "v2" };
		const root = gameProject(
			lockOf({
				"ui/shop": { id: 700, ver: 5, n: 3, hash: hashOf(SHOP), path: "ReplicatedStorage/Assets/UI", className: "ScreenGui" },
				"props/crate": { id: 701, ver: 6, n: 2, hash: hashOf(CRATE), path: "ServerStorage/Props", className: "Model", realm: "server" },
				"fx/gone": { id: 702 },
			}),
		);
		const { calls } = mockCloud({ exportAssets: [shopV2, CRATE] });
		const json = await run(root, ["sync"]);
		expect(json.counts).toEqual({ added: 0, updated: 1, removed: 1, unchanged: 1 });
		expect(calls.filter((c) => c.method === "POST" && c.path === "/assets/v1/assets")).toHaveLength(0);
		expect(calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual(["/assets/v1/assets/700"]);
		const lock = readAssetsLock(root)!;
		expect(Object.keys(lock.assets).sort()).toEqual(["props/crate", "ui/shop"]);
		expect(lock.assets["ui/shop"]).toMatchObject({ id: 700, ver: 70_000_000_000_700, n: 4, hash: hashOf(shopV2) });
		expect(lock.assets["props/crate"]).toEqual({ id: 701, ver: 6, n: 2, hash: hashOf(CRATE), realm: "server", path: "ServerStorage/Props", className: "Model" });
		expect(json.changes.find((c: any) => c.key === "ui/shop")).toMatchObject({ status: "updated", previousHash: hashOf(SHOP), hash: hashOf(shopV2), assetId: 700, n: 4, created: false });
	});

	test("--dry-run and status: export + diff only; nothing uploaded or written", async () => {
		const lock = lockOf({ "ui/shop": { id: 700, hash: "111111111111" } });
		for (const argv of [["sync", "--dry-run"], ["status"]]) {
			const root = gameProject(lock);
			const before = readFileSync(join(root, ASSETS_LOCK_FILE), "utf8");
			const { calls, scripts } = mockCloud({ exportAssets: [SHOP, CRATE] });
			const json = await run(root, argv);
			expect(json).toMatchObject({ dryRun: true, upToDate: false, counts: { added: 1, updated: 1, removed: 0, unchanged: 0 } });
			expect(json.changes.map((c: any) => [c.key, c.status])).toEqual([
				["props/crate", "added"],
				["ui/shop", "updated"],
			]);
			expect(calls.filter((c) => c.method === "PATCH" || (c.method === "POST" && c.path === "/assets/v1/assets"))).toHaveLength(0);
			expect(scripts.map((s) => s.kind)).toEqual(["export"]);
			expect(readFileSync(join(root, ASSETS_LOCK_FILE), "utf8")).toBe(before);
			expect(existsSync(join(root, ".typetorch", "assets.jsonl"))).toBe(false);
		}
	});

	test("status of an empty place against no lockfile: up to date (the live check's case); polling a QUEUED task", async () => {
		const root = gameProject();
		mockCloud({ exportAssets: [], queued: true });
		const json = await run(root, ["status"]);
		expect(json).toMatchObject({ dryRun: true, upToDate: true, counts: { added: 0, updated: 0, removed: 0, unchanged: 0 }, binaryBytes: 4 });
	});

	test("a hot asset with scripts stops the sync before anything is uploaded", async () => {
		const root = gameProject();
		const { calls } = mockCloud({ exportAssets: [{ ...SHOP, scripts: ["ReplicatedStorage/Assets/UI/Shop/Buy (LocalScript)"] }], exportOptions: { noBytes: true } });
		await expect(run(root, ["sync"])).rejects.toThrow(/can't contain scripts[\s\S]*Shop\/Buy \(LocalScript\)/);
		expect(calls.filter((c) => c.method === "PATCH" || c.path === "/assets/v1/assets")).toHaveLength(0);
		expect(existsSync(join(root, ASSETS_LOCK_FILE))).toBe(false);
	});

	test("a key whose asset was created by a run that stopped reuses that asset (no second create)", async () => {
		const root = gameProject();
		mkdirSync(join(root, ".typetorch"));
		writeFileSync(join(root, ".typetorch", "assets.jsonl"), JSON.stringify({ event: "created", at: "2026-10-05T10:00:00.000Z", universeId: 42, key: "ui/shop", assetId: 4242 }) + "\n");
		const { calls } = mockCloud({ exportAssets: [SHOP] });
		await run(root, ["sync"]);
		expect(calls.filter((c) => c.method === "POST" && c.path === "/assets/v1/assets")).toHaveLength(0);
		expect(calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual(["/assets/v1/assets/4242"]);
		expect(readAssetsLock(root)!.assets["ui/shop"].id).toBe(4242);
	});

	test("moderation not approved, or Roblox serving another version: that key keeps its old entry and the run fails", async () => {
		const root = gameProject(lockOf({ "ui/shop": { id: 700, ver: 5, n: 3, hash: "111111111111" }, "props/crate": { id: 701, ver: 6, n: 2, hash: "222222222222" } }));
		mockCloud({ exportAssets: [SHOP, CRATE], moderation: { 700: "Rejected" }, servedHash: { "props/crate": "333333333333" } });
		const json = await run(root, ["sync"]);
		expect(process.exitCode).toBe(1);
		expect(json.failed.map((f: any) => f.key).sort()).toEqual(["props/crate", "ui/shop"]);
		expect(json.failed.find((f: any) => f.key === "ui/shop").error).toContain("moderation is Rejected");
		expect(json.failed.find((f: any) => f.key === "props/crate").error).toContain("version lookup");
		const lock = readAssetsLock(root)!;
		expect(lock.assets["ui/shop"]).toMatchObject({ id: 700, ver: 5, hash: "111111111111" });
		expect(lock.assets["props/crate"]).toMatchObject({ id: 701, ver: 6, hash: "222222222222" });
		expect(lock.placeVersion).toBe(57);
	});

	test("a refused Luau Execution call stops with the scopes it needs", async () => {
		const root = gameProject();
		mockCloud({ taskStatus: 403 });
		await expect(run(root, ["status"])).rejects.toThrow(/needs universe\.place\.luau-execution-session:read and universe\.place\.luau-execution-session:write/);
	});

	test("--place-version picks the version; no published version is an error that names it", async () => {
		const root = gameProject();
		const { scripts } = mockCloud({ exportAssets: [], versions: [{ path: "assets/2/versions/3" }] });
		await expect(run(root, ["status"])).rejects.toThrow(/--place-version/);
		await run(root, ["status", "--place-version", "41"]);
		expect(scripts.at(-1)!.path).toContain("/versions/41/");
	});

	test("--deploy: runs the deploy with the passed-on flags when the asset map changed; refuses prod-channel branches up front", async () => {
		const root = gameProject();
		mockCloud({ exportAssets: [SHOP] });
		const deploys: ParsedArgs[] = [];
		const json = await run(root, ["sync", "--deploy", "dev", "--message", "new shop", "--no-registry"], {
			deploy: async (deployArgs) => {
				deploys.push(deployArgs);
			},
		});
		expect(deploys).toEqual([{ positionals: [], flags: { branch: "dev", message: "new shop", "no-registry": true } }]);
		expect(json.deploy).toBeNull(); // the fake deploy emitted nothing

		// nothing changed now: no deploy
		mockCloud({ exportAssets: [SHOP] });
		const again: ParsedArgs[] = [];
		await run(root, ["sync", "--deploy", "dev"], { deploy: async (a) => void again.push(a) });
		expect(again).toHaveLength(0);

		// prod-channel branch with lockfile changes: refused before any upload
		const prodRoot = gameProject();
		const { calls } = mockCloud({ exportAssets: [SHOP] });
		await expect(run(prodRoot, ["sync", "--deploy", "prod"], { deploy: async () => {} })).rejects.toThrow(/commit the lockfile/);
		expect(calls.filter((c) => c.method === "PATCH" || c.path === "/assets/v1/assets")).toHaveLength(0);
		await expect(run(prodRoot, ["status", "--deploy", "dev"])).rejects.toThrow(/goes with/);
		await expect(run(prodRoot, ["sync", "--dry-run", "--deploy", "dev"])).rejects.toThrow(/--dry-run/);
	});

	test("human output: the diff table, the uploads, the lockfile line and the next step", async () => {
		const root = gameProject(lockOf({ "ui/shop": { id: 700, hash: "111111111111" }, "fx/gone": { id: 702 } }));
		mockCloud({ exportAssets: [SHOP, CRATE] });
		const lines: string[] = [];
		const log = console.log;
		console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
		try {
			setOutputMode({ json: false, verbose: false });
			await assetsCommand(args(root, ["sync"]), { assets: new OpenCloud(FAKE_API_KEY) });
			await assetsCommand(args(root, ["list"]), {});
		} finally {
			console.log = log;
		}
		const text = lines.join("\n");
		expect(text).toContain("place      2 v57 (latest published; 1 newer unpublished save(s) not included)");
		expect(text).toContain("assets     2 in the place: 1 added, 1 updated, 1 removed, 0 unchanged");
		expect(text).toMatch(/\+\s+props\/crate\s+Model\s+ServerStorage\/Props/);
		expect(text).toMatch(/~\s+ui\/shop\s+ScreenGui\s+ReplicatedStorage\/Assets\/UI\s+111111111111 -> [0-9a-f]{12}\s+asset 700/);
		expect(text).toMatch(/-\s+fx\/gone .*gone from the place \(asset 702 stays on Roblox\)/);
		expect(text).toMatch(/upload\s+ui\/shop -> asset 700 v4, Approved/);
		expect(text).toMatch(/upload\s+props\/crate -> asset 9000 v2 \(new\), Approved/);
		expect(text).toContain(`wrote ${ASSETS_LOCK_FILE} (place v57): 1 added, 1 updated, 1 removed, 0 unchanged`);
		expect(text).toContain("next: commit typetorch.assets.lock.json, then `typetorch deploy`");
		expect(text).toMatch(/ui\/shop\s+replicated\s+ScreenGui\s+ReplicatedStorage\/Assets\/UI\s+700\s+4\s+70000000000700/);
	});

	test("assets list prints the lockfile", async () => {
		const lock = lockOf({ "ui/shop": { id: 700, ver: 5, n: 3, hash: "111111111111" } }, 57);
		const root = gameProject(lock);
		expect(await run(root, ["list"])).toEqual({ lockfile: ASSETS_LOCK_FILE, exists: true, ...lock });
		const empty = gameProject();
		expect(await run(empty, ["list"])).toEqual({ lockfile: ASSETS_LOCK_FILE, exists: false });
		await expect(run(empty, ["nope"])).rejects.toThrow(/unknown assets subcommand/);
	});
});
