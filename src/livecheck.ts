/**
 * Do live servers have something to run? (cecot, 2026-10: a kernel with no prod build took a live game down.)
 *
 * Since kernel 0.3.6 ("never an empty server", kernel src/server/Fallback.luau) a public server that can load nothing
 * (no verified, bootstrap or usable stored head of the default branch, no peer build, no backup) moves its players to
 * another server after BOOT_BUDGET (15 s) and kicks them after BOUNCE_MAX (3) bounces. So a place published with the
 * kernel before the default branch has a signed deploy, and without a baked backup (ServerStorage.TypeTorchBackup),
 * kicks every player of the live game.
 *
 * Facts:
 *   - the place (doctor's Luau Execution read, keyasset.ts placeKeysScript, which runs PLACE_GAME_LUAU): the kernel
 *     slots, the BootstrapHeads attribute, the backup, and an old game build that runs on its own (a roblox-ts build:
 *     ServerScriptService.TS, ReplicatedStorage.rbxts_include, or Scripts outside the kernel slots that require a
 *     roblox-ts runtime);
 *   - the default branch's head: the kernel's DataStore `heads` (seqstore.ts readSharedSeq, the deploy key), else
 *     this machine's log.
 * `liveServerChecks` and `defaultBranchHead` are pure (tested); `readPlaceGame` runs a small task for `deploy`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./config.ts";
import type { LiveHead } from "./deployments.ts";
import { isRecord } from "./json.ts";
import type { Check } from "./keycheck.ts";
import { branchChannel } from "./naming.ts";
import type { OpenCloud } from "./opencloud.ts";
import type { SharedSeq } from "./seqstore.ts";

/** The kernel's slots in a place (kernel place.project.json). The server slot is the one that moves players. */
export const KERNEL_SLOTS = ["ServerScriptService.TypeTorchKernel", "ReplicatedStorage.TypeTorchKernelShared", "ReplicatedFirst.TypeTorchKernelClient"] as const;
export const SERVER_SLOT = KERNEL_SLOTS[0];
/** A roblox-ts game build that runs on its own (rbxtsc's default output folders). */
export const OLD_BUILD_MARKERS = ["ServerScriptService.TS", "ReplicatedStorage.rbxts_include"] as const;
/** Kernel Constants: seconds before a server with nothing to run moves its players, and bounces before it kicks. */
export const BOOT_BUDGET = 15;
export const BOUNCE_MAX = 3;
/** At most this many script paths come back from the place. */
const SCRIPTS_LISTED = 10;

const luauPath = (path: string) => {
	const [service, name] = path.split(".");
	return `{ "${service}", "${name}" }`;
};

/**
 * Luau that fills `result.slots` (the kernel slots present), `result.oldBuild` (old-build markers present) and
 * `result.rbxtsScripts` (enabled scripts outside the TypeTorch* slots whose Source requires a roblox-ts runtime;
 * `result.sourceUnreadable` when Source can't be read in the task). Expects a `result` table in scope.
 */
export const PLACE_GAME_LUAU = `
-- Live servers (livecheck.ts): the kernel slots, and an old game build that runs next to the kernel.
local function present(paths)
	local found = {}
	for _, path in paths do
		local ok, service = pcall(game.GetService, game, path[1])
		if ok and service and service:FindFirstChild(path[2]) then
			table.insert(found, path[1] .. "." .. path[2])
		end
	end
	return found
end
result.slots = present({ ${KERNEL_SLOTS.map(luauPath).join(", ")} })
result.oldBuild = present({ ${OLD_BUILD_MARKERS.map(luauPath).join(", ")} })
local rbxtsScripts = {}
local rbxtsCount = 0
-- In a pcall: the same task reads the signing keys (keyasset.ts), which must not fail with this scan.
local scanned, scanError = pcall(function()
for _, serviceName in { "ServerScriptService", "ReplicatedFirst", "ReplicatedStorage", "StarterPlayer", "StarterGui", "Workspace" } do
	local service = game:GetService(serviceName)
	for _, child in service:GetChildren() do
		if string.sub(child.Name, 1, 9) ~= "TypeTorch" then
			local list = child:GetDescendants()
			table.insert(list, child)
			for _, item in list do
				if item:IsA("BaseScript") and item.Enabled then
					local ok, source = pcall(function()
						return item.Source
					end)
					if not ok then
						result.sourceUnreadable = true
					elseif string.find(source, "RuntimeLib", 1, true) or string.find(source, "rbxts_include", 1, true) then
						rbxtsCount += 1
						if #rbxtsScripts < ${SCRIPTS_LISTED} then
							table.insert(rbxtsScripts, item:GetFullName())
						end
					end
				end
			end
		end
	end
end
end)
if not scanned then
	result.sourceUnreadable = true
	result.scanError = tostring(scanError)
end
result.rbxtsScripts = rbxtsScripts
result.rbxtsCount = rbxtsCount
`;

