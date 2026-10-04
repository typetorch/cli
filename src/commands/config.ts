/** `typetorch config push`: copy typetorch.json's project settings into the registry value. */
import { flagBool, UsageError, type ParsedArgs } from "../args";
import { jsonEqual } from "../json";
import { bold, emitJson, info, isJson } from "../log";
import { applyProjectConfig, RegistryApi, writeRegistry, type RegistryValue } from "../registry";
import { openCloud, project } from "./common";

export const configFlags = { "dry-run": "boolean", force: "boolean" } as const;

const FIELDS = ["defaultBranch", "channels", "members", "revoked", "devBadgeId"] as const;

export function configDiff(before: RegistryValue, after: RegistryValue): string[] {
	return FIELDS.filter((field) => !jsonEqual(before[field], after[field])).map(
		(field) => `${field}: ${JSON.stringify(before[field])} -> ${JSON.stringify(after[field])}`,
	);
}

export async function configCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub !== "push") throw new UsageError(`unknown config subcommand "${sub ?? ""}" (only "push")`);
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const api = new RegistryApi(openCloud()!, proj.config.universeId);
	const result = await writeRegistry(
		api,
		{ message: `typetorch config push ${proj.config.project}`, force: flagBool(args, "force"), dryRun },
		(current) => applyProjectConfig(current, proj.config),
	);
	const diff = configDiff(result.before, result.after);
	if (isJson()) return emitJson({ ...result, diff });
	if (!result.changed) {
		info("registry already matches typetorch.json");
		return;
	}
	info(bold(dryRun ? "dry run: would publish" : `published${result.configVersion !== undefined ? ` (config v${result.configVersion})` : ""}`));
	for (const line of diff.length > 0 ? diff : ["(creates the TypeTorch key)"]) info(`  ${line}`);
}
