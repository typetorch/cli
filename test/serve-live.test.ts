/** typetorch serve runs the game's "live" script by default (when it has one); --no-live turns it off. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraScripts } from "../src/commands/serve";

const dir = mkdtempSync(join(tmpdir(), "tt-serve-live-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const repo = (name: string, scripts: Record<string, string>) => {
	const root = join(dir, name);
	Bun.spawnSync(["mkdir", "-p", root]);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
	return root;
};
const args = (flags: Record<string, string | boolean>) => ({ positionals: [], flags }) as never;

describe("serve's live script", () => {
	const withLive = repo("with", { live: "bun x live", lint: "x" });
	const without = repo("without", { lint: "x" });

	test("on by default when the game has one, off when it hasn't", () => {
		expect(extraScripts(args({}), withLive)).toEqual(["live"]);
		expect(extraScripts(args({}), without)).toEqual([]);
		expect(extraScripts(args({ with: "lint" }), withLive)).toEqual(["lint", "live"]);
	});

	test("--no-live turns it off, --live still asks for it explicitly", () => {
		expect(extraScripts(args({ "no-live": true }), withLive)).toEqual([]);
		expect(extraScripts(args({ "no-live": true, with: "live,lint" }), withLive)).toEqual(["lint"]);
		expect(extraScripts(args({ live: true }), without)).toEqual(["live"]); // serve then says package.json has no "live" script
		expect(() => extraScripts(args({ live: true, "no-live": true }), withLive)).toThrow("pick one");
	});
});
