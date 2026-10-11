/**
 * `typetorch experiment`: live analytics experiment overrides (experiments.ts) in the signed settings record, changed
 * without a deploy. Each change runs the `settings set` flow (read, verify with your keys, change, sign with both keys,
 * write guarded by the entry version, ping servers), writes `backend.analytics.experiments` and mirrors it into the old
 * `analytics` section (frameworks before 0.4), then logs who changed what to experiments.jsonl in the state dir.
 */
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import { backendCredentialsWarned } from "../backend.ts";
import {
	appendExperimentLog,
	describeOverride,
	EXPERIMENTS_LOG,
	experimentsDiffer,
	experimentsOf,
	isExperimentName,
	isVariantName,
	NoAnalyticsError,
	overrideState,
	parseVariants,
	parseWeights,
	RECENT_DAYS,
	recentVariants,
	VARIANT_NAME_MAX,
	withExperiments,
	type ExperimentAction,
	type ExperimentOverride,
	type SeenVariant,
} from "../experiments.ts";
import { ADMIN_TOKEN_VAR } from "../env.ts";
import { gitInfo } from "../git.ts";
import { bold, dim, emitJson, info, isJson, warn } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import { encodeBody, readSettings, type SettingsBody } from "../settings.ts";
import { DS_READ_SCOPE } from "../seqstore.ts";
import type { DualSigner } from "../signing.ts";
import { KEY_FILE_FLAGS, openCloud, project, projectStateDir } from "./common.ts";
import { changeSettings, reportChange, settingsSigner } from "./settings.ts";

export const experimentFlags = { "dry-run": "boolean", force: "boolean", "no-ping": "boolean", variants: "string", days: "string", ...KEY_FILE_FLAGS } as const;

export const EXPERIMENT_USAGE = `typetorch experiment list [--days <n>]                 every override in the settings record and its state
typetorch experiment weights <name> <w1,w2,...>         relative weights in the game's variant order (3,1 = 75% / 25%)
typetorch experiment settle <name> <variant>            everyone gets this variant (make it final)
typetorch experiment stop <name>                        everyone gets the control (the first variant), not stamped
typetorch experiment resume <name>                      drop stop / settle, keep the weights
typetorch experiment clear <name>                       remove the override (equal split again)
  [--variants a,b,...] [--dry-run] [--force] [--no-ping] [--key-file <path>] [--fallback-key-file <path>]

  Changes how the framework's analytics experiments (analytics.experiment(name, variants) in game code) split players,
  live: no deploy. Each change reads the signed settings record, checks it was signed by your keys, changes one
  experiment, signs it with both prod keys, writes it back and pings servers, which pick it up within seconds. It is
  written to backend.analytics.experiments and, for frameworks before 0.4, to the old analytics section too; the
  record needs a backend first (\`typetorch backend setup\`). Every change is logged to ${EXPERIMENTS_LOG} in the state dir
  (who, when, before, after).
  Players are placed by a hash of the experiment name and their player id, so changing weights moves as few players as
  possible, and \`resume\` puts everyone back where the weights say.
  The variants live in game code, so the CLI can't check them:
    weights  one weight per variant, in the order the game lists them; a list of another length is ignored (equal split)
    settle   the variant exactly as the game names it; a name the game doesn't use is ignored
  \`list\` shows the variants the backend's experiment rows named in the last ${RECENT_DAYS} days (--days), with
  ${ADMIN_TOKEN_VAR} and typetorch.json backend.url, so you can check. --variants a,b (the game's list, in order)
  checks the weights' count and the settled variant before anything is written.
  --dry-run   show the change, write nothing
  --force     replace a record your keys didn't sign (its fields are dropped; see \`typetorch settings --help\`)
  --no-ping   don't ping servers (they still read it within about a minute)
  Needs both signing keys and the deploy key's DataStore read/create/update scopes (like \`typetorch settings set\`).`;

const ACTIONS: readonly ExperimentAction[] = ["weights", "settle", "stop", "resume", "clear"];

/** The override after one action (undefined: no override). */
export function applyAction(action: ExperimentAction, before: ExperimentOverride | undefined, value?: { weights?: number[]; variant?: string }): ExperimentOverride | undefined {
	const current: ExperimentOverride = { ...(before ?? {}) };
	switch (action) {
		case "weights":
			return { ...current, weights: [...(value?.weights ?? [])] };
		case "settle": {
			delete current.active;
			return { ...current, variant: value?.variant };
		}
		case "stop":
			return { ...current, active: false };
		case "resume": {
			if (!before) return undefined;
			delete current.active;
			delete current.variant;
			return Object.keys(current).length ? current : undefined;
		}
		case "clear":
			return undefined;
	}
}

type Deps = { oc?: Pick<OpenCloud, "request" | "publishMessage">; signer?: DualSigner; now?: () => Date; fetch?: typeof fetch; by?: string };

