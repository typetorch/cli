/**
 * `typetorch kernel deploy --engine luau` (plans/13 "Patch engines", the `luau` row; spike S12): the Luau Execution
 * task that patches the kernel into the place WITHOUT downloading it (Roblox has no API-key route for place files).
 * This file holds the pure parts: the task scripts, the kernel-slots project, the settings values, the result parser
 * and the error explanations. kernel-luau.ts runs them.
 *
 * The deploy task runs on `/versions/{base}/luau-execution-session-tasks` with the kernel slots `.rbxm` as its binary
 * input (`({...})[1].BinaryInput`). It:
 *   1. deserializes the input (SerializationService:DeserializeInstancesAsync): one Folder `TypeTorchKernelSlots`
 *      holding a Folder per service, each holding that service's slots (the TypeTorch* children of the kernel's
 *      place.project.json);
 *   2. reads the place's current kernel (identity attributes, scripts per slot);
 *   3. takes the OUTSIDE MANIFEST twice: every top-level child of every service that isn't a slot, as a descriptor
 *      (tree shape, names, classes, attributes, tags, ObjectValue targets, script source hashes) plus the SHA-256 of its
 *      SerializeInstancesAsync bytes. A subtree whose bytes differ between the two reads is "unstable" and is then
 *      compared by its descriptor only;
 *   4. replaces ONLY the slots (every copy) with the input's, re-points ObjectValues outside the slots that pointed
 *      into the old kernel to the instance at the same path in the new one (or clears them, listed), applies the
 *      service settings (HttpEnabled; LoadStringEnabled only with --loadstring), refusing when one can't be set;
 *   5. takes the outside manifest again: anything that changed aborts (nothing is saved);
 *   6. checks the slots (one copy each, the identity attributes the CLI expects);
 *   7. mode "save" only, and only when nothing above found a problem: AssetService:SavePlaceAsync() (publishes:
 *      SaveWithoutPublish defaults to false). The "check" and "verify" scripts don't contain that call at all.
 * It returns one table (JSON in `output.results[0]`); every list in it is capped.
 *
 * The restore task (`kernel restore --version <n>`) runs on `/versions/{n}`: it reports that version's kernel and
 * size, and (mode "save") only calls SavePlaceAsync, which republishes version n as the newest version.
 */
import { createHash } from "node:crypto";
import { isRecord } from "./json.ts";
import { readRbxm, type RbxmInstance } from "./rbxm.ts";
import type { ServiceProp, SlotRef } from "./placepatch.ts";

/** The name of the Folder at the root of the kernel slots `.rbxm` (the binary input). */
export const SLOTS_ROOT = "TypeTorchKernelSlots";
/** Open Cloud: a task binary input may be at most 100 MiB. */
export const BINARY_INPUT_LIMIT = 100 * 1024 * 1024;
/** Open Cloud: a task script may be at most 4 MB (decimal, to be safe). */
export const TASK_SCRIPT_LIMIT = 4_000_000;
/** Open Cloud: a task runs for at most 5 minutes. The kernel tasks ask for all of it by default. */
export const TASK_TIMEOUT_MAX = 300;
/** Open Cloud: return values may be at most 4 MB of JSON. */
export const TASK_RESULT_LIMIT = 4_000_000;
/** The place setting SavePlaceAsync needs (Creator Hub, per place). */
export const SAVE_SETTING = "Allow place to be updated using Save Place API";

/** The script classes whose sources the task hashes (and the CLI lists). */
const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

/** Where the owner turns on SavePlaceAsync for a place (Creator Hub > the experience > Places > the place > Permissions). */
export function saveSettingUrl(universeId: number, placeId: number): string {
	return `https://create.roblox.com/dashboard/creations/experiences/${universeId}/places/${placeId}/permissions`;
}

// Luau literals ------------------------------------------------------------------------------------------------------

/** A Luau literal for JSON-like data (strings escaped byte by byte; no functions, no cycles). */
export function toLuau(value: unknown): string {
	if (value === null || value === undefined) return "nil";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`toLuau: ${value} is not a finite number`);
		return String(value);
	}
	if (typeof value === "string") return luauString(value);
	if (Array.isArray(value)) return `{ ${value.map(toLuau).join(", ")} }`;
	if (isRecord(value)) {
		const parts = Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `[${luauString(k)}] = ${toLuau(v)}`);
		return parts.length ? `{ ${parts.join(", ")} }` : "{}";
	}
	throw new Error(`toLuau: can't write a ${typeof value}`);
}

/** A double-quoted Luau string; anything outside printable ASCII is written as \ddd bytes. */
export function luauString(text: string): string {
	let out = '"';
	for (const byte of new TextEncoder().encode(text)) {
		if (byte === 0x22) out += '\\"';
		else if (byte === 0x5c) out += "\\\\";
		else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
		// Always three digits: "\0" followed by a digit would read as another byte.
		else out += `\\${String(byte).padStart(3, "0")}`;
	}
	return `${out}"`;
}

// The kernel slots project -------------------------------------------------------------------------------------------

/**
 * The Rojo project for the binary input: a Folder `TypeTorchKernelSlots`, a Folder per service named like the
 * service's class, and each slot node of the stamped kernel project (paths, attributes, the backup build) under it.
 * Nothing that isn't a slot (the baseplate, the services' $properties) goes in.
 */
export function slotsProject(stamped: unknown, slots: SlotRef[]): { name: string; tree: Record<string, unknown> } {
	const tree: Record<string, unknown> = { $className: "Folder" };
	const source = isRecord(stamped) && isRecord(stamped.tree) ? (stamped.tree as Record<string, unknown>) : {};
	for (const slot of slots) {
		const key = Object.keys(source).find((name) => isRecord(source[name]) && ((source[name] as Record<string, unknown>).$className ?? name) === slot.service);
		const service = key ? (source[key] as Record<string, unknown>) : undefined;
		const node = service?.[slot.name];
		if (!isRecord(node)) throw new Error(`the kernel project has no ${slot.service}.${slot.name}`);
		const folder = (tree[slot.service] ??= { $className: "Folder" }) as Record<string, unknown>;
		folder[slot.name] = JSON.parse(JSON.stringify(node));
	}
	return { name: SLOTS_ROOT, tree };
}

