# @typetorch/cli

`typetorch` builds a roblox-ts game into a payload, uploads it to Roblox as a private Model asset, and hot-swaps it
into live servers without a restart. It also promotes and rolls back already uploaded builds, lists deployments with
their git identity, checks and publishes the kernel place, and syncs **hot assets** (models and UI templates that
builders edit in the place) into the artifact. **Every deploy is approved by a person**
(`typetorch approve`); agents and the remote-claude dev-server only prepare them. **Prod-channel deploys are signed**
with two Ed25519 keys, so live prod servers only run what you published.

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
  "members": { "123456789": "owner" },   // userId -> owner | admin | dev
  "devBadgeId": null,
  "kernel": "node_modules/@typetorch/kernel",
  "approval": "all",                     // "all" (default) | "prod" | "none": which deploys need `typetorch approve`
  // written by `typetorch keys ...` (public keys only; commit them):
  "signingPublicKeys": ["…"],            // trusted main keys = the key asset's PublicKeys
  "revokedKeys": [],                     // = the key asset's RevokedKeys
  "fallbackPublicKey": "…",              // baked into the place by `kernel deploy`
  "keyAssetId": 123                      // the key asset; `kernel deploy` stamps it
}
```

Gitignore `.typetorch/`, `src/shared/build.ts`, `.payload.gen.project.json` and `.tsconfig.typetorch.json`.

### Keys

Keys are read from, highest priority first: the real environment; the env file named by `--env-file` or
`TYPETORCH_ENV_FILE`; `.env` files in the working directory and its parents (the nearest wins). **Keep them in an env
file outside the repo** (for example `~/.config/typetorch/my-game.env`) and point `TYPETORCH_ENV_FILE` at it (a repo
`.env` may hold just that line; a relative path is relative to that `.env`). Nothing read from a file is copied into
`process.env`, a key goes only into the Open Cloud client for its job, and child processes (rbxtsc, rojo, lune, bun
scripts, git) get an allowlisted environment without any key. Keys are never printed.

| Variable | Used for | Scopes |
|---|---|---|
| `OPENCLOUD_ASSETS_KEY` | payload uploads and moderation (`deploy`, `upload`); hot assets (`assets sync`, `assets status`); doctor's place check | `asset:read`, `asset:write`; `universe.place.luau-execution-session:read` + `:write` for hot assets and doctor (see "Hot assets") |
| `OPENCLOUD_DEPLOY_KEY` | deploy messages and the registry (`deploy`, `rollback`, `promote`, `config push`, `deployments`) | `universe-messaging-service:publish`, `universe:read` (+ `universe:write` to write the registry) |
| `OPENCLOUD_PLACE_KEY` | `kernel deploy` (manual only) | `universe.place:write` (+ `asset:read` to record the place version) |
| `TYPETORCH_API_KEY`, `OPENCLOUD_API_KEY` or `ROBLOX_API_KEY` | any job without its own key | all of the above |

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
message. Keep the deploy key away from agents. An old `signingPublicKey` (CLI 0.2-0.3) in typetorch.json is ignored.

### Signing prod deploys

Releases (deploy, rollback, promote, re-sign) and pins to a **prod-channel** branch are signed with two Ed25519 keys
when they are published; dev-channel ones never are. Every prod message and registry head carries `sig` (main key) and
`sigF` (fallback key). The kernel's rule is strict: once the key asset has loaded on a server only `sig` counts; while
it never loaded only `sigF` counts (format, rule and vectors in TypeTorch `plans/03-artifact.md`).

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
4. `typetorch kernel deploy --replace-place --yes`: bakes `KeyAssetId`, `FallbackPublicKey` and `BootstrapHeads`
   (the current prod heads, which the kernel trusts unsigned: heads stored before signing have no signature) into the
   place (servers restart). It refuses to publish without the keys. Run it from the machine with the latest
   deployment log (or a readable registry).
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
drop them after 120 s). `--by <userId>` names the owner/admin (default: the only "owner" in `members`, else the creator
userId). Unsigned pins from the in-game Admin tab only work on dev-channel servers.

No command prints a seed; a key file inside the repo or any git work tree is refused. The remote-claude dev-server only
deploys dev-channel branches, never gets the key variables, and is refused if it ever tries to publish to prod. Dry runs
show whether signing is ready, with placeholders instead of real signatures. Anyone who can write the group's assets
(including the upload/CI key) can change the key asset: an accepted risk until the keys are split (D4).

## Commands

| Command | Does |
|---|---|
| `typetorch build [--branch <b>] [--channel prod\|dev] [--clean]` | writes `src/shared/build.ts`, runs rbxtsc (`bun run build` if the repo has a build script), and rojo-builds `.typetorch/payload.rbxm` with the identity stamped on the root; checks it holds only Folders and ModuleScripts; writes `.typetorch/payload.json`. `--clean`: `git clean -fdX` out/ and include/ first |
| `typetorch upload [--no-build]` | clean build, upload as a new Model asset, wait for moderation; no deploy (then `promote` it) |
| `typetorch deploy [--branch] [--channel] [--no-build] [--dry-run] [--message <text>] [--force] [--no-registry] [--propose] [--proposed-by <who>]` | clean build, upload, wait until Approved, log "uploaded"; then approve here (a person at a terminal) or write a proposal; on approval: registry, deploy message, log "published". Per-stage timings |
| `typetorch promote <branch> <artifactId\|assetId\|#seq\|commit> [--force] [--dry-run]` | point a branch at an already uploaded, approved payload (from the deployments or `uploads.jsonl`) with a new seq; no rebuild. A prod-channel branch only takes prod-channel artifacts, even with `--force` ("rebuild for prod"). `promote <artifact> <branch>` works too when only the second is a known branch |
| `typetorch rollback [--branch] [--to <commit\|artifactId\|assetId\|#seq>] [--force] [--dry-run]` | point the branch at an earlier, already approved asset (no build or upload) and tell its servers |
| `typetorch deployments [--branch] [--limit n]` | deployment history with git identity; `*` = each branch's live head; lists uploads that never went out |
| `typetorch branch ls` | branches, channels and live heads |
| `typetorch config push [--dry-run]` | copy `defaultBranch`, `channels`, `members`, `devBadgeId` (and `revoked`) into the registry |
| `typetorch kernel deploy [--kernel <dir>] [--dry-run] [--replace-place --yes] [--allow-dirty] [--allow-untagged]` | see below |
| `typetorch approve [id]` | approve a proposal: details, y/N, publish (interactive terminal only); prod-channel ones are signed |
| `typetorch keys init [--key-file]` / `keys init --fallback [--force] [--yes]` / `keys rotate [--yes]` / `keys resign` | the signing keys: see "Signing prod deploys" |
| `typetorch pin <artifact> --branch <b> (--servers <ids> \| --pct <1-99>)` / `pin --unpin --branch <b> (--servers <ids> \| --all)` | A/B experiment pins, signed on prod-channel branches; `--by`, `--dry-run` |
| `typetorch reject <id> [--reason]` / `typetorch proposals [--all]` | drop a proposal / list them |
| `typetorch assets sync [--dry-run] [--deploy <branch>] [--place-version <n>]` | hot assets: export the instances marked `TypeTorchAsset` from the place's latest published version, upload new and changed ones, write `typetorch.assets.lock.json`; see "Hot assets" |
| `typetorch assets status` / `typetorch assets list` | export + diff without uploading / the lockfile |
| `typetorch doctor` | checks bun, git, rojo 7.7.x, roblox-ts, `typetorch.json`, the env file, each job's key, the approval policy, the state dir, the signing keys (key files vs typetorch.json, the key asset, the place; the place and the key asset's content through one Luau Execution task with the assets key; the same task warns when the place still holds `ServerStorage.TypeTorchDev`, the Studio local payload folder that live servers ignore), and probes each key's scopes with harmless calls |

