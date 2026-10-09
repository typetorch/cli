/**
 * The kernel as an uploaded asset (kernel 0.4.1 loader; plans/22). The place holds a small loader (installed once with
 * the luau engine); kernel updates are uploads plus one signed pointer in the settings record.
 *
 *   typetorch kernel install-loader   the luau engine: ServerScriptService.TypeTorchLoader (with the trust roots),
 *                                     ReplicatedFirst.TypeTorchLoaderClient, ServerStorage.TypeTorchKernelBaked (the
 *                                     fallback kernel) and the backup build go in; every copy of the kernel installed
 *                                     directly goes out (the task's remove mode). Run it again to refresh them.
 *   typetorch kernel deploy --asset   build the kernel PACKAGE (kernelasset.ts), upload it as a new version of the
 *     [--channel dev|prod]            group-owned kernel asset (typetorch.json kernelAssetId; the first time a new asset),
 *     [--reupload] [--new-asset]      wait for moderation, resolve and check the version in a Luau Execution task, then
 *     [--drain <min>]                 sign the pointer `kernel.<channel>` (prod sets dev too). --reupload sends the kept
 *                                     package of the channel's current kernel again (moderation took it down);
 *                                     --new-asset makes a new asset id (the old one is gone).
 *   typetorch kernel promote          dev's pointer to prod; refused unless the dev kernel is proven healthy (live >= 1 h,
 *     [--force] [--drain <min>]       servers ran it, no failed or rolled back deploy report from it)
 *   typetorch kernel rollback         a channel's pointer back to its previous kernel (this machine's log), or --to
 *     [--channel] [--to <v>]
 *   typetorch kernel drain            the signed drain message for a channel's kernel: public servers on another kernel
 *     [--channel] [--window <min>]    move their players to fresh servers within the window (kernel Drain.luau)
 *
 * Every pointer write is a signed settings record (both prod keys) and a ping; nothing restarts by itself (--drain is
 * opt-in). Records go to kernel-deploys.jsonl. Scopes: the assets key (asset:read/write, Luau Execution for the resolve
 * task), the deploy key (DataStores for the settings record, messaging for the ping and the drain).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { OUT_DIR, rojoBinary } from "../build.ts";
import { updateProjectConfig, type Project } from "../config.ts";
import { formatCounts, type FleetClient } from "../fleet.ts";
import { interaction } from "../interact.ts";
import { isRecord, parseJsonc } from "../json.ts";
import { BAKED_FOLDER, bakedSlotNode, LOADER_API, PACKAGE_ROOT, PACKAGE_SLOTS, packageProject, pointerOf, promoted, TRUST_ROOTS, withPointer, type KernelChannel, type KernelPointer } from "../kernelasset.ts";
import { luauDeploy, type LuauDeps } from "../kernel-luau.ts";
import { settingValues, SLOTS_ROOT } from "../kernelpatch-task.ts";
import { kernelLayout } from "../kernelpatch.ts";
import { bold, dim, emitJson, formatBytes, info, isJson, Stopwatch, warn } from "../log.ts";
import { DEPLOY_TOPIC, type OpenCloud } from "../opencloud.ts";
import { BACKUP_SLOT } from "../payloads.ts";
import type { SlotRef } from "../placepatch.ts";
import { run } from "../proc.ts";
import { readRbxm } from "../rbxm.ts";
import { readSettings, type SettingsBody } from "../settings.ts";
import { signCanonical, type DualSigner } from "../signing.ts";
import { openCloud, project, projectStateDir } from "./common.ts";
import { fleetFor } from "./fleet.ts";
import { absolutePaths, buildSlotsRbxm, KERNEL_LOG, KernelCheckError, luauDeps, prepareKernel, taskTimeout, type PreparedKernel } from "./kernel.ts";
import { changeSettings, reportChange, settingsSigner } from "./settings.ts";

export const PACKAGE_FILE = `${OUT_DIR}/kernel-package.rbxm`;
export const LOADER_SLOTS_FILE = `${OUT_DIR}/loader-slots.rbxm`;
export const LOADER_SLOT: SlotRef = { service: "ServerScriptService", name: "TypeTorchLoader" };
export const LOADER_CLIENT_SLOT: SlotRef = { service: "ReplicatedFirst", name: "TypeTorchLoaderClient" };
export const BAKED_SLOT: SlotRef = { service: "ServerStorage", name: BAKED_FOLDER };
/** Kernel packages kept at upload (for --reupload and the baked kernel of `backup refresh`). */
export const KERNELS_DIR = "kernels";
/** The first kernel the loader can run; the loader's default MinKernelVersion. */
export const MIN_LOADER_KERNEL = "0.4.1";
/** `kernel promote`: the dev kernel must have run this long without a failure. */
export const PROMOTE_HOURS = 1;
export const DRAIN_TAG = "tt1drain";
const MESSAGE_LIMIT = 1024;

// Kept packages ---------------------------------------------------------------------------------------------------------

export function keptKernelPath(stateDir: string, version: string, hash: string): string {
	return join(stateDir, KERNELS_DIR, `${version.replace(/[^A-Za-z0-9._-]/g, "_")}-${hash.slice(0, 12)}.rbxm`);
}

export function keepKernel(stateDir: string, version: string, hash: string, bytes: Uint8Array): string {
	mkdirSync(join(stateDir, KERNELS_DIR), { recursive: true });
	const path = keptKernelPath(stateDir, version, hash);
	writeFileSync(path, bytes);
	return path;
}

