/** `typetorch help`: the commands in groups, one short line each (details: `typetorch help <command>`). */
import { bold } from "./log.ts";

/** Each command in one group, in this order. A command missing here is listed under "Other", never hidden. */
export const HELP_GROUPS: [title: string, commands: string[]][] = [
	["Ship a build", ["deploy", "build", "upload", "test", "promote", "rollback"]],
	["Approvals", ["approve", "proposals", "reject"]],
	["Live servers", ["servers", "report", "alerts", "deployments", "branch", "pin"]],
	["Setup", ["doctor", "keys", "access", "fleet", "kernel", "assets", "config"]],
	["Tools", ["dev", "update"]],
];

/** Commands listed on another command's line instead of their own (alias -> command). */
export const HELP_ALIASES: Record<string, string> = { "remote-claude": "dev" };

/** The help page: `summaries` maps every command to its one-line summary. */
export function renderHelp(version: string, summaries: Record<string, string>): string {
	const aliases = (name: string) => Object.keys(HELP_ALIASES).filter((alias) => HELP_ALIASES[alias] === name);
	const summary = (name: string) =>
		aliases(name).length > 0 ? `${summaries[name]} (also: ${aliases(name).join(", ")})` : summaries[name];
	const grouped = new Set(HELP_GROUPS.flatMap(([, names]) => names));
	const other = Object.keys(summaries).filter((name) => !grouped.has(name) && HELP_ALIASES[name] === undefined);
	const groups = [...HELP_GROUPS, ...(other.length > 0 ? [["Other", other] as [string, string[]]] : [])].map(
		([title, names]) => [title, names.filter((name) => summaries[name] !== undefined)] as const,
	);
	const width = Math.max(...groups.flatMap(([, names]) => names.map((name) => name.length)));
	const lines = [`typetorch ${version}: hot-swap roblox-ts game code on live Roblox servers`, "", "usage: typetorch <command> [options]"];
	for (const [title, names] of groups) {
		if (names.length === 0) continue;
		lines.push("", bold(title));
		for (const name of names) lines.push(`  ${name.padEnd(width)}  ${summary(name)}`);
	}
	lines.push(
		"",
		bold("Options"),
		"  --json (machine output)  --verbose  --config <typetorch.json>  --env-file <path>  --help",
		"",
		bold("API keys"),
		"  OPENCLOUD_ASSETS_KEY, OPENCLOUD_DEPLOY_KEY, OPENCLOUD_PLACE_KEY per job, else TYPETORCH_API_KEY / OPENCLOUD_API_KEY",
		"  read from the environment, the TYPETORCH_ENV_FILE file, or .env here or above; never passed to child processes",
		"",
		"Details: typetorch help <command>, or typetorch <command> --help",
	);
	return lines.join("\n");
}

/** The known command closest to a mistyped one (at most 2 edits away), for "did you mean". */
export function closestCommand(input: string, names: string[]): string | undefined {
	const word = input.toLowerCase();
	let best: string | undefined;
	let bestDistance = 3;
	for (const name of names) {
		const distance = editDistance(word, name);
		if (distance < bestDistance) {
			best = name;
			bestDistance = distance;
		}
	}
	return best;
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}
