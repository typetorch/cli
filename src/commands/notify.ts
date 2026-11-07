/**
 * `typetorch notify ...`: experience notifications (plans/29, plans/29-contract.md). The game says WHY a player should
 * hear from it (intents, framework); the backend decides WHEN and WHAT and sends; this command is the owner's side:
 *
 *   push          typetorch.json `notifications` (validated here with the contract's rules, config.ts) to the backend,
 *                 PUT /v1/notify/config with the admin token; the backend validates again (authoritative) and audits
 *   templates     the kinds' template texts for the manual Creator Dashboard step (no API creates templates);
 *                 `templates set <kind> <message_id>` writes the id into typetorch.json
 *   status        GET /v1/notify/status (+ GET /v1/notify/config compared with typetorch.json); halted kinds stand out
 *   test          POST /v1/notify/test { userId, kind, params?, data? }: one send now, bypassing the caps (marked test)
 *   send          POST /v1/notify/send { userId, template, params?, data? }: a one-off (kind custom), within the caps
 *   key rotate    a new launch-data HMAC key: the signed settings record's backend.notify.keys first (both prod
 *                 keys; previous = the record's old current), then PUT /v1/notify/keys (game servers verify, so
 *                 they learn it before the backend signs with it); --backend-only re-sends the record's keys
 *   pause/resume  the backend's runtime setting notify.enabled (PATCH /v1/admin/settings); with a kind,
 *                 notify.kinds.<kind>.enabled (resume re-enables a kind the backend halted)
 *
 * Every call goes to typetorch.json backend.url with TYPETORCH_ADMIN_TOKEN. Nothing here prints or logs a key: the
 * notify key shows only as a fingerprint (the first 8 hex of its SHA-256).
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { flagBool, flagList, flagString, UsageError, type ParsedArgs } from "../args.ts";
import {
	backendCredentialsWarned,
	notifyGetConfig,
	notifyPutConfig,
	notifyPutKeys,
	notifySend,
	notifyStatus,
	notifyTest,
	patchRuntimeSettings,
	type BackendRequestOptions,
	type NotifySendResult,
	type NotifyStatus,
} from "../backend.ts";
import { NOTIFY_KIND_PATTERN, NOTIFY_PARAM_NAME, NOTIFY_TEMPLATE_MAX, templatePlaceholders, validateConfig, type Project } from "../config.ts";
import { ADMIN_TOKEN_VAR, registerSecret } from "../env.ts";
import { setJsonPath } from "../json.ts";
import { DOCS } from "../tui.ts";
import { bold, dim, emitJson, info, isJson, red, warn, yellow } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import { DS_READ_SCOPE } from "../seqstore.ts";
import { readSettings, verifySettingsRecord, type NotifyKeys, type SettingsBody } from "../settings.ts";
import type { DualSigner } from "../signing.ts";
import { KEY_FILE_FLAGS, openCloud, project } from "./common.ts";
import { changeSettings, reportChange, settingsSigner, type ChangeSettingsResult } from "./settings.ts";

export const notifyFlags = { param: "list", data: "string", "dry-run": "boolean", "no-ping": "boolean", "backend-only": "boolean", ...KEY_FILE_FLAGS } as const;

export const NOTIFY_USAGE = `typetorch notify push [--dry-run]
typetorch notify status
typetorch notify templates
typetorch notify templates set <kind> <message_id>
typetorch notify test <userId> <kind> [--param name=value]... [--data <text>]
typetorch notify send <userId> <template> [--param name=value]... [--data <text>]
typetorch notify key rotate [--dry-run] [--no-ping] [--key-file <path>] [--fallback-key-file <path>]
typetorch notify key rotate --backend-only
typetorch notify pause [<kind>]
typetorch notify resume [<kind>]

  Experience notifications (plans/29): the game declares WHY a player should hear from it (\`notify.want\` in the
  framework), the backend decides WHEN and WHAT and sends through Roblox, the framework verifies the tap. All calls go to
  typetorch.json backend.url with ${ADMIN_TOKEN_VAR}.
  push        typetorch.json "notifications" (kinds, caps) to the backend, checked first with the same rules it uses
  templates   each kind's "text" (copy-ready), its {placeholders} and whether it has its "template" id yet, the Creator
              Dashboard link and the steps: Roblox has no API that creates notification strings, so you paste each
              text there once (Engagement -> Notifications) and give the message id back with
  templates set <kind> <message_id>   writes notifications.kinds.<kind>.template into typetorch.json (only that value
              changes in the file); then \`typetorch notify push\`
  status      what the backend has: on / paused, dry run, rate, keys (set or not, never shown), the queue, the last
              24 h, each kind (a kind the backend HALTED for a bad template stands out), and whether the pushed config
              matches typetorch.json
  test        one send of <kind> to <userId> now, bypassing the caps (marked test; dry run still applies)
  send        a one-off with a template id (Creator Dashboard, Engagement -> Notifications) as kind "custom";
              respects Roblox's 1 a day and mutes
  --param name=value  a template placeholder (repeatable, at most 8; names a-z A-Z 0-9 _ -, values at most 64 chars)
  --data <text>       echoed to the game's onOpen when the player taps (at most 64 bytes)
  key rotate  a new launch-data signing key (32 random bytes): signed into the settings record's
              backend.notify.keys first (both prod keys; servers are pinged and verify taps with it), then sent to
              the backend, which signs with it from then on. The old key stays valid as "previous" for 14 days (the
              tap's lifetime). Shown only as a fingerprint. Needs the deploy key's DataStore scopes, like every
              settings write. --no-ping: the backend step waits (servers read the record within about a minute):
              run --backend-only afterwards
  --backend-only  send the settings record's current keys to the backend (after a failed or deferred backend step)
  pause       stop sending (the backend's runtime setting notify.enabled = false; intents still queue). With <kind>:
              notify.kinds.<kind>.enabled = false
  resume      send again (notify.enabled = true); with <kind>, re-enable that kind (also after the backend halted it)
  New backends start in dry run (notify.dryRun, the backend's Settings page): planned and counted, never sent.`;

// Inputs ----------------------------------------------------------------------------------------------------------------

export const NOTIFY_PARAMS_MAX = 8;
export const NOTIFY_PARAM_VALUE_MAX = 64;
export const NOTIFY_DATA_MAX = 64;

/** `--param name=value` (repeatable) as the contract's params: <= 8, names [a-zA-Z0-9_-]{1,32}, values <= 64 chars. */
export function parseParams(values: string[]): Record<string, string> | undefined {
	if (values.length === 0) return undefined;
	if (values.length > NOTIFY_PARAMS_MAX) throw new UsageError(`at most ${NOTIFY_PARAMS_MAX} --param values, got ${values.length}`);
	const params: Record<string, string> = {};
	for (const raw of values) {
		const eq = raw.indexOf("=");
		if (eq <= 0) throw new UsageError(`--param must be name=value, got "${raw}"`);
		const name = raw.slice(0, eq);
		const value = raw.slice(eq + 1);
		if (!NOTIFY_PARAM_NAME.test(name)) throw new UsageError(`--param name "${name}" must be 1-32 characters of a-z A-Z 0-9 _ -`);
		if (name in params) throw new UsageError(`--param ${name} given twice`);
		if ([...value].length > NOTIFY_PARAM_VALUE_MAX) throw new UsageError(`--param ${name}: the value is over ${NOTIFY_PARAM_VALUE_MAX} characters`);
		params[name] = value;
	}
	return params;
}