/** What PLACE_GAME_LUAU reported, plus the kernel's own attributes. */
export interface PlaceGame {
	/** The kernel slots in the place (KERNEL_SLOTS order). */
	slots: string[];
	/** Old-build markers in the place (ServerScriptService.TS, ...). */
	oldBuild: string[];
	/** Enabled scripts outside the slots that require a roblox-ts runtime (at most SCRIPTS_LISTED). */
	rbxtsScripts: string[];
	rbxtsCount: number;
	sourceUnreadable?: boolean;
	kernelVersion?: string;
	/** The kernel's BootstrapHeads attribute, parsed ({ [branch]: { a, s, i } }). */
	bootstrapHeads?: Record<string, unknown>;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The task's result (an empty Luau table may arrive as [] or {}). */
export function placeGameFrom(result: Record<string, unknown>): PlaceGame {
	const kernel = isRecord(result.kernel) ? result.kernel : undefined;
	let bootstrapHeads: Record<string, unknown> | undefined;
	if (kernel && typeof kernel.bootstrapHeads === "string") {
		try {
			const parsed = JSON.parse(kernel.bootstrapHeads);
			if (isRecord(parsed)) bootstrapHeads = parsed;
		} catch {}
	}
	const slots = strings(result.slots);
	// A place read by an older script (no slots list): the server slot is known from `kernel`.
	if (!Array.isArray(result.slots) && !isRecord(result.slots) && kernel) slots.push(SERVER_SLOT);
	const scripts = strings(result.rbxtsScripts);
	return {
		slots,
		oldBuild: strings(result.oldBuild),
		rbxtsScripts: scripts,
		rbxtsCount: typeof result.rbxtsCount === "number" ? result.rbxtsCount : scripts.length,
		...(result.sourceUnreadable === true ? { sourceUnreadable: true } : {}),
		...(kernel && typeof kernel.version === "string" ? { kernelVersion: kernel.version } : {}),
		...(bootstrapHeads ? { bootstrapHeads } : {}),
	};
}

/** The default branch's head, as public servers would find it. */
export type HeadState =
	| { state: "verified"; detail: string }
	/** A stored prod head without a signature (and not a bootstrap head): prod servers refuse it. */
	| { state: "unsigned"; detail: string }
	| { state: "none"; detail: string }
	/** The DataStore heads couldn't be read. */
	| { state: "unknown"; detail: string };

const seqOf = (value: unknown) => (isRecord(value) && typeof value.seq === "number" ? value.seq : isRecord(value) && typeof value.s === "number" ? value.s : undefined);

/**
 * The default branch's head: the kernel's DataStore `heads` (signed for a prod-channel branch, or the place's
 * bootstrap head), else the place's bootstrap head, else (DataStore unreadable) unknown, with this machine's log.
 */
export function defaultBranchHead(input: {
	config: Pick<ProjectConfig, "defaultBranch" | "channels">;
	shared?: SharedSeq;
	local?: Map<string, LiveHead>;
	bootstrap?: Record<string, unknown>;
}): HeadState {
	const branch = input.config.defaultBranch;
	const prod = branchChannel(input.config, branch) === "prod";
	const boot = seqOf(input.bootstrap?.[branch]);
	const stored = input.shared?.branches?.[branch];
	const storedSeq = seqOf(stored);
	if (input.shared?.branches) {
		if (storedSeq !== undefined) {
			const signed = isRecord(stored) && (typeof stored.sig === "string" || typeof stored.sigF === "string");
			if (!prod || signed) return { state: "verified", detail: `${branch} #${storedSeq}${prod ? " (signed)" : ""} in the DataStore heads` };
			if (boot === storedSeq) return { state: "verified", detail: `${branch} #${storedSeq}, the kernel's bootstrap head` };
			return { state: "unsigned", detail: `${branch} #${storedSeq} in the DataStore heads is unsigned and not a bootstrap head: prod servers refuse it` };
		}
		if (boot !== undefined) return { state: "verified", detail: `${branch} #${boot}, the kernel's bootstrap head` };
		return { state: "none", detail: `no ${branch} head in the DataStore heads` };
	}
	if (boot !== undefined) return { state: "verified", detail: `${branch} #${boot}, the kernel's bootstrap head` };
	const local = input.local?.get(branch);
	const why = input.shared ? (input.shared.error ?? "the heads entry didn't answer") : "no deploy key";
	return { state: "unknown", detail: `the DataStore heads weren't read (${why})${local ? `; this machine's log has ${branch} #${local.seq}` : `; this machine's log has no ${branch} deploy either`}` };
}

/** How to deploy the default branch: the git branch(es) typetorch.json maps to it, and the --branch form. */
export function deployDefaultHint(config: Pick<ProjectConfig, "defaultBranch" | "branches">): string {
	const branch = config.defaultBranch;
	const mapped = Object.entries(config.branches ?? {})
		.filter(([, to]) => to === branch)
		.map(([git]) => git);
	const explicit = `\`typetorch deploy --branch ${branch}\``;
	return mapped.length ? `\`typetorch deploy\` from git branch ${mapped.join(" or ")} (or ${explicit})` : explicit;
}

/** The place version before the kernel's first install, from this machine's kernel log. */
export function versionBeforeKernel(stateDir: string): number | undefined {
	const file = join(stateDir, "kernel-deploys.jsonl");
	if (!existsSync(file)) return undefined;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		try {
			const record = JSON.parse(line);
			if (record?.event === "kernel-published" && record.firstInstall === true && typeof record.placeVersionBefore === "number") return record.placeVersionBefore;
		} catch {}
	}
	return undefined;
}

