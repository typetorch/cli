/**
 * Live analytics experiment overrides (experiments.ts, commands/experiment.ts): validation with the framework's
 * parseExperiments rules, the actions, writes to backend.analytics.experiments mirrored into the old analytics section,
 * the endpoint check leaving experiments alone, backend setup keeping them, dry runs, the experiments.jsonl log, and
 * `list` with the backend's experiment rows. Fake keys only.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { analyticsDials, backendCommand, backendFlags } from "../src/commands/backend";
import { applyAction, experimentCommand, experimentFlags } from "../src/commands/experiment";
import { changeSettings, settingsCommand, settingsFlags } from "../src/commands/settings";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { experimentsProblems, parseVariants, parseWeights, readExperimentLog, recentVariantsSql, withExperiments } from "../src/experiments";
import { setOutputMode } from "../src/log";
import { backendProblems, bodyProblems, signSettings, withBackend, type SettingsBody, type SettingsRecord } from "../src/settings";
import { generateSigningKey, parseSigningKey, type DualSigner } from "../src/signing";
import { ADMIN, fakeServer, HOST, INGEST } from "./fixtures/fake-analytics";
import { fakeDataStoreCloud } from "./fixtures/fake-datastore";

function newSigner(): DualSigner {
	return { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
}

function project(patch: Record<string, unknown> = {}, env: Record<string, string> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-experiment-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod", dev: "dev" }, approval: "none", ...patch };
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

const AT = () => new Date("2026-10-11T12:00:00.000Z");
const bodyOf = (cloud: ReturnType<typeof fakeDataStoreCloud>): SettingsBody => JSON.parse((cloud.values.settings as SettingsRecord).body);
const withBackendBody = (extra: SettingsBody = {}) => withBackend(extra, { url: HOST, key: INGEST, analytics: { flushSeconds: 15 } });

/** A cloud holding a record with a backend, signed by `signer`. */
function seeded(signer: DualSigner, body: SettingsBody = withBackendBody()) {
	return fakeDataStoreCloud({ settings: signSettings(signer, 1, "2026-10-11T00:00:00.000Z", body) });
}

const exp = (args: string[]) => parseArgs(args, experimentFlags);

