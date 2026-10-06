import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { stampProject } from "../src/build";
import { waitAfterRelease } from "../src/commands/approve";
import { describeRollbackSetting, rollbackSetting, rollbackThreshold, WAIT_FLAGS } from "../src/commands/fleet";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { parseReport, parseServer, type FleetClient, type ReportRow, type ServerRow } from "../src/fleet";
import {
	describeHealth,
	effectiveHealth,
	HEALTH_ATTRIBUTES,
	HEALTH_DEFAULTS,
	healthAttributes,
	validateAutoRollback,
	validateHealth,
} from "../src/health";
import { setOutputMode } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import type { ReleaseResult } from "../src/commands/release";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
	process.exitCode = 0;
});

const BASE = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 } };

describe('typetorch.json "health"', () => {
	test("valid settings, with channel overrides", () => {
		expect(validateHealth({ errors: 10, window: 60 })).toEqual({ health: { errors: 10, window: 60 }, errors: [] });
		expect(validateHealth({ rollback: false })).toEqual({ health: { rollback: false }, errors: [] });
		expect(validateHealth({ errors: 1, window: 5, dev: { rollback: false }, prod: { errors: 100, window: 300 } })).toEqual({
			health: { errors: 1, window: 5, dev: { rollback: false }, prod: { errors: 100, window: 300 } },
			errors: [],
		});
		expect(validateHealth({})).toEqual({ health: {}, errors: [] });
	});
	test("bounds: errors 1-100 and window 5-300 (whole numbers), rollback a boolean", () => {
		for (const errors of [0, 101, 2.5, "3", -1, null]) expect(validateHealth({ errors }).errors).toEqual([expect.stringContaining(`"health.errors" must be a whole number from 1 to 100`)]);
		for (const window of [4, 301, 30.5, "30"]) expect(validateHealth({ window }).errors).toEqual([expect.stringContaining(`"health.window" must be a whole number of seconds from 5 to 300`)]);
		expect(validateHealth({ rollback: "no" }).errors).toEqual([expect.stringContaining(`"health.rollback" must be true or false`)]);
		expect(validateHealth({ dev: { errors: 0 } }).errors).toEqual([expect.stringContaining(`"health.dev.errors"`)]);
	});
	test("unknown keys and malformed overrides are errors (a typo must not silently keep the defaults)", () => {
		expect(validateHealth({ erors: 5 }).errors).toEqual([expect.stringContaining(`"health.erors" is not a health setting`)]);
		expect(validateHealth({ dev: { dev: { rollback: false } } }).errors).toEqual([expect.stringContaining(`"health.dev.dev" is not a health setting`)]);
		expect(validateHealth({ dev: false }).errors).toEqual([`"health.dev" must be an object like { "rollback": false }`]);
		expect(validateHealth(3).errors).toEqual([`"health" must be an object like { "errors": 3, "window": 30 }`]);
	});
	test("validateConfig takes health and autoRollback, and lists their problems with the others", () => {
		const ok = validateConfig({ ...BASE, health: { errors: 8, dev: { rollback: false } }, autoRollback: { failedPct: 50 } });
		expect(ok.warnings).toEqual([]);
		expect(ok.config?.health).toEqual({ errors: 8, dev: { rollback: false } });
		expect(ok.config?.autoRollback).toEqual({ failedPct: 50 });
		const none = validateConfig(BASE);
		expect(none.config?.health).toBeUndefined();
		expect(none.config?.autoRollback).toBeUndefined();
		const bad = validateConfig({ ...BASE, health: { errors: 500 }, autoRollback: { failedPct: 0 } });
		expect(bad.config).toBeUndefined();
		expect(bad.errors).toEqual([expect.stringContaining('"health.errors"'), expect.stringContaining('"autoRollback.failedPct"')]);
	});
	test("effective values per channel: defaults, then the base, then the channel's override", () => {
		expect(effectiveHealth(undefined, "prod")).toEqual({ ...HEALTH_DEFAULTS, source: "default" });
		expect(effectiveHealth({}, "dev")).toEqual({ ...HEALTH_DEFAULTS, source: "default" });
		const health = { errors: 8, window: 45, dev: { rollback: false }, prod: { window: 60 } };
		expect(effectiveHealth(health, "prod")).toEqual({ errors: 8, window: 60, rollback: true, source: "typetorch.json" });
		expect(effectiveHealth(health, "dev")).toEqual({ errors: 8, window: 45, rollback: false, source: "typetorch.json" });
		// Only the dev override set: prod builds keep the defaults (and say so).
		expect(effectiveHealth({ dev: { rollback: false } }, "prod")).toEqual({ ...HEALTH_DEFAULTS, source: "default" });
	});
	test("stamped on the payload root next to the identity (numbers and a boolean, as kernel 0.3.7 reads them)", () => {
		const attributes = healthAttributes(effectiveHealth({ errors: 8, dev: { rollback: false } }, "dev"));
		expect(attributes).toEqual({ HealthErrors: 8, HealthWindow: 30, HealthRollback: false });
		expect(Object.keys(attributes).sort()).toEqual(Object.values(HEALTH_ATTRIBUTES).sort());
		const project = { name: "P", tree: { $className: "Model", Server: { $path: "out/server" } } };
		const stamped = stampProject(project, { ArtifactId: "a1b2c3d-3fa91c", Channel: "dev", ...attributes });
		expect(stamped.tree.$attributes).toEqual({ ArtifactId: "a1b2c3d-3fa91c", Channel: "dev", HealthErrors: 8, HealthWindow: 30, HealthRollback: false });
	});
	test("one line for build, deploy and doctor", () => {
		expect(describeHealth({ errors: 3, window: 30, rollback: true })).toBe("3 errors in 30 s roll back");
		expect(describeHealth({ errors: 1, window: 60, rollback: true, source: "typetorch.json" })).toBe("1 error in 60 s roll back (typetorch.json)");
		expect(describeHealth({ errors: 3, window: 30, rollback: false, source: "default" })).toBe("rollback off (3 errors in 30 s: degraded only) (default)");
	});
});