/** A setting the task applies: the service property and the value the kernel project gives it. */
export interface SettingValue extends ServiceProp {
	value: boolean | number | string;
}

/** A Rojo `$properties` value as a plain value: implicit (`true`, `3`, `"x"`) or explicit (`{ "Bool": true }`). */
export function rojoValue(raw: unknown): boolean | number | string | undefined {
	if (typeof raw === "boolean" || typeof raw === "number" || typeof raw === "string") return raw;
	if (isRecord(raw)) {
		const entries = Object.entries(raw);
		if (entries.length === 1) {
			const [type, value] = entries[0];
			if (["Bool", "Float32", "Float64", "Int32", "Int64", "String"].includes(type) && (typeof value === "boolean" || typeof value === "number" || typeof value === "string")) return value;
		}
	}
	return undefined;
}

/** The values of the settings (kernelLayout's serviceProps) from the stamped project. Unusable values are listed. */
export function settingValues(stamped: unknown, props: ServiceProp[]): { settings: SettingValue[]; unusable: string[] } {
	const tree = isRecord(stamped) && isRecord(stamped.tree) ? (stamped.tree as Record<string, unknown>) : {};
	const settings: SettingValue[] = [];
	const unusable: string[] = [];
	for (const prop of props) {
		const key = Object.keys(tree).find((name) => isRecord(tree[name]) && ((tree[name] as Record<string, unknown>).$className ?? name) === prop.service);
		const node = key ? (tree[key] as Record<string, unknown>) : undefined;
		const value = isRecord(node?.$properties) ? rojoValue((node!.$properties as Record<string, unknown>)[prop.prop]) : undefined;
		if (value === undefined) unusable.push(`${prop.service}.${prop.prop}`);
		else settings.push({ ...prop, value });
	}
	return { settings, unusable };
}

// What the CLI reads from the slots .rbxm itself ---------------------------------------------------------------------

export interface SlotInventory {
	slot: string;
	instances: number;
	scripts: number;
	/** SHA-256 hex of the sorted `relpath:Class` lines of the slot's scripts (the root is "."), "\n"-joined. */
	scriptsHash: string;
}

