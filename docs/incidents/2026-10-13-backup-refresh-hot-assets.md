# Incident 2026-10-13: the automatic backup refresh put every new server on the hot-asset upload path

For TypeTorch beta testers and the agents working in their games. Read **Am I affected?** first; if you are, do
**Fix it now** before your next prod release. The same day it **recurred through `typetorch kernel deploy`** with the
first fix in place; see **Recurrence**.

## Summary

A prod `typetorch deploy` / `approve` / `promote` at an interactive terminal runs the **automatic backup refresh**
(CLI versions with the automatic refresh, up to 0.10.1; on by default). It bakes the build being replaced into `ServerStorage.TypeTorchBackup` and
**publishes the place** (SavePlaceAsync), so the place version moves (v N → v N+1). The only output was a dim line.

`typetorch.assets.lock.json` still names v N. The framework's AssetSync adopts the place's own baked hot-asset copies
only when `manifest.placeVersion == game.PlaceVersion`, so from then on **every new server** destroyed the place's
copies and loaded every hot asset from its uploaded version (`InsertService:LoadAssetVersion`). Servers that were
already running and only hot-swapped kept their adopted copies and stayed healthy, which hid the problem.

In the affected game, every fresh server for about two days came up with a broken client (main UI missing from
`PlayerGui`, tutorial off, no sound effects, tools unusable). Only warnings were logged, so no error alert fired. Why the
upload path broke that game's client is not fully understood yet (see **Still open**); treat the upload path as risky
until it is.

## Am I affected?

All of these:

1. The game uses **hot assets** with a lock file (`typetorch.assets.lock.json` in the repo).
2. The **backup refresh is on**: no `"backup": { "refresh": "off" }` in `typetorch.json` (the default is on).
3. Someone ran a prod release **from an interactive terminal** (the refresh never runs in CI or agent shells), and its
   output showed `backup      ... is the backup build now (place vX -> vY)`.

Check now:

```bash
typetorch assets status --json   # placeVersion (the place) vs lockPlaceVersion (the lock); counts
```

If `placeVersion != lockPlaceVersion`, new servers are on the upload path. Any place publish does this, not only the
backup refresh: a Studio publish, `typetorch kernel deploy`, or `typetorch backup refresh`.

Symptoms on a fresh server: AssetSync prints `hot assets: N loaded, ...` instead of `N baked`; the dev menu's hot
assets page shows `loaded` for every key. Game-specific: anything the game reads from the place's copies at a fixed
path may break or wait forever (`Infinite yield possible ...` warnings).

## Fix it now (before the fixed CLI and framework)

Only when `typetorch assets status` shows `0 added, 0 updated, 0 removed`:

```bash
typetorch assets sync --deploy prod   # lock -> the place's current version; nothing is uploaded; redeploys prod
```

Then restart (or let rotate) servers that booted on the mismatched version. If there **are** pending hot-asset
changes, the sync would upload them, which is the upload path again: test that on a dev server that boots fresh first.

To stop it from happening again until you upgrade: set `"backup": { "refresh": "off" }` in `typetorch.json`, and refresh
the backup deliberately with `typetorch backup refresh` followed by `typetorch assets sync --deploy prod`. After **any**
place publish, run the same sync.

## What the fix changes

- **CLI (`typetorch/cli`, this PR):** with a lock file, the backup refresh's save stamps the new
  `ServerStorage.TypeTorchBackup` with `HotAssetsPlaceVersion` (the lock's version) and `HotAssetsSavedAs` (the version
  the save becomes), but only when the place's copies are the lock's (the lock was made on the base version, or the old
  backup already vouched for it). The save task already refuses to change anything outside the kernel slots, so the
  claim is safe. When the claim can't be made, the **automatic** refresh is skipped with one line naming
  `typetorch assets sync --deploy <branch>`; `typetorch backup refresh` warns before its y/N and after.
