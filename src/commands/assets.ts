/**
 * `typetorch assets sync|status|list`: hot assets (TypeTorch plans/13 "Hot assets"; the steps are in ../assets.ts).
 *
 *   sync [--dry-run] [--deploy <branch>]  export from the place's latest published version, diff against
 *                                         typetorch.assets.lock.json, upload new and changed assets (new asset / new
 *                                         version of the same asset), wait for moderation, resolve the assetVersionIds,
 *                                         write the lockfile; --deploy then runs `typetorch deploy --branch <branch>`
 *                                         (same approval policy). --dry-run stops after the diff.
 *   status                                export + diff only (= sync --dry-run)
 *   list                                  the lockfile
 *
 * Everything uses the assets key: asset:read + asset:write (uploads; asset:read also on the place for its version
 * list) and universe.place.luau-execution-session:read + :write (the export and resolve tasks). A refused call stops
 * the command with the scope it needs.
 */
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import {
	appendAssetLog,
	ASSETS_LOCK_FILE,
	assetsAttribute,
	AssetsError,
	countChanges,
	diffAssets,
	exportScript,
	formatAssetsLock,
	knownAssetId,
	reusableUpload,
	latestPublishedVersion,
	nextLock,
	parseExport,
	parseResolve,
	readAssetLog,
	readAssetsLock,
	resolveScript,
	uploadHotAsset,
	writeAssetsLock,
	type AssetChange,
	type AssetsLock,
	type ExportResult,
	type HotAssetUpload,
	type ResolveItem,
} from "../assets.ts";
import type { Project } from "../config.ts";
import { bold, captureJson, debug, dim, emitJson, formatBytes, formatSeconds, info, isJson, seconds, Stopwatch, table, warn } from "../log.ts";
import { branchChannel, branchNameError } from "../naming.ts";
import { ApiError, type OpenCloud } from "../opencloud.ts";
import { ASSETS_SYNC_LOCK, withStateLock } from "../state.ts";
import { KEY_FILE_FLAGS, openCloud, project, projectStateDir } from "./common.ts";
import { deployCommand } from "./deploy.ts";

export const assetsFlags = {
	"dry-run": "boolean",
	deploy: "string",
	"place-version": "string",
	"moderation-timeout": "string",
	// passed on to the deploy (--deploy)
	message: "string",
	propose: "boolean",
	"proposed-by": "string",
	"no-registry": "boolean",
	...KEY_FILE_FLAGS,
} as const;

/** Flags `--deploy` hands to `typetorch deploy`. */
const DEPLOY_PASSTHROUGH = ["message", "propose", "proposed-by", "no-registry", "moderation-timeout", "key-file", "fallback-key-file"];

export interface AssetsDeps {
	/** The assets client (uploads, Luau Execution, place versions); default: the assets key. */
	assets?: OpenCloud;
	/** Runs the deploy for --deploy (default: `typetorch deploy`). */
	deploy?: (args: ParsedArgs) => Promise<void>;
}

const LUAU_SCOPES = "universe.place.luau-execution-session:read and universe.place.luau-execution-session:write";

/** Rethrows a refused call (401/403) as "the assets key needs <scopes>"; other errors unchanged. */
function explainRefusal(error: unknown, what: string, scopes: string): never {
	if (error instanceof ApiError && error.isScopeError) {
		throw new AssetsError(`${what} was refused (${error.status}): the assets key (OPENCLOUD_ASSETS_KEY or the shared key) needs ${scopes}. ${error.message}`);
	}
	throw error;
}

export interface PlaceExport {
	placeVersion: number;
	/** How the version was chosen. */
	base: "latest published" | "--place-version";
	/** Saved versions newer than the published one (not exported). */
	newerSaves: number;
	result: ExportResult;
	binaryBytes: number;
	taskPath?: string;
}

