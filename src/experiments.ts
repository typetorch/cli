/**
 * Live analytics experiment overrides (`typetorch experiment`): the framework's per-experiment dials in the signed
 * settings record, changed without a deploy. The framework (analytics/settings.ts `sinkSettings`, `parseExperiments`)
 * reads them from `backend.analytics.experiments`, and frameworks before 0.4 from the old `analytics.experiments`, so
 * the CLI writes both (`withExperiments`). analytics/experiments.ts `assignVariant` applies one override:
 *
 *   active: false   everyone gets the first variant (the control); `exp` isn't stamped
 *   variant         everyone gets this variant (stamped, forced = true); ignored unless it is one of the game's variants
 *   weights         relative weights in the game's variant order; hashed on unitHash("<name>:<pid>"), so a change
 *                   moves as few players as possible; ignored (equal split) unless there is one per variant
 *   players         { [UserId or pid]: variant }: that player gets the variant over all of the above (stamped,
 *                   forced); frameworks without per-player overrides ignore it
 *
 * The variants themselves live in game code (`analytics.experiment("onboarding", ["short", "long"])`), so the CLI
 * can't check them; `--variants` and the backend's recent `experiment` rows (`recentVariants`) help.
 * Every change is logged to experiments.jsonl in the state dir.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adminSql, type BackendRequestOptions } from "./backend.ts";
import type { SettingsBody } from "./settings.ts";

export const EXPERIMENTS_LOG = "experiments.jsonl";
/** The framework's isExperimentName: 1-64 characters of letters, digits, _ - . / */
export const EXPERIMENT_NAME_PATTERN = /^[A-Za-z0-9_\-./]{1,64}$/;
/** The framework's isVariantList: 1-16 distinct names of 1-32 characters. */
export const VARIANT_NAME_MAX = 32;
export const VARIANTS_MAX = 16;
/** The framework's EXPERIMENT_PLAYERS_MAX: per-player overrides one experiment may hold. */
export const PLAYERS_MAX = 200;
const OVERRIDE_FIELDS = new Set(["active", "weights", "variant", "players"]);

export interface ExperimentOverride {
	active?: boolean;
	weights?: number[];
	variant?: string;
	/** Per-player forced variants, keyed by UserId or pid. */
	players?: Record<string, string>;
}

export type Experiments = Record<string, ExperimentOverride>;

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function isExperimentName(value: unknown): value is string {
	return typeof value === "string" && EXPERIMENT_NAME_PATTERN.test(value);
}

export function isVariantName(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= VARIANT_NAME_MAX;
}

/** A `players` key: a Roblox UserId (digits) or an analytics pid (32 lowercase hex), as the framework accepts them. */
export function isPlayerKey(value: unknown): value is string {
	return typeof value === "string" && (/^[0-9]{1,19}$/.test(value) || /^[0-9a-f]{32}$/.test(value));
}

/** What is wrong with a weights list (numbers >= 0, 1-16 of them, not all 0), or undefined. */
export function weightsProblem(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > VARIANTS_MAX) return `must be a list of 1-${VARIANTS_MAX} numbers`;
	if (value.some((w) => typeof w !== "number" || !Number.isFinite(w) || w < 0)) return "must be numbers >= 0";
	if (!value.some((w) => (w as number) > 0)) return "can't all be 0";
	return undefined;
}

/** The problems of an experiments value (the framework's parseExperiments rules, a little stricter), or []. */
export function experimentsProblems(value: unknown, where = "experiments"): string[] {
	const object = plainObject(value);
	if (!object) return [`${where} must be { [name]: { active?, weights?, variant? } }`];
	const problems: string[] = [];
	for (const [name, raw] of Object.entries(object)) {
		if (!isExperimentName(name)) {
			problems.push(`${where}: "${String(name).slice(0, 80)}" isn't an experiment name (1-64 letters, digits and _ - . /)`);
			continue;
		}
		const entry = plainObject(raw);
		if (!entry) {
			problems.push(`${where}.${name} must be { active?, weights?, variant? }`);
			continue;
		}
		for (const field of Object.keys(entry)) if (!OVERRIDE_FIELDS.has(field)) problems.push(`${where}.${name}.${field} isn't an override (active, weights, variant)`);
		if (entry.active !== undefined && typeof entry.active !== "boolean") problems.push(`${where}.${name}.active must be true or false`);
		if (entry.variant !== undefined && !isVariantName(entry.variant)) problems.push(`${where}.${name}.variant must be a variant name (1-${VARIANT_NAME_MAX} characters)`);
		if (entry.weights !== undefined) {
			const problem = weightsProblem(entry.weights);
			if (problem) problems.push(`${where}.${name}.weights ${problem}`);
		}
		if (entry.players !== undefined) {
			const players = plainObject(entry.players);
			if (!players) problems.push(`${where}.${name}.players must be { [UserId or pid]: variant }`);
			else {
				const keys = Object.keys(players);
				if (keys.length > PLAYERS_MAX) problems.push(`${where}.${name}.players holds ${keys.length} players, over ${PLAYERS_MAX}`);
				const badKey = keys.find((key) => !isPlayerKey(key));
				if (badKey !== undefined) problems.push(`${where}.${name}.players: "${String(badKey).slice(0, 40)}" isn't a UserId or a pid`);
				const badVariant = keys.find((key) => !isVariantName(players[key]));
				if (badVariant !== undefined) problems.push(`${where}.${name}.players.${badVariant.slice(0, 40)} must be a variant name (1-${VARIANT_NAME_MAX} characters)`);
			}
		}
	}
	return problems;
}