export function parseData(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > NOTIFY_DATA_MAX) throw new UsageError(`--data is ${bytes} bytes; at most ${NOTIFY_DATA_MAX} (it rides the signed launch data)`);
	return value;
}

export function parseUserId(value: string | undefined): number {
	const id = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) throw new UsageError(`"${value ?? ""}" isn't a Roblox UserId (a positive whole number)`);
	return id;
}

export function parseKind(value: string | undefined): string {
	if (value === undefined || !NOTIFY_KIND_PATTERN.test(value)) throw new UsageError(`"${value ?? ""}" isn't a kind name (1-24 characters of a-z 0-9 _)`);
	return value;
}

/** First 8 hex of the key's SHA-256: enough to tell keys apart, nothing about the key. */
export function keyFingerprintOf(key: string): string {
	return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}

/** A new notify key: base64url (no padding) of 32 random bytes = 43 characters. */
export function newNotifyKey(random: (size: number) => Buffer = randomBytes): string {
	return random(32).toString("base64url");
}

/** JSON with keys sorted at every level (to compare the pushed config with typetorch.json). */
function canonical(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (typeof v === "object" && v !== null) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
		return v;
	};
	return JSON.stringify(sort(value));
}

// The command -------------------------------------------------------------------------------------------------------

export interface NotifyDeps {
	fetch?: typeof fetch;
	oc?: Pick<OpenCloud, "request" | "publishMessage">;
	signer?: DualSigner;
	now?: () => Date;
	/** 32 random bytes (tests pass a fixed source). */
	random?: (size: number) => Buffer;
}

