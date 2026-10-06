/**
 * The pre-publish gate (plans/12 batch D "Pre-publish gate"; spike S9): `typetorch test --cloud`.
 *
 * One Open Cloud Luau Execution task on the place's latest PUBLISHED version (what live servers run):
 *   1. LoadAsset the uploaded payload (the path live servers use) and check it like the kernel's mount does: a payload
 *      root, Folders and ModuleScripts only, `KernelApi` <= the place kernel's, the `Channel` a prod branch needs, the
 *      expected `ArtifactId`;
 *   2. mount its server tree in ServerStorage.TypeTorch.Generations and boot `Server.boot.boot(kernel)` with a stub
 *      kernel (onInit runs inside boot, onStart in spawned threads), within the kernel's READY_TIMEOUT;
 *   3. require every ModuleScript under Shared;
 *   4. run for N seconds while ScriptContext.Error collects every error (spawned threads included);
 *   5. soft stop (the generation's stop function, within the kernel's STOP_DEADLINE), then destroy the tree (scripts
 *      can't be disabled in a task, so the hard stop is emulated); errors from threads that outlive the stop and
 *      instances the generation left behind are reported;
 *   6. (swap) a second generation of a fresh copy boots, runs 1 s and stops, as on a hot swap (persist survives).
 * Place scripts don't run in a task (Roblox docs; verified live), so the place's kernel stays idle; DataStores,
 * MemoryStores and HttpService DO work there, so game code runs against real data: `workspace:GetAttribute(
 * "TypeTorchTest")` is true and the stub kernel has `test = true` for code that must not run in the gate. The stub
 * kernel's effective channel is "dev" whatever the branch (security audit 2026-10-06), so code that splits its stores by
 * `TypeTorch.channel` writes the `_dev` stores, never prod data; the payload's own Channel attribute is still checked
 * against `requireChannel` and reported as the artifact's channel.
 *
 * Failures (exit 1): the load/mount checks, boot errors or a boot that throws or doesn't return, any error while it
 * runs (onInit, onStart, Shared requires, the swap), a stop that throws, times out or logs "onStop threw". Warnings
 * only: errors after the stop (on live servers the hard stop kills those threads), leaked instances, game warnings.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestPublishedVersion } from "./assets.ts";
import { debug, warn } from "./log.ts";
import { withJob } from "./progress.ts";
import { ApiError, type OpenCloud } from "./opencloud.ts";
import { sleep } from "./runtime.ts";
import type { Channel } from "./naming.ts";

export const TESTS_LOG = "tests.jsonl";
export const DEFAULT_TEST_SECONDS = 5;
export const MAX_TEST_SECONDS = 120;
/** A pass of the same asset id this recent is reused by promote/approve instead of a new task. */
export const TEST_REUSE_MS = 24 * 60 * 60 * 1000;
export const LUAU_WRITE_SCOPE = "universe.place.luau-execution-session:write";
export const LUAU_SCOPES = "universe.place.luau-execution-session:read and :write";

export interface GateInput {
	assetId: number;
	/** Expected payload ArtifactId (a mismatch fails). */
	artifactId?: string;
	/** The target branch and its channel (the stub kernel reports them). */
	branch: string;
	channel: Channel;
	/** The payload's Channel attribute must be exactly this (prod-channel branches: "prod", as prod servers require). */
	requireChannel?: Channel;
	seq?: number;
	/** Seconds the first generation runs. */
	seconds: number;
	/** Boot a second generation after the stop (a hot swap). */
	swap: boolean;
	/**
	 * The effective channel the stub kernel reports to the game (`TypeTorch.channel`). Default "dev": the task runs
	 * against the real DataStores and MessagingService, so channel-split stores must point at dev data even when the
	 * branch is prod. Tests only.
	 */
	stubChannel?: Channel;
}

/** The stub kernel's channel unless the input says otherwise. */
export const STUB_CHANNEL: Channel = "dev";

export class GateError extends Error {
	override name = "GateError";
}

