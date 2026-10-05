/**
 * Hot assets (TypeTorch plans/13 "Hot assets"): models and UI templates that builders edit in the real place and that
 * running servers pick up live. A hot asset is any instance in the place with the string attribute `TypeTorchAsset`
 * set to a key (lowercase `a-z 0-9 / - _`, at most 64 characters, unique, no scripts inside).
 *
 * `typetorch assets sync` (commands/assets.ts):
 *   1. export   a Luau Execution task on the place's latest PUBLISHED version finds every marked instance, checks it,
 *               and serializes each one (SerializationService:SerializeInstancesAsync) into the task's binary output
 *               ("TTA1" + the exports back to back; offsets and sizes in the return values)
 *   2. diff     SHA-256 of each export (first 12 hex) against typetorch.assets.lock.json
 *   3. upload   a new key gets a group-owned Model (a tiny placeholder reserves the id, then the real version is PATCHed
 *               on); a changed key gets a new version of the SAME asset (PATCH). Uploaded bytes carry
 *               TypeTorchAssetId and TypeTorchAssetHash on their root (stamped here: the place is never changed).
 *               Waits for moderation; logged to assets.jsonl in the state dir
 *   4. resolve  a second task calls InsertService:GetLatestAssetVersionAsync(id) and loads that version to check its
 *               TypeTorchAssetHash, giving the assetVersionId that LoadAssetVersion needs
 *   5. write    typetorch.assets.lock.json, only when every upload and lookup worked: its `placeVersion` promises that
 *               every entry matches the place at that version (the runtime adopts the place's copies on that basis).
 *               A failed run writes nothing; the next one reuses its approved uploads (assets.jsonl).
 *   `typetorch deploy` stamps the lockfile as the `Assets` attribute on the payload root and its Server folder.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./json";
import type { OpenCloud } from "./opencloud";
import { readRbxm, setRootAttributes, writeSingleInstanceRbxm } from "./rbxm";

export const ASSETS_LOCK_FILE = "typetorch.assets.lock.json";
/** Upload log in the state dir. */
export const ASSETS_LOG = "assets.jsonl";
/** The attribute builders set in Studio: the asset's key. */
export const ASSET_ATTRIBUTE = "TypeTorchAsset";
/** Stamped on the uploaded copy only (never in the place). */
export const ASSET_ID_ATTRIBUTE = "TypeTorchAssetId";
export const ASSET_HASH_ATTRIBUTE = "TypeTorchAssetHash";
/** Stamped by the runtime (framework AssetSync) on live servers; stripped from exports. */
export const ASSET_VERSION_ATTRIBUTE = "TypeTorchAssetVersion";
/** CollectionService tag prefix the runtime uses (`__typetorch_asset:<key>`); stripped from exports. */
export const ASSET_TAG_PREFIX = "__typetorch_asset:";
/** The payload attribute (root Model and its Server folder) that carries the lockfile. */
export const ASSETS_PAYLOAD_ATTRIBUTE = "Assets";
/** The payload child that also gets the attribute: the kernel unpacks the root and drops it. */
export const ASSETS_PAYLOAD_FOLDER = "Server";
/** First bytes of the export task's binary output. */
export const EXPORT_MAGIC = "TTA1";
export const KEY_MAX_LENGTH = 64;
/** LuaSourceContainer classes (checked again in the exported bytes). */
export const SCRIPT_CLASSES: ReadonlySet<string> = new Set(["Script", "LocalScript", "ModuleScript", "CoreScript"]);
/** Services whose content stays on the server; everything else is replicated. */
const SERVER_SERVICES = new Set(["ServerStorage", "ServerScriptService"]);

export class AssetsError extends Error {
	override name = "AssetsError";
}

export type Realm = "replicated" | "server";

export interface LockEntry {
	/** Asset id (the same for every version of a key). */
	id: number;
	/** assetVersionId, for InsertService:LoadAssetVersion. */
	ver: number;
	/** The asset's version number. */
	n: number;
	/** First 12 hex of the SHA-256 of the exported bytes. */
	hash: string;
	realm: Realm;
	/** The parent's path in the place, e.g. `ReplicatedStorage/Assets/UI`. */
	path: string;
	className: string;
}

