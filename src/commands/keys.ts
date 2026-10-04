/**
 * `typetorch keys init`: makes the Ed25519 key that signs deploy messages (decision D1) and stores it ENCRYPTED with a
 * passphrase in a key file outside the repo (keystore.ts; default ~/.config/typetorch/keys/<universeId>.key). Needs an
 * interactive terminal: the passphrase is typed twice and never echoed, stored or printed. The public key goes into
 * typetorch.json "signingPublicKey" so `kernel deploy` bakes it into the place.
 *
 * A plaintext TYPETORCH_SIGNING_KEY from CLI 0.2.0 (in an env file or the environment) is offered for encryption
 * (keeping its public key), and its line can be removed from the env file.
 *
 * `typetorch keys status`: where the key file is, its public key, and whether it matches typetorch.json (no secrets).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args";
import { ALLOW_ENV_SIGNING_VAR, settings } from "../env";
import { interaction, NotInteractiveError, type Interaction } from "../interact";
import { encryptSeed, passphraseProblems, readKeyFile, writeKeyFile, type KeyFile } from "../keystore";
import { bold, emitJson, info, isJson, warn } from "../log";
import { query } from "../proc";
import { generateSigningKey, SIGNING_KEY_VAR } from "../signing";
import { keyFilePath, project } from "./common";

export const keysFlags = { force: "boolean", "key-file": "string" } as const;

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

/** Env-file text without the `name=` line(s). */
export function removeEnvLine(text: string, name: string): string {
	const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
	const kept = lines.filter((line) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
	return kept.length === 0 ? "" : kept.join("\n") + "\n";
}

/** True when `path` is inside `root` (or is it). */
function isInside(root: string, path: string): boolean {
	const rel = relative(root, path).replace(/\\/g, "/");
	return rel === "" || (!rel.startsWith("../") && rel !== ".." && !/^[a-z]:/i.test(rel));
}

/** Asks for a new passphrase twice until it is acceptable and both match. */
export async function newPassphrase(io: Interaction): Promise<string> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const first = await io.secret("new passphrase (12+ characters, not echoed): ");
		const problems = passphraseProblems(first);
		if (problems.length > 0) {
			info(`the passphrase needs ${problems.join(", ")}`);
			continue;
		}
		if ((await io.secret("repeat it: ")) === first) return first;
		info("the two passphrases differ");
	}
	throw new UsageError("no passphrase set");
}

