/**
 * `typetorch analytics extended show | set | unset`: the extended recording's dials (extended.ts; framework 0.7.2+,
 * plans/36) in the signed settings record, changed without a deploy. Each change runs the `settings set` flow (read,
 * verify with your keys, change, sign with both keys, write guarded by the entry version, ping servers) and writes
 * `backend.analytics.extended` and the record's `analytics.extended` (a Basin sink, frameworks before 0.4). Nothing else
 * in the record changes: the URLs and keys, experiments, flushSeconds and recordShare stay as they are.
 */
import { flagBool, UsageError, type ParsedArgs } from "../args.ts";
import { experimentsOf, describeOverride } from "../experiments.ts";
import {
	DIAL_NAMES,
	dialRows,
	describeExtended,
	EXT_EXPERIMENT,
	EXT_VARIANTS,
	extendedDiffer,
	extendedOf,
	NoAnalyticsSectionError,
	parseDialValue,
	setDials,
	unsetDials,
	withExtended,
	type ExtendedDials,
} from "../extended.ts";
import { bold, dim, emitJson, info, isJson, warn } from "../log.ts";
import type { OpenCloud } from "../opencloud.ts";
import { encodeBody, readSettings, type SettingsBody } from "../settings.ts";
import { DS_READ_SCOPE } from "../seqstore.ts";
import type { DualSigner } from "../signing.ts";
import { KEY_FILE_FLAGS, openCloud, project } from "./common.ts";
import { changeSettings, reportChange, settingsSigner } from "./settings.ts";

export const analyticsFlags = { "dry-run": "boolean", force: "boolean", "no-ping": "boolean", ...KEY_FILE_FLAGS } as const;

export const ANALYTICS_USAGE = `typetorch analytics extended show
typetorch analytics extended set <dial> <value> [<dial> <value> ...]
typetorch analytics extended unset <dial> [<dial> ...] | all
  [--dry-run] [--force] [--no-ping] [--key-file <path>] [--fallback-key-file <path>]

  The extended recording's dials (framework 0.7.2+, plans/36: poses, entities, animations, the UI tree), live: no
  deploy. Each change reads the signed settings record, checks it was signed by your keys, changes only these dials,
  signs it with both prod keys (seq + 1), writes it back and pings servers, which use the new values for recordings
  that start after they read it (within seconds). Written to backend.analytics.extended and, the same, to the record's
  analytics.extended (what a Basin sink and frameworks before 0.4 read); everything else (the backend URL and key,
  experiments, flushSeconds, recordShare, the sink) is kept. The record needs a backend first (\`typetorch backend setup\`).
  Dials (the framework's limits; a dial not set uses the default):
    seconds            10-600     300    seconds an extended session records after the first input
    maxPlaytime        0-86400    60     eligible while total playtime at the join is under this (seconds)
    afkSeconds         5-600      30     no input and no movement this long = AFK
    hz                 1-10       3.33   pose / move / UI polls a second
    entMax             0-255      24     the most entities recorded at once, nearest first (whole numbers)
    entRadius          10-2000    150    entities farther from the camera (studs) aren't recorded
    uiBudgetMs         0.05-4     0.25   UI poll time per frame, ms (phones and tablets: 0.6 of it)
    uiKeyframeSeconds  10-600     60     seconds between UI keyframes
    dryRun             true/false false  build everything, send nothing, report the counts
    streams.pose | streams.ent | streams.ui | streams.view   true/false (each default true)
  show   the record's dials, what servers use (default where unset) and who gets a recording
  set    one or more dials, e.g. \`set seconds 600\` or \`set hz 5 streams.ui off\`; a value out of range is refused
  unset  back to the default: dials by name, \`streams\` (every stream) or \`all\`
  Who gets an extended recording is the built-in experiment ${EXT_EXPERIMENT} (variants ${EXT_VARIANTS.join(", ")}), only in sessions
  recorded in detail (backend setup --record-share): no override, nobody. E.g.
  \`typetorch experiment weights ${EXT_EXPERIMENT} 1,1\` (half), \`typetorch experiment settle ${EXT_EXPERIMENT} on\` (all).
  --dry-run   show the change, write nothing
  --force     replace a record your keys didn't sign (its fields are dropped; see \`typetorch settings --help\`)
  --no-ping   don't ping servers (they still read it within about a minute)
  Needs both signing keys and the deploy key's DataStore read/create/update scopes (like \`typetorch settings set\`).`;

type Deps = { oc?: Pick<OpenCloud, "request" | "publishMessage">; signer?: DualSigner; now?: () => Date; fetch?: typeof fetch };

/** `set` positionals as { dial: value }, or a usage error. */
export function parseSetPairs(rest: readonly string[]): Record<string, number | boolean> {
	if (rest.length === 0 || rest.length % 2 !== 0) throw new UsageError("typetorch analytics extended set <dial> <value> [<dial> <value> ...] (e.g. set seconds 600)");
	const changes: Record<string, number | boolean> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const name = rest[i];
		if (Object.prototype.hasOwnProperty.call(changes, name)) throw new UsageError(`${name} is given twice`);
		const parsed = parseDialValue(name, rest[i + 1]);
		if (parsed.problem) throw new UsageError(parsed.problem);
		changes[name] = parsed.value!;
	}
	return changes;
}

/** `unset` positionals, checked. */
export function parseUnsetNames(rest: readonly string[]): string[] {
	if (rest.length === 0) throw new UsageError("typetorch analytics extended unset <dial> [<dial> ...] | all");
	for (const name of rest) {
		if (name === "all" || name === "streams" || DIAL_NAMES.includes(name)) continue;
		throw new UsageError(`"${name}" isn't an extended dial (${DIAL_NAMES.join(", ")}, streams, all)`);
	}
	return [...rest];
}