export interface AssetsLock {
	v: 1;
	/** The place version the assets were exported from. */
	placeVersion: number;
	assets: Record<string, LockEntry>;
}

// Keys, realms, hashes ----------------------------------------------------------------------------------------------

/** Why a `TypeTorchAsset` value isn't a valid key, or undefined. */
export function assetKeyError(key: unknown): string | undefined {
	if (typeof key !== "string") return `must be a string, got ${key === null ? "nil" : typeof key}`;
	if (key.length === 0) return "is empty";
	if (key.length > KEY_MAX_LENGTH) return `is ${key.length} characters (at most ${KEY_MAX_LENGTH})`;
	if (!/^[a-z0-9/_-]+$/.test(key)) return `may only use lowercase a-z, 0-9, "/", "-" and "_"`;
	return undefined;
}

/** `server` under ServerStorage or ServerScriptService, else `replicated`. */
export function realmFor(path: string): Realm {
	return SERVER_SERVICES.has(path.split("/")[0]) ? "server" : "replicated";
}

/** SHA-256 of the exported bytes, first 12 hex characters. */
export function assetHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

// The lockfile -------------------------------------------------------------------------------------------------------

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Validates a parsed lockfile; returns it normalized, or the problems. */
export function validateAssetsLock(raw: unknown): { lock?: AssetsLock; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(raw)) return { errors: ["must be a JSON object"] };
	if (raw.v !== 1) errors.push(`"v" must be 1`);
	if (!positiveInt(raw.placeVersion)) errors.push(`"placeVersion" must be a positive integer`);
	if (!isRecord(raw.assets)) errors.push(`"assets" must be an object`);
	const assets: Record<string, LockEntry> = {};
	for (const [key, entry] of Object.entries(isRecord(raw.assets) ? raw.assets : {})) {
		const keyError = assetKeyError(key);
		if (keyError) errors.push(`key "${key}" ${keyError}`);
		if (!isRecord(entry)) {
			errors.push(`"${key}" must be an object`);
			continue;
		}
		const bad: string[] = [];
		if (!positiveInt(entry.id)) bad.push("id");
		if (!positiveInt(entry.ver)) bad.push("ver");
		if (!positiveInt(entry.n)) bad.push("n");
		if (typeof entry.hash !== "string" || !/^[0-9a-f]{12}$/.test(entry.hash)) bad.push("hash");
		if (entry.realm !== "replicated" && entry.realm !== "server") bad.push("realm");
		if (typeof entry.path !== "string" || entry.path === "") bad.push("path");
		if (typeof entry.className !== "string" || entry.className === "") bad.push("className");
		if (bad.length) {
			errors.push(`"${key}": invalid ${bad.join(", ")}`);
			continue;
		}
		assets[key] = {
			id: entry.id as number,
			ver: entry.ver as number,
			n: entry.n as number,
			hash: entry.hash as string,
			realm: entry.realm as Realm,
			path: entry.path as string,
			className: entry.className as string,
		};
	}
	if (errors.length) return { errors };
	return { lock: { v: 1, placeVersion: raw.placeVersion as number, assets }, errors };
}

/** The project's lockfile, or undefined when there is none. Throws AssetsError when it is invalid. */
export function readAssetsLock(root: string): AssetsLock | undefined {
	const path = join(root, ASSETS_LOCK_FILE);
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new AssetsError(`${ASSETS_LOCK_FILE} is not valid JSON: ${(error as Error).message}`);
	}
	const { lock, errors } = validateAssetsLock(raw);
	if (!lock) throw new AssetsError(`${ASSETS_LOCK_FILE} is invalid:\n  - ${errors.join("\n  - ")}`);
	return lock;
}

function sortedAssets(assets: Record<string, LockEntry>): Record<string, LockEntry> {
	const out: Record<string, LockEntry> = {};
	for (const key of Object.keys(assets).sort()) {
		const e = assets[key];
		out[key] = { id: e.id, ver: e.ver, n: e.n, hash: e.hash, realm: e.realm, path: e.path, className: e.className };
	}
	return out;
}

