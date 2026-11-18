/**
 * The extended recording's dials (`analytics.extended`, framework 0.7.2+, plans/36) in the signed settings record:
 * `typetorch analytics extended show | set | unset` (commands/analytics.ts). The framework (analytics/settings.ts
 * `parseExtended`) reads them from `backend.analytics.extended` (the DuckDB sink, via `sinkSettings`) and from the
 * record's `analytics` section (a Basin sink, and frameworks before 0.4), so the CLI writes both, like the experiment
 * overrides (`withExperiments`). It clamps a value out of range and keeps the default for a wrong type; the CLI refuses
 * both instead, with the framework's limits (`EXTENDED_DIALS`).
 *
 * Who gets an extended recording is the built-in experiment `tt_extended_recording` (variants off, on;
 * `typetorch experiment`), and only in sessions recorded in detail (`recordShare`): no override, nobody.
 *
 * This module imports nothing at runtime from settings.ts (settings.ts calls `extendedProblems`).
 */
import type { SettingsBody } from "./settings.ts";

/** The framework's EXT_EXPERIMENT / EXT_VARIANTS: who gets an extended recording. */
export const EXT_EXPERIMENT = "tt_extended_recording";
export const EXT_VARIANTS = ["off", "on"] as const;

export type ExtendedStreamName = "pose" | "ent" | "ui" | "view";
export const EXTENDED_STREAMS: readonly ExtendedStreamName[] = ["pose", "ent", "ui", "view"];

/** The record's `extended` value: every field optional (missing = the framework's default). */
export interface ExtendedDials {
	seconds?: number;
	maxPlaytime?: number;
	afkSeconds?: number;
	hz?: number;
	entMax?: number;
	entRadius?: number;
	uiBudgetMs?: number;
	uiKeyframeSeconds?: number;
	dryRun?: boolean;
	streams?: Partial<Record<ExtendedStreamName, boolean>>;
}

export interface NumberDial {
	kind: "number";
	low: number;
	high: number;
	/** Whole numbers only (the framework floors entMax). */
	integer?: boolean;
	default: number;
	unit?: string;
	about: string;
}

export interface BooleanDial {
	kind: "boolean";
	default: boolean;
	about: string;
}

/** The numeric and boolean dials: the framework's parseExtended limits and defaultExtended values. */
export const EXTENDED_DIALS = {
	seconds: { kind: "number", low: 10, high: 600, default: 300, unit: "s", about: "seconds an extended session records after the first input" },
	maxPlaytime: { kind: "number", low: 0, high: 86400, default: 60, unit: "s", about: "eligible while total playtime at the join is under this" },
	afkSeconds: { kind: "number", low: 5, high: 600, default: 30, unit: "s", about: "no input and no movement this long = AFK" },
	hz: { kind: "number", low: 1, high: 10, default: 3.33, about: "pose / move / UI polls a second" },
	entMax: { kind: "number", low: 0, high: 255, integer: true, default: 24, about: "the most entities recorded at once, nearest first" },
	entRadius: { kind: "number", low: 10, high: 2000, default: 150, unit: "studs", about: "entities farther from the camera aren't recorded" },
	uiBudgetMs: { kind: "number", low: 0.05, high: 4, default: 0.25, unit: "ms", about: "UI poll time per frame (phones and tablets: 0.6 of it)" },
	uiKeyframeSeconds: { kind: "number", low: 10, high: 600, default: 60, unit: "s", about: "seconds between UI keyframes" },
	dryRun: { kind: "boolean", default: false, about: "build everything, send nothing, report the counts" },
} as const satisfies Record<string, NumberDial | BooleanDial>;

export type ScalarDialName = keyof typeof EXTENDED_DIALS;
const SCALAR_NAMES = Object.keys(EXTENDED_DIALS) as ScalarDialName[];
/** Every dial a command line can name: the scalars and streams.<name>. */
export const DIAL_NAMES: readonly string[] = [...SCALAR_NAMES, ...EXTENDED_STREAMS.map((name) => `streams.${name}`)];

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function dialSpec(name: string): NumberDial | BooleanDial | undefined {
	return Object.prototype.hasOwnProperty.call(EXTENDED_DIALS, name) ? (EXTENDED_DIALS as Record<string, NumberDial | BooleanDial>)[name] : undefined;
}

