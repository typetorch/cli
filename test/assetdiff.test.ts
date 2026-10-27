import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_DIR, diffAsset, keepBaselines, MAX_ENTRIES, MAX_PROPS, readBaseline, readTree, type AssetDiffEntry } from "../src/assetdiff";
import { concatBytes, encodeChunk, fileHeader, Writer, writeRbxm, type RbxmWriteInstance } from "../src/rbxm";

// A hand-built model with real property chunks (writeRbxm writes only Name and attributes) --------------------------

type Prop = { name: string; type: number; values: (w: Writer, count: number) => void };

interface Klass {
	className: string;
	names: string[];
	/** Referents, in order. */
	referents: number[];
	props: Prop[];
}

function interleavedU32(w: Writer, values: number[]) {
	for (let plane = 0; plane < 4; plane++) for (const v of values) w.u8((v >>> (8 * (3 - plane))) & 0xff);
}

const zigzag = (v: number) => ((v << 1) ^ (v >> 31)) >>> 0;

function robloxFloat(f: number): number {
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, f);
	const u = view.getUint32(0);
	return ((u << 1) | (u >>> 31)) >>> 0;
}

const ints = (values: number[]): Prop["values"] => (w) => interleavedU32(w, values.map(zigzag));
const floats = (values: number[]): Prop["values"] => (w) => interleavedU32(w, values.map(robloxFloat));
const strings = (values: string[]): Prop["values"] => (w) => values.forEach((v) => w.string(v));
const bools = (values: boolean[]): Prop["values"] => (w) => values.forEach((v) => w.u8(v ? 1 : 0));
const enums = (values: number[]): Prop["values"] => (w) => interleavedU32(w, values);
const vector3s = (values: [number, number, number][]): Prop["values"] => (w) => {
	for (let axis = 0; axis < 3; axis++) interleavedU32(w, values.map((v) => robloxFloat(v[axis])));
};
const udim2s = (values: [number, number, number, number][]): Prop["values"] => (w) => {
	interleavedU32(w, values.map((v) => robloxFloat(v[0])));
	interleavedU32(w, values.map((v) => robloxFloat(v[2])));
	interleavedU32(w, values.map((v) => zigzag(v[1])));
	interleavedU32(w, values.map((v) => zigzag(v[3])));
};
const refs = (values: number[]): Prop["values"] => (w) => w.referents(values);
const cframes = (values: { pos: [number, number, number]; rot: number }[]): Prop["values"] => (w) => {
	for (const v of values) w.u8(v.rot);
	for (let axis = 0; axis < 3; axis++) interleavedU32(w, values.map((v) => robloxFloat(v.pos[axis])));
};
const raw = (bytes: number[]): Prop["values"] => (w) => w.bytes(bytes);

function model(classes: Klass[], parents: Record<number, number>): Uint8Array {
	const chunks: Uint8Array[] = [];
	let instances = 0;
	for (const [classId, k] of classes.entries()) {
		const inst = new Writer();
		inst.u32(classId);
		inst.string(k.className);
		inst.u8(0);
		inst.u32(k.referents.length);
		inst.referents(k.referents);
		chunks.push(encodeChunk("INST", inst.done(), "lz4"));
		instances += k.referents.length;
	}
	for (const [classId, k] of classes.entries()) {
		for (const prop of [{ name: "Name", type: 0x01, values: strings(k.names) }, ...k.props]) {
			const w = new Writer();
			w.u32(classId);
			w.string(prop.name);
			w.u8(prop.type);
			prop.values(w, k.referents.length);
			chunks.push(encodeChunk("PROP", w.done(), "lz4"));
		}
	}
	const prnt = new Writer();
	const all = classes.flatMap((k) => k.referents);
	prnt.u8(0);
	prnt.u32(all.length);
	prnt.referents(all);
	prnt.referents(all.map((r) => parents[r] ?? -1));
	chunks.push(encodeChunk("PRNT", prnt.done(), "lz4"));
	chunks.push(encodeChunk("END", new TextEncoder().encode("</roblox>"), "none"));
	return concatBytes([fileHeader(classes.length, instances), ...chunks]);
}

