/**
 * Fresh backups (kernel 0.3.6's `ServerStorage.TypeTorchBackup`, the build a server runs only when nothing else can):
 * the place's backup should be at most one deploy behind, without a kernel deploy each time.
 *
 * - `typetorch backup refresh [--build <x>] [--dry-run] [--yes] [--force]`: puts a prod build's kept payload into the
 *   place as the backup, now. The luau engine (kernel-luau.ts) with ONLY the backup slot: a check task, y/N, a save task
 *   (SavePlaceAsync), the same outside-the-slot guard and the same Team Create / Save Place API errors as `kernel
 *   deploy`. Default build: the prod head. A build that isn't proven healthy is refused unless --force.
 * - Automatically, inside the owner's own prod runs: after `typetorch deploy` / `approve` / `promote` publishes build
 *   N+1 to the default (prod-channel) branch at an interactive terminal, the place's backup becomes build N when N ran
 *   with no failure for `backup.healthyHours` (typetorch.json, default 3 h). It never blocks or fails the deploy: every
 *   reason not to (unpublished saves, Team Create, the setting off, N not proven, no kept payload, no place key, not a
 *   terminal) is one line, and the deploy's own result is unchanged. `"backup": { "refresh": "off" }` turns it off.
 *
 * "Proven healthy": the fleet API has reports for N's seq, none failed or rolled back, no server running N is failed
 * or degraded, and N went out at least healthyHours ago (this machine's deployment log). No fleet API, no proof.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { OUT_DIR } from "../build.ts";
import { BACKUP_DEFAULTS, type Project } from "../config.ts";
import { matchDeployment, type LiveHead } from "../deployments.ts";
import { formatCounts, summarize, type FleetClient } from "../fleet.ts";
import { interaction } from "../interact.ts";
import { chooseBase } from "../kernelpatch.ts";
import { explainSaveError, kernelTaskScript, parseKernelTaskResult, compareSlots, SLOTS_ROOT, type KernelTaskConfig, type SlotInventory } from "../kernelpatch-task.ts";
import { findSavedVersion, LuauEngineError, runTask, sendInput, type LuauDeps } from "../kernel-luau.ts";
import { bold, dim, emitJson, info, isJson, Stopwatch, warn } from "../log.ts";
import { branchChannel, type Channel } from "../naming.ts";
import { BACKUP_FILE, BACKUP_SLOT, BackupError, backupHead, backupRbxm, findKeptPayload, type BackupInfo } from "../payloads.ts";
import { openCloud, project, projectStateDir, readHistory } from "./common.ts";
import { fleetFor } from "./fleet.ts";
import { buildSlotsRbxm, IDENTITY_SLOT, KERNEL_LOG, luauDeps, taskTimeout } from "./kernel.ts";

export const backupFlags = { build: "string", "dry-run": "boolean", yes: "boolean", force: "boolean", timeout: "string" } as const;

/** The backup slot's own .rbxm (the binary input of a refresh). */
export const BACKUP_SLOTS_FILE = `${OUT_DIR}/backup-slots.rbxm`;

export interface BuildRef {
	branch: string;
	seq: number;
	artifactId: string;
	assetId?: number;
	/** ISO time it went out (this machine's log). */
	at?: string;
}