function rangeText(spec: NumberDial): string {
	return `${spec.low}-${spec.high}${spec.integer ? " (whole numbers)" : ""}`;
}

/** What is wrong with one value for one dial (the framework's limits), or undefined. */
export function dialProblem(name: string, value: unknown): string | undefined {
	const stream = name.startsWith("streams.") ? name.slice(8) : undefined;
	if (stream !== undefined) {
		if (!(EXTENDED_STREAMS as readonly string[]).includes(stream)) return `"${name}" isn't a stream (${EXTENDED_STREAMS.map((s) => `streams.${s}`).join(", ")})`;
		return typeof value === "boolean" ? undefined : `${name} must be true or false`;
	}
	const spec = dialSpec(name);
	if (!spec) return `"${name}" isn't an extended dial (${DIAL_NAMES.join(", ")})`;
	if (spec.kind === "boolean") return typeof value === "boolean" ? undefined : `${name} must be true or false`;
	if (typeof value !== "number" || !Number.isFinite(value) || value < spec.low || value > spec.high) return `${name} must be a number from ${rangeText(spec)}`;
	if (spec.integer && !Number.isInteger(value)) return `${name} must be a whole number from ${rangeText(spec)}`;
	return undefined;
}

/** A command-line value for one dial (`600`, `true`, `off`, ...), or why not. */
export function parseDialValue(name: string, text: string): { value?: number | boolean; problem?: string } {
	const stream = name.startsWith("streams.");
	const spec = stream ? undefined : dialSpec(name);
	if (!stream && !spec) return { problem: dialProblem(name, undefined) };
	let value: number | boolean | undefined;
	if (stream || spec?.kind === "boolean") {
		const lower = text.trim().toLowerCase();
		value = ["true", "on", "yes", "1"].includes(lower) ? true : ["false", "off", "no", "0"].includes(lower) ? false : undefined;
		if (value === undefined) return { problem: `${name} must be true or false, got "${text}"` };
	} else value = text.trim() === "" ? Number.NaN : Number(text);
	const problem = dialProblem(name, value);
	return problem ? { problem: `${problem}, got "${text}"` } : { value };
}

/**
 * The problems of a stored `extended` value (`where` names it), or []. Unknown fields pass (a newer framework may read
 * more dials); the known ones must be what the framework accepts.
 */
export function extendedProblems(value: unknown, where = "extended"): string[] {
	const object = plainObject(value);
	if (!object) return [`${where} must be an object of dials (${SCALAR_NAMES.join(", ")}, streams)`];
	const problems: string[] = [];
	for (const name of SCALAR_NAMES) {
		if (object[name] === undefined) continue;
		const problem = dialProblem(name, object[name]);
		if (problem) problems.push(`${where}.${problem}`);
	}
	if (object.streams !== undefined) {
		const streams = plainObject(object.streams);
		if (!streams) problems.push(`${where}.streams must be { pose?, ent?, ui?, view? } (each true or false)`);
		else for (const name of EXTENDED_STREAMS) if (streams[name] !== undefined && typeof streams[name] !== "boolean") problems.push(`${where}.streams.${name} must be true or false`);
	}
	return problems;
}

function isBasin(body: SettingsBody): boolean {
	return plainObject(body.analytics)?.backend === "basin";
}

/**
 * The dials servers use: with a Basin sink the `analytics` section's (frameworks 0.4+ read that section then), else
 * `backend.analytics.extended`; either falls back to the other section's. {} when neither has any.
 */
export function extendedOf(body: SettingsBody): ExtendedDials {
	const fromBackend = plainObject(body.backend?.analytics?.extended);
	const fromOld = plainObject(plainObject(body.analytics)?.extended);
	const value = isBasin(body) ? (fromOld ?? fromBackend) : (fromBackend ?? fromOld);
	return (value ? JSON.parse(JSON.stringify(value)) : {}) as ExtendedDials;
}

/** The two sections hold different dials (one set of servers would see other values). */
export function extendedDiffer(body: SettingsBody): boolean {
	if (!body.backend || !body.analytics) return false;
	return stableJson(body.backend.analytics?.extended ?? null) !== stableJson(plainObject(body.analytics)?.extended ?? null);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner) => (plainObject(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));
}

