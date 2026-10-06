/**
 * Safety thresholds a project sets in typetorch.json (plans/17 blocker 5; kernel 0.3.7):
 *
 *   "health": { "errors": 3, "window": 30, "rollback": true, "dev": { "rollback": false } }
 *     The health window. On each server a new build is rolled back when its own scripts raise `errors` errors (1-100)
 *     within `window` seconds (5-300) of ready, or an onStart fails. `rollback: false` keeps a failing build running
 *     (the server reports "degraded" and a health_degraded alert instead). `prod` / `dev` override any of the three for
 *     builds of that channel. `typetorch build` stamps the result on the payload root as HealthErrors, HealthWindow and
 *     HealthRollback; kernel 0.3.7+ reads them at mount (missing or out-of-bounds values: its defaults), older kernels
 *     ignore them (3 errors, 30 s, rollback on). Per channel and not per branch: the values ride the immutable payload,
 *     and `promote` moves a build between branches of the same channel without a rebuild.
 *
 *   "autoRollback": { "failedPct": 20 }
 *     `deploy --wait` (and promote, approve) rolls the branch back when this percent (1-100) of the servers that tried
 *     the build report failed or rolled_back. `--rollback-at <pct>` overrides it; `--no-auto-rollback` turns it off.
 *
 * Why: a migrated game with harmless noisy errors hit 3 errors on every server at once, every server rolled back, and
 * `deploy --wait` rolled the branch back: every deploy flapped.
 */
import { isRecord } from "./json.ts";
import type { Channel } from "./naming.ts";

/** The kernel's defaults (kernel Constants HEALTH_ERRORS / HEALTH_WINDOW): what a build without settings gets. */
export const HEALTH_DEFAULTS = { errors: 3, window: 30, rollback: true } as const;
/** Inclusive bounds; the kernel checks the same ones (Constants HEALTH_ERRORS_MIN/MAX, HEALTH_WINDOW_MIN/MAX). */
export const HEALTH_BOUNDS = { errors: [1, 100], window: [5, 300] } as const;
/** The payload root attributes `typetorch build` stamps (next to ArtifactId and Channel). */
export const HEALTH_ATTRIBUTES = { errors: "HealthErrors", window: "HealthWindow", rollback: "HealthRollback" } as const;
/** The first kernel that reads them. */
export const HEALTH_KERNEL = "0.3.7";

export interface HealthSettings {
	errors?: number;
	window?: number;
	rollback?: boolean;
}

export interface HealthConfig extends HealthSettings {
	/** Overrides for builds of that channel. */
	prod?: HealthSettings;
	dev?: HealthSettings;
}

export interface EffectiveHealth {
	errors: number;
	window: number;
	rollback: boolean;
	/** Where the values come from: the kernel defaults, or typetorch.json (at least one value set for the channel). */
	source: "default" | "typetorch.json";
}

const SETTING_KEYS = ["errors", "window", "rollback"] as const;
const CHANNEL_KEYS = ["prod", "dev"] as const;

function settingsProblems(raw: Record<string, unknown>, path: string, allowChannels: boolean): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(raw)) {
		const known = (SETTING_KEYS as readonly string[]).includes(key) || (allowChannels && (CHANNEL_KEYS as readonly string[]).includes(key));
		if (!known) problems.push(`"${path}.${key}" is not a health setting (${[...SETTING_KEYS, ...(allowChannels ? CHANNEL_KEYS : [])].join(", ")})`);
	}
	const [errorsLow, errorsHigh] = HEALTH_BOUNDS.errors;
	if (raw.errors !== undefined && !(Number.isInteger(raw.errors) && (raw.errors as number) >= errorsLow && (raw.errors as number) <= errorsHigh)) {
		problems.push(`"${path}.errors" must be a whole number from ${errorsLow} to ${errorsHigh} (errors from a new build that roll a server back; default ${HEALTH_DEFAULTS.errors})`);
	}
	const [windowLow, windowHigh] = HEALTH_BOUNDS.window;
	if (raw.window !== undefined && !(Number.isInteger(raw.window) && (raw.window as number) >= windowLow && (raw.window as number) <= windowHigh)) {
		problems.push(`"${path}.window" must be a whole number of seconds from ${windowLow} to ${windowHigh} (after the build is ready; default ${HEALTH_DEFAULTS.window})`);
	}
	if (raw.rollback !== undefined && typeof raw.rollback !== "boolean") {
		problems.push(`"${path}.rollback" must be true or false (false: count errors, never roll back)`);
	}
	return problems;
}