/** Whether a prod build has run long enough without a failure to become the backup. */
export async function provenHealthy(fleet: FleetClient | undefined, build: BuildRef, minHours: number, now = Date.now()): Promise<{ proven: boolean; reason: string }> {
	const label = `#${build.seq} ${build.artifactId}`;
	const at = build.at ? Date.parse(build.at) : Number.NaN;
	if (Number.isNaN(at)) return { proven: false, reason: `when ${label} went out isn't in this machine's deployment log` };
	const hours = (now - at) / 3_600_000;
	if (hours < minHours) return { proven: false, reason: `${label} has been live ${hours.toFixed(1)} h, under the ${minHours} h it needs (typetorch.json backup.healthyHours)` };
	if (!fleet) return { proven: false, reason: `no fleet API to prove ${label} healthy (typetorch fleet setup)` };
	let reports;
	let servers;
	try {
		[reports, servers] = await Promise.all([fleet.reports({ seq: build.seq, branch: build.branch }), fleet.servers({ branch: build.branch })]);
	} catch (error) {
		return { proven: false, reason: `the fleet API didn't answer: ${(error as Error).message}` };
	}
	const summary = summarize({ seq: build.seq, branch: build.branch, artifactId: build.artifactId, reports, servers });
	if (summary.reports === 0) return { proven: false, reason: `no server reported ${label}` };
	if (summary.bad) return { proven: false, reason: `${label} failed or rolled back on some servers (${formatCounts(summary.counts)})` };
	const sick = servers.filter((s) => s.artifactId === build.artifactId && (s.health === "failed" || s.health === "degraded"));
	if (sick.length) return { proven: false, reason: `${sick.length} server(s) running ${label} are ${[...new Set(sick.map((s) => s.health))].join("/")}` };
	return { proven: true, reason: `${label}: live ${hours.toFixed(1)} h, ${formatCounts(summary.counts)}, no failures` };
}

/** The last backup build this machine put into the place (kernel deploy's backupBuild, or a refresh), if it knows. */
export function lastBackupHere(stateDir: string, placeId: number): string | undefined {
	const path = join(stateDir, KERNEL_LOG);
	if (!existsSync(path)) return undefined;
	let last: string | undefined;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (record.placeId !== placeId) continue;
			if (record.event === "kernel-published" && typeof record.backupBuild?.artifactId === "string") last = record.backupBuild.artifactId;
			if (record.event === "backup-refreshed" && typeof record.artifactId === "string") last = record.artifactId;
		} catch {}
	}
	return last;
}

export type BackupOutcome =
	| { status: "refreshed"; artifactId: string; placeVersionBefore: number; placeVersionAfter?: number; verified?: boolean; problems?: string[] }
	| { status: "skipped"; reason: string; already?: boolean }
	| { status: "dry-run"; artifactId: string; placeVersion: number; current?: string }
	| { status: "declined" };

export interface RefreshInput {
	universeId: number;
	placeId: number;
	build: BuildRef;
	/** The backup slot's .rbxm and what the CLI's reader found in it. */
	slotsBytes: Uint8Array;
	cliSlots: SlotInventory[];
	dryRun: boolean;
	/** No y/N (auto refresh inside a deploy the owner approved, or --yes). */
	yes: boolean;
	timeoutSeconds: number;
}

/**
 * The luau engine with the backup slot only. Never throws for the expected refusals: they come back as "skipped" with
 * the reason (the auto refresh prints it as one line; the command turns it into an error).
 */
