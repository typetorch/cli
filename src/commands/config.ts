/**
 * `typetorch config push`: gone in CLI 0.8. It wrote the ConfigService registry key, which needed universe:read (never
 * grantable to API keys). Kernel 0.3.8 reads one signed settings record instead (plans/20): `typetorch settings push`
 * writes defaultBranch, channels and dev access from typetorch.json. The command stays so scripts get a clear message.
 */
import { UsageError, type ParsedArgs } from "../args.ts";

export const configFlags = { "dry-run": "boolean", force: "boolean" } as const;

export async function configCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	throw new UsageError(
		`\`typetorch config${sub ? ` ${sub}` : ""}\` is gone (CLI 0.8): kernel 0.3.8 reads the signed settings record. Run \`typetorch settings push\` (defaultBranch, channels, dev access from typetorch.json)`,
	);
}
