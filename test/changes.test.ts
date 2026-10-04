import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeLines, cleanLine, parseStamp } from "../src/changes";
import { assetDescription, parseAssetDescription } from "../src/naming";

function sh(cwd: string, ...cmd: string[]) {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function repo(name: string, commits: string[]): { dir: string; hashes: string[] } {
	const dir = mkdtempSync(join(tmpdir(), `tt-${name}-`));
	sh(dir, "git", "init", "-q", "-b", "main");
	sh(dir, "git", "config", "user.email", "t@example.invalid");
	sh(dir, "git", "config", "user.name", "t");
	const hashes: string[] = [];
	commits.forEach((subject, i) => {
		writeFileSync(join(dir, "f.txt"), String(i));
		sh(dir, "git", "add", "-A");
		sh(dir, "git", "commit", "-q", "-m", subject);
		hashes.push(sh(dir, "git", "rev-parse", "HEAD"));
	});
	return { dir, hashes };
}

describe("what changed", () => {
	test("cleanLine strips control characters and long text", () => {
		expect(cleanLine("a\u0007b\nc\td")).toBe("a b c d");
		expect(cleanLine("x".repeat(200))).toHaveLength(120);
	});
	test("parseStamp", () => {
		expect(parseStamp("9a6547f*")).toEqual({ commit: "9a6547f", dirty: true });
		expect(parseStamp("9a6547f")).toEqual({ commit: "9a6547f", dirty: false });
		expect(parseStamp("v0.2.0")).toBeUndefined();
	});

	test("message, template commits since the previous deploy, framework and kernel commits", () => {
		const game = repo("game", ["one", "two", "three", "four"]);
		const framework = repo("fw", ["fw a", "fw b", "fw c"]);
		const kernel = repo("k", ["k a"]);
		const lines = changeLines({
			root: game.dir,
			branch: "dev",
			message: "make coins spin",
			git: { commitHash: game.hashes[3], commit: game.hashes[3].slice(0, 7), dirty: false },
			sources: { template: game.hashes[3].slice(0, 7), framework: `${framework.hashes[2].slice(0, 7)}*`, kernel: kernel.hashes[0].slice(0, 7) },
			previous: { commitHash: game.hashes[1], sources: { framework: framework.hashes[0].slice(0, 7), kernel: kernel.hashes[0].slice(0, 7) } },
			repos: { framework: framework.dir, kernel: kernel.dir },
		});
		expect(lines).toEqual([
			"make coins spin",
			"template: four",
			"template: three",
			"framework: fw c",
			"framework: fw b",
			"framework: uncommitted changes",
		]);
	});

	test("at most 5 per source and 8 in all; the largest group gives way", () => {
		const game = repo("many", Array.from({ length: 9 }, (_, i) => `game ${i}`));
		const framework = repo("fwmany", Array.from({ length: 9 }, (_, i) => `fw ${i}`));
		const lines = changeLines({
			root: game.dir,
			branch: "dev",
			message: "note",
			git: { commitHash: game.hashes[8], commit: "", dirty: true },
			sources: { template: "x", framework: framework.hashes[8].slice(0, 7) },
			previous: { commitHash: game.hashes[0], sources: { framework: framework.hashes[0].slice(0, 7) } },
			repos: { framework: framework.dir },
		});
		expect(lines).toHaveLength(8);
		expect(lines[0]).toBe("note");
		expect(lines.filter((l) => l.startsWith("template: "))).toHaveLength(4);
		expect(lines.filter((l) => l.startsWith("framework: "))).toHaveLength(3);
	});

	test("first deploy, and a rebuild with nothing new", () => {
		const game = repo("same", ["only"]);
		const git = { commitHash: game.hashes[0], commit: game.hashes[0].slice(0, 7), dirty: false };
		expect(changeLines({ root: game.dir, branch: "dev", git })).toEqual(["first deploy of dev"]);
		expect(changeLines({ root: game.dir, branch: "dev", git, previous: { commitHash: game.hashes[0] } })).toEqual(["rebuild, no source changes"]);
	});
});

describe("asset description with changes", () => {
	const base = {
		artifactId: "a1b2c3d-3fa91c",
		commitHash: "a1b2c3d".padEnd(40, "0"),
		branch: "dev",
		channel: "dev" as const,
		dirty: false,
		builtAt: "2026-10-04T00:00:00.000Z",
		sha256: "f".repeat(64),
	};
	test("identity, ---, change lines; parseable", () => {
		const text = assetDescription({ ...base, changes: ["make coins spin", "template: four"] });
		expect(text.split("\n").slice(-3)).toEqual(["---", "make coins spin", "template: four"]);
		const parsed = parseAssetDescription(text);
		expect(parsed.identity.artifact).toBe("a1b2c3d-3fa91c");
		expect(parsed.changes).toEqual(["make coins spin", "template: four"]);
	});
	test("at most 1000 characters: change lines are cut, identity lines never", () => {
		const changes = Array.from({ length: 8 }, (_, i) => `template: ${String(i).repeat(150)}`);
		const text = assetDescription({ ...base, ciUrl: `https://github.com/x/y/actions/runs/${"9".repeat(20)}`, changes });
		expect(text.length).toBeLessThanOrEqual(1000);
		const parsed = parseAssetDescription(text);
		expect(parsed.identity.sha256).toBe(base.sha256);
		expect(parsed.identity.ci).toContain("actions/runs");
		expect(parsed.changes.length).toBeGreaterThan(0);
		expect(parsed.changes.length).toBeLessThan(8);
	});
	test("control characters are removed", () => {
		const text = assetDescription({ ...base, changes: ["evil\u0000line\u001b[31m", "two\rparts"] });
		expect(parseAssetDescription(text).changes).toEqual(["evil line [31m", "two parts"]);
		expect(text).not.toMatch(/[\u0000\u001b\r]/);
	});
});
