/** `typetorch remote-claude`: finds @typetorch/dev-server and runs it with the same arguments and exit code. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findDevServer } from "../src/commands/remote-claude";

const root = mkdtempSync(join(tmpdir(), "tt-remote-claude-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const CLI = resolve(import.meta.dir, "..", "src", "index.ts");

/** A fake dev-server package: its bin prints its arguments as JSON and exits 7. */
function fakeDevServer(dir: string, options: { name?: string; src?: boolean; dist?: boolean } = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: options.name ?? "@typetorch/dev-server", version: "0.2.0", bin: { "typetorch-dev-server": "dist/index.js" } }));
	const body = "console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n";
	if (options.dist !== false) {
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "dist", "index.js"), body);
	}
	if (options.src) {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "index.ts"), body);
	}
}

describe("remote-claude: finding the dev-server", () => {
	test("installed in the game repo (node_modules here or in a parent)", () => {
		const repo = join(root, "game");
		fakeDevServer(join(repo, "node_modules", "@typetorch", "dev-server"));
		mkdirSync(join(repo, "src"), { recursive: true });
		const found = findDevServer({ cwd: join(repo, "src"), cliRoot: join(root, "elsewhere", "cli"), env: {} });
		expect("cmd" in found && found.cmd).toEqual([process.execPath, join(repo, "node_modules", "@typetorch", "dev-server", "dist", "index.js")]);
	});

	test("next to the CLI: the npm layout (global install, npx with both packages)", () => {
		const modules = join(root, "prefix", "node_modules", "@typetorch");
		fakeDevServer(join(modules, "dev-server"));
		const found = findDevServer({ cwd: join(root, "empty"), cliRoot: join(modules, "cli"), env: {} });
		expect("cmd" in found && found.label).toBe(join(modules, "dev-server", "dist", "index.js"));
	});

	test("a sibling checkout: Bun runs its src/index.ts (no build needed)", () => {
		const checkout = join(root, "checkout");
		fakeDevServer(join(checkout, "dev-server"), { src: true, dist: false });
		const found = findDevServer({ cwd: join(root, "empty"), cliRoot: join(checkout, "cli"), env: {} });
		expect("cmd" in found && found.cmd).toEqual([process.execPath, join(checkout, "dev-server", "src", "index.ts")]);
	});

	test("another package with the folder name is ignored; nothing found lists the places searched", () => {
		const other = join(root, "other");
		fakeDevServer(join(other, "dev-server"), { name: "dev-server" });
		const found = findDevServer({ cwd: join(root, "empty2"), cliRoot: join(other, "cli"), env: {} });
		expect("searched" in found).toBe(true);
		if ("searched" in found) {
			expect(found.searched).toContain(join(other, "dev-server"));
			expect(found.searched).toContain(join(root, "empty2", "node_modules", "@typetorch", "dev-server"));
		}
	});

	test("TYPETORCH_DEV_SERVER wins", () => {
		const entry = join(root, "custom", "server.js");
		mkdirSync(join(root, "custom"), { recursive: true });
		writeFileSync(entry, "");
		const found = findDevServer({ cwd: root, cliRoot: join(root, "checkout", "cli"), env: { TYPETORCH_DEV_SERVER: entry } });
		expect("cmd" in found && found.cmd).toEqual([process.execPath, entry]);
		expect("searched" in findDevServer({ cwd: root, cliRoot: root, env: { TYPETORCH_DEV_SERVER: join(root, "nope.js") } })).toBe(true);
	});
});

describe("remote-claude: running it", () => {
	test("passes every argument through and exits with the dev-server's code", () => {
		const repo = join(root, "game-run");
		fakeDevServer(join(repo, "node_modules", "@typetorch", "dev-server"));
		const args = ["--users", "1,2", "--env-file", "a b.env", "--help", "--branch=x"];
		const result = Bun.spawnSync(["bun", CLI, "remote-claude", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		expect(JSON.parse(result.stdout.toString())).toEqual(["remote-claude", ...args]);
		expect(result.exitCode).toBe(7);
	});

	test("typetorch dev is the same command", () => {
		const repo = join(root, "game-dev-alias");
		fakeDevServer(join(repo, "node_modules", "@typetorch", "dev-server"));
		const result = Bun.spawnSync(["bun", CLI, "dev", "--users", "1"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		expect(JSON.parse(result.stdout.toString())).toEqual(["remote-claude", "--users", "1"]);
		expect(result.exitCode).toBe(7);
	});

	test("not installed: a clear error, exit 1", () => {
		const result = Bun.spawnSync(["bun", CLI, "remote-claude", "--users", "1"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, TYPETORCH_DEV_SERVER: join(root, "missing.js") },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("@typetorch/dev-server is not installed");
		expect(result.stderr.toString()).toContain("npm i -g @typetorch/dev-server");
	});

	test("typetorch help remote-claude describes it", () => {
		const result = Bun.spawnSync(["bun", CLI, "help", "remote-claude"], { stdout: "pipe", stderr: "pipe" });
		expect(result.stdout.toString()).toContain("typetorch remote-claude --users");
	});
});