export function findKeptKernel(stateDir: string, version: string, hash: string): string | undefined {
	const path = keptKernelPath(stateDir, version, hash);
	return existsSync(path) ? path : undefined;
}

/** The package's root attributes, read back with the CLI's own reader (the upload must be what was built). */
export function packageIdentity(bytes: Uint8Array): { version?: string; hash?: string; slots: string[] } {
	const instances = readRbxm(bytes);
	const byRef = new Map(instances.map((i) => [i.referent, i]));
	const root = instances.find((i) => i.parent === -1 || !byRef.has(i.parent));
	if (!root || root.className !== "Model" || root.name !== PACKAGE_ROOT) throw new Error(`the kernel package must be one Model ${PACKAGE_ROOT}`);
	const slots: string[] = [];
	for (const slot of PACKAGE_SLOTS) {
		const service = instances.find((i) => i.parent === root.referent && i.name === slot.service);
		if (service && instances.some((i) => i.parent === service.referent && i.name === slot.name)) slots.push(`${slot.service}.${slot.name}`);
	}
	return { version: typeof root.attributes?.KernelVersion === "string" ? root.attributes.KernelVersion : undefined, hash: typeof root.attributes?.KernelHash === "string" ? root.attributes.KernelHash : undefined, slots };
}

// The resolve task -------------------------------------------------------------------------------------------------------

/**
 * Finds the asset version the upload made (GetLatestAssetVersionAsync, retried until the served version carries the
 * uploaded KernelHash: the lookup lags a PATCH by about a second, S13) and checks it the way the loader does (one Model,
 * the three slots, the Kernel script, every Script/LocalScript disabled, only Folders and scripts, no trust roots).
 * Read-only. Returns { versionId (decimal string), hash, problems, error?, tries }.
 */
export function kernelResolveScript(assetId: number, hash: string, waitSeconds = 60): string {
	if (!Number.isSafeInteger(assetId) || assetId <= 0 || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("bad kernel resolve input");
	const trust = TRUST_ROOTS.map((name) => `"${name}"`).join(", ");
	const slots = PACKAGE_SLOTS.map((slot) => `{ "${slot.service}", "${slot.name}" }`).join(", ");
	return `-- TypeTorch: typetorch kernel deploy --asset (resolve and check the uploaded kernel version). Read-only.
local InsertService = game:GetService("InsertService")
local ID, HASH, WAIT = ${assetId}, "${hash}", ${waitSeconds}
local TRUST = { ${trust} }
local SLOTS = { ${slots} }
local ALLOWED = { Folder = true, Script = true, LocalScript = true, ModuleScript = true }
local result = { tries = 0, problems = {} }

local function check(root)
	local problems = {}
	if root == nil or root.ClassName ~= "Model" then
		table.insert(problems, "the asset is not one Model")
		return problems
	end
	for _, slot in SLOTS do
		local holder = root:FindFirstChild(slot[1])
		if not (holder and holder:FindFirstChild(slot[2])) then
			table.insert(problems, "no " .. slot[1] .. "." .. slot[2])
		end
	end
	local scripts = root:FindFirstChild("ServerScriptService")
	local kernel = scripts and scripts:FindFirstChild("TypeTorchKernel")
	if kernel and not kernel:FindFirstChild("Kernel") then
		table.insert(problems, "the kernel folder has no Kernel script")
	end
	for _, descendant in root:GetDescendants() do
		if not ALLOWED[descendant.ClassName] then
			table.insert(problems, "holds a " .. descendant.ClassName .. " (" .. descendant:GetFullName() .. ")")
			break
		end
		if (descendant.ClassName == "Script" or descendant.ClassName == "LocalScript") and descendant.Disabled ~= true then
			table.insert(problems, descendant:GetFullName() .. " is not disabled")
			break
		end
	end
	if kernel then
		for _, name in TRUST do
			local value = kernel:GetAttribute(name)
			if value ~= nil and value ~= "" then
				table.insert(problems, "carries the trust root " .. name)
				break
			end
		end
	end
	return problems
end

local deadline = os.clock() + WAIT
while true do
	result.tries += 1
	local ok, version = pcall(function()
		return InsertService:GetLatestAssetVersionAsync(ID)
	end)
	if ok and typeof(version) == "number" then
		result.versionId = string.format("%d", version)
		local loaded, container = pcall(function()
			return InsertService:LoadAssetVersion(version)
		end)
		if loaded then
			local root = container:FindFirstChild("${PACKAGE_ROOT}") or (if container:GetAttribute("KernelHash") ~= nil then container else nil)
			result.hash = if root then root:GetAttribute("KernelHash") else nil
			result.problems = check(root)
			result.error = nil
			container:Destroy()
		else
			result.error = "LoadAssetVersion(" .. result.versionId .. "): " .. tostring(container)
		end
	else
		result.error = "GetLatestAssetVersionAsync: " .. tostring(version)
	end
	if result.hash == HASH or os.clock() >= deadline then
		break
	end
	task.wait(2)
end
return result
`;
}

export function parseKernelResolve(results: unknown[], hash: string): { versionId?: number; problems: string[] } {
	const raw = isRecord(results[0]) ? results[0] : {};
	const problems = Array.isArray(raw.problems) ? raw.problems.map(String) : [];
	const versionId = typeof raw.versionId === "string" && /^\d+$/.test(raw.versionId) ? Number(raw.versionId) : typeof raw.versionId === "number" ? raw.versionId : undefined;
	if (raw.hash !== hash) problems.unshift(typeof raw.error === "string" ? raw.error : `Roblox served a version with KernelHash ${String(raw.hash ?? "none")}, not the uploaded ${hash.slice(0, 12)} (after ${String(raw.tries ?? "?")} tries)`);
	return { versionId: versionId && Number.isSafeInteger(versionId) && versionId > 0 ? versionId : undefined, problems };
}

// The drain message --------------------------------------------------------------------------------------------------------

export interface DrainFields {
	/** Kernel version. */
	v: string;
	/** Kernel hash. */
	h: string;
	/** Window, seconds. */
	w: number;
	/** Sent, unix ms. */
	t: number;
}

/** The signed string (kernel Drain.luau): tt1drain \n v \n h \n w \n t. */
export function drainCanonical(fields: DrainFields): string {
	for (const value of [fields.v, fields.h]) if (typeof value !== "string" || value.includes("\n")) throw new Error("drain: bad version or hash");
	for (const value of [fields.w, fields.t]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("drain: bad window or time");
	return `${DRAIN_TAG}\n${fields.v}\n${fields.h}\n${fields.w}\n${fields.t}`;
}

/** The message text on TypeTorch/deploy: { k = "drain", v, h, w, t, sig, sigF } (at most 1 KiB). */
export function drainMessage(signer: DualSigner, fields: DrainFields): string {
	const canonical = drainCanonical(fields);
	const text = JSON.stringify({ k: "drain", ...fields, sig: signCanonical(signer.main, canonical), sigF: signCanonical(signer.fallback, canonical) });
	if (new TextEncoder().encode(text).length > MESSAGE_LIMIT) throw new Error("the drain message is over MessagingService's 1 KiB");
	return text;
}

/** A drain window in seconds from `--drain <minutes>` / `--window <minutes>` (0-60). */
export function drainWindow(raw: string | undefined, flag: string): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw) || Number(raw) > 60) throw new UsageError(`--${flag} takes minutes, 0 to 60 (0: right away)`);
	return Number(raw) * 60;
}

