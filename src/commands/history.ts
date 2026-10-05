/** `typetorch deployments` and `typetorch branch ls`: registry (when readable) + the local log. */
import { flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { formatDeploymentsTable, unpublishedUploads } from "../deployments.ts";
import { dim, emitJson, info, isJson, table } from "../log.ts";
import { branchChannel } from "../naming.ts";
import { openCloud, project, readHistory, registryApi } from "./common.ts";

export const deploymentsFlags = { branch: "string", limit: "string" } as const;

function sourceNote(unavailable: string | undefined): string {
	if (!unavailable) return "registry + local log";
	// The usual cause: the configs API needs universe:read, which API keys can't get.
	if (/universe:read|Scope not authorized/.test(unavailable)) return "local log only (the registry needs universe:read, which API keys can't get)";
	const first = unavailable.split("\n")[0];
	const short = first.length <= 120 ? first : `${first.slice(0, 120).replace(/\s+\S*$/, "")}...`;
	return `registry not read (${short}); local log only`;
}

export async function deploymentsCommand(args: ParsedArgs) {
	const proj = project(args);
	const oc = openCloud("deploy", true);
	const history = await readHistory(proj, registryApi(oc, proj, false));
	const branch = flagString(args, "branch");
	const limit = flagInt(args, "limit", 20);
	let rows = history.rows;
	if (branch) rows = rows.filter((d) => d.branch === branch);
	rows = rows.slice(-limit);
	// Uploads that never went out (a deploy that stopped after moderation, or `typetorch upload`): promote them.
	const pending = unpublishedUploads(history.uploads, history.rows)
		.filter((u) => !branch || u.branch === branch)
		.slice(-5);
	if (isJson()) {
		return emitJson({
			source: history.snapshot ? "registry+local" : "local",
			registryUnavailable: history.unavailable,
			stateDir: history.stateDir,
			heads: Object.fromEntries(history.heads),
			deployments: rows,
			unpublishedUploads: pending,
		});
	}
	if (rows.length === 0) {
		info(`no deployments${branch ? ` on ${branch}` : ""} yet (${sourceNote(history.unavailable)})`);
		return;
	}
	info(formatDeploymentsTable([...rows].reverse(), history.heads)); // newest first (--json keeps oldest first)
	info(dim(`* = live head of its branch; # = deploy number (seq); times UTC; ${sourceNote(history.unavailable)}`));
	for (const upload of pending) {
		info(
			`uploaded, never published: ${upload.artifactId} (asset ${upload.assetId}, ${upload.moderation}, ${upload.at.replace("T", " ").slice(0, 19)}): typetorch promote ${upload.branch} ${upload.assetId}`,
		);
	}
}

export const branchFlags = {} as const;

export async function branchCommand(args: ParsedArgs) {
	const sub = args.positionals[0] ?? "ls";
	if (sub !== "ls" && sub !== "list") throw new UsageError(`unknown branch subcommand "${sub}" (only "ls" for now)`);
	const proj = project(args);
	const oc = openCloud("deploy", true);
	const history = await readHistory(proj, registryApi(oc, proj, false));
	const registry = history.snapshot?.value;
	const names = new Set<string>([
		proj.config.defaultBranch,
		...Object.keys(proj.config.channels),
		...Object.keys(registry?.channels ?? {}),
		...history.heads.keys(),
	]);
	const branches = [...names].sort().map((name) => {
		const head = history.heads.get(name);
		const channel = registry?.channels[name] ?? branchChannel(proj.config, name);
		return { branch: name, channel, default: name === proj.config.defaultBranch, head: head ?? null };
	});
	if (isJson()) return emitJson({ source: registry ? "registry+local" : "local", registryUnavailable: history.unavailable, branches });
	info(
		table(
			["branch", "channel", "artifact", "commit", "seq", "deployed (UTC)", "asset"],
			branches.map((b) => [
				b.default ? `${b.branch} (default)` : b.branch,
				b.channel,
				b.head?.artifactId ?? "-",
				b.head ? `${b.head.commit || "uncommitted"}${b.head.dirty ? "*" : ""}` : "-",
				b.head ? `#${b.head.seq}` : "-",
				b.head?.deployedAt ? b.head.deployedAt.replace("T", " ").slice(0, 19) : "-",
				b.head ? String(b.head.assetId) : "-",
			]),
		),
	);
	info(dim(sourceNote(history.unavailable)));
}
