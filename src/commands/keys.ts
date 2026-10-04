/**
 * `typetorch keys init`: makes the Ed25519 keypair deploy messages are signed with (decision D1).
 *   - the private key (base64 of the 32-byte seed) goes into the env file as TYPETORCH_SIGNING_KEY: --env-file, else
 *     TYPETORCH_ENV_FILE, else the project's .env (only when git ignores it). It is never printed.
 *   - the public key (base64, 32 bytes) is printed and written to typetorch.json "signingPublicKey", so `kernel deploy`
 *     bakes it into the place for kernel 0.3 to verify against.
 * Refuses to replace an existing key without --force: servers verify with the old public key until the kernel is
 * redeployed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { expandPath, parseDotEnv, settings } from "../env";
import { bold, emitJson, info, isJson, warn } from "../log";
import { query } from "../proc";
import { generateSigningKey, SIGNING_KEY_VAR } from "../signing";
import { project } from "./common";

export const keysFlags = { force: "boolean" } as const;

/** Sets a top-level string field in a JSON file's text, keeping its formatting. */
export function setJsonStringField(text: string, key: string, value: string): string {
	const existing = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
	let next: string;
	if (existing.test(text)) next = text.replace(existing, `$1${JSON.stringify(value)}`);
	else {
		const end = text.lastIndexOf("}");
		if (end === -1) throw new Error("not a JSON object");
		const before = text.slice(0, end).replace(/\s*$/, "");
		const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "\t";
		next = `${before}${before.endsWith("{") ? "" : ","}\n${indent}"${key}": ${JSON.stringify(value)}\n${text.slice(end)}`;
	}
	if (JSON.parse(next)[key] !== value) throw new Error(`could not set "${key}"`);
	return next;
}

/** Sets `name=value` in env-file text (replacing an existing line), keeping everything else. */
export function setEnvLine(text: string, name: string, value: string): string {
	const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
	const index = lines.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
	if (index === -1) lines.push(`${name}=${value}`);
	else lines[index] = `${name}=${value}`;
	return lines.join("\n") + "\n";
}

/** The env file `keys init` writes: --env-file / TYPETORCH_ENV_FILE, else the project's .env. */
function targetEnvFile(root: string, flag?: string): { file: string; configured: boolean } {
	if (flag) return { file: expandPath(flag, process.cwd()), configured: true };
	const configured = settings().envFile;
	if (configured) return { file: configured, configured: true };
	return { file: join(root, ".env"), configured: false };
}

export async function keysCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub !== "init") throw new UsageError(`unknown keys subcommand "${sub ?? ""}" (only "init")`);
	const proj = project(args);
	const force = flagBool(args, "force");
	const { file, configured } = targetEnvFile(proj.root, flagString(args, "env-file"));

	// A key file inside the repo must be git-ignored, or it could be committed.
	const rel = relative(proj.root, file).replace(/\\/g, "/");
	const insideRepo = !rel.startsWith("../") && !/^[a-z]:/i.test(rel);
	if (insideRepo && query(["git", "rev-parse", "--is-inside-work-tree"], proj.root) === "true") {
		const ignored = query(["git", "check-ignore", "--", rel], proj.root) !== undefined;
		if (!ignored) throw new Error(`${file} is inside the repo and not git-ignored; ignore it first, or use --env-file <path outside the repo>`);
	}
	if (!configured) warn(`writing the signing key to ${file}; a file outside the repo is safer (--env-file ~/.config/typetorch/${proj.config.project}.env, then set TYPETORCH_ENV_FILE)`);

	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	const already = parseDotEnv(text)[SIGNING_KEY_VAR] !== undefined;
	const elsewhere = settings().get(SIGNING_KEY_VAR);
	if ((already || (elsewhere && elsewhere.source !== file)) && !force) {
		throw new Error(
			`a signing key already exists (${already ? file : elsewhere!.source}); --force replaces it, and servers then refuse new deploys until the kernel is redeployed with the new public key`,
		);
	}
	if (elsewhere && elsewhere.source !== file) {
		warn(`${SIGNING_KEY_VAR} is also set in ${elsewhere.source}, which wins over ${file}; remove it there`);
	}

	const { seed, publicKey } = generateSigningKey();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, setEnvLine(text, SIGNING_KEY_VAR, seed), { mode: 0o600 });
	try {
		chmodSync(file, 0o600);
	} catch {}
	writeFileSync(proj.configPath, setJsonStringField(readFileSync(proj.configPath, "utf8"), "signingPublicKey", publicKey));

	if (isJson()) return emitJson({ envFile: file, variable: SIGNING_KEY_VAR, publicKey, config: proj.configPath, replaced: already });
	info(bold(`signing key ${already ? "replaced" : "created"}`));
	info(`  private key  ${SIGNING_KEY_VAR} in ${file} (never printed; back it up somewhere safe)`);
	info(`  public key   ${publicKey}`);
	info(`  typetorch.json "signingPublicKey" updated (${proj.configPath})`);
	info("  next: commit typetorch.json; `typetorch kernel deploy` bakes the public key into the place for kernel 0.3");
}
