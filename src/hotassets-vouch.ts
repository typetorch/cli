/**
 * Hot assets across a place save (2026-10-13 incident): every save publishes a new place version, and the framework's
 * AssetSync adopts the place's own hot-asset copies only when the lockfile's placeVersion is the server's
 * game.PlaceVersion, or when ServerStorage.TypeTorchBackup vouches for it (HotAssetsPlaceVersion / HotAssetsSavedAs,
 * written by kernelpatch-task step 4b and the restore task). Every command that saves the place (backup refresh,
 * kernel deploy, kernel restore) reports here whether new servers on the saved version still adopt the place's copies.
 */
import { ASSETS_LOCK_FILE } from "./assets.ts";
import { info, warn } from "./log.ts";

/**
 * Hot assets after a save: `kept` when new servers on the saved version still adopt the place's copies (the new backup
 * vouches for the lockfile, and the save landed on the version it named). Otherwise they load every hot asset from its
 * uploaded version until `typetorch assets sync --deploy <branch>`.
 */
export interface BackupAssets {
	kept: boolean;
	lockPlaceVersion: number;
	/** Why not kept. */
	reason?: string;
}

/** What a save task reports about the vouch (KernelTaskResult / RestoreTaskResult `assets`). */
export interface StampedAssets {
	holds: boolean;
	lockPlaceVersion?: number;
	savedAs?: number;
}

/** Why a save would put new servers on the hot-asset upload path, for skip reasons and warnings. */
export function assetsMismatch(lockPlaceVersion: number, base: number): string {
	return `the hot-asset lock (${ASSETS_LOCK_FILE}) is for place v${lockPlaceVersion} and the place is v${base}: after this save new servers would load every hot asset from its uploaded version instead of the place's copies. Run typetorch assets sync --deploy <branch> first`;
}

/** Why a save can't vouch when the saved place carries no backup build (kernel deploy --no-backup, no prod head). */
export function noBackupToVouch(lockPlaceVersion: number): string {
	return `no backup build is in the saved place to vouch for the hot-asset lock (v${lockPlaceVersion}): after this save new servers load every hot asset from its uploaded version instead of the place's copies`;
}

/** Whether new servers on the saved version keep adopting the place's hot-asset copies (see BackupAssets). */
export function backupAssets(lockPlaceVersion: number, base: number, stamped: StampedAssets | undefined, saved: number | undefined): BackupAssets {
	if (!stamped) return { kept: false, lockPlaceVersion, reason: noBackupToVouch(lockPlaceVersion) };
	if (!stamped.holds) return { kept: false, lockPlaceVersion, reason: assetsMismatch(lockPlaceVersion, base) };
	if (saved === undefined) return { kept: false, lockPlaceVersion, reason: "the saved place version isn't known, so whether new servers adopt the place's hot-asset copies isn't either" };
	if (saved !== stamped.savedAs) {
		return { kept: false, lockPlaceVersion, reason: `the save became v${saved}, not v${stamped.savedAs} (another save landed in between): new servers load every hot asset from its uploaded version` };
	}
	return { kept: true, lockPlaceVersion };
}

/**
 * A publish of a place file (kernel deploy --place-file / --replace-place, kernel restore <file>): nothing vouches for
 * the lockfile in the new version, so unless the lock names it, new servers are on the upload path.
 */
export function publishedAssets(lockPlaceVersion: number, after: number | null | undefined): BackupAssets {
	if (after === lockPlaceVersion) return { kept: true, lockPlaceVersion };
	return {
		kept: false,
		lockPlaceVersion,
		reason: `the place is now ${after == null ? "a new version" : `v${after}`} and the hot-asset lock (${ASSETS_LOCK_FILE}) is for v${lockPlaceVersion}; a place file publish can't vouch for the lock's copies, so new servers load every hot asset from its uploaded version`,
	};
}

/**
 * After a save in a project with a hot-asset lock: whether new servers still adopt the place's copies. When they don't,
 * a warning with the command that fixes it (the 2026-10-13 incident: a dim note went unnoticed for two days).
 */
export function assetsNote(assets: BackupAssets | undefined, branch: string, indent = "              ") {
	if (!assets) return;
	if (assets.kept) {
		info(`${indent}hot assets: new servers on the saved version keep adopting the place's copies (lock v${assets.lockPlaceVersion}; framework 0.5.3+)`);
		return;
	}
	warn(`hot assets: ${assets.reason ?? "new servers load every hot asset from its uploaded version"}. Fix: typetorch assets sync --deploy ${branch}`);
}