export async function refreshBackup(input: RefreshInput, deps: LuauDeps): Promise<BackupOutcome> {
	const { universeId, placeId, build } = input;
	try {
		const versions = await deps.oc.placeVersions(placeId, 1);
		const choice = chooseBase(versions);
		if (!choice.ok) return { status: "skipped", reason: choice.reason.replace(/\. Pass --base.*$/, "; refresh after the next publish") };
		const base = { version: choice.version, newest: versions[0].version };
		let sent = await sendInput(deps, universeId, input.slotsBytes);
		const config: KernelTaskConfig = {
			mode: "check",
			placeId,
			placeVersion: base.version,
			slots: [BACKUP_SLOT],
			settings: [],
			install: true,
			identitySlot: IDENTITY_SLOT,
			expect: { BackupArtifactId: build.artifactId },
		};
		const check = parseKernelTaskResult((await runTask(deps, { universeId, placeId, version: base.version, script: kernelTaskScript(config), timeoutSeconds: input.timeoutSeconds, binaryInput: sent.path, what: "backup check task" })).results);
		if (check.oldKernel.present !== "true") return { status: "skipped", reason: `place ${placeId} v${base.version} has no TypeTorch kernel: typetorch kernel deploy installs the kernel and its backup` };
		if (check.oldKernel.BackupArtifactId === build.artifactId) return { status: "skipped", reason: `the place's backup is already ${build.artifactId}`, already: true };
		const problems = [...check.problems, ...compareSlots(check.newSlots, input.cliSlots, check.hashMode)];
		if (problems.length) return { status: "skipped", reason: `the check task found problems: ${problems.slice(0, 5).join("; ")}` };
		if (input.dryRun) return { status: "dry-run", artifactId: build.artifactId, placeVersion: base.version, current: check.oldKernel.BackupArtifactId };
		if (!input.yes) {
			if (!deps.interactive) throw new UsageError("refusing to save without --yes (no interactive terminal to ask)");
			const from = check.oldKernel.BackupArtifactId ? ` (now ${check.oldKernel.BackupArtifactId})` : " (the place has none)";
			if (!(await deps.confirm(`Make ${build.artifactId} (#${build.seq}) the backup build of place ${placeId}${from}? This saves the place (SavePlaceAsync)`))) return { status: "declined" };
		}
		const latest = await deps.oc.latestPlaceVersion(placeId);
		if (latest !== base.newest) return { status: "skipped", reason: `the place changed since the check (v${base.newest} then, v${latest} now)` };
		if ((deps.now ?? Date.now)() - sent.at > 13 * 60_000) sent = await sendInput(deps, universeId, input.slotsBytes);
		const record = { universeId, placeId, mode: "backup", engine: "luau", artifactId: build.artifactId, seq: build.seq, branch: build.branch, previous: check.oldKernel.BackupArtifactId ?? null, placeVersionBefore: base.version };
		deps.record({ event: "backup-refreshing", ...record });
		const save = parseKernelTaskResult(
			(await runTask(deps, { universeId, placeId, version: base.version, script: kernelTaskScript({ ...config, mode: "save", expectOutside: check.outside.rootD }), timeoutSeconds: input.timeoutSeconds, binaryInput: sent.path, what: "backup save task" })).results,
		);
		if (!save.saved) {
			const reason = save.saveError ? explainSaveError(save.saveError, { universeId, placeId }).text : `the save task found problems: ${save.problems.slice(0, 5).join("; ")}`;
			deps.record({ event: "backup-failed", ...record, error: reason.slice(0, 500) });
			return { status: "skipped", reason };
		}
		const saved = await findSavedVersion(deps, placeId, base.newest);
		let verified: boolean | undefined;
		const verifyProblems: string[] = [];
		if (saved) {
			try {
				const v = parseKernelTaskResult((await runTask(deps, { universeId, placeId, version: saved.version, script: kernelTaskScript({ ...config, mode: "verify", placeVersion: saved.version }), timeoutSeconds: input.timeoutSeconds, what: "backup verify task" })).results);
				if (v.identity.BackupArtifactId !== build.artifactId) verifyProblems.push(`the saved backup is ${v.identity.BackupArtifactId ?? "missing"}`);
				if (save.outside.afterD && v.outside.rootD !== save.outside.afterD) verifyProblems.push("the content outside the backup slot differs from what the save task wrote");
				verifyProblems.push(...v.problems);
				verified = verifyProblems.length === 0;
			} catch (error) {
				verifyProblems.push(`the verify task didn't run: ${(error as Error).message}`);
				verified = false;
			}
		}
		deps.record({ event: "backup-refreshed", ...record, placeVersionAfter: saved?.version ?? null, verified: verified ?? null });
		return { status: "refreshed", artifactId: build.artifactId, placeVersionBefore: base.newest, placeVersionAfter: saved?.version, verified, ...(verifyProblems.length ? { problems: verifyProblems } : {}) };
	} catch (error) {
		if (error instanceof UsageError) throw error;
		return { status: "skipped", reason: (error as Error).message };
	}
}

