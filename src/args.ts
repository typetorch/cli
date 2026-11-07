/**
 * Hand-rolled argument parsing (no dependencies). Each command declares its flags; unknown flags are errors so a typo
 * never silently changes what a deploy does.
 *   --flag            boolean
 *   --name value      string
 *   --name=value      string
 *   --name [n]        optional: true alone, or the next argument when it is a whole number (`--wait`, `--wait 60`)
 *   --name value ...  list: like string, but repeatable; every value in order (`flagList`), the last in `flags`
 *   --                everything after is positional
 */

export type FlagType = "boolean" | "string" | "optional" | "list";
export type FlagSpec = Record<string, FlagType>;

export interface ParsedArgs {
	positionals: string[];
	flags: Record<string, string | boolean>;
	/** Every value of each "list" flag, in order (absent when none was given). */
	lists?: Record<string, string[]>;
}

/** Thrown for bad command lines; the entry point prints it with the command's usage. */
export class UsageError extends Error {
	override name = "UsageError";
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS: FlagSpec = {
	help: "boolean",
	json: "boolean",
	verbose: "boolean",
	config: "string",
	"env-file": "string",
};

export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
	const all: FlagSpec = { ...GLOBAL_FLAGS, ...spec };
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	const lists: Record<string, string[]> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "-h") {
			flags.help = true;
			continue;
		}
		if (arg.startsWith("--")) {
			let name = arg.slice(2);
			let value: string | undefined;
			const eq = name.indexOf("=");
			if (eq !== -1) {
				value = name.slice(eq + 1);
				name = name.slice(0, eq);
			}
			const type = all[name];
			if (!type) throw new UsageError(`unknown option --${name}`);
			if (type === "boolean") {
				if (value !== undefined) throw new UsageError(`--${name} takes no value`);
				flags[name] = true;
				continue;
			}
			if (type === "optional") {
				if (value === undefined && /^\d+$/.test(argv[i + 1] ?? "")) value = argv[++i];
				flags[name] = value ?? true;
				continue;
			}
			if (value === undefined) {
				value = argv[i + 1];
				if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
				i++;
			}
			flags[name] = value;
			if (type === "list") (lists[name] ??= []).push(value);
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) throw new UsageError(`unknown option ${arg}`);
		positionals.push(arg);
	}
	return Object.keys(lists).length ? { positionals, flags, lists } : { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
	const value = args.flags[name];
	return typeof value === "string" ? value : undefined;
}

/** Every value of a repeatable ("list") flag, in order; [] when it wasn't given. */
export function flagList(args: ParsedArgs, name: string): string[] {
	const values = args.lists?.[name];
	if (values) return [...values];
	const single = flagString(args, name);
	return single === undefined ? [] : [single];
}

export function flagBool(args: ParsedArgs, name: string): boolean {
	return args.flags[name] === true;
}

export function flagInt(args: ParsedArgs, name: string, fallback: number): number {
	const raw = flagString(args, name);
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number, got "${raw}"`);
	return Number(raw);
}