function backendOptions(proj: Project, deps: NotifyDeps): BackendRequestOptions {
	const url = proj.config.backend?.url;
	if (!url) throw new Error("typetorch.json has no backend.url: notifications run on the TypeTorch backend (typetorch backend setup)");
	const admin = backendCredentialsWarned().admin;
	if (!admin) throw new Error(`${ADMIN_TOKEN_VAR} isn't set (the game repo's .env or the environment): the notify commands are admin calls`);
	return { url, adminToken: admin.value, fetch: deps.fetch, timeoutMs: 20_000 };
}

export async function notifyCommand(args: ParsedArgs, deps: NotifyDeps = {}) {
	const [sub, ...rest] = args.positionals;
	const extra = (allowed: number) => {
		if (rest.length > allowed) throw new UsageError(`unexpected argument "${rest[allowed]}"`);
	};
	const noSendFlags = () => {
		if (flagList(args, "param").length || flagString(args, "data") !== undefined) throw new UsageError("--param and --data belong to `notify test` and `notify send`");
	};
	switch (sub) {
		case "push":
			extra(0);
			noSendFlags();
			return notifyPush(args, deps);
		case "templates":
			noSendFlags();
			if (rest[0] === undefined) return notifyTemplates(args);
			if (rest[0] !== "set") throw new UsageError(`unknown notify templates subcommand "${rest[0]}" (set)`);
			extra(3);
			return notifyTemplateSet(args, rest[1], rest[2]);
		case "status":
			extra(0);
			noSendFlags();
			return notifyStatusCommand(args, deps);
		case "test":
		case "send":
			extra(2);
			return notifySendCommand(sub, args, deps);
		case "key":
			if (rest[0] !== "rotate") throw new UsageError(`unknown notify key subcommand "${rest[0] ?? ""}" (rotate)`);
			if (rest.length > 1) throw new UsageError(`unexpected argument "${rest[1]}"`);
			noSendFlags();
			return notifyKeyRotate(args, deps);
		case "pause":
		case "resume":
			extra(1);
			noSendFlags();
			return notifyPause(sub, rest[0] === undefined ? undefined : parseKind(rest[0]), args, deps);
		default:
			throw new UsageError(`unknown notify subcommand "${sub ?? ""}" (push, status, templates, test, send, key rotate, pause, resume)`);
	}
}

/** Where the docs explain kinds (linked from the "how to start" errors). */
export const NOTIFY_KINDS_DOCS = `${DOCS}/guides/notifications.md#kinds`;

/** A kind's minimal declaration: valid as it is, the text to be rewritten. */
export function kindStub(): Record<string, unknown> {
	return { text: "Your message with a {placeholder}", priority: 50, repeat: "daily", send: "preferred_hour" };
}

/** A minimal ready-to-paste `notifications` block with one kind (valid as it is). */
export function notificationsStub(kind: string): Record<string, unknown> {
	return {
		dailyCap: 1,
		quietAfterLeaveMinutes: 120,
		lapse: [
			[14, 7],
			[30, 2],
			[60, 1],
		],
		unopenedBackoff: { after: 5, factor: 0.5, days: 14 },
		kinds: { [kind]: kindStub() },
	};
}

function indent(text: string, by = "  "): string {
	return text
		.split("\n")
		.map((line) => by + line)
		.join("\n");
}