/** The Luau Execution task script. The input travels as JSON in a long bracket string (no Luau code is built from it). */
export function gateScript(input: GateInput): string {
	const config = JSON.stringify({
		assetId: input.assetId,
		artifactId: input.artifactId ?? null,
		branch: input.branch,
		channel: input.channel,
		requireChannel: input.requireChannel ?? null,
		seq: input.seq ?? null,
		seconds: input.seconds,
		swap: input.swap,
		stubChannel: input.stubChannel ?? STUB_CHANNEL,
	});
	if (config.includes("]==]")) throw new GateError("the test input can't be embedded in the task script");
	return GATE_SCRIPT.replace("__CONFIG__", () => config);
}

// The task script. Plain Luau strings only (no backticks: this is a TypeScript template literal).
const GATE_SCRIPT = String.raw`--!nonstrict
local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ScriptContext = game:GetService("ScriptContext")
local ServerScriptService = game:GetService("ServerScriptService")
local ServerStorage = game:GetService("ServerStorage")

local CONFIG = HttpService:JSONDecode([==[__CONFIG__]==])
local result = { v = 1, events = {}, warnings = {}, output = {}, generations = {}, leaks = {}, errorCount = 0, warningCount = 0 }
local phase = "load"
local MAX_EVENTS = 100

local function clip(value, size)
	local text = tostring(value)
	if #text > size then
		return string.sub(text, 1, size) .. "..."
	end
	return text
end

ScriptContext.Error:Connect(function(message, trace)
	result.errorCount += 1
	if #result.events < MAX_EVENTS then
		table.insert(result.events, { p = phase, m = clip(message, 1000), tr = clip(trace or "", 1200) })
	end
end)
LogService.MessageOut:Connect(function(message, kind)
	if kind == Enum.MessageType.MessageWarning then
		result.warningCount += 1
		if #result.warnings < MAX_EVENTS then
			table.insert(result.warnings, { p = phase, m = clip(message, 600) })
		end
	end
	if kind ~= Enum.MessageType.MessageError then
		table.insert(result.output, clip(message, 300))
		if #result.output > 40 then
			table.remove(result.output, 1)
		end
	end
end)

-- The place's kernel (read only: its scripts don't run in a task).
local constants = {}
local kernelShared = ReplicatedStorage:FindFirstChild("TypeTorchKernelShared")
if kernelShared and kernelShared:FindFirstChild("Constants") then
	local ok, value = pcall(require, kernelShared.Constants)
	if ok and typeof(value) == "table" then
		constants = value
	end
end
local kernelFolder = ServerScriptService:FindFirstChild("TypeTorchKernel")
local KERNEL_API = constants.KERNEL_API or 1
local STOP_DEADLINE = constants.STOP_DEADLINE or 5
local READY_TIMEOUT = constants.READY_TIMEOUT or 20
result.kernel = {
	present = kernelFolder ~= nil,
	version = constants.KERNEL_VERSION,
	api = KERNEL_API,
	build = kernelFolder and kernelFolder:GetAttribute("KernelCommit") or nil,
}
result.placeVersion = game.PlaceVersion
result.limits = { stop = STOP_DEADLINE, ready = READY_TIMEOUT }
workspace:SetAttribute("TypeTorchTest", true)

local function findPayloadRoot(container)
	if container:FindFirstChild("Server") and container:FindFirstChild("Client") then
		return container
	end
	for _, descendant in container:GetDescendants() do
		if descendant:IsA("Model") and descendant:FindFirstChild("Server") and descendant:FindFirstChild("Client") then
			return descendant
		end
	end
	return nil
end

local function loadPayload()
	local started = os.clock()
	local ok, container = pcall(InsertService.LoadAsset, InsertService, CONFIG.assetId)
	if not ok then
		error("LoadAsset(" .. tostring(CONFIG.assetId) .. ") failed: " .. tostring(container), 0)
	end
	local payload = findPayloadRoot(container)
	if not payload then
		error("asset " .. tostring(CONFIG.assetId) .. " has no payload root (Server/Shared/Client/include)", 0)
	end
	return payload, os.clock() - started
end

-- The kernel's mount checks (Kernel.server.luau mount), as failures.
local function checkPayload(payload)
	local problems = {}
	local artifactId = payload:GetAttribute("ArtifactId")
	if CONFIG.artifactId ~= nil and artifactId ~= CONFIG.artifactId then
		table.insert(problems, "the payload is artifact " .. tostring(artifactId) .. ", expected " .. CONFIG.artifactId)
	end
	local payloadChannel = payload:GetAttribute("Channel")
	if CONFIG.requireChannel ~= nil and payloadChannel ~= CONFIG.requireChannel then
		table.insert(problems, "the payload is " .. tostring(payloadChannel) .. "-channel; " .. CONFIG.branch .. " servers only take " .. CONFIG.requireChannel)
	end
	local others = {}
	for _, descendant in payload:GetDescendants() do
		if not descendant:IsA("ModuleScript") and descendant.ClassName ~= "Folder" then
			table.insert(others, descendant:GetFullName() .. " (" .. descendant.ClassName .. ")")
			if #others >= 5 then
				break
			end
		end
	end
	if #others > 0 then
		table.insert(problems, "the payload holds more than Folders and ModuleScripts: " .. table.concat(others, ", "))
	end
	local needsApi = payload:GetAttribute("KernelApi") or 1
	if typeof(needsApi) == "number" and needsApi > KERNEL_API then
		table.insert(problems, "the payload needs kernel API " .. needsApi .. "; the place's kernel is " .. KERNEL_API)
	end
	for _, part in { "Server", "Shared", "Client", "include" } do
		if not payload:FindFirstChild(part) then
			table.insert(problems, "the payload has no " .. part)
		end
	end
	local server = payload:FindFirstChild("Server")
	local boot = server and server:FindFirstChild("boot")
	if server and not (boot and boot:IsA("ModuleScript")) then
		table.insert(problems, "the payload has no Server.boot ModuleScript")
	end
	result.payload = {
		artifactId = artifactId,
		channel = payloadChannel,
		kernelApi = needsApi,
		commit = payload:GetAttribute("Commit"),
	}
	return problems
end

local storage = ServerStorage:FindFirstChild("TypeTorch") or Instance.new("Folder")
storage.Name = "TypeTorch"
storage.Parent = ServerStorage
local generationsFolder = storage:FindFirstChild("Generations") or Instance.new("Folder")
generationsFolder.Name = "Generations"
generationsFolder.Parent = storage

-- Instances a generation adds outside its own tree (leaks once it stopped).
local tracking = false
local added = setmetatable({}, { __mode = "k" })
local watched = { "Workspace", "ReplicatedStorage", "ReplicatedFirst", "ServerStorage", "ServerScriptService", "Lighting", "StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Teams" }
for _, name in watched do
	local ok, service = pcall(game.GetService, game, name)
	if ok and service then
		service.DescendantAdded:Connect(function(instance)
			if tracking and not instance:IsDescendantOf(generationsFolder) then
				added[instance] = true
			end
		end)
	end
end
local function collectLeaks()
	local list, total = {}, 0
	for instance in added do
		if instance:IsDescendantOf(game) and not added[instance.Parent] then
			total += 1
			if #list < 20 then
				table.insert(list, instance:GetFullName() .. " (" .. instance.ClassName .. ")")
			end
		end
	end
	table.clear(added)
	return list, total
end

local persistStore = {}
local function makeKernel(number, artifact, start)
	local handlers = {}
	local startedAt = os.time()
	local api = {
		kernelApi = KERNEL_API,
		kernelVersion = constants.KERNEL_VERSION or "test",
		kernelBuild = result.kernel.build,
		artifact = table.clone(artifact),
		generation = number,
		branch = CONFIG.branch,
		-- The effective channel is "dev" (CONFIG.stubChannel) whatever the branch: the task touches real stores.
		channel = CONFIG.stubChannel,
		serverType = if CONFIG.stubChannel == "prod" then "public" else "reserved",
		start = start,
		test = true,
	}
	local refused = { ok = false, error = "not available in typetorch test --cloud" }
	function api:persist(key, init)
		local value = persistStore[key]
		if value == nil then
			value = init()
			persistStore[key] = value
		end
		return value
	end
	function api:isDev()
		return false
	end
	function api:devInfo()
		return { dev = false, reason = "none" }
	end
	function api:onMessage(fn)
		handlers.message = fn
	end
	function api:send() end
	function api:broadcast() end
	function api:sendUnreliable() end
	function api:broadcastUnreliable() end
	function api:status()
		return {
			jobId = game.JobId,
			placeId = game.PlaceId,
			placeVersion = game.PlaceVersion,
			serverType = api.serverType,
			branch = CONFIG.branch,
			channel = CONFIG.stubChannel,
			startedAt = startedAt,
			uptime = os.time() - startedAt,
			generation = { name = artifact.id .. "#" .. number, number = number, startedAt = startedAt, uptime = os.time() - startedAt, artifact = table.clone(artifact) },
			history = {},
			players = #Players:GetPlayers(),
			maxPlayers = Players.MaxPlayers,
			kernelVersion = api.kernelVersion,
			kernelApi = KERNEL_API,
			memoryMb = 0,
			luaHeapKb = 0,
			appliedSeq = CONFIG.seq or 0,
		}
	end
	function api:logs()
		return {}
	end
	function api:branches()
		return {}
	end
	function api:artifacts()
		return {}
	end
	function api:reload()
		return refused
	end
	function api:rollback()
		return refused
	end
	function api:switchBranch()
		return refused
	end
	function api:newServer()
		return refused
	end
	function api:pinArtifact()
		return refused
	end
	function api:requestReload()
		return refused
	end
	function api:unpin()
		return refused
	end
	function api:pinned()
		return false
	end
	function api:onPending(fn)
		handlers.pending = fn
	end
	function api:onDevChanged(fn)
		handlers.dev = fn
	end
	function api:experiment()
		return nil
	end
	function api:keys()
		return {
			loaded = false,
			mode = "none",
			reads = 0,
			publicKeys = {},
			revokedKeys = {},
			trusted = 0,
			changes = 0,
			signedOnly = CONFIG.stubChannel == "prod",
			rejected = { total = 0, byKind = {} },
			refusals = {},
		}
	end
	return api
end

local count = 0
local function mount(payload)
	count += 1
	local artifactId = payload:GetAttribute("ArtifactId") or ("asset-" .. tostring(CONFIG.assetId))
	local tree = Instance.new("Folder")
	tree.Name = artifactId .. "#" .. count
	local artifact = {
		id = artifactId,
		assetId = CONFIG.assetId,
		channel = payload:GetAttribute("Channel") or CONFIG.channel,
		branch = CONFIG.branch,
		commit = payload:GetAttribute("Commit"),
		builtAt = payload:GetAttribute("BuiltAt"),
		seq = CONFIG.seq,
	}
	tree:SetAttribute("ArtifactId", artifactId)
	for name, value in { AssetId = artifact.assetId, Commit = artifact.commit, Branch = artifact.branch, Channel = artifact.channel, BuiltAt = artifact.builtAt, Seq = artifact.seq } do
		local kind = typeof(value)
		if kind == "string" or kind == "number" or kind == "boolean" then
			tree:SetAttribute(name, value)
		end
	end
	payload.Server.Parent = tree
	payload.Shared.Parent = tree
	payload.include.Parent = tree
	tree.Parent = generationsFolder
	return tree, artifact
end

-- Runs fn in its own thread for at most limit seconds: done, ok, value, seconds.
local function within(limit, fn)
	local done, ok, value = false, true, nil
	local started = os.clock()
	local thread = task.spawn(function()
		ok, value = pcall(fn)
		done = true
	end)
	while not done and os.clock() - started < limit do
		task.wait()
	end
	if not done then
		pcall(task.cancel, thread)
	end
	return done, ok, value, os.clock() - started
end

local function runGeneration(number, payload, loadSeconds, runSeconds, prefix, previous)
	local generation = { n = number, load = loadSeconds }
	table.insert(result.generations, generation)
	local tree, artifact = mount(payload)
	local start = if previous
		then { kind = "swap", reason = "deploy", previous = { artifact = previous, branch = CONFIG.branch, channel = CONFIG.stubChannel, generation = number - 1 }, branchChanged = false, startedAt = os.time(), loadSeconds = loadSeconds }
		else { kind = "boot", reason = "boot", branchChanged = false, startedAt = os.time(), loadSeconds = loadSeconds }
	local kernel = makeKernel(number, artifact, start)

	tracking = true
	phase = prefix .. "boot"
	local done, ok, stop, seconds = within(READY_TIMEOUT, function()
		local boot = require(tree.Server.boot)
		local stopFn = boot.boot(kernel)
		assert(typeof(stopFn) == "function", "Server.boot.boot(kernel) must return a stop function")
		return stopFn
	end)
	generation.boot = seconds
	if not done then
		generation.bootError = "Server.boot.boot(kernel) didn't return within " .. READY_TIMEOUT .. " s (the kernel would give up on this generation)"
	elseif not ok then
		generation.bootError = clip(stop, 1500)
	end
	if generation.bootError then
		tracking = false
		tree:Destroy()
		return generation, artifact, false
	end

	if number == 1 then
		phase = "shared"
		local modules = {}
		for _, descendant in tree.Shared:GetDescendants() do
			if descendant:IsA("ModuleScript") then
				table.insert(modules, descendant)
			end
		end
		local pending, failures, started = #modules, {}, os.clock()
		local finished = {}
		for _, module in modules do
			task.spawn(function()
				local okRequire, err = pcall(require, module)
				finished[module] = true
				if not okRequire then
					table.insert(failures, { m = module:GetFullName(), e = clip(err, 1000) })
				end
				pending -= 1
			end)
		end
		while pending > 0 and os.clock() - started < 5 do
			task.wait()
		end
		for _, module in modules do
			if not finished[module] then
				table.insert(failures, { m = module:GetFullName(), e = "require didn't return within 5 s (infinite yield?)" })
			end
		end
		result.shared = { modules = #modules, failures = failures, seconds = os.clock() - started }
	end

	phase = prefix .. "run"
	task.wait(runSeconds)
	generation.run = runSeconds

	phase = prefix .. "stop"
	local stopDone, stopOk, stopErr, stopSeconds = within(STOP_DEADLINE, function()
		stop({ reason = "deploy", branch = CONFIG.branch, next = { id = artifact.id, assetId = CONFIG.assetId, branch = CONFIG.branch, channel = artifact.channel } })
	end)
	generation.stop = stopSeconds
	if not stopDone then
		generation.stopError = "the stop function took more than " .. STOP_DEADLINE .. " s (the kernel cancels it and hard-stops)"
	elseif not stopOk then
		generation.stopError = clip(stopErr, 1500)
	end
	-- The hard stop: live servers disable the Entry clone (killing its threads), then destroy the tree.
	tree:Destroy()
	tracking = false
	phase = prefix .. "after-stop"
	task.wait(if prefix == "" and CONFIG.swap then 0.5 else 1)
	local leaks, total = collectLeaks()
	generation.leaks = leaks
	generation.leakCount = total
	return generation, artifact, true
end

local started = os.clock()
local ok, err = pcall(function()
	local payload, loadSeconds = loadPayload()
	phase = "mount"
	local problems = checkPayload(payload)
	if #problems > 0 then
		result.checks = problems
		return
	end
	local _, artifact, booted = runGeneration(1, payload, loadSeconds, CONFIG.seconds, "", nil)
	if booted and CONFIG.swap then
		phase = "swap-load"
		local second, secondLoad = loadPayload()
		runGeneration(2, second, secondLoad, 1, "swap-", artifact)
	end
end)
if not ok then
	result.fatal = clip(err, 1500)
end
result.seconds = os.clock() - started
result.phase = phase
return result
`;