/** Lines `relpath:Class` for every script in a subtree, sorted by bytes (the order Luau's `<` gives). */
export function scriptLines(paths: { rel: string; className: string }[]): string[] {
	return paths
		.filter((p) => SCRIPT_CLASSES.has(p.className))
		.map((p) => `${p.rel}:${p.className}`)
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export const sha256Text = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The slots in the binary input as the CLI's own reader sees them (an independent check of what the task reports),
 * plus the identity attributes on the kernel folder. Throws when the file isn't shaped like `slotsProject`.
 */
export function readSlotsRbxm(bytes: Uint8Array, slots: SlotRef[], identitySlot: SlotRef): { slots: SlotInventory[]; identity: Record<string, string | number | boolean>; instances: number } {
	const instances = readRbxm(bytes);
	const byReferent = new Map(instances.map((i) => [i.referent, i]));
	const children = new Map<number, RbxmInstance[]>();
	for (const instance of instances) {
		const list = children.get(instance.parent) ?? [];
		list.push(instance);
		children.set(instance.parent, list);
	}
	const roots = instances.filter((i) => i.parent === -1 || !byReferent.has(i.parent));
	if (roots.length !== 1 || roots[0].name !== SLOTS_ROOT || roots[0].className !== "Folder") {
		throw new Error(`the kernel slots file must have one root Folder ${SLOTS_ROOT} (found ${roots.map((r) => `${r.name} (${r.className})`).join(", ") || "none"})`);
	}
	const find = (parent: number, name: string) => (children.get(parent) ?? []).filter((i) => i.name === name);
	const out: SlotInventory[] = [];
	let identity: Record<string, string | number | boolean> = {};
	for (const slot of slots) {
		const services = find(roots[0].referent, slot.service);
		const found = services.length === 1 ? find(services[0].referent, slot.name) : [];
		if (found.length !== 1) throw new Error(`the kernel slots file has ${found.length} ${slot.service}.${slot.name} (expected 1)`);
		const paths: { rel: string; className: string }[] = [];
		const walk = (instance: RbxmInstance, rel: string) => {
			paths.push({ rel, className: instance.className });
			for (const child of children.get(instance.referent) ?? []) walk(child, rel === "." ? child.name : `${rel}/${child.name}`);
		};
		walk(found[0], ".");
		const lines = scriptLines(paths);
		out.push({ slot: `${slot.service}.${slot.name}`, instances: paths.length, scripts: lines.length, scriptsHash: sha256Text(lines.join("\n")) });
		if (slot.service === identitySlot.service && slot.name === identitySlot.name) identity = { ...(found[0].attributes ?? {}) };
	}
	return { slots: out, identity, instances: instances.length };
}

// The task scripts ---------------------------------------------------------------------------------------------------

export type KernelTaskMode = "check" | "save" | "verify";

export interface KernelTaskConfig {
	mode: KernelTaskMode;
	placeId: number;
	/** The version the task runs on (checked against game.PlaceVersion when readable). */
	placeVersion: number;
	slots: SlotRef[];
	settings: SettingValue[];
	/** A first install (no slot in the place) is refused without it (mode "save"; "check" only reports firstInstall). */
	install: boolean;
	/** The kernel folder whose attributes identify the kernel (ServerScriptService.TypeTorchKernel). */
	identitySlot: SlotRef;
	/** Identity attributes the new kernel must carry after the swap (verify: in the saved version). */
	expect: Record<string, string>;
	/** mode "save": the check task's outside descriptor root; any other value aborts before the save. */
	expectOutside?: string;
}

/**
 * The deploy task's Luau source. Mode "check" and "verify" scripts never contain the SavePlaceAsync call; "save" runs
 * it only after every check passed.
 */
export function kernelTaskScript(config: KernelTaskConfig): string {
	const save = config.mode === "save";
	const script = KERNEL_TASK_LUAU.replace("__CONFIG__", () => toLuau({ ...config, root: SLOTS_ROOT })).replace("__SAVE__", () => (save ? SAVE_BLOCK : "\t-- (no save in this mode)\n"));
	if (!save && script.includes("SavePlaceAsync")) throw new Error("internal: a non-save kernel task contains SavePlaceAsync");
	return script;
}

export interface RestoreTaskConfig {
	placeId: number;
	placeVersion: number;
	save: boolean;
	identitySlot: SlotRef;
}

/** The restore task: reports the version's kernel and size; with `save` it then only calls SavePlaceAsync. */
export function restoreTaskScript(config: RestoreTaskConfig): string {
	const script = RESTORE_TASK_LUAU.replace("__CONFIG__", () => toLuau(config)).replace("__SAVE__", () => (config.save ? RESTORE_SAVE_BLOCK : "-- (no save in a dry run)\n"));
	if (!config.save && script.includes("SavePlaceAsync")) throw new Error("internal: a dry-run restore task contains SavePlaceAsync");
	return script;
}

const SAVE_BLOCK = String.raw`	if #result.problems == 0 then
		local saveStarted = clock()
		local okSave, saveError = pcall(function()
			game:GetService("AssetService"):SavePlaceAsync()
		end)
		result.timings.save = clock() - saveStarted
		result.saveAttempted = true
		if okSave then
			result.saved = true
		else
			result.saveError = tostring(saveError)
		end
	end
`;

const RESTORE_SAVE_BLOCK = String.raw`local saveStarted = clock()
local okSave, saveError = pcall(function()
	game:GetService("AssetService"):SavePlaceAsync()
end)
result.timings.save = clock() - saveStarted
result.saveAttempted = true
if okSave then
	result.saved = true
else
	result.saveError = tostring(saveError)
end
`;

/** Shared helpers of both scripts: hashing, paths, attributes, the kernel identity. */
const HELPERS = String.raw`local clock = os.clock
local LIST_CAP = 40

local function getService(name)
	local ok, service = pcall(function()
		return game:GetService(name)
	end)
	if ok then
		return service
	end
	return nil
end

local function findService(name)
	local ok, service = pcall(function()
		return game:FindService(name)
	end)
	if ok then
		return service
	end
	return nil
end

local SerializationService = getService("SerializationService")
local EncodingService = getService("EncodingService")

local function hex(buf)
	local parts = table.create(buffer.len(buf))
	for i = 0, buffer.len(buf) - 1 do
		parts[i + 1] = string.format("%02x", buffer.readu8(buf, i))
	end
	return table.concat(parts)
end

-- Fallback when EncodingService can't hash: two FNV-1a 32 runs (equal content gives an equal hash: enough to compare).
local function fnvMul(h)
	return (bit32.lshift(h, 24) + h * 403) % 4294967296
end
local function fnv(buf)
	local a, b = 2166136261, 3735928559
	for i = 0, buffer.len(buf) - 1 do
		local byte = buffer.readu8(buf, i)
		a = fnvMul(bit32.bxor(a, byte))
		b = fnvMul(bit32.bxor(b, byte))
	end
	return string.format("fnv%08x%08x", a, b)
end

local hashMode = "sha256"
local function hashBuffer(buf)
	if EncodingService ~= nil and hashMode == "sha256" then
		local ok, digest = pcall(function()
			return EncodingService:ComputeBufferHash(buf, Enum.HashAlgorithm.Sha256)
		end)
		if ok and typeof(digest) == "buffer" then
			return hex(digest)
		end
	end
	hashMode = "fnv"
	return fnv(buf)
end
local function hashString(text)
	return hashBuffer(buffer.fromstring(text))
end

local function tryRead(instance, prop)
	local ok, value = pcall(function()
		return instance[prop]
	end)
	if ok then
		return value, true
	end
	return nil, false
end

local function childrenOf(instance)
	local ok, children = pcall(function()
		return instance:GetChildren()
	end)
	if ok then
		return children
	end
	return nil
end

local function attributesOf(instance)
	local ok, attributes = pcall(function()
		return instance:GetAttributes()
	end)
	if not ok then
		return "?"
	end
	local keys = {}
	for key in attributes do
		table.insert(keys, key)
	end
	table.sort(keys)
	local parts = {}
	for _, key in keys do
		local value = attributes[key]
		table.insert(parts, key .. "=" .. typeof(value) .. ":" .. tostring(value))
	end
	return table.concat(parts, ";")
end

local function tagsOf(instance)
	local ok, tags = pcall(function()
		return instance:GetTags()
	end)
	if not ok then
		return "?"
	end
	table.sort(tags)
	return table.concat(tags, ",")
end

local function isScript(instance)
	return instance.ClassName == "Script" or instance.ClassName == "LocalScript" or instance.ClassName == "ModuleScript"
end

-- Scripts whose Source this task couldn't read (unverified whether tasks may): their changes can't be listed.
local sourceUnreadable = 0
local function sourceHash(instance)
	local source, ok = tryRead(instance, "Source")
	if ok and type(source) == "string" then
		return hashString(source)
	end
	sourceUnreadable += 1
	return "?"
end

-- The kernel identity: the attributes on the kernel folder, else KERNEL_VERSION / KERNEL_API from Constants.
local function kernelIdentity(identitySlot)
	local identity = {}
	local service = findService(identitySlot.service)
	local folder = if service then service:FindFirstChild(identitySlot.name) else nil
	if folder ~= nil then
		for _, key in { "KernelVersion", "KernelHash", "KernelCommit", "KeyAssetId", "FallbackPublicKey", "BackupArtifactId" } do
			local value = folder:GetAttribute(key)
			if value ~= nil then
				identity[key] = tostring(value)
			end
		end
		local backupService = findService("ServerStorage")
		local backup = if backupService then backupService:FindFirstChild("TypeTorchBackup") else nil
		if backup ~= nil then
			local value = backup:GetAttribute("BackupArtifactId")
			if value ~= nil then
				identity.BackupArtifactId = tostring(value)
			end
		end
	end
	local shared = findService("ReplicatedStorage")
	local constants = if shared then shared:FindFirstChild("TypeTorchKernelShared") else nil
	constants = if constants then constants:FindFirstChild("Constants") else nil
	if constants ~= nil then
		local source = tryRead(constants, "Source")
		if type(source) == "string" then
			identity.constantsVersion = string.match(source, 'KERNEL_VERSION%s*=%s*"([^"]+)"')
			identity.constantsApi = string.match(source, "KERNEL_API%s*=%s*(%d+)")
		end
	end
	identity.present = folder ~= nil
	return identity
end
`;

/** The deploy task (modes check, save, verify). __CONFIG__ and __SAVE__ are filled by kernelTaskScript. */
export const KERNEL_TASK_LUAU = String.raw`--!nocheck
-- TypeTorch kernel deploy, luau engine. Generated by the TypeTorch CLI (src/kernelpatch-task.ts); see that file.
local CONFIG = __CONFIG__
local taskInput = ...
` + HELPERS + String.raw`
local started = clock()
local result = {
	v = 1,
	mode = CONFIG.mode,
	ok = false,
	saved = false,
	problems = {},
	warnings = {},
	timings = {},
}
local function problem(text)
	if #result.problems < 100 then
		table.insert(result.problems, text)
	end
end
local function warning(text)
	if #result.warnings < 50 then
		table.insert(result.warnings, text)
	end
end
local function capped(list, value)
	if #list < LIST_CAP then
		table.insert(list, value)
	end
end

local slotSet = {}
for _, slot in CONFIG.slots do
	slotSet[slot.service .. "\0" .. slot.name] = true
end
local function isSlotChild(service, child)
	return slotSet[service.ClassName .. "\0" .. child.Name] == true
end

-- The chain {instance, ..., service, DataModel}; nil when the instance isn't in the DataModel.
local function chainOf(instance)
	local chain = {}
	local node = instance
	while node ~= nil do
		table.insert(chain, node)
		node = node.Parent
	end
	local top = chain[#chain]
	if top == nil or top.ClassName ~= "DataModel" then
		return nil
	end
	return chain
end

-- "Service/Slot/a/b" when the instance is (in) a kernel slot, else nil.
local function slotPath(instance)
	local chain = chainOf(instance)
	if chain == nil or #chain < 3 then
		return nil
	end
	local service, top = chain[#chain - 1], chain[#chain - 2]
	if not isSlotChild(service, top) then
		return nil
	end
	local names = { service.ClassName }
	for i = #chain - 2, 1, -1 do
		table.insert(names, chain[i].Name)
	end
	return table.concat(names, "/")
end

-- Every "Service/Slot/..." path of the new kernel (filled from the input before the first manifest).
local newSlotPaths = {}

-- Where an ObjectValue points. Before the swap, a target in the old kernel that the new one doesn't have counts as
-- nil (the swap clears it); a target the new one has counts by its path (the swap re-points it).
local function refName(target, phase)
	if target == nil then
		return "nil"
	end
	local path = slotPath(target)
	if path ~= nil then
		if phase == "before" and not newSlotPaths[path] then
			return "nil"
		end
		return "slot:" .. path
	end
	if chainOf(target) == nil then
		return "detached:" .. target.ClassName .. ":" .. target.Name
	end
	return target:GetFullName()
end

local function describeTree(root, phase, refs)
	local lines = {}
	local count = 0
	local function walk(instance, depth)
		count += 1
		local extra = ""
		if instance.ClassName == "ObjectValue" then
			local target = tryRead(instance, "Value")
			extra = "ref=" .. refName(target, phase)
			if refs ~= nil and target ~= nil then
				local path = slotPath(target)
				if path ~= nil then
					table.insert(refs, { holder = instance, path = path })
				end
			end
		elseif isScript(instance) then
			extra = "src=" .. sourceHash(instance)
		end
		table.insert(lines, depth .. "|" .. instance.Name .. "|" .. instance.ClassName .. "|" .. attributesOf(instance) .. "|" .. tagsOf(instance) .. "|" .. extra)
		for _, child in childrenOf(instance) or {} do
			walk(child, depth + 1)
		end
	end
	walk(root, 0)
	return table.concat(lines, "\n"), count
end

-- The outside manifest: per service (its attributes and tags) and per top-level child that isn't a slot (descriptor
-- hash, and the hash of its serialized bytes when serialize is set).
local function manifest(phase, serialize, refs)
	local m = { entries = {}, keys = {}, services = 0, subtrees = 0, instances = 0, unserializable = 0, unreadable = 0 }
	for _, service in childrenOf(game) or {} do
		m.services += 1
		local serviceKey = service.ClassName .. "|" .. service.Name
		m.entries[serviceKey] = { d = hashString(service.ClassName .. "|" .. attributesOf(service) .. "|" .. tagsOf(service)), n = 0 }
		table.insert(m.keys, serviceKey)
		local children = childrenOf(service)
		if children == nil then
			m.unreadable += 1
			m.entries[serviceKey].d = "unreadable"
			continue
		end
		local index = 0
		for _, child in children do
			if not isSlotChild(service, child) then
				index += 1
				local key = serviceKey .. "/" .. index .. ":" .. child.Name
				local ok, text, count = pcall(describeTree, child, phase, refs)
				local entry
				if ok then
					entry = { d = hashString(text), n = count }
				else
					entry = { d = "error:" .. tostring(text), n = 0 }
					m.unreadable += 1
				end
				if serialize and SerializationService ~= nil then
					local okBytes, bytes = pcall(function()
						return SerializationService:SerializeInstancesAsync({ child })
					end)
					if okBytes and typeof(bytes) == "buffer" then
						entry.s = hashBuffer(bytes)
					else
						m.unserializable += 1
					end
				end
				m.entries[key] = entry
				table.insert(m.keys, key)
				m.subtrees += 1
				m.instances += entry.n
			end
		end
	end
	local lines, dlines = {}, {}
	for _, key in m.keys do
		local entry = m.entries[key]
		table.insert(lines, key .. "\t" .. entry.d .. "\t" .. tostring(entry.s))
		table.insert(dlines, key .. "\t" .. entry.d)
	end
	m.root = hashString(table.concat(lines, "\n"))
	m.rootD = hashString(table.concat(dlines, "\n"))
	return m
end

local function summary(m)
	return { services = m.services, subtrees = m.subtrees, instances = m.instances, unserializable = m.unserializable, unreadable = m.unreadable, root = m.root, rootD = m.rootD }
end

-- A slot's scripts: { ["relpath:Class"] = sourceHash } and the counts.
local function slotScripts(root)
	local scripts, lines = {}, {}
	local count = 0
	local function walk(instance, rel)
		count += 1
		if isScript(instance) then
			local line = rel .. ":" .. instance.ClassName
			scripts[line] = sourceHash(instance)
			table.insert(lines, line)
		end
		for _, child in childrenOf(instance) or {} do
			walk(child, if rel == "." then child.Name else rel .. "/" .. child.Name)
		end
	end
	walk(root, ".")
	table.sort(lines)
	return scripts, count, lines
end

local function addPaths(root, prefix)
	newSlotPaths[prefix] = true
	for _, child in childrenOf(root) or {} do
		addPaths(child, prefix .. "/" .. child.Name)
	end
end

local function splitPath(path)
	local names = {}
	for name in string.gmatch(path, "[^/]+") do
		table.insert(names, name)
	end
	return names
end

local function resolvePath(path)
	local names = splitPath(path)
	local node = findService(names[1])
	for i = 2, #names do
		if node == nil then
			return nil
		end
		node = node:FindFirstChild(names[i])
	end
	return node
end

local function slotInventories()
	local out = {}
	for _, slot in CONFIG.slots do
		local service = findService(slot.service)
		local copies = {}
		for _, child in (if service then childrenOf(service) else nil) or {} do
			if child.Name == slot.name then
				table.insert(copies, child)
			end
		end
		local entry = { slot = slot.service .. "." .. slot.name, copies = #copies, instances = 0, scripts = 0 }
		if #copies == 1 then
			local _, count, lines = slotScripts(copies[1])
			entry.instances = count
			entry.scripts = #lines
			entry.scriptsHash = hashString(table.concat(lines, "\n"))
		end
		table.insert(out, entry)
	end
	return out
end

local function run()
	-- The place this task runs on.
	local placeId = tryRead(game, "PlaceId")
	local placeVersion = tryRead(game, "PlaceVersion")
	result.placeId = placeId
	result.placeVersion = placeVersion
	if type(placeId) == "number" and placeId ~= 0 and placeId ~= CONFIG.placeId then
		problem("this task runs in place " .. placeId .. ", the deploy is for place " .. CONFIG.placeId)
	end
	if type(placeVersion) == "number" and placeVersion ~= 0 and placeVersion ~= CONFIG.placeVersion then
		problem("this task runs on place version " .. placeVersion .. ", the deploy asked for v" .. CONFIG.placeVersion)
	end

	if CONFIG.mode == "verify" then
		local t = clock()
		result.identity = kernelIdentity(CONFIG.identitySlot)
		result.newSlots = slotInventories()
		result.outside = summary(manifest("after", false, nil))
		result.timings.verify = clock() - t
		result.hashMode = hashMode
		return
	end

	-- 1. The input: one Folder holding a Folder per service, each holding that service's slots.
	local t = clock()
	if type(taskInput) ~= "table" or typeof(taskInput.BinaryInput) ~= "buffer" then
		problem("the task got no binary input (the kernel slots .rbxm)")
		return
	end
	result.inputBytes = buffer.len(taskInput.BinaryInput)
	if SerializationService == nil then
		problem("SerializationService isn't available in this task")
		return
	end
	local okInput, instances = pcall(function()
		return SerializationService:DeserializeInstancesAsync(taskInput.BinaryInput)
	end)
	if not okInput then
		problem("DeserializeInstancesAsync refused the kernel slots .rbxm: " .. tostring(instances))
		return
	end
	if #instances ~= 1 or instances[1].Name ~= CONFIG.root or instances[1].ClassName ~= "Folder" then
		problem("the kernel slots .rbxm must hold one Folder " .. CONFIG.root .. " (got " .. #instances .. " root instance(s))")
		return
	end
	local inputRoot = instances[1]
	local fresh = {}
	for _, slot in CONFIG.slots do
		local folder = inputRoot:FindFirstChild(slot.service)
		local instance = if folder then folder:FindFirstChild(slot.name) else nil
		if instance == nil then
			problem("the kernel slots .rbxm has no " .. slot.service .. "." .. slot.name)
		else
			fresh[slot.service .. "\0" .. slot.name] = instance
			addPaths(instance, slot.service .. "/" .. slot.name)
		end
	end
	for _, folder in inputRoot:GetChildren() do
		for _, child in folder:GetChildren() do
			if not slotSet[folder.Name .. "\0" .. child.Name] then
				problem("the kernel slots .rbxm holds " .. folder.Name .. "." .. child.Name .. ", which isn't a kernel slot")
			end
		end
	end
	if #result.problems > 0 then
		return
	end
	result.timings.input = clock() - t

	-- 2. The place's kernel now, and the slot services (created if missing, before the manifest, so both sides see them).
	local addedServices = {}
	for _, slot in CONFIG.slots do
		if findService(slot.service) == nil then
			if getService(slot.service) ~= nil then
				table.insert(addedServices, slot.service)
			end
		end
	end
	result.addedServices = addedServices
	result.oldKernel = kernelIdentity(CONFIG.identitySlot)
	local oldSlots = {}
	local anySlot = false
	for _, slot in CONFIG.slots do
		local service = getService(slot.service)
		if service == nil then
			problem("the place has no service " .. slot.service)
			return
		end
		local copies = {}
		for _, child in childrenOf(service) or {} do
			if child.Name == slot.name then
				table.insert(copies, child)
			end
		end
		local scripts, count = {}, 0
		for _, copy in copies do
			local s, n = slotScripts(copy)
			count += n
			for line, h in s do
				scripts[line] = h
			end
		end
		if #copies > 0 then
			anySlot = true
		end
		oldSlots[slot.service .. "\0" .. slot.name] = { copies = copies, scripts = scripts, count = count }
	end
	result.firstInstall = not anySlot
	if not anySlot and not CONFIG.install and CONFIG.mode == "save" then
		problem("the place has no TypeTorch kernel yet: a first install needs --install")
	end

	-- 3. The outside manifest, twice (a subtree whose bytes differ between two reads is compared by descriptor only).
	t = clock()
	local refs = {}
	local before1 = manifest("before", true, refs)
	local before = manifest("before", true, nil)
	local unstable = {}
	local unstableCount = 0
	for _, key in before.keys do
		local a, b = before1.entries[key], before.entries[key]
		if a == nil or a.d ~= b.d then
			problem("the place's content under " .. key .. " reads differently twice in a row; nothing was changed")
		elseif a.s ~= b.s then
			unstable[key] = true
			unstableCount += 1
		end
	end
	result.timings.before = clock() - t
	if CONFIG.expectOutside ~= nil and before.rootD ~= CONFIG.expectOutside then
		problem("the place's content outside the kernel differs from what the check task saw (" .. before.rootD .. " now, " .. CONFIG.expectOutside .. " then); nothing was saved")
	end
	if #result.problems > 0 then
		result.outside = summary(before)
		return
	end

	-- 4. Swap the slots (every copy), re-point references into the old kernel, apply the settings.
	t = clock()
	local slotReports = {}
	for _, slot in CONFIG.slots do
		local key = slot.service .. "\0" .. slot.name
		local service = getService(slot.service)
		local old = oldSlots[key]
		local newScripts, newCount = slotScripts(fresh[key])
		local report = { slot = slot.service .. "." .. slot.name, copies = #old.copies, before = old.count, after = newCount, changed = {}, added = {}, removed = {}, nChanged = 0, nAdded = 0, nRemoved = 0 }
		for line, h in newScripts do
			local was = old.scripts[line]
			if was == nil then
				report.nAdded += 1
				capped(report.added, line)
			elseif was ~= h then
				report.nChanged += 1
				capped(report.changed, line)
			end
		end
		for line in old.scripts do
			if newScripts[line] == nil then
				report.nRemoved += 1
				capped(report.removed, line)
			end
		end
		for _, copy in old.copies do
			copy:Destroy()
		end
		fresh[key].Parent = service
		table.insert(slotReports, report)
	end
	inputRoot:Destroy()
	result.slots = slotReports

	local remapped, cleared = {}, {}
	local nRemapped, nCleared = 0, 0
	for _, ref in refs do
		local target = resolvePath(ref.path)
		local where = ref.holder:GetFullName() .. ".Value -> " .. ref.path
		if target ~= nil then
			ref.holder.Value = target
			nRemapped += 1
			capped(remapped, where)
		else
			-- The engine keeps a reference to a destroyed instance until it is cleared (rbx-dom already cleared it).
			if ref.holder.Value ~= nil then
				ref.holder.Value = nil
			end
			nCleared += 1
			capped(cleared, where)
		end
	end
	result.refs = { remapped = remapped, cleared = cleared, nRemapped = nRemapped, nCleared = nCleared }

	local settings = {}
	for _, setting in CONFIG.settings do
		local path = setting.service .. "." .. setting.prop
		local entry = { path = path, want = tostring(setting.value), changed = false }
		local service = getService(setting.service)
		local current, readable = nil, false
		if service ~= nil then
			current, readable = tryRead(service, setting.prop)
		end
		entry.before = if readable then tostring(current) else nil
		if readable and current == setting.value then
			entry.after = entry.before
		else
			local okSet, setError = pcall(function()
				service[setting.prop] = setting.value
			end)
			if okSet then
				local now, nowReadable = tryRead(service, setting.prop)
				entry.after = if nowReadable then tostring(now) else nil
				entry.changed = true
				if nowReadable and now ~= setting.value then
					problem(path .. " is " .. tostring(now) .. " after setting it to " .. tostring(setting.value))
				end
			else
				entry.error = tostring(setError)
				problem(path .. " can't be set to " .. tostring(setting.value) .. " from a task (" .. tostring(setError) .. ")")
			end
		end
		table.insert(settings, entry)
	end
	result.settings = settings
	result.timings.swap = clock() - t

	-- 5. The outside manifest after the swap: anything that changed aborts.
	t = clock()
	local after = manifest("after", true, nil)
	result.timings.after = clock() - t
	local changed = {}
	local nChanged = 0
	for _, key in before.keys do
		local a, b = before.entries[key], after.entries[key]
		local why = nil
		if b == nil then
			why = "gone"
		elseif a.d ~= b.d then
			why = "structure, names, attributes, tags, references or script sources changed"
		elseif not unstable[key] and a.s ~= b.s then
			why = "properties changed"
		end
		if why ~= nil then
			nChanged += 1
			capped(changed, key .. ": " .. why)
		end
	end
	for _, key in after.keys do
		if before.entries[key] == nil then
			nChanged += 1
			capped(changed, key .. ": new")
		end
	end
	result.outside = summary(before)
	result.outside.after = after.root
	result.outside.afterD = after.rootD
	result.outside.unstable = unstableCount
	result.outside.changed = changed
	result.outside.nChanged = nChanged
	if nChanged > 0 then
		problem(nChanged .. " thing(s) outside the kernel slots changed during the patch (" .. table.concat(changed, "; ") .. "); nothing was saved")
	end

	-- 6. The slots now: one copy each, the identity the CLI expects.
	result.newSlots = slotInventories()
	for _, entry in result.newSlots do
		if entry.copies ~= 1 then
			problem(entry.slot .. " has " .. entry.copies .. " copies after the swap")
		end
	end
	result.identity = kernelIdentity(CONFIG.identitySlot)
	for key, value in CONFIG.expect do
		if result.identity[key] ~= value then
			problem("the kernel's " .. key .. " is " .. tostring(result.identity[key]) .. " after the swap, expected " .. value)
		end
	end
	result.hashMode = hashMode

	-- 7. Save (mode "save" only).
__SAVE__end

local okRun, runError = pcall(run)
if not okRun then
	problem("the task failed: " .. tostring(runError))
end
result.sourceUnreadable = sourceUnreadable
result.ok = #result.problems == 0 and (CONFIG.mode ~= "save" or result.saved == true)
result.timings.total = clock() - started
return result
`;

/** The restore task. __CONFIG__ and __SAVE__ are filled by restoreTaskScript. */
export const RESTORE_TASK_LUAU = String.raw`--!nocheck
-- TypeTorch kernel restore --version, luau engine. Generated by the TypeTorch CLI (src/kernelpatch-task.ts).
local CONFIG = __CONFIG__
` + HELPERS + String.raw`
local started = clock()
local result = { v = 1, mode = if CONFIG.save then "save" else "check", ok = false, saved = false, timings = {} }
result.placeId = tryRead(game, "PlaceId")
result.placeVersion = tryRead(game, "PlaceVersion")
result.identity = kernelIdentity(CONFIG.identitySlot)
local services, instances = 0, 0
for _, service in childrenOf(game) or {} do
	services += 1
	local ok, descendants = pcall(function()
		return service:GetDescendants()
	end)
	if ok then
		instances += #descendants
	end
end
result.services = services
result.instances = instances
if type(result.placeVersion) == "number" and result.placeVersion ~= 0 and result.placeVersion ~= CONFIG.placeVersion then
	result.problem = "this task runs on place version " .. result.placeVersion .. ", the restore asked for v" .. CONFIG.placeVersion
else
__SAVE__end
result.ok = result.problem == nil and (not CONFIG.save or result.saved == true)
result.timings.total = clock() - started
return result
`;

// Results ------------------------------------------------------------------------------------------------------------

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0);

