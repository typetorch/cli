# @typetorch/cli

`typetorch` builds a roblox-ts game into a payload, uploads it to Roblox as a private Model asset, and hot-swaps it
into live servers without a restart. It also promotes and rolls back already uploaded builds, lists deployments with
their git identity, signs every deploy message, and checks and publishes the kernel place.

Part of TypeTorch: the kernel (`@typetorch/kernel`) is baked into the place and swaps payloads; the framework
(`@typetorch/framework`) ships inside every payload.

## Install

Needs [Bun](https://bun.sh) 1.3+, git, Rojo 7.7.x and (for `kernel deploy`) Lune, through
[Rokit](https://github.com/rojo-rbx/rokit) (pin `rojo-rbx/rojo@7.7.0-rc.1` in the game's `rokit.toml`).

```sh
bun add -d @typetorch/cli      # in the game repo, then: bunx typetorch <command>
bun src/index.ts <command>     # from a checkout of this repo
```

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
  "signingPublicKey": "…"                // written by `typetorch keys init`
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
| `OPENCLOUD_ASSETS_KEY` | payload uploads and moderation (`deploy`, `upload`) | `asset:read`, `asset:write` |
| `OPENCLOUD_DEPLOY_KEY` | deploy messages and the registry (`deploy`, `rollback`, `promote`, `config push`, `deployments`) | `universe-messaging-service:publish`, `universe:read` (+ `universe:write` to write the registry) |
| `OPENCLOUD_PLACE_KEY` | `kernel deploy` (manual only) | `universe.place:write` (+ `asset:read` to record the place version) |
| `TYPETORCH_API_KEY`, `OPENCLOUD_API_KEY` or `ROBLOX_API_KEY` | any job without its own key | all of the above |
| `TYPETORCH_SIGNING_KEY` | signs deploy messages (base64 of a 32-byte Ed25519 seed; `typetorch keys init`) | not an Open Cloud key |

Other settings: `TYPETORCH_STATE_DIR` (where the logs live, default `.typetorch/`), `TYPETORCH_ROJO` / `TYPETORCH_LUNE`
(tool paths), `TYPETORCH_CHILD_ENV=NAME,NAME` (extra non-secret variables for child processes).

### Signing

`typetorch keys init [--env-file <path>]` creates the Ed25519 keypair: the private key goes into the env file as
`TYPETORCH_SIGNING_KEY` (refused for a file inside the repo that git doesn't ignore), the public key into
`typetorch.json` `"signingPublicKey"`. Every deploy, rollback and promote message then carries `sig`. `kernel deploy`
bakes the public key into the place for kernel 0.3, which refuses unsigned messages; kernel 0.2 ignores `sig`. Without a
key the CLI deploys unsigned and warns. Replacing a key needs `--force` and a kernel redeploy.

## Commands

| Command | Does |
|---|---|
| `typetorch build [--branch <b>] [--channel prod\|dev] [--clean]` | writes `src/shared/build.ts`, runs rbxtsc (`bun run build` if the repo has a build script), and rojo-builds `.typetorch/payload.rbxm` with the identity stamped on the root; checks it holds only Folders and ModuleScripts; writes `.typetorch/payload.json`. `--clean`: `git clean -fdX` out/ and include/ first |
| `typetorch upload [--no-build]` | clean build, upload as a new Model asset, wait for moderation; no deploy (then `promote` it) |
| `typetorch deploy [--branch] [--channel] [--no-build] [--dry-run] [--message <text>] [--force] [--no-registry]` | clean build, upload, wait until Approved, log "uploaded", update the registry, publish the signed deploy message, log "published"; prints per-stage timings |
| `typetorch promote <branch> <artifactId\|assetId\|#seq\|commit> [--force] [--dry-run]` | point a branch at an already uploaded, approved payload (from the deployments or `uploads.jsonl`) with a new seq; no rebuild |
| `typetorch rollback [--branch] [--to <commit\|artifactId\|assetId\|#seq>] [--force] [--dry-run]` | point the branch at an earlier, already approved asset (no build or upload) and tell its servers |
| `typetorch deployments [--branch] [--limit n]` | deployment history with git identity; `*` = each branch's live head; lists uploads that never went out |
| `typetorch branch ls` | branches, channels and live heads |
| `typetorch config push [--dry-run]` | copy `defaultBranch`, `channels`, `members`, `devBadgeId` (and `revoked`) into the registry |
| `typetorch kernel deploy [--kernel <dir>] [--dry-run] [--replace-place --yes] [--allow-dirty] [--allow-untagged]` | see below |
| `typetorch keys init [--env-file <path>] [--force]` | create the deploy-signing key |
| `typetorch doctor` | checks bun, git, rojo 7.7.x, roblox-ts, `typetorch.json`, the env file, each job's key, the signing key and the state dir, and probes each key's scopes with harmless calls |

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
  `SourceTemplate`, `SourceFramework`, `SourceKernel`.
- **Asset name:** `tt-<branch>-<artifactId>[-<channel>]` (only `[a-z0-9-]`, at most 50 characters; the channel only
  when `--channel` overrides the branch's). Roblox's text filter censors some names to `####`, so after the deploy
  message the CLI renames a censored asset to `TypeTorch payload`.
- **Asset description** (not censored; the dev menu reads it): `key=value` identity lines (`artifact`, `commit`,
  `branch`, `channel`, `dirty`, `built`, `sha256`, `framework`, `kernel`, `ci`), then `---` and up to 8 "what changed"
  lines: the `--message`, the game's commits since the branch's previous deploy, then framework and kernel commits
  (`first deploy of <branch>` or `rebuild, no source changes` when there are none). At most 1000 characters; change
  lines are cut first.
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
`{"b":branch,"a":assetId,"i":artifactId,"s":seq,"c":commit,"ch":channel,"t":unixMs,"r":1?,"sig":"…"?}` (`r` only for
rollbacks). `sig` is base64 Ed25519 over `tt1\n<b>\n<a>\n<i>\n<s>\n<c>\n<ch>\n<t>\n<r>` (exact rules and a test vector in
TypeTorch `plans/03-artifact.md`). Servers on branch `b` swap, and persist it as their branch head (the higher `s`
wins; heads are ordered by `(seq, time)`).

### Logs and the state dir

The state dir (`TYPETORCH_STATE_DIR`, default `.typetorch/`) holds `deployments.jsonl` ("published" lines),
`uploads.jsonl` ("uploaded" lines, written as soon as moderation answers, before anything is published) and
`kernel-deploys.jsonl`. Choosing a seq and logging it happens under `deploy.lock` there, and logs are only appended.
The remote-claude dev-server points the deploys it runs from its worktree at the main repo's state dir, so both share
one log and one seq. If a deploy stops after the upload, `typetorch deployments` lists the upload with its
`typetorch promote` command.

### Registry (interim, until the backend exists)

One ConfigService key, `TypeTorch`, in the experience's `InExperienceConfig` repository, written through the Open
Cloud configs API (read the draft and the published config, PATCH the draft, publish with `deploymentStrategy:
"Immediate"`). A write is refused when the draft holds unpublished changes to other keys (`--force` publishes them
anyway). The value keeps each branch's head (with the message's `t`, `r` and `sig`, so a kernel can verify it) and the
last 25 deployments, under the 10,000-character value limit.

**The registry is optional.** When it can't be read (no `universe:read`), `deploy`, `rollback` and `promote` warn once
and continue with the message; the next seq is one above the highest in the registry (if readable) and the state dir's
log. **When it can be read but not written, the deploy aborts** before the message (pass `--no-registry` to skip it).

### Kernel deploy

`typetorch kernel deploy`:
1. runs `lune run scripts/check.luau` in the kernel dir (`--kernel`, else `typetorch.json` `kernel`, else
   `node_modules/@typetorch/kernel`, else `../kernel`);
2. checks the version (package.json `version` = `KERNEL_VERSION` in `src/shared/Constants.luau`, and the kernel API)
   and prints it with a content hash (place.project.json and `src/`, LF line endings). A git checkout must be clean and
   tagged `v<version>` (`--allow-dirty`, `--allow-untagged`);
3. builds `.typetorch/place.rbxl` with `KernelVersion`, `KernelHash`, `KernelCommit` and `SigningPublicKey` attributes
   on `ServerScriptService.TypeTorchKernel`;
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
```

`bun run compile` builds a single binary (`dist/typetorch`).

## License

MIT
