import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoIdCollision,
	BuildError,
	checkPayloadTree,
	ignoredSourceFiles,
	projectPaths,
	readSources,
	sourceCandidates,
	stampProject,
	unexplainedOutputs,
	type PayloadMeta,
} from "../src/build";
import { withLocal } from "../src/commands/common";
import { resolveKernelDir } from "../src/commands/kernel";
import { release } from "../src/commands/release";
import type { Project } from "../src/config";
import { appendLocalLog, readLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { Stopwatch } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import { withStateLock } from "../src/state";

afterEach(() => useSettings(undefined));

const payloadProject = {
	name: "TypeTorchPayload",
	globIgnorePaths: ["**/package.json"],
	tree: {
		$className: "Model",
		$attributes: { Keep: true },
		Server: { $path: "out/server" },
		Shared: { $path: "out/shared" },
		Client: { $path: "out/client" },
		include: { $path: "include", node_modules: { $className: "Folder", "@rbxts": { $path: "node_modules/@rbxts" } } },
	},
};

function sh(cwd: string, ...cmd: string[]) {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

describe("payload project", () => {
	test("stampProject merges $attributes on the root and keeps everything else", () => {
		const stamped = stampProject(payloadProject, { ArtifactId: "a1b2c3d-3fa91c", KernelApi: 1 });
		expect(stamped.tree.$attributes).toEqual({ Keep: true, ArtifactId: "a1b2c3d-3fa91c", KernelApi: 1 });
		expect(stamped.tree.Server).toEqual({ $path: "out/server" });
		expect(stamped.globIgnorePaths).toEqual(["**/package.json"]);
		expect(payloadProject.tree.$attributes).toEqual({ Keep: true }); // not mutated
	});
	test("stampProject stamps existing child nodes too (Assets on Server), keeping their $path and $attributes", () => {
		const project = { ...payloadProject, tree: { ...payloadProject.tree, Server: { $path: "out/server", $attributes: { Own: 1 } } } };
		const stamped = stampProject(project, { ArtifactId: "x" }, { Server: { Assets: '{"v":1,"assets":{}}' }, Missing: { A: 1 } });
		expect(stamped.tree.Server).toEqual({ $path: "out/server", $attributes: { Own: 1, Assets: '{"v":1,"assets":{}}' } });
		expect(stamped.tree.Missing).toBeUndefined();
		expect(stamped.tree.Shared).toEqual({ $path: "out/shared" });
		expect(stamped.tree.$attributes).toEqual({ Keep: true, ArtifactId: "x" });
		expect(project.tree.Server.$attributes).toEqual({ Own: 1 }); // not mutated
	});
	test("checkPayloadTree", () => {
		expect(checkPayloadTree(payloadProject)).toEqual([]);
		expect(checkPayloadTree({ tree: { $className: "DataModel" } })).toHaveLength(5);
	});
	test("projectPaths lists every $path", () => {
		expect(projectPaths(payloadProject)).toEqual(["out/server", "out/shared", "out/client", "include", "node_modules/@rbxts"]);
	});
});

describe("resolveKernelDir", () => {
	test("falls back from node_modules to ../kernel", () => {
		const parent = mkdtempSync(join(tmpdir(), "tt-kernel-"));
		const root = join(parent, "game");
		mkdirSync(join(parent, "kernel"), { recursive: true });
		mkdirSync(root);
		writeFileSync(join(parent, "kernel", "place.project.json"), "{}");
		const proj = { root, config: {} } as unknown as Project;
		expect(resolveKernelDir(proj)).toBe(join(parent, "kernel"));
		expect(() => resolveKernelDir(proj, "nope")).toThrow(/place.project.json/);
	});
});

describe("clean builds (S-M3)", () => {
	test("sourceCandidates maps compiled files back to sources", () => {
		expect(sourceCandidates("server/boot.luau")).toContain("server/boot.ts");
		expect(sourceCandidates("shared/thing.server.luau")).toContain("shared/thing.server.ts");
		expect(sourceCandidates("client/ui/init.luau")).toEqual(expect.arrayContaining(["client/ui/index.ts", "client/ui/index.tsx", "client/ui/init.luau"]));
		expect(sourceCandidates("shared/data.json")).toEqual(["shared/data.json"]);
	});

	function repo() {
		const root = mkdtempSync(join(tmpdir(), "tt-clean-"));
		sh(root, "git", "init", "-q", "-b", "main");
		sh(root, "git", "config", "user.email", "t@example.invalid");
		sh(root, "git", "config", "user.name", "t");
		writeFileSync(join(root, ".gitignore"), "out/\ninclude/\nnode_modules/\nsrc/shared/build.ts\nsrc/secret.ts\nsrc/*.log\n");
		mkdirSync(join(root, "src", "server"), { recursive: true });
		mkdirSync(join(root, "src", "shared"), { recursive: true });
		writeFileSync(join(root, "src", "server", "boot.ts"), "export {};\n");
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "out" } }));
		sh(root, "git", "add", "-A");
		sh(root, "git", "commit", "-q", "-m", "init");
		return root;
	}

	test("ignored files in source dirs are found; generated build.ts and non-payload files are not", () => {
		const root = repo();
		writeFileSync(join(root, "src", "shared", "build.ts"), "// generated\n");
		writeFileSync(join(root, "src", "debug.log"), "noise\n");
		expect(ignoredSourceFiles(root, payloadProject)).toEqual([]);
		writeFileSync(join(root, "src", "secret.ts"), "export const X = 1;\n");
		expect(ignoredSourceFiles(root, payloadProject)).toEqual(["src/secret.ts"]);
	});

	test("compiled files must come from tracked sources (or the generated build.ts)", () => {
		const root = repo();
		mkdirSync(join(root, "out", "server"), { recursive: true });
		mkdirSync(join(root, "out", "shared"), { recursive: true });
		writeFileSync(join(root, "out", "server", "boot.luau"), "return nil\n");
		writeFileSync(join(root, "out", "shared", "build.luau"), "return nil\n");
		writeFileSync(join(root, "out", "tsconfig.tsbuildinfo"), "{}");
		expect(unexplainedOutputs(root)).toEqual([]);
		writeFileSync(join(root, "out", "server", "stray.luau"), "return nil\n");
		expect(unexplainedOutputs(root)).toEqual(["out/server/stray.luau"]);
	});
});