/** Checks typetorch.json "health". Returns the settings, or every problem found. */
export function validateHealth(raw: unknown): { health?: HealthConfig; errors: string[] } {
	if (!isRecord(raw)) return { errors: [`"health" must be an object like { "errors": 3, "window": 30 }`] };
	const errors = settingsProblems(raw, "health", true);
	for (const channel of CHANNEL_KEYS) {
		const override = raw[channel];
		if (override === undefined) continue;
		if (!isRecord(override)) errors.push(`"health.${channel}" must be an object like { "rollback": false }`);
		else errors.push(...settingsProblems(override, `health.${channel}`, false));
	}
	if (errors.length > 0) return { errors };
	const pick = (from: Record<string, unknown>): HealthSettings => ({
		...(from.errors !== undefined ? { errors: from.errors as number } : {}),
		...(from.window !== undefined ? { window: from.window as number } : {}),
		...(from.rollback !== undefined ? { rollback: from.rollback as boolean } : {}),
	});
	const health: HealthConfig = pick(raw);
	for (const channel of CHANNEL_KEYS) if (isRecord(raw[channel])) health[channel] = pick(raw[channel] as Record<string, unknown>);
	return { health, errors };
}

/** The values a build of `channel` carries: the defaults, then typetorch.json "health", then its channel override. */
export function effectiveHealth(health: HealthConfig | undefined, channel: Channel): EffectiveHealth {
	const override = health?.[channel];
	const set = (key: (typeof SETTING_KEYS)[number]) => override?.[key] !== undefined || health?.[key] !== undefined;
	return {
		errors: override?.errors ?? health?.errors ?? HEALTH_DEFAULTS.errors,
		window: override?.window ?? health?.window ?? HEALTH_DEFAULTS.window,
		rollback: override?.rollback ?? health?.rollback ?? HEALTH_DEFAULTS.rollback,
		source: SETTING_KEYS.some(set) ? "typetorch.json" : "default",
	};
}

/** The payload root attributes for a build (stamped by `typetorch build`, read by kernel 0.3.7+ at mount). */
export function healthAttributes(health: EffectiveHealth): Record<string, number | boolean> {
	return {
		[HEALTH_ATTRIBUTES.errors]: health.errors,
		[HEALTH_ATTRIBUTES.window]: health.window,
		[HEALTH_ATTRIBUTES.rollback]: health.rollback,
	};
}

/** One short line: "3 errors in 30 s roll back" / "rollback off (3 errors in 30 s: degraded only)". */
export function describeHealth(health: Pick<EffectiveHealth, "errors" | "window" | "rollback"> & { source?: string }): string {
	const errors = `${health.errors} error${health.errors === 1 ? "" : "s"} in ${health.window} s`;
	const text = health.rollback ? `${errors} roll back` : `rollback off (${errors}: degraded only)`;
	return health.source ? `${text} (${health.source})` : text;
}

// deploy --wait ----------------------------------------------------------------------------------------------------------

/** deploy --wait rolls the branch back when this percent of the servers that tried a build failed or rolled back. */
export const DEFAULT_FAILED_PCT = 20;
export const FAILED_PCT_BOUNDS = [1, 100] as const;

export interface AutoRollbackConfig {
	failedPct: number;
}

/** Checks typetorch.json "autoRollback". */
export function validateAutoRollback(raw: unknown): { autoRollback?: AutoRollbackConfig; errors: string[] } {
	const [low, high] = FAILED_PCT_BOUNDS;
	if (!isRecord(raw)) return { errors: [`"autoRollback" must be an object like { "failedPct": ${DEFAULT_FAILED_PCT} }`] };
	const errors: string[] = [];
	for (const key of Object.keys(raw)) if (key !== "failedPct") errors.push(`"autoRollback.${key}" is not a setting (failedPct)`);
	if (!(Number.isInteger(raw.failedPct) && (raw.failedPct as number) >= low && (raw.failedPct as number) <= high)) {
		errors.push(`"autoRollback.failedPct" must be a whole percent from ${low} to ${high} (default ${DEFAULT_FAILED_PCT})`);
	}
	return errors.length > 0 ? { errors } : { autoRollback: { failedPct: raw.failedPct as number }, errors };
}
