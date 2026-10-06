/**
 * `typetorch access push`: publish typetorch.json's members, revoked and devBadgeId to game servers as the ConfigService
 * key TypeTorchAccess (access.ts); `typetorch access status`: whether what servers have matches typetorch.json (as far
 * as this machine knows). Needs the deploy key with universe:write; nothing is read back (API keys can't read configs).
 */
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import { ACCESS_CONFIG_KEY, accessStatus, accessWarning, describeAccess, writeAccessRecord, type AccessStatus } from "../access.ts";
import type { Project } from "../config.ts";
import { bold, dim, emitJson, info, isJson, warn } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import { publishConfigKey } from "../registry.ts";
import { openCloud, project, projectStateDir } from "./common.ts";

export const accessFlags = { "dry-run": "boolean" } as const;

export const ACCESS_USAGE = `typetorch access push [--dry-run]
typetorch access status

  Dev access (who may use the dev menu and /tt) comes from typetorch.json: "members" (userId -> owner | dev), "revoked"
  and "devBadgeId". Servers read them from the server-only ConfigService key ${ACCESS_CONFIG_KEY} (kernel 0.3.6+), which
  only this command writes: in-game code can't write ConfigService, so a backdoored model can't make itself a dev.
  (The registry key TypeTorch also holds them, but writing it needs universe:read, which API keys can't get.)
  push     publish the lists (PATCH the config draft with this one key, then publish; universe:write on the deploy key).
           Running servers pick the change up when ConfigService pushes it (seconds to minutes); nothing is read back.
           .typetorch/access.json remembers a hash of what was pushed, so deploy and doctor warn when typetorch.json
           changed since.
  status   what this machine last pushed vs typetorch.json
  --dry-run  show the value and stop
  Note: the publish ships the whole ConfigService draft; an API key can't read it to check for other unpublished edits.`;

export interface PushAccessInput {
	proj: Project;
	oc: Pick<OpenCloud, "call">;
	dryRun: boolean;
	now?: () => Date;
}

export interface PushAccessResult {
	status: AccessStatus;
	dryRun: boolean;
	configVersion?: number;
}

/** Publishes the key and records the hash. The value is small (ids and roles), so it is shown in full. */
export async function pushAccess(input: PushAccessInput): Promise<PushAccessResult> {
	const { proj } = input;
	const dir = projectStateDir(proj);
	const status = accessStatus(proj.config, dir);
	if (input.dryRun) return { status, dryRun: true };
	const result = await publishConfigKey(input.oc, proj.config.universeId, ACCESS_CONFIG_KEY, status.value, `typetorch access push ${proj.config.project}`);
	const record = { v: 1 as const, universeId: proj.config.universeId, sha256: status.sha256, at: (input.now ?? (() => new Date()))().toISOString(), ...(result.configVersion !== undefined ? { configVersion: result.configVersion } : {}) };
	writeAccessRecord(dir, record);
	return { status: accessStatus(proj.config, dir), dryRun: false, ...(result.configVersion !== undefined ? { configVersion: result.configVersion } : {}) };
}

export async function accessCommand(args: ParsedArgs, deps: { oc?: Pick<OpenCloud, "call"> } = {}) {
	const [sub, extra] = args.positionals;
	if (sub !== "push" && sub !== "status") throw new UsageError(`unknown access subcommand "${sub ?? ""}" (push, status)`);
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	const proj = project(args);
	if (sub === "status") {
		const status = accessStatus(proj.config, projectStateDir(proj));
		if (isJson()) return emitJson({ key: ACCESS_CONFIG_KEY, value: status.value, sha256: status.sha256, configured: status.configured, published: status.published, stale: status.stale, record: status.record ?? null });
		info(`${ACCESS_CONFIG_KEY}: ${describeAccess(status.value)}`);
		if (!status.configured) info(dim("  nothing to publish: typetorch.json lists no members, revoked users or dev badge (only the creator is a dev)"));
		else if (!status.published) warn(accessWarning(status)!);
		else if (status.stale) warn(accessWarning(status)!);
		else info(dim(`  pushed ${status.record?.at}${status.record?.configVersion !== undefined ? ` (config v${status.record.configVersion})` : ""}; matches typetorch.json`));
		return;
	}
	const dryRun = flagBool(args, "dry-run");
	const status = accessStatus(proj.config, projectStateDir(proj));
	if (!status.configured && !dryRun) {
		warn(`typetorch.json lists no members, revoked users or dev badge: publishing an empty ${ACCESS_CONFIG_KEY} (servers then fall back to the registry's lists, if any)`);
	}
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, key: ACCESS_CONFIG_KEY, value: status.value });
		info(bold(`dry run: would write ConfigService key ${ACCESS_CONFIG_KEY} = ${JSON.stringify(status.value)} and publish it`));
		return;
	}
	const result = await pushAccess({ proj, oc: deps.oc ?? openCloud("deploy")!, dryRun: false });
	if (isJson()) return emitJson({ key: ACCESS_CONFIG_KEY, value: result.status.value, sha256: result.status.sha256, configVersion: result.configVersion ?? null });
	info(bold(`published ${ACCESS_CONFIG_KEY}: ${describeAccess(result.status.value)}${result.configVersion !== undefined ? ` (config v${result.configVersion})` : ""}`));
	info(dim("  running servers (kernel 0.3.6+) pick it up when ConfigService pushes the update; older kernels keep the registry's lists"));
	info(dim("  note: the publish ships the whole ConfigService draft; an API key can't read it to check for other unpublished edits"));
}