// Parsing and classification -----------------------------------------------------------------------------------------

export interface GateEvent {
	phase: string;
	message: string;
	trace?: string;
}

export interface GateGeneration {
	n: number;
	load?: number;
	boot?: number;
	run?: number;
	stop?: number;
	bootError?: string;
	stopError?: string;
	leaks: string[];
	leakCount: number;
}

export interface GateRaw {
	fatal?: string;
	checks: string[];
	events: GateEvent[];
	warnings: GateEvent[];
	errorCount: number;
	warningCount: number;
	output: string[];
	generations: GateGeneration[];
	shared?: { modules: number; failures: { module: string; error: string }[]; seconds: number };
	kernel?: { present: boolean; version?: string; api?: number; build?: string };
	payload?: { artifactId?: string; channel?: string; kernelApi?: number; commit?: string };
	placeVersion?: number;
	limits?: { stop: number; ready: number };
	seconds?: number;
	phase?: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The task's return value, checked (anything missing becomes empty; an unusable value throws). */
export function parseGate(results: unknown[]): GateRaw {
	const value = results[0];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GateError(`the test task returned ${JSON.stringify(results).slice(0, 300)}, not a result table`);
	}
	const r = value as Record<string, any>;
	const event = (e: any): GateEvent => ({ phase: str(e?.p) ?? "?", message: str(e?.m) ?? String(e?.m ?? ""), ...(str(e?.tr) ? { trace: e.tr } : {}) });
	return {
		...(str(r.fatal) ? { fatal: r.fatal } : {}),
		checks: list(r.checks).map(String),
		events: list(r.events).map(event),
		warnings: list(r.warnings).map(event),
		errorCount: num(r.errorCount) ?? 0,
		warningCount: num(r.warningCount) ?? 0,
		output: list(r.output).map(String),
		generations: list(r.generations).map((g: any) => ({
			n: num(g?.n) ?? 0,
			load: num(g?.load),
			boot: num(g?.boot),
			run: num(g?.run),
			stop: num(g?.stop),
			...(str(g?.bootError) ? { bootError: g.bootError } : {}),
			...(str(g?.stopError) ? { stopError: g.stopError } : {}),
			leaks: list(g?.leaks).map(String),
			leakCount: num(g?.leakCount) ?? 0,
		})),
		...(r.shared && typeof r.shared === "object"
			? {
					shared: {
						modules: num(r.shared.modules) ?? 0,
						failures: list(r.shared.failures).map((f: any) => ({ module: str(f?.m) ?? "?", error: str(f?.e) ?? "" })),
						seconds: num(r.shared.seconds) ?? 0,
					},
				}
			: {}),
		...(r.kernel && typeof r.kernel === "object" ? { kernel: { present: r.kernel.present === true, version: str(r.kernel.version), api: num(r.kernel.api), build: str(r.kernel.build) } } : {}),
		...(r.payload && typeof r.payload === "object"
			? { payload: { artifactId: str(r.payload.artifactId), channel: str(r.payload.channel), kernelApi: num(r.payload.kernelApi), commit: str(r.payload.commit) } }
			: {}),
		placeVersion: num(r.placeVersion),
		...(r.limits && typeof r.limits === "object" ? { limits: { stop: num(r.limits.stop) ?? 5, ready: num(r.limits.ready) ?? 20 } } : {}),
		seconds: num(r.seconds),
		phase: str(r.phase),
	};
}

