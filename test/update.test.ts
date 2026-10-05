/** `typetorch update`: how the CLI was installed, the command that updates it, version order, the registry read. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareVersions, detectInstall, latestVersion, updateCommand } from "../src/commands/update";

const root = mkdtempSync(join(tmpdir(), "tt-update-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const CLI = resolve(import.meta.dir, "..", "src", "index.ts");

/** A folder with node_modules/@typetorch/cli, and optionally a package.json and a lockfile. */
function installAt(dir: string, options: { pkg?: object; lock?: string } = {}): string {
	const cli = join(dir, "node_modules", "@typetorch", "cli");
	mkdirSync(cli, { recursive: true });
	writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@typetorch/cli", version: "0.6.0" }));
	if (options.pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(options.pkg));
	if (options.lock) writeFileSync(join(dir, options.lock), "");
	return cli;
}

describe("update: how the CLI was installed", () => {
	test("a game's devDependency with bun", () => {
		const game = join(root, "game-bun");
		const cli = installAt(game, { pkg: { devDependencies: { "@typetorch/cli": "^0.6.0" } }, lock: "bun.lock" });
		const install = detectInstall(cli);
		expect(install).toMatchObject({ kind: "project", dir: game.split("\\").join("/"), manager: "bun", dev: true });
		expect(updateCommand(install, "@typetorch/cli@0.7.0")).toEqual(["bun", "add", "-d", "@typetorch/cli@0.7.0"]);
	});

	test("a dependency with npm, pnpm or yarn from the lockfile", () => {
		for (const [lock, cmd] of [
			[undefined, ["npm", "install", "x"]],
			["pnpm-lock.yaml", ["pnpm", "add", "x"]],
			["yarn.lock", ["yarn", "add", "x"]],
		] as const) {
			const game = join(root, `game-${lock ?? "npm"}`);
			const cli = installAt(game, { pkg: { dependencies: { "@typetorch/cli": "*" } }, lock });
			expect(updateCommand(detectInstall(cli), "x")).toEqual([...cmd]);
		}
	});

	test("global installs: npm (no package.json), bun's global folder", () => {
		const npmGlobal = installAt(join(root, "npm-prefix"));
		expect(updateCommand(detectInstall(npmGlobal), "x")).toEqual(["npm", "install", "-g", "x"]);
		const bunHome = join(root, "bun-home");
		const bunGlobal = installAt(join(bunHome, "install", "global"), { pkg: { dependencies: {} } });
		const install = detectInstall(bunGlobal, { BUN_INSTALL: bunHome });
		expect(install).toMatchObject({ kind: "global", manager: "bun" });
		expect(updateCommand(install, "x")).toEqual(["bun", "add", "-g", "x"]);
	});

	test("npx, a git checkout, and a package.json that doesn't list the CLI have no update command", () => {
		const npx = installAt(join(root, "npm-cache", "_npx", "abc123"));
		expect(detectInstall(npx).kind).toBe("npx");
		const checkout = join(root, "cli-checkout");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		expect(detectInstall(checkout).kind).toBe("checkout");
		const hoisted = installAt(join(root, "workspace"), { pkg: { workspaces: ["games/*"] } });
		expect(detectInstall(hoisted).kind).toBe("unknown");
		for (const dir of [npx, checkout, hoisted]) expect(updateCommand(detectInstall(dir), "x")).toBeUndefined();
	});
});

describe("update: versions", () => {
	test("order: numbers, then a pre-release below its release", () => {
		expect(compareVersions("0.6.0", "0.7.0")).toBe(-1);
		expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
		expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
	});

	test("the registry's latest tag", async () => {
		const fake = (async (url: string) => {
			expect(String(url)).toContain("@typetorch%2fcli");
			return new Response(JSON.stringify({ "dist-tags": { latest: "0.7.0" } }));
		}) as unknown as typeof fetch;
		expect(await latestVersion(fake)).toBe("0.7.0");
		const missing = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
		await expect(latestVersion(missing)).rejects.toThrow("404");
	});

	test("a bad version argument is a usage error", () => {
		const result = Bun.spawnSync(["bun", CLI, "update", "latest-please"], { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("is not a version");
	});
});