/** Step 1: the export task on the latest published place version (or --place-version). */
export async function exportPlace(oc: OpenCloud, proj: Project, versionFlag?: string): Promise<PlaceExport> {
	const { universeId, placeId } = proj.config;
	let placeVersion: number;
	let base: PlaceExport["base"];
	let newerSaves = 0;
	if (versionFlag !== undefined) {
		if (!/^\d+$/.test(versionFlag) || Number(versionFlag) < 1) throw new UsageError(`--place-version must be a positive whole number, got "${versionFlag}"`);
		placeVersion = Number(versionFlag);
		base = "--place-version";
		// The lockfile records this version, and new servers adopt the place's copies only when they run exactly it:
		// warn when the Assets API says it was never published (best effort; the list may not be readable).
		try {
			const listed = (await oc.placeVersions(placeId)).find((v) => v.version === placeVersion);
			if (listed && !listed.published) warn(`place version ${placeVersion} is a save, not a published version: live servers never run it, so they won't adopt the place's copies`);
		} catch (error) {
			debug(`--place-version ${placeVersion}: the version list isn't readable (${(error as Error).message.slice(0, 200)})`);
		}
	} else {
		let versions;
		try {
			versions = await oc.placeVersions(placeId);
		} catch (error) {
			explainRefusal(error, `listing place ${placeId}'s versions`, "asset:read (on the place)");
		}
		({ version: placeVersion, newerSaves } = latestPublishedVersion(versions));
		base = "latest published";
	}
	let run;
	try {
		run = await oc.runLuau(universeId, placeId, exportScript(), 300, { version: placeVersion, binaryOutput: true });
	} catch (error) {
		explainRefusal(error, "creating the Luau Execution export task", LUAU_SCOPES);
	}
	if (run.state !== "COMPLETE") throw new AssetsError(`the export task ended ${run.state}${run.error ? `: ${JSON.stringify(run.error).slice(0, 800)}` : ""}`);
	const binary = run.binaryOutputUri ? await oc.downloadBinaryOutput(run.binaryOutputUri) : undefined;
	const result = parseExport(run.results, binary);
	if (result.reportedPlaceVersion !== undefined && result.reportedPlaceVersion !== placeVersion) {
		warn(`the export task ran on place version ${placeVersion} but game.PlaceVersion says ${result.reportedPlaceVersion}`);
	}
	return { placeVersion, base, newerSaves, result, binaryBytes: binary?.length ?? 0, taskPath: run.path };
}

interface Outcome {
	upload?: HotAssetUpload;
	/** The upload came from an earlier run (assets.jsonl), not this one. */
	reused?: boolean;
	ver?: number;
	error?: string;
}

function changeJson(change: AssetChange, outcome?: Outcome) {
	const e = change.exported;
	const l = change.locked;
	return {
		key: change.key,
		status: change.status,
		...(change.moved ? { moved: { from: l!.path, to: e!.path } } : {}),
		path: e?.path ?? l?.path,
		className: e?.className ?? l?.className,
		realm: e?.realm ?? l?.realm,
		hash: e?.hash ?? l?.hash,
		...(change.status === "updated" ? { previousHash: l!.hash } : {}),
		...(e ? { bytes: e.bytes.length } : {}),
		assetId: outcome?.upload?.assetId ?? l?.id,
		...(outcome?.upload ? { n: outcome.upload.n, moderation: outcome.upload.moderation, created: outcome.upload.created, ...(outcome.reused ? { reused: true } : {}) } : {}),
		...(outcome?.ver ? { ver: outcome.ver } : change.status === "unchanged" && l ? { ver: l.ver, n: l.n } : {}),
		...(outcome?.error ? { error: outcome.error } : {}),
	};
}

const MARK: Record<AssetChange["status"], string> = { added: "+", updated: "~", removed: "-", unchanged: "=" };

function printChanges(changes: AssetChange[]) {
	if (changes.length === 0) return;
	const rows = changes.map((c) => {
		const e = c.exported;
		const l = c.locked;
		const detail =
			c.status === "added"
				? `${e!.hash}  new, ${formatBytes(e!.bytes.length)}`
				: c.status === "updated"
					? `${l!.hash} -> ${e!.hash}  asset ${l!.id}, ${formatBytes(e!.bytes.length)}`
					: c.status === "removed"
						? `gone from the place (asset ${l!.id} stays on Roblox)`
						: `${e!.hash}${c.moved ? `  moved from ${l!.path}` : ""}`;
		return [MARK[c.status], c.key, e?.className ?? l!.className, e?.path ?? l!.path, detail];
	});
	info(
		table(["", "key", "class", "path", ""], rows)
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n"),
	);
}

function describeLock(lock: AssetsLock | undefined): string {
	return lock ? `${ASSETS_LOCK_FILE} (place v${lock.placeVersion}, ${Object.keys(lock.assets).length} assets)` : `${ASSETS_LOCK_FILE}: none yet`;
}