export interface GateProblem {
	/** load, mount, boot, shared, run, stop, swap-boot, swap-run, swap-stop, task */
	phase: string;
	message: string;
	trace?: string;
	/** How often the same message came up. */
	count: number;
}

export interface GateVerdict {
	ok: boolean;
	problems: GateProblem[];
	warnings: GateProblem[];
}

/** A generation's tree name in messages (`<artifact>#1`, `#2`) doesn't split a group. */
function normalize(message: string): string {
	return message.replace(/(Generations\.[^.\s#]+)#\d+/g, "$1#n").trim();
}

function group(items: { phase: string; message: string; trace?: string }[]): GateProblem[] {
	const groups = new Map<string, GateProblem>();
	for (const item of items) {
		const key = `${item.phase}\n${normalize(item.message)}`;
		const existing = groups.get(key);
		if (existing) existing.count++;
		else groups.set(key, { phase: item.phase, message: item.message, ...(item.trace ? { trace: item.trace } : {}), count: 1 });
	}
	return [...groups.values()];
}

const STOP_WARNING = /onStop threw|stop threw/i;

/** Pass or fail, and why (see the module comment). */
export function judgeGate(raw: GateRaw): GateVerdict {
	const problems: { phase: string; message: string; trace?: string }[] = [];
	const warnings: { phase: string; message: string; trace?: string }[] = [];
	if (raw.fatal) problems.push({ phase: raw.phase ?? "load", message: raw.fatal });
	for (const check of raw.checks) problems.push({ phase: "mount", message: check });
	for (const g of raw.generations) {
		const prefix = g.n > 1 ? "swap-" : "";
		if (g.bootError) problems.push({ phase: `${prefix}boot`, message: g.bootError });
		if (g.stopError) problems.push({ phase: `${prefix}stop`, message: g.stopError });
		if (g.leakCount > 0) {
			warnings.push({ phase: `${prefix}after-stop`, message: `${g.leakCount} instance(s) the generation created are still there after its stop: ${g.leaks.join(", ")}${g.leakCount > g.leaks.length ? ", ..." : ""}` });
		}
	}
	for (const failure of raw.shared?.failures ?? []) problems.push({ phase: "shared", message: `require ${failure.module}: ${failure.error}` });
	for (const event of raw.events) {
		if (event.phase.endsWith("after-stop")) {
			warnings.push({ ...event, message: `after the stop (a thread the soft stop didn't end; live servers' hard stop kills it): ${event.message}` });
		} else problems.push(event);
	}
	if (raw.errorCount > raw.events.length) problems.push({ phase: "run", message: `${raw.errorCount - raw.events.length} more error(s) not listed` });
	for (const w of raw.warnings) {
		if (STOP_WARNING.test(w.message) && w.phase.endsWith("stop") && !w.phase.endsWith("after-stop")) problems.push(w);
		else warnings.push(w);
	}
	return { ok: problems.length === 0, problems: group(problems), warnings: group(warnings) };
}

// Running it ------------------------------------------------------------------------------------------------------------

export interface GateRun {
	ok: boolean;
	verdict: GateVerdict;
	raw?: GateRaw;
	input: GateInput;
	placeVersion?: number;
	/** How the version was chosen. */
	base: "latest published" | "latest (version list not readable)";
	taskPath?: string;
	/** Wall time of the whole gate (version lookup, task, polling). */
	seconds: number;
}

export interface GateClient {
	placeVersions: OpenCloud["placeVersions"];
	runLuau: OpenCloud["runLuau"];
}

/** Runs the gate: the latest published place version, one task, the verdict. Throws GateError for setup problems. */
export async function runGate(oc: GateClient, place: { universeId: number; placeId: number }, input: GateInput, options: { onWait?: (text: string) => void } = {}): Promise<GateRun> {
	return withJob(`cloud test of asset ${input.assetId}`, () => gate(oc, place, input, options));
}

async function gate(oc: GateClient, place: { universeId: number; placeId: number }, input: GateInput, options: { onWait?: (text: string) => void }): Promise<GateRun> {
	const started = performance.now();
	let placeVersion: number | undefined;
	let base: GateRun["base"] = "latest published";
	try {
		placeVersion = latestPublishedVersion(await oc.placeVersions(place.placeId, 1)).version;
	} catch (error) {
		// The gate still means something on the newest saved version; say so.
		base = "latest (version list not readable)";
		warn(`can't list the place's versions (${(error as Error).message.slice(0, 200)}); testing on its latest version instead of the latest published one (the assets key needs asset:read on the place)`);
	}
	const timeout = Math.min(300, 90 + input.seconds);
	let run: Awaited<ReturnType<OpenCloud["runLuau"]>> | undefined;
	for (let attempt = 1; ; attempt++) {
		try {
			run = await oc.runLuau(place.universeId, place.placeId, gateScript(input), timeout, placeVersion !== undefined ? { version: placeVersion } : {});
			break;
		} catch (error) {
			if (error instanceof ApiError && error.isScopeError) {
				throw new GateError(`creating the Luau Execution task was refused (${error.status}): the assets key (OPENCLOUD_ASSETS_KEY or the shared key) needs ${LUAU_SCOPES}`);
			}
			if (error instanceof ApiError && error.status === 429 && attempt < 4) {
				options.onWait?.("Luau Execution allows 5 task creations per minute per key owner; waiting 15 s");
				await sleep(15_000);
				continue;
			}
			throw error;
		}
	}
	const seconds = Math.round(performance.now() - started) / 1000;
	if (run.state !== "COMPLETE") {
		const message = `the test task ended ${run.state}${run.error ? `: ${JSON.stringify(run.error).slice(0, 1500)}` : ""}`;
		return { ok: false, verdict: { ok: false, problems: [{ phase: "task", message, count: 1 }], warnings: [] }, input, placeVersion, base, taskPath: run.path, seconds };
	}
	const raw = parseGate(run.results);
	debug(`test task ${run.path}: ${raw.seconds?.toFixed(2)} s inside`);
	const verdict = judgeGate(raw);
	return { ok: verdict.ok, verdict, raw, input, placeVersion: raw.placeVersion ?? placeVersion, base, taskPath: run.path, seconds };
}

// Records ---------------------------------------------------------------------------------------------------------------

/** What a release logs about its gate (deployments.jsonl `test`, proposals). */
export type TestSummary =
	| { ok: true; at: string; seconds: number; placeVersion?: number; warnings?: number; reused?: boolean }
	| { ok: false; at: string; seconds: number; problems: number }
	| { skipped: string; at: string; by?: string };

export interface TestRecord {
	at: string;
	universeId: number;
	assetId: number;
	artifactId?: string;
	branch: string;
	channel: Channel;
	ok: boolean;
	seconds: number;
	placeVersion?: number;
	problems: number;
	warnings: number;
	task?: string;
	/** What ran it: test, deploy, promote, approve... */
	via: string;
}

export function appendTestRecord(dir: string, record: Omit<TestRecord, "at">): TestRecord {
	const full: TestRecord = { at: new Date().toISOString(), ...record };
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, TESTS_LOG), JSON.stringify(full) + "\n");
	return full;
}

export function readTestRecords(dir: string, universeId?: number): TestRecord[] {
	const file = join(dir, TESTS_LOG);
	if (!existsSync(file)) return [];
	const out: TestRecord[] = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (typeof entry?.assetId === "number" && typeof entry?.ok === "boolean" && (universeId === undefined || entry.universeId === universeId)) out.push(entry);
		} catch {}
	}
	return out;
}