/** The dials after setting these (`streams.x` names go in `streams`). Unknown fields already there are kept. */
export function setDials(current: ExtendedDials, changes: Record<string, number | boolean>): ExtendedDials {
	const next: ExtendedDials & Record<string, unknown> = JSON.parse(JSON.stringify(current));
	for (const [name, value] of Object.entries(changes)) {
		if (name.startsWith("streams.")) next.streams = { ...(next.streams ?? {}), [name.slice(8)]: value as boolean };
		else (next as Record<string, unknown>)[name] = value;
	}
	return next;
}

/** The dials without these (`streams` drops every stream; `all` drops everything). */
export function unsetDials(current: ExtendedDials, names: readonly string[]): ExtendedDials {
	if (names.includes("all")) return {};
	const next: ExtendedDials & Record<string, unknown> = JSON.parse(JSON.stringify(current));
	for (const name of names) {
		if (name === "streams") delete next.streams;
		else if (name.startsWith("streams.")) {
			if (next.streams) {
				delete next.streams[name.slice(8) as ExtendedStreamName];
				if (Object.keys(next.streams).length === 0) delete next.streams;
			}
		} else delete (next as Record<string, unknown>)[name];
	}
	return next;
}

export class NoAnalyticsSectionError extends Error {
	override name = "NoAnalyticsSectionError";
}

/**
 * The body with these dials in `backend.analytics.extended` and, the same, in the old `analytics` section (a Basin
 * sink, frameworks before 0.4). Empty dials drop the field. Nothing else changes. Throws when the record has neither
 * section (no analytics sink yet: `typetorch backend setup` first).
 */
export function withExtended(body: SettingsBody, dials: ExtendedDials): SettingsBody {
	if (!body.backend && !body.analytics) {
		throw new NoAnalyticsSectionError("the settings record has no backend (or analytics) section yet, so game servers send no analytics: run `typetorch backend setup` first");
	}
	const empty = Object.keys(dials).length === 0;
	const copy = () => JSON.parse(JSON.stringify(dials)) as ExtendedDials;
	const next: SettingsBody = { ...body };
	if (body.backend) {
		const analytics = { ...(body.backend.analytics ?? {}) };
		if (empty) delete analytics.extended;
		else analytics.extended = copy();
		const backend = { ...body.backend };
		if (Object.keys(analytics).length) backend.analytics = analytics;
		else delete backend.analytics;
		next.backend = backend;
	}
	if (body.analytics) {
		const old = { ...body.analytics };
		if (empty) delete old.extended;
		else old.extended = copy();
		next.analytics = old;
	}
	return next;
}

export interface DialRow {
	name: string;
	/** The record's value (undefined: not set). */
	value?: number | boolean;
	/** What servers use: the record's value, else the framework's default. */
	effective: number | boolean;
	default: number | boolean;
	unit?: string;
	about: string;
	range?: string;
}

/** One row per dial for `show`. */
export function dialRows(dials: ExtendedDials): DialRow[] {
	const rows: DialRow[] = [];
	for (const name of SCALAR_NAMES) {
		const spec: NumberDial | BooleanDial = EXTENDED_DIALS[name];
		const value = (dials as Record<string, unknown>)[name] as number | boolean | undefined;
		rows.push({
			name,
			...(value !== undefined ? { value } : {}),
			effective: value ?? spec.default,
			default: spec.default,
			...(spec.kind === "number" && spec.unit ? { unit: spec.unit } : {}),
			about: spec.about,
			...(spec.kind === "number" ? { range: rangeText(spec) } : {}),
		});
	}
	for (const stream of EXTENDED_STREAMS) {
		const value = dials.streams?.[stream];
		rows.push({ name: `streams.${stream}`, ...(value !== undefined ? { value } : {}), effective: value ?? true, default: true, about: `the ${stream} stream runs` });
	}
	return rows;
}

/** A short summary of the set dials, e.g. "seconds 600, hz 5" (for settings status). */
export function describeExtended(dials: ExtendedDials): string {
	const parts: string[] = [];
	for (const name of SCALAR_NAMES) {
		const value = (dials as Record<string, unknown>)[name];
		if (value !== undefined) parts.push(`${name} ${String(value)}`);
	}
	for (const stream of EXTENDED_STREAMS) if (dials.streams?.[stream] !== undefined) parts.push(`streams.${stream} ${String(dials.streams[stream])}`);
	return parts.length ? parts.join(", ") : "defaults";
}
