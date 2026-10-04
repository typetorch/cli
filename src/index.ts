#!/usr/bin/env bun
/**
 * typetorch: build, upload and hot-swap roblox-ts game code on live Roblox servers.
 * Run inside a game repo (a folder with typetorch.json). See README.md.
 */
import pkg from "../package.json" with { type: "json" };
import { flagBool, parseArgs, UsageError, type FlagSpec, type ParsedArgs } from "./args";
import { buildCommand, buildFlags, uploadCommand, uploadFlags } from "./commands/build";
import { configCommand, configFlags } from "./commands/config";
import { deployCommand, deployFlags } from "./commands/deploy";
import { doctorCommand, doctorFlags } from "./commands/doctor";
import { branchCommand, branchFlags, deploymentsCommand, deploymentsFlags } from "./commands/history";
import { kernelCommand, kernelFlags } from "./commands/kernel";
import { rollbackCommand, rollbackFlags } from "./commands/rollback";
import { loadDotEnv, redact } from "./env";
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
		usage: `typetorch build [--branch <b>] [--channel prod|dev]

  Writes src/shared/build.ts, runs rbxtsc, then rojo-builds default.project.json with the artifact identity
  stamped on the root ($attributes ArtifactId, KernelApi, Channel, Commit, BuiltAt) into .typetorch/payload.rbxm,
  plus .typetorch/payload.json (artifact id, git identity, sha256).
  --branch   TypeTorch branch (default: typetorch.json "branches"[git branch], else the git branch, lowercased, / -> -)
  --channel  override the branch's channel (default: "channels"[branch], else prod for defaultBranch, else dev)`,
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
		summary: "build, upload, wait for Approved, point the branch at it, tell live servers",
		usage: `typetorch deploy [--branch <b>] [--channel prod|dev] [--no-build] [--dry-run] [--message <text>] [--force]
                 [--no-registry] [--moderation-timeout <s>]

  build -> upload (new Model asset) -> moderation = Approved -> registry -> deploy message -> .typetorch/deployments.jsonl
  --dry-run      build and show what would be uploaded and sent; nothing leaves the machine except registry reads
  --no-build     deploy the last build (.typetorch/payload.rbxm)
  --force        allow a dev-channel or dirty artifact on a prod-channel branch, or publish a config draft that has
                 other unpublished changes
  --no-registry  skip the ConfigService registry (servers persist the head from the deploy message anyway)`,
	},
	rollback: {
		flags: rollbackFlags,
		run: rollbackCommand,
		summary: "re-point a branch at an earlier, already approved build",
		usage: `typetorch rollback [--branch <b>] [--to <commit|artifactId|assetId|#seq>] [--force] [--dry-run] [--no-registry]

  No build, upload or moderation wait. Without --to: the newest earlier deployment on the branch whose artifact
  differs from the live one. Searches the registry (when readable) and the local log.`,
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
		summary: "kernel deploy: build the kernel place and publish it (replaces the place)",
		usage: `typetorch kernel deploy [--kernel <dir>] [--dry-run]

  rojo build <kernel>/place.project.json -> .typetorch/place.rbxl, then publish it as the live place version.
  Kernel dir: --kernel, else typetorch.json "kernel", else node_modules/@typetorch/kernel, else ../kernel.
  REPLACES THE WHOLE PLACE; servers run it after they restart.`,
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
		"global options: --json (machine output), --verbose, --config <typetorch.json>, --help",
		"API key: TYPETORCH_API_KEY, OPENCLOUD_API_KEY or ROBLOX_API_KEY (environment or .env here or in a parent folder)",
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
	loadDotEnv(process.cwd());
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
