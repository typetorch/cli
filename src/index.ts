#!/usr/bin/env node
/**
 * typetorch: build, upload and hot-swap roblox-ts game code on live Roblox servers.
 * Run inside a game repo (a folder with typetorch.json). See README.md.
 * Runs under Node (the npm package: dist/index.js) and Bun (development: `bun src/index.ts`).
 */
import { readFileSync } from "node:fs";
import { flagBool, flagString, parseArgs, UsageError, type FlagSpec, type ParsedArgs } from "./args.ts";
import { ACCESS_USAGE, accessCommand, accessFlags } from "./commands/access.ts";
import { assetsCommand, assetsFlags } from "./commands/assets.ts";
import { buildCommand, buildFlags, uploadCommand, uploadFlags } from "./commands/build.ts";
import { configCommand, configFlags } from "./commands/config.ts";
import { deployCommand, deployFlags } from "./commands/deploy.ts";
import { doctorCommand, doctorFlags } from "./commands/doctor.ts";
import {
	ALERTS_USAGE,
	alertsCommand,
	alertsFlags,
	FLEET_USAGE,
	fleetCommand,
	fleetFlags,
	REPORT_USAGE,
	reportCommand,
	reportFlags,
	SERVERS_USAGE,
	serversCommand,
	serversFlags,
	WAIT_USAGE,
} from "./commands/fleet.ts";
import { GATE_USAGE, TEST_USAGE, testCommand, testFlags } from "./commands/test.ts";
import { ROLLOUT_USAGE, WIDEN_USAGE } from "./rollout.ts";
import { branchCommand, branchFlags, deploymentsCommand, deploymentsFlags } from "./commands/history.ts";
import { approveCommand, approveFlags, proposalsCommand, proposalsFlags, rejectCommand, rejectFlags } from "./commands/approve.ts";
import { kernelCommand, kernelFlags } from "./commands/kernel.ts";
import { keysCommand, keysFlags } from "./commands/keys.ts";
import { pinCommand, pinFlags } from "./commands/pin.ts";
import { promoteCommand, promoteFlags } from "./commands/promote.ts";
import { REMOTE_CLAUDE_USAGE, remoteClaudeCommand } from "./commands/remote-claude.ts";
import { rollbackCommand, rollbackFlags } from "./commands/rollback.ts";
import { UPDATE_USAGE, updateCommandRun, updateFlags } from "./commands/update.ts";
import { redact, Settings, useSettings } from "./env.ts";
import { closestCommand, renderHelp } from "./help.ts";
import { red, setOutputMode } from "./log.ts";
import { progress } from "./progress.ts";

/** package.json sits one level above both src/ (Bun) and dist/ (Node). */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

interface Command {
	flags: FlagSpec;
	run: (args: ParsedArgs) => Promise<void>;
	usage: string;
	summary: string;
	/** Takes the arguments as they are (no option parsing, --help included) and returns the exit code. */
	raw?: (argv: string[]) => Promise<number>;
}

