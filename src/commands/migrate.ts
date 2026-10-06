/**
 * `typetorch migrate --from flamework [--dry-run] [--net compat|native] [--report <file>] [--allow-dirty]`: the
 * mechanical part of moving a Flamework game to TypeTorch (src/migrate.ts), local only: no keys, no network.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { gitInfo } from "../git.ts";
import { bold, cyan, dim, emitJson, green, info, isJson, red, warn, yellow } from "../log.ts";
import { FLAG_KINDS, migrateFlamework, migrationReport, type FlagKind, type NetMode } from "../migrate.ts";
import { unifiedDiff } from "../textdiff.ts";

export const migrateFlags = {
	from: "string",
	net: "string",
	"dry-run": "boolean",
	report: "string",
	"allow-dirty": "boolean",
} as const;

export const DEFAULT_REPORT = "typetorch-migrate-report.md";

export const MIGRATE_USAGE = `typetorch migrate --from flamework [--dry-run] [--net compat|native] [--report <file>] [--allow-dirty]

  Rewrites a Flamework 1.x game (run it in the game folder, next to tsconfig.json) with the TypeScript compiler API,
  using the game's own node_modules/typescript. Local only: no keys, nothing leaves the machine.
  Rewrites: @flamework/core imports -> @typetorch/framework; @Service / @Controller classes extend Module and call
  super(); @metadata flamework:* tags; *.server.ts / *.client.ts ignite files -> src/<realm>/boot.ts (other top-level
  code moves into a generated module, reported); networking (below).
  Flags without rewriting: module-level state, Players.PlayerAdded.Connect, _G, loops / task.* / connections outside a
  trove, @flamework/components, Dependency<T>() before construction, loadstring, remotes, MessagingService,
  DataStore / ProfileService code, BindToClose, toolchain leftovers.
  --net compat   (default) Networking.createEvent / createFunction -> createFlameworkCompat: every call site
                 (connect, fire, broadcast, predict, setCallback, invoke, ...) stays as it is
  --net native   call sites move to createNetwork: connect -> on (in this.trove), setCallback -> handle, broadcast ->
                 fireAll, except -> fireExcept, predict -> emit; what it can't decide is flagged
  --dry-run      print the diff and the summary; write nothing (with --report, only the report)
  --report       the Markdown report (default ${DEFAULT_REPORT})
  --allow-dirty  run on a working tree with uncommitted changes (the migration is easiest to review as one diff)
  Then: bun run build; what still fails is in the report. Guide: guides/from-flamework.md`;

export async function migrateCommand(args: ParsedArgs) {
	const from = flagString(args, "from");
	if (from !== "flamework") throw new UsageError(from ? `--from ${from}: only flamework is supported` : "--from flamework is required");
	const net = (flagString(args, "net") ?? "compat") as NetMode;
	if (net !== "compat" && net !== "native") throw new UsageError(`--net ${net}: use compat or native`);
	if (args.positionals.length > 0) throw new UsageError(`unexpected argument ${args.positionals[0]}`);
	const dryRun = flagBool(args, "dry-run");
	const projectDir = process.cwd();
	if (!existsSync(join(projectDir, "tsconfig.json"))) throw new Error(`no tsconfig.json here (${projectDir}): run it in the game folder`);

	if (!dryRun && !flagBool(args, "allow-dirty")) {
		const git = gitInfo(projectDir);
		if (!git.isRepo) throw new Error("not a git repository: commit the game first (or --allow-dirty), so the migration is one reviewable diff");
		if (git.dirtyFiles.length > 0) {
			throw new Error(`uncommitted changes (${git.dirtyFiles.slice(0, 3).join(", ")}${git.dirtyFiles.length > 3 ? ", ..." : ""}): commit or stash them first, or pass --allow-dirty`);
		}
	}

	const result = migrateFlamework({ projectDir, net });
	const reportPath = resolve(projectDir, flagString(args, "report") ?? DEFAULT_REPORT);
	const writeReport = !dryRun || flagString(args, "report") !== undefined;
	const report = migrationReport(result, { net, dryRun, project: projectDir.split(/[\\/]/).pop() ?? "." });

	if (dryRun && !isJson()) {
		for (const change of result.changes) {
			const diff = unifiedDiff(change.path, change.before, change.after);
			if (diff !== "") info(colorDiff(diff));
		}
	}
	if (!dryRun) {
		for (const change of result.changes) {
			const target = join(projectDir, change.path);
			if (change.after === undefined) rmSync(target, { force: true });
			else {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, change.after);
			}
		}
	}
	if (writeReport) writeFileSync(reportPath, report);

	const created = result.changes.filter((change) => change.before === undefined).length;
	const deleted = result.changes.filter((change) => change.after === undefined).length;
	const changed = result.changes.length - created - deleted;
	if (isJson()) {
		emitJson({
			net,
			dryRun,
			changed: result.changes.filter((c) => c.before !== undefined && c.after !== undefined).map((c) => c.path),
			created: result.changes.filter((c) => c.before === undefined).map((c) => c.path),
			deleted: result.changes.filter((c) => c.after === undefined).map((c) => c.path),
			stats: result.stats,
			flags: result.flags,
			report: writeReport ? reportPath : undefined,
		});
		return;
	}
	info(
		`${bold(`migrate --from flamework --net ${net}`)}${dryRun ? dim(" (dry run: nothing written)") : ""}: ${changed} files changed, ${created} created, ${deleted} deleted`,
	);
	info(`  modules ${result.stats.modules ?? 0}, networks ${result.stats.networks ?? 0}${net === "native" ? `, call sites ${result.stats.callSites ?? 0}` : ""}, boot files ${result.stats.bootFiles ?? 0}`);
	const kinds = (Object.keys(FLAG_KINDS) as FlagKind[])
		.map((kind) => [kind, result.flags.filter((flag) => flag.kind === kind).length] as const)
		.filter(([, n]) => n > 0);
	if (kinds.length > 0) {
		info(`${yellow(`flagged for review: ${result.flags.length}`)}`);
		for (const [kind, n] of kinds) info(`  ${String(n).padStart(4)}  ${FLAG_KINDS[kind].title}`);
	} else info(green("nothing flagged"));
	if (writeReport) info(`report: ${cyan(reportPath)}`);
	if (!dryRun) info("next: bun run build (what still fails is in the report)");
	if (dryRun && result.changes.length === 0) warn("nothing to rewrite: is this a Flamework project?");
}

function colorDiff(diff: string): string {
	return diff
		.split("\n")
		.map((line) => (line.startsWith("+") && !line.startsWith("+++") ? green(line) : line.startsWith("-") && !line.startsWith("---") ? red(line) : line.startsWith("@@") ? cyan(line) : line))
		.join("\n");
}