describe("validation (the framework's parseExperiments rules)", () => {
	test("good overrides pass; names, weights, variants, active and unknown fields are checked", () => {
		expect(experimentsProblems({ tutorial_ui: { weights: [3, 1] }, "shop/v2.1-a": { variant: "short", active: true }, off: { active: false } })).toEqual([]);
		expect(experimentsProblems({})).toEqual([]);
		expect(experimentsProblems([])[0]).toContain("must be {");
		expect(experimentsProblems({ "bad name": {} })[0]).toContain("isn't an experiment name");
		expect(experimentsProblems({ ["x".repeat(65)]: {} })[0]).toContain("isn't an experiment name");
		expect(experimentsProblems({ a: [] })[0]).toContain("experiments.a must be");
		expect(experimentsProblems({ a: { weights: [1, -1] } })[0]).toContain("numbers >= 0");
		expect(experimentsProblems({ a: { weights: [0, 0] } })[0]).toContain("can't all be 0");
		expect(experimentsProblems({ a: { weights: [] } })[0]).toContain("1-16 numbers");
		expect(experimentsProblems({ a: { weights: [1, "2"] } })[0]).toContain("numbers >= 0");
		expect(experimentsProblems({ a: { weights: new Array(17).fill(1) } })[0]).toContain("1-16 numbers");
		expect(experimentsProblems({ a: { variant: "" } })[0]).toContain("variant must be a variant name");
		expect(experimentsProblems({ a: { variant: "v".repeat(33) } })[0]).toContain("variant must be a variant name");
		expect(experimentsProblems({ a: { active: "no" } })[0]).toContain("active must be true or false");
		expect(experimentsProblems({ a: { wieghts: [1] } })[0]).toContain("wieghts isn't an override");
	});

	test("backend.analytics allows experiments and checks them; a bad one blocks the whole record", () => {
		const backend = { url: HOST, key: INGEST, analytics: { flushSeconds: 15, experiments: { a: { weights: [3, 1] } } } };
		expect(backendProblems(backend)).toEqual([]);
		expect(backendProblems({ ...backend, analytics: { experiments: { a: { weights: [0] } } } })).toEqual(["backend.analytics.experiments.a.weights can't all be 0"]);
		expect(bodyProblems({ backend: { ...backend, analytics: { experiments: { a: { variant: 3 } } } } as never })[0]).toContain("backend.analytics.experiments.a.variant");
	});

	test("weights and --variants parse", () => {
		expect(parseWeights("3,1")).toEqual({ weights: [3, 1] });
		expect(parseWeights(" 0.5, 0.25 ,0.25")).toEqual({ weights: [0.5, 0.25, 0.25] });
		expect(parseWeights("3,,1").problem).toContain("numbers >= 0");
		expect(parseWeights("0,0").problem).toContain("can't all be 0");
		expect(parseWeights("a,b").problem).toContain("numbers >= 0");
		expect(parseVariants("control,short")).toEqual({ variants: ["control", "short"] });
		expect(parseVariants("a,a").problem).toContain("twice");
		expect(parseVariants("a,").problem).toContain("isn't a variant name");
	});

	test("the actions", () => {
		expect(applyAction("weights", undefined, { weights: [3, 1] })).toEqual({ weights: [3, 1] });
		expect(applyAction("settle", { weights: [3, 1], active: false }, { variant: "b" })).toEqual({ weights: [3, 1], variant: "b" });
		expect(applyAction("stop", { weights: [3, 1], variant: "b" })).toEqual({ weights: [3, 1], variant: "b", active: false });
		expect(applyAction("resume", { weights: [3, 1], variant: "b", active: false })).toEqual({ weights: [3, 1] });
		expect(applyAction("resume", { active: false })).toBeUndefined();
		expect(applyAction("resume", undefined)).toBeUndefined();
		expect(applyAction("clear", { weights: [1, 1] })).toBeUndefined();
	});

	test("withExperiments writes backend.analytics and mirrors into the old section; none drops the field; no sink refuses", () => {
		const body = withBackendBody();
		const next = withExperiments(body, { a: { weights: [3, 1] } });
		expect(next.backend?.analytics).toEqual({ flushSeconds: 15, experiments: { a: { weights: [3, 1] } } });
		expect(next.analytics?.experiments).toEqual({ a: { weights: [3, 1] } });
		const cleared = withExperiments(next, {});
		expect(cleared.backend?.analytics).toEqual({ flushSeconds: 15 });
		expect(cleared.analytics?.experiments).toBeUndefined();
		// A record from before CLI 0.9 (only the old analytics section, e.g. Basin): only that section.
		const basin = withExperiments({ analytics: { backend: "basin", events: "https://x.example" } }, { a: { active: false } });
		expect(basin).toEqual({ analytics: { backend: "basin", events: "https://x.example", experiments: { a: { active: false } } } });
		expect(() => withExperiments({ game: { a: 1 } }, { a: {} })).toThrow(/backend setup/);
	});
});

describe("backend setup keeps experiments", () => {
	test("analyticsDials carries backend.analytics.experiments, else the old section's (migrated into both)", () => {
		const current = withExperiments(withBackendBody(), { tutorial_ui: { weights: [3, 1] } });
		const next = withBackend(current, { url: HOST, key: INGEST, analytics: analyticsDials(current, { recordShare: 0.5 }) });
		expect(next.backend?.analytics).toEqual({ flushSeconds: 15, recordShare: 0.5, experiments: { tutorial_ui: { weights: [3, 1] } } });
		expect(next.analytics?.experiments).toEqual({ tutorial_ui: { weights: [3, 1] } });
		// Before `typetorch experiment`, setup kept experiments only in the old section: now they reach backend.analytics too.
		const old = { analytics: { backend: "basin", events: "https://x.ingest.cloudflare.com", token: "t", experiments: { onboarding: { variant: "short" } } } };
		const migrated = withBackend(old, { url: HOST, key: INGEST, analytics: analyticsDials(old, {}) });
		expect(migrated.backend?.analytics).toEqual({ experiments: { onboarding: { variant: "short" } } });
		expect(migrated.analytics?.experiments).toEqual({ onboarding: { variant: "short" } });
	});

	test("the command: `backend setup` over a record with overrides keeps them in both sections", async () => {
		setOutputMode({ json: false, verbose: false });
		const proj = project({}, { TYPETORCH_API_KEY: INGEST, TYPETORCH_ADMIN_TOKEN: ADMIN, OPENCLOUD_API_KEY: "fake-open-cloud-key-0000" });
		const signer = newSigner();
		const cloud = seeded(signer, withExperiments(withBackendBody(), { tutorial_ui: { weights: [3, 1] }, shop: { active: false } }));
		const done = await run(proj, () => backendCommand(parseArgs(["setup", "--url", HOST, "--record-share", "1"], backendFlags), { oc: cloud.oc, signer, fetch: fakeServer().fetch }));
		expect(done.error).toBeUndefined();
		const body = bodyOf(cloud);
		const experiments = { tutorial_ui: { weights: [3, 1] }, shop: { active: false } };
		expect(body.backend?.analytics).toEqual({ flushSeconds: 15, recordShare: 1, experiments });
		expect(body.analytics?.experiments).toEqual(experiments);
	});
});

