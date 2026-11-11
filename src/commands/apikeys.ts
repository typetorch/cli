/**
 * `typetorch keys create | list | revoke`: named API keys with roles on the TypeTorch backend (plans/31), next to the
 * prod signing keys that `keys init | rotate | resign` manage (commands/keys.ts). Every call goes to typetorch.json
 * backend.url with TYPETORCH_ADMIN_TOKEN:
 *
 *   create   POST /v1/admin/keys { name, role, expiresDays? }: the key (`ttk_<id>_<secret>`) is printed ONCE (--json:
 *            in `key`, for a script that pipes it into a secret store). It is registered with the scrubber the moment
 *            it arrives, and never written to disk or logged.
 *   list     GET /v1/admin/keys [?all=1]: id, name, role, scopes, expiry, last use, built-in / revoked (never a secret)
 *   revoke   DELETE /v1/admin/keys/{id}; built-in ids (env:*, the env tokens) are refused here: rotate the env instead
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { API_KEY_ROLES, backendCredentialsWarned, createApiKey, listApiKeys, revokeApiKey, type ApiKeyInfo, type ApiKeyRole, type BackendRequestOptions } from "../backend.ts";
import type { Project } from "../config.ts";
import { ADMIN_TOKEN_VAR, registerSecret } from "../env.ts";
import { bold, dim, emitJson, info, isJson, table, yellow } from "../log.ts";
import { project } from "./common.ts";

export const API_KEY_SUBCOMMANDS = ["create", "list", "revoke"] as const;
export const API_KEY_NAME = /^[a-z0-9._-]{1,48}$/;
export const API_KEY_ID = /^[0-9a-z]{10}$/;
export const EXPIRES_MAX_DAYS = 3650;

export const API_KEYS_USAGE = `typetorch keys create --name <name> --role <game|lookup|support|analyst|admin> [--expires <365d|90d|1y>]
typetorch keys list [--all]
typetorch keys revoke <id>

  Named API keys with roles on the TypeTorch backend (plans/31), for tools that must not hold the admin token (a support
  bot reading one player's anticheat rows, an analyst's notebook). Through typetorch.json backend.url with
  ${ADMIN_TOKEN_VAR}.
  create   makes a key "ttk_<id>_<secret>" and prints it ONCE: store it right away (a secret store, the tool's env);
           the backend keeps only its hash. --json returns it in "key". The id is public (lists, the audit log).
           --name     1-48 characters of a-z 0-9 . _ -, unique among active keys
           --role     game (ingest), lookup (identity:resolve), support (+ players:read), analyst (SQL and the named
                      queries, identity:resolve), admin (everything)
           --expires  1-3650 days: 90d, 365d, 1y (default: never)
  list     every key: id, name, role, scopes, expiry, last use, built-in / revoked; --all includes revoked keys. The env
           tokens (TYPETORCH_API_KEY, ${ADMIN_TOKEN_VAR}, TYPETORCH_LOOKUP_TOKEN) show as built-in (env:*)
  revoke   ends a key at once (it answers 401 from then on). Built-in env:* keys can't be revoked: change the env
           variable on the backend instead`;

/** `--expires 365d | 90d | 1y` as days (1-3650). */
export function parseExpires(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const match = /^(\d+)([dy])$/.exec(value.trim());
	const days = match ? Number(match[1]) * (match[2] === "y" ? 365 : 1) : NaN;
	if (!Number.isSafeInteger(days) || days < 1 || days > EXPIRES_MAX_DAYS) throw new UsageError(`--expires must be 1-${EXPIRES_MAX_DAYS} days written like 90d, 365d or 1y, got "${value}"`);
	return days;
}

export function parseRole(value: string | undefined): ApiKeyRole {
	if (value === undefined || !(API_KEY_ROLES as readonly string[]).includes(value)) throw new UsageError(`--role must be one of ${API_KEY_ROLES.join(", ")}${value === undefined ? "" : `, got "${value}"`}`);
	return value as ApiKeyRole;
}

export function parseKeyName(value: string | undefined): string {
	if (value === undefined || !API_KEY_NAME.test(value)) throw new UsageError(`--name must be 1-48 characters of a-z 0-9 . _ -${value === undefined ? "" : `, got "${value}"`}`);
	return value;
}