// Health (promote) ----------------------------------------------------------------------------------------------------------

/**
 * Whether the dev kernel is proven healthy (orchestrator default, plans/22): pointed at >= PROMOTE_HOURS ago, at least
 * one server ran it, and no deploy report from a server on it failed or rolled back since. `branches`: the dev-channel
 * branches to read reports for (the ones whose servers run it, else every dev branch given).
 */
export async function kernelHealth(fleet: FleetClient | undefined, pointer: KernelPointer, options: { now?: Date; hours?: number } = {}): Promise<{ proven: boolean; reason: string }> {
	const now = (options.now ?? new Date()).getTime();
	const hours = (now - Date.parse(pointer.at)) / 3_600_000;
	const need = options.hours ?? PROMOTE_HOURS;
	const label = `kernel ${pointer.version} (version ${pointer.versionId})`;
	if (!(hours >= need)) return { proven: false, reason: `${label} has been the dev kernel for ${Number.isFinite(hours) ? hours.toFixed(1) : "?"} h, under ${need} h` };
	if (!fleet) return { proven: false, reason: "no fleet API to prove it healthy (typetorch backend setup)" };
	let servers;
	try {
		servers = await fleet.servers({});
	} catch (error) {
		return { proven: false, reason: `the fleet API didn't answer: ${(error as Error).message}` };
	}
	const running = servers.filter((s) => s.kernelVersion === pointer.version);
	if (running.length === 0) return { proven: false, reason: `no live server runs ${label} (start a dev server: a reserved server on a dev branch)` };
	const sick = running.filter((s) => s.health === "failed");
	if (sick.length) return { proven: false, reason: `${sick.length} server(s) on ${label} are failed` };
	const since = Date.parse(pointer.at) / 1000;
	let bad = 0;
	let reports = 0;
	for (const branch of new Set(running.map((s) => s.branch).filter((b): b is string => Boolean(b)))) {
		try {
			for (const report of await fleet.reports({ branch })) {
				if (report.kernelVersion !== pointer.version || (report.at ?? 0) < since) continue;
				reports++;
				if (report.result === "failed" || report.result === "rolled_back") bad++;
			}
		} catch (error) {
			return { proven: false, reason: `the fleet API didn't answer: ${(error as Error).message}` };
		}
	}
	if (bad) return { proven: false, reason: `${bad} deploy report(s) from servers on ${label} failed or rolled back` };
	return { proven: true, reason: `${label}: ${hours.toFixed(1)} h, ${running.length} server(s), ${reports} report(s), none failed (${formatCounts({ ok: running.length })} live)` };
}

// History (rollback) -----------------------------------------------------------------------------------------------------------

/** The pointers a channel had (oldest first), from this machine's kernel-deploys.jsonl. */
export function pointerHistory(stateDir: string, universeId: number, channel: KernelChannel): KernelPointer[] {
	const path = join(stateDir, KERNEL_LOG);
	if (!existsSync(path)) return [];
	const out: KernelPointer[] = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (record.universeId !== universeId || record.event !== "kernel-pointer") continue;
			const pointer = record.pointers?.[channel];
			if (pointer && out.at(-1)?.versionId !== pointer.versionId) out.push(pointer);
		} catch {}
	}
	return out;
}

// The engine -------------------------------------------------------------------------------------------------------------------

export interface AssetDeps {
	/** The assets key's client: uploads, moderation, the resolve task. */
	assets: Pick<OpenCloud, "createModelAsset" | "updateModelAsset" | "waitForOperation" | "waitForModeration" | "runLuau">;
	/** The deploy key's client: the settings record, the ping, the drain. */
	deploy: Pick<OpenCloud, "request" | "publishMessage">;
	signer(): DualSigner;
	interactive: boolean;
	confirm(question: string): Promise<boolean>;
	/** kernel-deploys.jsonl */
	record(entry: Record<string, unknown>): void;
	fleet?: FleetClient;
	now?: () => Date;
	/** typetorch.json kernelAssetId, after a new asset. */
	setKernelAssetId(id: number): void;
}