/** The newest passing gate of this asset within `maxAgeMs` (the same bytes: an asset id never changes content). */
export function recentPass(records: TestRecord[], assetId: number, now = Date.now(), maxAgeMs = TEST_REUSE_MS): TestRecord | undefined {
	return [...records].reverse().find((r) => r.assetId === assetId && r.ok && now - Date.parse(r.at) <= maxAgeMs);
}

export function summaryFor(run: GateRun): TestSummary {
	const at = new Date().toISOString();
	return run.ok
		? { ok: true, at, seconds: run.seconds, ...(run.placeVersion !== undefined ? { placeVersion: run.placeVersion } : {}), ...(run.verdict.warnings.length ? { warnings: run.verdict.warnings.length } : {}) }
		: { ok: false, at, seconds: run.seconds, problems: run.verdict.problems.length };
}

/** When a release runs the gate (plans/12 "Pre-publish gate"). */
export type GatePolicy = { run: true; why: string } | { run: false; why: string };

export function gatePolicy(input: { kind: "deploy" | "promote" | "rollback" | "resign"; branchChannel: Channel; test: boolean; skipTest?: string }): GatePolicy {
	if (input.skipTest !== undefined) return { run: false, why: `skipped: ${input.skipTest}` };
	if (input.kind === "resign") return { run: false, why: "a re-sign republishes the live artifact" };
	if (input.test) return { run: true, why: "--test" };
	if (input.branchChannel === "prod" && input.kind !== "rollback") return { run: true, why: "always on for prod-channel branches" };
	if (input.branchChannel === "prod") return { run: false, why: "rollbacks to an earlier prod build skip it (add --test)" };
	return { run: false, why: "off for dev-channel branches (add --test)" };
}

/** `--skip-test "<reason>"`: a reason of a few words is required (it goes into the deploy log). */
export function skipReason(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const reason = value.trim().replace(/\s+/g, " ");
	if (reason.length < 3) throw new GateError(`--skip-test needs a reason (it goes into the deploy log), e.g. --skip-test "hotfix, tested in Studio"`);
	return reason.slice(0, 200);
}
