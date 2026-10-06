import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { approveProposal, finishRelease, propose, type ReleaseRequest } from "../src/commands/approve";
import { withLocal } from "../src/commands/common";
import { deployFlags } from "../src/commands/deploy";
import { currentRollout, widenCommand } from "../src/commands/widen";
import { validateConfig, type Project } from "../src/config";
import { appendLocalLog, readLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { scriptedInteraction } from "../src/interact";
import { setOutputMode, Stopwatch } from "../src/log";
import { deployMessage, type OpenCloud } from "../src/opencloud";
import { appendRollout, checkRollout, parseRollout, parseWiden, RolloutError } from "../src/rollout";
import { generateSigningKey } from "../src/signing";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

function project(patch: Record<string, unknown> = {}): Project {
	const root = mkdtempSync(join(tmpdir(), "tt-rollout-"));
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "none", ...patch };
	writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw));
	const { config } = validateConfig(raw);
	useSettings(new Settings({ startDir: root, env: {} }));
	return { root, configPath: join(root, "typetorch.json"), config: config!, warnings: [] };
}

function fakeOc() {
	const published: string[] = [];
	return { published, oc: { publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud };
}

const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777, channel: "dev" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false };
const request = (patch: Partial<ReleaseRequest> = {}): ReleaseRequest => ({ kind: "deploy", branch: "dev", branchChannel: "dev", artifact, force: false, by: "me", ...patch });

describe("rollout flags", () => {
	test("--rollout 1-99, --widen 1-100", () => {
		expect(parseRollout(undefined)).toBeUndefined();
		expect(parseRollout("10")).toBe(10);
		for (const bad of ["0", "100", "5.5", "x"]) expect(() => parseRollout(bad)).toThrow(/1 to 99/);
		expect(parseWiden("100")).toBe(100);
		expect(() => parseWiden("101")).toThrow(/1 to 100/);
	});
	test("refused for prod-channel branches, with the reason and the alternative", () => {
		expect(() => checkRollout("dev", "dev", 10)).not.toThrow();
		expect(() => checkRollout("prod", "prod", undefined)).not.toThrow();
		const error = (() => {
			try {
				checkRollout("prod", "prod", 10);
			} catch (e) {
				return e as Error;
			}
		})()!;
		expect(error).toBeInstanceOf(RolloutError);
		expect(error.message).toContain("prod servers ignore the rollout % on signed deploy messages");
		expect(error.message).toContain("typetorch pin <artifact> --branch prod --pct <1-99>");
	});
	test("the message: `ro` after r, never on a signed message", () => {
		const message = deployMessage({ b: "dev", a: 1, i: "x", s: 3, c: "c", ch: "dev", rollback: true, rollout: 25, t: 5 });
		expect(Object.keys(message)).toEqual(["b", "a", "i", "s", "c", "ch", "t", "r", "ro"]);
		expect(message.ro).toBe(25);
		expect(() => deployMessage({ b: "prod", a: 1, i: "x", s: 3, c: "c", ch: "prod", rollout: 25 }, { main: generateSigningKey(), fallback: generateSigningKey() } as any)).toThrow(/signed/);
		expect(() => deployMessage({ b: "dev", a: 1, i: "x", s: 3, c: "c", ch: "dev", rollout: 100 })).toThrow(/1 to 99/);
	});
});

