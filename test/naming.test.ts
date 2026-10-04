import { describe, expect, test } from "bun:test";
import {
	artifactId,
	artifactRevision,
	assetDescription,
	assetDisplayName,
	branchChannel,
	branchFromGit,
	branchNameError,
	buildFileSource,
	chooseRevision,
	compareEarlier,
	latestRevision,
	revisionArtifactId,
	strictest,
} from "../src/naming";

describe("branchFromGit", () => {
	test("uses the mapping first", () => {
		expect(branchFromGit("main", { main: "prod" })).toBe("prod");
	});
	test("lowercases and turns / into -", () => {
		expect(branchFromGit("feature/Login-Flow")).toBe("feature-login-flow");
		expect(branchFromGit("Dev")).toBe("dev");
	});
});

describe("branchNameError", () => {
	test("accepts valid names", () => {
		for (const name of ["prod", "dev", "feature-x", "release.1", "a_b", "0x"]) expect(branchNameError(name)).toBeUndefined();
	});
	test("rejects invalid names", () => {
		for (const name of ["", "Feature", "-x", "a b", "a/b", "x".repeat(65)]) expect(branchNameError(name)).toBeString();
	});
});

describe("channels", () => {
	const config = { defaultBranch: "prod", channels: { staging: "prod" as const, prod: "prod" as const } };
	test("configured channel wins", () => expect(branchChannel(config, "staging")).toBe("prod"));
	test("default branch is prod", () => expect(branchChannel({ defaultBranch: "main", channels: {} }, "main")).toBe("prod"));
	test("everything else is dev", () => expect(branchChannel(config, "feature-x")).toBe("dev"));
	test("strictest", () => {
		expect(strictest("dev", undefined)).toBe("dev");
		expect(strictest("dev", "prod")).toBe("prod");
	});
});

describe("artifactId", () => {
	test("clean", () => expect(artifactId({ channel: "dev", commit: "a1b2c3d", dirty: false })).toBe("dev-a1b2c3d"));
	test("dirty uses 6 hex of the sha256", () =>
		expect(artifactId({ channel: "prod", commit: "a1b2c3d", dirty: true, sha256: "abcdef0123" })).toBe("prod-a1b2c3d-dirty-abcdef"));
	test("no commits", () =>
		expect(artifactId({ channel: "dev", commit: "", dirty: true, sha256: "123456ff" })).toBe("dev-uncommitted-dirty-123456"));
	test("dirty without hash throws", () => expect(() => artifactId({ channel: "dev", commit: "a", dirty: true })).toThrow());
});

