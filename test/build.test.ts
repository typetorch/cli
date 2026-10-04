import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotRedeployedWithOtherBytes, BuildError, checkPayloadTree, stampProject, type PayloadMeta } from "../src/build";
import { withLocal } from "../src/commands/common";
import { resolveKernelDir } from "../src/commands/kernel";
import { release } from "../src/commands/release";
import type { Project } from "../src/config";
import { appendLocalLog, readLocalLog } from "../src/deployments";
import { Stopwatch } from "../src/log";
import { chooseRevision } from "../src/naming";
import type { OpenCloud } from "../src/opencloud";

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

describe("revisions in the deploy flow", () => {
	const A = "a".repeat(64);
	const B = "b".repeat(64);
	const meta = (patch: Partial<PayloadMeta> = {}): PayloadMeta => ({
		artifactId: "dev-12b63b9.r2",
		revision: 2,
		project: "game",
		channel: "dev",
		branch: "dev",
		gitBranch: "master",
		commit: "12b63b9",
		commitHash: "12b63b94e060baa26bf19aaf0b5416f65bbafa28",
		dirty: false,
		builtAt: "2026-10-04T12:00:00.000Z",
		bytes: 10,
		sha256: A,
		kernelApi: 1,
		file: ".typetorch/payload.rbxm",
		...patch,
	});

	test("--no-build: a new id or identical bytes deploy; other or unknown bytes under the same id are refused", () => {
		expect(() => assertNotRedeployedWithOtherBytes(meta(), [])).not.toThrow();
		expect(() => assertNotRedeployedWithOtherBytes(meta(), [{ artifactId: "dev-12b63b9.r2", sha256: A }])).not.toThrow();
		expect(() => assertNotRedeployedWithOtherBytes(meta(), [{ artifactId: "dev-12b63b9.r2", sha256: B }])).toThrow(BuildError);
		expect(() => assertNotRedeployedWithOtherBytes(meta(), [{ artifactId: "dev-12b63b9.r2" }])).toThrow(/build again/);
	});
	test("--no-build: dirty ids are named by their own hash and never refused", () => {
		const dirty = meta({ artifactId: "dev-12b63b9-dirty-abcdef", dirty: true, revision: undefined });
		expect(() => assertNotRedeployedWithOtherBytes(dirty, [{ artifactId: "dev-12b63b9-dirty-abcdef" }])).not.toThrow();
	});

	test("the deploy log line records sha256 and agrees with the message; the next build of the commit then picks .r3", async () => {
		const root = mkdtempSync(join(tmpdir(), "tt-revision-"));
		const proj = { root, config: { project: "game", universeId: 42 } } as unknown as Project;
		// an old entry (no sha256) for the base id, like deploys #4 and #6 of dev-12b63b9
		appendLocalLog(root, {
			seq: 4,
			at: "2026-10-04T12:22:48.536Z",
			action: "deploy",
			branch: "dev",
			channel: "dev",
			artifactId: "dev-12b63b9",
			assetId: 134192491895548,
			commit: "12b63b9",
			commitHash: meta().commitHash,
			dirty: false,
			by: "me",
			universeId: 42,
		});
		const published: string[] = [];
		const oc = { publishMessage: async (_u: number, _t: string, message: string) => void published.push(message) } as unknown as OpenCloud;
		const m = meta();
		const result = await release({
			proj,
			oc,
			history: withLocal(proj, undefined, "test"),
			action: "deploy",
			branch: "dev",
			artifact: { artifactId: m.artifactId, assetId: 5, channel: m.channel, commit: m.commit, commitHash: m.commitHash, dirty: false },
			by: "me",
			force: false,
			watch: new Stopwatch(),
			extra: { sha256: m.sha256 },
		});
		expect(JSON.parse(published[0]!).i).toBe("dev-12b63b9.r2");
		expect(result.entry).toMatchObject({ seq: 5, artifactId: "dev-12b63b9.r2", sha256: A, fromArtifactId: "dev-12b63b9" });

		const logged = readLocalLog(root, 42);
		expect(logged.map((e) => [e.artifactId, e.sha256])).toEqual([
			["dev-12b63b9", undefined],
			["dev-12b63b9.r2", A],
		]);
		// identical bytes stamped .r2 -> keep .r2; any other bytes -> .r3
		expect(chooseRevision({ base: "dev-12b63b9", stampedId: "dev-12b63b9.r2", sha256: A, earlier: logged }).artifactId).toBe("dev-12b63b9.r2");
		expect(chooseRevision({ base: "dev-12b63b9", stampedId: "dev-12b63b9.r2", sha256: B, earlier: logged }).artifactId).toBe("dev-12b63b9.r3");
	});
});