- **Framework (`typetorch/framework`, companion PR):** AssetSync adopts the place's copies when the backup vouches for
  this exact `game.PlaceVersion` (`report.place = "vouched"`). Any later publish (Studio) has another version, so the
  claim ends there. A server whose place doesn't match warns once at boot, and every generation sends a `tech` /
  `assets` analytics row (`place`: `same` / `vouched` / `differs`, counts per source: `kept`, `baked`, `loaded`,
  `failed`), so "all new servers load uploads" is visible in the events table.
- **Both are needed:** an old framework ignores the stamp; an old CLI never writes it. Upgrade both, then run one
  `typetorch assets sync --deploy prod` so the lock matches the place.
- **Not covered by that fix:** `typetorch kernel deploy` also publishes the place and didn't stamp. It recurred that
  way the same day; see **Recurrence** for the follow-up fix.

## Recurrence: `typetorch kernel deploy` (same day, with the fixed framework)

**What happened.** The game ran the fixed framework (0.5.3) on prod and its lock matched the place's newest published
version vN. Someone ran `typetorch kernel deploy --base published --yes`, which patched the kernel into vN, baked the
backup build, and saved the place as vN+2 (another save, vN+1, sat in between). The new backup carried **no**
`HotAssetsPlaceVersion` / `HotAssetsSavedAs`: only the backup refresh passed the lock to the save task (CLI 0.10.2), and
`kernel deploy` never did, so the task skipped the stamp. New servers saw lock vN against place vN+2 with no vouch and
took the upload path: the same broken client. Fixed in the game by `typetorch assets sync --deploy prod` (lock -> vN+2).

**The follow-up fix (`typetorch/cli`, this PR).** Every CLI command that saves the place now handles the lock:

| Command | Publishes the place | Now |
| --- | --- | --- |
| automatic backup refresh, `typetorch backup refresh` | yes (SavePlaceAsync) | stamps (first fix) |
| `typetorch kernel deploy` (default luau engine) | yes (SavePlaceAsync) | stamps the backup it bakes, checks the stamp in the verify task, prints the outcome; warns before the y/N when it can't |
| `typetorch kernel deploy --no-backup`, or no prod head to bake | yes | nothing to stamp: warns before the y/N and after, with the fix |
| `typetorch kernel restore --version <n>` | yes (republishes vn as a new version) | stamps vn's backup for the new version when vn's copies are the lock's (the lock is vn, or vn's backup vouched for it) |
| `typetorch kernel deploy --place-file` / `--replace-place`, `typetorch kernel restore <file>` | yes (place file upload) | can't stamp: warns after the publish with the fix |
| Studio publish | yes | outside the CLI: run `typetorch assets sync --deploy prod` after it |

The stamp rule is the same everywhere: the save's hot-asset copies are the lock's when the lock names the version the
save starts from, or that version's backup vouched for the lock as that version. The claim names the version the save
becomes (newest + 1), and the framework accepts it only on exactly that version.

**What to do.** Upgrade the CLI to the release with this fix. Until then, after **any** `kernel deploy` or `kernel
restore`, check `typetorch assets status --json` and run `typetorch assets sync --deploy prod` when
`placeVersion != lockPlaceVersion`.

## For agents working in an affected game

- Never run a prod release, `backup refresh`, `kernel deploy` or a place publish without checking
  `typetorch assets status --json` afterwards; if `placeVersion != lockPlaceVersion`, tell the owner and propose
  `typetorch assets sync --deploy prod` (it redeploys prod: get the owner's go-ahead).
- When reading analytics, a drop in gameplay events on servers that booted after a place publish, while joins continue,
  is this failure mode. Group events by `job` and compare each server's boot place version with the lock.
- Game code: don't wait forever on a UI that StarterGui copies into `PlayerGui` (`WaitForChild` without a timeout), and
  don't assume a hot asset's children match the place's copy. A client generation can start before the character
  spawns.

## Still open

Why the upload path broke the affected game's client is not proven. The leading lead (from code, untested): client
code checked `PlayerGui` once at start and then waited forever on a path that didn't exist, so it failed whenever the
client generation started before the character spawned; the upload path holds a booting server's start a few seconds
longer, which can change that order. If you see the upload path break your game too, record `PlayerGui.ChildAdded`
times against the client generation's start on a fresh dev server with a mismatched lock, and share it.