const COMMANDS: Record<string, Command> = {
	build: {
		flags: buildFlags,
		run: buildCommand,
		summary: "compile and pack the payload",
		usage: `typetorch build [--branch <b>] [--channel prod|dev] [--clean]

  Writes src/shared/build.ts, runs rbxtsc (prod channel: $print/$warn compiled away, no source paths), then
  rojo-builds default.project.json with the identity stamped on the root ($attributes ArtifactId, KernelApi, Channel,
  Commit, BuiltAt, SourceTemplate/Framework/Kernel) into .typetorch/payload.rbxm (only Folders and ModuleScripts
  allowed), plus .typetorch/payload.json. Artifact id: <commit7>-<hash6>, or <commit7>-dirty-<hash6>.
  --branch   TypeTorch branch (default: typetorch.json "branches"[git branch], else the git branch, lowercased, / -> -)
  --channel  override the branch's channel (default: "channels"[branch], else prod for defaultBranch, else dev)
  --clean    git clean -fdX out/ and include/ first (deploy and upload always do)`,
	},
	upload: {
		flags: uploadFlags,
		run: uploadCommand,
		summary: "build and upload a payload, no deploy",
		usage: `typetorch upload [--branch <b>] [--channel prod|dev] [--no-build] [--moderation-timeout <s>]

  Uploads the payload as a NEW private Model asset named tt-<branch>-<commit>[-dirty] and waits for moderation.
  Does not touch the registry or live servers.`,
	},
	deploy: {
		flags: deployFlags,
		run: deployCommand,
		summary: "build, upload, approve and send to live servers",
		usage: `typetorch deploy [--branch <b>] [--channel prod|dev] [--no-build] [--dry-run] [--message <text>] [--force]
                 [--no-registry] [--moderation-timeout <s>] [--propose] [--proposed-by <who>]
                 [--key-file <path>] [--fallback-key-file <path>]

  clean build -> upload (new Model asset) -> moderation = Approved -> "uploaded" record -> approval -> registry ->
  deploy message -> deployments.jsonl (in the state dir: TYPETORCH_STATE_DIR, default .typetorch/)
  Approval (typetorch.json "approval": "all" by default, "prod", or "none"): a person at a terminal approves right
  after the upload (y/N). Anyone else (an agent, the dev-server, --propose) only writes a proposal:
  approve it with \`typetorch approve <id>\`.
  --propose            write a proposal even when you could approve now
  --proposed-by <who>  who prepares it: cli, agent, dev-server/claude... (default: cli at a terminal, else agent)
  --dry-run      build and show what would be uploaded and sent; nothing leaves the machine except registry reads
  --no-build     deploy the last build (.typetorch/payload.rbxm)
  --force        allow a dev-channel or dirty artifact on a prod-channel branch, or publish a config draft that has
                 other unpublished changes
  --no-registry  skip the ConfigService registry (servers persist the head from the deploy message anyway)
  --require-shared-seq  stop before the upload when no shared seq source is readable (CI: no local log to take a seq
                 from): the DataStore (universe-datastores.objects:read) or the registry. --require-registry: old name
  Prod-channel branches: the message is signed with both keys (sig + sigF) when it is published; the key files are
  checked before the upload. Dev-channel messages are unsigned. See \`typetorch keys\`.
${GATE_USAGE}
${WAIT_USAGE}
${ROLLOUT_USAGE}
${WIDEN_USAGE}`,
	},
	promote: {
		flags: promoteFlags,
		run: promoteCommand,
		summary: "point a branch at an uploaded build, no rebuild",
		usage: `typetorch promote <branch> <artifactId|assetId|#seq|commit> [--force] [--dry-run] [--no-registry] [--message <text>]
                  [--key-file <path>] [--fallback-key-file <path>]

  Re-publishes an approved payload asset to <branch> with a new seq (signed with both keys on a prod-channel branch).
  Finds it in the deployments (any branch) or in uploads.jsonl (an upload whose deploy stopped, or \`typetorch
  upload\`). A prod-channel branch takes only prod-channel artifacts, even with --force ("rebuild for prod"); a dirty
  one needs --force. \`promote <artifact> <branch>\` works too when only the second is a known branch.
  Approval (typetorch.json "approval": "all" by default, "prod", or "none"): a person at a terminal approves right
  after the upload (y/N). Anyone else (an agent, the dev-server, --propose) only writes a proposal:
  approve it with \`typetorch approve <id>\`.
  --propose            write a proposal even when you could approve now
  --proposed-by <who>  who prepares it: cli, agent, dev-server/claude... (default: cli at a terminal, else agent)
${GATE_USAGE}
${WAIT_USAGE}
${ROLLOUT_USAGE}`,
	},
	rollback: {
		flags: rollbackFlags,
		run: rollbackCommand,
		summary: "point a branch back at an earlier build",
		usage: `typetorch rollback [--branch <b>] [--to <commit|artifactId|assetId|#seq>] [--force] [--dry-run] [--no-registry]
                   [--key-file <path>] [--fallback-key-file <path>]

  No build, upload or moderation wait. Without --to: the newest earlier deployment on the branch whose artifact
  differs from the live one. Searches the registry (when readable) and the local log.
  Approval (typetorch.json "approval": "all" by default, "prod", or "none"): a person at a terminal approves right
  after the upload (y/N). Anyone else (an agent, the dev-server, --propose) only writes a proposal:
  approve it with \`typetorch approve <id>\`.
  --propose            write a proposal even when you could approve now
  --proposed-by <who>  who prepares it: cli, agent, dev-server/claude... (default: cli at a terminal, else agent)
  The cloud test is off for rollbacks (an earlier build); --test runs it.
${GATE_USAGE}
${WAIT_USAGE}`,
	},
	deployments: {
		flags: deploymentsFlags,
		run: deploymentsCommand,
		summary: "deploy history (* = live)",
		usage: `typetorch deployments [--branch <b>] [--limit <n>] [--json]`,
	},
	branch: {
		flags: branchFlags,
		run: branchCommand,
		summary: "branches, channels and live heads",
		usage: `typetorch branch ls [--json]`,
	},
	config: {
		flags: configFlags,
		run: configCommand,
		summary: "push settings to the registry (needs universe:read)",
		usage: `typetorch config push [--dry-run] [--force]

  Writes defaultBranch, channels, members, devBadgeId (and revoked) into the registry, keeping branches and
  deployments. Needs universe:read and universe:write; universe:read can't be granted to API keys today (OAuth
  only), so with an API key this fails until Roblox offers it. For members/revoked/devBadgeId use
  \`typetorch access push\` instead (ConfigService TypeTorchAccess, written blind; kernel 0.3.6+).`,
	},
	access: {
		flags: accessFlags,
		run: (args) => accessCommand(args),
		summary: "publish members and revoked to servers",
		usage: ACCESS_USAGE,
	},
	kernel: {
		flags: kernelFlags,
		run: kernelCommand,
		summary: "install or update the kernel in the place; restore a backup",
		usage: `typetorch kernel deploy [--patch] [--dry-run] [--yes] [--install] [--base published|latest|<n>] [--place-file <file>]
                        [--engine splice|lune] [--kernel <dir>] [--allow-dirty] [--allow-untagged] [--fallback-key-file <path>]
                        [--no-backup] [--loadstring]
typetorch kernel deploy --replace-place [--dry-run] [--yes] [--no-backup] [--loadstring]      (template/test place only: wipes Studio content)
typetorch kernel restore <file.rbxl> [--dry-run] [--yes]

  1. lune run scripts/check.luau in the kernel dir  2. version (package.json = Constants.luau) + content hash, printed;
  a git checkout must be clean and tagged v<version>  3. rojo build <kernel>/place.project.json -> .typetorch/place.rbxl
  with KernelVersion/KernelHash/KernelCommit, KeyAssetId + FallbackPublicKey (typetorch.json; publishing refuses
  without them) and BootstrapHeads on ServerScriptService.TypeTorchKernel. Kernel 0.3.6: the prod head's payload (kept
  in <state dir>/payloads/<artifactId>.rbxm by every upload; API keys can't download assets) becomes the backup build,
  ServerStorage.TypeTorchBackup (a kernel slot, refreshed by every kernel deploy, both modes); servers run it only when
  nothing else can run. No kept payload: the place keeps its backup, with a warning. --no-backup skips it.
  4. Patch (default): download the place's newest version (it must be published; --base published|latest|<n>),
  back it up to .typetorch/place-backups/<placeId>-v<n>.rbxl, replace ONLY the kernel slots (the TypeTorch* children
  of services in place.project.json) and its service settings (HttpEnabled; LoadStringEnabled only with --loadstring), verify (binary + Lune:
  everything outside the slots unchanged), write .typetorch/place-patches/<placeId>-v<n>-kernel-<version>.rbxl, show a
  summary, y/N (or --yes), check nobody published meanwhile, publish. A place without a kernel needs --install.
  --dry-run       everything except the publish
  --loadstring    turn loadstring on (ServerScriptService.LoadStringEnabled = true), for remote-claude's run_luau (the test
                  place); without it a patch leaves the place's value and --replace-place publishes it off
  --place-file    patch a local .rbxl instead of downloading (Studio: File > Download a Copy); publishing also needs
                  --base <the version it was taken from>
  --engine lune   re-encode the whole place with Lune (rbx-dom) when the default splice engine refuses; rbx-dom migrates
                  some properties (Image -> ImageContent, ...) and drops a few, listed in the summary
  restore         publish a place file (a backup, or a dry run's patched file) as the new live version
  Scopes (the place key): asset:read, universe.place:write (publish). Downloading the place needs legacy-asset:manage,
  which can't be granted to API keys today: download a copy in Studio (File > Download a Copy) and pass
  --place-file <file> --base <version>. Records go to
  kernel-deploys.jsonl in the state dir. Kernel dir: --kernel, else typetorch.json "kernel", else
  node_modules/@typetorch/kernel, else ../kernel.`,
	},
	approve: {
		flags: approveFlags,
		run: approveCommand,
		summary: "review a deploy proposal and publish it (y/N)",
		usage: `typetorch approve [id] [--no-registry] [--key-file <path>] [--fallback-key-file <path>]

  Lists pending proposals (newest first), shows the one you pick (branch, artifact, notes, sources, size, proposer,
  age), asks y/N, then publishes it like a deploy (signed with both keys on a prod-channel branch). Refuses when
  stdin isn't an interactive terminal. A prod deploy or promote proposal without a passed (or skipped) cloud test
  runs it before the y/N. --rollout overrides the proposal's.
  --import <dir>       first copy the pending proposals of another state dir (a CI run's typetorch-state artifact)
                       into this one, with their upload and test records: prod proposals made in CI are approved here
${GATE_USAGE}
${WAIT_USAGE}
${ROLLOUT_USAGE}`,
	},
	test: {
		flags: testFlags,
		run: (args) => testCommand(args),
		summary: "boot a build headless in the place (the prod gate)",
		usage: TEST_USAGE,
	},
	servers: {
		flags: serversFlags,
		run: (args) => serversCommand(args),
		summary: "live servers: branch, build, health, players",
		usage: SERVERS_USAGE,
	},
	report: {
		flags: reportFlags,
		run: (args) => reportCommand(args),
		summary: "what the servers reported for a deploy",
		usage: REPORT_USAGE,
	},
	alerts: {
		flags: alertsFlags,
		run: (args) => alertsCommand(args),
		summary: "server, deploy and auto-rollback alerts",
		usage: ALERTS_USAGE,
	},
	fleet: {
		flags: fleetFlags,
		run: (args) => fleetCommand(args),
		summary: "point game servers at the fleet API",
		usage: FLEET_USAGE,
	},
	pin: {
		flags: pinFlags,
		run: (args) => pinCommand(args),
		summary: "A/B pins: run a build on some servers",
		usage: `typetorch pin <artifactId|assetId|#seq|commit> --branch <b> (--servers <jobId,...> | --pct <1-99>) [--by <userId>]
typetorch pin --unpin --branch <b> (--servers <jobId,...> | --all) [<artifact>] [--by <userId>]
              [--dry-run] [--no-registry] [--key-file <path>] [--fallback-key-file <path>]

  Publishes TypeTorch/pin (kernel 0.2.3): servers of branch <b> whose JobId is listed, or whose bucket is below
  --pct, run the artifact until the next deploy reaches them, an unpin, or they close. --all (unpin only) = every
  server. Prod-channel branches: signed with both keys (sig + sigF) when published. Approval follows typetorch.json
  "approval" like a deploy: a y/N here (pins can't be proposals: servers drop them after 120 s). --by: the userId
  sent as the pinner (default: the only "owner" in members, else the creator userId); servers accept owners only.
  Many JobIds are split over several messages (1 KiB each), each signed.`,
	},
	keys: {
		flags: keysFlags,
		run: (args) => keysCommand(args),
		summary: "prod signing keys: init, rotate, resign",
		usage: `typetorch keys init [--key-file <path>]
typetorch keys init --fallback [--force] [--yes] [--fallback-key-file <path>]
typetorch keys rotate [--yes] [--key-file <path>] [--fallback-key-file <path>]
typetorch keys resign [--key-file <path>] [--fallback-key-file <path>]

  Prod-channel deploys are signed with two Ed25519 keys (plans/03): sig (MAIN key) and sigF (FALLBACK key). Seeds
  live in plaintext key files outside every repo and are never printed:
    main      ~/.config/typetorch/keys/<universeId>.key           (--key-file, or TYPETORCH_KEY_FILE)
    fallback  ~/.config/typetorch/keys/<universeId>.fallback.key  (--fallback-key-file, or TYPETORCH_FALLBACK_KEY_FILE)
  (the variables are read from the real environment only, never from an env file).
  init             the main pair; its public key goes into typetorch.json "signingPublicKeys" and into the KEY ASSET
                   (a group-owned Model, created through Open Cloud; its id goes into "keyAssetId"). Resumes a
                   half-finished run. Needs the assets key.
  init --fallback  the fallback pair; its public key goes into "fallbackPublicKey". Then \`typetorch kernel deploy\`
                   bakes KeyAssetId and FallbackPublicKey into the place.
    --force        replace the fallback pair (a leaked one): the old public key is added to the key asset's
                   RevokedKeys first, then a new pair is made; then \`typetorch kernel deploy\`
  rotate           a new main pair (a lost or leaked main key): the key asset gets a new version trusting only the new
                   key and revoking the old one, the key file is replaced, TypeTorch/rekey tells servers to re-read
                   the key asset, then every prod-channel branch's live head is re-signed (keys resign). No restart.
  resign           republish each prod-channel branch's live head as a fresh signed message: same artifact and asset,
                   a new seq, r = "resign" (servers update the head, no swap). Follows the approval policy.
  --yes            skip the y/N (rotate, init --fallback --force)
  \`typetorch doctor\` checks both key files against typetorch.json, the key asset and the place.`,
	},
	reject: {
		flags: rejectFlags,
		run: rejectCommand,
		summary: "reject a deploy proposal",
		usage: `typetorch reject <id> [--reason <text>]`,
	},
	proposals: {
		flags: proposalsFlags,
		run: proposalsCommand,
		summary: "list deploy proposals",
		usage: `typetorch proposals [--all] [--json]

  Proposals live in proposals.jsonl in the state dir and expire after 24 h.`,
	},
	assets: {
		flags: assetsFlags,
		run: (args) => assetsCommand(args),
		summary: "sync hot assets from the place",
		usage: `typetorch assets sync [--dry-run] [--deploy <branch>] [--place-version <n>] [--moderation-timeout <s>]
typetorch assets status [--place-version <n>]
typetorch assets list

  Hot assets (TypeTorch plans/13): instances in the place with the attribute TypeTorchAsset = "<key>" (lowercase
  a-z 0-9 / - _, at most 64 characters, unique, no scripts inside, not inside another hot asset).
  sync    1. a Luau Execution task on the place's latest PUBLISHED version (or --place-version) serializes each one
          2. SHA-256 (first 12 hex) vs typetorch.assets.lock.json
          3. new key: a group-owned Model (a placeholder reserves the id, the export is its next version); changed key:
             a new version of the SAME asset (PATCH). Uploaded copies carry TypeTorchAssetId and TypeTorchAssetHash;
             the place is never changed. Waits for moderation; logged to assets.jsonl in the state dir
          4. a second task resolves each new version's assetVersionId (GetLatestAssetVersionAsync, hash checked)
          5. writes typetorch.assets.lock.json (commit it); \`typetorch deploy\` stamps its asset map on the payload as
             the Assets attribute
  --dry-run          stop after the diff (= assets status)
  --deploy <branch>  then deploy that branch (same approval policy; --message, --propose, --proposed-by,
                     --no-registry and the key file flags are passed on). A prod-channel branch needs the lockfile
                     committed first, so --deploy refuses it when the sync changes the lockfile.
  status  export + diff, nothing uploaded or written
  list    the lockfile
  Scopes (the assets key): asset:read, asset:write, universe.place.luau-execution-session:read and :write.`,
	},
	"remote-claude": {
		flags: {},
		run: async () => {},
		raw: (argv) => remoteClaudeCommand(argv),
		summary: "Claude Code from the in-game dev menu",
		usage: REMOTE_CLAUDE_USAGE,
	},
	dev: {
		flags: {},
		run: async () => {},
		raw: (argv) => remoteClaudeCommand(argv),
		summary: "Claude Code from the in-game dev menu",
		usage: REMOTE_CLAUDE_USAGE.replace("typetorch remote-claude --users", "typetorch dev (= remote-claude) --users"),
	},
	update: {
		flags: updateFlags,
		run: updateCommandRun,
		summary: "update this CLI from npm",
		usage: UPDATE_USAGE,
	},
	doctor: {
		flags: doctorFlags,
		run: doctorCommand,
		summary: "check tools, typetorch.json, keys and scopes",
		usage: `typetorch doctor [--json]`,
	},
};

