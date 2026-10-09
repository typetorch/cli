# @typetorch/cli

`typetorch` builds a roblox-ts game into a payload, uploads it to Roblox as a private Model asset, and hot-swaps it
into live servers without a restart. It also promotes and rolls back already uploaded builds, lists deployments with
their git identity, checks and publishes the kernel place, and syncs **hot assets** (models and UI templates that
builders edit in the place) into the artifact. **Every deploy is approved by a person**
(`typetorch approve`); agents and the remote-claude dev-server only prepare them. **Prod-channel deploys are signed**
with two Ed25519 keys, so live prod servers only run what you published. **A cloud test gates prod deploys**: the
uploaded payload boots headless in the place before anything is published. `typetorch servers` and `typetorch report`
show the live fleet and what each server did with a deploy.

Part of TypeTorch: the kernel (`@typetorch/kernel`) is baked into the place and swaps payloads; the framework
(`@typetorch/framework`) ships inside every payload.

## Install

The CLI runs on **Node 20+** (npm, npx) or **Bun 1.3+**; you don't need both to run it.

```sh
npm i -g @typetorch/cli        # then: typetorch <command>
npx @typetorch/cli <command>   # no install
bun add -d @typetorch/cli      # in the game repo, then: bunx typetorch <command>
bun src/index.ts <command>     # from a checkout of this repo
```