export class KernelAssetError extends Error {
	override name = "KernelAssetError";
}

async function currentBody(deps: AssetDeps, universeId: number): Promise<SettingsBody> {
	const read = await readSettings(deps.deploy as never, universeId);
	if (read.scopeMissing) throw new KernelAssetError(`can't read the settings record: the deploy key needs universe-datastores.objects:read (${read.error})`);
	if (read.error) throw new KernelAssetError(`reading the settings record failed: ${read.error}`);
	return read.body ?? {};
}

async function writePointers(proj: Project, deps: AssetDeps, signer: DualSigner, what: string, mutate: (body: SettingsBody) => SettingsBody) {
	const result = await changeSettings({ proj, oc: deps.deploy, signer, mutate: (body) => mutate(body), what });
	if (!isJson()) reportChange(result, what);
	return result;
}

async function sendDrain(proj: Project, deps: AssetDeps, signer: DualSigner, pointer: KernelPointer, windowSeconds: number) {
	const now = (deps.now ?? (() => new Date()))();
	const text = drainMessage(signer, { v: pointer.version, h: pointer.hash, w: windowSeconds, t: now.getTime() });
	await deps.deploy.publishMessage(proj.config.universeId, DEPLOY_TOPIC, text);
	if (!isJson()) info(`  drain    sent: public servers on another kernel move their players within ${Math.round(windowSeconds / 60)} min (kernel 0.4.1+)`);
}

const describePointer = (p: KernelPointer | undefined) => (p ? `${p.version} (asset ${p.asset} version ${p.versionId}, ${p.hash.slice(0, 12)})` : "none");

async function confirmOrRefuse(deps: AssetDeps, yes: boolean, question: string): Promise<boolean> {
	if (yes) return true;
	if (!deps.interactive) throw new UsageError("refusing without --yes (no interactive terminal to ask)");
	return deps.confirm(question);
}

/** Upload (or re-upload) a kernel package, wait for moderation, resolve and check the version. */
export async function uploadKernel(
	proj: Project,
	deps: AssetDeps,
	input: { bytes: Uint8Array; version: string; hash: string; newAsset: boolean; timeoutSeconds: number },
): Promise<{ assetId: number; versionId: number; created: boolean }> {
	const existing = proj.config.kernelAssetId;
	const created = input.newAsset || !existing;
	let operationId: string;
	if (created) {
		operationId = await deps.assets.createModelAsset({
			bytes: input.bytes,
			fileName: "TypeTorchKernel.rbxm",
			displayName: "TypeTorchKernel",
			description: `kernel=${input.version}\nhash=${input.hash}`,
			creator: proj.config.creator,
		});
	} else {
		operationId = await deps.assets.updateModelAsset({ assetId: existing!, bytes: input.bytes, fileName: "TypeTorchKernel.rbxm" });
	}
	const operation = await deps.assets.waitForOperation(operationId);
	const assetId = Number(operation?.response?.assetId ?? existing);
	if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new KernelAssetError(`the upload finished without an asset id: ${JSON.stringify(operation?.error ?? operation).slice(0, 300)}`);
	if (created) deps.setKernelAssetId(assetId);
	let state: string | undefined = operation?.response?.moderationResult?.moderationState;
	if (state !== "Approved") state = (await deps.assets.waitForModeration(assetId)).state;
	if (state !== "Approved") throw new KernelAssetError(`kernel asset ${assetId}: moderation is ${state ?? "unknown"}; nothing was pointed at it. Once it is Approved run the same command with --reupload, or --new-asset if the asset itself is gone`);
	const run = await deps.assets.runLuau(proj.config.universeId, proj.config.placeId, kernelResolveScript(assetId, input.hash), input.timeoutSeconds);
	if (run.state !== "COMPLETE") throw new KernelAssetError(`the resolve task failed (${run.state}): ${JSON.stringify(run.error ?? "").slice(0, 300)}`);
	const resolved = parseKernelResolve(run.results, input.hash);
	if (resolved.problems.length || !resolved.versionId) throw new KernelAssetError(`kernel asset ${assetId}: the uploaded version can't be used: ${resolved.problems.join("; ") || "no version id"}`);
	return { assetId, versionId: resolved.versionId, created };
}

export interface AssetDeployInput {
	proj: Project;
	channel: KernelChannel;
	version: string;
	hash: string;
	commit?: string;
	bytes: Uint8Array;
	/** Where the package is kept (shown; --reupload reads it). */
	kept: string;
	newAsset: boolean;
	reupload: boolean;
	dryRun: boolean;
	yes: boolean;
	drainSeconds?: number;
	timeoutSeconds: number;
}