/** A Model "Rig" (referent 0) holding Parts (referents 1..) with the given properties. */
function rig(parts: { name: string; size: [number, number, number]; anchored: boolean; material: number; pos: [number, number, number]; shape?: string }[], extra: Prop[] = []): Uint8Array {
	const referents = parts.map((_, i) => i + 1);
	return model(
		[
			{ className: "Model", names: ["Rig"], referents: [0], props: [{ name: "PrimaryPart", type: 0x13, values: refs([1]) }] },
			{
				className: "Part",
				names: parts.map((p) => p.name),
				referents,
				props: [
					{ name: "Size", type: 0x0e, values: vector3s(parts.map((p) => p.size)) },
					{ name: "Anchored", type: 0x02, values: bools(parts.map((p) => p.anchored)) },
					{ name: "Material", type: 0x12, values: enums(parts.map((p) => p.material)) },
					{ name: "CFrame", type: 0x10, values: cframes(parts.map((p) => ({ pos: p.pos, rot: 2 }))) },
					{ name: "Transparency", type: 0x04, values: floats(parts.map(() => 0.5)) },
					{ name: "CollisionGroupId", type: 0x03, values: ints(parts.map((_, i) => i * 7 - 3)) },
					{ name: "Shape", type: 0x01, values: strings(parts.map((p) => p.shape ?? "Block")) },
					{ name: "UniqueId", type: 0x1f, values: raw(parts.flatMap((_, i) => Array.from({ length: 16 }, (_, k) => (i * 31 + k) & 0xff))) },
					...extra,
				],
			},
		],
		Object.fromEntries(referents.map((r) => [r, 0])),
	);
}

const PART = { name: "Torso", size: [2, 2, 1] as [number, number, number], anchored: true, material: 256, pos: [0, 3, 0] as [number, number, number] };
const LEG = { name: "Leg", size: [1, 2, 1] as [number, number, number], anchored: false, material: 272, pos: [0.5, 1, 0] as [number, number, number] };

const tree = (instances: RbxmWriteInstance[]) => writeRbxm(instances);
const entryKeys = (entries: AssetDiffEntry[]) => entries.map((e) => `${e.kind} ${e.path} (${e.className})`);

describe("readTree: instances with their decoded properties", () => {
	test("paths from the root, same-named siblings numbered, refs rendered as paths", () => {
		const t = readTree(rig([PART, LEG, { ...LEG, pos: [-0.5, 1, 0] }]));
		expect([...t.byPath.keys()]).toEqual(["Rig", "Rig/Torso", "Rig/Leg", "Rig/Leg#2"]);
		const torso = t.byPath.get("Rig/Torso")!;
		expect(Object.fromEntries(torso.props)).toEqual({
			Size: "(2, 2, 1)",
			Anchored: "true",
			Material: "enum 256",
			CFrame: "(0, 3, 0) rot #2",
			Transparency: "0.5",
			CollisionGroupId: "-3",
			Shape: '"Block"',
		});
		expect(t.byPath.get("Rig/Leg#2")!.props.get("CollisionGroupId")).toBe("11");
		expect(t.byPath.get("Rig")!.props.get("PrimaryPart")).toBe("-> Rig/Torso");
		expect(t.undecoded.size).toBe(0); // UniqueId is ignored, not undecoded
	});
	test("attributes and tags from writeRbxm's files; UDim2", () => {
		const t = readTree(
			model(
				[
					{
						className: "Frame",
						names: ["Root", "Child"],
						referents: [0, 1],
						props: [
							{ name: "Size", type: 0x07, values: udim2s([[1, 0, 0, 40], [0.5, -4, 0.25, 0]]) },
							{ name: "Tags", type: 0x01, values: strings(["b\0a", ""]) },
						],
					},
				],
				{ 1: 0 },
			),
		);
		expect(t.byPath.get("Root")!.props.get("Size")).toBe("{1, 0}, {0, 40}");
		expect(t.byPath.get("Root/Child")!.props.get("Size")).toBe("{0.5, -4}, {0.25, 0}");
		expect(t.byPath.get("Root")!.props.get("Tags")).toBe('"a", "b"');
		expect(t.byPath.get("Root/Child")!.props.get("Tags")).toBe("");
		const withAttributes = readTree(tree([{ className: "Folder", name: "F", parent: -1, attributes: { TypeTorchAsset: "x", Speed: 2 } }]));
		expect(withAttributes.byPath.get("F")!.props.get("AttributesSerialize")!.startsWith("Speed=2; TypeTorchAsset=\"x\"|")).toBe(true);
	});
});

