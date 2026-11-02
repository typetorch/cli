import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildFlags, uploadFlags } from "../src/commands/build.ts";
import { deployFlags } from "../src/commands/deploy.ts";
import { COMPILER_HEADER, darkluaConfig, defineDev, packProject, remapProject, setsDev, shake } from "../src/pack.ts";

describe("defineDev", () => {
	it("empties a whole-line binding, keeping the line", () => {
		const out = defineDev("local a = 1\nlocal __DEV__ = ReactGlobals.__DEV__ :: boolean\nlocal b = 2\n");
		expect(out.split("\n")).toEqual(["local a = 1", "", "local b = 2", ""]);
		expect(defineDev("local __DEV__ = _G.__DEV__\n")).toBe("\n");
		expect(defineDev('local __DEV__ = require(Packages.Shared).ReactGlobals.__DEV__\n')).toBe("\n");
	});
	it("rewrites a bare field read and leaves longer expressions and writes alone", () => {
		expect(defineDev("if ReactGlobals.__DEV__ then")).toBe("if __DEV__ then");
		expect(defineDev("if (ReactGlobals :: any).__DEV__ then")).toBe("if __DEV__ then");
		expect(defineDev("f(require(x).ReactGlobals.__DEV__)")).toBe("f(require(x).ReactGlobals.__DEV__)");
		expect(defineDev("ReactGlobals.__DEV__ = true")).toBe("ReactGlobals.__DEV__ = true");
	});
	it("sees a game that sets the flag", () => {
		expect(setsDev("_G.__DEV__ = true")).toBe(true);
		expect(setsDev('_G["__DEV__"] = true')).toBe(true);
		expect(setsDev("if _G.__DEV__ == true then")).toBe(false);
	});
});

describe("shake", () => {
	const entry = (path: string, source = "") => ({ path, source });
	it("never drops a package, used or not", () => {
		expect(shake([entry("out/server/a.luau"), entry("node_modules/@rbxts/unused/init.luau"), entry("node_modules/@rbxts/x/y.story.luau")]).size).toBe(0);
	});
	it("drops a story nothing names, keeps a named one", () => {
		const dropped = shake([
			entry("out/client/ui/a.story.luau"),
			entry("out/client/ui/b.story.luau"),
			entry("out/client/x.luau", 'script.Parent.ui:FindFirstChild("b.story")'),
		]);
		expect([...dropped]).toEqual(["out/client/ui/a.story.luau"]);
	});
});

describe("packProject", () => {
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "tt-pack-"));
		const write = (path: string, text: string) => {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		};
		write("out/a.luau", "-- comment\nreturn 1\n");
		write("out/b.luau", "return 2\n");
		write("out/x.meta.json", "{}");
		write("out/skip.d.ts", "x");
		return { root, write };
	}
	/** Stands in for darklua: copies each batch, uppercased, and counts runs and files. */
	function fake(fail?: boolean) {
		const calls: number[] = [];
		const run = async (command: string[], cwd: string) => {
			if (fail) throw new Error("parse error");
			const input = join(cwd, command[4]);
			const output = join(cwd, command[5]);
			mkdirSync(output, { recursive: true });
			let files = 0;
			for (let at = 0; existsSync(join(input, `${at}.luau`)); at++) {
				writeFileSync(join(output, `${at}.luau`), readFileSync(join(input, `${at}.luau`), "utf8").toUpperCase());
				files++;
			}
			calls.push(files);
		};
		return { run, calls };
	}
	const project = { tree: { $className: "Model", Server: { $path: "out" } } };
	const options = (root: string, run: any) => ({ root, project, paths: ["out"], darklua: "darklua", darkluaVersion: "darklua 1", run });

	it("transforms every module once, one process for a small batch; a rebuild does nothing; a change redoes one", async () => {
		const { root, write } = fixture();
		const first = fake();
		const result = await packProject(options(root, first.run));
		expect(first.calls).toEqual([2]);
		expect(result.processed).toBe(2);
		expect(readFileSync(join(root, ".typetorch/pack/out/b.luau"), "utf8")).toBe("RETURN 2\n");
		expect(existsSync(join(root, ".typetorch/pack/out/x.meta.json"))).toBe(true);
		expect(existsSync(join(root, ".typetorch/pack/out/skip.d.ts"))).toBe(false);
		expect(result.project.tree.Server.$path).toBe(".typetorch/pack/out");

		const second = fake();
		const again = await packProject(options(root, second.run));
		expect(second.calls).toEqual([]);
		expect(again.processed).toBe(0);
		expect(readFileSync(join(root, ".typetorch/pack/out/b.luau"), "utf8")).toBe("RETURN 2\n");

		write("out/b.luau", "return 3\n");
		const third = fake();
		await packProject(options(root, third.run));
		expect(third.calls).toEqual([1]);
	});

	it("a darklua failure stops the build", async () => {
		const { root } = fixture();
		await expect(packProject(options(root, fake(true).run))).rejects.toThrow("parse error");
	});

	it("a game that sets __DEV__ turns the define stage off", async () => {
		const { root, write } = fixture();
		write("out/c.luau", "_G.__DEV__ = true\n");
		const result = await packProject(options(root, fake().run));
		expect(result.skipped.length).toBe(1);
	});

	it("keeps the compiler's header comment", () => {
		const rule = (darkluaConfig({ strip: true, define: false, shake: false }) as any).rules[0];
		expect(rule).toEqual({ rule: "remove_comments", except: [COMPILER_HEADER] });
		expect(new RegExp(COMPILER_HEADER).test("-- Compiled with roblox-ts v3.0.0")).toBe(true);
		expect(new RegExp(COMPILER_HEADER).test("-- a normal comment")).toBe(false);
	});

	it("keeps retain_lines whatever the stages", () => {
		expect((darkluaConfig({ strip: true, define: true, shake: true }) as any).generator).toBe("retain_lines");
		expect(remapProject({ tree: { a: { $path: "./x" } } }, "d").tree.a.$path).toBe("d/x");
	});
});

describe("--no-minify", () => {
	it("is a known flag wherever a payload is built", () => {
		for (const flags of [buildFlags, uploadFlags, deployFlags]) expect((flags as Record<string, string>)["no-minify"]).toBe("boolean");
	});
});