/** `typetorch kernel deploy --asset`. */
export async function assetDeploy(input: AssetDeployInput, deps: AssetDeps): Promise<void> {
	const { proj } = input;
	const body = await currentBody(deps, proj.config.universeId);
	const before = { prod: pointerOf(body, "prod"), dev: pointerOf(body, "dev") };
	const asset = input.newAsset || !proj.config.kernelAssetId ? "a NEW kernel asset" : `kernel asset ${proj.config.kernelAssetId} (a new version)`;
	const plan = { channel: input.channel, kernel: { version: input.version, hash: input.hash, commit: input.commit }, bytes: input.bytes.length, kept: input.kept, asset, reupload: input.reupload, before, drainSeconds: input.drainSeconds ?? null };
	if (!isJson()) {
		info(`  package  ${input.kept}  ${formatBytes(input.bytes.length)}  kernel ${input.version} (${input.hash.slice(0, 12)})${input.reupload ? "  (re-upload of the kept package)" : ""}`);
		info(`  upload   to ${asset}`);
		info(`  pointer  ${input.channel === "prod" ? "prod and dev" : "dev"}: ${describePointer(before[input.channel])} -> kernel ${input.version}`);
		if (input.channel === "prod") info(`           dev now: ${describePointer(before.dev)}`);
		info(`  drain    ${input.drainSeconds === undefined ? "no (new servers only; --drain <min> moves the others)" : `within ${input.drainSeconds / 60} min`}`);
	}
	if (input.dryRun) {
		if (isJson()) return emitJson({ dryRun: true, ...plan });
		info(bold("dry run: nothing uploaded or signed"));
		return;
	}
	const signer = deps.signer();
	if (!(await confirmOrRefuse(deps, input.yes, `Upload kernel ${input.version} and point ${input.channel === "prod" ? "prod (and dev)" : "dev"} at it?`))) {
		info("nothing uploaded");
		return;
	}
	const watch = new Stopwatch();
	const uploaded = await watch.stage("upload", () => uploadKernel(proj, deps, { bytes: input.bytes, version: input.version, hash: input.hash, newAsset: input.newAsset, timeoutSeconds: input.timeoutSeconds }));
	const pointer: KernelPointer = { asset: uploaded.assetId, versionId: uploaded.versionId, version: input.version, hash: input.hash, loaderApi: LOADER_API, ...(input.commit ? { commit: input.commit } : {}), at: (deps.now ?? (() => new Date()))().toISOString() };
	if (!isJson()) info(`  uploaded asset ${uploaded.assetId}${uploaded.created ? " (new; typetorch.json kernelAssetId)" : ""} version ${uploaded.versionId}: checked`);
	const result = await watch.stage("sign", () =>
		writePointers(proj, deps, signer, `kernel.${input.channel === "prod" ? "prod and kernel.dev" : "dev"} = ${input.version}`, (b) => {
			const dev = withPointer(b, "dev", pointer);
			return input.channel === "prod" ? withPointer(dev, "prod", pointer) : dev;
		}),
	);
	const after = { dev: pointer, prod: input.channel === "prod" ? pointer : before.prod };
	deps.record({ event: "kernel-pointer", universeId: proj.config.universeId, placeId: proj.config.placeId, action: input.reupload ? "reupload" : "deploy", channel: input.channel, pointers: after, before, created: uploaded.created, settingsSeq: result.seq ?? null });
	if (input.drainSeconds !== undefined) await sendDrain(proj, deps, signer, pointer, input.drainSeconds);
	if (isJson()) return emitJson({ ...plan, pointer, settingsSeq: result.seq ?? null, timings: watch.total() });
	info(bold(`kernel ${input.version} is the ${input.channel === "prod" ? "prod and dev" : "dev"} kernel: new servers load it (asset ${pointer.asset} version ${pointer.versionId})`));
	if (input.channel === "dev") info(dim("  then: typetorch kernel promote (after it ran healthy for an hour on dev servers)"));
}

/** `typetorch kernel promote`: dev's kernel to prod once proven healthy. */
export async function kernelPromote(input: { proj: Project; force: boolean; yes: boolean; dryRun: boolean; drainSeconds?: number }, deps: AssetDeps): Promise<void> {
	const { proj } = input;
	const body = await currentBody(deps, proj.config.universeId);
	const dev = pointerOf(body, "dev");
	const prod = pointerOf(body, "prod");
	if (!dev) throw new KernelAssetError("the settings record has no kernel.dev pointer (typetorch kernel deploy --asset first)");
	if (prod && prod.versionId === dev.versionId) {
		info(`prod already runs kernel ${prod.version} (version ${prod.versionId})`);
		return;
	}
	const health = await kernelHealth(deps.fleet, dev, { now: deps.now?.() });
	if (!isJson()) {
		info(`  prod     ${describePointer(prod)} -> ${describePointer(dev)}`);
		info(`  health   ${health.proven ? health.reason : `NOT proven: ${health.reason}`}`);
	}
	if (!health.proven && !input.force) throw new KernelAssetError(`refusing to promote an unproven kernel to prod: ${health.reason}. --force does it anyway`);
	if (!health.proven) warn("--force: promoting an unproven kernel");
	if (input.dryRun) {
		if (isJson()) return emitJson({ dryRun: true, from: prod ?? null, to: dev, health });
		info(bold("dry run: nothing signed"));
		return;
	}
	const signer = deps.signer();
	if (!(await confirmOrRefuse(deps, input.yes, `Make kernel ${dev.version} the prod kernel?`))) return;
	const now = (deps.now ?? (() => new Date()))();
	const result = await writePointers(proj, deps, signer, `kernel.prod = ${dev.version}`, (b) => promoted(b, now));
	const pointer = { ...dev, at: now.toISOString() };
	deps.record({ event: "kernel-pointer", universeId: proj.config.universeId, placeId: proj.config.placeId, action: "promote", channel: "prod", pointers: { prod: pointer, dev }, before: { prod, dev }, health, forced: !health.proven, settingsSeq: result.seq ?? null });
	if (input.drainSeconds !== undefined) await sendDrain(proj, deps, signer, pointer, input.drainSeconds);
	if (isJson()) return emitJson({ from: prod ?? null, to: pointer, health, settingsSeq: result.seq ?? null });
	info(bold(`kernel ${dev.version} is the prod kernel: new public servers load it`));
}