export interface SlotReport {
	slot: string;
	copies: number;
	before: number;
	after: number;
	changed: string[];
	added: string[];
	removed: string[];
	nChanged: number;
	nAdded: number;
	nRemoved: number;
}

export interface KernelTaskResult {
	mode: string;
	ok: boolean;
	saved: boolean;
	saveAttempted: boolean;
	saveError?: string;
	problems: string[];
	warnings: string[];
	placeId?: number;
	placeVersion?: number;
	firstInstall: boolean;
	addedServices: string[];
	oldKernel: Record<string, string>;
	identity: Record<string, string>;
	slots: SlotReport[];
	newSlots: { slot: string; copies: number; instances: number; scripts: number; scriptsHash?: string }[];
	settings: { path: string; want: string; before?: string; after?: string; changed: boolean; error?: string }[];
	refs: { remapped: string[]; cleared: string[]; nRemapped: number; nCleared: number };
	outside: { services: number; subtrees: number; instances: number; unserializable: number; unreadable: number; unstable: number; root?: string; rootD?: string; after?: string; afterD?: string; changed: string[]; nChanged: number };
	hashMode?: string;
	inputBytes?: number;
	/** Scripts whose Source the task couldn't read (their changes aren't listed). */
	sourceUnreadable: number;
	timings: Record<string, number>;
}