Every command takes `--json` (one JSON document on stdout; human lines go to stderr), `--verbose`, `--config <path>`
and `--env-file <path>`.

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
- **Sources:** the game commit (`template`) and the framework and kernel commits from `.typetorch/packages/manifest.json`
  (the template's `scripts/packages.ts` writes it when it packs the local packages), else `v<version>` of the installed
  package. `<commit>*` means a dirty checkout. Stamped as payload attributes and as `SOURCES` in build.ts, logged, and
  put on the registry head.
- **Payload root attributes:** `ArtifactId`, `KernelApi` (1), `Channel`, `Commit`, `BuiltAt` (unix seconds),
  `SourceTemplate`, `SourceFramework`, `SourceKernel`, `Notes`, and `Assets` (also on the payload's `Server` folder;
  see "Hot assets").
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
`{"b":branch,"a":assetId,"i":artifactId,"s":seq,"c":commit,"ch":channel,"t":unixMs,"r":1?,"sig":"…","sigF":"…"}` (`r`:
`1` for rollbacks, `"resign"` for heads re-signed by `keys rotate`; `sig`/`sigF` only for prod-channel branches: base64
Ed25519 over
`tt1\n<b>\n<a>\n<i>\n<s>\n<c>\n<ch>\n<t>\n<r>`, rules and test vectors in TypeTorch `plans/03-artifact.md`). Servers on
branch `b` swap, and persist it as their branch head (the higher `s` wins; heads are ordered by `(seq, time)`).
`TypeTorch/rekey` `{"t":unixMs}` tells servers to re-read the key asset (after `keys rotate`).

### Logs and the state dir

The state dir (`TYPETORCH_STATE_DIR`, default `.typetorch/`) holds `deployments.jsonl` ("published" lines, with
`proposalId` and `proposedBy` when approved from a proposal), `uploads.jsonl` ("uploaded" lines, written as soon as
moderation answers, before anything is published), `proposals.jsonl` (proposed / approved / rejected / failed events)
`kernel-deploys.jsonl` and `assets.jsonl` (hot assets: created / uploaded / failed / synced). Choosing a seq and logging
it happens under `deploy.lock` there (`assets sync` holds `assets-sync.lock` instead), and logs are only appended.
The remote-claude dev-server points the deploys it runs from its worktree at the main repo's state dir, so both share
one log and one seq. If a deploy stops after the upload, `typetorch deployments` lists the upload with its
`typetorch promote` command.

### Registry (interim, until the backend exists)

One ConfigService key, `TypeTorch`, in the experience's `InExperienceConfig` repository, written through the Open
Cloud configs API (read the draft and the published config, PATCH the draft, publish with `deploymentStrategy:
"Immediate"`). A write is refused when the draft holds unpublished changes to other keys (`--force` publishes them
anyway). The value keeps each branch's head (with the message's `t`, `r`, `sig` and `sigF`, so a kernel can verify a
prod head like the message) and the last 25 deployments, under the 10,000-character value limit.

