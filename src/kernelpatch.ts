/**
 * `typetorch kernel deploy` in patch mode (the default; plans/13 "Kernel deploy = patch, not replace", spike S12):
 * the pieces between the kernel build and the publish. Pure functions where possible; kernel.ts runs them.
 *   - kernelLayout: the slots (TypeTorch* children of services) and service settings ($properties) of the kernel
 *     project, so the patch follows whatever the kernel package declares;
 *   - chooseBase: which place version to patch (the newest, which must be published, unless --base says otherwise);
 *   - runLunePatch / runLuneVerify: the Lune side (kernelpatch-luau.ts);
 *   - summaryLines: the human summary shown before the y/N.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./json.ts";
import { KERNEL_PATCH_LUAU } from "./kernelpatch-luau.ts";
import { formatBytes } from "./log.ts";
import type { PlaceVersion } from "./opencloud.ts";
import type { PatchReport, PatchVerification, PlaceSummary, ServiceProp, SlotRef } from "./placepatch.ts";
import { capture } from "./proc.ts";

export const BACKUP_DIR = "place-backups";
export const PATCH_DIR = "place-patches";
export const LUNE_SCRIPT = "kernel-patch.luau";

/** The service setting that turns `loadstring` on place-wide (remote-claude's run_luau needs it; nothing else does). */
export const LOADSTRING_SETTING: ServiceProp = { service: "ServerScriptService", prop: "LoadStringEnabled" };

export interface KernelLayoutOptions {
	/**
	 * Apply the kernel project's `LoadStringEnabled` to the place (`kernel deploy --loadstring`). Off by default
	 * (security audit 2026-10-06): a patch then leaves the place's own value alone, so installing the kernel never
	 * turns `loadstring` on in a real game. `loadstring` widens any future code-execution bug to the whole place.
	 */
	loadstring?: boolean;
}

/**
 * The kernel's slots and service settings, read from its place project (`tree.<Service>.TypeTorch*`, `$properties`).
 * `ServerScriptService.LoadStringEnabled` is left out unless `options.loadstring` is set (the place keeps its value).
 */
export function kernelLayout(projectJson: unknown, options: KernelLayoutOptions = {}): { slots: SlotRef[]; serviceProps: ServiceProp[] } {
	const slots: SlotRef[] = [];
	const serviceProps: ServiceProp[] = [];
	const tree = isRecord(projectJson) ? projectJson.tree : undefined;
	if (!isRecord(tree)) return { slots, serviceProps };
	for (const [key, node] of Object.entries(tree)) {
		if (key.startsWith("$") || !isRecord(node)) continue;
		const service = typeof node.$className === "string" ? node.$className : key;
		for (const child of Object.keys(node)) {
			if (!child.startsWith("$") && child.startsWith("TypeTorch")) slots.push({ service, name: child });
		}
		if (isRecord(node.$properties)) {
			for (const prop of Object.keys(node.$properties)) {
				if (!options.loadstring && service === LOADSTRING_SETTING.service && prop === LOADSTRING_SETTING.prop) continue;
				serviceProps.push({ service, prop });
			}
		}
	}
	return { slots, serviceProps };
}

/** Whether a kernel place project turns `loadstring` on (`$properties.LoadStringEnabled` = true on ServerScriptService). */
export function declaresLoadstring(projectJson: unknown): boolean {
	const tree = isRecord(projectJson) ? projectJson.tree : undefined;
	if (!isRecord(tree)) return false;
	return Object.entries(tree).some(([key, node]) => {
		if (!isRecord(node) || (typeof node.$className === "string" ? node.$className : key) !== LOADSTRING_SETTING.service) return false;
		return isRecord(node.$properties) && node.$properties[LOADSTRING_SETTING.prop] === true;
	});
}

export type BaseChoice =
	| { ok: true; version: number; published: boolean; /** Saved versions newer than the base (not shipped). */ skipped: number[] }
	| { ok: false; reason: string };

/**
 * The version to patch. Default: the newest version, which must be published (newer unpublished saves mean someone
 * saved work in Studio or Team Create that isn't live: refuse and name them). `published`: the newest published one
 * (the saves stay only in version history). `latest`: the newest version even if unpublished (ships the saves).
 * A number: exactly that version.
 */
