/**
 * Checks of the endpoints that go into the signed settings record (`settings.fleet`, `settings.analytics`), run BEFORE
 * anything is signed or written (`typetorch fleet setup`, `typetorch settings set analytics`) and again against the live
 * record by `typetorch doctor`. A record with a wrong URL or token isn't rejected by anything else: kernel 0.3.8 signs
 * nothing about it, game servers just fail every request (HttpService "NetFail", HTTP 401/530) and nobody notices until
 * the dev menu turns yellow. Three steps per endpoint, each reported pass/fail with a fix hint:
 *
 *   url      parses; https (the kernel's Fleet module and Roblox game servers only use https; analytics also takes http on
 *            localhost for Studio); no credentials in it; only the characters the kernel accepts; the base address (fleet) or
 *            `.../v1/ingest` (DuckDB analytics); a token of a usable shape
 *   healthz  GET <base>/healthz answers 200 `{ ok: true }` within 5 s (a dead quick tunnel, a stopped server, a wrong host)
 *   token    GET <base>/v1/auth/check with the token (analytics server: no side effects) says it is an INGEST token, valid for
 *            the part (fleet / analytics); the ADMIN token is refused (it would sit in a record every server script can
 *            read). Older servers without that route: GET /v1/settings (also read-only) proves the token is accepted.
 *
 * Basin analytics has no /healthz and no documented side-effect-free authenticated call, so there the stream URLs must
 * answer any HTTP status and a 401/403 for the token is a failure; whether the token is right is otherwise unknown.
 *
 * Nothing here prints or returns a token (error text is scrubbed). Redirects aren't followed (the token would travel).
 * Uses only fetch, so it runs under Node 20+ and Bun.
 */
import { fleetUrlError } from "./config.ts";
import { registerSecret } from "./env.ts";
import { fleetHint, fleetNetworkHint, INGEST_TOKEN_HINT, LOCAL_FLEET_HINT, shortBody } from "./httphints.ts";
import { dim, green, info, red, warn } from "./log.ts";

export const CHECK_TIMEOUT_MS = 5000;
/** The kernel's Fleet module (kernel/src/server/Fleet.luau parseSettings): `^https://[%w%.%-]+[%w:%-%./_]*$`, at most 300. */
const KERNEL_FLEET_URL = /^https:\/\/[A-Za-z0-9.-]+[A-Za-z0-9:\-./_]*$/;
const KERNEL_FLEET_URL_MAX = 300;
/** The kernel's token rule: 8-1000 visible characters. */
const FLEET_TOKEN_MIN = 8;
const FLEET_TOKEN_MAX = 1000;
const ANALYTICS_TOKEN_MAX = 4096;
export const INGEST_PATH = "/v1/ingest";

export type EndpointTarget = "fleet" | "analytics";
export type StepName = "url" | "healthz" | "token";

export interface EndpointStep {
	step: StepName;
	ok: boolean;
	/** Not run (an earlier step failed, or nothing can be checked): not a failure by itself. */
	skipped?: boolean;
	detail: string;
	/** How to fix it (failures only). */
	hint?: string;
	ms?: number;
}

export interface EndpointReport {
	target: EndpointTarget;
	/** host[:port] the checks went to, when the URL parsed. */
	host?: string;
	steps: EndpointStep[];
	/** Every step passed or was skipped without an earlier failure. */
	ok: boolean;
}

export interface EndpointOptions {
	/** Tests pass a fake. */
	fetch?: typeof fetch;
	/** Per request, default 5 s. */
	timeoutMs?: number;
}

export interface FleetEndpointInput extends EndpointOptions {
	url: unknown;
	token: unknown;
	/**
	 * true (default): the rules for settings.fleet (kernel Fleet.luau: https only). false: typetorch.json `fleet.url`,
	 * which the CLI itself reads, so http on localhost is fine.
	 */
	kernelRules?: boolean;
}

// Small helpers ---------------------------------------------------------------------------------------------------------

const pass = (step: StepName, detail: string, ms?: number): EndpointStep => ({ step, ok: true, detail, ...(ms !== undefined ? { ms } : {}) });
const fail = (step: StepName, detail: string, hint?: string, ms?: number): EndpointStep => ({ step, ok: false, detail, ...(hint ? { hint } : {}), ...(ms !== undefined ? { ms } : {}) });
const skip = (step: StepName, detail: string): EndpointStep => ({ step, ok: true, skipped: true, detail });

const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

