#!/usr/bin/env bun
/**
 * typetorch: build, upload and hot-swap roblox-ts game code on live Roblox servers.
 * Run inside a game repo (a folder with typetorch.json). See README.md.
 */
import pkg from "../package.json" with { type: "json" };
import { flagBool, flagString, parseArgs, UsageError, type FlagSpec, type ParsedArgs } from "./args";
import { buildCommand, buildFlags, uploadCommand, uploadFlags } from "./commands/build";
import { configCommand, configFlags } from "./commands/config";
import { deployCommand, deployFlags } from "./commands/deploy";
import { doctorCommand, doctorFlags } from "./commands/doctor";
import { branchCommand, branchFlags, deploymentsCommand, deploymentsFlags } from "./commands/history";
import { approveCommand, approveFlags, proposalsCommand, proposalsFlags, rejectCommand, rejectFlags } from "./commands/approve";
import { kernelCommand, kernelFlags } from "./commands/kernel";
import { keysCommand, keysFlags } from "./commands/keys";
import { promoteCommand, promoteFlags } from "./commands/promote";
import { rollbackCommand, rollbackFlags } from "./commands/rollback";
import { redact, Settings, useSettings } from "./env";
import { red, setOutputMode } from "./log";

interface Command {
	flags: FlagSpec;
	run: (args: ParsedArgs) => Promise<void>;
	usage: string;
	summary: string;
}

