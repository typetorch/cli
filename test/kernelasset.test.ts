/** The kernel package and the signed kernel pointer (kernelasset.ts; kernel 0.4.0 loader, plans/22). */
import { describe, expect, test } from "bun:test";
import { bakedSlotNode, LOADER_API, packageProject, PACKAGE_ROOT, pointerOf, pointerProblems, promoted, withPointer, type KernelPointer } from "../src/kernelasset";

const stamped = {
	name: "TypeTorchPlace",
	tree: {
		$className: "DataModel",
		HttpService: { $className: "HttpService", $properties: { HttpEnabled: true } },
		Workspace: { $className: "Workspace", Baseplate: { $className: "Part" } },
		ServerScriptService: {
			$className: "ServerScriptService",
			TypeTorchKernel: {
				$className: "Folder",
				$attributes: { KernelVersion: "0.4.0", KernelHash: "h", KeyAssetId: 1, FallbackPublicKey: "k", BootstrapHeads: "{}", BootScreen: "X" },
				Kernel: { $path: "/k/src/server/Kernel.server.luau" },
				Signing: { $path: "/k/src/server/Signing.luau" },
				Entry: { $path: "/k/src/server/Entry.server.luau", $properties: { Disabled: true } },
				vendor: { $path: "/k/src/server/vendor" },
			},
		},
		ReplicatedStorage: { $className: "ReplicatedStorage", TypeTorchKernelShared: { $className: "Folder", ClientEntry: { $path: "/k/src/shared/ClientEntry.client.luau" } } },
		ReplicatedFirst: { $className: "ReplicatedFirst", TypeTorchKernelClient: { $path: "/k/src/client/KernelClient.client.luau" } },
		ServerStorage: { $className: "ServerStorage", TypeTorchBackup: { $path: "/game/backup.rbxm" } },
	},
};
const POINTER: KernelPointer = { asset: 555, versionId: 777001, version: "0.4.0", hash: "a".repeat(64), loaderApi: 1, at: "2026-10-09T00:00:00.000Z" };

describe("the kernel package", () => {
	test("a Model with the three slots, every script disabled, identity on the root, no trust roots, no backup", () => {
		const project = packageProject(stamped, { version: "0.4.0", hash: "f".repeat(64), commit: "abc1234", api: 1 });
		expect(project.name).toBe(PACKAGE_ROOT);
		expect(project.tree.$className).toBe("Model");
		expect(project.tree.$attributes).toEqual({ KernelVersion: "0.4.0", KernelHash: "f".repeat(64), LoaderApi: LOADER_API, KernelCommit: "abc1234", KernelApi: 1 });
		const kernel = (project.tree.ServerScriptService as any).TypeTorchKernel;
		expect(kernel.$attributes).toEqual({ KernelVersion: "0.4.0", KernelHash: "h" });
		expect(kernel.Kernel.$properties).toEqual({ Disabled: true });
		expect(kernel.Entry.$properties).toEqual({ Disabled: true });
		expect(kernel.Signing.$properties).toBeUndefined();
		expect(kernel.vendor.$properties).toBeUndefined();
		expect((project.tree.ReplicatedFirst as any).TypeTorchKernelClient.$properties).toEqual({ Disabled: true });
		expect((project.tree.ReplicatedStorage as any).TypeTorchKernelShared.ClientEntry.$properties).toEqual({ Disabled: true });
		const text = JSON.stringify(project);
		for (const absent of ["TypeTorchBackup", "Baseplate", "HttpEnabled", "FallbackPublicKey", "KeyAssetId", "BootstrapHeads", "BootScreen"]) expect(text).not.toContain(absent);
		expect(() => packageProject({ tree: {} }, { version: "0.4.0", hash: "x" })).toThrow("no ServerScriptService.TypeTorchKernel");
	});

	test("the baked fallback kernel: the same slots under one Folder", () => {
		const baked = bakedSlotNode(stamped);
		expect(baked.$className).toBe("Folder");
		expect(Object.keys(baked).sort()).toEqual(["$className", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService"]);
		expect(JSON.stringify(baked)).not.toContain("FallbackPublicKey");
	});
});

describe("the kernel pointer in the settings record", () => {
	test("checked, set per channel, promoted dev -> prod", () => {
		expect(pointerProblems(POINTER)).toEqual([]);
		expect(pointerProblems({ ...POINTER, versionId: 0, hash: "x" })).toEqual(["versionId must be an asset version id", "hash must be the 64-hex kernel hash"]);
		const body = withPointer({ defaultBranch: "prod" } as { defaultBranch: string; kernel?: unknown }, "dev", POINTER);
		expect(pointerOf(body, "dev")).toEqual(POINTER);
		expect(pointerOf(body, "prod")).toBeUndefined();
		const now = new Date("2026-10-09T12:00:00.000Z");
		const both = promoted(body, now);
		expect(pointerOf(both, "prod")).toEqual({ ...POINTER, at: now.toISOString() });
		expect(pointerOf(both, "dev")).toEqual(POINTER);
		expect(() => promoted({ defaultBranch: "prod" } as { kernel?: unknown })).toThrow("no kernel.dev pointer");
		expect(() => withPointer({} as { kernel?: unknown }, "prod", { ...POINTER, asset: -1 })).toThrow("refusing a bad kernel pointer");
	});
});
