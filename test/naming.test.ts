import { describe, expect, test } from "bun:test";
import {
	artifactId,
	assetDisplayName,
	branchChannel,
	branchFromGit,
	branchNameError,
	buildFileSource,
	compareEarlier,
	formatSources,
	parseArtifactId,
	provisionalArtifactId,
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

describe("artifact ids: <commit7>[-dirty]-<hash6>", () => {
	const sha = "3fa91c0123456789";
	test("clean", () => expect(artifactId({ commit: "12b63b9", dirty: false, sha256: sha })).toBe("12b63b9-3fa91c"));
	test("dirty", () => expect(artifactId({ commit: "12b63b9", dirty: true, sha256: sha })).toBe("12b63b9-dirty-3fa91c"));
	test("no commits", () => expect(artifactId({ commit: "", dirty: true, sha256: sha })).toBe("uncommitted-dirty-3fa91c"));
	test("no channel and no revision in the id", () => expect(artifactId({ commit: "12b63b9", dirty: false, sha256: sha })).toMatch(/^[0-9a-f]{7}-[0-9a-f]{6}$/));
	test("a hash is required", () => expect(() => artifactId({ commit: "12b63b9", dirty: false, sha256: "" })).toThrow());
	test("the provisional id is the id without its hash", () => {
		expect(provisionalArtifactId({ commit: "12b63b9", dirty: false })).toBe("12b63b9");
		expect(provisionalArtifactId({ commit: "12b63b9", dirty: true })).toBe("12b63b9-dirty");
		expect(provisionalArtifactId({ commit: "", dirty: false })).toBe("uncommitted-dirty");
	});
	test("ids use only [a-z0-9-]", () => expect(artifactId({ commit: "12b63b9", dirty: true, sha256: sha })).toMatch(/^[a-z0-9-]+$/));
});

describe("parseArtifactId reads every id the CLI ever wrote", () => {
	test("new ids", () => {
		expect(parseArtifactId("12b63b9-3fa91c")).toEqual({ format: "hash", commit: "12b63b9", dirty: false, hash: "3fa91c" });
		expect(parseArtifactId("12b63b9-dirty-3fa91c")).toEqual({ format: "hash", commit: "12b63b9", dirty: true, hash: "3fa91c" });
		expect(parseArtifactId("uncommitted-dirty-3fa91c")).toMatchObject({ format: "hash", commit: "", dirty: true });
	});
	test("legacy ids", () => {
		expect(parseArtifactId("dev-12b63b9")).toMatchObject({ format: "legacy", channel: "dev", commit: "12b63b9", dirty: false });
		expect(parseArtifactId("prod-12b63b9.r2")).toMatchObject({ format: "legacy", channel: "prod", revision: 2 });
		expect(parseArtifactId("dev-12b63b9-dirty-abcdef")).toMatchObject({ format: "legacy", dirty: true, hash: "abcdef" });
		expect(parseArtifactId("asset-75496329079219")).toEqual({ format: "asset", assetId: 75496329079219 });
	});
	test("anything else", () => expect(parseArtifactId("hello").format).toBe("unknown"));
});

describe("compareEarlier", () => {
	const id = "12b63b9-3fa91c";
	const A = "a".repeat(64);
	const B = "b".repeat(64);
	test("new, same, different; a missing sha256 counts as different", () => {
		expect(compareEarlier(id, A, [])).toBe("new");
		expect(compareEarlier(id, A, [{ artifactId: "12b63b9-000000", sha256: B }])).toBe("new");
		expect(compareEarlier(id, A, [{ artifactId: id, sha256: A }])).toBe("same");
		expect(compareEarlier(id, A, [{ artifactId: id, sha256: B }])).toBe("different");
		expect(compareEarlier(id, A, [{ artifactId: id }])).toBe("different");
	});
});

describe("assetDisplayName", () => {
	const base = { artifactId: "a1b2c3d-3fa91c", channel: "dev" as const, impliedChannel: "dev" as const };
	test("tt-<branch>-<artifactId>", () => expect(assetDisplayName({ ...base, branch: "main" })).toBe("tt-main-a1b2c3d-3fa91c"));
	test("dirty ids", () => expect(assetDisplayName({ ...base, artifactId: "a1b2c3d-dirty-3fa91c", branch: "dev" })).toBe("tt-dev-a1b2c3d-dirty-3fa91c"));
	test("channel only when it differs from the branch's", () => {
		expect(assetDisplayName({ ...base, branch: "prod", channel: "dev", impliedChannel: "prod" })).toBe("tt-prod-a1b2c3d-3fa91c-dev");
		expect(assetDisplayName({ ...base, branch: "prod", channel: "prod", impliedChannel: "prod" })).toBe("tt-prod-a1b2c3d-3fa91c");
	});
	test("only [a-z0-9-] and at most 50 chars, the id kept", () => {
		const name = assetDisplayName({ ...base, artifactId: "a1b2c3d-dirty-3fa91c", branch: "Feature.With_Odd__Chars-and-a-very-long-name-that-goes-on" });
		expect(name).toMatch(/^[a-z0-9-]+$/);
		expect(name.length).toBeLessThanOrEqual(50);
		expect(name.endsWith("-a1b2c3d-dirty-3fa91c")).toBe(true);
		expect(name).not.toContain("--");
	});
	test("uncommitted", () => expect(assetDisplayName({ ...base, artifactId: "uncommitted-dirty-3fa91c", branch: "dev" })).toBe("tt-dev-uncommitted-dirty-3fa91c"));
});

describe("sources", () => {
	test("formatSources", () => {
		expect(formatSources({ template: "12b63b9", framework: "9a6547f*", kernel: "v0.2.0" })).toBe("template 12b63b9, framework 9a6547f*, kernel v0.2.0");
		expect(formatSources({ template: "12b63b9" })).toBe("template 12b63b9");
		expect(formatSources(undefined)).toBe("");
	});
});

test("buildFileSource is the exact generated file (BUILD unchanged, SOURCES added)", () => {
	expect(
		buildFileSource({ dirty: false, channel: "dev", builtAt: "2026-10-04T12:00:00.000Z", sources: { template: "12b63b9", framework: "9a6547f*" } }),
	).toBe(
		[
			"// Generated by `typetorch build`. Do not edit.",
			'import { $compileTime, $git } from "rbxts-transform-debug";',
			'import type { BuildInfo } from "@typetorch/framework";',
			'const GIT = $git("Branch", "Commit");',
			'export const BUILD: BuildInfo = { branch: GIT.Branch, commit: GIT.Commit, dirty: false, channel: "dev", builtAt: $compileTime() };',
			'export const SOURCES: { readonly template?: string; readonly framework?: string; readonly kernel?: string } = { template: "12b63b9", framework: "9a6547f*" };',
			"// 2026-10-04T12:00:00.000Z",
			"",
		].join("\n"),
	);
});
