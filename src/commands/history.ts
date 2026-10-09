/**
 * `typetorch deployments` (`typetorch branch` lives in branch.ts): this machine's deployment log (CLI 0.8: the ConfigService registry
 * is gone; it was never readable with an API key).
 */
import { flagInt, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { formatDeploymentsTable, unpublishedUploads } from "../deployments.ts";
import { dim, emitJson, info, isJson, table } from "../log.ts";
import { branchChannel } from "../naming.ts";
import { project, readHistory } from "./common.ts";

export const deploymentsFlags = { branch: "string", limit: "string" } as const;

const SOURCE_NOTE = "this machine's deployment log";

export async function deploymentsCommand(args: ParsedArgs) {
	const proj = project(args);
	const history = await readHistory(proj);
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
			source: "local",
			stateDir: history.stateDir,
			heads: Object.fromEntries(history.heads),
			deployments: rows,
			unpublishedUploads: pending,
		});
	}
	if (rows.length === 0) {
		info(`no deployments${branch ? ` on ${branch}` : ""} yet (${SOURCE_NOTE})`);
		return;
	}
	// newest first (--json keeps oldest first); the channel column is the branch's (kernel 0.3.9's rule), not the build's
	info(formatDeploymentsTable([...rows].reverse(), history.heads, Date.now(), (name) => branchChannel(proj.config, name)));
	info(dim(`* = live head of its branch; # = deploy number (seq); times UTC; ${SOURCE_NOTE}`));
	for (const upload of pending) {
		info(
			`uploaded, never published: ${upload.artifactId} (asset ${upload.assetId}, ${upload.moderation}, ${upload.at.replace("T", " ").slice(0, 19)}): typetorch promote ${upload.branch} ${upload.assetId}`,
		);
	}
}