export function chooseBase(versions: PlaceVersion[], base?: string): BaseChoice {
	if (versions.length === 0) return { ok: false, reason: "the place has no versions (an empty version list)" };
	const newest = versions[0];
	const newerThan = (n: number) => versions.filter((v) => v.version > n).map((v) => v.version);
	if (base === undefined) {
		if (newest.published || !newest.hasPublishedField) return { ok: true, version: newest.version, published: newest.published, skipped: [] };
		const published = versions.find((v) => v.published);
		const saves = published ? newerThan(published.version) : versions.map((v) => v.version);
		return {
			ok: false,
			reason: `the newest version v${newest.version} is not published: ${saves.length} saved version(s) after ${published ? `the last publish (v${published.version})` : "the first publish"} (${saves.slice(0, 8).map((v) => `v${v}`).join(", ")}${saves.length > 8 ? ", ..." : ""}), from Studio or Team Create. Pass --base latest to ship that work with the kernel, or --base published to patch v${published?.version ?? "?"} (the saves then stay only in version history)`,
		};
	}
	if (base === "latest") return { ok: true, version: newest.version, published: newest.published, skipped: [] };
	if (base === "published") {
		const published = versions.find((v) => v.published);
		if (!published) return { ok: false, reason: "no published version in the place's recent versions" };
		return { ok: true, version: published.version, published: true, skipped: newerThan(published.version) };
	}
	if (/^\d+$/.test(base)) {
		const version = Number(base);
		const known = versions.find((v) => v.version === version);
		return { ok: true, version, published: known?.published ?? false, skipped: newerThan(version) };
	}
	return { ok: false, reason: `--base must be "published", "latest" or a version number, got "${base}"` };
}

/** Writes the Lune script into `dir` (the game's .typetorch/) and returns its path. */
export function writeLuneScript(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, LUNE_SCRIPT);
	writeFileSync(path, KERNEL_PATCH_LUAU);
	return path;
}

export class LunePatchError extends Error {
	override name = "LunePatchError";
}

/** Lune's serde writes an empty table as {}: lists come back as arrays either way. */
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

export interface LuneVerification {
	ok: boolean;
	problems: string[];
	/** Referent properties outside the slots whose target changed (`path.Prop: before -> after`, by full name). */
	references: string[];
	stats: { services: number; subtrees: number; instances: number; /** Subtrees equal property by property, not byte by byte (explicit defaults). */ explicitDefaults: number };
	addedServices: string[];
	slots: { slot: string; instances: number; equal: boolean }[];
	settings: { path: string; value: string }[];
	identity: Record<string, string>;
}

/** Runs the Lune verifier (kernelpatch-luau.ts "verify") in `cwd` (a dir whose rokit.toml pins Lune). */
export async function runLuneVerify(lune: string, cwd: string, script: string, files: { original: string; patched: string; kernel: string; spec: string; out: string }): Promise<LuneVerification> {
	const result = await capture([lune, "run", script, "verify", files.original, files.patched, files.kernel, files.spec, files.out], cwd);
	if (result.exitCode !== 0) {
		throw new LunePatchError(`Lune couldn't verify the patched place (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 8).join(" ")}`);
	}
	const raw = JSON.parse(readFileSync(files.out, "utf8"));
	return {
		ok: raw.ok === true,
		problems: list(raw.problems).map(String),
		references: list(raw.references).map(String),
		stats: { services: Number(raw.stats?.services ?? 0), subtrees: Number(raw.stats?.subtrees ?? 0), instances: Number(raw.stats?.instances ?? 0), explicitDefaults: Number(raw.stats?.explicitDefaults ?? 0) },
		addedServices: list(raw.addedServices).map(String),
		slots: list(raw.slots).map((s) => ({ slot: String(s.slot), instances: Number(s.instances ?? 0), equal: s.equal === true })),
		settings: list(raw.settings).map((s) => ({ path: String(s.path), value: String(s.value) })),
		identity: isRecord(raw.identity) ? Object.fromEntries(Object.entries(raw.identity).map(([k, v]) => [k, String(v)])) : {},
	};
}

/** The `--engine lune` patch: Lune deserializes, swaps the slots, copies the settings and serializes the whole place. */
export async function runLunePatch(lune: string, cwd: string, script: string, files: { original: string; kernel: string; spec: string; out: string }): Promise<{ removed: number; added: number }> {
	const result = await capture([lune, "run", script, "patch", files.original, files.kernel, files.spec, files.out], cwd);
	if (result.exitCode !== 0) {
		throw new LunePatchError(`the Lune patch failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 8).join(" ")}`);
	}
	const line = result.stdout.trim().split(/\r?\n/).pop() ?? "{}";
	try {
		const parsed = JSON.parse(line);
		return { removed: Number(parsed.removed ?? 0), added: Number(parsed.added ?? 0) };
	} catch {
		return { removed: 0, added: 0 };
	}
}

const kernelLabel = (k: { version?: string; hash?: string; commit?: string }) =>
	k.version ? `${k.version}${k.commit ? ` @ ${k.commit}` : ""}${k.hash ? ` (hash ${k.hash.slice(0, 12)})` : ""}` : "none";

export interface SummaryInput {
	where: string;
	base: { version?: number; published?: boolean; skipped?: number[]; source: string; bytes: number; seconds?: number };
	backup?: string;
	before: PlaceSummary;
	engine: "splice" | "lune";
	report?: PatchReport;
	lunePatch?: { removed: number; added: number };
	newKernel: { version?: string; hash?: string; commit?: string };
	ts: PatchVerification;
	lune: LuneVerification;
	output: { path: string; bytes: number };
}