describe("sources", () => {
	test("from the packages manifest, else the installed package version", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-sources-"));
		mkdirSync(join(root, ".typetorch", "packages"), { recursive: true });
		mkdirSync(join(root, "node_modules", "@typetorch", "kernel"), { recursive: true });
		writeFileSync(join(root, "node_modules", "@typetorch", "kernel", "package.json"), JSON.stringify({ version: "0.2.0" }));
		writeFileSync(
			join(root, ".typetorch", "packages", "manifest.json"),
			JSON.stringify({ schema: 1, packages: { framework: { commit: "9a6547f0000000", dirty: true } } }),
		);
		expect(readSources(root, { commit: "12b63b9", dirty: false })).toEqual({ template: "12b63b9", framework: "9a6547f*", kernel: "v0.2.0" });
		expect(readSources(root, { commit: "", dirty: true }).template).toBe("uncommitted*");
	});
});

describe("id collisions (deploy --no-build)", () => {
	const A = "a".repeat(64);
	const B = "b".repeat(64);
	const meta = { artifactId: "12b63b9-aaaaaa", sha256: A, dirty: false } as PayloadMeta;
	test("a new id or the same bytes pass; the same id with other recorded bytes is refused", () => {
		expect(() => assertNoIdCollision(meta, [])).not.toThrow();
		expect(() => assertNoIdCollision(meta, [{ artifactId: "12b63b9-aaaaaa", sha256: A }])).not.toThrow();
		expect(() => assertNoIdCollision(meta, [{ artifactId: "12b63b9-aaaaaa", sha256: B }])).toThrow(BuildError);
		// legacy entries without a sha256 never block (their ids have another shape anyway)
		expect(() => assertNoIdCollision(meta, [{ artifactId: "12b63b9-aaaaaa" }])).not.toThrow();
	});
});