/** A revoke target: a key id, never a whole key (that one is scrubbed and refused) or a built-in env:* id. */
export function parseRevokeId(value: string | undefined): string {
	if (value === undefined) throw new UsageError("typetorch keys revoke <id> (the id from `typetorch keys list`)");
	if (value.startsWith("ttk_")) {
		registerSecret(value);
		throw new UsageError("that is a whole key, not its id: pass only the id (`typetorch keys list`), and treat the key you pasted as exposed");
	}
	if (value.startsWith("env:")) throw new UsageError(`${value} is a built-in key (an env token on the backend): it can't be revoked; change the variable in the backend's environment and restart it instead`);
	if (!API_KEY_ID.test(value)) throw new UsageError(`"${value}" isn't a key id (10 characters of 0-9 a-z, from \`typetorch keys list\`)`);
	return value;
}

function backendOptions(proj: Project, fetcher?: typeof fetch): BackendRequestOptions {
	const url = proj.config.backend?.url;
	if (!url) throw new Error("typetorch.json has no backend.url: API keys live on the TypeTorch backend (typetorch backend setup)");
	const admin = backendCredentialsWarned().admin;
	if (!admin) throw new Error(`${ADMIN_TOKEN_VAR} isn't set (the game repo's .env or the environment): managing API keys is an admin call`);
	return { url, adminToken: admin.value, fetch: fetcher, timeoutMs: 20_000 };
}

/** A timestamp (ISO text, unix ms or unix seconds) as "YYYY-MM-DD HH:MM" UTC, or the fallback. */
export function when(value: string | number | null, fallback: string): string {
	if (value === null) return fallback;
	const date = typeof value === "number" ? new Date(value < 1e11 ? value * 1000 : value) : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 16).replace("T", " ");
}

export function keyState(key: Pick<ApiKeyInfo, "builtIn" | "revokedAt">): string {
	return key.builtIn ? "built-in" : key.revokedAt !== null ? `revoked ${when(key.revokedAt, "")}` : "active";
}

export interface ApiKeysDeps {
	fetch?: typeof fetch;
}

export async function apiKeysCommand(sub: (typeof API_KEY_SUBCOMMANDS)[number], args: ParsedArgs, deps: ApiKeysDeps = {}) {
	const extra = args.positionals.slice(sub === "revoke" ? 2 : 1);
	if (extra.length) throw new UsageError(`unexpected argument "${extra[0]}"`);
	const misplaced = (flags: string[]) => {
		for (const flag of flags) if (args.flags[flag] !== undefined) throw new UsageError(`--${flag} belongs to \`typetorch keys ${flag === "all" ? "list" : "create"}\``);
	};
	if (sub === "create") {
		misplaced(["all"]);
		const name = parseKeyName(flagString(args, "name"));
		const role = parseRole(flagString(args, "role"));
		const expiresDays = parseExpires(flagString(args, "expires"));
		const proj = project(args);
		const created = await createApiKey(backendOptions(proj, deps.fetch), { name, role, ...(expiresDays !== undefined ? { expiresDays } : {}) });
		if (isJson()) return emitJson(created);
		info(bold(`API key created: ${created.id} "${created.name}", role ${created.role}${created.scopes.length ? ` (${created.scopes.join(", ")})` : ""}, expires ${when(created.expiresAt, "never")}`));
		info("");
		info(`  ${created.key}`);
		info("");
		info(yellow("Store it now: it is not shown again (the backend keeps only its hash). Lost it? Revoke it and create another."));
		return;
	}
	if (sub === "list") {
		misplaced(["name", "role", "expires"]);
		const proj = project(args);
		const keys = await listApiKeys(backendOptions(proj, deps.fetch), flagBool(args, "all"));
		if (isJson()) return emitJson({ keys });
		if (keys.length === 0) {
			info("no API keys (and no built-in env tokens reported)");
			return;
		}
		info(table(["id", "name", "role", "scopes", "expires", "last used", "state"], keys.map((k) => [k.id, k.name || "-", k.role, k.scopes.join(",") || "-", when(k.expiresAt, "never"), when(k.lastUsedAt, "never"), keyState(k)])));
		if (!flagBool(args, "all")) info(dim("  --all also lists revoked keys"));
		return;
	}
	misplaced(["name", "role", "expires", "all"]);
	const id = parseRevokeId(args.positionals[1]);
	const proj = project(args);
	const revoked = await revokeApiKey(backendOptions(proj, deps.fetch), id);
	if (isJson()) return emitJson({ ok: true, id: revoked.id, revokedAt: revoked.revokedAt });
	info(bold(`API key ${revoked.id} revoked${revoked.revokedAt !== null ? ` at ${when(revoked.revokedAt, "")}` : ""}: it answers 401 from now on`));
}
