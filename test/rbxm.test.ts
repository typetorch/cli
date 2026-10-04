import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPayloadContents, lz4Block, RbxmError, readRbxm } from "../src/rbxm";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

describe("rbxm reader (S-L4)", () => {
	test("lz4 block: literals and an overlapping match", () => {
		// token 0x1f: 1 literal "a", match length 15+4=19... use a short one: token 0x13 = 1 literal, match 3+4=7
		const block = new Uint8Array([0x13, 0x61, 0x01, 0x00, 0x10, 0x62]); // "a" + 7x copy offset 1 + literal "b"
		expect(new TextDecoder().decode(lz4Block(block, 9))).toBe("aaaaaaaab");
		expect(() => lz4Block(new Uint8Array([0x10, 0x61, 0x05, 0x00]), 6)).toThrow(RbxmError);
	});
	test("reads classes, names and parents from a Rojo-built model", () => {
		const instances = readRbxm(fixture("payload-ok.rbxm"));
		const names = instances.map((i) => `${i.className}:${i.name}`).sort();
		expect(names).toEqual(["Folder:Shared", "Model:TypeTorchPayload", "ModuleScript:a", "ModuleScript:b"]);
		const root = instances.find((i) => i.className === "Model")!;
		expect(root.parent).toBe(-1);
		expect(instances.find((i) => i.name === "Shared")!.parent).toBe(root.referent);
	});
	test("a payload of Folders and ModuleScripts passes", () => {
		expect(checkPayloadContents(fixture("payload-ok.rbxm"))).toEqual({ instances: 4, modules: 2, disallowed: [], rootProblems: [] });
	});
	test("Scripts and other classes are listed with their paths", () => {
		const result = checkPayloadContents(fixture("payload-scripts.rbxm"));
		expect(result.disallowed.sort()).toEqual(["TypeTorchPayload/Server/note (StringValue)", "TypeTorchPayload/Server/run (Script)"]);
		expect(result.modules).toBe(1);
	});
	test("reads the root's attributes (strings and numbers), e.g. the Notes JSON", () => {
		const root = readRbxm(fixture("payload-attributes.rbxm")).find((i) => i.className === "Model")!;
		expect(root.attributes?.ArtifactId).toBe("12b63b9-3fa91c");
		expect(root.attributes?.KernelApi).toBe(1);
		expect(JSON.parse(String(root.attributes?.Notes))).toEqual({ v: 1, message: "hi", changes: ["template: x"], sources: { template: "12b63b9" }, built: "t", branch: "dev" });
	});
	test("not an rbxm", () => expect(() => readRbxm(new TextEncoder().encode("<roblox xmlns"))).toThrow(RbxmError));
});