describe("release: one seq source, signed messages", () => {
	const artifact = { artifactId: "12b63b9-3fa91c", assetId: 5, channel: "dev" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false };

	function setup(stateDir?: string) {
		const root = mkdtempSync(join(tmpdir(), "tt-release-"));
		useSettings(new Settings({ startDir: root, env: stateDir ? { TYPETORCH_STATE_DIR: stateDir } : {} }));
		const proj = { root, config: { project: "game", universeId: 42 } } as unknown as Project;
		const published: string[] = [];
		const oc = { publishMessage: async (_u: number, _t: string, message: string) => void published.push(message) } as unknown as OpenCloud;
		return { root, proj, oc, published };
	}

	test("a worktree and the main repo share one state dir, so seqs never collide", async () => {
		const shared = mkdtempSync(join(tmpdir(), "tt-state-"));
		appendLocalLog(shared, { ...artifact, seq: 14, at: "2026-10-04T12:00:00.000Z", action: "deploy", branch: "dev", by: "me", universeId: 42 });
		const main = setup(shared);
		const first = await release({ proj: main.proj, oc: main.oc, history: withLocal(main.proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		const worktree = setup(shared); // a different checkout, same TYPETORCH_STATE_DIR
		const second = await release({ proj: worktree.proj, oc: worktree.oc, history: withLocal(worktree.proj), action: "deploy", branch: "dev", artifact: { ...artifact, assetId: 6, artifactId: "12b63b9-000001" }, by: "claude", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		expect([first.entry.seq, second.entry.seq]).toEqual([15, 16]);
		expect(readLocalLog(shared, 42).map((e) => e.seq)).toEqual([14, 15, 16]);
		expect(readFileSync(join(shared, "deployments.jsonl"), "utf8")).toContain('"event":"published"');
	});

	test("concurrent releases from one state dir take distinct seqs (lock)", async () => {
		const shared = mkdtempSync(join(tmpdir(), "tt-state-"));
		const a = setup(shared);
		const runs = [0, 1, 2].map((i) =>
			release({ proj: a.proj, oc: a.oc, history: withLocal(a.proj), action: "deploy", branch: "dev", artifact: { ...artifact, assetId: 10 + i }, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" }),
		);
		const seqs = (await Promise.all(runs)).map((r) => r.entry.seq).sort();
		expect(seqs).toEqual([1, 2, 3]);
	});

	test("messages are unsigned {b,a,i,s,c,ch,t,r}; the entry keeps t and r", async () => {
		const { proj, oc, published } = setup();
		const result = await release({ proj, oc, history: withLocal(proj), action: "rollback", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		const message = JSON.parse(published[0]);
		expect(Object.keys(message)).toEqual(["b", "a", "i", "s", "c", "ch", "t", "r"]);
		expect(message.r).toBe(1);
		expect(result.entry).toMatchObject({ t: message.t, r: 1 });
		expect(result.entry).not.toHaveProperty("sig");
	});

	test("CLI 0.8: no registry is written; the local log says registry skipped, and a failed publish logs nothing", async () => {
		const { proj, oc } = setup();
		const result = await release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		expect(result.registry).toBe("skipped");
		const failing = { publishMessage: async () => { throw new Error("messaging down"); } } as unknown as OpenCloud;
		await expect(
			release({ proj, oc: failing, history: withLocal(proj), action: "deploy", branch: "dev", artifact: { ...artifact, assetId: 7 }, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" }),
		).rejects.toThrow(/messaging down/);
		expect(readLocalLog(join(proj.root, ".typetorch")).map((e) => e.seq)).toEqual([1]);
	});
});

describe("state lock", () => {
	test("a stale lock is taken over; a live one makes the next holder wait", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-lock-"));
		const order: string[] = [];
		const first = withStateLock(dir, "a", async () => {
			order.push("a start");
			await Bun.sleep(300);
			order.push("a end");
		});
		await Bun.sleep(50);
		const second = withStateLock(dir, "b", async () => void order.push("b"));
		await Promise.all([first, second]);
		expect(order).toEqual(["a start", "a end", "b"]);
		writeFileSync(join(dir, "deploy.lock"), "{}");
		await withStateLock(dir, "c", async () => void order.push("c"), { staleMs: -1 });
		expect(order.at(-1)).toBe("c");
		writeFileSync(join(dir, "deploy.lock"), "{}");
		await expect(withStateLock(dir, "d", async () => {}, { waitMs: 100 })).rejects.toThrow(/another deploy holds/);
	});
});
