import { describe, expect, test } from "bun:test";
import {
	formatDeploymentsTable,
	liveHeads,
	matchDeployment,
	mergeDeployments,
	nextSeqFrom,
	previousDifferent,
	type LocalDeployment,
} from "../src/deployments";
import { makeEntry } from "../src/commands/release";
import { checkChannelGuard } from "../src/commands/deploy";
import { deployMessage } from "../src/opencloud";
import {
	applyProjectConfig,
	emptyRegistry,
	foreignDraftChanges,
	MAX_VALUE_CHARS,
	nextSeq,
	normalizeRegistry,
	recordDeployment,
	sameConfigValue,
	trimRegistry,
	unwrapDraftEntries,
	type RegistryDeployment,
} from "../src/registry";
import { validateConfig } from "../src/config";

function dep(seq: number, patch: Partial<RegistryDeployment> = {}): RegistryDeployment {
	const commit = `c${String(seq).padStart(6, "0")}`;
	return {
		seq,
		at: `2026-10-04T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
		action: "deploy",
		branch: "dev",
		channel: "dev",
		artifactId: `dev-${commit}`,
		assetId: 100000000 + seq,
		commit,
		commitHash: `${commit}${"0".repeat(33)}`,
		dirty: false,
		by: "tester",
		...patch,
	};
}

describe("registry value", () => {
	test("normalize fills defaults and parses JSON strings", () => {
		expect(normalizeRegistry(undefined)).toEqual(emptyRegistry());
		expect(normalizeRegistry('{"defaultBranch":"main","branches":{}}').defaultBranch).toBe("main");
		expect(normalizeRegistry("not json")).toEqual(emptyRegistry());
	});
	test("recordDeployment moves the head and appends", () => {
		const value = recordDeployment(emptyRegistry(), dep(1));
		expect(value.branches.dev).toMatchObject({ artifactId: "dev-c000001", seq: 1, deployedAt: dep(1).at, by: "tester" });
		expect(value.deployments).toHaveLength(1);
		expect(nextSeq(value)).toBe(2);
	});
	test("keeps at most 25 deployments, newest", () => {
		let value = emptyRegistry();
		for (let i = 1; i <= 30; i++) value = recordDeployment(value, dep(i));
		expect(value.deployments).toHaveLength(25);
		expect(value.deployments[0].seq).toBe(6);
		expect(value.deployments.at(-1)!.seq).toBe(30);
	});
	test("trims to the value size limit", () => {
		let value = emptyRegistry();
		for (let i = 1; i <= 25; i++) value = recordDeployment(value, dep(i, { by: "x".repeat(200) }));
		expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_VALUE_CHARS);
		expect(value.deployments.at(-1)!.seq).toBe(25);
		const { dropped } = trimRegistry(value, 25, 2000);
		expect(dropped).toBeGreaterThan(0);
	});
	test("applyProjectConfig keeps branches and deployments", () => {
		const value = recordDeployment(emptyRegistry(), dep(1));
		const { config } = validateConfig({
			project: "p",
			universeId: 1,
			placeId: 2,
			creator: { groupId: 3 },
			channels: { prod: "prod" },
			members: { "9": "owner" },
			devBadgeId: 77,
		});
		const next = applyProjectConfig(value, config!);
		expect(next.channels).toEqual({ prod: "prod" });
		expect(next.members).toEqual({ "9": "owner" });
		expect(next.devBadgeId).toBe(77);
		expect(next.revoked).toEqual({});
		expect(next.branches).toEqual(value.branches);
		expect(next.deployments).toEqual(value.deployments);
	});
});

describe("draft safety", () => {
	test("unwrapDraftEntries", () => {
		expect(unwrapDraftEntries({ a: { value: 1, description: "d" }, b: 2 })).toEqual({ a: 1, b: 2 });
	});
	test("our key never counts; equal values don't count", () => {
		expect(
			foreignDraftChanges({
				draftEntries: { TypeTorch: { x: 1 }, Speed: 5, Name: "same" },
				publishedEntries: { TypeTorch: {}, Speed: 4, Name: "same" },
			}),
		).toEqual(["Speed"]);
	});
	test("deletions (null) and new keys count", () => {
		expect(foreignDraftChanges({ draftEntries: { Gone: null, New: 1 }, publishedEntries: { Gone: 3 } })).toEqual(["Gone", "New"]);
	});
	test("JSON-string vs object encodings of the same value are equal", () => {
		expect(sameConfigValue('{"a":1}', { a: 1 })).toBe(true);
		expect(foreignDraftChanges({ draftEntries: { Cfg: '{"a":1}' }, publishedEntries: { Cfg: { a: 1 } } })).toEqual([]);
	});
	test("conditional rules in the draft count", () => {
		expect(
			foreignDraftChanges({ draftEntries: {}, publishedEntries: {}, draftRules: { rules: { r1: { tokens: [] } }, rulesOrder: ["r1"] } }),
		).toEqual(["(conditional rules)"]);
		expect(foreignDraftChanges({ draftEntries: {}, publishedEntries: {}, draftRules: {} })).toEqual([]);
	});
});

describe("history", () => {
	const registryRows = [dep(1), dep(2), dep(3, { branch: "prod", channel: "prod", artifactId: "prod-c000003" })];
	const local: LocalDeployment[] = [{ ...dep(2) }, { ...dep(4), registry: "unavailable" }];
	const rows = mergeDeployments(registryRows, local);

	test("merge keeps one row per deployment, registry first", () => {
		expect(rows.map((r) => [r.seq, r.source])).toEqual([
			[1, "registry"],
			[2, "both"],
			[3, "registry"],
			[4, "local"],
		]);
	});
	test("live head = highest seq per branch (registry head or any entry)", () => {
		const registry = recordDeployment(recordDeployment(emptyRegistry(), dep(1)), dep(2));
		const heads = liveHeads(registry, rows);
		expect(heads.get("dev")?.seq).toBe(4);
		expect(heads.get("prod")?.seq).toBe(3);
	});
	test("next seq spans registry and local log", () => {
		const registry = recordDeployment(emptyRegistry(), dep(9));
		expect(nextSeqFrom(registry, local)).toBe(10);
		expect(nextSeqFrom(undefined, local)).toBe(5);
		expect(nextSeqFrom(undefined, [])).toBe(1);
	});
	test("matchDeployment", () => {
		expect(matchDeployment(rows, "#2")?.seq).toBe(2);
		expect(matchDeployment(rows, String(100000003))?.seq).toBe(3);
		expect(matchDeployment(rows, "prod-c000003")?.seq).toBe(3);
		expect(matchDeployment(rows, "c000001")?.seq).toBe(1);
		expect(matchDeployment(rows, "c0000")?.seq).toBe(4); // newest prefix match
		expect(matchDeployment(rows, "c0000", "prod")?.seq).toBe(3); // preferred branch first
		expect(matchDeployment(rows, "zzz")).toBeUndefined();
	});
	test("previousDifferent skips the live artifact", () => {
		const withRollback = [...rows, { ...dep(5), artifactId: "dev-c000002", assetId: 100000002, action: "rollback" as const, source: "local" as const }];
		const head = liveHeads(undefined, withRollback).get("dev")!;
		expect(head.artifactId).toBe("dev-c000002");
		expect(previousDifferent(withRollback, "dev", head)?.seq).toBe(4);
	});
	test("table marks live heads", () => {
		const heads = liveHeads(undefined, rows);
		const text = formatDeploymentsTable(rows, heads);
		const lines = text.split("\n");
		expect(lines[0]).toContain("branch@commit");
		expect(lines.filter((l) => l.startsWith("*"))).toHaveLength(2);
		expect(text).toContain("[local]");
	});
});

describe("deploy entries and messages", () => {
	test("makeEntry takes seq and from from what is known", () => {
		const registry = recordDeployment(emptyRegistry(), dep(3));
		const entry = makeEntry(
			{
				action: "deploy",
				branch: "dev",
				by: "me",
				artifact: { artifactId: "dev-new0000", assetId: 5, channel: "dev", commit: "new0000", commitHash: "new", dirty: false },
			},
			registry,
			[{ ...dep(7) }],
		);
		expect(entry).toMatchObject({ seq: 8, action: "deploy", fromAssetId: dep(7).assetId, fromArtifactId: dep(7).artifactId, by: "me" });
	});
	test("first deploy on a branch has no from", () => {
		const entry = makeEntry(
			{ action: "deploy", branch: "x", by: "me", artifact: { artifactId: "a", assetId: 1, channel: "dev", commit: "c", commitHash: "h", dirty: false } },
			undefined,
			[],
		);
		expect(entry.seq).toBe(1);
		expect(entry.fromAssetId).toBeUndefined();
	});
	test("deploy message shape (kernel contract)", () => {
		const message = deployMessage({ b: "dev", a: 123, i: "dev-a1b2c3d", s: 7, c: "a1b2c3d", ch: "dev", t: 1000 });
		expect(JSON.stringify(message)).toBe('{"b":"dev","a":123,"i":"dev-a1b2c3d","s":7,"c":"a1b2c3d","ch":"dev","t":1000}');
		expect(deployMessage({ b: "dev", a: 1, i: "x", s: 1, c: "c", ch: "prod", t: 1, rollback: true }).r).toBe(1);
	});
	test("channel guard", () => {
		expect(() => checkChannelGuard({ branch: "prod", branchChannel: "prod", artifactChannel: "dev", dirty: false, force: false })).toThrow(/dev-channel/);
		expect(() => checkChannelGuard({ branch: "prod", branchChannel: "prod", artifactChannel: "prod", dirty: true, force: false })).toThrow(/dirty/);
		expect(() => checkChannelGuard({ branch: "prod", branchChannel: "prod", artifactChannel: "dev", dirty: true, force: true })).not.toThrow();
		expect(() => checkChannelGuard({ branch: "dev", branchChannel: "dev", artifactChannel: "dev", dirty: true, force: false })).not.toThrow();
	});
});