describe("releases with a rollout", () => {
	test("finishRelease sends `ro` and logs the rollout (the registry head never carries it)", async () => {
		const proj = project();
		const { oc, published } = fakeOc();
		await finishRelease({ proj, mode: { kind: "publish" }, proposer: { name: "cli", explicit: false }, request: request({ rollout: 10 }), oc, history: withLocal(proj), watch: new Stopwatch() });
		expect(JSON.parse(published[0])).toMatchObject({ b: "dev", s: 1, ro: 10 });
		expect(readLocalLog(join(proj.root, ".typetorch"))[0].rollout).toBe(10);
	});
	test("a proposal keeps its rollout; approve --rollout overrides it; prod refuses before the y/N", async () => {
		const proj = project({ approval: "all" });
		const p = propose(proj, request({ rollout: 10 }), { name: "agent", explicit: false });
		const { oc, published } = fakeOc();
		await approveProposal(proj, { proposal: p, status: "pending" }, { io: scriptedInteraction({ answers: ["y"] }), oc, rollout: 30 });
		expect(JSON.parse(published[0]).ro).toBe(30);
		const prod = propose(proj, request({ branch: "prod", branchChannel: "prod", artifact: { ...artifact, channel: "prod" }, rollout: 10 }), { name: "agent", explicit: false });
		const io = scriptedInteraction({ answers: ["y"] });
		await expect(approveProposal(proj, { proposal: prod, status: "pending" }, { io, oc })).rejects.toThrow(RolloutError);
		expect(io.asked).toEqual([]);
	});
});

describe("deploy --widen", () => {
	function deployed(proj: Project, rollout?: number) {
		appendLocalLog(join(proj.root, ".typetorch"), { seq: 9, at: new Date().toISOString(), action: "deploy", branch: "dev", channel: "dev", artifactId: "12b63b9-3fa91c", assetId: 777, commit: "12b63b9", commitHash: "", dirty: false, by: "me", universeId: 42, ...(rollout ? { rollout } : {}) });
	}
	const run = async (proj: Project, argv: string[], oc: OpenCloud, answers: string[] = []) => {
		const cwd = process.cwd();
		process.chdir(proj.root);
		try {
			await widenCommand(parseArgs(argv, deployFlags), { oc, io: scriptedInteraction({ answers }) });
		} finally {
			process.chdir(cwd);
		}
	};
	test("re-sends the same seq with the new ro (100 = no ro), logs rollouts.jsonl", async () => {
		const proj = project();
		deployed(proj, 10);
		const { oc, published } = fakeOc();
		await run(proj, ["--widen", "50", "--branch", "dev", "--no-registry"], oc);
		expect(JSON.parse(published[0])).toMatchObject({ b: "dev", a: 777, i: "12b63b9-3fa91c", s: 9, ro: 50 });
		expect(currentRollout(join(proj.root, ".typetorch"), "dev", 9, 10)).toBe(50);
		await run(proj, ["--widen", "100", "--branch", "dev", "--no-registry"], oc);
		expect(JSON.parse(published[1]).ro).toBeUndefined();
		expect(JSON.parse(published[1]).s).toBe(9);
		expect(currentRollout(join(proj.root, ".typetorch"), "dev", 9, 10)).toBeUndefined();
	});
	test("asks y/N when the policy wants approval; refuses prod and flags of a new deploy", async () => {
		const proj = project({ approval: "all" });
		deployed(proj, 10);
		const { oc, published } = fakeOc();
		await run(proj, ["--widen", "50", "--branch", "dev", "--no-registry"], oc, ["n"]);
		expect(published).toEqual([]);
		await run(proj, ["--widen", "50", "--branch", "dev", "--no-registry"], oc, ["y"]);
		expect(published).toHaveLength(1);
		await expect(run(proj, ["--widen", "50", "--branch", "prod", "--no-registry"], oc)).rejects.toThrow(RolloutError);
		await expect(run(proj, ["--widen", "50", "--rollout", "5", "--branch", "dev"], oc)).rejects.toThrow(/--rollout goes with a new deploy/);
	});
	test("currentRollout: the newest widen of that seq, else the deploy's", () => {
		const proj = project();
		const dir = join(proj.root, ".typetorch");
		expect(currentRollout(dir, "dev", 9, 10)).toBe(10);
		appendRollout(dir, { universeId: 42, branch: "dev", seq: 8, artifactId: "x", assetId: 1, rollout: 70, by: "me" });
		expect(currentRollout(dir, "dev", 9, 10)).toBe(10);
		appendRollout(dir, { universeId: 42, branch: "dev", seq: 9, artifactId: "x", assetId: 1, rollout: 40, by: "me" });
		expect(currentRollout(dir, "dev", 9, 10)).toBe(40);
	});
});