/** The lockfile's text: keys sorted, one line per asset (readable diffs), LF, trailing newline. */
export function formatAssetsLock(lock: AssetsLock): string {
	const assets = sortedAssets(lock.assets);
	const lines = Object.entries(assets).map(([key, entry]) => `\t\t${JSON.stringify(key)}: ${JSON.stringify(entry)}`);
	const body = lines.length ? `{\n${lines.join(",\n")}\n\t}` : "{}";
	return `{\n\t"v": 1,\n\t"placeVersion": ${lock.placeVersion},\n\t"assets": ${body}\n}\n`;
}

export function writeAssetsLock(root: string, lock: AssetsLock): string {
	const path = join(root, ASSETS_LOCK_FILE);
	writeFileSync(path, formatAssetsLock(lock));
	return path;
}

/**
 * The payload's `Assets` attribute (stamped on the root Model and on its `Server` folder, which the framework reads
 * at runtime because the kernel drops the root): `{"v":1,"placeVersion":N,"assets":{...}}`, the lockfile as is.
 * `placeVersion` stays: places that builders publish carry no TypeTorchAssetHash on their copies, so a new server
 * adopts the place's own copies only when `placeVersion == game.PlaceVersion`. Without a lockfile: `{"v":1,"assets":{}}`.
 */
export function assetsAttribute(lock: AssetsLock | undefined): string {
	if (!lock) return JSON.stringify({ v: 1, assets: {} });
	return JSON.stringify({ v: 1, placeVersion: lock.placeVersion, assets: sortedAssets(lock.assets) });
}

// Export (Luau Execution) --------------------------------------------------------------------------------------------

/**
 * The export task. Read-only: data model changes in a task are never saved. Returns
 * `{BinaryOutput = "TTA1" .. exports, ReturnValues = {{v, placeVersion, placeId, services, assets}}}`; each asset is
 * `{key, keyType, path, name, className, scripts, scriptCount, nestedIn?, error?, offset?, size?}`. Nothing is
 * serialized when any check fails (the CLI then lists every problem).
 */
export function exportScript(): string {
	return `-- TypeTorch: typetorch assets sync (export). Read-only.
local SerializationService = game:GetService("SerializationService")
local CollectionService = game:GetService("CollectionService")
local ATTRIBUTE = "${ASSET_ATTRIBUTE}"
local STAMPS = { "${ASSET_ID_ATTRIBUTE}", "${ASSET_HASH_ATTRIBUTE}", "${ASSET_VERSION_ATTRIBUTE}" }
local TAG_PREFIX = "${ASSET_TAG_PREFIX}"
local MAGIC = "${EXPORT_MAGIC}"
local MAX_LISTED = 50

local function pathOf(instance)
	local parts = {}
	local current = instance
	while current and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	return parts
end

local marked = {}
local order = {}
local services = {}
for _, service in game:GetChildren() do
	pcall(function()
		if service:GetAttribute(ATTRIBUTE) ~= nil then
			table.insert(services, service.Name)
		end
		for _, instance in service:GetDescendants() do
			if instance:GetAttribute(ATTRIBUTE) ~= nil then
				marked[instance] = true
				table.insert(order, instance)
			end
		end
	end)
end

local problems = #services > 0
local seen = {}
local items = {}
for _, instance in order do
	local raw = instance:GetAttribute(ATTRIBUTE)
	local key = if typeof(raw) == "string" then raw else tostring(raw)
	local parts = pathOf(instance)
	table.remove(parts)
	local scripts = {}
	local scriptCount = 0
	local function check(candidate)
		if candidate:IsA("LuaSourceContainer") then
			scriptCount += 1
			if #scripts < MAX_LISTED then
				table.insert(scripts, table.concat(pathOf(candidate), "/") .. " (" .. candidate.ClassName .. ")")
			end
		end
	end
	check(instance)
	for _, descendant in instance:GetDescendants() do
		check(descendant)
	end
	local nestedIn = nil
	local ancestor = instance.Parent
	while ancestor and ancestor ~= game do
		if marked[ancestor] then
			nestedIn = tostring(ancestor:GetAttribute(ATTRIBUTE))
			break
		end
		ancestor = ancestor.Parent
	end
	local valid = typeof(raw) == "string" and #raw >= 1 and #raw <= ${KEY_MAX_LENGTH} and string.match(raw, "^[a-z0-9/_%-]+$") ~= nil
	if not valid or scriptCount > 0 or nestedIn ~= nil or seen[key] then
		problems = true
	end
	for _, part in parts do
		if part == "" or string.find(part, "/", 1, true) then
			problems = true
		end
	end
	seen[key] = true
	table.insert(items, {
		instance = instance,
		meta = {
			key = key,
			keyType = typeof(raw),
			path = parts,
			name = instance.Name,
			className = instance.ClassName,
			scripts = scripts,
			scriptCount = scriptCount,
			nestedIn = nestedIn,
		},
	})
end

local total = #MAGIC
if not problems then
	for _, item in items do
		local instance = item.instance
		for _, name in STAMPS do
			instance:SetAttribute(name, nil)
		end
		for _, tag in CollectionService:GetTags(instance) do
			if string.sub(tag, 1, #TAG_PREFIX) == TAG_PREFIX then
				CollectionService:RemoveTag(instance, tag)
			end
		end
		local ok, result = pcall(function()
			return SerializationService:SerializeInstancesAsync({ instance })
		end)
		if ok then
			item.buf = result
			total += buffer.len(result)
		else
			item.meta.error = "SerializeInstancesAsync: " .. tostring(result)
			problems = true
		end
	end
end

local out = buffer.create(if problems then #MAGIC else total)
buffer.writestring(out, 0, MAGIC)
local offset = #MAGIC
local assets = {}
for _, item in items do
	if not problems then
		item.meta.offset = offset
		item.meta.size = buffer.len(item.buf)
		buffer.copy(out, offset, item.buf)
		offset += item.meta.size
	end
	table.insert(assets, item.meta)
end
return {
	BinaryOutput = out,
	ReturnValues = {
		{ v = 1, placeVersion = game.PlaceVersion, placeId = string.format("%d", game.PlaceId), services = services, assets = assets, ok = not problems },
	},
}
`;
}