export async function analyticsCommand(args: ParsedArgs, deps: Deps = {}) {
	const [area, sub, ...rest] = args.positionals;
	if (area !== "extended") throw new UsageError(`unknown analytics subcommand "${area ?? ""}" (extended)`);
	if (sub === "show") {
		if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
		for (const flag of ["dry-run", "force", "no-ping"]) if (flagBool(args, flag)) throw new UsageError(`--${flag} belongs to \`analytics extended set\` and \`unset\``);
		return extendedShow(args, deps);
	}
	if (sub !== "set" && sub !== "unset") throw new UsageError(`unknown analytics extended subcommand "${sub ?? ""}" (show, set, unset)`);
	const changes = sub === "set" ? parseSetPairs(rest) : undefined;
	const names = sub === "unset" ? parseUnsetNames(rest) : undefined;
	const change = (current: ExtendedDials) => (changes ? setDials(current, changes) : unsetDials(current, names!));
	const what = sub === "set" ? `analytics extended set ${Object.entries(changes!).map(([name, value]) => `${name}=${value}`).join(" ")}` : `analytics extended unset ${names!.join(" ")}`;

	const proj = project(args);
	let cloud = deps.oc;
	const client = () => (cloud ??= openCloud("deploy")!);
	let before: ExtendedDials = {};
	let after: ExtendedDials = {};
	let differed = false;
	let noAnalytics: Error | undefined;
	const mutate = (body: SettingsBody): SettingsBody | undefined => {
		noAnalytics = undefined;
		before = extendedOf(body);
		differed = extendedDiffer(body);
		after = change(before);
		try {
			return withExtended(body, after);
		} catch (error) {
			if (!(error instanceof NoAnalyticsSectionError)) throw error;
			noAnalytics = error;
			return undefined;
		}
	};

	if (flagBool(args, "dry-run")) {
		const read = await readSettings(client(), proj.config.universeId);
		if (read.scopeMissing) throw new Error(`can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${read.error})`);
		if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
		const current = read.body ?? {};
		const next = mutate(JSON.parse(JSON.stringify(current)) as SettingsBody);
		if (noAnalytics) throw noAnalytics;
		const changed = next !== undefined && encodeBody(next) !== encodeBody(current);
		const seq = read.record ? read.record.seq + (changed ? 1 : 0) : 1;
		if (isJson()) return emitJson({ dryRun: true, changed, seq, before, after, sectionsDiffered: differed });
		info(bold(`dry run: ${changed ? `would write settings #${seq}` : "nothing to change"} (${what})`));
		info(`  before  ${describeExtended(before)}`);
		info(`  after   ${describeExtended(after)}`);
		if (differed) info(dim("  the two analytics sections differ now; the write makes both these dials"));
		return;
	}

	const signer = deps.signer ?? settingsSigner(proj, args);
	const result = await changeSettings({ proj, oc: client(), signer, mutate, what, force: flagBool(args, "force"), noPing: flagBool(args, "no-ping"), now: deps.now, fetch: deps.fetch });
	if (noAnalytics) throw noAnalytics;
	if (isJson()) return emitJson({ outcome: result.outcome ?? null, seq: result.seq ?? null, pinged: result.pinged ?? false, before, after, owners: result.owners ?? null });
	reportChange(result, what);
	info(`  extended recording: ${describeExtended(after)}`);
	if (!experimentsOf(result.after ?? {})[EXT_EXPERIMENT]) {
		warn(`no ${EXT_EXPERIMENT} override in the record, so nobody gets an extended recording yet: \`typetorch experiment weights ${EXT_EXPERIMENT} 1,1\` (or settle ... on)`);
	}
}

async function extendedShow(args: ParsedArgs, deps: Deps) {
	const proj = project(args);
	const read = await readSettings(deps.oc ?? openCloud("deploy")!, proj.config.universeId);
	if (read.scopeMissing) throw new Error(`can't read the settings record: the deploy key needs ${DS_READ_SCOPE} (${read.error})`);
	if (read.error) throw new Error(`reading the settings record failed: ${read.error}`);
	const body = read.body ?? {};
	const dials = extendedOf(body);
	const rows = dialRows(dials);
	const rollout = experimentsOf(body)[EXT_EXPERIMENT];
	const differ = extendedDiffer(body);
	if (isJson()) {
		return emitJson({ seq: read.record?.seq ?? null, extended: dials, dials: rows, sectionsDiffer: differ, experiment: { name: EXT_EXPERIMENT, override: rollout ?? null } });
	}
	if (read.missing) info("no settings record yet (start with `typetorch backend setup`)");
	else info(bold(`settings #${read.record?.seq ?? "-"}: extended recording dials (${Object.keys(dials).length ? describeExtended(dials) : "all defaults"})`));
	if (!read.missing && !body.backend && !body.analytics) info(dim("  no backend section: game servers send no analytics yet (`typetorch backend setup`)"));
	const width = Math.max(...rows.map((row) => row.name.length));
	for (const row of rows) {
		const shown = `${String(row.effective)}${row.unit ? ` ${row.unit}` : ""}`;
		info(`  ${row.name.padEnd(width)}  ${shown.padEnd(10)} ${row.value === undefined ? dim("default") : bold("set    ")}  ${dim(`${row.range ? `${row.range}; ` : ""}${row.about}`)}`);
	}
	if (differ) warn("backend.analytics.extended and analytics.extended differ: the next `analytics extended set` / `unset` (or `backend setup`) writes both the same");
	info(`  who: ${EXT_EXPERIMENT} ${rollout ? describeOverride(rollout) : "has no override: nobody gets an extended recording"}`);
}