/** `3,1` -> [3, 1], or why not. */
export function parseWeights(text: string): { weights?: number[]; problem?: string } {
	const parts = text.split(",").map((part) => part.trim());
	const weights = parts.map((part) => (part === "" ? Number.NaN : Number(part)));
	const problem = weightsProblem(weights);
	if (problem) return { problem: `weights "${text}" ${problem} (e.g. 3,1 = 75% for the first variant)` };
	return { weights };
}

/** `--variants a,b` -> ["a", "b"], or why not. */
export function parseVariants(text: string): { variants?: string[]; problem?: string } {
	const variants = text.split(",").map((part) => part.trim());
	if (variants.length < 1 || variants.length > VARIANTS_MAX) return { problem: `--variants must list 1-${VARIANTS_MAX} variants` };
	const bad = variants.find((variant) => !isVariantName(variant));
	if (bad !== undefined) return { problem: `--variants: "${bad}" isn't a variant name (1-${VARIANT_NAME_MAX} characters)` };
	if (new Set(variants).size !== variants.length) return { problem: "--variants lists a variant twice" };
	return { variants };
}

/**
 * The overrides servers use: `backend.analytics.experiments` when the record has a backend, else the old
 * `analytics.experiments`. A backend whose analytics never got experiments (records `backend setup` wrote
 * before `typetorch experiment` existed) falls back to the old section's, which is what the next write carries over.
 */
export function experimentsOf(body: SettingsBody): Experiments {
	const current = body.backend?.analytics?.experiments ?? plainObject(body.analytics)?.experiments;
	return (plainObject(current) as Experiments | undefined) ?? {};
}

