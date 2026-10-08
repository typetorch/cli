/**
 * The luau engine of `typetorch kernel deploy` (the default without --place-file) and `typetorch kernel restore
 * --version <n>`: the place is never downloaded (Roblox has no API-key route for place files). Every step runs in Luau
 * Execution tasks on a place version (kernelpatch-task.ts has the scripts):
 *
 *   deploy  1. base version: the Assets API version list (asset:read), the same rules as the splice engine
 *           2. the kernel slots .rbxm goes up once as a binary input (valid 15 min, reused by both tasks)
 *           3. CHECK task on /versions/{base}: patches in memory, verifies, reports; never calls SavePlaceAsync
 *           4. summary, y/N (or --yes); --dry-run stops here
 *           5. nobody published since the check (the version list again)
 *           6. SAVE task on /versions/{base}: the same patch and checks (the outside manifest must equal the check's),
 *              then AssetService:SavePlaceAsync() (publishes)
 *           7. the new version from the version list, then a VERIFY task on it (identity, slots, outside manifest)
 *   restore 1. CHECK task on /versions/{n}: that version's kernel and size; never saves
 *           2. summary, y/N; nobody published since
 *           3. SAVE task on /versions/{n}: only SavePlaceAsync, which republishes version n as the newest version
 *
 * Scopes (the place key): universe.place.luau-execution-session:read + :write, asset:read. The place needs "Allow
 * place to be updated using Save Place API" (Creator Hub, per place) and no active Team Create session.
 */
import { writeFileSync } from "node:fs";
import { chooseBase } from "./kernelpatch.ts";
import {
	BINARY_INPUT_LIMIT,
	compareSlots,
	explainSaveError,
	explainTaskFailure,
	kernelTaskScript,
	parseKernelTaskResult,
	parseRestoreTaskResult,
	restoreTaskScript,
	SAVE_SETTING,
	saveSettingUrl,
	TASK_SCRIPT_LIMIT,
	type KernelTaskConfig,
	type KernelTaskResult,
	type SettingValue,
	type SlotInventory,
} from "./kernelpatch-task.ts";
import { bold, dim, emitJson, formatBytes, formatSeconds, info, isJson, Stopwatch, warn } from "./log.ts";
import { ApiError, TaskStillRunningError, type LuauTaskResult, type OpenCloud } from "./opencloud.ts";
import type { SlotRef } from "./placepatch.ts";
import { sleep as realSleep } from "./runtime.ts";

export class LuauEngineError extends Error {
	override name = "LuauEngineError";
}

/** The Open Cloud calls the engine makes (an OpenCloud, or a fake in tests). */
export type LuauCloud = Pick<OpenCloud, "placeVersions" | "latestPlaceVersion" | "createBinaryInput" | "uploadBinaryInput" | "runLuau" | "taskLogs">;

export interface LuauDeps {
	oc: LuauCloud;
	/** Whether a person can answer y/N here. */
	interactive: boolean;
	confirm(question: string): Promise<boolean>;
	/** kernel-deploys.jsonl */
	record(entry: Record<string, unknown>): void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** How long to look for the saved version in the version list (default 60 s). */
	findVersionSeconds?: number;
}

/** A binary input is valid 15 minutes; one older than this is uploaded again before the save task. */
const INPUT_REUSE_MS = 13 * 60_000;

const scopeHint = "the place key needs universe.place.luau-execution-session:read + :write (Luau Execution) and asset:read (the place's versions)";

/** Turns an Open Cloud refusal of a Luau Execution call into a message with the fix. */
function cloudError(error: unknown, what: string): Error {
	if (error instanceof ApiError) {
		if (error.status === 401 || error.status === 403) return new LuauEngineError(`${what} was refused (${error.status}): ${scopeHint}. ${error.message}`);
		if (error.status === 429) return new LuauEngineError(`${what} stayed rate limited: Luau Execution allows 5 task creations a minute per API key owner and 10 unfinished tasks per place. Wait a minute and run again. ${error.message}`);
		if (error.status === 413 || (error.status === 400 && /size|large|limit/i.test(error.text))) {
			return new LuauEngineError(`${what} was refused as too big (Open Cloud: a binary input is at most 100 MiB, a script at most 4 MB). ${error.message}`);
		}
	}
	return error instanceof Error ? error : new Error(String(error));
}

