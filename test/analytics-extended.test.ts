/**
 * `typetorch analytics extended` (extended.ts, commands/analytics.ts): the framework's limits, set / unset / show,
 * signed writes to backend.analytics.extended mirrored into the analytics section (a Basin sink reads that one), the
 * rest of the record kept, the endpoint check leaving the dials alone, backend setup keeping them, dry runs, and an
 * untrusted record refused. Fake keys only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { analyticsCommand, analyticsFlags, parseSetPairs, parseUnsetNames } from "../src/commands/analytics";
import { analyticsDials, backendCommand, backendFlags } from "../src/commands/backend";
import { changeSettings, settingsCommand, settingsFlags } from "../src/commands/settings";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { withExperiments } from "../src/experiments";
import { dialProblem, extendedOf, extendedProblems, parseDialValue, setDials, unsetDials, withExtended } from "../src/extended";
import { setOutputMode } from "../src/log";
import { bodyProblems, signSettings, withBackend, type SettingsBody, type SettingsRecord } from "../src/settings";
import { generateSigningKey, parseSigningKey, type DualSigner } from "../src/signing";
import { ADMIN, fakeServer, HOST, INGEST } from "./fixtures/fake-analytics";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(env: Record<string, string> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-extended-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod", dev: "dev" }, approval: "none" };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw, null, "\t"));
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: root, env }));
	return { root, configPath: join(root, "typetorch.json"), config, warnings };
}

async function run<T>(proj: Project, fn: () => Promise<T>): Promise<{ result?: T; out: string; error?: Error }> {
	const lines: string[] = [];
	const log = console.log;
	const err = console.error;
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	const cwd = process.cwd();
	process.chdir(proj.root);
	try {
		return { result: await fn(), out: lines.join("\n") };
	} catch (error) {
		return { error: error as Error, out: lines.join("\n") };
	} finally {
		process.chdir(cwd);
		console.log = log;
		console.error = err;
	}
}

const AT = () => new Date("2026-11-18T12:00:00.000Z");
const bodyOf = (cloud: ReturnType<typeof fakeDataStoreCloud>): SettingsBody => JSON.parse((cloud.values.settings as SettingsRecord).body);
const EXPERIMENTS = { tutorial_ui: { weights: [3, 1] }, tt_extended_recording: { weights: [1, 1] } };
/** A record with a backend, dials, experiments, a game value and a channel: everything `set` must keep. */
const fullBody = (): SettingsBody => ({
	...withExperiments(withBackend({ game: { motd: "hi" }, channels: { prod: "prod" } }, { url: HOST, key: INGEST, analytics: { flushSeconds: 15, recordShare: 0.25 } }), EXPERIMENTS),
});
const seeded = (signer: DualSigner, body: SettingsBody = fullBody()) => fakeDataStoreCloud({ settings: signSettings(signer, 1, "2026-11-18T00:00:00.000Z", body) });
const ext = (args: string[]) => parseArgs(["extended", ...args], analyticsFlags);