describe("experiment commands", () => {
	setOutputMode({ json: false, verbose: false });

	test("weights / settle / stop / resume / clear: signed writes to both sections, pings, logged with before and after", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer);
		const deps = { oc: cloud.oc, signer, now: AT, by: "dev-a" };

		const weights = await run(proj, () => experimentCommand(exp(["weights", "tutorial_ui", "3,1"]), deps));
		expect(weights.error).toBeUndefined();
		expect(weights.out).toContain("experiment weights tutorial_ui: written as settings #2");
		expect(weights.out).toContain("weights 3,1 (75% / 25%)");
		expect(weights.out).toContain("game's variant order");
		expect(bodyOf(cloud).backend?.analytics?.experiments).toEqual({ tutorial_ui: { weights: [3, 1] } });
		expect(bodyOf(cloud).analytics?.experiments).toEqual({ tutorial_ui: { weights: [3, 1] } });
		// The rest of the record is untouched (the key, the dials, the old sink).
		expect(bodyOf(cloud).backend).toMatchObject({ url: HOST, key: INGEST, analytics: { flushSeconds: 15 } });
		expect(bodyOf(cloud).analytics).toMatchObject({ backend: "duckdb", token: INGEST });

		await run(proj, () => experimentCommand(exp(["settle", "tutorial_ui", "short"]), deps));
		expect(bodyOf(cloud).backend?.analytics?.experiments).toEqual({ tutorial_ui: { weights: [3, 1], variant: "short" } });
		const stop = await run(proj, () => experimentCommand(exp(["stop", "tutorial_ui"]), deps));
		expect(stop.out).toContain("stopped: everyone gets the control");
		expect(bodyOf(cloud).analytics?.experiments).toEqual({ tutorial_ui: { weights: [3, 1], variant: "short", active: false } });
		await run(proj, () => experimentCommand(exp(["resume", "tutorial_ui"]), deps));
		expect(bodyOf(cloud).backend?.analytics?.experiments).toEqual({ tutorial_ui: { weights: [3, 1] } });
		await run(proj, () => experimentCommand(exp(["clear", "tutorial_ui"]), deps));
		expect(bodyOf(cloud).backend?.analytics).toEqual({ flushSeconds: 15 });
		expect(bodyOf(cloud).analytics?.experiments).toBeUndefined();
		expect(cloud.published.map((p) => JSON.parse(p.message).s)).toEqual([2, 3, 4, 5, 6]);

		// Nothing to resume or clear: unchanged, no ping, no log line.
		const again = await run(proj, () => experimentCommand(exp(["clear", "tutorial_ui"]), deps));
		expect(again.out).toContain("already set");
		expect(cloud.published).toHaveLength(5);

		const log = readExperimentLog(join(proj.root, ".typetorch"), 42);
		expect(log.map((r) => [r.action, r.seq])).toEqual([
			["weights", 2],
			["settle", 3],
			["stop", 4],
			["resume", 5],
			["clear", 6],
		]);
		expect(log[0]).toEqual({ at: "2026-10-11T12:00:00.000Z", universeId: 42, seq: 2, experiment: "tutorial_ui", action: "weights", before: null, after: { weights: [3, 1] }, by: "dev-a" });
		expect(log[4]).toMatchObject({ before: { weights: [3, 1] }, after: null });
	});

	test("weights while settled warns that resume applies them; --variants checks the count and the settled variant", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer, withExperiments(withBackendBody(), { a: { variant: "x" } }));
		const deps = { oc: cloud.oc, signer, now: AT, by: "dev" };
		const warned = await run(proj, () => experimentCommand(exp(["weights", "a", "1,1", "--variants", "x,y"]), deps));
		expect(warned.out).toContain('still settled on "x"');
		expect(warned.out).toContain("split: x 50%, y 50%");
		expect(warned.out).not.toContain("game's variant order");
		const count = await run(proj, () => experimentCommand(exp(["weights", "a", "1,1,1", "--variants", "x,y"]), deps));
		expect(count.error?.message).toContain("3 weights for 2 variants");
		const missing = await run(proj, () => experimentCommand(exp(["settle", "a", "z", "--variants", "x,y"]), deps));
		expect(missing.error?.message).toContain(`"z" isn't one of --variants`);
		const usage = [
			await run(proj, () => experimentCommand(exp(["weights", "a"]), deps)),
			await run(proj, () => experimentCommand(exp(["weights", "a", "0,0"]), deps)),
			await run(proj, () => experimentCommand(exp(["stop", "bad name"]), deps)),
			await run(proj, () => experimentCommand(exp(["stop", "a", "extra"]), deps)),
			await run(proj, () => experimentCommand(exp(["stop", "a", "--variants", "x"]), deps)),
			await run(proj, () => experimentCommand(exp(["launch", "a"]), deps)),
		];
		expect(usage.map((u) => u.error?.name)).toEqual(["UsageError", "UsageError", "UsageError", "UsageError", "UsageError", "UsageError"]);
		expect(cloud.published).toHaveLength(1);
	});

	test("--dry-run shows before and after and writes, pings and logs nothing", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer);
		const before = structuredClone(cloud.values.settings);
		const dry = await run(proj, () => experimentCommand(exp(["weights", "tutorial_ui", "3,1", "--dry-run"]), { oc: cloud.oc, now: AT }));
		expect(dry.error).toBeUndefined();
		expect(dry.out).toContain("dry run: would write settings #2");
		expect(dry.out).toContain("before  no override (equal split)");
		expect(dry.out).toContain("after   weights 3,1 (75% / 25%)");
		expect(cloud.values.settings).toEqual(before);
		expect(cloud.published).toEqual([]);
		expect(existsSync(join(proj.root, ".typetorch", "experiments.jsonl"))).toBe(false);
		setOutputMode({ json: true, verbose: false });
		try {
			const json = await run(proj, () => experimentCommand(exp(["stop", "tutorial_ui", "--dry-run"]), { oc: cloud.oc }));
			expect(JSON.parse(json.out)).toEqual({ dryRun: true, experiment: "tutorial_ui", action: "stop", changed: true, seq: 2, before: null, after: { active: false }, state: "stopped" });
		} finally {
			setOutputMode({ json: false, verbose: false });
		}
	});

	test("no backend in the record: refused with the setup hint, nothing written", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer, { game: { a: 1 } });
		const refused = await run(proj, () => experimentCommand(exp(["weights", "a", "1,1"]), { oc: cloud.oc, signer }));
		expect(refused.error?.message).toContain("typetorch backend setup");
		expect(bodyOf(cloud)).toEqual({ game: { a: 1 } });
		expect(cloud.published).toEqual([]);
		const dry = await run(proj, () => experimentCommand(exp(["weights", "a", "1,1", "--dry-run"]), { oc: cloud.oc }));
		expect(dry.error?.message).toContain("typetorch backend setup");
	});

	test("the endpoint check ignores experiments but still refuses an unchecked url or key change", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer);
		const ok = await changeSettings({ proj, oc: cloud.oc, signer, what: "test", mutate: (body) => withExperiments(body, { a: { weights: [1, 2] } }) });
		expect(ok.outcome).toBe("written");
		await expect(changeSettings({ proj, oc: cloud.oc, signer, what: "test", mutate: (body) => ({ ...body, backend: { ...body.backend!, url: "https://evil.example" } }) })).rejects.toThrow(
			/without checking its endpoint/,
		);
		await expect(changeSettings({ proj, oc: cloud.oc, signer, what: "test", mutate: (body) => ({ ...body, analytics: { ...body.analytics, events: "https://evil.example/v1/ingest" } }) })).rejects.toThrow(
			/without checking its endpoint/,
		);
	});

	test("settings status and get backend show the overrides; keys stay hidden", async () => {
		const proj = project();
		const signer = newSigner();
		const cloud = seeded(signer, withExperiments(withBackendBody(), { tutorial_ui: { weights: [3, 1] }, shop: { variant: "big" } }));
		const status = await run(proj, () => settingsCommand(parseArgs(["status"], settingsFlags), { oc: cloud.oc, signer }));
		expect(status.out).toContain("experiments    2 overrides");
		expect(status.out).toContain('shop: settled: everyone gets "big"');
		expect(status.out).toContain("tutorial_ui: weights 3,1 (75% / 25%)");
		expect(status.out).not.toContain(INGEST);
		const get = await run(proj, () => settingsCommand(parseArgs(["get", "backend"], settingsFlags), { oc: cloud.oc, signer }));
		expect(JSON.parse(get.out).analytics.experiments).toEqual({ tutorial_ui: { weights: [3, 1] }, shop: { variant: "big" } });
		expect(get.out).not.toContain(INGEST);
		expect(get.out).toContain("hidden");
	});

	test("list: overrides with the variants the backend's experiment rows named; without the admin token it says so", async () => {
		const proj = project({ backend: { url: HOST } }, { TYPETORCH_ADMIN_TOKEN: ADMIN });
		const signer = newSigner();
		const cloud = seeded(signer, withExperiments(withBackendBody(), { tutorial_ui: { weights: [3, 1] } }));
		const sent: { auth: string | null; body: { sql: string; limit?: number } }[] = [];
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname !== "/v1/sql") return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
			sent.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
			return Response.json({
				columns: [
					{ name: "name", type: "VARCHAR" },
					{ name: "variant", type: "VARCHAR" },
					{ name: "n", type: "BIGINT" },
					{ name: "variants", type: "INTEGER" },
					{ name: "forced", type: "BOOLEAN" },
					{ name: "last", type: "BIGINT" },
				],
				rows: [
					["onboarding", "short", 30, 2, false, 1],
					["onboarding", "long", 10, 2, false, 1],
					["tutorial_ui", "new", 75, 2, false, 1],
					["tutorial_ui", "old", 25, 2, false, 1],
				],
				truncated: false,
				ms: 3,
			});
		}) as typeof fetch;
		const list = await run(proj, () => experimentCommand(exp(["list"]), { oc: cloud.oc, fetch: fetcher, now: AT }));
		expect(list.error).toBeUndefined();
		expect(list.out).toContain("settings #1: 1 experiment override");
		expect(list.out).toMatch(/onboarding +no override \(equal split\)/);
		expect(list.out).toContain("seen in 7 d: short 30 (75%), long 10 (25%); the game passes 2 variants");
		expect(list.out).toMatch(/tutorial_ui +weights 3,1 \(75% \/ 25%\)/);
		expect(sent[0].auth).toBe(`Bearer ${ADMIN}`);
		expect(sent[0].body.sql).toBe(recentVariantsSql(AT().getTime() - 7 * 86_400_000));
		expect(list.out).not.toContain(ADMIN);

		setOutputMode({ json: true, verbose: false });
		try {
			const json = JSON.parse((await run(proj, () => experimentCommand(exp(["list", "--days", "3"]), { oc: cloud.oc, fetch: fetcher, now: AT }))).out);
			expect(json.days).toBe(3);
			expect(json.experiments.map((e: { name: string; state: string }) => [e.name, e.state])).toEqual([
				["onboarding", "default"],
				["tutorial_ui", "weighted"],
			]);
			expect(json.experiments[1].seen.map((s: { variant: string }) => s.variant)).toEqual(["new", "old"]);
		} finally {
			setOutputMode({ json: false, verbose: false });
		}

		const failing = (async () => new Response(JSON.stringify({ error: "ad-hoc SQL is off on this server (TYPETORCH_SQL=0)" }), { status: 404 })) as unknown as typeof fetch;
		const off = await run(proj, () => experimentCommand(exp(["list"]), { oc: cloud.oc, fetch: failing }));
		expect(off.error).toBeUndefined();
		expect(off.out).toContain("ad-hoc SQL is off");
		const noToken = project({ backend: { url: HOST } });
		const plain = await run(noToken, () => experimentCommand(exp(["list"]), { oc: cloud.oc, fetch: fetcher }));
		expect(plain.out).toContain("TYPETORCH_ADMIN_TOKEN isn't set");
		expect(plain.out).toContain("tutorial_ui");
	});

	test("a record whose experiments sit only in the old analytics section: list warns, the next change copies them to backend", async () => {
		const proj = project();
		const signer = newSigner();
		const body = withBackendBody();
		body.analytics = { ...body.analytics, experiments: { onboarding: { weights: [1, 3] } } };
		const cloud = seeded(signer, body);
		const list = await run(proj, () => experimentCommand(exp(["list"]), { oc: cloud.oc }));
		expect(list.out).toContain("differ from backend.analytics'");
		expect(list.out).toContain("onboarding");
		await run(proj, () => experimentCommand(exp(["stop", "tutorial_ui"]), { oc: cloud.oc, signer, by: "dev" }));
		const expected = { onboarding: { weights: [1, 3] }, tutorial_ui: { active: false } };
		expect(bodyOf(cloud).backend?.analytics?.experiments).toEqual(expected);
		expect(bodyOf(cloud).analytics?.experiments).toEqual(expected);
	});
});