/** The old analytics section holds different experiments than the backend's (frameworks before 0.4 see those). */
export function experimentsDiffer(body: SettingsBody): boolean {
	if (!body.backend || !body.analytics) return false;
	const sorted = (value: unknown) => JSON.stringify(value ?? {}, (_key, inner) => (plainObject(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));
	return sorted(body.backend.analytics?.experiments) !== sorted(body.analytics.experiments);
}

export class NoAnalyticsError extends Error {
	override name = "NoAnalyticsError";
}

/**
 * The body with these overrides in `backend.analytics.experiments` and, mirrored, in the old `analytics` section
 * (frameworks before 0.4). No overrides drops the field. Throws when the record has neither section (no analytics sink
 * yet: `typetorch backend setup` first).
 */
export function withExperiments(body: SettingsBody, experiments: Experiments): SettingsBody {
	if (!body.backend && !body.analytics) throw new NoAnalyticsError("the settings record has no backend (or analytics) section yet, so game servers send no analytics: run `typetorch backend setup` first");
	const empty = Object.keys(experiments).length === 0;
	const copy = (): Experiments => JSON.parse(JSON.stringify(experiments)) as Experiments;
	const next: SettingsBody = { ...body };
	if (body.backend) {
		const analytics = { ...(body.backend.analytics ?? {}) };
		if (empty) delete analytics.experiments;
		else analytics.experiments = copy();
		const backend = { ...body.backend };
		if (Object.keys(analytics).length) backend.analytics = analytics;
		else delete backend.analytics;
		next.backend = backend;
	}
	if (body.analytics) {
		const old = { ...body.analytics };
		if (empty) delete old.experiments;
		else old.experiments = copy();
		next.analytics = old;
	}
	return next;
}

function percent(share: number): string {
	const value = Math.round(share * 1000) / 10;
	return `${value}%`;
}

/** One line about an override: what players get. */
export function describeOverride(override: ExperimentOverride | undefined): string {
	if (!override) return "no override (equal split)";
	const parts: string[] = [];
	const weights = override.weights?.length ? override.weights : undefined;
	const total = weights?.reduce((sum, w) => sum + w, 0) ?? 0;
	const split = weights ? `weights ${weights.join(",")} (${weights.map((w) => (total > 0 ? percent(w / total) : "?")).join(" / ")})` : undefined;
	const forcedPlayers = Object.entries(override.players ?? {});
	if (override.active === false) {
		parts.push("stopped: everyone gets the control (first variant), not stamped");
		if (override.variant !== undefined) parts.push(`also settled on "${override.variant}" (stop wins; resume drops both)`);
		if (split) parts.push(`${split} kept for resume`);
	} else if (override.variant !== undefined) {
		parts.push(`settled: everyone gets "${override.variant}"`);
		if (split) parts.push(`${split} kept for resume`);
	} else if (split) parts.push(split);
	else if (!forcedPlayers.length) parts.push(override.active === true ? "running (equal split)" : "no change (equal split)");
	else parts.push("equal split");
	if (forcedPlayers.length) {
		const shown = forcedPlayers.slice(0, 3).map(([player, variant]) => `${player} -> "${variant}"`).join(", ");
		parts.push(`${forcedPlayers.length} player${forcedPlayers.length === 1 ? "" : "s"} forced: ${shown}${forcedPlayers.length > 3 ? ", ..." : ""}`);
	}
	return parts.join("; ");
}

/** The state an override puts an experiment in (for --json). */
export function overrideState(override: ExperimentOverride | undefined): "default" | "weighted" | "settled" | "stopped" {
	if (!override) return "default";
	if (override.active === false) return "stopped";
	if (override.variant !== undefined) return "settled";
	return override.weights?.length ? "weighted" : "default";
}

// The log -----------------------------------------------------------------------------------------------------------

export type ExperimentAction = "weights" | "settle" | "stop" | "resume" | "clear" | "force" | "unforce";

export interface ExperimentLogRecord {
	at: string;
	universeId: number;
	/** The settings record's seq this change was written as. */
	seq: number;
	experiment: string;
	/** force / unforce: the player (UserId or pid). */
	player?: string;
	action: ExperimentAction;
	before: ExperimentOverride | null;
	after: ExperimentOverride | null;
	by: string;
}

export function appendExperimentLog(dir: string, record: Omit<ExperimentLogRecord, "at">, now = new Date()): ExperimentLogRecord {
	mkdirSync(dir, { recursive: true });
	const line: ExperimentLogRecord = { at: now.toISOString(), ...record };
	appendFileSync(join(dir, EXPERIMENTS_LOG), JSON.stringify(line) + "\n");
	return line;
}

export function readExperimentLog(dir: string, universeId?: number): ExperimentLogRecord[] {
	const path = join(dir, EXPERIMENTS_LOG);
	if (!existsSync(path)) return [];
	const records: ExperimentLogRecord[] = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as ExperimentLogRecord;
			if (universeId === undefined || record.universeId === universeId) records.push(record);
		} catch {}
	}
	return records;
}

// The backend's experiment rows ----------------------------------------------------------------------------------

export interface SeenVariant {
	variant: string;
	rows: number;
	/** The `variants` count the game passed (props.variants), the largest seen. */
	variants: number | null;
	forced: boolean;
	/** Unix ms of the last row. */
	last: number;
}

export const RECENT_DAYS = 7;

/** The SQL behind `recentVariants` (one read-only SELECT over `events`). */
export function recentVariantsSql(sinceMs: number): string {
	return [
		"SELECT name, json_extract_string(props, '$.variant') AS variant, COUNT(*) AS n,",
		"MAX(TRY_CAST(json_extract_string(props, '$.variants') AS INTEGER)) AS variants,",
		"BOOL_OR(COALESCE(TRY_CAST(json_extract_string(props, '$.forced') AS BOOLEAN), false)) AS forced, MAX(t) AS last",
		`FROM events WHERE kind = 'experiment' AND t >= ${Math.floor(sinceMs)}`,
		"GROUP BY 1, 2 ORDER BY 1, 3 DESC",
	].join(" ");
}

/**
 * The variants each experiment's `experiment` rows named in the last `days` days (POST /v1/sql with the admin token),
 * most rows first. Throws BackendError when the backend can't answer.
 */
export async function recentVariants(options: BackendRequestOptions & { days?: number; now?: number }): Promise<Map<string, SeenVariant[]>> {
	const since = (options.now ?? Date.now()) - (options.days ?? RECENT_DAYS) * 86_400_000;
	const result = await adminSql(options, recentVariantsSql(since), 2000);
	const index = (name: string) => result.columns.indexOf(name);
	const [name, variant, n, variants, forced, last] = ["name", "variant", "n", "variants", "forced", "last"].map(index);
	const seen = new Map<string, SeenVariant[]>();
	for (const row of result.rows) {
		const experiment = row[name];
		const value = row[variant];
		if (typeof experiment !== "string" || typeof value !== "string") continue;
		const list = seen.get(experiment) ?? [];
		list.push({
			variant: value,
			rows: Number(row[n] ?? 0),
			variants: row[variants] === null || row[variants] === undefined ? null : Number(row[variants]),
			forced: row[forced] === true,
			last: Number(row[last] ?? 0),
		});
		seen.set(experiment, list);
	}
	return seen;
}