describe("diffAsset", () => {
	test("added, removed and changed instances with their properties", () => {
		const before = rig([PART, LEG]);
		const after = rig([{ ...PART, size: [2, 2.5, 1], anchored: false, shape: "Ball" }, { ...LEG, name: "Arm" }]);
		const diff = diffAsset(before, after);
		expect(diff.baseline).toBe("state");
		expect(diff.before).toEqual({ instances: 3, bytes: before.length, classes: { Part: 2, Model: 1 } });
		expect(diff.after?.instances).toBe(3);
		expect(entryKeys(diff.entries)).toEqual(["added Rig/Arm (Part)", "removed Rig/Leg (Part)", "changed Rig/Torso (Part)"]);
		expect(diff.entries[2].props).toEqual([
			{ name: "Anchored", from: "true", to: "false" },
			{ name: "Shape", from: '"Block"', to: '"Ball"' },
			{ name: "Size", from: "(2, 2, 1)", to: "(2, 2.5, 1)" },
		]);
		expect(diff.more).toBe(0);
		expect(diff.undecoded).toBeUndefined();
		expect(diff.note).toBeUndefined();
	});
	test("attribute changes show as Attributes; a class change is a remove and an add", () => {
		const before = tree([
			{ className: "ScreenGui", name: "Shop", parent: -1, attributes: { TypeTorchAsset: "ui/shop" } },
			{ className: "TextLabel", name: "Title", parent: 0, attributes: { Text: "Shop" } },
			{ className: "Frame", name: "Body", parent: 0 },
		]);
		const after = tree([
			{ className: "ScreenGui", name: "Shop", parent: -1, attributes: { TypeTorchAsset: "ui/shop" } },
			{ className: "TextLabel", name: "Title", parent: 0, attributes: { Text: "Store", Big: true } },
			{ className: "ScrollingFrame", name: "Body", parent: 0 },
		]);
		const diff = diffAsset(before, after);
		expect(entryKeys(diff.entries)).toEqual(["removed Shop/Body (Frame)", "added Shop/Body (ScrollingFrame)", "changed Shop/Title (TextLabel)"]);
		expect(diff.entries[2].props).toEqual([{ name: "Attributes", from: 'Text="Shop"', to: 'Big=true; Text="Store"' }]);
	});
	test("only ids changed: a note instead of entries", () => {
		const a = rig([PART]);
		const b = rig([PART], []);
		// The same content with other UniqueIds: rebuild with a different id pattern.
		const other = model(
			[
				{ className: "Model", names: ["Rig"], referents: [0], props: [] },
				{ className: "Part", names: ["Torso"], referents: [1], props: [{ name: "UniqueId", type: 0x1f, values: raw(Array.from({ length: 16 }, () => 9)) }] },
			],
			{ 1: 0 },
		);
		const same = model(
			[
				{ className: "Model", names: ["Rig"], referents: [0], props: [] },
				{ className: "Part", names: ["Torso"], referents: [1], props: [{ name: "UniqueId", type: 0x1f, values: raw(Array.from({ length: 16 }, () => 4)) }] },
			],
			{ 1: 0 },
		);
		expect(diffAsset(a, b).entries).toEqual([]);
		const diff = diffAsset(other, same);
		expect(diff.entries).toEqual([]);
		expect(diff.note).toMatch(/nothing this diff decodes changed/);
	});
	test("a property type this reader doesn't decode is named when its chunk differs", () => {
		const custom = (bytes: number[]): Prop[] => [{ name: "Thing", type: 0x1e, values: raw(bytes) }];
		const diff = diffAsset(rig([PART], custom([1, 2, 3])), rig([PART], custom([1, 2, 4])));
		expect(diff.entries).toEqual([]);
		expect(diff.undecoded).toEqual(["Part.Thing"]);
		expect(diffAsset(rig([PART], custom([1, 2, 3])), rig([PART], custom([1, 2, 3]))).undecoded).toBeUndefined();
	});
	test("bounded: MAX_ENTRIES entries and MAX_PROPS properties, the rest counted", () => {
		const many = (n: number, text: string) => tree([{ className: "Folder", name: "Root", parent: -1 }, ...Array.from({ length: n }, (_, i) => ({ className: "Part", name: `p${i}`, parent: 0, attributes: { T: text } }))]);
		const grew = diffAsset(many(0, "a"), many(MAX_ENTRIES + 5, "a"));
		expect(grew.entries).toHaveLength(MAX_ENTRIES);
		expect(grew.more).toBe(5);
		expect(grew.entries.every((e) => e.kind === "added")).toBe(true);
		const props = (v: number) => rig([PART], Array.from({ length: MAX_PROPS + 3 }, (_, i) => ({ name: `Extra${i}`, type: 0x03, values: ints([v]) })));
		const changed = diffAsset(props(1), props(2));
		expect(changed.entries).toHaveLength(1);
		expect(changed.entries[0].props).toHaveLength(MAX_PROPS);
		expect(changed.entries[0].moreProps).toBe(3);
	});
	test("long values are cut", () => {
		const long = (text: string) => tree([{ className: "Folder", name: "Root", parent: -1, attributes: { Notes: text } }]);
		const diff = diffAsset(long("x"), long("y".repeat(200)));
		expect(diff.entries[0].props![0].to!.length).toBeLessThanOrEqual(48);
		expect(diff.entries[0].props![0].to!.endsWith("...")).toBe(true);
	});
	test("without a baseline: the export's summary and the note; a removed asset has only its old summary", () => {
		const bytes = rig([PART, LEG]);
		const diff = diffAsset(undefined, bytes, "no copy");
		expect(diff).toEqual({ baseline: "none", note: "no copy", after: { instances: 3, bytes: bytes.length, classes: { Part: 2, Model: 1 } }, entries: [], more: 0 });
		const removed = diffAsset(bytes, undefined);
		expect(removed.baseline).toBe("state");
		expect(removed.before?.instances).toBe(3);
		expect(removed.after).toBeUndefined();
		expect(diffAsset(new TextEncoder().encode("<roblox xmlns"), bytes).note).toMatch(/couldn't read the model/);
	});
});

describe("the state dir's copies", () => {
	test("keeps each export by hash and drops what neither the lockfile nor the export refers to", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-baselines-"));
		try {
			const a = { hash: "aaaaaaaaaaaa", bytes: rig([PART]) };
			const b = { hash: "bbbbbbbbbbbb", bytes: rig([LEG]) };
			keepBaselines(dir, [a, b], []);
			expect(readdirSync(join(dir, BASELINE_DIR)).sort()).toEqual(["aaaaaaaaaaaa.rbxm", "bbbbbbbbbbbb.rbxm"]);
			expect(readBaseline(dir, "aaaaaaaaaaaa")).toEqual(a.bytes);
			// The lockfile still names a; the export only b now; c was never kept.
			keepBaselines(dir, [b], ["aaaaaaaaaaaa", "cccccccccccc"]);
			expect(readdirSync(join(dir, BASELINE_DIR)).sort()).toEqual(["aaaaaaaaaaaa.rbxm", "bbbbbbbbbbbb.rbxm"]);
			keepBaselines(dir, [b], []);
			expect(readdirSync(join(dir, BASELINE_DIR))).toEqual(["bbbbbbbbbbbb.rbxm"]);
			expect(readBaseline(dir, "aaaaaaaaaaaa")).toBeUndefined();
			expect(readBaseline(dir, "../../etc/passwd")).toBeUndefined();
			expect(existsSync(join(dir, BASELINE_DIR, "cccccccccccc.rbxm"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