const record = (value: unknown): Record<string, string> =>
	isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)])) : {};

/** The deploy task's return value (output.results[0]) as a typed object; missing parts become empty. */
export function parseKernelTaskResult(results: unknown[]): KernelTaskResult {
	const raw = isRecord(results[0]) ? results[0] : {};
	const outside = isRecord(raw.outside) ? raw.outside : {};
	const refs = isRecord(raw.refs) ? raw.refs : {};
	return {
		mode: str(raw.mode) ?? "?",
		ok: raw.ok === true,
		saved: raw.saved === true,
		saveAttempted: raw.saveAttempted === true,
		saveError: str(raw.saveError),
		problems: list(raw.problems).map(String),
		warnings: list(raw.warnings).map(String),
		placeId: typeof raw.placeId === "number" ? raw.placeId : undefined,
		placeVersion: typeof raw.placeVersion === "number" ? raw.placeVersion : undefined,
		firstInstall: raw.firstInstall === true,
		addedServices: list(raw.addedServices).map(String),
		oldKernel: record(raw.oldKernel),
		identity: record(raw.identity),
		slots: list(raw.slots).map((s) => ({
			slot: String(s?.slot),
			copies: num(s?.copies),
			before: num(s?.before),
			after: num(s?.after),
			changed: list(s?.changed).map(String),
			added: list(s?.added).map(String),
			removed: list(s?.removed).map(String),
			nChanged: num(s?.nChanged),
			nAdded: num(s?.nAdded),
			nRemoved: num(s?.nRemoved),
		})),
		newSlots: list(raw.newSlots).map((s) => ({ slot: String(s?.slot), copies: num(s?.copies), instances: num(s?.instances), scripts: num(s?.scripts), scriptsHash: str(s?.scriptsHash) })),
		settings: list(raw.settings).map((s) => ({ path: String(s?.path), want: String(s?.want), before: str(s?.before), after: str(s?.after), changed: s?.changed === true, error: str(s?.error) })),
		refs: { remapped: list(refs.remapped).map(String), cleared: list(refs.cleared).map(String), nRemapped: num(refs.nRemapped), nCleared: num(refs.nCleared) },
		outside: {
			services: num(outside.services),
			subtrees: num(outside.subtrees),
			instances: num(outside.instances),
			unserializable: num(outside.unserializable),
			unreadable: num(outside.unreadable),
			unstable: num(outside.unstable),
			root: str(outside.root),
			rootD: str(outside.rootD),
			after: str(outside.after),
			afterD: str(outside.afterD),
			changed: list(outside.changed).map(String),
			nChanged: num(outside.nChanged),
		},
		hashMode: str(raw.hashMode),
		inputBytes: typeof raw.inputBytes === "number" ? raw.inputBytes : undefined,
		sourceUnreadable: num(raw.sourceUnreadable),
		timings: isRecord(raw.timings) ? Object.fromEntries(Object.entries(raw.timings).map(([k, v]) => [k, num(v)])) : {},
	};
}