async function logsTail(oc: LuauCloud, run: LuauTaskResult | undefined): Promise<string> {
	if (!run?.path) return "";
	const lines = (await oc.taskLogs(run.path)).slice(-8);
	return lines.length ? `\n  task log (last ${lines.length}): ${lines.join(" | ").slice(0, 1200)}` : "";
}

const pad = (label: string) => label.padEnd(9);
const kernelLabel = (k: Record<string, string | undefined>) =>
	k.KernelVersion || k.constantsVersion
		? `${k.KernelVersion ?? k.constantsVersion}${k.KernelCommit ? ` @ ${k.KernelCommit}` : ""}${k.KernelHash ? ` (hash ${k.KernelHash.slice(0, 12)})` : ""}`
		: "none";

export interface DeployInput {
	universeId: number;
	placeId: number;
	where: string;
	kernel: { version: string; hash: string; commit?: string; dirty?: boolean; api?: number };
	slots: SlotRef[];
	settings: SettingValue[];
	identitySlot: SlotRef;
	/** The kernel slots .rbxm (the binary input) and what the CLI's own reader found in it. */
	slotsBytes: Uint8Array;
	slotsFile: string;
	cliSlots: SlotInventory[];
	baseFlag?: string;
	install: boolean;
	dryRun: boolean;
	yes: boolean;
	timeoutSeconds: number;
	/** Problems that block the save (missing signing keys...); a dry run shows them only. */
	blockers: string[];
	/** The JSON report of the check (and the deploy) goes here. */
	reportPath: string;
	reportDisplay: string;
	/** Added to every kernel-deploys.jsonl record. */
	logFields: Record<string, unknown>;
}