/** The backup slot's .rbxm for a build: its kept payload stamped as the backup, under the slots root. */
export async function backupSlots(proj: Project, build: BuildRef, now = new Date()): Promise<{ bytes: Uint8Array; cliSlots: SlotInventory[] }> {
	const stateDir = projectStateDir(proj);
	const source = findKeptPayload(stateDir, build.artifactId);
	if (!source) throw new BackupError(`${build.artifactId} has no kept payload on this machine (payloads are kept at upload, CLI 0.7.4+): re-upload or rebuild it here first`);
	const info: BackupInfo = { artifactId: build.artifactId, seq: build.seq, branch: build.branch, channel: "prod", at: now.toISOString() };
	const model = join(proj.root, OUT_DIR, BACKUP_FILE);
	writeFileSync(model, backupRbxm(new Uint8Array(readFileSync(source)), info));
	const projectJson = { name: SLOTS_ROOT, tree: { $className: "Folder", [BACKUP_SLOT.service]: { $className: "Folder", [BACKUP_SLOT.name]: { $path: model.replace(/\\/g, "/") } } } };
	const built = await buildSlotsRbxm(proj, projectJson, [BACKUP_SLOT], BACKUP_SLOT, BACKUP_SLOTS_FILE);
	return { bytes: built.bytes, cliSlots: built.read.slots };
}

const line = (text: string) => info(`  backup      ${text}`);

/**
 * After a prod release at the owner's terminal: refresh the place's backup to the build it replaced, when that build is
 * proven healthy. Prints one or two lines; never throws (the deploy is already done and stays done).
 */
export async function autoRefreshBackup(input: {
	proj: Project;
	action: string;
	branch: string;
	branchChannel: Channel;
	/** The branch's head before this release (the build that becomes the backup). */
	previous?: Pick<LiveHead, "artifactId" | "assetId" | "seq"> & { deployedAt?: string };
	interactive?: boolean;
	/** Tests: a fake engine, fleet and slot builder. */
	deps?: { luau?: LuauDeps; fleet?: FleetClient | null; slots?: (build: BuildRef) => Promise<{ bytes: Uint8Array; cliSlots: SlotInventory[] }>; now?: number };
}): Promise<BackupOutcome | undefined> {
	const { proj, previous } = input;
	try {
		if (input.branchChannel !== "prod" || (input.action !== "deploy" && input.action !== "promote")) return undefined;
		const settings = proj.config.backup ?? BACKUP_DEFAULTS;
		if (settings.refresh === "off") return undefined;
		// The backup is made from the default branch's head (payloads.ts backupHead): only its releases move it.
		if (input.branch !== proj.config.defaultBranch && branchChannel(proj.config, proj.config.defaultBranch) === "prod") return undefined;
		const skip = (reason: string): BackupOutcome => {
			line(dim(`not refreshed: ${reason}`));
			return { status: "skipped", reason };
		};
		if (!previous) return skip("no previous build on this branch");
		if (!(input.interactive ?? interaction().interactive)) return skip(`not an interactive run (later: typetorch backup refresh --build #${previous.seq})`);
		const stateDir = projectStateDir(proj);
		if (lastBackupHere(stateDir, proj.config.placeId) === previous.artifactId) return skip(`the place's backup is already ${previous.artifactId}`);
		// A proposal's `from` has no time: this machine's log has it.
		const at = previous.deployedAt ?? (await readHistory(proj)).rows.find((r) => r.seq === previous.seq && r.branch === input.branch)?.at;
		const build: BuildRef = { branch: input.branch, seq: previous.seq, artifactId: previous.artifactId, assetId: previous.assetId, at };
		const fleet = input.deps && "fleet" in input.deps ? (input.deps.fleet ?? undefined) : fleetFor(proj).client;
		const health = await provenHealthy(fleet, build, settings.healthyHours, input.deps?.now);
		if (!health.proven) return skip(`${health.reason} (later: typetorch backup refresh --build #${previous.seq})`);
		const luau = input.deps?.luau ?? (openCloud("place", true) ? luauDeps(proj) : undefined);
		if (!luau) return skip("no place key (OPENCLOUD_PLACE_KEY or the shared key)");
		const slots = await (input.deps?.slots ?? ((b: BuildRef) => backupSlots(proj, b)))(build);
		line(`refreshing to #${build.seq} ${build.artifactId} (${health.reason}); the deploy itself is done`);
		const outcome = await refreshBackup({ universeId: proj.config.universeId, placeId: proj.config.placeId, build, slotsBytes: slots.bytes, cliSlots: slots.cliSlots, dryRun: false, yes: true, timeoutSeconds: 300 }, luau);
		if (outcome.status === "refreshed") {
			line(`${build.artifactId} is the backup build now (place v${outcome.placeVersionBefore} -> v${outcome.placeVersionAfter ?? "?"})${outcome.verified === false ? `; verify: ${outcome.problems?.join("; ")}` : ""}`);
			assetsNote(proj);
		} else if (outcome.status === "skipped") line(dim(`not refreshed: ${outcome.reason}`));
		return outcome;
	} catch (error) {
		line(dim(`not refreshed: ${(error as Error).message}`));
		return { status: "skipped", reason: (error as Error).message };
	}
}