describe("revisions", () => {
	const base = "dev-12b63b9";
	const A = "a".repeat(64);
	const B = "b".repeat(64);
	const C = "c".repeat(64);

	test("revisionArtifactId: revision 1 is the base id, then .r<N>", () => {
		expect(revisionArtifactId(base, 1)).toBe(base);
		expect(revisionArtifactId(base, 2)).toBe("dev-12b63b9.r2");
		expect(revisionArtifactId(base, 12)).toBe("dev-12b63b9.r12");
	});
	test("ids stay within [a-z0-9.-]", () => expect(revisionArtifactId(base, 3)).toMatch(/^[a-z0-9.-]+$/));
	test("artifactRevision parses only the base's family", () => {
		expect(artifactRevision(base, base)).toBe(1);
		expect(artifactRevision("dev-12b63b9.r2", base)).toBe(2);
		expect(artifactRevision("dev-12b63b9.r10", base)).toBe(10);
		for (const other of ["prod-12b63b9", "dev-12b63b9-dirty-abcdef", "dev-12b63b9.r", "dev-12b63b9.r02", "dev-12b63b9.rx", "dev-12b63b90", "dev-12b63b9.r2.r3"]) {
			expect(artifactRevision(other, base)).toBeUndefined();
		}
	});
	test("compareEarlier: new, same, different; a missing sha256 counts as different", () => {
		expect(compareEarlier(base, A, [])).toBe("new");
		expect(compareEarlier(base, A, [{ artifactId: "dev-other00", sha256: B }])).toBe("new");
		expect(compareEarlier(base, A, [{ artifactId: base, sha256: A }])).toBe("same");
		expect(compareEarlier(base, A, [{ artifactId: base, sha256: A }, { artifactId: base, sha256: A }])).toBe("same");
		expect(compareEarlier(base, A, [{ artifactId: base, sha256: B }])).toBe("different");
		expect(compareEarlier(base, A, [{ artifactId: base }])).toBe("different");
		// the id already went out with two payloads: never "same", even if one matches
		expect(compareEarlier(base, A, [{ artifactId: base, sha256: A }, { artifactId: base, sha256: B }])).toBe("different");
	});
	test("latestRevision: the highest revision of the family", () => {
		expect(latestRevision(base, [])).toBeUndefined();
		expect(latestRevision(base, [{ artifactId: "prod-12b63b9" }])).toBeUndefined();
		expect(latestRevision(base, [{ artifactId: base }])).toEqual({ artifactId: base, revision: 1 });
		const earlier = [{ artifactId: "dev-12b63b9.r3" }, { artifactId: base }, { artifactId: "dev-12b63b9.r2" }];
		expect(latestRevision(base, earlier)).toEqual({ artifactId: "dev-12b63b9.r3", revision: 3 });
	});
	test("chooseRevision: first deploy of a commit keeps the base id", () => {
		expect(chooseRevision({ base, stampedId: base, sha256: A, earlier: [] })).toEqual({ artifactId: base, revision: 1 });
		expect(chooseRevision({ base, stampedId: base, sha256: A, earlier: [{ artifactId: "prod-12b63b9", sha256: B }] })).toEqual({
			artifactId: base,
			revision: 1,
		});
	});
	test("chooseRevision: identical bytes reuse the id (no-op redeploy)", () => {
		expect(chooseRevision({ base, stampedId: base, sha256: A, earlier: [{ artifactId: base, sha256: A }] })).toEqual({ artifactId: base, revision: 1 });
		const earlier = [{ artifactId: base, sha256: A }, { artifactId: "dev-12b63b9.r2", sha256: B }];
		expect(chooseRevision({ base, stampedId: "dev-12b63b9.r2", sha256: B, earlier })).toEqual({ artifactId: "dev-12b63b9.r2", revision: 2 });
	});
	test("chooseRevision: different bytes get the next free revision", () => {
		expect(chooseRevision({ base, stampedId: base, sha256: A, earlier: [{ artifactId: base, sha256: B }] })).toEqual({
			artifactId: "dev-12b63b9.r2",
			revision: 2,
		});
		const earlier = [{ artifactId: base, sha256: A }, { artifactId: "dev-12b63b9.r2", sha256: B }];
		expect(chooseRevision({ base, stampedId: "dev-12b63b9.r2", sha256: C, earlier })).toEqual({ artifactId: "dev-12b63b9.r3", revision: 3 });
		// gaps don't matter: one above the highest seen
		expect(chooseRevision({ base, stampedId: "dev-12b63b9.r5", sha256: C, earlier: [{ artifactId: "dev-12b63b9.r5", sha256: A }] }).artifactId).toBe(
			"dev-12b63b9.r6",
		);
	});
	test("chooseRevision: old log entries without sha256 count as different (dev-12b63b9 deployed twice -> .r2)", () => {
		const earlier = [
			{ artifactId: base, assetId: 134192491895548, seq: 4 },
			{ artifactId: "prod-12b63b9", assetId: 138576381221184, seq: 5 },
			{ artifactId: base, assetId: 128470902397525, seq: 6 },
		];
		expect(chooseRevision({ base, stampedId: base, sha256: A, earlier })).toEqual({ artifactId: "dev-12b63b9.r2", revision: 2 });
	});
	test("chooseRevision: an id that went out with two payloads is never reused", () => {
		const earlier = [{ artifactId: base, sha256: A }, { artifactId: base, sha256: B }];
		expect(chooseRevision({ base, stampedId: base, sha256: A, earlier }).artifactId).toBe("dev-12b63b9.r2");
	});
});