The [template](https://github.com/typetorch/template) already has `@typetorch/cli` (and `@typetorch/dev-server`) in its
devDependencies and the script `"typetorch": "typetorch"`: after `bun install`, `bun run typetorch <command>` runs it.

What the commands call:
- **git**, and **Rojo 7.7.x** (plus **Lune** for `kernel deploy`) through [Rokit](https://github.com/rojo-rbx/rokit):
  pin `rojo-rbx/rojo@7.7.0-rc.1` in the game's `rokit.toml`.
- **Bun** for `typetorch build` / `deploy` / `upload`: the game repo is a Bun project and the build runs
  `bun run build` (or `bun run rbxtsc`) in it. Commands that don't build (`approve`, `promote`, `rollback`,
  `deployments`, `keys`, `pin`, `assets status`, `doctor`) don't need it.
- **zstd** for hot assets (`assets sync` / `status`, which read Roblox-serialized exports): Bun, or Node 22.15+.
  `typetorch doctor` reports the runtime, Bun and zstd.

### `typetorch` on PATH (from a checkout)

`bin/typetorch.cmd` (cmd.exe and PowerShell) and `bin/typetorch` (bash/zsh) run this checkout with Bun. Add `bin/` to
your user PATH once, then open a new terminal. PowerShell, for this machine's checkout:

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";<path-to>\typetorch-cli\bin", "User")
```

Alternatively `bun link` in this folder, then `bun link @typetorch/cli` in a game repo (that puts it on the repo's
`bunx typetorch`, not on PATH).

## Setup

A game repo has `typetorch.json` next to `default.project.json`:

```jsonc
{
  "project": "my-game",
  "universeId": 123, "placeId": 456,
  "creator": { "groupId": 789 },         // or { "userId": 1 }: the experience owner (LoadAsset refuses other owners)
  "defaultBranch": "prod",
  "branches": { "main": "prod" },        // git branch -> TypeTorch branch (default: lowercased, "/" -> "-")
  "channels": { "prod": "prod" },        // branch -> "prod" | "dev" (default: prod for defaultBranch, else dev)
  "members": { "123456789": "owner" },   // userId -> owner | dev
  "devBadgeId": null,
  "kernel": "node_modules/@typetorch/kernel",
  "approval": "all",                     // "all" (default) | "prod" | "none": which deploys need `typetorch approve`
  // written by `typetorch keys ...` (public keys only; commit them):
  "signingPublicKeys": ["…"],            // trusted main keys = the key asset's PublicKeys
  "revokedKeys": [],                     // = the key asset's RevokedKeys
  "fallbackPublicKey": "…",              // baked into the place by `kernel deploy`
  "keyAssetId": 123,                     // the key asset; `kernel deploy` stamps it
  "backend": { "url": "https://backend.example.com" },  // the TypeTorch backend (`typetorch backend setup` writes it)
  // optional safety thresholds (see "Health window and auto-rollback settings"):
  "health": { "errors": 3, "window": 30, "rollback": true, "dev": { "rollback": false } },
  "autoRollback": { "failedPct": 20 }
}
```

Gitignore `.env`, `.typetorch/`, `src/shared/build.ts`, `.payload.gen.project.json` and `.tsconfig.typetorch.json`.

**Secrets go in the game repo's `.env`, everything else in `typetorch.json`** (CLI 0.9, plans/21). `typetorch doctor`
lists every value the CLI reads and where it came from (Config).

### Health window and auto-rollback settings

- `"health"`: on each server a new build is rolled back when its own scripts throw `errors` errors (1-100, default 3)
  within `window` seconds of starting (5-300, default 30), or an `onStart` fails. `"rollback": false` keeps a failing
  build running: the server only reports `degraded` (a `health_degraded` alert). `"prod"` and `"dev"` override any of
  the three for builds of that channel. Per channel, not per branch: the values ride the build, and `promote` moves a
  build between branches without a rebuild.
- Every build stamps the result on the payload root as `HealthErrors`, `HealthWindow` and `HealthRollback` (the
  defaults when unset). Kernel 0.3.7+ reads them when it mounts the build; older kernels ignore them (3, 30 s, on).
  Prod payloads are signed deploys of your own uploads, so the values are trusted like the code.
- `"autoRollback": { "failedPct": 20 }`: `--wait` rolls the branch back when this % (1-100) of the servers that tried
  the build report `failed` or `rolled_back`. `--rollback-at <pct>` overrides it for one command.
- `build` and `deploy` print the health line; `deploy` prints the auto-rollback line; `doctor` shows both.
- A noisy game: measure first. Deploy to a dev branch, play, and count your errors in the first 30 s (dev menu >
  Server > Status shows "Health window: errors / limit, time left"). Then set `errors` above that, or fix the errors.

### Keys

Keys are read from, highest priority first: the real environment; the **game repo's `.env`** (next to typetorch.json:
`--config`'s folder, else the nearest folder with typetorch.json at or above the working directory). No other `.env`
is read (before CLI 0.9 every parent folder's `.env` counted). `--env-file <path>` or `TYPETORCH_ENV_FILE` (real
environment) is an override: that file is read **instead of** `.env`. A `TYPETORCH_ENV_FILE=` line inside the game's
`.env` (the CLI 0.8 layout) is still followed for CLI 0.9 only, with a warning: move the keys into `.env`. Values Bun
auto-loads from `.env*` files count as that file, not as the environment. Nothing read from a file is copied into
`process.env`, a key goes only into the client for its job, and child processes (rbxtsc, rojo, lune, bun scripts, git)
get an allowlisted environment without any key. Keys are never printed.

| Variable | Used for | Scopes |
|---|---|---|
| `OPENCLOUD_ASSETS_KEY` | payload uploads and moderation (`deploy`, `upload`); the cloud test (`test --cloud`, the prod gate); hot assets (`assets sync`, `assets status`); doctor's place check | `asset:read` (also on the place), `asset:write`; `universe.place.luau-execution-session:read` + `:write` for the cloud test, hot assets and doctor |
| `OPENCLOUD_DEPLOY_KEY` | deploy messages and the shared seq (`deploy`, `rollback`, `promote`, `keys resign`); the signed settings record (`settings`, `access push`, `backend setup`, `keys rotate` / `resign`) | `universe-messaging-service:publish`; `universe-datastores.objects:read` (+ `:create` and `:update` to claim seqs, store the durable head and write the settings; see "The shared seq", "The durable head" and "Settings"). No `universe:write` / `universe:read`: nothing is kept in ConfigService since CLI 0.8 / kernel 0.3.8 |
| `OPENCLOUD_PLACE_KEY` | `kernel deploy`, `kernel restore` (manual only) | `universe.place.luau-execution-session:read` + `:write` (the default luau engine: Luau Execution tasks patch and save the place) and `asset:read` (place versions); `universe.place:write` only to publish files (`--place-file`, `kernel restore <file>`, `--replace-place`). **Roblox has no API-key route for downloading place files**: Asset Delivery needs `legacy-asset:manage`, which can't be granted to API keys, and `universe.place:read` shipped but only covers the place version history (`/place-version-history-api/v1/{placeId}/history`, `/contributors`; a key limited to one experience even gets 403 "Scope must be configured to allow all resources" there) |
| `OPENCLOUD_API_KEY` (alias `ROBLOX_API_KEY`) | any job without its own key | all of the above |
| `TYPETORCH_API_KEY` | the TypeTorch backend's **game key** (write-only): `backend setup` checks it and writes it into the settings record (game servers post heartbeats, events and errors with it); the CLI posts alerts with it. **Since CLI 0.9 never a Roblox key**: an old value that still looks like one (the same as an Open Cloud variable, or the CLI 0.8 layout next to `TYPETORCH_FLEET_INGEST_TOKEN`) is refused with the rename to do | - |
| `TYPETORCH_ADMIN_TOKEN` | the backend's **admin token**: `servers`, `report`, `alerts`, `--wait`, the owner list (`PUT /v1/access`); never goes into the record | - |

Old names, read in CLI 0.9 only, with a warning naming the new one: `TYPETORCH_FLEET_TOKEN` (= `TYPETORCH_ADMIN_TOKEN`),
`TYPETORCH_FLEET_INGEST_TOKEN` (= `TYPETORCH_API_KEY`).

Other settings: `TYPETORCH_STATE_DIR` (where the logs live, default `.typetorch/`), `TYPETORCH_PROPOSED_BY`, `TYPETORCH_ROJO` / `TYPETORCH_LUNE` (tool paths), `TYPETORCH_CHILD_ENV=NAME,NAME` (extra
non-secret variables for child processes), `TYPETORCH_KEY_FILE` / `TYPETORCH_FALLBACK_KEY_FILE` (the signing key files;
read from the real environment only, never from an env file, and never passed to a child process).

The signing keys are not environment variables: they are key files (see "Signing prod deploys").

### Approving deploys

Every deploy, rollback and promote is approved by a person in their own terminal (`"approval": "all"`, the default;
`"prod"` asks only for prod-channel branches, `"none"` never asks). No key or passphrase is involved: it is a y/N.

1. **You deploy:** `typetorch deploy` in a terminal builds, uploads and waits for moderation, then shows the details and
   asks y/N: one command.
2. **Anyone else deploys** (an agent, the remote-claude dev-server, a script, or you with `--propose`): the same build,
   upload and moderation, then a **proposal** in `proposals.jsonl` (state dir) and nothing published. It prints
   `approve with: typetorch approve <id>`. Proposals expire after 24 h. `--proposed-by` / `TYPETORCH_PROPOSED_BY` names
   who prepared it (default: `cli` at a terminal, `agent` otherwise).
3. **`typetorch approve [id]`** lists the pending proposals (newest first), shows branch, artifact, notes, sources, size,
   proposer and age, asks y/N, then publishes and logs it. It refuses when stdin isn't an interactive terminal.
   `typetorch reject <id>` drops one; `typetorch proposals [--all]` lists them.

Approval and signing are separate: whatever publishes a release to a prod-channel branch (your y/N, or `"approval":
"none"`) signs it automatically. Approval itself is enforced by the CLI only, so for dev-channel branches (unsigned)
anything that holds the Open Cloud deploy key, or runs code on any server of the universe, can still publish a deploy
message. Keep the deploy key away from agents.

### Signing prod deploys

Releases (deploy, rollback, promote, re-sign) and pins to a **prod-channel** branch are signed with two Ed25519 keys
when they are published; dev-channel ones never are. Every prod message, durable head and the settings record carry `sig` (main key) and
`sigF` (fallback key). The kernel's rule is strict: once the key asset has loaded on a server only `sig` counts; while
it never loaded only `sigF` counts (rules: [Prod signing](https://github.com/typetorch/docs/blob/main/guides/prod-signing.md)).

| | Main key | Fallback key |
|---|---|---|
| Key file (plaintext JSON, no passphrase: keep it safe and backed up) | `~/.config/typetorch/keys/<universeId>.key` | `~/.config/typetorch/keys/<universeId>.fallback.key` |
| Other path | `--key-file` or `TYPETORCH_KEY_FILE` | `--fallback-key-file` or `TYPETORCH_FALLBACK_KEY_FILE` |
| Where servers get the public key | the **key asset** (a group-owned Model with `PublicKeys` / `RevokedKeys` attributes; its id is stamped on the kernel as `KeyAssetId`) | baked into the place as `FallbackPublicKey` |
| Replace it | `typetorch keys rotate` (no restart; re-signs the live prod heads) | `typetorch keys init --fallback --force`, then `typetorch kernel deploy` |

**Set up once, in this order:**
1. `typetorch keys init`: the main key file, `signingPublicKeys`, and the key asset (created through Open Cloud with
   the assets key; its id goes into `keyAssetId`). Running it again resumes or does nothing.
2. `typetorch keys init --fallback`: the fallback key file and `fallbackPublicKey` (no network).
3. Commit typetorch.json (public keys only).
4. `typetorch kernel deploy`: bakes `KeyAssetId`, `FallbackPublicKey` and `BootstrapHeads` (the current prod heads,
   which the kernel trusts unsigned: heads stored before signing have no signature) into the place's kernel (patched
   in; servers run it after a restart). It refuses to publish without the keys. Run it from the machine with the
   latest deployment log.
5. `typetorch doctor`: both key files exist and match typetorch.json, the key asset (Approved, right owner, same
   lists) and the place's kernel attributes; any mismatch is a warning.

**Recovery:** a lost or leaked main key: `typetorch keys rotate`. The key asset trusts only the new key and revokes
the old one, `TypeTorch/rekey` tells servers to re-read it, and then each prod-channel branch's live head is
**re-signed**: the same artifact and asset as a fresh signed message with a new seq and `r` = `"resign"` (servers
update the head, no swap), through the approval policy like any prod publish. `typetorch keys resign` does only that
step (to retry it). A leaked or lost fallback key: `typetorch keys init --fallback --force` (adds the old key to the
key asset's RevokedKeys first, then makes a new pair), then `typetorch kernel deploy`.

**Signed pins (A/B experiments on prod):** `typetorch pin <artifact> --branch <b> (--servers <jobId,...> | --pct
<1-99>)` and `typetorch pin --unpin --branch <b> (--servers ... | --all)` publish `TypeTorch/pin` (kernel 0.2.3 fields)
with `sig`/`sigF` on prod-channel branches, after a y/N (the approval policy; pins can't be proposals because servers
drop them after 120 s). `--by <userId>` names the owner (default: the only "owner" in `members`, else the creator
userId). Unsigned pins from the in-game Manage tab only work on dev-channel servers.

No command prints a seed; a key file inside the repo or any git work tree is refused. The remote-claude dev-server only
deploys dev-channel branches, never gets the key variables, and is refused if it ever tries to publish to prod. Dry runs
show whether signing is ready, with placeholders instead of real signatures. Anyone who can write the group's assets
(including the upload/CI key) can change the key asset: an accepted risk until the keys are split (D4).

## Commands

| Command | Does |
|---|---|
| `typetorch build [--branch <b>] [--channel prod\|dev] [--clean]` | writes `src/shared/build.ts`, runs rbxtsc (`bun run build` if the repo has a build script), and rojo-builds `.typetorch/payload.rbxm` with the identity stamped on the root; checks it holds only Folders and ModuleScripts; writes `.typetorch/payload.json`. `--clean`: `git clean -fdX` out/ and include/ first |
| `typetorch upload [--no-build]` | clean build, upload as a new Model asset, wait for moderation; no deploy (then `promote` it) |
| `typetorch deploy [--branch] [--channel] [--no-build] [--dry-run] [--message <text>] [--force] [--propose] [--proposed-by <who>] [--test] [--skip-test <reason>] [--wait [s]] [--no-wait] [--rollout <1-99>]` | clean build, upload, wait until Approved, log "uploaded"; the cloud test (always for prod-channel branches); then approve here (a person at a terminal) or write a proposal; on approval: deploy message, durable head, log "published"; then (prod: by default) wait for the servers' reports. Per-stage timings |
| `typetorch deploy --widen <1-100> [--branch]` | re-send the branch's live deploy (same seq) to more servers; dev-channel branches only (see "Rollouts") |
| `typetorch promote <branch> <artifactId\|assetId\|#seq\|commit> [--force] [--dry-run] [--test] [--skip-test <reason>] [--wait [s]] [--rollout <1-99>]` | point a branch at an already uploaded, approved payload (from the deployments or `uploads.jsonl`) with a new seq; no rebuild. A prod-channel branch only takes prod-channel artifacts, even with `--force` ("rebuild for prod"). `promote <artifact> <branch>` works too when only the second is a known branch |
| `typetorch rollback [--branch] [--to <commit\|artifactId\|assetId\|#seq>] [--force] [--dry-run] [--test] [--wait [s]]` | point the branch at an earlier, already approved asset (no build or upload) and tell its servers; no cloud test unless `--test` (it is an earlier build) |
| `typetorch deployments [--branch] [--limit n]` | deployment history with git identity; `*` = each branch's live head; lists uploads that never went out |
| `typetorch branch ls` | branches, channels and live heads |
| `typetorch settings status` / `get [field\|game.<key>]` / `set game.<key> <json\|->` / `unset <field>` / `push` | the signed settings record (see "Settings"); `push` writes `defaultBranch`, `channels` and dev access from typetorch.json. `--dry-run`, `--force`, `--no-ping` |
| `typetorch access push [--dry-run]` / `access status` | typetorch.json `members`, `revoked`, `devBadgeId` into the settings record's `access` / compare it with typetorch.json |
| `typetorch kernel deploy [--dry-run] [--yes] [--install] [--base published\|latest\|<n>] [--engine luau\|splice\|lune] [--place-file <file>] [--timeout <s>] [--kernel <dir>] [--no-backup] [--loadstring]` | patch the kernel (and the backup build) into the live place (check, y/N, save, verify); no download: Luau Execution tasks do it (the luau engine), or `--place-file` patches a Studio copy (splice); `--replace-place --yes` for the template/test place only; see below |
| `typetorch kernel restore --version <n> [--dry-run] [--yes]` | republish place version `n` (a task on it calls SavePlaceAsync): the undo of a kernel deploy |
| `typetorch kernel restore <file> [--dry-run] [--yes]` | publish a place file: a backup from `.typetorch/place-backups/`, or a dry run's patched file |
| `typetorch backup refresh [--build <x>] [--dry-run] [--yes] [--force]` | make a proven-healthy prod build the place's backup build now (luau engine, only that slot); see "Backup build" |
| `typetorch deploy --reupload <artifactId|#seq|commit|assetId> [--branch <b>]` | moderation took down an approved build: upload its kept bytes as a NEW asset, then deploy it (cloud test, approval, new seq, signed on prod); see "Backup build" |
| `typetorch approve [id] [--import <dir>] [--test] [--skip-test <reason>] [--rollout <1-99>] [--wait [s]]` | approve a proposal: details, y/N, publish (interactive terminal only); prod-channel ones are signed. A prod deploy or promote proposal without a passed (or skipped) cloud test runs it before the y/N. `--import`: a proposal state dir from automation you run yourself (see "No GitHub Actions") |
| `typetorch test [--cloud] [<artifact>] [--branch] [--seconds <n>] [--no-swap]` | the cloud test on its own (see "Cloud test") |
| `typetorch servers [--branch] [--watch]` | live servers from the fleet API (see "Fleet") |
| `typetorch alerts [--follow] [--level] [--since <min>]` | the fleet's alerts (see "Fleet") |
| `typetorch backend setup [--url <url>] [--flush-seconds <s>] [--record-share <0-1>] [--dry-run] [--force]` | point game servers at the TypeTorch backend: checks, then the record's `backend` section (and the old `fleet`/`analytics` from it), ping, owner list, typetorch.json `backend.url` (see "Fleet") |
| `typetorch report <seq\|artifact\|latest> [--branch]` | what the servers did with one deploy; exits 1 when one failed or rolled back (see "Fleet") |
| `typetorch keys init [--key-file]` / `keys init --fallback [--force] [--yes]` / `keys rotate [--yes]` / `keys resign` | the signing keys: see "Signing prod deploys" |
| `typetorch pin <artifact> --branch <b> (--servers <ids> \| --pct <1-99>)` / `pin --unpin --branch <b> (--servers <ids> \| --all)` | A/B experiment pins, signed on prod-channel branches; `--by`, `--dry-run` |
| `typetorch reject <id> [--reason]` / `typetorch proposals [--all]` | drop a proposal / list them |
| `typetorch assets sync [--dry-run] [--deploy <branch>] [--place-version <n>]` | hot assets: export the instances marked `TypeTorchAsset` from the place's latest published version, upload new and changed ones, write `typetorch.assets.lock.json`; see "Hot assets" |
| `typetorch assets status` / `typetorch assets list` | export + diff without uploading / the lockfile |
| `typetorch remote-claude --users <ids> [...]` | runs `typetorch-dev-server remote-claude` ([`@typetorch/dev-server`](https://github.com/typetorch/dev-server)) with the same arguments in this terminal, and exits with its code: devs prompt Claude Code on this machine from the in-game DEV > Claude tab (dev-channel branches only). Found in `TYPETORCH_DEV_SERVER` (an entry), `node_modules/@typetorch/dev-server` in the game repo or a parent, next to this CLI (`npm i -g @typetorch/dev-server`; with npx: `npx -p @typetorch/cli -p @typetorch/dev-server typetorch remote-claude ...`), or a sibling `../dev-server` checkout; else a clear error. It gets the real environment (the dev-server reads the key, `--env-file` / `TYPETORCH_ENV_FILE` and `.env` itself) |
| `typetorch dev --users <ids> [...]` | the same as `typetorch remote-claude` |
| `typetorch migrate --from flamework [--dry-run] [--net compat\|native] [--report <file>] [--allow-dirty]` | the mechanical part of moving a Flamework 1.x game (see "Migrating from Flamework"); local only, no keys |
| `typetorch update [<version>] [--check] [--yes]` | updates this CLI to the newest `@typetorch/cli` on npm (or `<version>`) the way it was installed: in the game's `package.json` with its package manager (bun, pnpm, yarn or npm, from the lockfile; a devDependency stays one), or globally (`npm i -g`, `bun add -g`, pnpm, yarn). Asks y/N first (`--yes` skips; without a terminal it prints the command). npx needs nothing (`npx @typetorch/cli@latest`); a git checkout gets the `git pull` to run. `--check` only shows the versions and the command |
| `typetorch doctor [--show-ok]` | prints the **Config** section (every value the CLI reads and where it came from: typetorch.json, the game repo's `.env`, the environment, the settings record; secrets only as set / unset), then checks the runtime, bun, zstd, git, rojo 7.7.x, roblox-ts, `typetorch.json`, the env file, each job's key, the approval policy, the state dir, the health window per channel and the auto-rollback threshold, the signing keys (key files vs typetorch.json, the key asset, the place; the place and the key asset's content through one Luau Execution task with the assets key; the same task warns when the place still holds `ServerStorage.TypeTorchDev`, the Studio local payload folder that live servers ignore), the backend (typetorch.json `backend.url` with your keys: url, `/healthz`, the game key's and the admin token's roles; the record's own backend section; a stale tunnel or a wrong key is a FAIL with the fix), the backend's owner list against the signed record, **live servers** (FAIL when the published place has the kernel, the default branch has no verified head in the DataStore heads or the kernel's BootstrapHeads, and the place has no backup build: kernel 0.3.6+ then moves every player out after 15 s and kicks after 3 bounces; the fix names the git branch mapped to the default branch and `kernel restore --version <n>`), **old game build** (warn when a roblox-ts build such as `ServerScriptService.TS` or `ReplicatedStorage.rbxts_include` runs next to the kernel), and probes each key's scopes with harmless calls. Only problems and info lines print; `--show-ok` lists the passed checks too (`--json` always has every check) |

Every command takes `--json` (one JSON document on stdout; human lines go to stderr), `--verbose`, `--config <path>`
and `--env-file <path>` (`remote-claude` passes everything to the dev-server). Under Node, an `--env-file` naming a
missing file is reported by Node itself (`node: <file>: not found`, exit 9): Node checks that flag even after the
script name.

**Long waits name what they wait on.** On a terminal, one line on stderr is redrawn while anything takes longer than a
quarter second, e.g. `⠹ 12s  waiting on: moderation of asset 123 (12s), publish message (1s)` (jobs over 10 s turn
yellow; `|/-\` instead of braille on Windows consoles without UTF-8). Log lines clear it first, prompts hide it, and
the cursor comes back on exit and on Ctrl+C. Without a terminal (CI, agents, pipes) there is no animation: a job past
15 s prints `still waiting on: ...` every 15 s. `--json` prints none of it.

### Migrating from Flamework

`typetorch migrate --from flamework`, in the game folder (next to `tsconfig.json`), rewrites the source with the
TypeScript compiler API, using the game's own `node_modules/typescript` (no extra dependency). It refuses a working
tree with uncommitted changes (`--allow-dirty`), so the migration is one diff to review; `--dry-run` prints that diff
and writes nothing.

- **Rewrites:** `@flamework/core` imports to `@typetorch/framework` (unsupported names are dropped when unused, else
  kept and flagged); `@Service` / `@Controller` classes `extends Module` (or their local base class does) and call
  `super()`; a module's own `trove = new Trove()` gives way to Module's; `@metadata flamework:*` tags; ignite files
  (`*.server.ts` / `*.client.ts` with `Flamework.ignite()`) become `src/<realm>/boot.ts` with the `addPaths` folders,
  and their other top-level code moves into a generated module's `onStart` in the first folder.
- **Networking:** `--net compat` (default) swaps `Networking.createEvent` / `createFunction` for the framework's
  `createFlameworkCompat`, so every call site stays as it is. `--net native` merges each file's networks into one
  `createNetwork` and rewrites the call sites (`connect` -> `on` in `this.trove`, `setCallback` -> `handle`,
  `broadcast` -> `fireAll`, `except` -> `fireExcept`, `predict` -> `emit`, `fire(players[])` -> `fireList`, the call
  shorthand -> `fire` / `invoke`), deletes handler files that only created handlers, and flags what it can't decide.
- **Flags (not rewritten):** module-level state, `Players.PlayerAdded.Connect`, `_G`, loops / `task.*` / connections
  outside a trove, `@flamework/components`, `Dependency<T>()` before construction, `loadstring`, remotes,
  MessagingService, DataStore / ProfileService code, BindToClose, Scripts left in the source tree, toolchain leftovers.
- **Output:** `typetorch-migrate-report.md` (`--report`): a summary, every flag by kind with file, line and the fix,
  and what was rewritten; plus a short summary on the terminal (`--json` for both as data).

`typetorch build` warns while the game still uses `createFlameworkCompat` (its calls are part of the protocol hash).

### Identity

- **Artifact id:** `<commit7>-<hash6>`, e.g. `12b63b9-3fa91c`, or `<commit7>-dirty-<hash6>` for a working tree with
  uncommitted changes (`uncommitted-dirty-<hash6>` without commits). `commit7` is the first 7 hex of HEAD (what
  `$git("Commit")` compiles in); `hash6` is the first 6 hex of the SHA-256 of the payload built with the id minus its
  hash. Same bytes, same id (a promote keeps it); different bytes, different id (every rebuild stamps a new build time).
  The channel is metadata, not part of the id. Legacy ids (`dev-12b63b9`, `prod-12b63b9.r2`, `asset-<id>`) are still
  read everywhere, including `rollback --to` and `promote`.
- **Deploy number:** `#seq`, global and monotonic: the handle to paste when something goes wrong.
- **Branch:** `--branch`, else `typetorch.json` `branches[gitBranch]`, else the git branch lowercased with `/` → `-`.
- **Channel:** `--channel`, else `channels[branch]`, else `prod` for `defaultBranch`, else `dev`. A prod-channel branch
  refuses a dev-channel or dirty artifact unless `--force`.
- **Sources:** the game commit (`template`), and for the framework and kernel `v<version>` of the installed npm
  package, or, with the template's optional local override (`bun run packages`, which packs sibling checkouts and
  writes `.typetorch/packages/manifest.json`), the checkouts' commits. `<commit>*` means a dirty checkout. Stamped as
  payload attributes and as `SOURCES` in build.ts, and logged.
- **Payload root attributes:** `ArtifactId`, `KernelApi` (1), `Channel`, `Commit`, `BuiltAt` (unix seconds),
  `SourceTemplate`, `SourceFramework`, `SourceKernel`, `Notes`, `ProtocolHash`, and `Assets` (also on the payload's
  `Server` folder; see "Hot assets").
- **`ProtocolHash`** (`p1-<16 hex>`; kernel 0.3.2 lets client events cross a hot swap when the old and new payloads
  carry the same one): a hash of the arguments of every `createNetwork(...)` call in the compiled game (`out/`), which
  @typetorch/transformer generates from the network interfaces (every leaf's path and argument guard, both
  directions), canonicalized so comments, whitespace, file paths and the order of unions, literal lists and fields
  don't count, plus the framework's net runtime (`out/net/runtime.luau`: a new wire format is a new protocol). No
  `createNetwork` call, nothing stamped. `typetorch build` and `deploy` print `protocol unchanged since #N` or
  `protocol changed since #N` against the branch's previous deploy (recorded as `protocolHash` in the logs).
- **`Notes`** (what the dev menu shows): a JSON string, at most 4000 bytes,
  `{"v":1,"message":"…","changes":["template: …","framework: …"],"sources":{"template":"…","framework":"…","kernel":"…"},"built":"<ISO>","branch":"…"}`.
  `message` is the deploy's `--message` (remote-claude passes Claude's summary); `changes` are the game's commits since
  the branch's previous deploy, then framework and kernel commits (`first deploy of <branch>` or `rebuild, no source
  changes` when there are none). Change lines are dropped first when it is too long.
- **Asset name:** `tt-<branch>-<artifactId>[-<channel>]` (only `[a-z0-9-]`, at most 50 characters; the channel only
  when `--channel` overrides the branch's). Roblox's text filter censors some names to `####`, so after the deploy
  message the CLI renames a censored asset to `TypeTorch payload`.
- **Asset description:** only `artifact=<id>` and `commit=<sha7>`. Roblox's text filter censors descriptions too (a
  longer one came back as all `#`), so the notes live in the `Notes` attribute. After the upload the CLI reads the
  description back and warns when it was censored (harmless).