const COMMANDS: Record<string, Command> = {
	build: {
		flags: buildFlags,
		run: buildCommand,
		summary: "compile and pack the payload (.typetorch/payload.rbxm)",
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
		summary: "build and upload the payload as a new Model asset (no deploy)",
		usage: `typetorch upload [--branch <b>] [--channel prod|dev] [--no-build] [--moderation-timeout <s>]

  Uploads the payload as a NEW private Model asset named tt-<branch>-<commit>[-dirty] and waits for moderation.
  Does not touch the registry or live servers.`,
	},
	deploy: {
		flags: deployFlags,
		run: deployCommand,
		summary: "build, upload, wait for Approved, then approve (or propose) and tell live servers",
		usage: `typetorch deploy [--branch <b>] [--channel prod|dev] [--no-build] [--dry-run] [--message <text>] [--force]
                 [--no-registry] [--moderation-timeout <s>] [--propose] [--proposed-by <who>] [--key-file <path>]

  clean build -> upload (new Model asset) -> moderation = Approved -> "uploaded" record -> approval -> registry ->
  signed deploy message -> deployments.jsonl (in the state dir: TYPETORCH_STATE_DIR, default .typetorch/)
  Approval (typetorch.json "approval": "all" by default, "prod", or "none"): a person at a terminal approves right
  after the upload (y + the key's passphrase). Anyone else (an agent, the dev-server, --propose) only writes a proposal:
  approve it with \`typetorch approve <id>\`.
  --propose            write a proposal even when you could approve now
  --proposed-by <who>  who prepares it: cli, agent, dev-server/claude... (default: cli at a terminal, else agent)
  --key-file <path>    the encrypted signing key (default ~/.config/typetorch/keys/<universeId>.key)
  --dry-run      build and show what would be uploaded and sent; nothing leaves the machine except registry reads
  --no-build     deploy the last build (.typetorch/payload.rbxm)
  --force        allow a dev-channel or dirty artifact on a prod-channel branch, or publish a config draft that has
                 other unpublished changes
  --no-registry  skip the ConfigService registry (servers persist the head from the deploy message anyway)`,
	},
	promote: {
		flags: promoteFlags,
		run: promoteCommand,
		summary: "point a branch at an already uploaded artifact (new seq, no rebuild)",
		usage: `typetorch promote <branch> <artifactId|assetId|#seq|commit> [--force] [--dry-run] [--no-registry] [--message <text>]

  Re-publishes an approved payload asset to <branch> with a new seq and a signed deploy message. Finds it in the
  deployments (any branch) or in uploads.jsonl (an upload whose deploy stopped, or \`typetorch upload\`). A
  dev-channel or dirty artifact needs --force on a prod-channel branch.
  Approval (typetorch.json "approval": "all" by default, "prod", or "none"): a person at a terminal approves right
  after the upload (y + the key's passphrase). Anyone else (an agent, the dev-server, --propose) only writes a proposal:
  approve it with \`typetorch approve <id>\`.
  --propose            write a proposal even when you could approve now
  --proposed-by <who>  who prepares it: cli, agent, dev-server/claude... (default: cli at a terminal, else agent)
  --key-file <path>    the encrypted signing key (default ~/.config/typetorch/keys/<universeId>.key)`,
	},
	rollback: {
		flags: rollbackFlags,
		run: rollbackCommand,
		summary: "re-point a branch at an earlier, already approved build",
		usage: `typetorch rollback [--branch <b>] [--to <commit|artifactId|assetId|#seq>] [--force] [--dry-run] [--no-registry]

  No build, upload or moderation wait. Without --to: the newest earlier deployment on the branch whose artifact
  differs from the live one. Searches the registry (when readable) and the local log.
  Approval (typetorch.json "approval": "all" by default, "prod", or "none"): a person at a terminal approves right
  after the upload (y + the key's passphrase). Anyone else (an agent, the dev-server, --propose) only writes a proposal:
  approve it with \`typetorch approve <id>\`.
  --propose            write a proposal even when you could approve now
  --proposed-by <who>  who prepares it: cli, agent, dev-server/claude... (default: cli at a terminal, else agent)
  --key-file <path>    the encrypted signing key (default ~/.config/typetorch/keys/<universeId>.key)`,
	},
	deployments: {
		flags: deploymentsFlags,
		run: deploymentsCommand,
		summary: "list deployments with their git identity (* = live)",
		usage: `typetorch deployments [--branch <b>] [--limit <n>] [--json]`,
	},
	branch: {
		flags: branchFlags,
		run: branchCommand,
		summary: "branch ls: branches, channels and live heads",
		usage: `typetorch branch ls [--json]`,
	},
	config: {
		flags: configFlags,
		run: configCommand,
		summary: "config push: copy typetorch.json settings into the registry",
		usage: `typetorch config push [--dry-run] [--force]

  Writes defaultBranch, channels, members, devBadgeId (and revoked) into the registry, keeping branches and
  deployments. Needs the universe:read and universe:write scopes.`,
	},
	kernel: {
		flags: kernelFlags,
		run: kernelCommand,
		summary: "kernel deploy: check, identify, build and (with --replace-place --yes) publish the kernel place",
		usage: `typetorch kernel deploy [--kernel <dir>] [--dry-run] [--replace-place --yes] [--allow-dirty] [--allow-untagged]

  1. lune run scripts/check.luau in the kernel dir  2. version (package.json = Constants.luau) + content hash, printed;
  a git checkout must be clean and tagged v<version>  3. rojo build <kernel>/place.project.json -> .typetorch/place.rbxl
  with KernelVersion/KernelHash/KernelCommit/SigningPublicKey on ServerScriptService.TypeTorchKernel.
  Publishing only patches the kernel slots once plans/13 lands (needs spike S12). Until then --replace-place --yes
  publishes the whole kernel place, which WIPES Studio/Team Create content; the place version before and after go to
  kernel-deploys.jsonl in the state dir. Kernel dir: --kernel, else typetorch.json "kernel", else
  node_modules/@typetorch/kernel, else ../kernel.`,
	},
	keys: {
		flags: keysFlags,
		run: keysCommand,
		summary: "keys init|status: the passphrase-encrypted Ed25519 key that signs approved deploys",
		usage: `typetorch keys init [--key-file <path>] [--force]
typetorch keys status [--key-file <path>]

  init (interactive): creates the key (or encrypts a plaintext TYPETORCH_SIGNING_KEY from CLI 0.2.0), asks for a
  passphrase twice, writes the encrypted key file (scrypt + AES-256-GCM; default
  ~/.config/typetorch/keys/<universeId>.key, never inside the repo) and the public key to typetorch.json
  "signingPublicKey". status: the key file, its public key and whether it matches typetorch.json.`,
	},
	approve: {
		flags: approveFlags,
		run: approveCommand,
		summary: "approve a deploy proposal: details, y/N, passphrase, sign, publish (interactive only)",
		usage: `typetorch approve [id] [--no-registry] [--key-file <path>]

  Lists pending proposals (newest first), shows the one you pick (branch, artifact, notes, sources, size, proposer,
  age), asks y/N and the signing key's passphrase (not echoed), then signs and publishes it like a deploy. Refuses
  when stdin isn't an interactive terminal.`,
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
		summary: "list deploy proposals (pending; --all for every one)",
		usage: `typetorch proposals [--all] [--json]

  Proposals live in proposals.jsonl in the state dir and expire after 24 h.`,
	},
	doctor: {
		flags: doctorFlags,
		run: doctorCommand,
		summary: "check tools, typetorch.json, the API key and its scopes",
		usage: `typetorch doctor [--json]`,
	},
};

function help(): string {
	const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
	return [
		`typetorch ${pkg.version}: hot-swap roblox-ts game code on live Roblox servers`,
		"",
		"usage: typetorch <command> [options]",
		"",
		...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
		"",
		"global options: --json (machine output), --verbose, --config <typetorch.json>, --env-file <path>, --help",
		"keys (environment, the TYPETORCH_ENV_FILE file, or .env here or above; never copied to child processes):",
		"  OPENCLOUD_ASSETS_KEY, OPENCLOUD_DEPLOY_KEY, OPENCLOUD_PLACE_KEY per job, else TYPETORCH_API_KEY / OPENCLOUD_API_KEY",
		"deploys are approved and signed by a person: typetorch approve (key from typetorch keys init)",
	].join("\n");
}

async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (!name || name === "help" || name === "--help" || name === "-h") {
		const topic = name === "help" ? rest[0] : undefined;
		console.log(topic && COMMANDS[topic] ? COMMANDS[topic].usage : help());
		return 0;
	}
	if (name === "--version" || name === "-v" || name === "version") {
		console.log(pkg.version);
		return 0;
	}
	const command = COMMANDS[name];
	if (!command) {
		console.error(red(`unknown command "${name}"`));
		console.error(help());
		return 2;
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