/** The one-sentence reason, shared by doctor, kernel deploy and deploy. */
export function nothingToRunReason(defaultBranch: string): string {
	return `public servers have nothing to run: the kernel (0.3.6+) moves every player out after ${BOOT_BUDGET} s and kicks them after ${BOUNCE_MAX} bounces while ${defaultBranch} has no verified head and the place has no backup build`;
}

export interface LiveInput {
	config: Pick<ProjectConfig, "defaultBranch" | "branches" | "channels">;
	/** The place (undefined: not read). */
	game?: PlaceGame & { source: string };
	/** ServerStorage.TypeTorchBackup (KeyFacts.backup). */
	backup?: { present: boolean; channel?: string };
	head: HeadState;
	/** For `kernel restore --version <n>` (versionBeforeKernel). */
	restoreVersion?: number;
}

/** A backup servers would run: present and not dev-channel. */
export const usableBackup = (backup: LiveInput["backup"]) => Boolean(backup?.present && backup.channel !== "dev");

/**
 * "live servers": fail when the place has the kernel, the default branch no verified head and the place no usable
 * backup; "old game build": warn when the kernel shares the place with a roblox-ts build that runs on its own.
 */
export function liveServerChecks(input: LiveInput): Check[] {
	const { game, head, config } = input;
	if (!game) return [{ name: "live servers", status: "info", detail: "not checked: the place wasn't read (needs the assets key's Luau Execution and signing set up)" }];
	const checks: Check[] = [];
	const kernel = game.slots.includes(SERVER_SLOT);
	const version = game.kernelVersion ? `kernel ${game.kernelVersion}` : "the kernel";
	if (!kernel) {
		checks.push({ name: "live servers", status: "ok", detail: `${game.source}: no ${SERVER_SLOT}: servers run the place's own scripts` });
		return checks;
	}
	const backup = usableBackup(input.backup);
	if (backup) {
		checks.push({ name: "live servers", status: "ok", detail: `${game.source}: ${version}; ${head.detail}; the backup build covers a server that can load nothing else` });
	} else if (head.state === "verified") {
		checks.push({ name: "live servers", status: "ok", detail: `${game.source}: ${version} runs ${head.detail}` });
	} else if (head.state === "unknown") {
		checks.push({ name: "live servers", status: "warn", detail: `${game.source}: ${version} and no backup build, and ${head.detail}: can't tell whether public servers have something to run. If ${config.defaultBranch} was never deployed, they move every player out after ${BOOT_BUDGET} s; deploy it: ${deployDefaultHint(config)}` });
	} else {
		const noBackup = input.backup?.present ? "the backup build is dev-channel: servers refuse it" : "no ServerStorage.TypeTorchBackup";
		const restore = `\`typetorch kernel restore --version ${input.restoreVersion ?? "<n>"}\`${input.restoreVersion === undefined ? " (n: a place version from before the kernel install)" : ""}`;
		checks.push({
			name: "live servers",
			status: "fail",
			detail: `${game.source}: live servers have nothing to run (${head.detail}; ${noBackup}): ${version} moves every player out after ${BOOT_BUDGET} s and kicks after ${BOUNCE_MAX} bounces. Deploy ${config.defaultBranch} first (${deployDefaultHint(config)}), or restore the place version without the kernel (${restore})`,
		});
	}
	const old = [...game.oldBuild, ...game.rbxtsScripts.filter((path) => !game.oldBuild.some((marker) => path === marker || path.startsWith(`${marker}.`)))];
	if (old.length) {
		const more = game.rbxtsCount > game.rbxtsScripts.length ? ` (+${game.rbxtsCount - game.rbxtsScripts.length} more)` : "";
		checks.push({
			name: "old game build",
			status: "warn",
			detail: `${game.source}: the kernel shares the place with a game build that runs on its own (${old.join(", ")}${more}): two games run in one server, and with a player data library in both they fight over session locks. Publish the place without the old scripts once ${config.defaultBranch} is deployed`,
		});
	} else {
		checks.push({ name: "old game build", status: "ok", detail: `${game.source}: no roblox-ts build outside the kernel slots${game.sourceUnreadable ? " (markers only: script sources weren't readable in the task)" : ""}` });
	}
	return checks;
}