**The registry is optional.** When it can't be read (no `universe:read`), `deploy`, `rollback` and `promote` warn once
and continue with the message; the next seq is one above the highest in the registry (if readable) and the state dir's
log. **When it can be read but not written, the deploy aborts** before the message (pass `--no-registry` to skip it).

### Hot assets

Builders edit models and UI templates in the real place and publish it as usual; running servers pick up the new
versions without a restart (the framework's `hotAsset`). Design: TypeTorch `plans/13` "Hot assets".

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
     deploy --branch <branch>` (same approval policy; `--message`, `--propose`, `--proposed-by`, `--no-registry`,
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

### Kernel deploy

`typetorch kernel deploy`:
1. runs `lune run scripts/check.luau` in the kernel dir (`--kernel`, else `typetorch.json` `kernel`, else
   `node_modules/@typetorch/kernel`, else `../kernel`);
2. checks the version (package.json `version` = `KERNEL_VERSION` in `src/shared/Constants.luau`, and the kernel API)
   and prints it with a content hash (place.project.json and `src/`, LF line endings). A git checkout must be clean and
   tagged `v<version>` (`--allow-dirty`, `--allow-untagged`);
3. builds `.typetorch/place.rbxl` with `KernelVersion`, `KernelHash` and `KernelCommit` attributes, plus the signing
   trust roots `KeyAssetId` and `FallbackPublicKey` from typetorch.json and `BootstrapHeads` (the JSON of the current
   prod-channel heads, `{"<branch>":{"a","s","i"}}`, from the registry or the local log; `--no-registry`), on
   `ServerScriptService.TypeTorchKernel` (publishing refuses without the keys, or when the fallback key file doesn't
   match);
4. publishes **only with `--replace-place --yes`**, which replaces the whole place and wipes Studio/Team Create
   content (patching just the kernel slots comes later; see TypeTorch `plans/13`). The place version before and after
   go to `kernel-deploys.jsonl`. `--dry-run` stops before publishing.

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
