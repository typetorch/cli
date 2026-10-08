/**
 * `typetorch access push`: typetorch.json's members, revoked and devBadgeId into the signed settings record's `access`
 * (kernel 0.3.8, plans/20; settings.ts), signed with both prod keys, then a ping so servers apply it within seconds;
 * `typetorch access status`: what the record holds (read back) vs typetorch.json. Before CLI 0.8 this wrote the
 * ConfigService key TypeTorchAccess blind (API keys can't read configs).
 */
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import { accessHash, accessStatus, accessValue, accessWarning, describeAccess, writeAccessRecord, type AccessStatus, type AccessValue } from "../access.ts";
import type { Project } from "../config.ts";
import { bold, dim, emitJson, info, isJson, warn } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import { readSettings } from "../settings.ts";
import type { DualSigner } from "../signing.ts";
import { KEY_FILE_FLAGS, openCloud, project, projectStateDir } from "./common.ts";
import { changeSettings, reportChange, settingsSigner, type ChangeSettingsResult } from "./settings.ts";

export const accessFlags = { "dry-run": "boolean", "no-ping": "boolean", ...KEY_FILE_FLAGS } as const;

export const ACCESS_USAGE = `typetorch access push [--dry-run] [--no-ping] [--key-file <path>] [--fallback-key-file <path>]
typetorch access status

  Dev access (who may use the dev menu and /tt) comes from typetorch.json: "members" (userId -> owner | dev), "revoked"
  and "devBadgeId". Servers (kernel 0.3.8+) read them from the signed settings record's \`access\` field, which only the
  CLI can write: it is signed with both prod keys, so game code (which can write DataStores) can't make itself a dev.
  push     write the lists into the settings record (signed, seq + 1) and ping servers: they apply it within seconds.
           Then the owners go to the backend (PUT /v1/access with TYPETORCH_ADMIN_TOKEN): only they may Sign in with
           Roblox there. Run it again to re-send them when the backend lost its copy (doctor compares both).
           .typetorch/access.json remembers a hash of what was pushed, so deploy and doctor warn when typetorch.json
           changed since.
  status   the record's lists (read back) vs typetorch.json
  --dry-run  show the lists and stop
  Needs both signing keys (\`typetorch keys init\`) and the deploy key's DataStore read/create/update scopes.`;

export interface PushAccessInput {
	proj: Project;
	oc: Pick<OpenCloud, "request" | "publishMessage">;
	signer: DualSigner;
	dryRun: boolean;
	noPing?: boolean;
	now?: () => Date;
	/** The owner-list PUT to the backend (tests pass a fake). */
	fetch?: typeof fetch;
}

export interface PushAccessResult {
	status: AccessStatus;
	dryRun: boolean;
	write?: ChangeSettingsResult;
}

/** Writes `access` into the settings record and records the hash. The lists are ids and roles, shown in full. */
export async function pushAccess(input: PushAccessInput): Promise<PushAccessResult> {
	const { proj } = input;
	const dir = projectStateDir(proj);
	const status = accessStatus(proj.config, dir);
	if (input.dryRun) return { status, dryRun: true };
	const value = status.value;
	const write = await changeSettings({
		proj,
		oc: input.oc,
		signer: input.signer,
		what: "access push",
		noPing: input.noPing,
		fetch: input.fetch,
		now: input.now,
		mutate: (body) => ({ ...body, access: { members: value.members, revoked: value.revoked, devBadgeId: value.devBadgeId } }),
	});
	const record = { v: 1 as const, universeId: proj.config.universeId, sha256: status.sha256, at: (input.now ?? (() => new Date()))().toISOString(), ...(write.seq !== undefined ? { settingsSeq: write.seq } : {}) };
	writeAccessRecord(dir, record);
	return { status: accessStatus(proj.config, dir), dryRun: false, write };
}

/** The record's access lists as an AccessValue (for a hash compare), or undefined when it has none. */
function storedAccess(raw: unknown): AccessValue | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as { members?: Record<string, "owner" | "dev">; revoked?: Record<string, true>; devBadgeId?: number | null };
	return accessValue({ members: value.members ?? {}, revoked: value.revoked ?? {}, devBadgeId: value.devBadgeId ?? null });
}

export async function accessCommand(args: ParsedArgs, deps: { oc?: Pick<OpenCloud, "request" | "publishMessage">; signer?: DualSigner; fetch?: typeof fetch } = {}) {
	const [sub, extra] = args.positionals;
	if (sub !== "push" && sub !== "status") throw new UsageError(`unknown access subcommand "${sub ?? ""}" (push, status)`);
	if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
	const proj = project(args);
	if (sub === "status") {
		const status = accessStatus(proj.config, projectStateDir(proj));
		const oc = deps.oc ?? openCloud("deploy", true);
		const read = oc ? await readSettings(oc, proj.config.universeId) : undefined;
		const stored = storedAccess(read?.body?.access);
		const matches = stored !== undefined ? accessHash(stored) === status.sha256 : undefined;
		if (isJson()) {
			return emitJson({ value: status.value, sha256: status.sha256, configured: status.configured, settingsSeq: read?.record?.seq ?? null, stored: stored ?? null, matches: matches ?? null, readError: read?.error ?? null });
		}
		info(`typetorch.json: ${describeAccess(status.value)}`);
		if (!read || read.error) {
			warn(`the settings record wasn't read (${read?.error ?? "no deploy key"}); showing what this machine last pushed`);
			const note = accessWarning(status);
			if (note) warn(note);
			else if (status.record) info(dim(`  pushed ${status.record.at}; matches typetorch.json`));
			return;
		}
		if (!stored) {
			if (status.configured) warn("the settings record holds no dev lists: run `typetorch access push` (until then only the experience creator is a dev)");
			else info(dim("  nothing to push: typetorch.json lists no members, revoked users or dev badge (only the creator is a dev)"));
			return;
		}
		info(`settings #${read.record?.seq}: ${describeAccess(stored)}`);
		if (matches) info(dim("  matches typetorch.json"));
		else warn("the settings record's lists differ from typetorch.json: run `typetorch access push`");
		return;
	}
	const dryRun = flagBool(args, "dry-run");
	const status = accessStatus(proj.config, projectStateDir(proj));
	if (!status.configured && !dryRun) {
		warn("typetorch.json lists no members, revoked users or dev badge: writing empty lists (only the experience creator is a dev)");
	}
	if (dryRun) {
		if (isJson()) return emitJson({ dryRun: true, field: "access", value: status.value });
		info(bold(`dry run: would write settings.access = ${JSON.stringify({ members: status.value.members, revoked: status.value.revoked, devBadgeId: status.value.devBadgeId })} and ping servers`));
		return;
	}
	const signer = deps.signer ?? settingsSigner(proj, args);
	const result = await pushAccess({ proj, oc: deps.oc ?? openCloud("deploy")!, signer, dryRun: false, noPing: flagBool(args, "no-ping"), fetch: deps.fetch });
	if (isJson()) return emitJson({ field: "access", value: result.status.value, sha256: result.status.sha256, settingsSeq: result.write?.seq ?? null, outcome: result.write?.outcome ?? null, owners: result.write?.owners ?? null });
	reportChange(result.write!, `access push (${describeAccess(result.status.value)})`);
}