/** The summary printed before the y/N (and by --dry-run). */
export function summaryLines(input: SummaryInput): string[] {
	const lines: string[] = [];
	const pad = (label: string) => label.padEnd(9);
	const { base, before, report } = input;
	lines.push(`${pad("place")} ${input.where}`);
	lines.push(
		`${pad("base")} ${base.version !== undefined ? `v${base.version}${base.published === undefined ? "" : base.published ? " (published)" : " (NOT published)"}` : "version unknown"}  ${base.source}  ${formatBytes(base.bytes)}${base.seconds !== undefined ? ` in ${base.seconds.toFixed(1)} s` : ""}`,
	);
	if (base.skipped?.length) lines.push(`${pad("")} saved versions newer than the base are NOT shipped: ${base.skipped.map((v) => `v${v}`).join(", ")}`);
	if (input.backup) lines.push(`${pad("backup")} ${input.backup}  (restore: typetorch kernel restore ${input.backup})`);
	lines.push(`${pad("kernel")} ${kernelLabel(before.kernel)} -> ${kernelLabel(input.newKernel)}${before.kernel.versionSource === "constants" ? "  (old version from Constants.luau: no stamped attributes)" : ""}`);
	if (report) {
		for (const slot of report.slots) {
			const mark = slot.before === 0 ? "+" : slot.scripts.changed.length || slot.scripts.added.length || slot.scripts.removed.length || slot.before !== slot.after ? "~" : "=";
			const parts = [`${slot.before} -> ${slot.after} instances`];
			if (slot.copies > 1) parts.push(`${slot.copies} copies replaced by one`);
			if (slot.scripts.changed.length) parts.push(`changed: ${slot.scripts.changed.join(", ")}`);
			if (slot.scripts.added.length && slot.before > 0) parts.push(`added: ${slot.scripts.added.join(", ")}`);
			if (slot.scripts.removed.length) parts.push(`removed: ${slot.scripts.removed.join(", ")}`);
			if (mark === "=") parts.push("scripts unchanged (attributes re-stamped)");
			lines.push(`${pad(slot === report.slots[0] ? "slots" : "")} ${mark} ${slot.slot.padEnd(40)} ${parts.join("; ")}`);
		}
		const settings = report.settings.map((s) => `${s.path} ${s.changed ? `${s.before ?? "(unset)"} -> ${s.after}` : `${s.after} (unchanged)`}`);
		if (settings.length) lines.push(`${pad("settings")} ${settings.join("; ")}`);
		if (report.addedServices.length) lines.push(`${pad("services")} added: ${report.addedServices.join(", ")}`);
		if (report.references.remapped.length || report.references.cleared.length) {
			lines.push(`${pad("refs")} into the old kernel: ${report.references.remapped.length} re-pointed by path, ${report.references.cleared.length} cleared${report.references.cleared.length ? ` (${report.references.cleared.slice(0, 5).join("; ")})` : ""}`);
		}
	} else if (input.lunePatch) {
		lines.push(`${pad("slots")} ${input.lunePatch.removed} instances removed, ${input.lunePatch.added} added (Lune)`);
	}
	lines.push(
		`${pad("outside")} ${input.ts.outside.after} instances outside the slots, ${input.ts.outside.before === input.ts.outside.after && !input.ts.problems.some((p) => p.startsWith("instances outside")) ? "unchanged" : "CHANGED"} (paths and classes); Lune: ${input.lune.stats.subtrees} subtrees in ${input.lune.stats.services} services ${input.lune.ok ? `equal${input.lune.stats.explicitDefaults ? ` (${input.lune.stats.explicitDefaults} property by property: explicit defaults)` : ""}` : "DIFFER"}, references kept${input.lune.references.length ? ` except ${input.lune.references.length} cleared` : ""}`,
	);
	if (input.engine === "splice" && report) {
		lines.push(`${pad("engine")} splice: ${report.chunks.copied} of ${report.chunks.before} chunks copied byte for byte; re-encoded: ${report.classes.rewritten.join(", ") || "nothing"}${report.movedReferents ? `; ${report.movedReferents} referent(s) moved to stay dense` : ""}`);
	} else {
		lines.push(`${pad("engine")} lune: the whole place was re-encoded by rbx-dom${input.ts.droppedProps.length ? `; ${input.ts.droppedProps.length} property kind(s) migrated or dropped: ${input.ts.droppedProps.slice(0, 6).join(", ")}${input.ts.droppedProps.length > 6 ? ", ..." : ""}` : ""}`);
	}
	const caveats = Object.entries(before.caveats).map(([c, n]) => `${n} ${c}`);
	if (caveats.length) lines.push(`${pad("caveats")} the Place Publishing API documents it "doesn't update" ${caveats.join(", ")} (${input.engine === "splice" ? "copied as stored" : "re-encoded by rbx-dom"}; check them after the first publish)`);
	if (before.otherTypeTorch.length) lines.push(`${pad("kept")} ${before.otherTypeTorch.join(", ")} (not a kernel slot)`);
	lines.push(`${pad("output")} ${input.output.path}  ${formatBytes(input.output.bytes)}`);
	return lines;
}
