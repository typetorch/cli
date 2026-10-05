import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPayloadContents, lz4Block, RbxmError, readRbxm, setRootAttributes, writeRbxm, writeSingleInstanceRbxm } from "../src/rbxm";

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

/** The chunks of a file: name and raw bytes (header + payload), to compare what an edit left untouched. */
function chunksOf(bytes: Uint8Array): { name: string; raw: Uint8Array }[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: { name: string; raw: Uint8Array }[] = [];
	let offset = 32;
	while (offset < bytes.length) {
		const name = new TextDecoder().decode(bytes.subarray(offset, offset + 4)).replace(/\0+$/, "");
		const compressed = view.getUint32(offset + 4, true);
		const length = view.getUint32(offset + 8, true);
		const end = offset + 16 + (compressed || length);
		out.push({ name, raw: bytes.subarray(offset, end) });
		offset = end;
		if (name === "END") break;
	}
	return out;
}

describe("rbxm writer and root attributes (hot assets)", () => {
	test("writeRbxm: several classes, parents and string/number/boolean attributes read back", () => {
		for (const compression of ["lz4", "zstd", "none"] as const) {
			const bytes = writeRbxm(
				[
					{ className: "Folder", name: "Shop", parent: -1, attributes: { TypeTorchAsset: "ui/shop" } },
					{ className: "Frame", name: "Card", parent: 0, attributes: { Price: 5.5, Sale: true } },
					{ className: "Folder", name: "Icons", parent: 0 },
					{ className: "ImageLabel", name: "Coin", parent: 2 },
				],
				{ compression },
			);
			const instances = readRbxm(bytes);
			const byName = Object.fromEntries(instances.map((i) => [i.name, i]));
			expect(instances.map((i) => `${i.className}:${i.name}`).sort()).toEqual(["Folder:Icons", "Folder:Shop", "Frame:Card", "ImageLabel:Coin"]);
			expect(byName.Shop.parent).toBe(-1);
			expect(byName.Card.parent).toBe(byName.Shop.referent);
			expect(byName.Coin.parent).toBe(byName.Icons.referent);
			expect(byName.Shop.attributes).toEqual({ TypeTorchAsset: "ui/shop" });
			expect(byName.Card.attributes).toEqual({ Price: 5.5, Sale: true });
			expect(byName.Icons.attributes).toBeUndefined();
		}
		expect(() => writeRbxm([{ className: "Folder", name: "x", parent: 3 }])).toThrow(RbxmError);
		expect(() => writeRbxm([{ className: "Folder", name: "x", parent: -1, attributes: { n: Number.NaN } }])).toThrow(RbxmError);
	});
	test("setRootAttributes on a Rojo-built model: the root gains them, every other chunk stays byte for byte", () => {
		const before = fixture("payload-attributes.rbxm");
		const after = setRootAttributes(before, { TypeTorchAssetId: 123456789012345, TypeTorchAssetHash: "abc123def456" });
		const root = readRbxm(after).find((i) => i.parent === -1)!;
		expect(root.attributes).toMatchObject({ ArtifactId: "12b63b9-3fa91c", KernelApi: 1, TypeTorchAssetId: 123456789012345, TypeTorchAssetHash: "abc123def456" });
		expect(readRbxm(after).map((i) => `${i.className}:${i.name}:${i.parent}`)).toEqual(readRbxm(before).map((i) => `${i.className}:${i.name}:${i.parent}`));
		const a = chunksOf(before);
		const b = chunksOf(after);
		expect(b.map((c) => c.name)).toEqual(a.map((c) => c.name));
		const changed = a.filter((chunk, i) => Buffer.compare(Buffer.from(chunk.raw), Buffer.from(b[i].raw)) !== 0);
		expect(changed.map((c) => c.name)).toEqual(["PROP"]);
		expect(Buffer.compare(Buffer.from(after.subarray(0, 32)), Buffer.from(before.subarray(0, 32)))).toBe(0);
	});
	test("setRootAttributes adds the AttributesSerialize chunk when the root's class has none", () => {
		const before = fixture("payload-ok.rbxm");
		const after = setRootAttributes(before, { TypeTorchAssetHash: "0123456789ab" });
		expect(chunksOf(after).filter((c) => c.name === "PROP")).toHaveLength(chunksOf(before).filter((c) => c.name === "PROP").length + 1);
		expect(readRbxm(after).find((i) => i.parent === -1)!.attributes).toEqual({ TypeTorchAssetHash: "0123456789ab" });
		expect(checkPayloadContents(after)).toEqual(checkPayloadContents(before));
	});
	test("setRootAttributes: zstd chunks, other instances of the root's class keep their attributes", () => {
		const bytes = writeRbxm(
			[
				{ className: "Folder", name: "Shop", parent: -1, attributes: { TypeTorchAsset: "ui/shop" } },
				{ className: "Folder", name: "Inner", parent: 0, attributes: { Keep: "me" } },
			],
			{ compression: "zstd" },
		);
		const after = readRbxm(setRootAttributes(bytes, { TypeTorchAssetId: 42 }));
		expect(after.find((i) => i.name === "Shop")!.attributes).toEqual({ TypeTorchAsset: "ui/shop", TypeTorchAssetId: 42 });
		expect(after.find((i) => i.name === "Inner")!.attributes).toEqual({ Keep: "me" });
	});
	test("setRootAttributes refuses two roots and an attribute the root already has", () => {
		const twoRoots = writeRbxm([
			{ className: "Folder", name: "A", parent: -1 },
			{ className: "Folder", name: "B", parent: -1 },
		]);
		expect(() => setRootAttributes(twoRoots, { X: 1 })).toThrow(/one root/);
		const stamped = writeSingleInstanceRbxm({ className: "Model", name: "M", attributes: { TypeTorchAssetHash: "old" } });
		expect(() => setRootAttributes(stamped, { TypeTorchAssetHash: "new" })).toThrow(/already has/);
	});
});