describe("the framework's limits", () => {
	test("each dial's range and type", () => {
		expect(dialProblem("seconds", 600)).toBeUndefined();
		expect(dialProblem("seconds", 10)).toBeUndefined();
		expect(dialProblem("seconds", 601)).toContain("10-600");
		expect(dialProblem("seconds", 9)).toContain("10-600");
		expect(dialProblem("maxPlaytime", 0)).toBeUndefined();
		expect(dialProblem("maxPlaytime", 86401)).toContain("0-86400");
		expect(dialProblem("afkSeconds", 4)).toContain("5-600");
		expect(dialProblem("hz", 3.33)).toBeUndefined();
		expect(dialProblem("hz", 11)).toContain("1-10");
		expect(dialProblem("entMax", 24.5)).toContain("whole number");
		expect(dialProblem("entMax", 256)).toContain("0-255");
		expect(dialProblem("entRadius", 9)).toContain("10-2000");
		expect(dialProblem("uiBudgetMs", 0.05)).toBeUndefined();
		expect(dialProblem("uiBudgetMs", 0.01)).toContain("0.05-4");
		expect(dialProblem("uiKeyframeSeconds", 700)).toContain("10-600");
		expect(dialProblem("dryRun", true)).toBeUndefined();
		expect(dialProblem("dryRun", 1)).toContain("true or false");
		expect(dialProblem("streams.ui", false)).toBeUndefined();
		expect(dialProblem("streams.foo", true)).toContain("isn't a stream");
		expect(dialProblem("recordSeconds", 1)).toContain("isn't an extended dial");
		expect(dialProblem("toString", 1)).toContain("isn't an extended dial");
	});

	test("command-line values", () => {
		expect(parseDialValue("seconds", "600")).toEqual({ value: 600 });
		expect(parseDialValue("seconds", "")).toMatchObject({ problem: expect.stringContaining("10-600") });
		expect(parseDialValue("seconds", "abc").problem).toContain('got "abc"');
		expect(parseDialValue("seconds", "Infinity").problem).toContain("10-600");
		expect(parseDialValue("dryRun", "on")).toEqual({ value: true });
		expect(parseDialValue("streams.ent", "off")).toEqual({ value: false });
		expect(parseDialValue("streams.ent", "maybe").problem).toContain("true or false");
		expect(parseSetPairs(["seconds", "600", "streams.ui", "false"])).toEqual({ seconds: 600, "streams.ui": false });
		expect(() => parseSetPairs([])).toThrow(/set <dial> <value>/);
		expect(() => parseSetPairs(["seconds"])).toThrow(/set <dial> <value>/);
		expect(() => parseSetPairs(["seconds", "600", "seconds", "300"])).toThrow(/twice/);
		expect(() => parseSetPairs(["seconds", "601"])).toThrow(/10-600/);
		expect(parseUnsetNames(["seconds", "streams", "streams.ui"])).toEqual(["seconds", "streams", "streams.ui"]);
		expect(() => parseUnsetNames(["nope"])).toThrow(/isn't an extended dial/);
	});

	test("stored values: known dials checked, unknown fields kept; bad ones block the record", () => {
		expect(extendedProblems({ seconds: 600, streams: { ui: false }, futureDial: 3 })).toEqual([]);
		expect(extendedProblems([])[0]).toContain("must be an object");
		expect(extendedProblems({ seconds: 900 })[0]).toBe("extended.seconds must be a number from 10-600");
		expect(extendedProblems({ streams: { pose: "yes" } })[0]).toContain("streams.pose must be true or false");
		const bad = withExtended(fullBody(), { seconds: 900 });
		expect(bodyProblems(bad)).toEqual(["backend.analytics.extended.seconds must be a number from 10-600", "analytics.extended.seconds must be a number from 10-600"]);
	});

	test("set, unset, and which section is read", () => {
		expect(setDials({ hz: 5, streams: { ui: false } }, { seconds: 600, "streams.ent": false })).toEqual({ hz: 5, seconds: 600, streams: { ui: false, ent: false } });
		expect(unsetDials({ hz: 5, seconds: 600, streams: { ui: false } }, ["streams.ui", "hz"])).toEqual({ seconds: 600 });
		expect(unsetDials({ hz: 5, streams: { ui: false, ent: false } }, ["streams"])).toEqual({ hz: 5 });
		expect(unsetDials({ hz: 5 }, ["all"])).toEqual({});
		const both = { backend: { url: HOST, key: INGEST, analytics: { extended: { seconds: 100 } } }, analytics: { backend: "duckdb", extended: { seconds: 200 } } };
		expect(extendedOf(both)).toEqual({ seconds: 100 });
		expect(extendedOf({ ...both, analytics: { ...both.analytics, backend: "basin" } })).toEqual({ seconds: 200 });
		expect(extendedOf({ analytics: { backend: "duckdb", extended: { hz: 2 } } })).toEqual({ hz: 2 });
		expect(() => withExtended({ game: {} }, { seconds: 600 })).toThrow(/typetorch backend setup/);
	});
});

describe("analytics extended commands", () => {
	setOutputMode({ json: false, verbose: false });

	test("set seconds 600: signed (seq + 1) into both sections, everything else kept, pinged; unset goes back", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer);
		const original = bodyOf(cloud);
		const deps = { oc: cloud.oc, signer, now: AT };

		const set = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600"]), deps));
		expect(set.error).toBeUndefined();
		expect(set.out).toContain("analytics extended set seconds=600: written as settings #2");
		expect(set.out).toContain("servers pinged");
		expect(set.out).not.toContain("nobody gets");
		const record = cloud.values.settings as SettingsRecord;
		expect(record.seq).toBe(2);
		expect(record.sig).not.toBe("");
		expect(record.sigF).not.toBe("");
		const body = bodyOf(cloud);
		expect(body.backend?.analytics?.extended).toEqual({ seconds: 600 });
		expect(body.analytics?.extended).toEqual({ seconds: 600 });
		// Only the dials changed: drop them and the record is the one before.
		const without = JSON.parse(JSON.stringify(body)) as SettingsBody;
		delete without.backend!.analytics!.extended;
		delete without.analytics!.extended;
		expect(without).toEqual(original);
		expect(cloud.published.map((p) => JSON.parse(p.message))).toEqual([{ k: "settings", s: 2 }]);

		await run(proj, () => analyticsCommand(ext(["set", "hz", "5", "streams.ui", "off"]), deps));
		expect(bodyOf(cloud).backend?.analytics?.extended).toEqual({ seconds: 600, hz: 5, streams: { ui: false } });
		expect(bodyOf(cloud).analytics?.extended).toEqual({ seconds: 600, hz: 5, streams: { ui: false } });

		const same = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600"]), deps));
		expect(same.out).toContain("already set");
		expect(cloud.published).toHaveLength(2);

		await run(proj, () => analyticsCommand(ext(["unset", "all"]), deps));
		expect(bodyOf(cloud)).toEqual(original);
		expect((cloud.values.settings as SettingsRecord).seq).toBe(4);
	});

	test("out of range or unknown: a usage error before anything is read", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer);
		const before = structuredClone(cloud.values.settings);
		for (const args of [["set", "seconds", "601"], ["set", "seconds", "9"], ["set", "seconds"], ["set", "recordSeconds", "60"], ["unset"], ["unset", "nope"], ["launch"]]) {
			const done = await run(proj, () => analyticsCommand(ext(args), { oc: cloud.oc, signer }));
			expect(done.error?.name).toBe("UsageError");
		}
		const area = await run(proj, () => analyticsCommand(parseArgs(["experiments"], analyticsFlags), { oc: cloud.oc, signer }));
		expect(area.error?.message).toContain("unknown analytics subcommand");
		expect(cloud.values.settings).toEqual(before);
	});

	test("a Basin sink: the analytics section (what servers read) gets the dials too, the sink and token kept", async () => {
		const proj = project();
		const signer = newSigner();
		const basin = withBackend({}, { url: HOST, key: INGEST }, { sink: { backend: "basin", events: "https://e.ingest.cloudflare.com", recordings: "https://r.ingest.cloudflare.com", token: "basin-send-token-1234" } });
		const cloud = seeded(signer, basin);
		const done = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600"]), { oc: cloud.oc, signer, now: AT }));
		expect(done.error).toBeUndefined();
		expect(done.out).toContain("nobody gets an extended recording yet");
		const body = bodyOf(cloud);
		expect(body.analytics).toEqual({ ...basin.analytics, extended: { seconds: 600 } });
		expect(body.backend?.analytics?.extended).toEqual({ seconds: 600 });
	});

	test("--dry-run shows before and after and writes nothing; --json too", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer);
		const before = structuredClone(cloud.values.settings);
		const dry = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600", "--dry-run"]), { oc: cloud.oc }));
		expect(dry.error).toBeUndefined();
		expect(dry.out).toContain("dry run: would write settings #2");
		expect(dry.out).toContain("before  defaults");
		expect(dry.out).toContain("after   seconds 600");
		expect(cloud.values.settings).toEqual(before);
		expect(cloud.published).toEqual([]);
		setOutputMode({ json: true, verbose: false });
		try {
			const json = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600", "--dry-run"]), { oc: cloud.oc }));
			expect(JSON.parse(json.out)).toEqual({ dryRun: true, changed: true, seq: 2, before: {}, after: { seconds: 600 }, sectionsDiffered: false });
		} finally {
			setOutputMode({ json: false, verbose: false });
		}
	});

	test("a record your keys didn't sign is refused; no backend is refused with the setup hint", async () => {
		const proj = project();
		const cloud = seeded(newSigner());
		const before = structuredClone(cloud.values.settings);
		const refused = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600"]), { oc: cloud.oc, signer: newSigner() }));
		expect(refused.error?.message).toContain("isn't signed by your keys");
		expect(cloud.values.settings).toEqual(before);

		const signer = newSigner();
		const bare = seeded(signer, { game: { a: 1 } });
		const none = await run(proj, () => analyticsCommand(ext(["set", "seconds", "600"]), { oc: bare.oc, signer }));
		expect(none.error?.message).toContain("typetorch backend setup");
		expect(bodyOf(bare)).toEqual({ game: { a: 1 } });
	});

	test("show: values, defaults and who gets it; settings status shows the dials", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer, withExtended(fullBody(), { seconds: 600, streams: { ui: false } }));
		const show = await run(proj, () => analyticsCommand(ext(["show"]), { oc: cloud.oc }));
		expect(show.error).toBeUndefined();
		expect(show.out).toMatch(/seconds\s+600 s/);
		expect(show.out).toMatch(/hz\s+3\.33/);
		expect(show.out).toMatch(/streams\.ui\s+false/);
		expect(show.out).toContain("who: tt_extended_recording weights 1,1 (50% / 50%)");
		expect(show.out).not.toContain(INGEST);
		setOutputMode({ json: true, verbose: false });
		try {
			const json = JSON.parse((await run(proj, () => analyticsCommand(ext(["show"]), { oc: cloud.oc }))).out);
			expect(json.extended).toEqual({ seconds: 600, streams: { ui: false } });
			expect(json.dials.find((row: { name: string }) => row.name === "seconds")).toMatchObject({ value: 600, effective: 600, default: 300 });
			expect(json.experiment.override).toEqual({ weights: [1, 1] });
		} finally {
			setOutputMode({ json: false, verbose: false });
		}
		const status = await run(proj, () => settingsCommand(parseArgs(["status"], settingsFlags), { oc: cloud.oc, signer }));
		expect(status.out).toContain("extended rec.  seconds 600, streams.ui false");
	});

	test("the endpoint check ignores the dials; backend setup keeps them (and the Basin section's)", async () => {
		const proj = project({ TYPETORCH_API_KEY: INGEST, TYPETORCH_ADMIN_TOKEN: ADMIN, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" });
		const signer = newSigner();
		const cloud = seeded(signer);
		const ok = await changeSettings({ proj, oc: cloud.oc, signer, what: "test", fetch: fakeServer().fetch, mutate: (body) => withExtended(body, { seconds: 600 }) });
		expect(ok.outcome).toBe("written");
		const setup = await run(proj, () => backendCommand(parseArgs(["setup", "--url", HOST, "--record-share", "1"], backendFlags), { oc: cloud.oc, signer, fetch: fakeServer().fetch }));
		expect(setup.error).toBeUndefined();
		expect(bodyOf(cloud).backend?.analytics).toEqual({ flushSeconds: 15, recordShare: 1, experiments: EXPERIMENTS, extended: { seconds: 600 } });
		expect(bodyOf(cloud).analytics?.extended).toEqual({ seconds: 600 });
		// Dials only in the old section (set by hand before this command): setup carries them into backend.analytics.
		const old = { analytics: { backend: "duckdb", events: `${HOST}/v1/ingest`, token: INGEST, extended: { hz: 2 } } };
		expect(analyticsDials(old, {})).toEqual({ extended: { hz: 2 } });
	});
});