export interface RestoreTaskResult {
	ok: boolean;
	saved: boolean;
	saveAttempted: boolean;
	saveError?: string;
	problem?: string;
	placeVersion?: number;
	identity: Record<string, string>;
	services: number;
	instances: number;
	timings: Record<string, number>;
}

export function parseRestoreTaskResult(results: unknown[]): RestoreTaskResult {
	const raw = isRecord(results[0]) ? results[0] : {};
	return {
		ok: raw.ok === true,
		saved: raw.saved === true,
		saveAttempted: raw.saveAttempted === true,
		saveError: str(raw.saveError),
		problem: str(raw.problem),
		placeVersion: typeof raw.placeVersion === "number" ? raw.placeVersion : undefined,
		identity: record(raw.identity),
		services: num(raw.services),
		instances: num(raw.instances),
		timings: isRecord(raw.timings) ? Object.fromEntries(Object.entries(raw.timings).map(([k, v]) => [k, num(v)])) : {},
	};
}

/**
 * The CLI's cross-check of the task's view of the new slots against its own reading of the input: copies, instance
 * and script counts, and (when the task could hash with SHA-256) the script list hash.
 */
export function compareSlots(task: KernelTaskResult["newSlots"], cli: SlotInventory[], hashMode: string | undefined): string[] {
	const problems: string[] = [];
	for (const want of cli) {
		const got = task.find((s) => s.slot === want.slot);
		if (!got) {
			problems.push(`${want.slot}: the task didn't report it`);
			continue;
		}
		if (got.copies !== 1) problems.push(`${want.slot}: ${got.copies} copies (expected 1)`);
		if (got.instances !== want.instances) problems.push(`${want.slot}: ${got.instances} instances, the kernel build has ${want.instances}`);
		if (got.scripts !== want.scripts) problems.push(`${want.slot}: ${got.scripts} scripts, the kernel build has ${want.scripts}`);
		if (hashMode === "sha256" && got.scriptsHash && got.scriptsHash !== want.scriptsHash) problems.push(`${want.slot}: its script list differs from the kernel build's`);
	}
	return problems;
}