function help(): string {
	return renderHelp(pkg.version, Object.fromEntries(Object.entries(COMMANDS).map(([name, c]) => [name, c.summary])));
}

const HELP_WORDS = new Set(["help", "--help", "-h", "-H", "-?", "/?"]);

async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (!name || HELP_WORDS.has(name)) {
		const topic = name === "help" ? rest[0] : undefined;
		if (topic && !COMMANDS[topic]) {
			const guess = closestCommand(topic, Object.keys(COMMANDS));
			console.error(red(`unknown command "${topic}"${guess ? `: did you mean "${guess}"?` : ""}`));
			console.error(help());
			return 2;
		}
		console.log(topic ? COMMANDS[topic].usage : help());
		return 0;
	}
	if (name === "--version" || name === "-v" || name === "-V" || name === "version") {
		console.log(pkg.version);
		return 0;
	}
	const command = COMMANDS[name];
	if (!command) {
		const guess = closestCommand(name, Object.keys(COMMANDS));
		console.error(red(`unknown command "${name}"${guess ? `: did you mean "${guess}"?` : ""}`));
		console.error(help());
		return 2;
	}
	if (command.raw) {
		useSettings(new Settings({ startDir: process.cwd() }));
		return command.raw(rest);
	}
	let args: ParsedArgs;
	try {
		args = parseArgs(rest, command.flags);
	} catch (error) {
		console.error(red(`error: ${(error as Error).message}`));
		console.error(command.usage);
		return 2;
	}
	if (flagBool(args, "help")) {
		console.log(command.usage);
		return 0;
	}
	setOutputMode({ json: flagBool(args, "json"), verbose: flagBool(args, "verbose") });
	// Settings stay in this object: nothing from an env file is copied into process.env (S-H2).
	useSettings(new Settings({ startDir: process.cwd(), envFile: flagString(args, "env-file") }));
	try {
		await command.run(args);
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (error) {
		const err = error as Error;
		progress().stop();
		console.error(red(`error: ${redact(err.message ?? String(error))}`));
		if (error instanceof UsageError) {
			console.error(command.usage);
			return 2;
		}
		if (flagBool(args, "verbose") && err.stack) console.error(redact(err.stack));
		return 1;
	}
}

process.exit(await main(process.argv.slice(2)));