- **`src/shared/build.ts`** ends with a `// <build time>` line so its text changes on every build (rbxtsc's incremental
  compile skips unchanged files). Repo build scripts that write build.ts themselves should skip it when
  `TYPETORCH_SKIP_BUILD_INFO=1`.

### Builds

- **Clean deploys:** `deploy` and `upload` run `git clean -fdX` on out/ and include/ (ignored files only) before
  building. A clean id is refused when git-ignored files sit in the payload's source dirs, or a compiled file has no
  tracked source.
- **Payload check:** the built `.rbxm` must be one `Model` holding only `Folder`s and `ModuleScript`s; anything else
  (Scripts, values from `.txt` files, models from `.rbxm` files...) fails the build with its path.
- **Debug macros per channel:** dev builds keep `rbxts-transform-debug`'s `$print`/`$warn`/`$dbg` with their
  `[src/file.ts:line]` prefixes. Prod builds compile with a generated `.tsconfig.typetorch.json` (deleted afterwards)
  whose first plugin is a CLI transformer: `$print`/`$warn` are removed (arguments not evaluated), `$dbg(x)` becomes `x`,
  `$assert`/`$error` keep their check without the source path. The CLI appends `-p .tsconfig.typetorch.json` to a build
  script that ends with `rbxtsc` (else it runs rbxtsc directly). Compiles also get `TYPETORCH_CHANNEL` and
  `TYPETORCH_DEBUG_MACROS` (`1`/`0`).

