import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "../src/args";
import {
	absolutePaths,
	kernelConstants,
	kernelContentHash,
	KernelCheckError,
	kernelIdentity,
	stampKernelProject,
	versionProblems,
} from "../src/commands/kernel";
import type { Project } from "../src/config";
import { parseDotEnv, Settings, useSettings } from "../src/env";
import { setOutputMode } from "../src/log";

afterEach(() => useSettings(undefined));

function sh(cwd: string, ...cmd: string[]) {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function kernelDir(version = "0.3.0", constantsVersion = version): string {
	const dir = mkdtempSync(join(tmpdir(), "tt-kernel-"));
	mkdirSync(join(dir, "src", "shared"), { recursive: true });
	mkdirSync(join(dir, "src", "server"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@typetorch/kernel", version, typetorch: { kernelApi: 1 } }));
	writeFileSync(join(dir, "src", "shared", "Constants.luau"), `return {\n\tKERNEL_API = 1,\n\tKERNEL_VERSION = "${constantsVersion}",\n}\n`);
	writeFileSync(join(dir, "src", "server", "Kernel.server.luau"), "print('kernel')\r\n");
	writeFileSync(
		join(dir, "place.project.json"),
		JSON.stringify({ name: "P", tree: { $className: "DataModel", ServerScriptService: { $className: "ServerScriptService", TypeTorchKernel: { $className: "Folder", Kernel: { $path: "src/server/Kernel.server.luau" } } } } }),
	);
	return dir;
}

describe("kernel identity (S-L5)", () => {
	test("constants and version agreement", () => {
		expect(kernelConstants('KERNEL_API = 1,\n\tKERNEL_VERSION = "0.2.2",')).toEqual({ version: "0.2.2", api: 1 });
		expect(versionProblems({ version: "0.2.0", typetorch: { kernelApi: 1 } }, { version: "0.2.2", api: 1 })).toEqual([
			"package.json version 0.2.0 != Constants.luau KERNEL_VERSION 0.2.2",
		]);
		expect(versionProblems({ version: "0.2.2", typetorch: { kernelApi: 2 } }, { version: "0.2.2", api: 1 })).toHaveLength(1);
		expect(versionProblems({ version: "0.2.2" }, { version: "0.2.2", api: 1 })).toEqual([]);
	});
	test("the content hash ignores line endings and changes with any source", () => {
		const a = kernelDir();
		const b = kernelDir();
		writeFileSync(join(b, "src", "server", "Kernel.server.luau"), "print('kernel')\n");
		expect(kernelContentHash(a)).toEqual(kernelContentHash(b));
		writeFileSync(join(b, "src", "server", "Kernel.server.luau"), "print('kernel 2')\n");
		expect(kernelContentHash(a).hash).not.toBe(kernelContentHash(b).hash);
	});
	test("a package kernel: version and hash; a version mismatch is refused", () => {
		const proj = { root: mkdtempSync(join(tmpdir(), "tt-game-")), config: {} } as unknown as Project;
		const identity = kernelIdentity(proj, kernelDir(), { allowDirty: false, allowUntagged: false });
		expect(identity).toMatchObject({ version: "0.3.0", api: 1, source: "package", files: 3 });
		expect(identity.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(() => kernelIdentity(proj, kernelDir("0.3.0", "0.3.1"), { allowDirty: false, allowUntagged: false })).toThrow(KernelCheckError);
	});
	test("a git checkout must be clean and tagged v<version>", () => {
		const dir = kernelDir();
		sh(dir, "git", "init", "-q", "-b", "main");
		sh(dir, "git", "config", "user.email", "t@example.invalid");
		sh(dir, "git", "config", "user.name", "t");
		sh(dir, "git", "add", "-A");
		sh(dir, "git", "commit", "-q", "-m", "kernel");
		const proj = { root: mkdtempSync(join(tmpdir(), "tt-game-")), config: {} } as unknown as Project;
		expect(() => kernelIdentity(proj, dir, { allowDirty: false, allowUntagged: false })).toThrow(/not tagged v0.3.0/);
		expect(kernelIdentity(proj, dir, { allowDirty: false, allowUntagged: true }).tag).toBeUndefined();
		sh(dir, "git", "update-ref", "refs/tags/v0.3.0", "HEAD"); // a lightweight tag
		expect(kernelIdentity(proj, dir, { allowDirty: false, allowUntagged: false })).toMatchObject({ source: "git", tag: "v0.3.0", dirty: false });
		writeFileSync(join(dir, "src", "server", "Kernel.server.luau"), "print('changed')\n");
		expect(() => kernelIdentity(proj, dir, { allowDirty: false, allowUntagged: false })).toThrow(/uncommitted/);
	});
	test("the stamped place project: absolute $paths and identity attributes on the kernel slot", () => {
		const dir = kernelDir();
		const project = JSON.parse(readFileSync(join(dir, "place.project.json"), "utf8"));
		const { project: stamped, stamped: ok } = stampKernelProject(project, dir, { KernelVersion: "0.3.0", SigningPublicKey: "abc" });
		expect(ok).toBe(true);
		const slot = stamped.tree.ServerScriptService.TypeTorchKernel;
		expect(slot.$attributes).toEqual({ KernelVersion: "0.3.0", SigningPublicKey: "abc" });
		expect(slot.Kernel.$path).toBe(join(dir, "src/server/Kernel.server.luau").replace(/\\/g, "/"));
		expect(project.tree.ServerScriptService.TypeTorchKernel.$attributes).toBeUndefined(); // not mutated
		expect(absolutePaths({ a: [{ $path: "x" }] }, "/k")).toEqual({ a: [{ $path: resolve("/k", "x").replace(/\\/g, "/") }] });
	});
});