/** `typetorch kernel rollback`: a channel's pointer back to its previous kernel (or --to <version|versionId>). */
export async function kernelRollback(input: { proj: Project; channel: KernelChannel; to?: string; yes: boolean; dryRun: boolean; drainSeconds?: number; stateDir: string }, deps: AssetDeps): Promise<void> {
	const { proj, channel } = input;
	const body = await currentBody(deps, proj.config.universeId);
	const current = pointerOf(body, channel);
	const history = pointerHistory(input.stateDir, proj.config.universeId, channel);
	let target: KernelPointer | undefined;
	if (input.to) {
		target = [...history].reverse().find((p) => String(p.versionId) === input.to || p.version === input.to);
		if (!target) throw new KernelAssetError(`no kernel.${channel} pointer "${input.to}" in this machine's log (${KERNEL_LOG}); known: ${history.map((p) => `${p.version}/${p.versionId}`).join(", ") || "none"}`);
	} else {
		target = [...history].reverse().find((p) => !current || p.versionId !== current.versionId);
		if (!target) throw new KernelAssetError(`no earlier kernel.${channel} pointer in this machine's log (${KERNEL_LOG})`);
	}
	if (!isJson()) info(`  ${channel.padEnd(8)} ${describePointer(current)} -> ${describePointer(target)}`);
	if (input.dryRun) {
		if (isJson()) return emitJson({ dryRun: true, channel, from: current ?? null, to: target });
		info(bold("dry run: nothing signed"));
		return;
	}
	const signer = deps.signer();
	if (!(await confirmOrRefuse(deps, input.yes, `Point kernel.${channel} back at ${target.version} (version ${target.versionId})?`))) return;
	const now = (deps.now ?? (() => new Date()))();
	const pointer = { ...target, at: now.toISOString() };
	const result = await writePointers(proj, deps, signer, `kernel.${channel} = ${target.version} (rollback)`, (b) => withPointer(b, channel, pointer));
	deps.record({ event: "kernel-pointer", universeId: proj.config.universeId, placeId: proj.config.placeId, action: "rollback", channel, pointers: { ...{ prod: pointerOf(body, "prod"), dev: pointerOf(body, "dev") }, [channel]: pointer }, before: { [channel]: current }, settingsSeq: result.seq ?? null });
	if (input.drainSeconds !== undefined) await sendDrain(proj, deps, signer, pointer, input.drainSeconds);
	if (isJson()) return emitJson({ channel, from: current ?? null, to: pointer, settingsSeq: result.seq ?? null });
	info(bold(`kernel.${channel} is ${target.version} again: new servers load it`));
}

/** `typetorch kernel drain`: the signed drain for a channel's current kernel. */
export async function kernelDrain(input: { proj: Project; channel: KernelChannel; windowSeconds: number; yes: boolean; dryRun: boolean }, deps: AssetDeps): Promise<void> {
	const body = await currentBody(deps, input.proj.config.universeId);
	const pointer = pointerOf(body, input.channel);
	if (!pointer) throw new KernelAssetError(`the settings record has no kernel.${input.channel} pointer`);
	if (!isJson()) info(`  drain    public servers not on ${describePointer(pointer)} move their players within ${input.windowSeconds / 60} min`);
	if (input.dryRun) {
		if (isJson()) return emitJson({ dryRun: true, pointer, windowSeconds: input.windowSeconds });
		info(bold("dry run: nothing sent"));
		return;
	}
	const signer = deps.signer();
	if (!(await confirmOrRefuse(deps, input.yes, `Move the players of every public server not on kernel ${pointer.version} within ${input.windowSeconds / 60} min?`))) return;
	await sendDrain(input.proj, deps, signer, pointer, input.windowSeconds);
	deps.record({ event: "kernel-drain", universeId: input.proj.config.universeId, placeId: input.proj.config.placeId, channel: input.channel, pointer, windowSeconds: input.windowSeconds });
	if (isJson()) emitJson({ pointer, windowSeconds: input.windowSeconds });
}

// install-loader --------------------------------------------------------------------------------------------------------------

