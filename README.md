# @typetorch/cli

`typetorch` builds a roblox-ts game into a payload, uploads it to Roblox as a private Model asset, and hot-swaps it
into live servers without a restart. It also rolls back, lists deployments with their git identity, and publishes the
kernel place.

Part of TypeTorch: the kernel (`@typetorch/kernel`) is baked into the place and swaps payloads; the framework
(`@typetorch/framework`) ships inside every payload.

## Install

Needs [Bun](https://bun.sh) 1.3+, git, and Rojo 7.7.x through [Rokit](https://github.com/rojo-rbx/rokit) (pin
`rojo-rbx/rojo@7.7.0-rc.1` in the game's `rokit.toml`).

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
  "kernel": "node_modules/@typetorch/kernel"
}
```

The Open Cloud API key comes from `TYPETORCH_API_KEY`, `OPENCLOUD_API_KEY` or `ROBLOX_API_KEY`, in the environment or
in a `.env` file in the working directory or any parent folder (the nearest file wins; real environment variables are
never overridden). The key is never printed. Scopes:

| Scope | Used by |
|---|---|
| `asset:read`, `asset:write` | `upload`, `deploy` |
| `universe-messaging-service:publish` | `deploy`, `rollback` |
| `universe:read`, `universe:write` | the ConfigService registry (optional, see below), `config push` |
| `universe.place:write` | `kernel deploy` |

Gitignore `.typetorch/`, `src/shared/build.ts` and `.payload.gen.project.json` in the game repo.

## Commands

| Command | Does |
|---|---|
| `typetorch build [--branch <b>] [--channel prod\|dev]` | writes `src/shared/build.ts`, runs rbxtsc (`bun run build` if the repo has a build script), and rojo-builds `.typetorch/payload.rbxm` with the identity stamped on the root (`ArtifactId`, `KernelApi`, `Channel`, `Commit`, `BuiltAt`); writes `.typetorch/payload.json` |
| `typetorch upload [--no-build]` | build, then upload as a new Model asset and wait for moderation; no deploy |
| `typetorch deploy [--branch] [--channel] [--no-build] [--dry-run] [--message <text>] [--force] [--no-registry]` | build, upload, wait until Approved, update the registry, publish the deploy message, append `.typetorch/deployments.jsonl` (with the payload `sha256`); prints per-stage timings |
| `typetorch rollback [--branch] [--to <commit\|artifactId\|assetId\|#seq>] [--force] [--dry-run]` | point the branch at an earlier, already approved asset (no build or upload) and tell its servers |
| `typetorch deployments [--branch] [--limit n]` | deployment history with git identity; `*` = each branch's live head |
| `typetorch branch ls` | branches, channels and live heads |
| `typetorch config push [--dry-run]` | copy `defaultBranch`, `channels`, `members`, `devBadgeId` (and `revoked`) into the registry |
| `typetorch kernel deploy [--kernel <dir>] [--dry-run]` | rojo-build `<kernel>/place.project.json` and publish it as the live place version (**replaces the whole place**) |
| `typetorch doctor` | checks bun, git, rojo 7.7.x, roblox-ts, `typetorch.json`, the API key, and probes the key's scopes with harmless calls |

Every command takes `--json` (one JSON document on stdout; human lines go to stderr), `--verbose`, and
`--config <path>`.

### Identity

- **Branch:** `--branch`, else `typetorch.json` `branches[gitBranch]`, else the git branch lowercased with `/` → `-`.
- **Channel:** `--channel`, else `channels[branch]`, else `prod` for `defaultBranch`, else `dev`.
- **Artifact id:** `<channel>-<commit>[.r<N>]` (commit = first 7 hex of HEAD, the same value `$git("Commit")` compiles
  in), or `<channel>-<commit>-dirty-<sha6>` for a dirty tree (sha6 = first 6 hex of the sha256 of the payload stamped
  with the provisional id `<channel>-<commit>-dirty`). Ids use only `[a-z0-9.-]`.
- **Revisions:** the kernel ignores a deploy message whose id equals the running one, so a clean build whose commit
  already went out with other bytes (say only `@typetorch/framework` changed) gets the next revision:
  `dev-12b63b9`, then `dev-12b63b9.r2`, `.r3`, … The build checks earlier deployments in `.typetorch/deployments.jsonl`
  and in the registry when it is readable (without it, only this machine's log): it stamps the newest known id of the
  commit (or the plain id), hashes the payload, keeps that id when an earlier deploy had exactly these bytes (a no-op
  redeploy), and otherwise restamps with one above the highest revision. Log entries record the payload `sha256`; older
  entries without one count as different. Since `BuiltAt` is stamped, every rebuild has new bytes, so in practice a
  repeat deploy of a commit gets a new revision and only `deploy --no-build` of the same payload reuses its id.
  `deploy --no-build` refuses a payload whose id has since gone out with other bytes (build again). Dirty builds keep
  their hash-named ids.
- **Asset name:** `tt-<branch>-<commit>[-r<N>][-dirty][-<channel>]` (only `[a-z0-9-]`, at most 50 characters; `-r<N>`
  is the revision; the channel is added only when `--channel` overrides the branch's). Roblox's text filter still
  censors some of these to `####`, unpredictably (`tt-main-a17a22c` passes, `tt-dev-59daad8` doesn't), so after the
  deploy message is out the CLI reads the stored name back and renames a censored asset to `TypeTorch payload`. The
  description is not censored and
  carries the full identity: `artifact=`, `commit=` (full hash), `branch=`, `channel=`, `dirty=`, `built=`,
  `sha256=`, and `ci=` in GitHub Actions.
- **`src/shared/build.ts`** ends with a `// <build time>` line so its text changes on every build: rbxtsc's
  incremental compile skips unchanged files, which would keep an old `$git()` commit compiled in. The build checks the
  compiled file carries the current commit. Repo build scripts that write build.ts themselves should skip it when
  `TYPETORCH_SKIP_BUILD_INFO=1` (the CLI sets it when it runs `bun run build`).
- **Payload root attributes:** `ArtifactId`, `KernelApi` (1), `Channel`, `Commit`, `BuiltAt` (unix seconds).
- A prod-channel branch refuses a dev-channel or dirty artifact unless `--force`.

### Deploy message

`POST /cloud/v2/universes/{universeId}:publishMessage`, topic `TypeTorch/deploy`, message
`{"b":branch,"a":assetId,"i":artifactId,"s":seq,"c":commit,"ch":channel,"t":unixMs,"r":1?}` (`r` only for rollbacks).
Servers on branch `b` swap, and persist it as their branch head (in-game DataStore, the higher `s` wins).

### Registry (interim, until the backend exists)

One ConfigService key, `TypeTorch`, in the experience's `InExperienceConfig` repository, written through the Open
Cloud configs API (read the draft and the published config, PATCH the draft, publish with `deploymentStrategy:
"Immediate"`). Because the game shares that repository, a write is refused when the draft holds unpublished changes
to other keys (`--force` publishes them anyway). The value keeps each branch's head and the last 25 deployments, and
stays under the 10,000-character value limit by dropping the oldest deployments.

**The registry is optional.** When the key lacks `universe:read`/`universe:write` (403), `deploy` and `rollback` warn
once and continue with the upload and the message; the next seq is one above the highest seq in the registry (if
readable) and the local log. `deployments`, `branch ls` and `rollback --to` read the local log plus the registry when
readable.

## Develop

```sh
bun install
bun test                    # unit tests
bun run typecheck
cd test-fixture && bun install && cd ..
bun test/fixture.e2e.ts     # builds test-fixture/ in a temp git repo; deploy/rollback only as --dry-run
```

`bun run compile` builds a single binary (`dist/typetorch`).

## License

MIT