describe('typetorch.json "autoRollback"', () => {
	test("failedPct 1-100, nothing else", () => {
		expect(validateAutoRollback({ failedPct: 35 })).toEqual({ autoRollback: { failedPct: 35 }, errors: [] });
		for (const failedPct of [0, 101, 12.5, "20", undefined]) expect(validateAutoRollback({ failedPct }).errors).toEqual([expect.stringContaining('"autoRollback.failedPct" must be a whole percent from 1 to 100')]);
		expect(validateAutoRollback({ failedPct: 20, enabled: false }).errors).toEqual(['"autoRollback.enabled" is not a setting (failedPct)']);
		expect(validateAutoRollback(20).errors).toEqual(['"autoRollback" must be an object like { "failedPct": 20 }']);
	});
	test("the threshold: --rollback-at, else typetorch.json, else 20; --no-auto-rollback turns it off", () => {
		const spec = { ...WAIT_FLAGS };
		const config = { autoRollback: { failedPct: 50 } };
		expect(rollbackSetting(parseArgs([], spec))).toEqual({ threshold: 20, source: "default" });
		expect(rollbackSetting(parseArgs([], spec), config)).toEqual({ threshold: 50, source: "typetorch.json autoRollback.failedPct" });
		expect(rollbackSetting(parseArgs(["--rollback-at", "75"], spec), config)).toEqual({ threshold: 75, source: "--rollback-at" });
		expect(rollbackSetting(parseArgs(["--no-auto-rollback"], spec), config)).toEqual({ source: "--no-auto-rollback" });
		expect(rollbackThreshold(parseArgs([], spec), config)).toBe(50);
		expect(() => rollbackSetting(parseArgs(["--rollback-at", "101"], spec), config)).toThrow(/1 to 100/);
		expect(describeRollbackSetting({ threshold: 50, source: "typetorch.json autoRollback.failedPct" })).toBe("auto-rollback at 50% of the servers that tried it (typetorch.json autoRollback.failedPct)");
		expect(describeRollbackSetting({ source: "--no-auto-rollback" })).toBe("auto-rollback off (--no-auto-rollback)");
	});
	test("the deploy output says which threshold --wait uses, and the wait uses it", async () => {
		const root = mkdtempSync(join(tmpdir(), "tt-health-"));
		const raw = { ...BASE, channels: { prod: "prod" }, approval: "none", autoRollback: { failedPct: 50 } };
		writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw));
		const { config } = validateConfig(raw);
		useSettings(new Settings({ startDir: root, env: {} }));
		const proj: Project = { root, configPath: join(root, "typetorch.json"), config: config!, warnings: [] };
		// 1 of 3 servers rolled back: 33% is below 50% (it would have rolled back at the default 20%).
		const NOW = 1_791_220_000;
		const job = (n: number) => `0000000${n}-aaaa-bbbb-cccc-000000000000`.slice(-36);
		const servers = [1, 2, 3].map((n) => ({ j: job(n), t: "public", b: "dev", c: "dev", a: "4363e8c-d2b6d6", n: 3, m: 20, s: NOW - 3600, u: NOW - 20, p: 7, v: "0.3.7", q: 42, g: 2, h: "ok", sv: 2 }));
		const reports = [1, 2, 3].map((n) => ({ s: 42, b: "dev", a: "4363e8c-d2b6d6", j: job(n), r: n === 1 ? "rolled_back" : "swapped", d: 0.3, t: NOW - 5, g: 3, k: "0.3.7", p: 3 }));
		const fleet: FleetClient = {
			servers: async () => servers.map(parseServer).filter((s): s is ServerRow => !!s),
			reports: async () => reports.map(parseReport).filter((r): r is ReportRow => !!r),
			alerts: async () => [],
			postAlert: async () => true,
		};
		const result = {
			entry: { seq: 42, branch: "dev", artifactId: "4363e8c-d2b6d6", assetId: 1, action: "deploy" },
			message: { b: "dev", a: 1, i: "4363e8c-d2b6d6", s: 42, c: "4363e8c", ch: "dev", t: NOW * 1000 },
		} as unknown as ReleaseResult;
		const setting = rollbackSetting(parseArgs([], { ...WAIT_FLAGS }), proj.config);
		const out: string[] = [];
		const log = console.log;
		console.log = (line: string) => void out.push(line);
		let wait;
		try {
			wait = await waitAfterRelease(proj, result, {
				seconds: 30,
				oc: { publishMessage: async () => {} } as unknown as OpenCloud,
				branchChannel: "dev",
				threshold: setting.threshold,
				thresholdSource: setting.source,
				keyPaths: { main: "x", fallback: "y" },
				deps: { fleet, now: () => 0, sleep: async () => {} },
			});
		} finally {
			console.log = log;
		}
		const text = out.join("\n");
		expect(text).toContain("auto-rollback at 50% of the servers that tried it (typetorch.json autoRollback.failedPct)");
		expect(text).toContain("below the auto-rollback threshold (33% < 50%): not rolled back");
		expect(wait?.autoRollback).toBeUndefined();
		expect(wait?.decision).toMatchObject({ failures: 1, answered: 3, met: false });
	});
});