/** The loader slots project: the loader (trust roots and identity stamped), its client, the baked kernel, the backup. */
export function loaderSlotsProject(prepared: Pick<PreparedKernel, "stamped" | "kernelDir" | "identity">, loaderProject: unknown, minKernel: string): { project: unknown; slots: SlotRef[] } {
	const tree = isRecord(loaderProject) && isRecord(loaderProject.tree) ? (loaderProject.tree as Record<string, unknown>) : {};
	const pick = (service: string, name: string) => {
		const node = isRecord(tree[service]) ? (tree[service] as Record<string, unknown>)[name] : undefined;
		if (!isRecord(node)) throw new KernelCheckError(`the kernel's loader.project.json has no ${service}.${name} (kernel 0.4.1+)`);
		return absolutePaths(node, prepared.kernelDir) as Record<string, unknown>;
	};
	const stampedTree = isRecord(prepared.stamped) && isRecord((prepared.stamped as Record<string, unknown>).tree) ? ((prepared.stamped as Record<string, unknown>).tree as Record<string, unknown>) : {};
	const kernelNode = isRecord(stampedTree.ServerScriptService) ? ((stampedTree.ServerScriptService as Record<string, unknown>).TypeTorchKernel as Record<string, unknown>) : undefined;
	const kernelAttributes = isRecord(kernelNode?.$attributes) ? (kernelNode!.$attributes as Record<string, unknown>) : {};
	const loader = pick("ServerScriptService", LOADER_SLOT.name);
	const attributes: Record<string, unknown> = { ...(isRecord(loader.$attributes) ? loader.$attributes : {}) };
	for (const name of [...TRUST_ROOTS, "KernelVersion", "KernelHash", "KernelCommit"]) if (kernelAttributes[name] !== undefined) attributes[name] = kernelAttributes[name];
	attributes.MinKernelVersion = minKernel;
	loader.$attributes = attributes;
	const storage: Record<string, unknown> = { $className: "Folder", [BAKED_FOLDER]: bakedSlotNode(prepared.stamped) };
	const slots: SlotRef[] = [LOADER_SLOT, LOADER_CLIENT_SLOT, BAKED_SLOT];
	const backupNode = isRecord(stampedTree.ServerStorage) ? (stampedTree.ServerStorage as Record<string, unknown>)[BACKUP_SLOT.name] : undefined;
	if (isRecord(backupNode)) {
		storage[BACKUP_SLOT.name] = backupNode;
		slots.push(BACKUP_SLOT);
	}
	return {
		project: { name: SLOTS_ROOT, tree: { $className: "Folder", ServerScriptService: { $className: "Folder", [LOADER_SLOT.name]: loader }, ReplicatedFirst: { $className: "Folder", [LOADER_CLIENT_SLOT.name]: pick("ReplicatedFirst", LOADER_CLIENT_SLOT.name) }, ServerStorage: storage } },
		slots,
	};
}

/** `typetorch kernel install-loader`: the luau engine with the loader slots, removing the kernel installed directly. */
export async function installLoader(args: ParsedArgs, deps?: LuauDeps): Promise<void> {
	const prepared = await prepareKernel(args);
	const { proj, kernelDir, identity, signing, watch, where } = prepared;
	const loaderFile = join(kernelDir, "loader.project.json");
	if (!existsSync(loaderFile)) throw new KernelCheckError(`${kernelDir} has no loader.project.json: the loader needs kernel ${MIN_LOADER_KERNEL}+`);
	const minKernel = flagString(args, "min-kernel") ?? MIN_LOADER_KERNEL;
	const { project: slotsJson, slots } = loaderSlotsProject(prepared, parseJsonc(readFileSync(loaderFile, "utf8")), minKernel);
	const layout = kernelLayout(prepared.stamped, { loadstring: flagBool(args, "loadstring") });
	const { settings } = settingValues(prepared.stamped, layout.serviceProps);
	const { bytes, read } = await watch.stage("slots", () => buildSlotsRbxm(proj, slotsJson, slots, LOADER_SLOT, LOADER_SLOTS_FILE));
	if (read.identity.KernelHash !== identity.hash) throw new KernelCheckError(`${LOADER_SLOTS_FILE} carries KernelHash ${String(read.identity.KernelHash)}, the kernel is ${identity.hash}`);
	info(`  loader   ${LOADER_SLOTS_FILE}  ${formatBytes(bytes.length)}  ${read.slots.map((s) => `${s.slot} ${s.instances}`).join(", ")}; MinKernelVersion ${minKernel}; removes the kernel installed directly`);
	const outDir = join(proj.root, OUT_DIR);
	mkdirSync(join(outDir, "place-patches"), { recursive: true });
	const reportPath = join(outDir, "place-patches", `${proj.config.placeId}-loader-${identity.version}-luau.json`);
	await luauDeploy(
		{
			universeId: proj.config.universeId,
			placeId: proj.config.placeId,
			where,
			kernel: { version: identity.version, hash: identity.hash, commit: identity.commit, dirty: identity.dirty, api: identity.api },
			slots,
			remove: PACKAGE_SLOTS,
			settings,
			identitySlot: LOADER_SLOT,
			slotsBytes: bytes,
			slotsFile: LOADER_SLOTS_FILE,
			cliSlots: read.slots,
			baseFlag: flagString(args, "base"),
			install: true,
			dryRun: flagBool(args, "dry-run"),
			yes: flagBool(args, "yes"),
			timeoutSeconds: taskTimeout(args),
			blockers: signing.problems,
			reportPath,
			reportDisplay: reportPath.replace(/\\/g, "/"),
			logFields: { mode: "install-loader", minKernelVersion: minKernel, kernelTag: identity.tag, kernelSource: identity.source, keyAssetId: proj.config.keyAssetId ?? null, fallbackPublicKey: proj.config.fallbackPublicKey ?? null, bootstrapHeads: prepared.heads, backupBuild: prepared.backup },
		},
		deps ?? luauDeps(proj),
	);
}

// Command wiring ---------------------------------------------------------------------------------------------------------------

function channelFlagOf(args: ParsedArgs, fallback: KernelChannel): KernelChannel {
	const raw = flagString(args, "channel") ?? fallback;
	if (raw !== "prod" && raw !== "dev") throw new UsageError(`--channel must be prod or dev, got "${raw}"`);
	return raw;
}