export async function keysInit(args: ParsedArgs, io: Interaction = interaction()) {
	const proj = project(args);
	if (!io.interactive) {
		throw new NotInteractiveError("typetorch keys init asks for a passphrase: run it yourself in an interactive terminal");
	}
	const force = flagBool(args, "force");
	const keyFile = keyFilePath(proj, flagString(args, "key-file"));
	if (isInside(proj.root, keyFile)) throw new UsageError(`the key file must live outside the repo (${keyFile} is inside ${proj.root}); pass --key-file <path outside it>`);
	if (existsSync(dirname(keyFile)) && query(["git", "rev-parse", "--is-inside-work-tree"], dirname(keyFile)) === "true") {
		warn(`${keyFile} is inside a git work tree; make sure it is never committed (it is encrypted, but keep it private)`);
	}
	if (existsSync(keyFile) && !force) {
		const current = readKeyFile(keyFile);
		throw new UsageError(
			`a signing key already exists at ${keyFile} (public key ${current.publicKey}); --force replaces it, and servers then refuse new deploys until the kernel is redeployed with the new public key`,
		);
	}

	// A plaintext key from CLI 0.2.0: offer to encrypt it (same public key, so nothing else changes).
	let seed: string | undefined;
	let plaintext: ReturnType<ReturnType<typeof settings>["plaintextSigningKey"]>;
	try {
		plaintext = settings().plaintextSigningKey();
	} catch (error) {
		warn(`${SIGNING_KEY_VAR} is set but unreadable (${(error as Error).message}); ignoring it`);
	}
	if (plaintext) {
		info(`a plaintext ${SIGNING_KEY_VAR} exists in ${plaintext.source} (public key ${plaintext.publicKey})`);
		if (await io.confirm("encrypt that key into the key file (keeps the same public key)?")) seed = plaintext.seed;
	}
	const created = seed === undefined;
	seed ??= generateSigningKey().seed;
	const passphrase = await newPassphrase(io);
	const file: KeyFile = encryptSeed(seed, passphrase, { universeId: proj.config.universeId });
	writeKeyFile(keyFile, file);
	writeFileSync(proj.configPath, setJsonStringField(readFileSync(proj.configPath, "utf8"), "signingPublicKey", file.publicKey));

	if (plaintext && !created) {
		if (plaintext.source !== "environment" && existsSync(plaintext.source)) {
			if (await io.confirm(`remove the plaintext ${SIGNING_KEY_VAR} line from ${plaintext.source}?`)) {
				writeFileSync(plaintext.source, removeEnvLine(readFileSync(plaintext.source, "utf8"), SIGNING_KEY_VAR));
				info(`removed ${SIGNING_KEY_VAR} from ${plaintext.source}`);
			}
		} else {
			warn(`remove ${SIGNING_KEY_VAR} from your environment: the key file replaces it`);
		}
	}
	if (isJson()) return emitJson({ keyFile, publicKey: file.publicKey, config: proj.configPath, migrated: !created });
	info(bold(`signing key ${created ? "created" : "encrypted"}: ${keyFile}`));
	info(`  public key   ${file.publicKey}`);
	info(`  typetorch.json "signingPublicKey" updated (${proj.configPath})`);
	info("  the passphrase is not stored anywhere: keep it (and a backup of the key file) somewhere safe");
	info("  next: commit typetorch.json; `typetorch kernel deploy` bakes the public key into the place for kernel 0.3");
}

export async function keysStatus(args: ParsedArgs) {
	const proj = project(args);
	const keyFile = keyFilePath(proj, flagString(args, "key-file"));
	let file: KeyFile | undefined;
	let problem: string | undefined;
	try {
		file = existsSync(keyFile) ? readKeyFile(keyFile) : undefined;
	} catch (error) {
		problem = (error as Error).message;
	}
	let plaintextSource: string | undefined;
	try {
		plaintextSource = settings().plaintextSigningKey()?.source;
	} catch {
		plaintextSource = "unreadable";
	}
	const status = {
		keyFile,
		exists: file !== undefined,
		problem,
		publicKey: file?.publicKey ?? null,
		configured: proj.config.signingPublicKey ?? null,
		matches: file !== undefined && file.publicKey === proj.config.signingPublicKey,
		kdf: file ? `scrypt N=${file.kdf.N} r=${file.kdf.r} p=${file.kdf.p}` : null,
		plaintextKey: plaintextSource ?? null,
		ciEscapeHatch: settings().get(ALLOW_ENV_SIGNING_VAR)?.value === "1",
		approval: proj.config.approval,
	};
	if (isJson()) return emitJson(status);
	info(`key file     ${keyFile}${file ? "" : problem ? `  (${problem})` : "  (none: typetorch keys init)"}`);
	if (file) info(`public key   ${file.publicKey}  (${status.kdf}, AES-256-GCM)`);
	info(`config       signingPublicKey ${status.configured ?? "(not set)"}${file ? (status.matches ? "  matches" : "  DOES NOT MATCH the key file") : ""}`);
	info(`approval     "${status.approval}"`);
	if (plaintextSource) warn(`a plaintext ${SIGNING_KEY_VAR} is in ${plaintextSource}: it is ignored; typetorch keys init encrypts it`);
	if (status.ciEscapeHatch) warn(`${ALLOW_ENV_SIGNING_VAR}=1 is set: the CI escape hatch (signing without approval) is on`);
}

export async function keysCommand(args: ParsedArgs) {
	const sub = args.positionals[0];
	if (sub === "init") return keysInit(args);
	if (sub === "status") return keysStatus(args);
	throw new UsageError(`unknown keys subcommand "${sub ?? ""}" (init or status)`);
}