describe("assetDisplayName", () => {
	const base = { commit: "a1b2c3d", dirty: false, channel: "dev" as const, impliedChannel: "dev" as const };
	test("tt-<branch>-<commit>", () => expect(assetDisplayName({ ...base, branch: "main" })).toBe("tt-main-a1b2c3d"));
	test("dirty suffix", () => expect(assetDisplayName({ ...base, branch: "dev", dirty: true })).toBe("tt-dev-a1b2c3d-dirty"));
	test("channel only when it differs from the branch's", () => {
		expect(assetDisplayName({ ...base, branch: "prod", channel: "dev", impliedChannel: "prod" })).toBe("tt-prod-a1b2c3d-dev");
		expect(assetDisplayName({ ...base, branch: "prod", channel: "prod", impliedChannel: "prod" })).toBe("tt-prod-a1b2c3d");
	});
	test("only [a-z0-9-] and at most 50 chars, commit kept", () => {
		const name = assetDisplayName({ ...base, branch: "Feature.With_Odd__Chars-and-a-very-long-name-that-goes-on", dirty: true });
		expect(name).toMatch(/^[a-z0-9-]+$/);
		expect(name.length).toBeLessThanOrEqual(50);
		expect(name.endsWith("-a1b2c3d-dirty")).toBe(true);
		expect(name).not.toContain("--");
	});
	test("uncommitted", () => expect(assetDisplayName({ ...base, branch: "dev", commit: "", dirty: true })).toBe("tt-dev-uncommitted-dirty"));
	test("revision suffix -r<N> (2+ only)", () => {
		expect(assetDisplayName({ ...base, branch: "dev", revision: 2 })).toBe("tt-dev-a1b2c3d-r2");
		expect(assetDisplayName({ ...base, branch: "dev", revision: 1 })).toBe("tt-dev-a1b2c3d");
		expect(assetDisplayName({ ...base, branch: "prod", channel: "dev", impliedChannel: "prod", revision: 3 })).toBe("tt-prod-a1b2c3d-r3-dev");
		const long = assetDisplayName({ ...base, branch: "feature-with-a-very-long-name-that-goes-on-and-on", revision: 12 });
		expect(long).toMatch(/^[a-z0-9-]+$/);
		expect(long.length).toBeLessThanOrEqual(50);
		expect(long.endsWith("-a1b2c3d-r12")).toBe(true);
	});
});

describe("assetDescription", () => {
	test("one key=value per line", () => {
		const text = assetDescription({
			artifactId: "dev-a1b2c3d",
			commitHash: "a1b2c3d4",
			branch: "dev",
			channel: "dev",
			dirty: false,
			builtAt: "2026-10-04T00:00:00.000Z",
			sha256: "ff",
		});
		expect(text.split("\n")).toEqual([
			"artifact=dev-a1b2c3d",
			"commit=a1b2c3d4",
			"branch=dev",
			"channel=dev",
			"dirty=false",
			"built=2026-10-04T00:00:00.000Z",
			"sha256=ff",
		]);
	});
	test("ci line when present", () => {
		const text = assetDescription({ artifactId: "a", commitHash: "", branch: "b", channel: "dev", dirty: true, builtAt: "t", sha256: "s", ciUrl: "https://ci" });
		expect(text).toContain("commit=uncommitted");
		expect(text.endsWith("ci=https://ci")).toBe(true);
	});
});

test("buildFileSource is the exact generated file", () => {
	expect(buildFileSource({ dirty: false, channel: "dev", builtAt: "2026-10-04T12:00:00.000Z" })).toBe(
		[
			"// Generated by `typetorch build`. Do not edit.",
			'import { $compileTime, $git } from "rbxts-transform-debug";',
			'import type { BuildInfo } from "@typetorch/framework";',
			'const GIT = $git("Branch", "Commit");',
			'export const BUILD: BuildInfo = { branch: GIT.Branch, commit: GIT.Commit, dirty: false, channel: "dev", builtAt: $compileTime() };',
			"// 2026-10-04T12:00:00.000Z",
			"",
		].join("\n"),
	);
});