/** The real dependencies: the assets and deploy keys' clients, the signing keys (loaded when needed), the terminal. */
export function assetDeps(proj: Project, args: ParsedArgs): AssetDeps {
	const io = interaction();
	const stateDir = projectStateDir(proj);
	return {
		get assets() {
			return openCloud("assets")!;
		},
		get deploy() {
			return openCloud("deploy")!;
		},
		signer: () => settingsSigner(proj, args),
		interactive: io.interactive,
		confirm: (question) => io.confirm(question),
		record: (entry) => {
			mkdirSync(stateDir, { recursive: true });
			appendFileSync(join(stateDir, KERNEL_LOG), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
		},
		fleet: fleetFor(proj).client,
		setKernelAssetId: (id) => updateProjectConfig(proj, { kernelAssetId: id }),
	};
}

/** Builds the kernel package with Rojo into .typetorch/kernel-package.rbxm and keeps a copy for --reupload. */
export async function buildPackage(prepared: PreparedKernel): Promise<{ bytes: Uint8Array; kept: string }> {
	const { proj, identity } = prepared;
	const gen = PACKAGE_FILE.replace(/\.rbxm$/, ".gen.project.json");
	writeFileSync(join(proj.root, gen), JSON.stringify(packageProject(prepared.stamped, { version: identity.version, hash: identity.hash, commit: identity.commit ? `${identity.commit}${identity.dirty ? "*" : ""}` : undefined, api: identity.api }), null, "\t"));
	try {
		await run([rojoBinary(), "build", gen, "-o", PACKAGE_FILE], proj.root);
	} finally {
		rmSync(join(proj.root, gen), { force: true });
	}
	const bytes = new Uint8Array(readFileSync(join(proj.root, PACKAGE_FILE)));
	const read = packageIdentity(bytes);
	if (read.hash !== identity.hash || read.slots.length !== PACKAGE_SLOTS.length) throw new KernelCheckError(`${PACKAGE_FILE} isn't the kernel package (hash ${String(read.hash)}, slots ${read.slots.join(", ")})`);
	return { bytes, kept: keepKernel(projectStateDir(proj), identity.version, identity.hash, bytes) };
}

/** `kernel deploy --asset` from the command line. */
export async function assetDeployCommand(args: ParsedArgs) {
	for (const flag of ["engine", "place-file", "replace-place", "base", "install", "loadstring", "patch"]) {
		if (args.flags[flag] !== undefined) throw new UsageError(`--${flag} doesn't apply to --asset (the place isn't patched; typetorch kernel install-loader installs the loader once)`);
	}
	const channel = channelFlagOf(args, "dev");
	const drainSeconds = drainWindow(flagString(args, "drain"), "drain");
	const reupload = flagBool(args, "reupload");
	if (reupload) {
		const proj = project(args);
		const deps = assetDeps(proj, args);
		const pointer = pointerOf(await currentBody(deps, proj.config.universeId), channel);
		if (!pointer) throw new KernelAssetError(`--reupload sends the kept package of kernel.${channel}'s kernel, and the settings record has no kernel.${channel}`);
		const kept = findKeptKernel(projectStateDir(proj), pointer.version, pointer.hash);
		if (!kept) throw new KernelAssetError(`kernel ${pointer.version} (${pointer.hash.slice(0, 12)}) has no kept package on this machine (<state dir>/${KERNELS_DIR}): deploy it again from its kernel checkout (typetorch kernel deploy --asset --kernel <dir>)`);
		const bytes = new Uint8Array(readFileSync(kept));
		const read = packageIdentity(bytes);
		if (read.hash !== pointer.hash) throw new KernelAssetError(`${kept} isn't kernel ${pointer.hash.slice(0, 12)}`);
		return assetDeploy({ proj, channel, version: pointer.version, hash: pointer.hash, commit: pointer.commit, bytes, kept, newAsset: flagBool(args, "new-asset"), reupload: true, dryRun: flagBool(args, "dry-run"), yes: flagBool(args, "yes"), drainSeconds, timeoutSeconds: taskTimeout(args) }, deps);
	}
	const prepared = await prepareKernel(args);
	const { bytes, kept } = await prepared.watch.stage("package", () => buildPackage(prepared));
	const proj = prepared.proj;
	if (prepared.signing.problems.length && !flagBool(args, "dry-run")) throw new KernelCheckError(`refusing to point servers at a kernel without trust roots:\n  - ${prepared.signing.problems.join("\n  - ")}`);
	return assetDeploy(
		{ proj, channel, version: prepared.identity.version, hash: prepared.identity.hash, commit: prepared.identity.commit, bytes, kept: kept.replace(/\\/g, "/"), newAsset: flagBool(args, "new-asset"), reupload: false, dryRun: flagBool(args, "dry-run"), yes: flagBool(args, "yes"), drainSeconds, timeoutSeconds: taskTimeout(args) },
		assetDeps(proj, args),
	);
}

export async function promoteCommand(args: ParsedArgs) {
	const proj = project(args);
	return kernelPromote({ proj, force: flagBool(args, "force"), yes: flagBool(args, "yes"), dryRun: flagBool(args, "dry-run"), drainSeconds: drainWindow(flagString(args, "drain"), "drain") }, assetDeps(proj, args));
}

export async function rollbackCommand(args: ParsedArgs) {
	const proj = project(args);
	return kernelRollback({ proj, channel: channelFlagOf(args, "prod"), to: flagString(args, "to"), yes: flagBool(args, "yes"), dryRun: flagBool(args, "dry-run"), drainSeconds: drainWindow(flagString(args, "drain"), "drain"), stateDir: projectStateDir(proj) }, assetDeps(proj, args));
}

export async function drainCommand(args: ParsedArgs) {
	const proj = project(args);
	const windowSeconds = drainWindow(flagString(args, "window") ?? "30", "window")!;
	return kernelDrain({ proj, channel: channelFlagOf(args, "prod"), windowSeconds, yes: flagBool(args, "yes"), dryRun: flagBool(args, "dry-run") }, assetDeps(proj, args));
}