### Deploy message

`POST /cloud/v2/universes/{universeId}:publishMessage`, topic `TypeTorch/deploy`, message
`{"b":branch,"a":assetId,"i":artifactId,"s":seq,"c":commit,"ch":channel,"t":unixMs,"r":1?,"ro":pct?,"sig":"…","sigF":"…"}`
(`ro`: the rollout %, dev-channel only, see "Rollouts"; `r`:
`1` for rollbacks, `"resign"` for heads re-signed by `keys rotate`; `sig`/`sigF` only for prod-channel branches: base64
Ed25519 over
`tt1\n<b>\n<a>\n<i>\n<s>\n<c>\n<ch>\n<t>\n<r>`, rules in [Prod signing](https://github.com/typetorch/docs/blob/main/guides/prod-signing.md)). Servers on
branch `b` swap, and persist it as their branch head (the higher `s` wins; heads are ordered by `(seq, time)`).
`TypeTorch/rekey` `{"t":unixMs}` tells servers to re-read the key asset (after `keys rotate`).

### Logs and the state dir

The state dir (`TYPETORCH_STATE_DIR`, default `.typetorch/`) holds `deployments.jsonl` ("published" lines, with
`proposalId` and `proposedBy` when approved from a proposal), `uploads.jsonl` ("uploaded" lines, written as soon as
moderation answers, before anything is published), `proposals.jsonl` (proposed / approved / rejected / failed events)
`kernel-deploys.jsonl`, `assets.jsonl` (hot assets: created / uploaded / failed / synced), `tests.jsonl` (every cloud
test: asset, pass or fail, seconds, place version, task) and `rollouts.jsonl` (`deploy --widen`). A deployment line
carries `test` (`{ok, seconds, placeVersion}` or `{skipped: "<reason>"}`) and `rollout` when they apply. Choosing a seq and logging
it happens under `deploy.lock` there (`assets sync` holds `assets-sync.lock` instead), and logs are only appended.
The remote-claude dev-server points the deploys it runs from its worktree at the main repo's state dir, so both share
one log and one seq. If a deploy stops after the upload, `typetorch deployments` lists the upload with its
`typetorch promote` command.

### Settings

Kernel 0.3.8 reads ONE signed record instead of ConfigService (CLI 0.8 removed the ConfigService registry, `config
push` and every `universe:write` / `universe:read` use): the game's DataStore `TypeTorch`, key `settings`,
`{ v: 1, seq, at, body, sig, sigF }`. `body` is JSON text with `defaultBranch`, `channels`, `access` (`members`,
`revoked`, `devBadgeId`), `backend` (`{url, key, analytics?}`; CLI 0.9), the old `fleet` (`{url, token}`) and `analytics` (the sink settings) derived from it for kernels before 0.4 and `game` (the game's live values,
`TypeTorch.liveConfig`); at most 32 KB, `game` at most 16 KB. `sig` and `sigF` are Ed25519 by the main and the fallback
prod key over the lines `tt1settings`, `<seq>`, `<at>` and `<body>` joined with `\n`: the body is the exact text stored,
so nothing is re-encoded before verifying.

Every write (`settings set|unset|push`, `access push`, `backend setup`, `keys rotate|resign`) reads the record, refuses
one your keys didn't sign (`--force` replaces it and drops its fields: they're never re-signed), changes one field,
raises `seq`, signs with both keys and writes it with `matchVersion` (or `exclusiveCreate`), starting over when
another machine wrote in between. Then a ping on `TypeTorch/deploy`, `{"k":"settings","s":<seq>}`, makes 0.3.8 servers
read it within seconds (`--no-ping`: within about a minute). All of them need both key files (else "run `typetorch keys
init`"). `settings status` and `get` print no token. **After every write** the record's owners go to the backend
(`PUT /v1/access {seq, owners}` with `TYPETORCH_ADMIN_TOKEN`; only owners may Sign in with Roblox there): a backend that
is down, refuses, or holds a newer seq is a warning, never a failed write; `typetorch access push` sends them again. Servers verify by the same strict rule as prod deploys and refuse an older seq, so game code (which
can write DataStores) can't change it; it can only put back an older signed copy, which running servers refuse (a
fresh write fixes it).

**Endpoint checks (the backend never reaches the record broken).** A wrong address or key in the record is not
rejected by anything else: game servers just fail every request ("NetFail", HTTP 401 or 530) until someone looks at the
dev menu. So `typetorch backend setup` tests the value BEFORE reading the record or signing, and `typetorch doctor` runs
the same tests against the live record:

| Step | What is checked | Typical fix it prints |
|---|---|---|
| `url` | parses; https (the kernel's Fleet module and Roblox servers only use https); no user info; the base address, not an endpoint path, and only the characters the kernel accepts | give the public https address |
| `healthz` | `GET <base>/healthz` answers 200 `{"ok":true}` within 5 s; redirects are reported, not followed | a dead quick tunnel: start `bun run local` again; a stopped server; a wrong host |
| `key` | `GET <base>/v1/auth/check` (no side effects) with `TYPETORCH_API_KEY` says role `game` (write-only) and that the fleet and analytics parts run | put the backend's API key in the game repo's `.env` |
| `admin` | the same with `TYPETORCH_ADMIN_TOKEN` says role `admin` | put the backend's admin token in `.env` |

A failure prints each failing step with a `fix:` line in red, writes nothing (no record, no ping, no typetorch.json
change) and exits 1; `--force` writes anyway and prints the failures as warnings, **except** when the value in the key's
place is the admin token or anything else that isn't the game key (the same value for both, or role `admin`): that is
refused with `--force` too, because the record is readable by every server script (security review M2). `--dry-run`
runs the checks too. Server text in messages has terminal escapes and control characters removed, and a redirect's
`Location` is scrubbed of the key (L5). `doctor` lists `backend url / healthz / key / admin` for typetorch.json's
`backend.url` with your keys, the record's own backend (or the old fleet / analytics sections of a CLI 0.8 record),
and compares the backend's owner list (`GET /v1/access`) with the signed record's owners.

`--no-registry` (deploy, rollback, promote, approve, kernel deploy) is accepted and prints a one-line note.
`--require-shared-seq` and `--require-registry` are gone (CLI 0.9).

### The shared seq

Every machine (your PC, CI, the remote-claude dev-server) must take deploy numbers from one sequence: servers order
heads by seq and ignore one at or below the seq they applied. The next seq is the highest of:
- the state dir's `deployments.jsonl` (this machine);
- the game's DataStore `TypeTorch` (Open Cloud DataStores, the deploy key with `universe-datastores.objects:read`):
  the kernel's `heads` and `deployments` records (every live server records each deploy message it hears, so they lag
  only while no server runs) and `seq`, the CLI's own counter;

plus one. When the key also has `universe-datastores.objects:create` and `:update`, the seq is **claimed** with one
atomic increment of `seq` (by enough to clear every source), so two machines deploying at once never share a number,
whether servers run or not. The deployment line records where it came from (`seqSource`: `counter`, `read` or `local`).
Without the read scope a deploy warns and uses this machine's log only.

### The durable head

After the deploy message goes out (`deploy`, `promote`, `rollback`, `approve`, the automatic rollback, and `deploy
--widen`), the CLI also writes the head into the game's DataStore `TypeTorch`: `heads.<branch>` (the shape the kernel
stores, with `sig`/`sigF` for prod) and the deploy's entry in `deployments` (newest first, 100 kept). So a deploy made
while **no server of that branch runs** isn't lost: with kernel 0.3.5, new servers boot it and running ones pick it up
within about a minute (the kernel reads this copy every ~60 s and writes the MemoryStore copy back). It is a
read-merge-write guarded by the entry's version (DataStores v1 `matchVersion`, or `exclusiveCreate` for a new key),
retried when a game server wrote the key meanwhile, and a branch's seq is never lowered. It needs the shared seq's
scopes (`universe-datastores.objects:read`, `:create`, `:update`); without them the deploy still succeeds, with one
warning: "the head isn't stored durably: deploys reach only running servers". `typetorch doctor` checks the write
scopes (`scope datastore write`, a tiny value under the key `doctor`).

CLI 0.8.1 (kernel 0.3.9): `heads.<branch>` also keeps the branch's last 3 heads before it as `prev` (newest first, the
same shape). `/tt rollback` on a server that booted straight into a bad build uses them (a server-local swap; prod
servers take only a previous head whose signature verifies); `typetorch rollback <branch>` still rolls the whole
branch back. Records written before have no `prev` (the kernel falls back to the deployment history).
`typetorch deployments` shows each row's branch channel (prod: the default branch or one configured prod), with the
build's channel in brackets when it differs.

### Hot assets

Builders edit models and UI templates in the real place and publish it as usual; running servers pick up the new
versions without a restart (the framework's `hotAsset`). Guide: [Hot assets](https://github.com/typetorch/docs/blob/main/guides/hot-assets.md).

- **Marking:** any instance with the string attribute `TypeTorchAsset` = a key: lowercase `a-z 0-9 / - _`, at most 64
  characters, unique in the place. A hot asset may not contain scripts (any LuaSourceContainer), may not sit inside
  another hot asset, and its parents' names may not contain `/`. A service can't be one. The sync refuses and lists
  every problem before uploading anything.
- **`typetorch assets sync`:**
  1. **Export:** a Luau Execution task on the place's **latest published** version (the newest version the Assets API
     marks `published`; `--place-version <n>` picks one) finds them, checks them, and serializes each with
     `SerializationService:SerializeInstancesAsync`. The task returns its metadata as `ReturnValues` and the bytes as
     binary output (`enableBinaryOutput`: `TTA1` + the exports back to back, at most 256 MiB, downloaded from a
     presigned URL that never gets the key). The task drops the runtime's stamps (`TypeTorchAssetId`,
     `TypeTorchAssetHash`, `TypeTorchAssetVersion`, `__typetorch_asset:*` tags) from its own copy first; the place is
     never changed.
  2. **Diff:** SHA-256 of each export, first 12 hex, against the lockfile: added, updated, removed, unchanged (and
     moved: same bytes, another parent).
  3. **Upload** (4 at a time): a new key gets a group-owned Model; a small placeholder (version 1) reserves the id,
     then the export is PATCHed on as version 2. A changed key gets a new version of the SAME asset (PATCH), so ids
     never change. Every uploaded copy carries `TypeTorchAssetId` (number) and `TypeTorchAssetHash` on its root.
     Waits for moderation (`--moderation-timeout`, default 600 s). A removed key's asset stays on Roblox, and comes
     back with the same id if the key does.
  4. **Resolve:** a second task calls `InsertService:GetLatestAssetVersionAsync(id)` for each upload and loads that
     version to check its `TypeTorchAssetHash` (retrying for up to 60 s), giving the `assetVersionId` that
     `LoadAssetVersion` needs.
  5. **Write** `typetorch.assets.lock.json` (commit it), **only when every upload and lookup worked**: its
     `placeVersion` promises that every entry matches the place at that version, and new servers adopt the place's own
     copies on that promise. A failed run writes nothing and exits 1; the next run reuses its approved uploads
     (`assets.jsonl`) and a placeholder it created. A newer published place with the same assets only updates
     `placeVersion`.
  6. **Report** and print the next step. `--dry-run` stops after the diff. `--deploy <branch>` then runs `typetorch
     deploy --branch <branch>` (same approval policy; `--message`, `--propose`, `--proposed-by`,
     `--moderation-timeout` and the key file flags are passed on) when the Assets attribute changes. A prod-channel
     branch only takes clean builds, so `--deploy` to one is refused while the sync changes the lockfile: sync, commit,
     then deploy.
- **`typetorch assets status`:** export + diff only (`upToDate` in `--json`). **`typetorch assets list`:** the lockfile.
- **Lockfile** (`typetorch.assets.lock.json`, keys sorted, one line per asset):

  ```json
  {
  	"v": 1,
  	"placeVersion": 57,
  	"assets": {
  		"ui/shop": {"id":123456789012,"ver":44838191841145,"n":2,"hash":"abc123def456","realm":"replicated","path":"ReplicatedStorage/Assets/UI","className":"ScreenGui"}
  	}
  }
  ```

  `id` asset id, `ver` assetVersionId, `n` version number, `hash` the export's SHA-256 (12 hex), `path` the parent's
  path, `realm` `server` under ServerStorage or ServerScriptService, else `replicated`.
- **In the artifact:** every build stamps the lockfile as the JSON attribute `Assets` on the payload root **and on its
  `Server` folder** (the kernel drops the root; the framework reads `Server`): `{"v":1,"placeVersion":57,"assets":{...}}`,
  or `{"v":1,"assets":{}}` without a lockfile. An invalid lockfile stops the build. It is data only: the payload check
  (Folders and ModuleScripts) is unchanged. On prod it rides the signed payload; a rollback brings back older versions.
- **Scopes** (the assets key, `OPENCLOUD_ASSETS_KEY` or the shared key): `asset:read` (also on the place: its version
  list), `asset:write`, `universe.place.luau-execution-session:read` and `universe.place.luau-execution-session:write`.
  A refused call stops the command and names the scope. Luau Execution allows 5 task creations per minute per key
  owner; a sync uses 2 (`status` 1).

### Cloud test (the pre-publish gate)

`typetorch test --cloud [<artifact>]` runs one Open Cloud Luau Execution task on the place's **latest published
version** (what live servers run). Measured on the test place: 9-11 s (the task itself about 7 s).

1. `InsertService:LoadAsset` the payload (the path live servers use) and the kernel's mount checks: a payload root,
   only Folders and ModuleScripts, `KernelApi` not above the place kernel's, the expected `ArtifactId`, and on a
   prod-channel branch `Channel` exactly `"prod"` (prod servers refuse anything else).
2. Mount the server tree in `ServerStorage.TypeTorch.Generations` and call `Server.boot.boot(kernel)` with a stub
   kernel (the real contract: persist, status, onMessage..., plus `test = true`); onInit runs inside it, onStart in
   spawned threads. It must return its stop function within the kernel's `READY_TIMEOUT`.
3. `require` every ModuleScript under `Shared` (5 s budget).
4. Run for `--seconds` (default 5) while `ScriptContext.Error` collects every error, spawned threads included.
5. Stop it: the stop function within the kernel's `STOP_DEADLINE` (5 s); then the tree is destroyed (scripts can't be
   disabled in a task, so the hard stop is emulated). Errors after the stop and instances the generation left behind
   are reported.
6. Boot a second generation of a fresh copy, run 1 s and stop it, as a hot swap would (`--no-swap` skips it).

**Fails** (exit 1): the load and mount checks, a boot that throws or doesn't return, any error while it runs (onInit,
onStart, Shared requires, the swap), a stop that throws, times out or logs "onStop threw". **Warnings**: errors after
the stop (live servers' hard stop kills those threads), leftover instances, game warnings. Place scripts don't run in a
task, but **DataStores, MemoryStores and HttpService do**: game code runs against real data, with no players.
`workspace:GetAttribute("TypeTorchTest")` is true there, and the stub kernel has `test = true`, for code that must not
run in the test.

**In releases:** `deploy` runs it on the approved upload, before the proposal or the message; `promote` before
publishing; both **always for prod-channel branches**, and with `--test` elsewhere (rollbacks: `--test` only, they go
to an earlier build). A pass of the same asset in the last 24 h (`tests.jsonl`) counts for promote and approve
(`--test` runs it again). `approve` runs it before the y/N for a prod deploy or promote proposal that has no pass or
skip recorded. `--skip-test "<reason>"` publishes without it; the reason goes into the proposal and the deploy log.
Scopes: the assets key with `universe.place.luau-execution-session:read` + `:write`, and `asset:read` on the place
(Luau Execution allows 5 task creations per minute per key owner; the CLI waits and retries on 429).

### Fleet: servers, reports, alerts, --wait and automatic rollback

Kernel 0.3.2+ posts a heartbeat per server, one report per deploy outcome per server (results `swapped`, `failed`,
`rolled_back`, `skipped`, `booted`) and alerts to the **fleet API**, a small service (the backend's fleet part, `@typetorch/backend`)
you host. The CLI reads it:

- **Setup:** `typetorch backend setup --url https://<host>` (see "Settings > Endpoint checks") writes the record's
  `backend` = `{url, key, analytics?: {flushSeconds, recordShare}}` and, for kernels before 0.4 and frameworks before 0.4,
  the old `fleet` = `{url, token}` and `analytics` (DuckDB ingest at `<url>/v1/ingest`, the same key; an existing
  section keeps its experiments) derived from it, with the game key from `TYPETORCH_API_KEY`, pings the servers, sends
  the owner list (`PUT /v1/access`) and sets typetorch.json `"backend": { "url": ... }` (dropping CLI 0.8's `"fleet"`,
  which is still read with a warning). Reads use the admin token in `TYPETORCH_ADMIN_TOKEN`; alerts the CLI posts use the
  game key (the backend refuses the admin token on its game routes). Both come from the environment or the game repo's
  `.env` and are never printed or passed to a child process. Without them, `servers`, `report` and `alerts` say so in
  one line, and `--wait` is skipped with a note. `typetorch fleet setup` and `typetorch settings set analytics` moved
  here (CLI 0.9; both print where).
- `typetorch servers [--branch <b>] [--watch]`: job, branch, artifact, applied seq, health (`ok`, `failed`,
  `unverified`, `degraded`), players, kernel, age (uptime), seen (last heartbeat); `--watch` redraws every 5 s.
  Reserved-server access codes are never printed.
- `typetorch report <seq|artifact|latest> [--branch <b>]`: counts per result, errors grouped with the servers that hit
  them, and the branch's servers still on an older seq. Exits 1 when a server failed or rolled back, and prints the
  rollback command.
- `typetorch alerts [--follow] [--level info|warning|critical] [--since <minutes>]`: the fleet's alerts (default the
  last 60 minutes); `--follow` keeps printing new ones.
- `--wait [seconds]` on `deploy`, `promote`, `rollback` and `approve` (and `deploy --widen`): **on by default for
  prod-channel branches (90 s)**, off for dev (`--wait` turns it on, `--no-wait` off). After the message it polls the
  reports every 5 s until every live server of the branch has reported the seq (or moved past it):
  - at about 30 s it **re-sends the same message** (same seq and signature; kernels ignore a seq they applied) when
    servers are still behind and haven't reported (kernels also poll the head every 60 s and retry failed loads);
  - **automatic rollback:** when `--rollback-at` (default: typetorch.json `autoRollback.failedPct`, else 20) % or
    more of the servers that tried the seq (`skipped` ones don't count) report `failed` or `rolled_back`, with at least one failure, it rolls the branch back to the
    previous artifact through the same path as `typetorch rollback` (signed on prod-channel branches, with the key
    files on this PC). It decides early once the share can't drop below the threshold. It posts a critical
    `auto_rollback` alert (with the ingest token; otherwise it prints it), shows "rolling back <branch> to <artifact> in
    10 s: Ctrl+C keeps the new build" at a terminal (no wait without one), logs the reason on the rollback's deployment
    line (`autoRollback`) and on the proposal (an `auto_rollback` event), waits for the rollback's own reports, and
    exits 1. `--no-auto-rollback` turns it off;
  - failures below the threshold: a red summary, the rollback command, exit 1;
  - **stalled servers alone never roll back:** their JobIds are listed, a `server_stuck` warning alert is posted, and
    the command exits 0 with a warning.

### Rollouts

`--rollout <1-99>` on `deploy`, `promote` and `approve` sends the message with `ro`: only servers whose bucket (djb2
of the JobId, mod 100) is below it swap; the others keep their artifact, and new servers boot the head.
`typetorch deploy --widen <1-100> [--branch <b>]` re-sends the branch's live deploy, the **same seq**, with the new
percentage (100 = every server, sent without `ro`); it asks y/N when typetorch.json `approval` applies, and logs to
`rollouts.jsonl`. **Dev-channel branches only:** `ro` isn't covered by the signature, so prod servers ignore it on
signed messages, and the CLI refuses `--rollout` for prod-channel branches (to try a build on some prod servers, use
signed A/B pins: `typetorch pin <artifact> --branch prod --pct <1-99>`).

### No GitHub Actions

TypeTorch doesn't use or ship GitHub Actions (owner decision: they are a common supply-chain risk). Builds,
cloud tests and deploys run from a developer's machine. `approve --import <dir>` works in any automation you choose to
run yourself.

### Kernel deploy

`typetorch kernel deploy`:
1. runs `lune run scripts/check.luau` in the kernel dir (`--kernel`, else `typetorch.json` `kernel`, else
   `node_modules/@typetorch/kernel`, else `../kernel`);
2. checks the version (package.json `version` = `KERNEL_VERSION` in `src/shared/Constants.luau`, and the kernel API)
   and prints it with a content hash (place.project.json and `src/`, LF line endings). A git checkout must be clean and
   tagged `v<version>` (`--allow-dirty`, `--allow-untagged`);
3. builds `.typetorch/place.rbxl` with `KernelVersion`, `KernelHash` and `KernelCommit` attributes, plus the signing
   trust roots `KeyAssetId` and `FallbackPublicKey` from typetorch.json and `BootstrapHeads` (the JSON of the current
   prod-channel heads, `{"<branch>":{"a","s","i"}}`, from the local log), on
   `ServerScriptService.TypeTorchKernel` (publishing refuses without the keys, or when the fallback key file doesn't
   match), and (kernel 0.3.6) the **backup build**: the current prod head's payload, which `deploy` and `upload` keep in
   `<state dir>/payloads/<artifactId>.rbxm` (API keys can't download assets), checked (one Model, Folders and
   ModuleScripts only, Channel `prod`) and stamped with `BackupArtifactId`, `BackupSeq`, `BackupBranch`,
   `BackupChannel` and `BackupAt`, as `ServerStorage.TypeTorchBackup`. Servers run it only when nothing else can (see
   the kernel's "Never an empty server"). It is a kernel slot, so every deploy replaces it. Without a kept payload for
   the prod head it warns and the place keeps the backup it has; `--no-backup` skips it. `doctor` shows the place's
   backup and its age (it warns past 30 days). When no backup is baked AND the default branch has no verified head
   (the kernel's DataStore heads, else the BootstrapHeads stamped now), publishing asks y/N first and refuses without
   a terminal unless `--force`: kernel 0.3.6+ with nothing to run moves every player out after 15 s and kicks after 3
   bounces. Deploy the default branch first (servers without the kernel ignore it);
4. **patches** the live place (the default, `--patch`): it changes ONLY the **kernel slots** (the `TypeTorch*`
   children of services in the kernel's `place.project.json`: `ServerScriptService.TypeTorchKernel`,
   `ReplicatedStorage.TypeTorchKernelShared`, `ReplicatedFirst.TypeTorchKernelClient`, and from kernel 0.3.6
   `ServerStorage.TypeTorchBackup`; every copy of each) and the service settings that project declares
   (`HttpService.HttpEnabled`; `ServerScriptService.LoadStringEnabled` only with `--loadstring`, which sets it to true
   for remote-claude's `run_luau` on a test place: without the flag a patch keeps the place's own value and
   `--replace-place` publishes it off). The base is the place's newest version, which must be published (newer
   unpublished saves are refused and listed; `--base published` patches the last publish and leaves them in version
   history, `--base latest` ships them, `--base <n>` takes that version). A place without a kernel needs `--install`.
   An active Team Create session blocks the save. Roblox has **no API-key route for downloading place files**, so
   there are two ways to get at the place:
   - **`--engine luau` (the default without `--place-file`): no download.** The slots are built alone into
     `.typetorch/kernel-slots.rbxm` (one Folder `TypeTorchKernelSlots`, a Folder per service, the slots; read back by
     the CLI's own reader) and sent once as a Luau Execution **binary input** (at most 100 MiB; valid 15 minutes).
     1. A **check task** on `/versions/<base>` deserializes it (SerializationService), reads the place's kernel,
        takes the **outside manifest** twice (every top-level child of every service that isn't a slot: tree shape,
        names, classes, attributes, tags, ObjectValue targets and script source hashes, plus the SHA-256 of its
        SerializeInstancesAsync bytes; bytes that differ between the two reads count by the descriptor only), swaps
        the slots, re-points ObjectValues that pointed into the old kernel (to the same path in the new one, or clears
        them, listed), applies the settings (one a task can't write stops it: set it once in Studio), takes the
        manifest again (anything changed stops it) and checks the slots and the identity attributes. It never calls
        SavePlaceAsync (the script doesn't contain it). The CLI compares the task's view of the new slots with its own
        reading of the `.rbxm` (instance and script counts, the script list hash), prints the summary and writes
        `.typetorch/place-patches/<placeId>-kernel-<version>-luau.json`.
     2. y/N (or `--yes`), then a check that nobody published since.
     3. A **save task** on the same version repeats all of it (its outside manifest must equal the check's) and calls
        `AssetService:SavePlaceAsync()`, which publishes (SaveWithoutPublish defaults to false).
     4. The new version comes from the version list; a **verify task** on it checks the kernel identity, one copy of
        each slot (same counts and script list) and the outside descriptor.

     Needs the place setting **"Allow place to be updated using Save Place API"** (Creator Hub > Creations > the
     experience > Places > the place > **Permissions**, `create.roblox.com/dashboard/creations/experiences/<universeId>/places/<placeId>/permissions`;
     per place, off for places made in Studio) and the place key's Luau Execution scopes. The API key's owner needs
     edit rights on the place (group places: a role that can edit and publish the experience). Errors name the fix:
     the setting, Team Create, a task timeout (`--timeout <s>`, 30-300, default 300), the 100 MiB input limit
     (`--no-backup` leaves the backup build out), a rate limit (5 task creations a minute per key owner, 10 open tasks
     per place: 429s wait and retry). The base version stays in version history: **undo with `typetorch kernel restore
     --version <base>`** (a task on that version calls SavePlaceAsync, which publishes it again as the newest version).
     *Unverified until the first live run:* the presigned upload is a PUT (`content-type: application/octet-stream`,
     then none), SavePlaceAsync's exact error texts, whether a task may read script sources and write `HttpEnabled`.
   - **`--place-file <file> --base <version>` (the splice engine): a copy downloaded in Studio** (File > Download a
     Copy), backed up to `.typetorch/place-backups/<placeId>-v<n>.rbxl`. The **splice** engine works on the binary
     chunks: every chunk of a class the kernel doesn't use is copied byte for byte; the script and folder classes are
     re-encoded with the game's own values moved as raw bytes; referents stay dense; references into the old kernel
     are re-pointed to the new instance at the same path, or cleared (listed). `--engine lune` re-encodes the whole
     place with Lune (rbx-dom) instead, which migrates some properties (Image -> ImageContent and others) and drops a
     few: only for when the splice engine refuses. It verifies twice: the CLI's binary reader (every instance outside
     the slots by path and class, no property chunk lost, the slots equal to the kernel build) and Lune (every subtree
     outside the slots equal, every reference pointing where it did, the slots and settings equal to the kernel
     build); writes `.typetorch/place-patches/<placeId>-v<n>-kernel-<version>.rbxl` and a JSON report, prints a summary
     (kernel old -> new, scripts changed/added/removed per slot, settings, references, chunks copied), asks y/N (or
     `--yes`), checks that nobody published meanwhile, and publishes with the Place Publishing API
     (`universe.place:write`). `--engine splice` without `--place-file` tries the Asset Delivery download, which API
     keys can't do today (403, with this explanation).

   `--dry-run` does everything except the save or publish. `typetorch kernel restore <file> [--dry-run] [--yes]`
   publishes a place file back: a backup (undo of a splice deploy), or a dry run's patched file (publish exactly what
   was inspected). `--replace-place --yes` publishes the whole kernel place instead and **wipes Studio/Team Create
   content** (the template/test place only). The place version before and after go to `kernel-deploys.jsonl`.

### Backup build

Kernel 0.3.6 servers run `ServerStorage.TypeTorchBackup` only when the head, the last known good and the builds other
servers run all fail. It should be at most one deploy behind:
- **Automatic:** after `typetorch deploy`, `approve` or `promote` publishes build N+1 to the default (prod-channel) branch
  at your terminal, the place's backup becomes build N once N is **proven healthy**: the fleet API has reports for its
  seq with no failure or rollback, no server running it is failed or degraded, and it went out at least
  `backup.healthyHours` ago (typetorch.json `"backup": { "refresh": "auto", "healthyHours": 3 }`; `"refresh": "off"`
  turns it off). It uses the luau engine with ONLY the backup slot (check task, save task with SavePlaceAsync, verify
  task; the rest of the place must not change). It never blocks or fails the deploy: unpublished saves, Team Create,
  the "Save Place API" setting, an unproven build, no kept payload, no place key, or a non-interactive run each print
  one line (`backup      not refreshed: ...`). A rollback never moves the backup.
- **Now:** `typetorch backup refresh [--build <x>]` (default: the prod head; y/N or `--yes`; `--dry-run`; an unproven
  build needs `--force`).
- `doctor` shows the place's backup build and its age. Each save is a new place version: a project with hot assets
  then loads them from their asset versions on new servers until the next `typetorch assets sync`.
- **A build taken down by moderation:** `typetorch deploy --reupload <build>` uploads the exact bytes kept at upload
  (`<state dir>/payloads`) as a NEW asset (uploads.jsonl `reuploadOf` = the old asset id), waits for moderation and
  deploys it like any deploy (the cloud test, the approval policy: prod = your y/N or `typetorch approve`; a new seq,
  signed on prod). The artifact id stays; servers on the old asset swap to the new copy. Then `typetorch backup
  refresh` if the backup was that build.

## Develop

```sh
bun install
bun test                    # unit tests
bun run typecheck
cd test-fixture && bun install && cd ..
bun test/fixture.e2e.ts     # builds test-fixture/ in a temp git repo; deploy/rollback/promote/kernel only as --dry-run, no keys
bun run build               # tsc -p tsconfig.build.json: src/*.ts -> dist/*.js (ESM for Node 20+; no Bun API in src)
bun run smoke               # node scripts/smoke.mjs: the compiled bin and runtime under plain Node
bun run smoke:pack          # + npm pack: file list, a scan for keys/local paths/user names, npx <tarball> --help
```

The sources stay TypeScript (`bun src/index.ts` runs them directly). Bun-specific APIs are kept out of `src/`: child
processes, PATH lookup, Windows `.cmd` scripts (Node won't spawn them directly: an npm shim runs its JS target with
node; any other `.cmd` goes through cmd.exe with every argument quoted and escaped, and arguments with a double quote
or a line break are refused), sleep and zstd live in `src/runtime.ts`, on Node's own modules. The build compiles with
`types: ["node"]`, so a Bun global in `src/` doesn't compile. `prepublishOnly` runs the build, `bun test` and the
pack smoke test; publishing is done by hand (`npm publish`, 2FA).

`bun run compile` builds a single binary (`release/typetorch`).

## License

MIT