/** One hot asset as exported from the place. */
export interface ExportedAsset {
	key: string;
	/** The parent's path, `/`-joined. */
	path: string;
	name: string;
	className: string;
	realm: Realm;
	bytes: Uint8Array;
	hash: string;
}

export interface ExportResult {
	/** `game.PlaceVersion` as the task saw it. */
	reportedPlaceVersion?: number;
	assets: ExportedAsset[];
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const stringList = (value: unknown): string[] => listOf(value).filter((x): x is string => typeof x === "string");

/** The export task's metadata table: `results[0]`, also when it comes back wrapped as `{ReturnValues = {...}}`. */
function exportMeta(results: unknown[]): Record<string, unknown> {
	let first = results[0];
	if (isRecord(first) && Array.isArray(first.ReturnValues)) first = first.ReturnValues[0];
	if (!isRecord(first) || first.v !== 1) throw new AssetsError(`the export task returned no TypeTorch metadata: ${JSON.stringify(results).slice(0, 300)}`);
	return first;
}

/**
 * Checks the export task's return values and binary output and slices it into assets. Throws AssetsError listing
 * every problem: invalid or duplicate keys, scripts inside an asset (each listed), assets inside other assets, a
 * marked service, a parent name with "/", and bytes that don't match what the task reported.
 */
export function parseExport(results: unknown[], binary: Uint8Array | undefined): ExportResult {
	const meta = exportMeta(results);
	const problems: string[] = [];
	const scriptProblems: string[] = [];
	for (const service of stringList(meta.services)) problems.push(`the service ${service} has a ${ASSET_ATTRIBUTE} attribute: mark an instance inside it instead`);
	const entries = listOf(meta.assets).filter(isRecord);
	const where = (e: Record<string, unknown>) => `${[...stringList(e.path), String(e.name ?? "?")].join("/")} (${String(e.className ?? "?")})`;
	const byKey = new Map<string, string[]>();
	for (const e of entries) {
		const key = String(e.key);
		const keyError = e.keyType === "string" ? assetKeyError(key) : `must be a string, got ${String(e.keyType)}`;
		if (keyError) problems.push(`${where(e)}: ${ASSET_ATTRIBUTE} "${key}" ${keyError}`);
		byKey.set(key, [...(byKey.get(key) ?? []), where(e)]);
		const scripts = stringList(e.scripts);
		const count = typeof e.scriptCount === "number" ? e.scriptCount : scripts.length;
		if (count > 0) {
			const more = count > scripts.length ? `, and ${count - scripts.length} more` : "";
			scriptProblems.push(`${key} (${where(e)}): ${scripts.join(", ")}${more}`);
		}
		if (typeof e.nestedIn === "string") problems.push(`${key} (${where(e)}) is inside hot asset "${e.nestedIn}": hot assets can't nest`);
		if (stringList(e.path).some((part) => part === "" || part.includes("/"))) problems.push(`${key} (${where(e)}): a parent's name is empty or contains "/"`);
		if (typeof e.error === "string") problems.push(`${key} (${where(e)}): ${e.error}`);
	}
	for (const [key, paths] of byKey) if (paths.length > 1) problems.push(`the key "${key}" is used ${paths.length} times: ${paths.join(", ")}`);
	if (scriptProblems.length) problems.unshift(`hot assets can't contain scripts (LuaSourceContainer); remove them:\n    ${scriptProblems.join("\n    ")}`);
	if (problems.length) throw new AssetsError(`refusing to sync: ${problems.length} problem(s) with the hot assets in the place:\n  - ${problems.join("\n  - ")}`);

	const assets: ExportedAsset[] = [];
	if (entries.length > 0 || binary) {
		if (!binary) throw new AssetsError("the export task returned no binary output");
		if (new TextDecoder().decode(binary.subarray(0, EXPORT_MAGIC.length)) !== EXPORT_MAGIC) throw new AssetsError("the export task's binary output doesn't start with TTA1");
	}
	for (const e of entries) {
		const key = String(e.key);
		const offset = e.offset;
		const size = e.size;
		if (typeof offset !== "number" || typeof size !== "number" || offset < EXPORT_MAGIC.length || size <= 0 || offset + size > binary!.length) {
			throw new AssetsError(`${key}: the export reported bytes ${String(offset)}+${String(size)} outside the ${binary!.length}-byte output`);
		}
		const bytes = binary!.slice(offset, offset + size);
		let instances;
		try {
			instances = readRbxm(bytes);
		} catch (error) {
			throw new AssetsError(`${key}: the exported bytes aren't a binary model: ${(error as Error).message}`);
		}
		const scripts = instances.filter((i) => SCRIPT_CLASSES.has(i.className));
		if (scripts.length) throw new AssetsError(`refusing to sync: ${key} contains scripts: ${scripts.map((i) => `${i.name} (${i.className})`).join(", ")}`);
		const roots = instances.filter((i) => i.parent === -1);
		if (roots.length !== 1 || roots[0].className !== e.className) {
			throw new AssetsError(`${key}: expected one ${String(e.className)} root in the export, found ${roots.map((r) => r.className).join(", ") || "none"}`);
		}
		const marked = roots[0].attributes?.[ASSET_ATTRIBUTE];
		if (marked !== undefined && marked !== key) throw new AssetsError(`${key}: the exported root is marked "${String(marked)}"`);
		const path = stringList(e.path).join("/");
		assets.push({ key, path, name: String(e.name ?? ""), className: String(e.className), realm: realmFor(path), bytes, hash: assetHash(bytes) });
	}
	assets.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const reported = typeof meta.placeVersion === "number" && Number.isSafeInteger(meta.placeVersion) ? meta.placeVersion : undefined;
	return { reportedPlaceVersion: reported, assets };
}

// Diff ---------------------------------------------------------------------------------------------------------------

export type ChangeStatus = "added" | "updated" | "removed" | "unchanged";

export interface AssetChange {
	key: string;
	status: ChangeStatus;
	exported?: ExportedAsset;
	locked?: LockEntry;
	/** Unchanged bytes, but the parent path changed (no upload; the lockfile's path follows). */
	moved?: boolean;
}

/** The export against the lockfile, sorted by key. */
export function diffAssets(lock: AssetsLock | undefined, exported: ExportedAsset[]): AssetChange[] {
	const locked = lock?.assets ?? {};
	const changes: AssetChange[] = [];
	const seen = new Set<string>();
	for (const asset of exported) {
		seen.add(asset.key);
		const entry = locked[asset.key];
		if (!entry) changes.push({ key: asset.key, status: "added", exported: asset });
		else if (entry.hash !== asset.hash) changes.push({ key: asset.key, status: "updated", exported: asset, locked: entry });
		else changes.push({ key: asset.key, status: "unchanged", exported: asset, locked: entry, ...(entry.path !== asset.path ? { moved: true } : {}) });
	}
	for (const [key, entry] of Object.entries(locked)) if (!seen.has(key)) changes.push({ key, status: "removed", locked: entry });
	return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function countChanges(changes: AssetChange[]): Record<ChangeStatus, number> {
	const counts: Record<ChangeStatus, number> = { added: 0, updated: 0, removed: 0, unchanged: 0 };
	for (const change of changes) counts[change.status]++;
	return counts;
}

/** The newest published place version: the export base. Throws when none of the listed versions is published. */
export function latestPublishedVersion(versions: { version: number; published: boolean }[]): { version: number; newerSaves: number } {
	const index = versions.findIndex((v) => v.published);
	if (index === -1) {
		throw new AssetsError(
			`none of the place's newest ${versions.length} versions is published (Assets API "published"); publish the place, or pass --place-version <n>`,
		);
	}
	return { version: versions[index].version, newerSaves: index };
}

/** The lockfile after a sync: unchanged and failed keys keep their entry, uploaded ones get the new one. */
export function nextLock(input: {
	placeVersion: number;
	changes: AssetChange[];
	uploaded: Map<string, { id: number; ver: number; n: number }>;
}): AssetsLock {
	const assets: Record<string, LockEntry> = {};
	for (const change of input.changes) {
		if (change.status === "removed") continue;
		const exported = change.exported!;
		const done = input.uploaded.get(change.key);
		if (done) {
			assets[change.key] = { id: done.id, ver: done.ver, n: done.n, hash: exported.hash, realm: exported.realm, path: exported.path, className: exported.className };
		} else if (change.locked) {
			// unchanged (path and realm follow the place), or an update that failed (keeps the old version)
			assets[change.key] =
				change.status === "unchanged" ? { ...change.locked, path: exported.path, realm: exported.realm, className: exported.className } : { ...change.locked };
		}
	}
	return { v: 1, placeVersion: input.placeVersion, assets };
}

// Resolve (Luau Execution) -------------------------------------------------------------------------------------------

export interface ResolveItem {
	key: string;
	id: number;
	hash: string;
}

/**
 * The resolve task: for each asset, `InsertService:GetLatestAssetVersionAsync(id)`, then `LoadAssetVersion` of that
 * version to read its TypeTorchAssetHash; retries every 2 s for up to `waitSeconds` until the hash is the uploaded one
 * (a version lookup right after a PATCH can lag). Returns a list of `{key, id, ver?, hash?, error?, tries}`; ids are
 * decimal strings.
 */
export function resolveScript(items: ResolveItem[], waitSeconds = 60): string {
	for (const item of items) {
		if (assetKeyError(item.key) || !positiveInt(item.id) || !/^[0-9a-f]{12}$/.test(item.hash)) throw new AssetsError(`bad resolve item ${JSON.stringify(item)}`);
	}
	const list = items.map((i) => `\t{ key = "${i.key}", id = ${i.id}, hash = "${i.hash}" },`).join("\n");
	return `-- TypeTorch: typetorch assets sync (resolve versions). Read-only.
local InsertService = game:GetService("InsertService")
local ITEMS = {
${list}
}
local WAIT = ${waitSeconds}
local DEADLINE = os.clock() + 240
local results = {}

local function hashOf(container)
	for _, candidate in { container, unpack(container:GetChildren()) } do
		local value = candidate:GetAttribute("${ASSET_HASH_ATTRIBUTE}")
		if value ~= nil then
			return tostring(value)
		end
	end
	return nil
end

local function resolve(item)
	local result = { key = item.key, id = string.format("%d", item.id), tries = 0 }
	results[item.key] = result
	local deadline = math.min(os.clock() + WAIT, DEADLINE)
	while true do
		result.tries += 1
		local ok, version = pcall(function()
			return InsertService:GetLatestAssetVersionAsync(item.id)
		end)
		if ok and typeof(version) == "number" then
			result.ver = string.format("%d", version)
			local loaded, container = pcall(function()
				return InsertService:LoadAssetVersion(version)
			end)
			if loaded then
				result.hash = hashOf(container)
				result.error = nil
				container:Destroy()
			else
				result.error = "LoadAssetVersion(" .. result.ver .. "): " .. tostring(container)
			end
		else
			result.error = "GetLatestAssetVersionAsync: " .. tostring(version)
		end
		if result.hash == item.hash or os.clock() >= deadline then
			break
		end
		task.wait(2)
	end
end

local queue = table.clone(ITEMS)
local workers = math.min(4, #queue)
local finished = 0
for _ = 1, workers do
	task.spawn(function()
		while #queue > 0 do
			local item = table.remove(queue, 1)
			if os.clock() >= DEADLINE then
				results[item.key] = { key = item.key, id = string.format("%d", item.id), error = "no time left in the task" }
			else
				local ok, err = pcall(resolve, item)
				if not ok then
					results[item.key] = { key = item.key, id = string.format("%d", item.id), error = tostring(err) }
				end
			end
		end
		finished += 1
	end)
end
while finished < workers do
	task.wait(0.1)
end
local list = {}
for _, result in results do
	table.insert(list, result)
end
return list
`;
}

/** The resolve task's answer per key: the assetVersionId when the served version carries the uploaded hash. */
export function parseResolve(results: unknown[], items: ResolveItem[]): Map<string, { ver?: number; error?: string }> {
	const rows = listOf(results[0]).filter(isRecord);
	const byKey = new Map(rows.map((row) => [String(row.key), row]));
	const out = new Map<string, { ver?: number; error?: string }>();
	for (const item of items) {
		const row = byKey.get(item.key);
		if (!row) {
			out.set(item.key, { error: "the resolve task returned nothing for it" });
			continue;
		}
		const ver = typeof row.ver === "string" && /^\d+$/.test(row.ver) ? Number(row.ver) : typeof row.ver === "number" ? row.ver : undefined;
		if (row.hash === item.hash && ver !== undefined && positiveInt(ver)) out.set(item.key, { ver });
		else {
			const served = typeof row.hash === "string" ? `a version with hash ${row.hash}` : "no TypeTorchAssetHash";
			out.set(item.key, { error: typeof row.error === "string" ? row.error : `Roblox served ${served}${ver ? ` (version ${ver})` : ""}, not ${item.hash}` });
		}
	}
	return out;
}

// Upload -------------------------------------------------------------------------------------------------------------

/** `tt-asset-<key>` with every run of other characters as "-", at most 50 characters. */
export function hotAssetDisplayName(key: string): string {
	return `tt-asset-${key.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 50).replace(/-+$/, "");
}

/** A tiny Model that reserves a new key's asset id; the real export is PATCHed on as the next version. */
export function placeholderRbxm(key: string): Uint8Array {
	return writeSingleInstanceRbxm({ className: "Folder", name: "TypeTorchAssetPlaceholder", attributes: { [ASSET_ATTRIBUTE]: key } });
}

/** The export with TypeTorchAssetId and TypeTorchAssetHash on its root: what gets uploaded. */
export function stampExport(bytes: Uint8Array, assetId: number, hash: string): Uint8Array {
	return setRootAttributes(bytes, { [ASSET_ID_ATTRIBUTE]: assetId, [ASSET_HASH_ATTRIBUTE]: hash });
}

export interface HotAssetUpload {
	assetId: number;
	/** The asset's version number (the PATCH's revisionId). */
	n: number;
	moderation: string;
	/** True when this run created the asset. */
	created: boolean;
}

/**
 * Uploads one hot asset: with no `assetId`, creates a group-owned placeholder Model first (`onCreated` gets the id as
 * soon as it is known, so a failed run can resume with it), then PATCHes the stamped export as a new version of that
 * asset and waits for moderation. Never creates a second asset for a key that has one.
 */
export async function uploadHotAsset(
	oc: OpenCloud,
	input: {
		creator: { groupId: number } | { userId: number };
		key: string;
		bytes: Uint8Array;
		hash: string;
		assetId?: number;
		moderationTimeout: number;
		onCreated?: (assetId: number) => void;
	},
): Promise<HotAssetUpload> {
	let assetId = input.assetId;
	let created = false;
	if (!assetId) {
		const operationId = await oc.createModelAsset({
			bytes: placeholderRbxm(input.key),
			fileName: "typetorch-asset-placeholder.rbxm",
			displayName: hotAssetDisplayName(input.key),
			description: `key=${input.key}`,
			creator: input.creator,
		});
		const operation = await oc.waitForOperation(operationId);
		if (operation?.error) throw new AssetsError(`creating the asset for ${input.key} failed: ${JSON.stringify(operation.error)}`);
		assetId = Number(operation?.response?.assetId);
		if (!positiveInt(assetId)) throw new AssetsError(`creating the asset for ${input.key} returned no asset id: ${JSON.stringify(operation).slice(0, 300)}`);
		created = true;
		input.onCreated?.(assetId);
	}
	const operationId = await oc.updateModelAsset({ assetId, bytes: stampExport(input.bytes, assetId, input.hash), fileName: `${input.key.replace(/\//g, "-")}.rbxm` });
	const operation = await oc.waitForOperation(operationId);
	if (operation?.error) throw new AssetsError(`uploading ${input.key} as a new version of asset ${assetId} failed: ${JSON.stringify(operation.error)}`);
	let n = Number(operation?.response?.revisionId);
	if (!positiveInt(n)) {
		const body = await oc.call("GET", `/assets/v1/assets/${assetId}/versions?maxPageSize=1`);
		const path: unknown = body?.assetVersions?.[0]?.path;
		n = typeof path === "string" ? Number(path.split("/").pop()) : Number.NaN;
		if (!positiveInt(n)) throw new AssetsError(`can't tell the version number of asset ${assetId} after the upload`);
	}
	let moderation: string | undefined = operation?.response?.moderationResult?.moderationState;
	if (moderation !== "Approved") moderation = (await oc.waitForModeration(assetId, input.moderationTimeout)).state;
	return { assetId, n, moderation: moderation ?? "unknown", created };
}

// The upload log (state dir) -----------------------------------------------------------------------------------------

export interface AssetLogRecord {
	event: "created" | "uploaded" | "failed" | "synced";
	at: string;
	universeId: number;
	project?: string;
	key?: string;
	assetId?: number;
	[field: string]: unknown;
}

export function appendAssetLog(stateDir: string, record: Omit<AssetLogRecord, "at">): AssetLogRecord {
	mkdirSync(stateDir, { recursive: true });
	const line: AssetLogRecord = { at: new Date().toISOString(), ...record } as AssetLogRecord;
	appendFileSync(join(stateDir, ASSETS_LOG), JSON.stringify(line) + "\n");
	return line;
}

export function readAssetLog(stateDir: string, universeId: number): AssetLogRecord[] {
	const path = join(stateDir, ASSETS_LOG);
	if (!existsSync(path)) return [];
	const records: AssetLogRecord[] = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (isRecord(record) && record.universeId === universeId) records.push(record as AssetLogRecord);
		} catch {}
	}
	return records;
}

/**
 * An upload of exactly these bytes that a previous run made and Roblox approved, when it is the key's latest event
 * here (a run that failed elsewhere writes no lockfile; the next one reuses it instead of uploading again). A later
 * "failed" or "created" record for the key voids it.
 */
export function reusableUpload(records: AssetLogRecord[], key: string, hash: string): HotAssetUpload | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (record.key !== key || (record.event !== "uploaded" && record.event !== "failed" && record.event !== "created")) continue;
		if (record.event !== "uploaded" || record.hash !== hash || record.moderation !== "Approved") return undefined;
		if (!positiveInt(record.assetId) || !positiveInt(record.n)) return undefined;
		return { assetId: record.assetId, n: record.n, moderation: "Approved", created: false };
	}
	return undefined;
}

/** The asset id this machine already made for a key (a run that stopped after creating it, or a key that came back). */
export function knownAssetId(records: AssetLogRecord[], key: string): number | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (record.key === key && (record.event === "created" || record.event === "uploaded") && positiveInt(record.assetId)) return record.assetId;
	}
	return undefined;
}