/** A saved place has a new version: hot assets baked for the old one are loaded from the asset store until the next sync. */
function assetsNote(proj: Project) {
	if (existsSync(join(proj.root, "typetorch.assets.lock.json"))) {
		info(dim("              the place has a new version: new servers load hot assets from their asset versions (not the place's copies) until the next typetorch assets sync"));
	}
}

/** `typetorch backup refresh [--build <x>] [--dry-run] [--yes] [--force] [--timeout <s>]`. */
export async function backupCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub !== "refresh") throw new UsageError(`unknown backup subcommand "${sub ?? ""}" (refresh)`);
	const proj = project(args);
	const watch = new Stopwatch();
	const history = await watch.stage("read", () => readHistory(proj));
	const wanted = flagString(args, "build");
	let build: BuildRef;
	if (wanted) {
		const row = matchDeployment(history.rows.filter((r) => branchChannel(proj.config, r.branch) === "prod"), wanted, proj.config.defaultBranch);
		if (!row) throw new UsageError(`no prod-channel deployment matches "${wanted}" in this machine's log (typetorch deployments lists them)`);
		build = { branch: row.branch, seq: row.seq, artifactId: row.artifactId, assetId: row.assetId, at: row.at };
	} else {
		const head = backupHead(proj.config, history.heads);
		if (!head) throw new UsageError("no prod-channel head is known on this machine: deploy prod first, or pass --build <x>");
		build = { branch: head.branch, seq: head.seq, artifactId: head.artifactId, assetId: head.assetId, at: head.deployedAt };
	}
	const settings = proj.config.backup ?? BACKUP_DEFAULTS;
	const health = await provenHealthy(fleetFor(proj).client, build, settings.healthyHours);
	info(`  build       #${build.seq} ${build.artifactId} (${build.branch})`);
	info(`  health      ${health.proven ? health.reason : `NOT proven: ${health.reason}`}`);
	if (!health.proven) {
		if (!flagBool(args, "force")) throw new LuauEngineError(`refusing to make an unproven build the backup (it is what servers run when nothing else works): ${health.reason}. --force does it anyway`);
		warn("--force: making an unproven build the backup");
	}
	let slots;
	try {
		slots = await watch.stage("slots", () => backupSlots(proj, build));
	} catch (error) {
		if (error instanceof BackupError) throw new LuauEngineError(error.message);
		throw error;
	}
	const outcome = await refreshBackup(
		{ universeId: proj.config.universeId, placeId: proj.config.placeId, build, slotsBytes: slots.bytes, cliSlots: slots.cliSlots, dryRun: flagBool(args, "dry-run"), yes: flagBool(args, "yes"), timeoutSeconds: taskTimeout(args) },
		luauDeps(proj),
	);
	if (isJson()) return emitJson({ build, health, outcome });
	if (outcome.status === "refreshed") {
		info(bold(`${build.artifactId} is the backup build of place ${proj.config.placeId} now (v${outcome.placeVersionBefore} -> v${outcome.placeVersionAfter ?? "?"})`));
		if (outcome.verified === false) warn(`the verify task: ${outcome.problems?.join("; ")}`);
		assetsNote(proj);
	} else if (outcome.status === "dry-run") info(bold(`dry run: ${build.artifactId} would replace the place's backup ${outcome.current ?? "(none)"} on v${outcome.placeVersion}; nothing saved`));
	else if (outcome.status === "declined") info("not saved");
	else if (outcome.already) info(outcome.reason);
	else throw new LuauEngineError(`backup not refreshed: ${outcome.reason}`);
}