export async function experimentCommand(args: ParsedArgs, deps: Deps = {}) {
	const [sub, name, valueArg, extra] = args.positionals;
	if (sub === "list") {
		if (name !== undefined) throw new UsageError(`unexpected argument "${name}"`);
		return experimentList(args, deps);
	}
	if (!ACTIONS.includes(sub as ExperimentAction)) throw new UsageError(`unknown experiment subcommand "${sub ?? ""}" (list, weights, settle, stop, resume, clear)`);
	const action = sub as ExperimentAction;
	if (flagString(args, "days") !== undefined) throw new UsageError("--days belongs to `experiment list`");
	if (name === undefined) throw new UsageError(`typetorch experiment ${action} <name>${action === "weights" ? " <w1,w2,...>" : action === "settle" ? " <variant>" : ""}`);
	if (!isExperimentName(name)) throw new UsageError(`"${name}" isn't an experiment name (1-64 letters, digits and _ - . /, as the game passes it to analytics.experiment)`);
	const takesValue = action === "weights" || action === "settle";
	if (takesValue && valueArg === undefined) throw new UsageError(`typetorch experiment ${action} ${name} ${action === "weights" ? "<w1,w2,...>" : "<variant>"}`);
	const unexpected = takesValue ? extra : (valueArg ?? extra);
	if (unexpected !== undefined) throw new UsageError(`unexpected argument "${unexpected}"`);

	const variantsFlag = flagString(args, "variants");
	if (variantsFlag !== undefined && !takesValue) throw new UsageError("--variants belongs to `experiment weights` and `experiment settle`");
	let variants: string[] | undefined;
	if (variantsFlag !== undefined) {
		const parsed = parseVariants(variantsFlag);
		if (parsed.problem) throw new UsageError(parsed.problem);
		variants = parsed.variants;
	}
	let weights: number[] | undefined;
	let variant: string | undefined;
	const notes: string[] = [];
	if (action === "weights") {
		const parsed = parseWeights(valueArg!);
		if (parsed.problem) throw new UsageError(parsed.problem);
		weights = parsed.weights!;
		if (variants && variants.length !== weights.length) {
			throw new UsageError(`${weights.length} weight${weights.length === 1 ? "" : "s"} for ${variants.length} variants (${variants.join(", ")}): servers would ignore them and split equally`);
		}
		if (variants) notes.push(`split: ${variants.map((v, i) => `${v} ${Math.round((weights![i] / weights!.reduce((a, b) => a + b, 0)) * 1000) / 10}%`).join(", ")}`);
		else notes.push(`the weights go in the game's variant order (the list it passes to analytics.experiment("${name}", ...)), one per variant; another count is ignored (equal split). Check the variants with \`typetorch experiment list\` or pass --variants`);
	} else if (action === "settle") {
		variant = valueArg!;
		if (!isVariantName(variant)) throw new UsageError(`"${variant}" isn't a variant name (1-${VARIANT_NAME_MAX} characters)`);
		if (variants && !variants.includes(variant)) throw new UsageError(`"${variant}" isn't one of --variants (${variants.join(", ")})`);
		if (!variants) notes.push(`"${variant}" must be exactly one of the game's variants, or servers ignore it. Check with \`typetorch experiment list\` or pass --variants`);
	}

	const proj = project(args);
	let cloud = deps.oc;
	const client = () => (cloud ??= openCloud("deploy")!);
	let before: ExperimentOverride | undefined;
	let after: ExperimentOverride | undefined;
	let noAnalytics: Error | undefined;
	const mutate = (body: SettingsBody): SettingsBody | undefined => {
		noAnalytics = undefined;
		const current = experimentsOf(body);
		before = current[name];
		after = applyAction(action, before, { weights, variant });
		const next = { ...current };
		if (after === undefined) delete next[name];
		else next[name] = after;
		try {
			return withExperiments(body, next);
		} catch (error) {
			if (!(error instanceof NoAnalyticsError)) throw error;
			noAnalytics = error;
			return undefined;
		}
	};
	const what = `experiment ${action} ${name}`;

	if (flagBool(args, "dry-run")) {
		const read = await readSettings(client(), proj.config.universeId);
		if (read.scopeMissing) throw new Error(`can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${read.error})`);
		if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
		const current = read.body ?? {};
		const next = mutate(JSON.parse(JSON.stringify(current)) as SettingsBody);
		if (noAnalytics) throw noAnalytics;
		const changed = next !== undefined && encodeBody(next) !== encodeBody(current);
		const seq = read.record ? read.record.seq + (changed ? 1 : 0) : 1;
		if (isJson()) return emitJson({ dryRun: true, experiment: name, action, changed, seq, before: before ?? null, after: after ?? null, state: overrideState(after) });
		info(bold(`dry run: ${changed ? `would write settings #${seq}` : "nothing to change"} (${what})`));
		info(`  before  ${describeOverride(before)}`);
		info(`  after   ${describeOverride(after)}`);
		for (const note of notes) info(dim(`  ${note}`));
		return;
	}

	const signer = deps.signer ?? settingsSigner(proj, args);
	const result = await changeSettings({ proj, oc: client(), signer, mutate, what, force: flagBool(args, "force"), noPing: flagBool(args, "no-ping"), now: deps.now, fetch: deps.fetch });
	if (noAnalytics) throw noAnalytics;
	let logged = false;
	if (result.outcome === "written" && result.seq !== undefined) {
		appendExperimentLog(
			projectStateDir(proj),
			{ universeId: proj.config.universeId, seq: result.seq, experiment: name, action, before: before ?? null, after: after ?? null, by: deps.by ?? gitInfo(proj.root).userName },
			deps.now?.(),
		);
		logged = true;
	}
	if (isJson()) {
		return emitJson({ outcome: result.outcome ?? null, seq: result.seq ?? null, pinged: result.pinged ?? false, experiment: name, action, before: before ?? null, after: after ?? null, state: overrideState(after), logged, owners: result.owners ?? null });
	}
	reportChange(result, what);
	info(`  ${name}: ${describeOverride(after)}`);
	if (action === "weights" && after && (after.active === false || after.variant !== undefined)) {
		warn(`${name} is still ${after.active === false ? "stopped" : `settled on "${after.variant}"`}: the weights apply after \`typetorch experiment resume ${name}\``);
	}
	for (const note of notes) info(dim(`  ${note}`));
}

async function experimentList(args: ParsedArgs, deps: Deps) {
	for (const flag of ["variants"]) if (flagString(args, flag) !== undefined) throw new UsageError(`--${flag} belongs to \`experiment weights\` and \`experiment settle\``);
	const daysRaw = flagString(args, "days");
	const days = daysRaw === undefined ? RECENT_DAYS : Number(daysRaw);
	if (!Number.isInteger(days) || days < 1 || days > 90) throw new UsageError(`--days must be a whole number from 1 to 90, got "${daysRaw}"`);
	const proj = project(args);
	const read = await readSettings(deps.oc ?? openCloud("deploy")!, proj.config.universeId);
	if (read.scopeMissing) throw new Error(`can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${read.error})`);
	if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
	const body = read.body ?? {};
	const overrides = experimentsOf(body);

	// The variants the game actually uses, from the backend's experiment rows (admin token), when it can answer.
	let seen: Map<string, SeenVariant[]> | undefined;
	let seenNote: string | undefined;
	const url = proj.config.backend?.url ?? body.backend?.url;
	const admin = backendCredentialsWarned().admin?.value;
	if (!url) seenNote = "no backend.url in typetorch.json: the game's variants aren't shown";
	else if (!admin) seenNote = `${ADMIN_TOKEN_VAR} isn't set: the game's variants aren't shown`;
	else {
		try {
			seen = await recentVariants({ url, adminToken: admin, fetch: deps.fetch, days, timeoutMs: 20_000, now: deps.now?.().getTime() });
		} catch (error) {
			seenNote = `the backend's experiment rows aren't available (${(error as Error).message})`;
		}
	}
	const names = [...new Set([...Object.keys(overrides), ...(seen?.keys() ?? [])])].sort((a, b) => a.localeCompare(b));
	const differ = experimentsDiffer(body);
	if (isJson()) {
		return emitJson({
			seq: read.record?.seq ?? null,
			days,
			oldSectionDiffers: differ,
			variantsFrom: seen ? "backend" : null,
			variantsNote: seenNote ?? null,
			experiments: names.map((name) => ({ name, override: overrides[name] ?? null, state: overrideState(overrides[name]), seen: seen ? (seen.get(name) ?? []) : null })),
		});
	}
	if (read.missing) info("no settings record yet: no overrides (start with `typetorch backend setup`)");
	else info(bold(`settings #${read.record?.seq ?? "-"}: ${Object.keys(overrides).length} experiment override${Object.keys(overrides).length === 1 ? "" : "s"}`));
	if (!body.backend && !body.analytics && !read.missing) info(dim("  no backend section: game servers send no analytics yet (`typetorch backend setup`)"));
	if (differ) warn("the old analytics section's experiments (frameworks before 0.4) differ from backend.analytics': the next experiment change or `backend setup` rewrites both");
	if (names.length === 0) info("  (no overrides, and no experiment rows seen)");
	const width = Math.max(0, ...names.map((name) => name.length));
	for (const name of names) {
		info(`  ${name.padEnd(width)}  ${describeOverride(overrides[name])}`);
		const rows = seen?.get(name);
		if (rows?.length) {
			const total = rows.reduce((sum, row) => sum + row.rows, 0);
			const count = Math.max(0, ...rows.map((row) => row.variants ?? 0));
			const list = rows.map((row) => `${row.variant} ${row.rows} (${Math.round((row.rows / total) * 100)}%)${row.forced ? " forced" : ""}`).join(", ");
			info(dim(`  ${"".padEnd(width)}  seen in ${days} d: ${list}${count ? `; the game passes ${count} variant${count === 1 ? "" : "s"}` : ""}`));
		} else if (seen) info(dim(`  ${"".padEnd(width)}  no experiment rows in ${days} d`));
	}
	if (seenNote) info(dim(`  ${seenNote}`));
}