/** The error for a typetorch.json with no `notifications`: how to start, with a block to paste. */
export function noNotificationsError(kind = "my_kind"): Error {
	// Pretty, with number pairs kept on one line ("lapse": [[14, 7], ...]).
	const pretty = JSON.stringify(notificationsStub(kind), null, 2).replace(/\[\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]/g, "[$1, $2]");
	const block = `"notifications": ${pretty.replace(/\[\s*(\[[^\]]*\](?:,\s*\[[^\]]*\])*)\s*\]/g, (_, inner: string) => `[${inner.replace(/,\s*\[/g, ", [")}]`)}`;
	return new Error(
		[
			`typetorch.json has no "notifications" section. Add one to start (a minimal block, valid as it is; rewrite the text):`,
			"",
			indent(block),
			"",
			`Kinds (priority, repeat, send, text and {placeholders}): ${NOTIFY_KINDS_DOCS}`,
		].join("\n"),
	);
}

/** The error for a kind that isn't declared: its stub to paste under notifications.kinds. */
export function unknownKindError(kind: string, declared: string[]): Error {
	const block = `"${kind}": ${JSON.stringify(kindStub())}`;
	return new Error(
		[
			`"${kind}" isn't a kind in typetorch.json (declared: ${declared.join(", ") || "none"}). Add it under "notifications" > "kinds" first:`,
			"",
			indent(block),
			"",
			`Kinds (priority, repeat, send, text and {placeholders}): ${NOTIFY_KINDS_DOCS}`,
		].join("\n"),
	);
}

async function notifyPush(args: ParsedArgs, deps: NotifyDeps) {
	const proj = project(args);
	const config = proj.config.notifications;
	if (!config) throw noNotificationsError();
	const kinds = Object.entries(config.kinds);
	const noTemplate = kinds.filter(([, kind]) => !kind.template).map(([name]) => name);
	if (flagBool(args, "dry-run")) {
		if (isJson()) return emitJson({ dryRun: true, config });
		info(bold(`dry run: would push ${kinds.length} kind${kinds.length === 1 ? "" : "s"} to the backend (PUT /v1/notify/config)`));
		info(JSON.stringify(config, null, 2));
		if (noTemplate.length) info(dim(`  no template (planned, never sent): ${noTemplate.join(", ")}`));
		return;
	}
	const options = backendOptions(proj, deps);
	await notifyPutConfig(options, config);
	if (isJson()) return emitJson({ pushed: true, kinds: kinds.map(([name]) => name) });
	info(bold(`notifications config pushed: ${kinds.length} kind${kinds.length === 1 ? "" : "s"} (${kinds.map(([name]) => name).join(", ") || "none"})`));
	const textOnly = noTemplate.filter((name) => config.kinds[name].text);
	const bare = noTemplate.filter((name) => !config.kinds[name].text);
	if (textOnly.length) warn(`${textOnly.join(", ")} ${textOnly.length === 1 ? "has" : "have"} a text but no template id yet: planned and counted, never sent. Make ${textOnly.length === 1 ? "it" : "them"} in the Creator Dashboard (\`typetorch notify templates\`), then \`notify templates set <kind> <message_id>\` and push again`);
	if (bare.length) warn(`no template for ${bare.join(", ")}: planned and counted, never sent (add a "text", then \`typetorch notify templates\`)`);
	info(dim("  a kind the backend halted for a bad template stays off until `typetorch notify resume <kind>`"));
}

/** The line `notify status` prints when the backend halted ALL sending (e.g. "auth": Roblox refused the Open Cloud key). */
export function haltedAllLine(why: string): string {
	return why === "auth"
		? `ALL SENDING HALTED (auth): Roblox refused the backend's Open Cloud key (401/403). Give the key the scope ${"user.user-notification:write"} (or set OPENCLOUD_NOTIFY_KEY on the backend to one that has it; \`typetorch doctor\` probes it), then turn sending back on (the backend's Notifications page, or \`typetorch notify resume\`). Intents keep queueing meanwhile`
		: `ALL SENDING HALTED (${why}): see the backend's Notifications page and its log; then \`typetorch notify resume\``;
}

/** The lines `notify status` prints for halted kinds: what happened and the way back. */
export function haltedLines(status: Pick<NotifyStatus, "kinds">): string[] {
	return status.kinds
		.filter((kind) => kind.halted)
		.map((kind) =>
			kind.halted === "bad_template"
				? `${kind.kind} is HALTED: Roblox doesn't know its template (404 NOT_FOUND, "message id ... does not exist"); nothing of this kind is sent and its ${kind.pending} pending intent${kind.pending === 1 ? "" : "s"} wait. Fix notifications.kinds.${kind.kind}.template in typetorch.json (the message id from Creator Dashboard, Engagement -> Notifications), run \`typetorch notify push\`, then \`typetorch notify resume ${kind.kind}\``
				: `${kind.kind} is HALTED (${kind.halted}): see the backend's Notifications page; re-enable with \`typetorch notify resume ${kind.kind}\` once fixed`,
		);
}

async function notifyStatusCommand(args: ParsedArgs, deps: NotifyDeps) {
	const proj = project(args);
	const options = backendOptions(proj, deps);
	const status = await notifyStatus(options);
	let pushed: { matches: boolean | null; updatedAt: string | null; by: string | null; error?: string };
	try {
		const remote = await notifyGetConfig(options);
		const local = proj.config.notifications;
		pushed = { matches: remote.config === null ? false : local ? canonical(remote.config) === canonical(local) : null, updatedAt: remote.updatedAt, by: remote.by };
		if (remote.config === null) pushed.matches = local ? false : null;
	} catch (error) {
		pushed = { matches: null, updatedAt: null, by: null, error: (error as Error).message };
	}
	const halted = haltedLines(status);
	if (isJson()) return emitJson({ ...status.raw, config: pushed, haltedAll: status.halted ?? null, haltedKinds: status.kinds.filter((k) => k.halted).map((k) => ({ kind: k.kind, why: k.halted })) });
	if (status.halted) warn(haltedAllLine(status.halted));

	info(bold(`notifications: ${status.enabled ? "on" : red("PAUSED")} (notify.enabled)${status.dryRun ? `, ${yellow("dry run")}: planned and counted, nothing sent to Roblox (notify.dryRun)` : ""}`));
	info(`  rate      ${status.rate ?? "?"} / s, day clock ${status.clock ?? "?"}`);
	info(`  keys      ${status.keys.current ? "set" : red("NOT SET (typetorch notify key rotate)")}${status.keys.current ? `, previous ${status.keys.previous ? "kept" : "none"}` : ""}${status.keys.since ? `, since ${new Date(status.keys.since * 1000).toISOString()}` : ""}`);
	info(`  queue     ${status.queue.pending} pending, ${status.queue.due1h} due within 1 h, ${status.queue.sending} sending`);
	const last429 = status.bucket.last429At === null ? "none" : typeof status.bucket.last429At === "number" ? new Date(status.bucket.last429At * (status.bucket.last429At < 1e12 ? 1000 : 1)).toISOString() : status.bucket.last429At;
	info(`  bucket    rate ${status.bucket.rate ?? "?"} / s, ${status.bucket.tokens ?? "?"} tokens, last 429 ${last429}`);
	info(`  24 h      ${status.sends24h.sent} sent, ${status.sends24h.failed} failed, ${status.sends24h.dry} dry`);
	if (status.kinds.length === 0) info(dim("  no kinds: push the config (typetorch notify push)"));
	else {
		const width = Math.max(...status.kinds.map((kind) => kind.kind.length));
		info("  kinds");
		for (const kind of status.kinds) {
			const state = kind.halted ? red(`HALTED (${kind.halted})`) : kind.enabled ? "on" : yellow("off");
			info(`    ${kind.kind.padEnd(width)}  ${state}  ${kind.template ? "template" : dim("no template (never sent)")}  ${kind.pending} pending`);
		}
	}
	if (pushed.error) warn(`the pushed config wasn't read (${pushed.error})`);
	else if (pushed.matches === true) info(dim(`  pushed config matches typetorch.json${pushed.updatedAt ? ` (${pushed.updatedAt}${pushed.by ? ` by ${pushed.by}` : ""})` : ""}`));
	else if (pushed.matches === false) warn(proj.config.notifications ? "the backend's config differs from typetorch.json (or none was pushed): run `typetorch notify push`" : "the backend holds a config but typetorch.json has no notifications section");
	for (const line of halted) warn(line);
}

async function notifySendCommand(sub: "test" | "send", args: ParsedArgs, deps: NotifyDeps) {
	const [, userArg, what] = args.positionals;
	const userId = parseUserId(userArg);
	if (what === undefined) throw new UsageError(sub === "test" ? "typetorch notify test <userId> <kind>" : "typetorch notify send <userId> <template>");
	const params = parseParams(flagList(args, "param"));
	const data = parseData(flagString(args, "data"));
	if (flagBool(args, "dry-run")) throw new UsageError(`--dry-run isn't for notify ${sub}: the backend's dry run (notify.dryRun) decides whether Roblox is called`);
	const proj = project(args);
	let result: NotifySendResult;
	if (sub === "test") {
		const kind = parseKind(what);
		const declared = proj.config.notifications?.kinds[kind];
		if (proj.config.notifications && !declared) warn(`"${kind}" isn't a kind in typetorch.json: the backend knows only pushed kinds`);
		for (const line of paramMismatch(declared?.text, params)) warn(line);
		result = await notifyTest(backendOptions(proj, deps), { userId, kind, ...(params ? { params } : {}), ...(data !== undefined ? { data } : {}) });
	} else {
		if (what.length < 1 || what.length > NOTIFY_TEMPLATE_MAX) throw new UsageError(`the template must be a message id of 1-${NOTIFY_TEMPLATE_MAX} characters`);
		result = await notifySend(backendOptions(proj, deps), { userId, template: what, ...(params ? { params } : {}), ...(data !== undefined ? { data } : {}) });
	}
	if (isJson()) return emitJson(result);
	if ("skipped" in result) info(yellow(`not sent: ${result.skipped}`));
	else info(bold(`${sub === "test" ? "test" : "one-off"} to ${userId}: ${result.status} (nid ${result.nid})`));
}

/** Params vs a kind's template text (the backend refuses these as missing_param / unknown_param); [] when they match. */
export function paramMismatch(text: string | undefined, params: Record<string, string> | undefined): string[] {
	if (text === undefined) return [];
	const { names } = templatePlaceholders(text);
	const given = Object.keys(params ?? {});
	const missing = names.filter((name) => !given.includes(name));
	const unknown = given.filter((name) => !names.includes(name));
	return [
		...(missing.length ? [`the kind's text needs ${missing.map((n) => `{${n}}`).join(", ")}: pass --param ${missing[0]}=... (the backend refuses it as missing_param)`] : []),
		...(unknown.length ? [`${unknown.join(", ")} ${unknown.length === 1 ? "isn't a placeholder" : "aren't placeholders"} of the kind's text (the backend refuses it as unknown_param)`] : []),
	];
}

// templates -----------------------------------------------------------------------------------------------------------

/**
 * The experience's page in the Creator Dashboard (the same URL pattern as kernelpatch-task's saveSettingUrl). The
 * notifications page sits under it at Engagement -> Notifications; its own path isn't verified, so it isn't linked.
 */
export function dashboardUrl(universeId: number): string {
	return `https://create.roblox.com/dashboard/creations/experiences/${universeId}/overview`;
}

export interface TemplateRow {
	kind: string;
	text: string | null;
	placeholders: string[];
	template: string | null;
}

export function templateRows(proj: Pick<Project, "config">): TemplateRow[] {
	return Object.entries(proj.config.notifications?.kinds ?? {}).map(([kind, config]) => ({
		kind,
		text: config.text ?? null,
		placeholders: config.text ? templatePlaceholders(config.text).names : [],
		template: config.template ?? null,
	}));
}

async function notifyTemplates(args: ParsedArgs) {
	const proj = project(args);
	if (!proj.config.notifications) throw noNotificationsError();
	const rows = templateRows(proj);
	const url = dashboardUrl(proj.config.universeId);
	if (isJson()) return emitJson({ dashboard: url, menu: "Engagement > Notifications", kinds: rows });
	const todo = rows.filter((row) => row.text && !row.template);
	info(bold(`notification templates: ${rows.filter((r) => r.template).length} made, ${todo.length} to make`));
	info("");
	for (const row of rows) {
		const state = row.template ? `template ${row.template}` : row.text ? yellow("no template id yet") : dim("no text and no template id");
		info(`${bold(row.kind)}  ${state}`);
		if (row.text) {
			info("");
			info(row.text);
			info("");
			info(dim(`  placeholders: ${row.placeholders.length ? row.placeholders.map((n) => `{${n}}`).join(" ") : "none"}`));
		} else if (!row.template) info(dim(`  add notifications.kinds.${row.kind}.text to typetorch.json (at most 99 characters, {placeholders})`));
		info("");
	}
	info(bold("Make the missing ones (Roblox has no API for this):"));
	info(`  1. open the experience in the Creator Dashboard: ${url}`);
	info("     then Engagement > Notifications");
	info("  2. create a notification string per kind above: paste its text as it is ({placeholders} included)");
	info("  3. copy the new string's message id, then: typetorch notify templates set <kind> <message_id>");
	info("  4. typetorch notify push");
}

async function notifyTemplateSet(args: ParsedArgs, kindArg: string | undefined, id: string | undefined) {
	const kind = parseKind(kindArg);
	if (id === undefined) throw new UsageError("typetorch notify templates set <kind> <message_id>");
	if (id.length > NOTIFY_TEMPLATE_MAX || !/^[^\s{}"]+$/.test(id)) throw new UsageError(`"${id}" isn't a message id (1-${NOTIFY_TEMPLATE_MAX} characters, no spaces)`);
	const proj = project(args);
	const config = proj.config.notifications;
	if (!config) throw noNotificationsError(kind);
	if (!(kind in config.kinds)) throw unknownKindError(kind, Object.keys(config.kinds));
	const before = config.kinds[kind].template;
	if (before === id) {
		if (isJson()) return emitJson({ kind, template: id, changed: false });
		info(`${kind}: already template ${id}`);
		return;
	}
	const text = readFileSync(proj.configPath, "utf8");
	const next = setJsonPath(text, ["notifications", "kinds", kind, "template"], id);
	const checked = validateConfig(JSON.parse(next));
	if (!checked.config) throw new Error(`refusing to write an invalid ${proj.configPath}:\n  - ${checked.errors.join("\n  - ")}`);
	writeFileSync(proj.configPath, next);
	proj.config = checked.config;
	if (isJson()) return emitJson({ kind, template: id, previous: before ?? null, changed: true });
	info(bold(`${kind}: template ${id}${before ? ` (was ${before})` : ""} written to typetorch.json`));
	info(dim("  then: typetorch notify push (a kind the backend halted for its template also needs `typetorch notify resume " + kind + "`)"));
}

async function notifyPause(sub: "pause" | "resume", kind: string | undefined, args: ParsedArgs, deps: NotifyDeps) {
	if (flagBool(args, "dry-run")) throw new UsageError(`--dry-run isn't for notify ${sub}`);
	const proj = project(args);
	const key = kind === undefined ? "notify.enabled" : `notify.kinds.${kind}.enabled`;
	const value = sub === "resume";
	const result = await patchRuntimeSettings(backendOptions(proj, deps), { [key]: value });
	if (isJson()) return emitJson({ setting: key, value, changed: result.changed.includes(key) });
	const what = kind === undefined ? "notifications" : `kind ${kind}`;
	if (result.changed.includes(key)) info(bold(`${what} ${value ? "resumed" : "paused"} (${key} = ${value})`));
	else info(`${what}: already ${value ? "on" : "paused"} (${key} = ${value})`);
	if (!value) info(dim("  intents keep queueing; `typetorch notify resume" + (kind ? ` ${kind}` : "") + "` sends again"));
}

// key rotate ----------------------------------------------------------------------------------------------------------

export interface RotateResult {
	dryRun: boolean;
	/** Fingerprints only. */
	current: string;
	previous: string | null;
	since: number;
	/** The previous key that this rotation drops while tokens signed with it may still be tapped (rotated under 14 days ago). */
	droppedRecent: boolean;
	write?: ChangeSettingsResult;
	/** The backend got the keys (PUT /v1/notify/keys). False with --no-ping (sent later with --backend-only) or on a failure. */
	backend: "sent" | "deferred" | "failed";
	/** Why the backend step failed (no secret in it). */
	backendError?: string;
}

/** How long the previous key stays valid after a rotation: the launch token's lifetime (14 days). */
export const PREVIOUS_GRACE_SECONDS = 14 * 86_400;

const BACKEND_ONLY_HINT = "typetorch notify key rotate --backend-only";

interface RotateInput {
	proj: Project;
	oc: Pick<OpenCloud, "request" | "publishMessage">;
	signer: DualSigner;
	backend: BackendRequestOptions;
	dryRun?: boolean;
	noPing?: boolean;
	now?: () => Date;
	random?: (size: number) => Buffer;
	fetch?: typeof fetch;
}

/** The settings record, read and verified with your keys, with its backend section (else an error naming the fix). */
async function verifiedRecord(input: Pick<RotateInput, "proj" | "oc" | "signer">, what: string) {
	const read = await readSettings(input.oc, input.proj.config.universeId);
	if (read.scopeMissing) throw new Error(`can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${read.error})`);
	if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
	if (read.problem) throw new Error(`the settings record isn't usable (${read.problem}): rewrite it first (typetorch settings push --force); nothing was ${what}`);
	if (!read.record || !read.body?.backend) throw new Error(`the settings record has no backend section: run \`typetorch backend setup\` first (game servers read the notify key next to the backend's address); nothing was ${what}`);
	if (!verifySettingsRecord(read.record, { main: input.signer.main.publicKey, fallback: input.signer.fallback.publicKey })) {
		throw new Error(`the settings record isn't signed by your keys, so it can't be trusted or re-signed; fix that first (typetorch settings status); nothing was ${what}`);
	}
	const keys = read.body.backend.notify?.keys;
	if (keys?.current) registerSecret(keys.current);
	if (keys?.previous) registerSecret(keys.previous);
	return { read, keys };
}

/**
 * The rotation, in the contract's order (plans/29-contract.md "Review fixes"): game servers are the only verifiers, so
 * they learn the key first. 1. the settings record's backend.notify.keys = { current: new, previous: the record's old
 * current, since } (every other field kept; the record is read and verified with your keys first), 2. PUT
 * /v1/notify/keys with the same keys, so the backend starts signing with the new key only once servers can verify it.
 * With --no-ping the backend step is left for `--backend-only` (servers read the record within about a minute). A
 * failed backend step leaves a safe state: servers accept both keys and the backend keeps signing with the old one
 * (now `previous`). The new key is registered with the scrubber and never returned.
 */
export async function rotateNotifyKey(input: RotateInput): Promise<RotateResult> {
	const { proj } = input;
	const { keys: old } = await verifiedRecord(input, "rotated");
	const now = (input.now ?? (() => new Date()))();
	const since = Math.floor(now.getTime() / 1000);
	const droppedRecent = Boolean(old?.previous && typeof old.since === "number" && since - old.since < PREVIOUS_GRACE_SECONDS);
	const previous = old?.current ? keyFingerprintOf(old.current) : null;
	if (input.dryRun) return { dryRun: true, current: "(new)", previous, since, droppedRecent, backend: "deferred" };

	const current = newNotifyKey(input.random);
	registerSecret(current);
	const keys: NotifyKeys = { current, ...(old?.current ? { previous: old.current } : {}), since };

	// 1. The record (game servers verify): a record whose notify key moved since the read (another machine rotated) is
	// left alone.
	let moved = false;
	const mutate = (body: SettingsBody): SettingsBody | undefined => {
		moved = !body.backend || (body.backend.notify?.keys?.current ?? undefined) !== (old?.current ?? undefined);
		return moved ? undefined : { ...body, backend: { ...body.backend!, notify: { keys } } };
	};
	const write = await changeSettings({ proj, oc: input.oc, signer: input.signer, mutate, what: "notify key rotate", noPing: input.noPing, now: input.now, fetch: input.fetch });
	if (moved) throw new Error("the settings record's notify key changed while rotating (another machine rotated it); nothing was changed here. Check `typetorch notify status`, then rotate again if needed");
	const result: RotateResult = { dryRun: false, current: keyFingerprintOf(current), previous, since, droppedRecent, write, backend: "deferred" };
	if (input.noPing) return result;

	// 2. The backend: it signs with the new key from now on.
	try {
		await notifyPutKeys(input.backend, keys);
		result.backend = "sent";
	} catch (error) {
		result.backend = "failed";
		result.backendError = (error as Error).message;
	}
	return result;
}

/** `--backend-only`: the record's keys (read and verified) to the backend, e.g. after a failed or deferred backend step. */
export async function sendRecordKeys(input: Pick<RotateInput, "proj" | "oc" | "signer" | "backend">): Promise<{ current: string; previous: string | null; since: number }> {
	const { keys } = await verifiedRecord(input, "sent");
	if (!keys?.current || typeof keys.since !== "number") throw new Error("the settings record holds no notify key yet: run `typetorch notify key rotate`");
	await notifyPutKeys(input.backend, keys);
	return { current: keyFingerprintOf(keys.current), previous: keys.previous ? keyFingerprintOf(keys.previous) : null, since: keys.since };
}

async function notifyKeyRotate(args: ParsedArgs, deps: NotifyDeps) {
	const proj = project(args);
	const dryRun = flagBool(args, "dry-run");
	const backend = backendOptions(proj, deps);
	const oc = deps.oc ?? openCloud("deploy")!;
	const signer = deps.signer ?? settingsSigner(proj, args);
	if (flagBool(args, "backend-only")) {
		if (dryRun || flagBool(args, "no-ping")) throw new UsageError("--backend-only takes no --dry-run or --no-ping");
		const sent = await sendRecordKeys({ proj, oc, signer, backend });
		if (isJson()) return emitJson({ backendOnly: true, current: sent.current, previous: sent.previous, since: sent.since });
		info(bold(`backend: notify keys from the settings record stored (current ${sent.current}${sent.previous ? `, previous ${sent.previous}` : ""}); it signs with ${sent.current} from now on`));
		return;
	}
	const result = await rotateNotifyKey({ proj, oc, signer, backend, dryRun, noPing: flagBool(args, "no-ping"), now: deps.now, random: deps.random, fetch: deps.fetch });
	if (isJson()) {
		return emitJson({
			dryRun: result.dryRun,
			current: result.current,
			previous: result.previous,
			since: result.since,
			droppedRecentPrevious: result.droppedRecent,
			seq: result.write?.seq ?? null,
			outcome: result.write?.outcome ?? null,
			backend: result.backend,
			...(result.backendError ? { backendError: result.backendError } : {}),
		});
	}
	if (result.droppedRecent) warn("the previous key was rotated in under 14 days and is dropped now: taps on notifications signed with it fail as \"sig\"");
	if (result.dryRun) {
		info(bold(`dry run: would make a new notify key, sign it into the settings record (previous = ${result.previous ?? "none"}), ping servers, then send it to the backend (PUT /v1/notify/keys)`));
		return;
	}
	info(bold(`notify key rotated: current ${result.current}${result.previous ? `, previous ${result.previous} (accepted for 14 days)` : ""} (SHA-256 fingerprints; the keys are never shown)`));
	reportChange(result.write!, "settings backend.notify.keys");
	if (result.backend === "sent") info(dim("  backend: stored (PUT /v1/notify/keys); it signs with the new key from now on"));
	else if (result.backend === "deferred") {
		warn(`--no-ping: servers pick up the new key on their next settings read (within about a minute). The backend still signs with the old key, which servers keep accepting as previous; after that minute run \`${BACKEND_ONLY_HINT}\``);
	} else {
		warn(`the backend didn't take the new key (${result.backendError}). Safe for now: servers accept both keys and the backend keeps signing with the old one (now previous, valid 14 days). Fix the cause and run \`${BACKEND_ONLY_HINT}\` (it sends the record's keys)`);
		process.exitCode = 1;
	}
}