// Errors -------------------------------------------------------------------------------------------------------------

export type SaveFailureKind = "setting" | "team-create" | "unknown";

/**
 * Why SavePlaceAsync failed, with the fix. Roblox's exact error texts are unverified (live test), so the message is
 * matched loosely and always quoted; an unknown one lists every known cause.
 */
export function explainSaveError(message: string, where: { universeId: number; placeId: number }): { kind: SaveFailureKind; text: string } {
	const setting = `turn on "${SAVE_SETTING}" for this place: Creator Hub > Creations > the experience > Places > the place > Permissions (${saveSettingUrl(where.universeId, where.placeId)}). It is per place, and off for places made in Studio`;
	const teamCreate = "an active Team Create session blocks SavePlaceAsync: ask everyone to close the place in Studio (Team Create can stay on), then run again";
	if (/team\s*create|collaborat|active session|session is active|server is busy|busy|409|conflict/i.test(message)) {
		return { kind: "team-create", text: `SavePlaceAsync failed: ${teamCreate}. Roblox said: ${message}` };
	}
	if (/save\s*place\s*api|not\s+(been\s+)?(allowed|enabled|permitted)|permission|forbidden|403|unauthori[sz]ed|not authorized|disabled|not allowed/i.test(message)) {
		return { kind: "setting", text: `SavePlaceAsync failed: ${setting}. Roblox said: ${message}` };
	}
	return {
		kind: "unknown",
		text: `SavePlaceAsync failed: ${message}. Known causes: (1) the place setting is off: ${setting}; (2) ${teamCreate}; (3) the API key's owner can't edit this place (group places: a role with edit and publish rights for the experience)`,
	};
}