function reportOf(target: EndpointTarget, steps: EndpointStep[], host?: string): EndpointReport {
	return { target, ...(host ? { host } : {}), steps, ok: steps.every((s) => s.ok) };
}

function short(value: unknown, max = 60): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "(missing)");
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** `text` without the token (error messages and response bodies). */
function scrub(text: string, token: string | undefined): string {
	return token && token.length >= 4 ? text.split(token).join("<token>") : text;
}

// One GET ---------------------------------------------------------------------------------------------------------------

interface Reply {
	status: number;
	text: string;
	ms: number;
	location?: string;
}
type Outcome = { reply: Reply; error?: undefined } | { reply?: undefined; error: Error; timedOut: boolean; ms: number };

async function get(doFetch: typeof fetch, url: string, token: string | undefined, timeoutMs: number): Promise<Outcome> {
	const started = performance.now();
	try {
		const response = await doFetch(url, {
			method: "GET",
			headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			// A redirect would carry the token to wherever it points: report it instead.
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = (await response.text()).slice(0, 4000);
		return { reply: { status: response.status, text, ms: Math.round(performance.now() - started), location: response.headers.get("location") ?? undefined } };
	} catch (error) {
		const err = error as Error;
		return { error: err, timedOut: err.name === "TimeoutError" || err.name === "AbortError", ms: Math.round(performance.now() - started) };
	}
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** A failed request (no answer, a redirect, an error status) as a step, or undefined when it answered 2xx. */
function failedRequest(step: StepName, what: string, host: string, outcome: Outcome, timeoutMs: number, token?: string): EndpointStep | undefined {
	if (outcome.error) {
		const message = scrub(outcome.error.message, token);
		if (outcome.timedOut) return fail(step, `${what} didn't answer within ${timeoutMs / 1000} s`, `check that the server and its tunnel are running (a tunnel that just started can take a minute); ${LOCAL_FLEET_HINT}`, outcome.ms);
		const hint = fleetNetworkHint(outcome.error, host) ?? `check the URL and that the server is running; ${LOCAL_FLEET_HINT}`;
		const code = (outcome.error as { cause?: { code?: string } }).cause?.code;
		return fail(step, `${what} didn't answer (${code ?? message})`, hint, outcome.ms);
	}
	const { status, text, location } = outcome.reply;
	if (status >= 300 && status < 400) {
		let target = location ?? "somewhere else";
		try {
			if (location) target = new URL(location, `https://${host}`).host;
		} catch {}
		return fail(step, `${what} redirects (${status}) to ${target}`, `use the final address directly (${location ? short(location, 80) : "see the Location header"}): game servers must not depend on a redirect, and the CLI won't send the token through one`, outcome.reply.ms);
	}
	if (status >= 200 && status < 300) return undefined;
	if (step === "healthz" && (status === 401 || status === 403)) {
		return fail(step, `${what} answered HTTP ${status}, but /healthz is public on the analytics server`, "something in front of it (Cloudflare Access, a proxy login) blocks game servers too: take that off this address", outcome.reply.ms);
	}
	const hint = fleetHint(status, text, host);
	return fail(step, `${what} answered HTTP ${status}${hint ? "" : ` ${shortBody(scrub(text, token))}`}`, hint ?? defaultStatusHint(status), outcome.reply.ms);
}

function defaultStatusHint(status: number): string | undefined {
	if (status === 401 || status === 403) return undefined;
	if (status === 404) return "that URL isn't the TypeTorch analytics server (wrong host or path)";
	if (status >= 500) return "the server is failing: check its log";
	return undefined;
}

// Steps -----------------------------------------------------------------------------------------------------------------

function fleetUrlStep(value: unknown, kernelRules: boolean): { step: EndpointStep; base?: string; host?: string } {
	const problem = fleetUrlError(value);
	if (problem) {
		const loopbackHttp = typeof value === "string" && /^http:\/\/(localhost|127\.0\.0\.1)/i.test(value);
		return {
			step: fail("url", `${short(value, 80)} ${problem}`, loopbackHttp ? undefined : "use the fleet API's public https address, e.g. the https://*.trycloudflare.com URL `bun run local` prints, or https://fleet.<your domain> on a VPS"),
		};
	}
	const text = value as string;
	const url = new URL(text);
	const host = url.host;
	if (url.search || url.hash) return { step: fail("url", `${short(text, 80)} has a query or fragment`, "give the base address only: https://host[:port]"), host };
	if (/\/v1(\/|$)/.test(url.pathname)) {
		return { step: fail("url", `${short(text, 80)} is an endpoint path, not the base address`, "give the server's base address (https://host): game servers add /v1/fleet/heartbeat and the other paths themselves"), host };
	}
	if (url.protocol === "http:") {
		if (kernelRules) {
			return {
				step: fail("url", `${short(text, 80)} is http: the kernel's Fleet module only accepts https URLs, so game servers would ignore it (and can't reach ${url.hostname} anyway)`, `use the https:// address of the server or its tunnel; ${LOCAL_FLEET_HINT}`),
				host,
			};
		}
		return { step: pass("url", `${host} over http (loopback: fine for this PC's CLI; game servers can't reach it)`), base: text.replace(/\/+$/, ""), host };
	}
	if (kernelRules && (text.length > KERNEL_FLEET_URL_MAX || !KERNEL_FLEET_URL.test(text))) {
		return {
			step: fail("url", `${short(text, 80)} has characters the kernel rejects (it accepts https://host[:port][/path] with letters, digits and . : - / _; at most ${KERNEL_FLEET_URL_MAX})`, "use the plain address, without query, spaces or user info"),
			host,
		};
	}
	return { step: pass("url", `${host} over https`), base: text.replace(/\/+$/, ""), host };
}

function fleetTokenShape(token: unknown): string | undefined {
	if (typeof token !== "string" || token === "") return "no token";
	if (/[\s\u0000-\u001f]/.test(token)) return "the token contains spaces or control characters (copy it again without the line break)";
	if (token.length < FLEET_TOKEN_MIN) return `the token is ${token.length} characters; the kernel wants ${FLEET_TOKEN_MIN} to ${FLEET_TOKEN_MAX}`;
	if (token.length > FLEET_TOKEN_MAX) return `the token is over ${FLEET_TOKEN_MAX} characters`;
	return undefined;
}

/** GET <base>/healthz: 200 and `{ ok: true }`. */
async function healthzStep(doFetch: typeof fetch, base: string, host: string, timeoutMs: number, token?: string): Promise<EndpointStep> {
	const outcome = await get(doFetch, `${base}/healthz`, undefined, timeoutMs);
	// The token isn't sent here; it only scrubs what a confused server might echo.
	const failed = failedRequest("healthz", `${host}/healthz`, host, outcome, timeoutMs, token);
	if (failed) return failed;
	const reply = outcome.reply!;
	const body = parseJson(reply.text);
	if (body?.ok !== true) {
		return fail("healthz", `${host}/healthz answered ${reply.status} but not {"ok":true}: ${shortBody(scrub(reply.text, token), 80)}`, `that address isn't the TypeTorch analytics server (a tunnel pointing at something else, or a wrong port); ${LOCAL_FLEET_HINT}`, reply.ms);
	}
	return pass("healthz", `${host} answered in ${reply.ms} ms`, reply.ms);
}

const PART_OFF = (part: EndpointTarget) =>
	`the server runs without its ${part === "fleet" ? "fleet" : "analytics"} part: set TT_SERVER_PARTS=analytics,fleet in its env file and restart it`;

/** GET <base>/v1/auth/check with the token (older servers: /v1/settings). */
async function tokenStep(doFetch: typeof fetch, base: string, host: string, token: string, part: EndpointTarget, timeoutMs: number): Promise<EndpointStep> {
	const outcome = await get(doFetch, `${base}/v1/auth/check`, token, timeoutMs);
	if (outcome.reply?.status === 404) return legacyTokenStep(doFetch, base, host, token, timeoutMs);
	if (outcome.reply && (outcome.reply.status === 401 || outcome.reply.status === 403)) {
		return fail("token", `the server refused the token (HTTP ${outcome.reply.status})`, INGEST_TOKEN_HINT(part), outcome.reply.ms);
	}
	if (outcome.reply?.status === 429) return fail("token", "the server is rate-limiting this client (HTTP 429)", "wait a minute and run it again");
	const failed = failedRequest("token", `${host}/v1/auth/check`, host, outcome, timeoutMs, token);
	if (failed) return failed;
	const reply = outcome.reply!;
	const body = parseJson(reply.text);
	if (!body || body.ok !== true || typeof body.role !== "string") {
		return fail("token", `${host}/v1/auth/check answered something unexpected: ${shortBody(scrub(reply.text, token), 80)}`, "update the analytics server (this check needs /v1/auth/check), or check the URL points at it", reply.ms);
	}
	if (body.role === "admin") {
		return fail(
			"token",
			"this is the server's ADMIN token (it reads everything), not an ingest token",
			`the settings record is readable by every script in your game, so it must only hold a write-only token. ${INGEST_TOKEN_HINT(part)}`,
			reply.ms,
		);
	}
	const valid = typeof body.valid === "object" && body.valid !== null ? (body.valid as Record<string, unknown>) : {};
	if (valid[part] !== true) return fail("token", `the token is accepted, but not for the ${part} part`, PART_OFF(part), reply.ms);
	return pass("token", `accepted as an ingest (write-only) token, valid for ${part}`, reply.ms);
}

/** Servers before /v1/auth/check: GET /v1/settings takes an ingest or admin token and changes nothing. */
async function legacyTokenStep(doFetch: typeof fetch, base: string, host: string, token: string, timeoutMs: number): Promise<EndpointStep> {
	const outcome = await get(doFetch, `${base}/v1/settings`, token, timeoutMs);
	if (outcome.reply && (outcome.reply.status === 401 || outcome.reply.status === 403)) {
		return fail("token", `the server refused the token (HTTP ${outcome.reply.status})`, INGEST_TOKEN_HINT("analytics"), outcome.reply.ms);
	}
	if (outcome.reply?.status === 404) return fail("token", `${host} has neither /v1/auth/check nor /v1/settings`, "that address isn't the TypeTorch analytics server (or it is too old): check the URL, or update the server", outcome.reply.ms);
	const failed = failedRequest("token", `${host}/v1/settings`, host, outcome, timeoutMs, token);
	if (failed) return failed;
	return pass("token", "accepted (an older server without /v1/auth/check: checked through /v1/settings, which can't tell an ingest token from the admin token; update the server for the full check)", outcome.reply!.ms);
}

// Fleet -----------------------------------------------------------------------------------------------------------------

/** The checks for `settings.fleet` = { url, token } (or typetorch.json `fleet.url` with `kernelRules: false`). */
export async function checkFleetEndpoint(input: FleetEndpointInput): Promise<EndpointReport> {
	const doFetch = input.fetch ?? fetch;
	const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS;
	const token = typeof input.token === "string" ? input.token : undefined;
	if (token) registerSecret(token);
	const kernelRules = input.kernelRules ?? true;
	const { step: url, base, host } = fleetUrlStep(input.url, kernelRules);
	const steps: EndpointStep[] = [url];
	if (!url.ok || !base || !host) {
		steps.push(skip("healthz", "not checked: the URL is not usable"), skip("token", "not checked: the URL is not usable"));
		return reportOf("fleet", steps, host);
	}
	const healthz = await healthzStep(doFetch, base, host, timeoutMs, token);
	steps.push(healthz);
	if (!healthz.ok) {
		steps.push(skip("token", "not checked: the server didn't answer"));
		return reportOf("fleet", steps, host);
	}
	if (token === undefined && !kernelRules) {
		steps.push(skip("token", "no token given"));
		return reportOf("fleet", steps, host);
	}
	const shape = kernelRules ? fleetTokenShape(token) : undefined;
	if (shape) {
		steps.push(fail("token", shape, INGEST_TOKEN_HINT("fleet")));
		return reportOf("fleet", steps, host);
	}
	steps.push(await tokenStep(doFetch, base, host, token as string, "fleet", timeoutMs));
	return reportOf("fleet", steps, host);
}

// Analytics -------------------------------------------------------------------------------------------------------------

function analyticsUrl(value: unknown, field: string, allowHttpLoopback: boolean): { url?: URL; problem?: string } {
	if (typeof value !== "string" || value === "" || value.length > 2048) return { problem: `${field} must be a URL` };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { problem: `${field} ${short(value, 80)} isn't a URL` };
	}
	if (url.protocol !== "https:" && !(allowHttpLoopback && url.protocol === "http:" && isLoopback(url))) {
		return { problem: `${field} ${short(value, 80)} must be https (Roblox game servers only reach https endpoints)` };
	}
	if (url.username || url.password) return { problem: `${field} must not hold credentials (put the token in "token")` };
	if (/\s/.test(value)) return { problem: `${field} contains spaces` };
	return { url };
}

/**
 * The checks for the `analytics` settings value: { backend: "duckdb" | "basin", events, recordings?, token?, identity? ... }.
 * The shape is validated here only as far as the endpoint goes (analytics' own validateSettings checks the dials).
 */
export async function checkAnalyticsEndpoint(settings: unknown, options: EndpointOptions = {}): Promise<EndpointReport> {
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	const raw = typeof settings === "object" && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>) : undefined;
	if (!raw) return reportOf("analytics", [fail("url", "the analytics settings must be a JSON object", 'e.g. {"backend":"duckdb","events":"https://<host>/v1/ingest","token":"<ingest token>"}'), skip("healthz", "not checked"), skip("token", "not checked")]);
	const token = typeof raw.token === "string" ? raw.token : undefined;
	if (token) registerSecret(token);
	const backend = raw.backend;
	const skipped = (reason: string): EndpointStep[] => [skip("healthz", reason), skip("token", reason)];
	if (backend !== "duckdb" && backend !== "basin") {
		return reportOf("analytics", [fail("url", `backend ${short(backend ?? "(missing)", 40)} must be "duckdb" or "basin"`, "duckdb: your own analytics server; basin: Cloudflare Basin streams"), ...skipped("not checked: the settings are not usable")]);
	}
	const problems: string[] = [];
	const events = analyticsUrl(raw.events, "events", backend === "duckdb");
	if (events.problem) problems.push(events.problem);
	let recordings: URL | undefined;
	if (raw.recordings !== undefined) {
		const checked = analyticsUrl(raw.recordings, "recordings", false);
		if (checked.problem) problems.push(checked.problem);
		else recordings = checked.url;
	} else if (backend === "basin") problems.push("basin needs a recordings stream URL too (recordings)");
	if (raw.identity !== undefined) {
		const checked = analyticsUrl(raw.identity, "identity", false);
		if (checked.problem) problems.push(checked.problem);
	}
	if (raw.token !== undefined && (typeof raw.token !== "string" || raw.token === "" || /\s/.test(raw.token) || raw.token.length > ANALYTICS_TOKEN_MAX)) {
		problems.push("token must be a non-empty string without spaces");
	}
	if (backend === "duckdb" && raw.token === undefined) problems.push("duckdb needs the server's ingest token (token): without it every upload is refused (401)");
	let base: string | undefined;
	if (events.url && backend === "duckdb") {
		const path = events.url.pathname.replace(/\/+$/, "");
		if (events.url.search || events.url.hash) problems.push("events must not have a query or fragment");
		if (!path.endsWith(INGEST_PATH)) problems.push(`events ${short(String(raw.events), 80)} must end in ${INGEST_PATH}`);
		else base = `${events.url.origin}${path.slice(0, -INGEST_PATH.length)}`;
	}
	const host = events.url?.host;
	if (problems.length) {
		return reportOf("analytics", [fail("url", problems.join("; "), backend === "duckdb" ? `events is <server address>${INGEST_PATH}, e.g. https://abc.trycloudflare.com${INGEST_PATH}; ${LOCAL_FLEET_HINT}` : "events and recordings are the two Basin stream URLs (https://<stream id>.ingest.cloudflare.com)"), ...skipped("not checked: the settings are not usable")], host);
	}
	const url = pass("url", `${backend} at ${host}${events.url!.protocol === "http:" ? " over http (loopback: works in Studio only; live servers need https)" : " over https"}`);
	if (backend === "basin") return checkBasin(doFetch, url, events.url!, recordings, token, timeoutMs);
	const healthz = await healthzStep(doFetch, base!, host!, timeoutMs, token);
	if (!healthz.ok) return reportOf("analytics", [url, healthz, skip("token", "not checked: the server didn't answer")], host);
	return reportOf("analytics", [url, healthz, await tokenStep(doFetch, base!, host!, token!, "analytics", timeoutMs)], host);
}

/** Basin: any HTTP answer from each stream URL means it exists; 401/403 with the token is a failure (see the module comment). */
async function checkBasin(doFetch: typeof fetch, url: EndpointStep, events: URL, recordings: URL | undefined, token: string | undefined, timeoutMs: number): Promise<EndpointReport> {
	const host = events.host;
	let ms = 0;
	let refused: number | undefined;
	for (const stream of [events, recordings]) {
		if (!stream) continue;
		const outcome = await get(doFetch, stream.toString(), token, timeoutMs);
		if (outcome.error) {
			const failedStep = failedRequest("healthz", stream.host, stream.host, outcome, timeoutMs, token)!;
			const wrongStream = /ENOTFOUND/.test(failedStep.detail) ? "; a wrong stream id doesn't resolve: copy the URL from the Basin dashboard (wrangler basin pipelines streams get)" : "";
			return reportOf("analytics", [url, { ...failedStep, hint: `${failedStep.hint ?? "check the stream URL"}${wrongStream}` }, skip("token", "not checked: a stream didn't answer")], host);
		}
		ms = Math.max(ms, outcome.reply.ms);
		if (outcome.reply.status === 401 || outcome.reply.status === 403) refused = outcome.reply.status;
		if (outcome.reply.status >= 500) {
			return reportOf("analytics", [url, fail("healthz", `${stream.host} answered HTTP ${outcome.reply.status}`, "Cloudflare is failing on that stream; try again in a minute, and check the stream is enabled for HTTP ingest", outcome.reply.ms), skip("token", "not checked")], host);
		}
	}
	const healthz = pass("healthz", `the Basin stream URL${recordings ? "s" : ""} answered (any HTTP status counts: Basin has no /healthz)`, ms);
	if (refused !== undefined) {
		return reportOf("analytics", [url, healthz, fail("token", `Basin refused the token (HTTP ${refused})`, "use an API token with the 'Basin Pipelines Send' permission, or switch off 'Require authentication' on the stream")], host);
	}
	const note = token ? "no side-effect-free check exists for Basin: a wrong token shows up as 401 on the first upload (dev menu > Status > Analytics)" : "no token set: right only when the stream doesn't require authentication";
	return reportOf("analytics", [url, healthz, skip("token", note)], host);
}

// Output ----------------------------------------------------------------------------------------------------------------

/** The lines for one report: "ok   url       ..." / "FAIL healthz   ..." with the fix under a failure. */
export function formatReport(report: EndpointReport, color = true): string[] {
	const paint = { ok: color ? green : (t: string) => t, fail: color ? red : (t: string) => t, skip: color ? dim : (t: string) => t };
	const lines: string[] = [];
	for (const step of report.steps) {
		const label = step.skipped ? paint.skip("skip") : step.ok ? paint.ok("ok  ") : paint.fail("FAIL");
		lines.push(`  ${label} ${report.target} ${step.step.padEnd(7)} ${step.skipped ? paint.skip(step.detail) : step.detail}`);
		if (!step.ok && step.hint) lines.push(`       fix: ${step.hint}`);
	}
	return lines;
}

/** JSON-safe form of reports (no tokens exist in them). */
export function reportsJson(reports: EndpointReport[]) {
	return reports.map((r) => ({ target: r.target, host: r.host ?? null, ok: r.ok, steps: r.steps }));
}

export class EndpointCheckError extends Error {
	override name = "EndpointCheckError";
	constructor(
		message: string,
		readonly reports: EndpointReport[],
	) {
		super(message);
	}
}

/** Failed steps over all reports. */
export function failedSteps(reports: EndpointReport[]): { target: EndpointTarget; step: EndpointStep }[] {
	return reports.flatMap((r) => r.steps.filter((s) => !s.ok).map((step) => ({ target: r.target, step })));
}

/**
 * Stops the write when a check failed: throws an error that lists every failure with its fix (the CLI prints it in
 * red, exit 1). With `force` the failures are warnings and the write goes ahead. Passing reports print as dim lines.
 * Returns true when the write may go ahead with failures ignored (`force`).
 */
export function enforceEndpoints(input: { reports: EndpointReport[]; what: string; force?: boolean }): boolean {
	const failures = failedSteps(input.reports);
	for (const report of input.reports) {
		const lines = formatReport(report);
		if (failures.length === 0) for (const line of lines) info(dim(line));
	}
	if (failures.length === 0) return false;
	const detail = input.reports.flatMap((r) => formatReport(r, false).filter((line) => !line.includes(" skip "))).join("\n");
	if (input.force) {
		warn(`--force: writing ${input.what} although ${failures.length} check${failures.length === 1 ? "" : "s"} failed (game servers will fail the same way until it is fixed):\n${detail}`);
		return true;
	}
	throw new EndpointCheckError(
		`refusing to write ${input.what}: ${failures.length} check${failures.length === 1 ? "" : "s"} failed, nothing was signed or written\n${detail}\nFix that and run it again, or pass --force to write it anyway.`,
		input.reports,
	);
}

/** One line for a report: "fleet abc.trycloudflare.com: url ok, healthz ok (212 ms), token ok" (doctor and summaries). */
export function summarizeReport(report: EndpointReport): string {
	return `${report.target}${report.host ? ` ${report.host}` : ""}: ${report.steps.map((s) => `${s.step} ${s.skipped ? "skipped" : s.ok ? "ok" : "FAILED"}`).join(", ")}`;
}