/** A small read of the published place for `deploy` (the kernel slot, BootstrapHeads, the backup). Throws on failure. */
export async function readPlaceGame(oc: Pick<OpenCloud, "runLuau">, universeId: number, placeId: number): Promise<{ game: PlaceGame; backup: { present: boolean; channel?: string } }> {
	const script = `
local result = {}
local slot = game:GetService("ServerScriptService"):FindFirstChild("TypeTorchKernel")
if slot then
	result.kernel = { version = slot:GetAttribute("KernelVersion"), bootstrapHeads = slot:GetAttribute("BootstrapHeads") }
end
local backup = game:GetService("ServerStorage"):FindFirstChild("TypeTorchBackup")
if backup then
	result.backup = { channel = backup:GetAttribute("BackupChannel") or backup:GetAttribute("Channel") }
end
${PLACE_GAME_LUAU}
return result
`;
	const run = await oc.runLuau(universeId, placeId, script, 60);
	const result = run.results[0];
	if (run.state !== "COMPLETE" || !isRecord(result)) throw new Error(`task ${run.state}`);
	const backup = isRecord(result.backup) ? { present: true, ...(typeof result.backup.channel === "string" ? { channel: result.backup.channel } : {}) } : { present: false };
	return { game: placeGameFrom(result), backup };
}

/**
 * `typetorch deploy` to a branch other than the default one, while the default branch has no verified head: public
 * servers run the default branch, so this deploy didn't reach them. `kernel`: the published place has the kernel
 * (true), doesn't (false), or couldn't be read (undefined). Undefined when there is nothing to say.
 */
export function defaultBranchWarning(input: {
	config: Pick<ProjectConfig, "defaultBranch" | "branches">;
	branch: string;
	head: HeadState;
	kernel: boolean | undefined;
	backup?: { present: boolean; channel?: string };
	/** Where the kernel fact came from, when not from the place itself. */
	kernelSource?: string;
}): string | undefined {
	const { config, branch, head } = input;
	if (branch === config.defaultBranch || head.state === "verified" || head.state === "unknown" || input.kernel === false) return undefined;
	const start = `deployed to branch "${branch}", but public servers run ${config.defaultBranch}, which has no verified head (${head.detail})`;
	const fix = `Deploy it: ${deployDefaultHint(config)}`;
	if (input.kernel === undefined) return `${start}. If the published place has the kernel (0.3.6+) and no backup build, its servers move every player out after ${BOOT_BUDGET} s and kick them after ${BOUNCE_MAX} bounces (\`typetorch doctor\` checks the place). ${fix}`;
	const from = input.kernelSource ? ` (${input.kernelSource})` : "";
	if (usableBackup(input.backup)) return `${start}: the kernel in the place${from} runs its backup build there, not this deploy. ${fix}`;
	return `${start}: ${nothingToRunReason(config.defaultBranch)}${from}. ${fix}`;
}