/** Runs `fn` over `items`, at most `size` at a time. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
	const queue = [...items];
	await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
		while (queue.length) await fn(queue.shift()!);
	}));
}

async function syncCommand(args: ParsedArgs, deps: AssetsDeps, mode: "sync" | "status") {
	const proj = project(args);
	const { universeId, placeId } = proj.config;
	const dryRun = mode === "status" || flagBool(args, "dry-run");
	const deployBranch = flagString(args, "deploy");
	if (deployBranch !== undefined) {
		if (mode === "status") throw new UsageError("--deploy goes with `typetorch assets sync`");
		if (dryRun) throw new UsageError("--deploy can't be combined with --dry-run");
		const problem = branchNameError(deployBranch);
		if (problem) throw new UsageError(`--deploy: ${problem}`);
	}
	const moderationTimeout = flagInt(args, "moderation-timeout", 600);
	const oc = deps.assets ?? openCloud("assets")!;
	const lock = readAssetsLock(proj.root);
	const watch = new Stopwatch();

	const placed = await watch.stage("export", () => exportPlace(oc, proj, flagString(args, "place-version")));
	const changes = diffAssets(lock, placed.result.assets);
	const counts = countChanges(changes);
	const pending = changes.filter((c) => c.status === "added" || c.status === "updated");
	const saves = placed.newerSaves ? `; ${placed.newerSaves} newer unpublished save(s) not included` : "";
	info(`place      ${placeId} v${placed.placeVersion} (${placed.base}${saves}), exported in ${formatSeconds(watch.timings.export)}`);
	info(`lockfile   ${describeLock(lock)}`);
	info(`assets     ${placed.result.assets.length} in the place: ${counts.added} added, ${counts.updated} updated, ${counts.removed} removed, ${counts.unchanged} unchanged`);
	printChanges(changes);
	const base = {
		placeId,
		placeVersion: placed.placeVersion,
		base: placed.base,
		newerSaves: placed.newerSaves,
		lockfile: ASSETS_LOCK_FILE,
		lockPlaceVersion: lock?.placeVersion,
		counts,
		binaryBytes: placed.binaryBytes,
		taskPath: placed.taskPath,
	};

	// The lockfile changes when anything is uploaded, removed or moved, or when it records a newer place version (the
	// runtime adopts the place's own copies only on servers of exactly that version). An empty place and no lockfile:
	// nothing to write.
	const entriesChange = pending.length > 0 || counts.removed > 0 || changes.some((c) => c.moved);
	const lockChanges = entriesChange || (lock ? lock.placeVersion !== placed.placeVersion : placed.result.assets.length > 0);
	if (dryRun) {
		if (isJson()) return emitJson({ ...base, mode, dryRun: true, upToDate: !lockChanges, changes: changes.map((c) => changeJson(c)) });
		info(
			!lockChanges
				? dim(`up to date: nothing to upload or write`)
				: !entriesChange
					? bold(`${mode === "status" ? "out of date" : "dry run"}: nothing to upload; \`typetorch assets sync\` would record place v${placed.placeVersion} in ${ASSETS_LOCK_FILE}`)
					: bold(`${mode === "status" ? "out of date" : "dry run"}: \`typetorch assets sync\` would upload ${pending.length} and write ${ASSETS_LOCK_FILE}`),
		);
		return;
	}

	if (deployBranch && lockChanges && branchChannel(proj.config, deployBranch) === "prod") {
		throw new UsageError(
			`--deploy ${deployBranch}: prod-channel branches only take clean builds, and this sync changes ${ASSETS_LOCK_FILE}. Run \`typetorch assets sync\`, commit the lockfile, then \`typetorch deploy --branch ${deployBranch}\``,
		);
	}

	const stateDir = projectStateDir(proj);
	const outcomes = new Map<string, Outcome>();
	const { next, written, changed } = await withStateLock(
		stateDir,
		`assets sync ${proj.config.project}`,
		async () => {
			// 3. Upload: a new key reuses an id this machine already made for it, else creates one. The same bytes
			// uploaded and approved by a run that then failed elsewhere are reused (the resolve task checks them).
			const log = readAssetLog(stateDir, universeId);
			await watch.stage("upload", () =>
				pool(pending, 4, async (change) => {
					const e = change.exported!;
					const started = performance.now();
					const assetId = change.locked?.id ?? knownAssetId(log, change.key);
					const reused = reusableUpload(log, change.key, e.hash);
					if (reused && (assetId === undefined || reused.assetId === assetId)) {
						info(`  upload     ${change.key}: reusing asset ${reused.assetId} v${reused.n} (uploaded and approved by an earlier run)`);
						outcomes.set(change.key, { upload: reused, reused: true });
						return;
					}
					try {
						const upload = await uploadHotAsset(oc, {
							creator: proj.config.creator,
							key: change.key,
							bytes: e.bytes,
							hash: e.hash,
							assetId,
							moderationTimeout,
							onCreated: (assetId) => appendAssetLog(stateDir, { event: "created", universeId, project: proj.config.project, key: change.key, assetId }),
						});
						appendAssetLog(stateDir, {
							event: "uploaded",
							universeId,
							project: proj.config.project,
							key: change.key,
							assetId: upload.assetId,
							n: upload.n,
							hash: e.hash,
							bytes: e.bytes.length,
							moderation: upload.moderation,
							placeVersion: placed.placeVersion,
							path: e.path,
							className: e.className,
						});
						info(`  upload     ${change.key} -> asset ${upload.assetId} v${upload.n}${upload.created ? " (new)" : ""}, ${upload.moderation} (${formatSeconds(seconds(performance.now() - started))})`);
						outcomes.set(change.key, upload.moderation === "Approved" ? { upload } : { upload, error: `moderation is ${upload.moderation}` });
					} catch (error) {
						const message = (error as Error).message ?? String(error);
						outcomes.set(change.key, { error: message });
						appendAssetLog(stateDir, { event: "failed", universeId, project: proj.config.project, key: change.key, error: message.slice(0, 500) });
						info(`  upload     ${change.key} FAILED: ${message.slice(0, 300)}`);
					}
				}),
			);

			// 4. Resolve the assetVersionIds of the approved uploads (and check Roblox serves the uploaded bytes).
			const items: ResolveItem[] = [];
			for (const change of pending) {
				const outcome = outcomes.get(change.key);
				if (outcome?.upload && !outcome.error) items.push({ key: change.key, id: outcome.upload.assetId, hash: change.exported!.hash });
			}
			if (items.length > 0) {
				await watch.stage("resolve", async () => {
					let run;
					try {
						run = await oc.runLuau(universeId, placeId, resolveScript(items), 300, { version: placed.placeVersion });
					} catch (error) {
						explainRefusal(error, "creating the Luau Execution resolve task", LUAU_SCOPES);
					}
					const resolved: Map<string, { ver?: number; error?: string }> =
						run.state === "COMPLETE"
							? parseResolve(run.results, items)
							: new Map(items.map((i) => [i.key, { error: `the resolve task ended ${run.state}: ${JSON.stringify(run.error ?? null).slice(0, 300)}` }]));
					for (const item of items) {
						const r = resolved.get(item.key)!;
						const outcome = outcomes.get(item.key)!;
						if (r.ver !== undefined) outcome.ver = r.ver;
						else {
							outcome.error = `version lookup: ${r.error}`;
							// a later run uploads it again instead of reusing this upload
							appendAssetLog(stateDir, { event: "failed", universeId, project: proj.config.project, key: item.key, assetId: item.id, error: outcome.error.slice(0, 500) });
						}
					}
				});
			}

			// 5. The lockfile, only when everything worked: its placeVersion promises that every entry matches the place
			// at that version (new servers adopt the place's copies on that promise).
			const failed = [...outcomes].filter(([, o]) => o.error).map(([key]) => key);
			const uploaded = new Map<string, { id: number; ver: number; n: number }>();
			for (const [key, outcome] of outcomes) if (outcome.upload && outcome.ver !== undefined && !outcome.error) uploaded.set(key, { id: outcome.upload.assetId, ver: outcome.ver, n: outcome.upload.n });
			const next = nextLock({ placeVersion: placed.placeVersion, changes, uploaded });
			const written = failed.length === 0 && lockChanges && formatAssetsLock(next) !== (lock ? formatAssetsLock(lock) : undefined);
			if (written) writeAssetsLock(proj.root, next);
			appendAssetLog(stateDir, { event: "synced", universeId, project: proj.config.project, placeVersion: placed.placeVersion, ...counts, uploaded: [...uploaded.keys()], failed, written });
			return { next: written ? next : lock, written, changed: written && assetsAttribute(next) !== assetsAttribute(lock) };
		},
		{ file: ASSETS_SYNC_LOCK, staleMs: 60 * 60_000 },
	);

	const failed = [...outcomes].filter(([, o]) => o.error);
	const result = {
		...base,
		mode,
		dryRun: false,
		changes: changes.map((c) => changeJson(c, outcomes.get(c.key))),
		failed: failed.map(([key, o]) => ({ key, error: o.error })),
		lock: { written, changed, placeVersion: next?.placeVersion, assets: Object.keys(next?.assets ?? {}).length },
		timings: watch.total(),
	};
	for (const [key, outcome] of failed) warn(`${key}: ${outcome.error}`);
	if (failed.length) process.exitCode = 1;
	if (!isJson()) {
		info(
			failed.length
				? bold(`${ASSETS_LOCK_FILE} NOT written: ${failed.length} asset(s) failed (its place version must match every entry). Fix them and sync again; approved uploads are reused`)
				: written
					? bold(`wrote ${ASSETS_LOCK_FILE} (place v${next!.placeVersion}): ${counts.added} added, ${counts.updated} updated, ${counts.removed} removed, ${counts.unchanged} unchanged`)
					: dim(next ? `up to date: ${ASSETS_LOCK_FILE} unchanged` : `no hot assets in the place: no ${ASSETS_LOCK_FILE} written`),
		);
		info(dim(`  ${Object.entries(watch.total()).map(([stage, s]) => `${stage} ${formatSeconds(s)}`).join(", ")}`));
	}

	// --deploy: a deploy with the new Assets attribute (same approval policy as `typetorch deploy`).
	let deploy: unknown;
	if (deployBranch) {
		if (failed.length) warn(`not deploying ${deployBranch}: ${failed.length} asset(s) failed`);
		else if (!changed) info(dim(`not deploying ${deployBranch}: the Assets attribute wouldn't change (\`typetorch deploy\` deploys anyway)`));
		else {
			const flags: Record<string, string | boolean> = { branch: deployBranch };
			for (const name of DEPLOY_PASSTHROUGH) if (args.flags[name] !== undefined) flags[name] = args.flags[name];
			const deployArgs: ParsedArgs = { positionals: [], flags };
			info(bold(`deploying ${deployBranch} with the new Assets attribute`));
			const run = deps.deploy ?? deployCommand;
			if (isJson()) deploy = await captureJson(() => run(deployArgs));
			else await run(deployArgs);
		}
	} else if (changed && !isJson()) {
		info(`next: commit ${ASSETS_LOCK_FILE}, then \`typetorch deploy\` (or next time: \`typetorch assets sync --deploy <branch>\`)`);
	}
	if (isJson()) emitJson({ ...result, ...(deployBranch ? { deploy: deploy ?? null } : {}) });
}

function listCommand(args: ParsedArgs) {
	const proj = project(args);
	const lock = readAssetsLock(proj.root);
	if (isJson()) return emitJson({ lockfile: ASSETS_LOCK_FILE, exists: Boolean(lock), ...(lock ?? {}) });
	if (!lock) return info(`no ${ASSETS_LOCK_FILE} yet: run \`typetorch assets sync\``);
	const keys = Object.keys(lock.assets).sort();
	info(`${ASSETS_LOCK_FILE}: ${keys.length} hot asset(s) from place v${lock.placeVersion}`);
	if (keys.length === 0) return;
	info(
		table(
			["key", "realm", "class", "path", "asset", "n", "version id", "hash"],
			keys.map((key) => {
				const e = lock.assets[key];
				return [key, e.realm, e.className, e.path, String(e.id), String(e.n), String(e.ver), e.hash];
			}),
		),
	);
}

export async function assetsCommand(args: ParsedArgs, deps: AssetsDeps = {}) {
	const [sub, extra] = args.positionals;
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	if (sub === "list") return listCommand(args);
	if (sub === "status") return syncCommand(args, deps, "status");
	if (sub === "sync") return syncCommand(args, deps, "sync");
	throw new UsageError(`unknown assets subcommand "${sub ?? ""}" (sync, status, list)`);
}
