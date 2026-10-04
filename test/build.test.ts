import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPayloadTree, stampProject } from "../src/build";
import { resolveKernelDir } from "../src/commands/kernel";
import type { Project } from "../src/config";

const payloadProject = {
	name: "TypeTorchPayload",
	globIgnorePaths: ["**/package.json"],
	tree: {
		$className: "Model",
		$attributes: { Keep: true },
		Server: { $path: "out/server" },
		Shared: { $path: "out/shared" },
		Client: { $path: "out/client" },
		include: { $path: "include" },
	},
};

describe("payload project", () => {
	test("stampProject merges $attributes on the root and keeps everything else", () => {
		const stamped = stampProject(payloadProject, { ArtifactId: "dev-a", KernelApi: 1 });
		expect(stamped.tree.$attributes).toEqual({ Keep: true, ArtifactId: "dev-a", KernelApi: 1 });
		expect(stamped.tree.Server).toEqual({ $path: "out/server" });
		expect(stamped.globIgnorePaths).toEqual(["**/package.json"]);
		expect(payloadProject.tree.$attributes).toEqual({ Keep: true }); // not mutated
	});
	test("checkPayloadTree", () => {
		expect(checkPayloadTree(payloadProject)).toEqual([]);
		expect(checkPayloadTree({ tree: { $className: "DataModel" } })).toHaveLength(5);
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