/** The fix for a failed task (state FAILED), by Open Cloud's error code. */
export function explainTaskFailure(error: unknown, timeoutSeconds: number): string {
	const code = isRecord(error) ? String(error.code ?? "") : "";
	const message = isRecord(error) ? String(error.message ?? "") : String(error ?? "");
	if (code === "DEADLINE_EXCEEDED") {
		return `the Luau Execution task ran out of time (it had ${timeoutSeconds} s; Roblox allows at most ${TASK_TIMEOUT_MAX} s). A very big place takes long to read twice: run again with --timeout ${TASK_TIMEOUT_MAX}${timeoutSeconds >= TASK_TIMEOUT_MAX ? ", or patch a Studio copy instead (--place-file <file> --base <version>, splice engine)" : ""}`;
	}
	if (code === "OUTPUT_SIZE_LIMIT_EXCEEDED") return `the task's report went over Open Cloud's 4 MB limit (a CLI bug: its lists are capped); ${message}`;
	if (code === "INTERNAL_ERROR") return `Roblox failed the task (INTERNAL_ERROR): run again in a minute. ${message}`;
	if (/non-creatable|not creatable|cannot be created|deserializ/i.test(message)) return `the task couldn't read the kernel slots .rbxm: ${message}`;
	return `the Luau Execution task failed${code ? ` (${code})` : ""}: ${message || "no message"}`;
}