/** The summary printed before the y/N (and by --dry-run). */
export function deploySummaryLines(input: {
	where: string;
	base: { version: number; published: boolean; skipped: number[] };
	check: KernelTaskResult;
	kernel: DeployInput["kernel"];
	slotsFile: string;
	slotsBytes: number;
	seconds?: number;
}): string[] {
	const { check, base } = input;
	const lines: string[] = [];
	lines.push(`${pad("place")} ${input.where}`);
	lines.push(`${pad("base")} v${base.version} ${base.published ? "(published)" : "(NOT published)"}  read in a Luau Execution task on /versions/${base.version} (no download)`);
	if (base.skipped.length) lines.push(`${pad("")} saved versions newer than the base are NOT shipped: ${base.skipped.map((v) => `v${v}`).join(", ")}`);
	lines.push(`${pad("kernel")} ${kernelLabel(check.oldKernel)} -> ${kernelLabel({ KernelVersion: input.kernel.version, KernelCommit: input.kernel.commit ? `${input.kernel.commit}${input.kernel.dirty ? "*" : ""}` : undefined, KernelHash: input.kernel.hash })}`);
	for (const [index, slot] of check.slots.entries()) {
		const touched = slot.nChanged || slot.nAdded || slot.nRemoved || slot.before !== slot.after;
		const mark = slot.copies === 0 ? "+" : touched ? "~" : "=";
		const parts = [`${slot.before} -> ${slot.after} instances`];
		if (slot.copies > 1) parts.push(`${slot.copies} copies replaced by one`);
		const more = (n: number, shown: string[]) => (n > shown.length ? `, +${n - shown.length} more` : "");
		if (slot.nChanged) parts.push(`changed: ${slot.changed.join(", ")}${more(slot.nChanged, slot.changed)}`);
		if (slot.nAdded && slot.copies > 0) parts.push(`added: ${slot.added.join(", ")}${more(slot.nAdded, slot.added)}`);
		if (slot.nRemoved) parts.push(`removed: ${slot.removed.join(", ")}${more(slot.nRemoved, slot.removed)}`);
		if (mark === "=") parts.push("scripts unchanged (attributes re-stamped)");
		lines.push(`${pad(index === 0 ? "slots" : "")} ${mark} ${slot.slot.padEnd(40)} ${parts.join("; ")}`);
	}
	const settings = check.settings.map((s) => `${s.path} ${s.error ? `CAN'T BE SET (${s.error})` : s.changed ? `${s.before ?? "(unreadable)"} -> ${s.after ?? s.want}` : `${s.after ?? s.want} (unchanged)`}`);
	if (settings.length) lines.push(`${pad("settings")} ${settings.join("; ")}`);
	if (check.addedServices.length) lines.push(`${pad("services")} added: ${check.addedServices.join(", ")}`);
	if (check.refs.nRemapped || check.refs.nCleared) {
		lines.push(`${pad("refs")} ObjectValues into the old kernel: ${check.refs.nRemapped} re-pointed by path, ${check.refs.nCleared} cleared${check.refs.cleared.length ? ` (${check.refs.cleared.slice(0, 5).join("; ")})` : ""}`);
	}
	const o = check.outside;
	const how = o.unstable ? `; ${o.unstable} subtree(s) compared by descriptor only (their bytes differ between two reads)` : "";
	const odd = [o.unserializable ? `${o.unserializable} not serializable (descriptor only)` : "", o.unreadable ? `${o.unreadable} unreadable` : ""].filter(Boolean).join(", ");
	lines.push(`${pad("outside")} ${o.instances} instances in ${o.subtrees} subtrees of ${o.services} services, ${o.nChanged === 0 ? "unchanged" : `CHANGED (${o.nChanged})`} after the patch (descriptor + serialized bytes${how})${odd ? `; ${odd}` : ""}`);
	lines.push(`${pad("input")} ${input.slotsFile}  ${formatBytes(input.slotsBytes)} (binary input; limit 100 MiB)`);
	lines.push(`${pad("engine")} luau: the save task repeats this patch on v${base.version} and calls AssetService:SavePlaceAsync() (publishes); undo: typetorch kernel restore --version ${base.version}`);
	if (check.sourceUnreadable) lines.push(`${pad("")} ${check.sourceUnreadable} script source(s) couldn't be read in the task: changed scripts aren't listed (added and removed ones are), and scripts outside the slots are compared by their serialized bytes`);
	if (check.hashMode && check.hashMode !== "sha256") lines.push(`${pad("")} the task hashed with ${check.hashMode} (EncodingService's SHA-256 wasn't available)`);
	if (input.seconds !== undefined) lines.push(`${pad("check")} task ${formatSeconds(input.seconds)}${check.timings.total !== undefined ? ` (Luau ${formatSeconds(check.timings.total)})` : ""}`);
	return lines;
}

/** Finds the version a save made: the newest version once it is above `above` (polls the version list). */
export async function findSavedVersion(deps: LuauDeps, placeId: number, above: number): Promise<{ version: number; published: boolean } | undefined> {
	const sleep = deps.sleep ?? realSleep;
	const deadline = (deps.now ?? Date.now)() + (deps.findVersionSeconds ?? 60) * 1000;
	while (true) {
		try {
			const [newest] = await deps.oc.placeVersions(placeId, 1);
			if (newest && newest.version > above) return { version: newest.version, published: newest.published };
		} catch {}
		if ((deps.now ?? Date.now)() >= deadline) return undefined;
		await sleep(2000);
	}
}

/** A task, with its failure explained (and the version list checked when it may have saved). */
export async function runTask(deps: LuauDeps, input: { universeId: number; placeId: number; version: number; script: string; timeoutSeconds: number; binaryInput?: string; what: string }): Promise<LuauTaskResult> {
	if (input.script.length > TASK_SCRIPT_LIMIT) throw new LuauEngineError(`the ${input.what} script is ${formatBytes(input.script.length)}, over Open Cloud's 4 MB task script limit (a CLI bug)`);
	let run: LuauTaskResult;
	try {
		run = await deps.oc.runLuau(input.universeId, input.placeId, input.script, input.timeoutSeconds, { version: input.version, ...(input.binaryInput ? { binaryInput: input.binaryInput } : {}) });
	} catch (error) {
		if (error instanceof TaskStillRunningError) {
			throw new LuauEngineError(`the ${input.what} is still ${error.state.toLowerCase()} a minute past its ${input.timeoutSeconds} s timeout (${error.taskPath}); Roblox may be slow. It may still finish`);
		}
		throw cloudError(error, `creating the ${input.what}`);
	}
	if (run.state !== "COMPLETE") {
		throw new LuauEngineError(`${explainTaskFailure(run.error, input.timeoutSeconds)} (${input.what}, state ${run.state})${await logsTail(deps.oc, run)}`);
	}
	return run;
}

/** Sends the kernel slots .rbxm as a binary input; returns its path and when it was made. */
export async function sendInput(deps: LuauDeps, universeId: number, bytes: Uint8Array): Promise<{ path: string; at: number }> {
	if (bytes.length > BINARY_INPUT_LIMIT) {
		throw new LuauEngineError(
			`the kernel slots .rbxm is ${formatBytes(bytes.length)}, over Open Cloud's 100 MiB binary input limit. The backup build (ServerStorage.TypeTorchBackup, the prod payload) is most of it: --no-backup leaves the place's current backup as it is`,
		);
	}
	let input: { path: string; uploadUri: string };
	try {
		input = await deps.oc.createBinaryInput(universeId, bytes.length);
	} catch (error) {
		throw cloudError(error, "creating the task's binary input");
	}
	await deps.oc.uploadBinaryInput(input.uploadUri, bytes);
	return { path: input.path, at: (deps.now ?? Date.now)() };
}

/** `typetorch kernel deploy --engine luau`. */
export async function luauDeploy(input: DeployInput, deps: LuauDeps): Promise<void> {
	const { universeId, placeId } = input;
	const watch = new Stopwatch();

	// 1. The base version (Assets API; the place version history API needs a key scoped to all resources).
	let versions;
	try {
		versions = await watch.stage("versions", () => deps.oc.placeVersions(placeId, 1));
	} catch (error) {
		if (error instanceof ApiError && error.isScopeError) throw new LuauEngineError(`listing the place's versions needs asset:read on the place key: ${error.message}`);
		throw error;
	}
	const choice = chooseBase(versions, input.baseFlag);
	if (!choice.ok) throw new LuauEngineError(choice.reason);
	const base = { version: choice.version, newest: versions[0].version, published: choice.published, skipped: choice.skipped };

	// 2. The kernel slots, once (reused by the save task while it is valid).
	let sent = await watch.stage("input", () => sendInput(deps, universeId, input.slotsBytes));

	// 3. The check task.
	const config: KernelTaskConfig = {
		mode: "check",
		placeId,
		placeVersion: base.version,
		slots: input.slots,
		settings: input.settings,
		install: input.install,
		identitySlot: input.identitySlot,
		expect: { KernelVersion: input.kernel.version, KernelHash: input.kernel.hash },
	};
	const checkRun = await watch.stage("check", () => runTask(deps, { universeId, placeId, version: base.version, script: kernelTaskScript(config), timeoutSeconds: input.timeoutSeconds, binaryInput: sent.path, what: "check task" }));
	const check = parseKernelTaskResult(checkRun.results);
	const crossCheck = compareSlots(check.newSlots, input.cliSlots, check.hashMode);
	const problems = [...check.problems, ...crossCheck.map((p) => `the task's slots vs the kernel build: ${p}`)];
	const report = { universeId, placeId, engine: "luau", base, kernel: input.kernel, slots: input.slots, settings: input.settings, check, crossCheck, cliSlots: input.cliSlots, task: checkRun.path, ...input.logFields };
	writeFileSync(input.reportPath, JSON.stringify(report, null, "\t"));
	if (!isJson()) {
		info("");
		for (const line of deploySummaryLines({ where: input.where, base, check, kernel: input.kernel, slotsFile: input.slotsFile, slotsBytes: input.slotsBytes.length, seconds: watch.timings.check })) info(`  ${line}`);
		info(dim(`  report   ${input.reportDisplay}`));
		for (const line of check.warnings) warn(line);
		info("");
	}
	if (problems.length > 0) {
		const settingsFix = check.settings.some((s) => s.error)
			? `\n  A setting a task can't write is set once in Studio and published: HttpEnabled under Game Settings > Security > Allow HTTP Requests; LoadStringEnabled in ServerScriptService's properties, then deploy without --loadstring (a patch keeps the place's value). Or patch a Studio copy: --place-file <file> --base <version>`
			: "";
		throw new LuauEngineError(`the check task found problems (nothing saved; report in ${input.reportDisplay}):\n  - ${problems.slice(0, 15).join("\n  - ")}${settingsFix}`);
	}
	if (check.firstInstall && !input.install) {
		const text = `place ${placeId} v${base.version} has no TypeTorch kernel yet (none of ${input.slots.map((s) => `${s.service}.${s.name}`).join(", ")}): a first install adds them; check the summary, then run again with --install`;
		if (!input.dryRun) throw new LuauEngineError(text);
		warn(text);
	}

	// 4. Dry run: stop (the check task never calls SavePlaceAsync).
	if (input.dryRun) {
		if (isJson()) return emitJson({ dryRun: true, ...report });
		info(bold(`dry run: kernel ${input.kernel.version} patched into v${base.version} inside a Luau Execution task; nothing saved`));
		info(dim(`  deploy: typetorch kernel deploy${input.baseFlag ? ` --base ${input.baseFlag}` : ""}${check.firstInstall ? " --install" : ""} (checks again, asks y/N, then saves)`));
		if (input.blockers.length) warn(`a real deploy would refuse: ${input.blockers.join("; ")}`);
		return;
	}
	if (input.blockers.length > 0) throw new LuauEngineError(`refusing to save a kernel that can't verify prod deploys:\n  - ${input.blockers.join("\n  - ")}`);
	if (!input.yes) {
		if (!deps.interactive) throw new LuauEngineError("refusing to save without --yes (no interactive terminal to ask); check the summary above, then run again with --yes");
		if (!(await deps.confirm(`Save the patched place as the new live version of place ${placeId} (SavePlaceAsync in a Luau Execution task)?`))) {
			info("not saved");
			return;
		}
	}

	// 5. Nobody published since the base was chosen.
	let latest: number;
	try {
		latest = await deps.oc.latestPlaceVersion(placeId);
	} catch (error) {
		throw new LuauEngineError(`can't read the place's current version (asset:read on the place key), so the deploy can't check that nobody published since v${base.newest}: ${(error as Error).message}`);
	}
	if (latest !== base.newest) throw new LuauEngineError(`the place changed since the check (newest version then v${base.newest}, now v${latest}); nothing saved. Run the deploy again to patch the new version`);

	// 6. The save task: the same patch, the same outside manifest, then SavePlaceAsync.
	if ((deps.now ?? Date.now)() - sent.at > INPUT_REUSE_MS) sent = await watch.stage("input", () => sendInput(deps, universeId, input.slotsBytes));
	const record = { universeId, placeId, mode: "patch", engine: "luau", base, placeVersionBefore: base.version, newestBefore: base.newest, firstInstall: check.firstInstall, oldKernel: check.oldKernel, kernelVersion: input.kernel.version, kernelHash: input.kernel.hash, kernelCommit: input.kernel.commit, kernelApi: input.kernel.api, outside: check.outside.rootD, ...input.logFields };
	deps.record({ event: "kernel-publishing", ...record });
	let save: KernelTaskResult;
	let saveRun: LuauTaskResult;
	try {
		saveRun = await watch.stage("save", () =>
			runTask(deps, { universeId, placeId, version: base.version, script: kernelTaskScript({ ...config, mode: "save", expectOutside: check.outside.rootD, expectOutsideList: check.outside.dlist }), timeoutSeconds: input.timeoutSeconds, binaryInput: sent.path, what: "save task" }),
		);
		save = parseKernelTaskResult(saveRun.results);
	} catch (error) {
		const after = await findSavedVersion({ ...deps, findVersionSeconds: 6 }, placeId, base.newest);
		deps.record({ event: "kernel-failed", ...record, error: (error as Error).message.slice(0, 500), placeVersionAfter: after?.version ?? null });
		throw new LuauEngineError(
			`${(error as Error).message}\n  ${after ? `a new version v${after.version} appeared: the save may have gone through. Check it (typetorch kernel deploy --dry-run reads the kernel in it); undo: typetorch kernel restore --version ${base.version}` : "no new version appeared: nothing was published"}`,
		);
	}
	if (!save.saved) {
		const explained = save.saveError ? explainSaveError(save.saveError, { universeId, placeId }).text : `the save task found problems, nothing saved:\n  - ${save.problems.slice(0, 15).join("\n  - ")}`;
		deps.record({ event: "kernel-failed", ...record, error: explained.slice(0, 500), task: saveRun.path });
		throw new LuauEngineError(explained);
	}

	// 7. The new version, and a verify task on it.
	const saved = await watch.stage("find", () => findSavedVersion(deps, placeId, base.newest));
	let verify: { ok: boolean; problems: string[]; task?: string } | undefined;
	if (saved) {
		try {
			const verifyRun = await watch.stage("verify", () => runTask(deps, { universeId, placeId, version: saved.version, script: kernelTaskScript({ ...config, mode: "verify", placeVersion: saved.version }), timeoutSeconds: input.timeoutSeconds, what: "verify task" }));
			const v = parseKernelTaskResult(verifyRun.results);
			const vProblems = [...v.problems];
			for (const [key, value] of Object.entries(config.expect)) if (v.identity[key] !== value) vProblems.push(`the saved kernel's ${key} is ${v.identity[key] ?? "missing"}, expected ${value}`);
			vProblems.push(...compareSlots(v.newSlots, input.cliSlots, v.hashMode));
			if (save.outside.afterD && v.outside.rootD && v.outside.rootD !== save.outside.afterD) vProblems.push(`the content outside the kernel in v${saved.version} differs from what the save task wrote (descriptor ${v.outside.rootD.slice(0, 12)} vs ${save.outside.afterD.slice(0, 12)})`);
			verify = { ok: vProblems.length === 0, problems: vProblems, task: verifyRun.path };
		} catch (error) {
			verify = { ok: false, problems: [`the verify task didn't run: ${(error as Error).message}`] };
		}
	}
	const timings = watch.total();
	const done = { ...record, placeVersionAfter: saved?.version ?? null, publishedAfter: saved?.published ?? null, verify, task: saveRun.path, timings };
	deps.record({ event: "kernel-published", ...done });
	writeFileSync(input.reportPath, JSON.stringify({ ...report, save, saved, verify }, null, "\t"));
	if (isJson()) return emitJson(done);
	info(`  save     ${formatSeconds(timings.save)}  place version ${base.newest} -> ${saved ? `${saved.version}${saved.published ? " (published)" : " (NOT marked published)"}` : "? (not in the version list yet)"}`);
	if (!saved) warn(`the saved version didn't show up in the place's version list within a minute; check Creator Hub > the place > Version History`);
	else if (!saved.published) warn(`v${saved.version} isn't marked published: SavePlaceAsync should publish (SaveWithoutPublish defaults to false); check Creator Hub`);
	if (verify && !verify.ok) warn(`the verify task on v${saved?.version} found problems:\n  - ${verify.problems.slice(0, 10).join("\n  - ")}\n  undo: typetorch kernel restore --version ${base.version}`);
	else if (verify) info(`  verify   ${formatSeconds(timings.verify ?? 0)}  v${saved?.version}: kernel ${input.kernel.version}, slots and outside content as checked`);
	info(bold(`published kernel ${input.kernel.version} (hash ${input.kernel.hash.slice(0, 16)}) into ${input.where}; servers run it after they restart`));
	info(dim(`  undo: typetorch kernel restore --version ${base.version}`));
}

export interface RestoreInput {
	universeId: number;
	placeId: number;
	where: string;
	version: number;
	identitySlot: SlotRef;
	dryRun: boolean;
	yes: boolean;
	timeoutSeconds: number;
}

/** `typetorch kernel restore --version <n>`: republish version n through SavePlaceAsync in a task on it. */
export async function luauRestore(input: RestoreInput, deps: LuauDeps): Promise<void> {
	const { universeId, placeId, version } = input;
	const watch = new Stopwatch();
	let versions;
	try {
		versions = await watch.stage("versions", () => deps.oc.placeVersions(placeId, 1));
	} catch (error) {
		if (error instanceof ApiError && error.isScopeError) throw new LuauEngineError(`listing the place's versions needs asset:read on the place key: ${error.message}`);
		throw error;
	}
	const newest = versions[0]?.version;
	if (newest === undefined) throw new LuauEngineError("the place has no versions");
	if (version > newest) throw new LuauEngineError(`place ${placeId} has no v${version} yet (newest: v${newest})`);
	const listed = versions.find((v) => v.version === version);
	const config = { placeId, placeVersion: version, save: false, identitySlot: input.identitySlot };
	const checkRun = await watch.stage("check", () => runTask(deps, { universeId, placeId, version, script: restoreTaskScript(config), timeoutSeconds: input.timeoutSeconds, what: "restore check task" }));
	const check = parseRestoreTaskResult(checkRun.results);
	if (check.problem) throw new LuauEngineError(check.problem);
	if (!isJson()) {
		info(`  place    ${input.where}, now at v${newest}`);
		info(`  version  v${version}${listed ? (listed.published ? " (published)" : " (a save, never published)") : " (older than the version list shows)"}: ${check.instances} instances in ${check.services} services, kernel ${kernelLabel(check.identity)}`);
		info(`  engine   luau: a task on /versions/${version} calls AssetService:SavePlaceAsync(), which publishes it as v${newest + 1} (no download)`);
	}
	warn(`this publishes v${version} as the new live version of place ${placeId}: everything published after it (Studio work, other kernel deploys) leaves the live place (it stays in version history)${version < newest ? ` (v${version + 1}..v${newest})` : ""}`);
	if (version === newest) warn(`v${version} is already the newest version: this only publishes it again`);
	if (input.dryRun) {
		if (isJson()) return emitJson({ dryRun: true, placeId, version, newest, check });
		info(bold("dry run: nothing saved (the check task never calls SavePlaceAsync)"));
		return;
	}
	if (!input.yes) {
		if (!deps.interactive) throw new LuauEngineError("refusing to save without --yes (no interactive terminal to ask)");
		if (!(await deps.confirm(`Publish v${version} as the new live version of place ${placeId}?`))) {
			info("not saved");
			return;
		}
	}
	let latest: number;
	try {
		latest = await deps.oc.latestPlaceVersion(placeId);
	} catch (error) {
		throw new LuauEngineError(`can't read the place's current version (asset:read on the place key): ${(error as Error).message}`);
	}
	if (latest !== newest) throw new LuauEngineError(`the place changed since the check (newest then v${newest}, now v${latest}); nothing saved. Run the restore again`);
	const record = { universeId, placeId, mode: "restore", engine: "luau", fromVersion: version, fileKernel: check.identity.KernelVersion ?? check.identity.constantsVersion ?? null, placeVersionBefore: newest };
	deps.record({ event: "kernel-restoring", ...record });
	let save;
	let saveRun: LuauTaskResult;
	try {
		saveRun = await watch.stage("save", () => runTask(deps, { universeId, placeId, version, script: restoreTaskScript({ ...config, save: true }), timeoutSeconds: input.timeoutSeconds, what: "restore save task" }));
		save = parseRestoreTaskResult(saveRun.results);
	} catch (error) {
		const after = await findSavedVersion({ ...deps, findVersionSeconds: 6 }, placeId, newest);
		deps.record({ event: "kernel-restore-failed", ...record, error: (error as Error).message.slice(0, 500), placeVersionAfter: after?.version ?? null });
		throw new LuauEngineError(`${(error as Error).message}\n  ${after ? `a new version v${after.version} appeared: the restore may have gone through; check it` : "no new version appeared: nothing was published"}`);
	}
	if (!save.saved) {
		const explained = save.saveError ? explainSaveError(save.saveError, { universeId, placeId }).text : `the restore task didn't save: ${save.problem ?? "no reason given"}`;
		deps.record({ event: "kernel-restore-failed", ...record, error: explained.slice(0, 500), task: saveRun.path });
		throw new LuauEngineError(explained);
	}
	const saved = await watch.stage("find", () => findSavedVersion(deps, placeId, newest));
	const done = { ...record, placeVersionAfter: saved?.version ?? null, publishedAfter: saved?.published ?? null, task: saveRun.path, timings: watch.total() };
	deps.record({ event: "kernel-restored", ...done });
	if (isJson()) return emitJson(done);
	info(`  save     ${formatSeconds(watch.timings.save)}  place version ${newest} -> ${saved ? `${saved.version}${saved.published ? " (published)" : " (NOT marked published)"}` : "? (not in the version list yet)"}`);
	info(bold(`published v${version} of place ${placeId} again; servers run it after they restart`));
}

/** The place setting, for help texts and doctor. */
export const SAVE_SETTING_HELP = (universeId: number, placeId: number) => `"${SAVE_SETTING}": Creator Hub > Creations > the experience > Places > the place > Permissions (${saveSettingUrl(universeId, placeId)})`;
