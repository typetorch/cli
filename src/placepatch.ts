/**
 * Kernel patch, "splice" engine (plans/13 "Kernel deploy = patch, not replace"; spike S12 in plans/09).
 *
 * Replaces only the kernel SLOTS of a binary place file (.rbxl) with the ones from a freshly built kernel place, at the
 * chunk level of Roblox's binary format (https://dom.rojo.space/binary.html), and keeps everything else byte for byte:
 *   - every chunk of a class with no kernel instance (Parts, Models, GUIs, terrain, unions...) is copied as stored;
 *   - the classes the slots use (Folder, Script, LocalScript, ModuleScript, and a service whose setting is applied) get
 *     their INST and PROP chunks re-encoded: the values of the game's own instances are moved as raw bytes, the old
 *     kernel's instances are dropped and the new kernel's appended;
 *   - PRNT (the parent table) is rewritten; META, SSTR and unknown chunks are copied.
 * Referents stay dense (0..n-1): the new instances take the ids the old kernel freed (plus the next ones), and only
 * when the kernel shrank do the game's highest ids move into the gaps (Referent properties are remapped then).
 * Referent properties that pointed INTO the old kernel are pointed at the new instance at the same path, else nil.
 *
 * Why not Lune's deserializePlace/serializePlace for the whole place (spike S12, measured on Studio-saved places):
 * rbx-dom re-encodes every property and applies its migrations (Image -> ImageContent, MeshId -> MeshContent,
 * SoundId -> AudioContent, UICorner.CornerRadius -> four corner radii, Sound RollOff* -> legacy names) and drops
 * properties it doesn't serialize (BillboardGui.DistanceStep, CanvasGroup.ResolutionScale,
 * TestService.Is30FpsThrottleEnabled). The splice engine touches none of that. Lune still reads the result as an
 * independent check (kernelpatch-luau.ts) and remains available as `--engine lune`.
 *
 * Value layouts handled for the re-encoded classes: String; Bool, Float64, Faces, Axes (one value after another);
 * Int32, Float32, UDim, UDim2, Color3, Vector2, Vector3, BrickColor, Enum, Color3uint8, Int64, SharedString, UniqueId,
 * SecurityCapabilities (byte-plane interleaved, moved as opaque values); Referent (decoded and remapped). Anything else
 * in a re-encoded class is refused (PlacePatchError), so the CLI can fall back to `--engine lune`.
 */
import { createHash } from "node:crypto";
import { chunkData, encodeChunk, instancePath, rawChunks, readAttributes, readRbxmDetailed, Reader, type ChunkCompression, type RawChunk, type RbxmInstance } from "./rbxm.ts";
import { hasZstd } from "./runtime.ts";

export class PlacePatchError extends Error {
	override name = "PlacePatchError";
}

export const TYPE = {
	String: 0x01,
	Bool: 0x02,
	Referent: 0x13,
	SharedString: 0x1c,
	UniqueId: 0x1f,
	Content: 0x22,
} as const;

/** Byte-plane interleaved types: width of one value. Their per-value transforms (zigzag, float rotation) don't matter here. */
const PLANAR_WIDTH: Record<number, number> = {
	0x03: 4, // Int32
	0x04: 4, // Float32
	0x06: 8, // UDim (Float32 array + Int32 array)
	0x07: 16, // UDim2
	0x0b: 4, // BrickColor
	0x0c: 12, // Color3
	0x0d: 8, // Vector2
	0x0e: 12, // Vector3
	0x12: 4, // Enum
	0x1a: 3, // Color3uint8 (R, G, B arrays)
	0x1b: 8, // Int64
	0x1c: 4, // SharedString (index into SSTR)
	0x1f: 16, // UniqueId
	0x21: 8, // SecurityCapabilities
};
/** Types stored one value after another, fixed width. */
const SEQUENTIAL_WIDTH: Record<number, number> = {
	0x02: 1, // Bool
	0x05: 8, // Float64
	0x09: 1, // Faces
	0x0a: 1, // Axes
};

const TYPE_NAMES: Record<number, string> = {
	0x01: "String", 0x02: "Bool", 0x03: "Int32", 0x04: "Float32", 0x05: "Float64", 0x06: "UDim", 0x07: "UDim2",
	0x08: "Ray", 0x09: "Faces", 0x0a: "Axes", 0x0b: "BrickColor", 0x0c: "Color3", 0x0d: "Vector2", 0x0e: "Vector3", 0x0f: "Vector2int16",
	0x10: "CFrame", 0x12: "Enum", 0x13: "Referent", 0x14: "Vector3int16", 0x15: "NumberSequence", 0x16: "ColorSequence",
	0x17: "NumberRange", 0x18: "Rect", 0x19: "PhysicalProperties", 0x1a: "Color3uint8", 0x1b: "Int64",
	0x1c: "SharedString", 0x1e: "OptionalCFrame", 0x1f: "UniqueId", 0x20: "Font", 0x21: "SecurityCapabilities",
	0x22: "Content",
};

export function typeName(type: number): string {
	return TYPE_NAMES[type] ?? `type 0x${type.toString(16)}`;
}

/** Decoded property values: raw per-instance bytes (strings, fixed-width values), or referents. */
/** One Content value: 0 none, 1 a uri, 2 an object (a referent). */
export interface ContentItem {
	source: number;
	uri?: Uint8Array;
	ref?: number;
}

export type Values =
	| { kind: "bytes"; items: Uint8Array[] }
	| { kind: "ref"; items: number[] }
	/** Content: per-instance items, plus the chunk's trailing "external" words (u32 count + count*4 bytes), kept as is. */
	| { kind: "content"; items: ContentItem[]; externalCount: number; external: Uint8Array };

/** One property value of one instance, in any of the decoded forms. */
export type Item = Uint8Array | number | ContentItem;

const isContent = (item: Item | undefined): item is ContentItem => typeof item === "object" && item !== null && !(item instanceof Uint8Array);

// Byte helpers ---------------------------------------------------------------------------------------------------------

class Bytes {
	private parts: Uint8Array[] = [];
	private size = 0;
	push(part: Uint8Array) {
		this.parts.push(part);
		this.size += part.length;
	}
	u8(value: number) {
		this.push(Uint8Array.of(value & 0xff));
	}
	u32(value: number) {
		const out = new Uint8Array(4);
		new DataView(out.buffer).setUint32(0, value >>> 0, true);
		this.push(out);
	}
	string(text: string | Uint8Array) {
		const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
		this.u32(data.length);
		this.push(data);
	}
	referents(values: number[]) {
		this.push(encodeReferents(values));
	}
	done(): Uint8Array {
		const out = new Uint8Array(this.size);
		let offset = 0;
		for (const part of this.parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	}
}

/** Referents: delta-encoded, zigzag, big-endian, byte-plane interleaved i32s. */
export function encodeReferents(values: number[]): Uint8Array {
	const n = values.length;
	const out = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const delta = (i === 0 ? values[0] : values[i] - values[i - 1]) | 0;
		const u = ((delta << 1) ^ (delta >> 31)) >>> 0;
		out[i] = u >>> 24;
		out[n + i] = (u >>> 16) & 0xff;
		out[2 * n + i] = (u >>> 8) & 0xff;
		out[3 * n + i] = u & 0xff;
	}
	return out;
}

function planarDecode(region: Uint8Array, count: number, width: number): Uint8Array[] {
	const items: Uint8Array[] = [];
	for (let i = 0; i < count; i++) {
		const value = new Uint8Array(width);
		for (let b = 0; b < width; b++) value[b] = region[b * count + i];
		items.push(value);
	}
	return items;
}

function planarEncode(items: Uint8Array[], width: number): Uint8Array {
	const count = items.length;
	const out = new Uint8Array(count * width);
	for (let i = 0; i < count; i++) for (let b = 0; b < width; b++) out[b * count + i] = items[i][b];
	return out;
}

export function sha256Hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function sameItem(a: Item, b: Item): boolean {
	if (typeof a === "number" || typeof b === "number") return a === b;
	if (isContent(a) || isContent(b)) {
		if (!isContent(a) || !isContent(b)) return false;
		return a.source === b.source && a.ref === b.ref && (a.uri === b.uri || (!!a.uri && !!b.uri && equalBytes(a.uri, b.uri)));
	}
	return equalBytes(a, b);
}

// The parsed file ------------------------------------------------------------------------------------------------------

export interface PlaceInstance {
	referent: number;
	className: string;
	classId: number;
	/** Position among its class's referents (= its index in every PROP chunk of the class). */
	index: number;
	name: string;
	parent: number;
}

interface ClassEntry {
	id: number;
	name: string;
	/** Object format: 1 for services. */
	format: number;
	referents: number[];
	chunk: number;
	props: PropEntry[];
}

interface PropEntry {
	name: string;
	type: number;
	chunk: number;
	/** Where the values start in the decompressed chunk. */
	valuesAt: number;
}

/** A binary place or model, parsed down to classes, properties (lazily) and the parent table. */
export class PlaceFile {
	readonly header: Uint8Array;
	readonly chunks: RawChunk[];
	readonly tail: Uint8Array;
	readonly classes: ClassEntry[] = [];
	readonly classById = new Map<number, ClassEntry>();
	readonly classByName = new Map<string, ClassEntry>();
	readonly instances = new Map<number, PlaceInstance>();
	readonly prnt: { chunk: number; version: number; children: number[]; parents: number[] };
	/** Chunk index -> the class of an INST chunk, or the class and property of a PROP chunk. */
	readonly chunkOwner = new Map<number, { entry: ClassEntry; prop?: PropEntry }>();
	private readonly cache = new Map<number, Uint8Array>();
	private kids?: Map<number, number[]>;
	private serviceMap?: Map<string, PlaceInstance>;

	constructor(readonly bytes: Uint8Array) {
		const parsed = rawChunks(bytes);
		this.chunks = parsed.chunks;
		this.header = bytes.subarray(0, 32);
		this.tail = bytes.subarray(parsed.tail);
		let prnt: PlaceFile["prnt"] | undefined;
		this.chunks.forEach((chunk, index) => {
			if (chunk.name === "INST") {
				const reader = new Reader(this.data(index));
				const id = reader.u32();
				const name = reader.string();
				const format = reader.u8();
				const referents = reader.referents(reader.u32());
				if (this.classById.has(id)) throw new PlacePatchError(`class id ${id} appears twice`);
				if (this.classByName.has(name)) throw new PlacePatchError(`class ${name} has two INST chunks`);
				const entry: ClassEntry = { id, name, format, referents, chunk: index, props: [] };
				this.classes.push(entry);
				this.classById.set(id, entry);
				this.classByName.set(name, entry);
				this.chunkOwner.set(index, { entry });
				referents.forEach((referent, position) => {
					if (this.instances.has(referent)) throw new PlacePatchError(`referent ${referent} appears twice`);
					this.instances.set(referent, { referent, className: name, classId: id, index: position, name: "", parent: -1 });
				});
			} else if (chunk.name === "PROP") {
				const reader = new Reader(this.data(index));
				const owner = this.classById.get(reader.u32());
				if (!owner) throw new PlacePatchError("a PROP chunk comes before its class's INST chunk");
				const name = reader.string();
				const type = reader.u8();
				if (owner.props.some((p) => p.name === name)) throw new PlacePatchError(`${owner.name}.${name} has two PROP chunks`);
				const prop: PropEntry = { name, type, chunk: index, valuesAt: reader.offset };
				owner.props.push(prop);
				this.chunkOwner.set(index, { entry: owner, prop });
			} else if (chunk.name === "PRNT") {
				const reader = new Reader(this.data(index));
				const version = reader.u8();
				const count = reader.u32();
				prnt = { chunk: index, version, children: reader.referents(count), parents: reader.referents(count) };
			}
		});
		if (!prnt) throw new PlacePatchError("the file has no PRNT chunk");
		this.prnt = prnt;
		prnt.children.forEach((child, i) => {
			const instance = this.instances.get(child);
			if (instance) instance.parent = prnt!.parents[i];
		});
		for (const entry of this.classes) {
			const names = this.prop(entry, "Name");
			if (!names || names.type !== TYPE.String) continue;
			const values = this.values(entry, names);
			if (values.kind !== "bytes") continue;
			entry.referents.forEach((referent, i) => {
				this.instances.get(referent)!.name = new TextDecoder().decode(values.items[i]);
			});
		}
	}

	/** A chunk's decompressed payload (cached). */
	data(index: number): Uint8Array {
		let data = this.cache.get(index);
		if (!data) {
			const chunk = this.chunks[index];
			data = chunkData(chunk.payload, chunk.compressedLength, chunk.length);
			this.cache.set(index, data);
		}
		return data;
	}

	prop(entry: ClassEntry, name: string): PropEntry | undefined {
		return entry.props.find((p) => p.name === name);
	}

	/** Decodes a PROP chunk's values (one per instance of the class). Throws PlacePatchError for unsupported types. */
	values(entry: ClassEntry, prop: PropEntry): Values {
		const data = this.data(prop.chunk);
		const count = entry.referents.length;
		const reader = new Reader(data);
		reader.offset = prop.valuesAt;
		const where = `${entry.name}.${prop.name} (${typeName(prop.type)})`;
		let values: Values;
		if (prop.type === TYPE.String) {
			const items: Uint8Array[] = [];
			for (let i = 0; i < count; i++) items.push(reader.take(reader.u32()));
			values = { kind: "bytes", items };
		} else if (prop.type === TYPE.Referent) {
			values = { kind: "ref", items: reader.referents(count) };
		} else if (prop.type === TYPE.Content) {
			// Source types (interleaved i32), then the uris, the object referents and the "external" words (rbx_binary).
			const sources = reader.interleavedI32(count);
			const uris: Uint8Array[] = [];
			for (let i = reader.u32(); i > 0; i--) uris.push(reader.take(reader.u32()));
			const objects = reader.referents(reader.u32());
			const externalCount = reader.u32();
			const external = reader.take(externalCount * 4);
			let u = 0;
			let o = 0;
			const items = sources.map((source): ContentItem => {
				if (source === 1) return { source, uri: uris[u++] };
				if (source === 2) return { source, ref: objects[o++] };
				if (source !== 0) throw new PlacePatchError(`${where}: Content source type ${source} is unknown to the splice engine`);
				return { source };
			});
			if (u !== uris.length || o !== objects.length || items.some((i) => (i.source === 1 && !i.uri) || (i.source === 2 && i.ref === undefined))) {
				throw new PlacePatchError(`${where}: the Content counts don't match`);
			}
			values = { kind: "content", items, externalCount, external };
		} else if (PLANAR_WIDTH[prop.type] !== undefined) {
			const width = PLANAR_WIDTH[prop.type];
			values = { kind: "bytes", items: planarDecode(reader.take(count * width), count, width) };
		} else if (SEQUENTIAL_WIDTH[prop.type] !== undefined) {
			const width = SEQUENTIAL_WIDTH[prop.type];
			const items: Uint8Array[] = [];
			for (let i = 0; i < count; i++) items.push(reader.take(width));
			values = { kind: "bytes", items };
		} else {
			throw new PlacePatchError(`can't re-encode ${where}: the splice engine doesn't handle that value type`);
		}
		if (reader.offset !== data.length) throw new PlacePatchError(`${where}: ${data.length - reader.offset} unexpected bytes after the values`);
		return values;
	}

	/** Children of an instance, in PRNT order. */
	children(referent: number): PlaceInstance[] {
		if (!this.kids) {
			this.kids = new Map();
			this.prnt.children.forEach((child, i) => {
				const parent = this.prnt.parents[i];
				let list = this.kids!.get(parent);
				if (!list) this.kids!.set(parent, (list = []));
				list.push(child);
			});
		}
		return (this.kids.get(referent) ?? []).map((r) => this.instances.get(r)!).filter(Boolean);
	}

	/** The instance and its descendants, parents before children. */
	subtree(referent: number): number[] {
		const out: number[] = [];
		const visit = (r: number) => {
			out.push(r);
			for (const child of this.children(r)) visit(child.referent);
		};
		visit(referent);
		return out;
	}

	/** `Service/Child/...` (names; `<Class>` for unnamed ones). */
	path(referent: number): string {
		const parts: string[] = [];
		const seen = new Set<number>();
		let current = this.instances.get(referent);
		while (current && !seen.has(current.referent)) {
			seen.add(current.referent);
			parts.unshift(current.name || `<${current.className}>`);
			current = current.parent === -1 ? undefined : this.instances.get(current.parent);
		}
		return parts.join("/");
	}

	/** Top-level instances (services) by class name; the first one wins. */
	services(): Map<string, PlaceInstance> {
		if (this.serviceMap) return this.serviceMap;
		const out = new Map<string, PlaceInstance>();
		for (const child of this.children(-1)) if (!out.has(child.className)) out.set(child.className, child);
		// Instances with no PRNT entry are roots too.
		for (const instance of this.instances.values()) if (instance.parent === -1 && !out.has(instance.className)) out.set(instance.className, instance);
		this.serviceMap = out;
		return out;
	}

	/** One instance's String property, decoded as text. */
	stringProp(referent: number, name: string): string | undefined {
		const instance = this.instances.get(referent);
		if (!instance) return undefined;
		const entry = this.classById.get(instance.classId)!;
		const prop = this.prop(entry, name);
		if (!prop || prop.type !== TYPE.String) return undefined;
		const values = this.values(entry, prop);
		return values.kind === "bytes" ? new TextDecoder().decode(values.items[instance.index]) : undefined;
	}

	/** One instance's attributes (strings, numbers, booleans). */
	attributes(referent: number): Record<string, string | number | boolean> {
		const instance = this.instances.get(referent);
		if (!instance) return {};
		const entry = this.classById.get(instance.classId)!;
		const prop = this.prop(entry, "AttributesSerialize");
		if (!prop || prop.type !== TYPE.String) return {};
		const values = this.values(entry, prop);
		return values.kind === "bytes" && values.items[instance.index].length > 0 ? readAttributes(values.items[instance.index]) : {};
	}

	/** Every PROP chunk's type, for the "Content properties hold referents" check. */
	hasType(type: number): boolean {
		return this.classes.some((c) => c.props.some((p) => p.type === type));
	}
}

// Slots ------------------------------------------------------------------------------------------------------------------

/** A kernel slot: a direct child of a service that the kernel owns (plans/13 "owned slots"). */
export interface SlotRef {
	service: string;
	name: string;
}

export const slotKey = (slot: SlotRef) => `${slot.service}.${slot.name}`;

/** Every instance with that name directly under that service (normally one). */
export function slotRoots(file: PlaceFile, slot: SlotRef): PlaceInstance[] {
	const service = file.services().get(slot.service);
	return service ? file.children(service.referent).filter((c) => c.name === slot.name) : [];
}

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

/** The scripts of a slot: path inside the slot -> sha256 of the Source. */
export function slotScripts(file: PlaceFile, slot: SlotRef): Map<string, string> {
	const out = new Map<string, string>();
	for (const root of slotRoots(file, slot)) {
		const base = file.path(root.referent);
		for (const referent of file.subtree(root.referent)) {
			const instance = file.instances.get(referent)!;
			if (!SCRIPT_CLASSES.has(instance.className)) continue;
			const rel = file.path(referent).slice(base.length + 1) || instance.name;
			out.set(`${rel} (${instance.className})`, sha256Hex(file.stringProp(referent, "Source") ?? ""));
		}
	}
	return out;
}

export interface KernelInfo {
	version?: string;
	hash?: string;
	commit?: string;
	/** Where the version came from: the stamped attribute, or Constants.luau's KERNEL_VERSION. */
	versionSource?: "attribute" | "constants";
}

/** The kernel identity in a place: the attributes `kernel deploy` stamps, else KERNEL_VERSION in the shared Constants. */
export function kernelInfo(file: PlaceFile): KernelInfo {
	const info: KernelInfo = {};
	const kernel = slotRoots(file, { service: "ServerScriptService", name: "TypeTorchKernel" })[0];
	if (kernel) {
		const attributes = file.attributes(kernel.referent);
		if (typeof attributes.KernelVersion === "string" && attributes.KernelVersion) {
			info.version = attributes.KernelVersion;
			info.versionSource = "attribute";
		}
		if (typeof attributes.KernelHash === "string" && attributes.KernelHash) info.hash = attributes.KernelHash;
		if (typeof attributes.KernelCommit === "string" && attributes.KernelCommit) info.commit = attributes.KernelCommit;
	}
	if (!info.version) {
		const shared = slotRoots(file, { service: "ReplicatedStorage", name: "TypeTorchKernelShared" })[0];
		const constants = shared ? file.children(shared.referent).find((c) => c.name === "Constants") : undefined;
		const version = constants ? /KERNEL_VERSION\s*=\s*"([^"]+)"/.exec(file.stringProp(constants.referent, "Source") ?? "")?.[1] : undefined;
		if (version) {
			info.version = version;
			info.versionSource = "constants";
		}
	}
	return info;
}

/** Classes the Place Publishing API documents it "doesn't update" (they are kept as stored, but worth a look). */
export const PUBLISH_CAVEAT_CLASSES = ["PartOperation", "UnionOperation", "NegateOperation", "IntersectOperation", "SurfaceAppearance", "WrapLayer", "WrapTarget", "EditableImage", "EditableMesh"];

export interface PlaceSummary {
	instances: number;
	classes: number;
	services: number;
	slots: { slot: string; copies: number; instances: number }[];
	kernel: KernelInfo;
	/** Instances of PUBLISH_CAVEAT_CLASSES (class -> count), only the ones present. */
	caveats: Record<string, number>;
	/** Top-level children named TypeTorch* that are not slots (e.g. ServerStorage.TypeTorchDev): kept, listed. */
	otherTypeTorch: string[];
}

export function summarizePlace(file: PlaceFile, slots: SlotRef[]): PlaceSummary {
	const caveats: Record<string, number> = {};
	for (const name of PUBLISH_CAVEAT_CLASSES) {
		const entry = file.classByName.get(name);
		if (entry && entry.referents.length > 0) caveats[name] = entry.referents.length;
	}
	const slotNames = new Set(slots.map(slotKey));
	const otherTypeTorch: string[] = [];
	for (const service of file.services().values()) {
		for (const child of file.children(service.referent)) {
			if (child.name.startsWith("TypeTorch") && !slotNames.has(`${service.className}.${child.name}`)) otherTypeTorch.push(`${service.className}.${child.name}`);
		}
	}
	return {
		instances: file.instances.size,
		classes: file.classes.length,
		services: file.services().size,
		slots: slots.map((slot) => {
			const roots = slotRoots(file, slot);
			return { slot: slotKey(slot), copies: roots.length, instances: roots.reduce((n, r) => n + file.subtree(r.referent).length, 0) };
		}),
		kernel: kernelInfo(file),
		caveats,
		otherTypeTorch,
	};
}

// The patch ----------------------------------------------------------------------------------------------------------------

/** A service property the kernel project sets (`$properties` on a service node), copied from the kernel build. */
export interface ServiceProp {
	service: string;
	prop: string;
}

export interface PatchInput {
	/** The place as published (downloaded). */
	original: Uint8Array;
	/** The kernel place built by rojo (place.project.json with the identity and trust roots stamped). */
	kernel: Uint8Array;
	slots: SlotRef[];
	serviceProps: ServiceProp[];
	/** Seeds the UniqueIds of the new instances (the kernel content hash), so a dry run and a deploy write the same bytes. */
	seed: string;
	/** Chunk compression for re-encoded chunks (default: zstd when this runtime has it, else LZ4 literal blocks). */
	compression?: ChunkCompression;
}

export interface SlotChange {
	slot: string;
	/** Instances in the place before (all copies), 0 when absent. */
	before: number;
	/** Instances after (from the kernel build). */
	after: number;
	/** How many instances with that name the place had under the service (normally 0 or 1). */
	copies: number;
	scripts: { changed: string[]; added: string[]; removed: string[]; same: number };
}

export interface SettingChange {
	path: string;
	before?: string;
	after: string;
	changed: boolean;
}

export interface PatchReport {
	slots: SlotChange[];
	settings: SettingChange[];
	instances: { before: number; after: number; removed: number; added: number };
	classes: { before: number; after: number; rewritten: string[]; added: string[]; removed: string[] };
	chunks: { before: number; after: number; copied: number; rewritten: number; added: number; dropped: number };
	/** Referent properties outside the slots that pointed into the old kernel: re-pointed by path, or cleared. */
	references: { remapped: string[]; cleared: string[] };
	/** Values the kernel build didn't have (filled with the class's usual value) or the place didn't have (zero). */
	filled: string[];
	/** Game instances whose referent moved to keep the ids dense (only when the kernel shrank). */
	movedReferents: number;
	addedServices: string[];
	compression: ChunkCompression;
	oldKernel: KernelInfo;
	newKernel: KernelInfo;
}

function formatValue(type: number, value: Item | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return `ref ${value}`;
	if (isContent(value)) return value.source === 0 ? "none" : value.source === 1 ? JSON.stringify(new TextDecoder().decode(value.uri)) : `object ${value.ref}`;
	if (type === TYPE.Bool) return value[0] ? "true" : "false";
	if (type === TYPE.String) return JSON.stringify(new TextDecoder().decode(value));
	if (type === 0x1b && value.length === 8) {
		const u = new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, false);
		return String((u >> 1n) ^ -(u & 1n));
	}
	if ((type === 0x12 || type === 0x03) && value.length === 4) {
		const u = new DataView(value.buffer, value.byteOffset, 4).getUint32(0, false);
		return String(type === 0x03 ? (u >>> 1) ^ -(u & 1) : u);
	}
	return `0x${Buffer.from(value).toString("hex")}`;
}

/** Types whose missing values (in the kernel build) take the place's usual value: ids, not behaviour. */
const USUAL_VALUE_TYPES = new Set([0x1b, 0x1c, 0x1f]);

/** Types a missing property may be zero-filled with (zero = the engine default for these). */
const ZERO_FILL_TYPES = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x12, 0x1b, 0x21, 0x22]);

function zeroValue(type: number): Item {
	if (type === TYPE.Referent) return -1;
	if (type === TYPE.String) return new Uint8Array(0);
	if (type === TYPE.Content) return { source: 0 };
	const width = PLANAR_WIDTH[type] ?? SEQUENTIAL_WIDTH[type];
	if (width === undefined) throw new PlacePatchError(`no zero value for ${typeName(type)}`);
	return new Uint8Array(width);
}

/** Zigzag, big-endian, byte-plane interleaved i32s (no delta). */
function encodeInterleavedI32(values: number[]): Uint8Array {
	const n = values.length;
	const out = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const v = values[i] | 0;
		const u = ((v << 1) ^ (v >> 31)) >>> 0;
		out[i] = u >>> 24;
		out[n + i] = (u >>> 16) & 0xff;
		out[2 * n + i] = (u >>> 8) & 0xff;
		out[3 * n + i] = u & 0xff;
	}
	return out;
}

/** `external`: a Content chunk's trailing words, already with their u32 count (empty = none). */
function encodeValues(type: number, items: Item[], external?: Uint8Array): Uint8Array {
	if (type === TYPE.Referent) return encodeReferents(items as number[]);
	if (type === TYPE.Content) {
		const contents = items as ContentItem[];
		const out = new Bytes();
		out.push(encodeInterleavedI32(contents.map((c) => c.source)));
		const uris = contents.filter((c) => c.source === 1);
		out.u32(uris.length);
		for (const c of uris) out.string(c.uri!);
		const objects = contents.filter((c) => c.source === 2).map((c) => c.ref!);
		out.u32(objects.length);
		out.push(encodeReferents(objects));
		if (external && external.length > 0) out.push(external);
		else out.u32(0);
		return out.done();
	}
	if (type === TYPE.String) {
		const out = new Bytes();
		for (const item of items as Uint8Array[]) out.string(item);
		return out.done();
	}
	if (PLANAR_WIDTH[type] !== undefined) return planarEncode(items as Uint8Array[], PLANAR_WIDTH[type]);
	if (SEQUENTIAL_WIDTH[type] !== undefined) {
		const out = new Bytes();
		for (const item of items as Uint8Array[]) out.push(item);
		return out.done();
	}
	throw new PlacePatchError(`can't encode ${typeName(type)}`);
}

/** The most common value of a property, when at least half of the instances share it. */
function usualValue(items: Uint8Array[]): Uint8Array | undefined {
	if (items.length === 0) return undefined;
	const counts = new Map<string, { value: Uint8Array; n: number }>();
	for (const item of items) {
		const key = Buffer.from(item).toString("base64");
		const entry = counts.get(key);
		if (entry) entry.n++;
		else counts.set(key, { value: item, n: 1 });
	}
	const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
	return best.n * 2 >= items.length ? best.value : undefined;
}

/** A UniqueId for a new instance: index, time 0, 8 bytes from sha256(seed, path, n). Deterministic, non-nil. */
function uniqueId(seed: string, path: string, n: number): Uint8Array {
	const value = new Uint8Array(16);
	const view = new DataView(value.buffer);
	view.setUint32(0, (n + 1) >>> 0, false);
	value.set(createHash("sha256").update(`${seed}\0${path}\0${n}`).digest().subarray(0, 8), 8);
	return value;
}

interface Member {
	ref: number;
	from: "place" | "kernel";
	/** Position in the source class (its index in every PROP chunk of that class). */
	index: number;
	/** Source referent (in its file). */
	source: number;
}

interface ClassPlan {
	name: string;
	format: number;
	newId: number;
	place?: ClassEntry;
	kernel?: ClassEntry;
	members: Member[];
	/** Instances were removed or added: every PROP chunk is re-encoded. */
	reshaped: boolean;
}

/** Patches the kernel slots of `original` with the ones in `kernel`. Throws PlacePatchError when it can't. */
export function patchPlace(input: PatchInput): { bytes: Uint8Array; report: PatchReport } {
	const place = new PlaceFile(input.original);
	const kernel = new PlaceFile(input.kernel);
	const compression: ChunkCompression = input.compression ?? (hasZstd() ? "zstd" : "lz4");
	const placeServices = place.services();
	const kernelServices = kernel.services();

	// 1. What goes: every copy of every slot, with descendants.
	const removed = new Set<number>();
	for (const slot of input.slots) for (const root of slotRoots(place, slot)) for (const r of place.subtree(root.referent)) removed.add(r);

	// 2. What comes: each slot from the kernel build (and a service the place lacks), parents before children.
	const incoming: number[] = [];
	const incomingSet = new Set<number>();
	const addedServices: string[] = [];
	const slotRootTarget = new Map<number, string>(); // kernel slot root -> service class
	for (const slot of input.slots) {
		const service = kernelServices.get(slot.service);
		const roots = service ? kernel.children(service.referent).filter((c) => c.name === slot.name) : [];
		if (roots.length !== 1) throw new PlacePatchError(`the kernel build has ${roots.length} ${slotKey(slot)} (expected 1)`);
		if (!placeServices.has(slot.service) && !incomingSet.has(service!.referent)) {
			incoming.push(service!.referent);
			incomingSet.add(service!.referent);
			addedServices.push(slot.service);
		}
		slotRootTarget.set(roots[0].referent, slot.service);
		for (const r of kernel.subtree(roots[0].referent)) {
			incoming.push(r);
			incomingSet.add(r);
		}
	}

	// 3. Referents: dense ids stay dense; the new instances take the freed ids first.
	const placeRefs = [...place.instances.keys()];
	const survivors = placeRefs.filter((r) => !removed.has(r));
	const maxRef = placeRefs.reduce((a, b) => Math.max(a, b), -1);
	const dense = placeRefs.length === maxRef + 1 && placeRefs.every((r) => r >= 0);
	const moved = new Map<number, number>();
	const newRef = new Map<number, number>(); // kernel referent -> referent in the patched place
	if (dense) {
		const newCount = survivors.length + incoming.length;
		const used = new Set(survivors.filter((r) => r < newCount));
		const free: number[] = [];
		for (let r = 0; r < newCount; r++) if (!used.has(r)) free.push(r);
		let next = 0;
		for (const r of survivors.filter((r) => r >= newCount).sort((a, b) => a - b)) moved.set(r, free[next++]);
		for (const k of incoming) newRef.set(k, free[next++]);
	} else {
		const free = [...removed].sort((a, b) => a - b);
		let next = 0;
		let fresh = maxRef + 1;
		for (const k of incoming) newRef.set(k, next < free.length ? free[next++] : fresh++);
	}
	const mapRef = (r: number) => moved.get(r) ?? r;

	// Referents that pointed into the old kernel: the new instance at the same path, else nil.
	const kernelByPath = new Map<string, number>();
	for (const k of incoming) if (!kernelByPath.has(kernel.path(k))) kernelByPath.set(kernel.path(k), newRef.get(k)!);
	const references = { remapped: [] as string[], cleared: [] as string[] };
	const danglingTarget = (r: number): number => kernelByPath.get(place.path(r)) ?? -1;

	// 4. Classes: the place's (minus emptied ones), then new ones from the kernel build.
	const plans: ClassPlan[] = [];
	const planByName = new Map<string, ClassPlan>();
	for (const entry of place.classes) {
		const members: Member[] = [];
		let reshaped = false;
		entry.referents.forEach((r, index) => {
			if (removed.has(r)) reshaped = true;
			else members.push({ ref: mapRef(r), from: "place", index, source: r });
		});
		const plan: ClassPlan = { name: entry.name, format: entry.format, newId: -1, place: entry, kernel: kernel.classByName.get(entry.name), members, reshaped };
		plans.push(plan);
		planByName.set(entry.name, plan);
	}
	for (const k of incoming) {
		const instance = kernel.instances.get(k)!;
		let plan = planByName.get(instance.className);
		const kernelClass = kernel.classById.get(instance.classId)!;
		if (!plan) {
			plan = { name: instance.className, format: kernelClass.format, newId: -1, kernel: kernelClass, members: [], reshaped: true };
			plans.push(plan);
			planByName.set(plan.name, plan);
		}
		if (plan.format !== kernelClass.format) throw new PlacePatchError(`class ${plan.name} is a service in one file and not in the other`);
		plan.reshaped = true;
		plan.members.push({ ref: newRef.get(k)!, from: "kernel", index: instance.index, source: k });
	}
	const kept = plans.filter((p) => p.members.length > 0);
	// Class ids: the place's keep theirs (compacted in id order only when a class disappears), new ones come after.
	const keptPlace = kept.filter((p) => p.place).sort((a, b) => a.place!.id - b.place!.id);
	keptPlace.forEach((p, i) => (p.newId = i));
	kept.filter((p) => !p.place).forEach((p, i) => (p.newId = keptPlace.length + i));
	for (const plan of kept) {
		// Referents ascending inside a class, as Roblox writes them; the PROP values follow the same order.
		if (plan.members.some((m) => m.from === "place" && m.ref !== m.source)) plan.reshaped = true;
		if (plan.reshaped) plan.members.sort((a, b) => a.ref - b.ref);
	}
	const removedClasses = plans.filter((p) => p.members.length === 0).map((p) => p.name);

	// Service settings: the kernel build's value for the place's service instance.
	const settingsWanted = new Map<string, { prop: string; type: number; value: Item }[]>();
	const settings: SettingChange[] = [];
	for (const { service, prop } of input.serviceProps) {
		const kernelService = kernelServices.get(service);
		const entry = kernelService ? kernel.classById.get(kernelService.classId)! : undefined;
		const propEntry = entry ? kernel.prop(entry, prop) : undefined;
		if (!kernelService || !entry || !propEntry) throw new PlacePatchError(`the kernel build has no ${service}.${prop}`);
		const values = kernel.values(entry, propEntry);
		const value = values.items[kernelService.index];
		const list = settingsWanted.get(service) ?? [];
		list.push({ prop, type: propEntry.type, value });
		settingsWanted.set(service, list);
	}

	const report: PatchReport = {
		slots: [],
		settings,
		instances: { before: place.instances.size, after: survivors.length + incoming.length, removed: removed.size, added: incoming.length },
		classes: { before: place.classes.length, after: kept.length, rewritten: [], added: kept.filter((p) => !p.place).map((p) => p.name), removed: removedClasses },
		chunks: { before: place.chunks.length, after: 0, copied: 0, rewritten: 0, added: 0, dropped: 0 },
		references,
		filled: [],
		movedReferents: moved.size,
		addedServices,
		compression,
		oldKernel: kernelInfo(place),
		newKernel: kernelInfo(kernel),
	};

	// The values of one property for a class's new member list.
	const propValuesFor = (plan: ClassPlan, name: string, type: number): { items: Item[]; external?: Uint8Array } => {
		const placeProp = plan.place ? place.prop(plan.place, name) : undefined;
		const kernelProp = plan.kernel ? kernel.prop(plan.kernel, name) : undefined;
		if (placeProp && placeProp.type !== type) throw new PlacePatchError(`${plan.name}.${name} has two types`);
		if (kernelProp && kernelProp.type !== type) {
			throw new PlacePatchError(`${plan.name}.${name} is ${typeName(type)} in the place but ${typeName(kernelProp.type)} in the kernel build`);
		}
		const placeValues = placeProp ? place.values(plan.place!, placeProp) : undefined;
		const kernelValues = kernelProp ? kernel.values(plan.kernel!, kernelProp) : undefined;
		const fromPlace = plan.members.some((m) => m.from === "place");
		const fromKernel = plan.members.some((m) => m.from === "kernel");
		let fallbackKernel: Item | undefined;
		let freshIds = false;
		// Content chunks end with "external" words that belong to no single instance: kept only when nothing moves.
		let external: Uint8Array | undefined;
		if (placeValues?.kind === "content" && placeValues.externalCount > 0) {
			if (plan.reshaped) throw new PlacePatchError(`${plan.name}.${name}: a Content chunk with external data can't be re-shaped; use --engine lune`);
			const count = new Uint8Array(4);
			new DataView(count.buffer).setUint32(0, placeValues.externalCount, true);
			external = new Uint8Array([...count, ...placeValues.external]);
		}
		if (fromKernel && kernelValues?.kind === "content" && kernelValues.externalCount > 0) {
			throw new PlacePatchError(`${plan.name}.${name}: the kernel build has Content external data; use --engine lune`);
		}
		if (fromKernel && !kernelValues) {
			// Zero/empty is the engine default for what the kernel build leaves out (Disabled false, RunContext Legacy,
			// no Tags, no attributes, no Capabilities). Only id-like values take the class's usual value (at least half
			// of the place's instances share it): SourceAssetId (-1), HistoryId (nil), a SharedString index. A UniqueId
			// without a usual value gets fresh ids; a SharedString without one is refused (index 0 is some other string).
			const usual = USUAL_VALUE_TYPES.has(type) && placeValues?.kind === "bytes" ? usualValue(placeValues.items) : undefined;
			if (usual) fallbackKernel = usual;
			else if (type === TYPE.UniqueId) freshIds = true;
			else if (type === TYPE.SharedString) throw new PlacePatchError(`${plan.name}.${name} (SharedString) has no value for the kernel's instances; use --engine lune`);
			else fallbackKernel = zeroValue(type);
			const n = plan.members.filter((m) => m.from === "kernel").length;
			report.filled.push(`${plan.name}.${name}: ${freshIds ? "fresh ids" : formatValue(type, fallbackKernel)} for ${n} new instance(s) (not in the kernel build)`);
		}
		let fallbackPlace: Item | undefined;
		if (fromPlace && !placeValues) {
			if (!ZERO_FILL_TYPES.has(type)) {
				throw new PlacePatchError(`the kernel build sets ${plan.name}.${name} (${typeName(type)}), which the place's ${plan.name}s don't have; use --engine lune`);
			}
			fallbackPlace = zeroValue(type);
			const n = plan.members.filter((m) => m.from === "place").length;
			report.filled.push(`${plan.name}.${name}: ${formatValue(type, fallbackPlace)} for the place's ${n} existing instance(s) (new property from the kernel build)`);
		}
		// A referent from the place: the old kernel's -> the new instance at the same path (else nil); moved -> its new id.
		const placeTarget = (member: Member, target: number): number => {
			if (target === -1) return -1;
			if (!removed.has(target)) return mapRef(target);
			const next = danglingTarget(target);
			(next === -1 ? references.cleared : references.remapped).push(`${place.path(member.source)}.${name} -> ${place.path(target)}`);
			return next;
		};
		const kernelTarget = (target: number): number => (incomingSet.has(target) ? newRef.get(target)! : -1);
		const items = plan.members.map((member, i): Item => {
			if (member.from === "place") {
				if (!placeValues) return fallbackPlace!;
				const value = placeValues.items[member.index];
				if (placeValues.kind === "ref") return placeTarget(member, value as number);
				if (isContent(value) && value.source === 2) {
					const ref = placeTarget(member, value.ref!);
					return ref === -1 ? { source: 0 } : { source: 2, ref };
				}
				return value;
			}
			if (kernelValues) {
				const value = kernelValues.items[member.index];
				if (kernelValues.kind === "ref") return kernelTarget(value as number);
				if (isContent(value) && value.source === 2) {
					const ref = kernelTarget(value.ref!);
					return ref === -1 ? { source: 0 } : { source: 2, ref };
				}
				return value;
			}
			if (freshIds) return uniqueId(input.seed, kernel.path(member.source), i);
			return fallbackKernel!;
		});
		return { items, external };
	};

	const propChunk = (plan: ClassPlan, name: string, type: number, values: { items: Item[]; external?: Uint8Array }) => {
		const out = new Bytes();
		out.u32(plan.newId);
		out.string(name);
		out.u8(type);
		out.push(encodeValues(type, values.items, values.external));
		return encodeChunk("PROP", out.done(), compression);
	};
	const instChunk = (plan: ClassPlan) => {
		const out = new Bytes();
		out.u32(plan.newId);
		out.string(plan.name);
		out.u8(plan.format);
		out.u32(plan.members.length);
		out.referents(plan.members.map((m) => m.ref));
		if (plan.format === 1) out.push(new Uint8Array(plan.members.length).fill(1));
		return encodeChunk("INST", out.done(), compression);
	};

	// 5. Assemble: copy what didn't change, re-encode what did, add the rest before PRNT.
	const out: Uint8Array[] = [];
	const lastInst = place.chunks.map((c) => c.name).lastIndexOf("INST");
	const rewritten = new Set<string>();
	const extraProps: Uint8Array[] = [];
	for (const plan of kept) {
		// Properties only the kernel build has, for a class the place already had.
		if (!plan.place || !plan.kernel) continue;
		for (const prop of plan.kernel.props) {
			if (place.prop(plan.place, prop.name)) continue;
			if (!plan.members.some((m) => m.from === "kernel")) continue;
			extraProps.push(propChunk(plan, prop.name, prop.type, propValuesFor(plan, prop.name, prop.type)));
			rewritten.add(plan.name);
		}
	}
	for (const plan of kept.filter((p) => !p.place)) {
		for (const prop of plan.kernel!.props) extraProps.push(propChunk(plan, prop.name, prop.type, propValuesFor(plan, prop.name, prop.type)));
	}

	place.chunks.forEach((chunk, index) => {
		const raw = place.bytes.subarray(chunk.start, chunk.end);
		if (chunk.name === "INST") {
			const entry = place.chunkOwner.get(index)!.entry;
			const plan = planByName.get(entry.name)!;
			if (plan.members.length === 0) report.chunks.dropped++;
			else if (plan.reshaped || plan.newId !== entry.id || plan.members.some((m) => m.ref !== m.source)) {
				out.push(instChunk(plan));
				rewritten.add(plan.name);
				report.chunks.rewritten++;
			} else {
				out.push(raw);
				report.chunks.copied++;
			}
			if (index === lastInst) {
				for (const plan of kept.filter((p) => !p.place)) {
					out.push(instChunk(plan));
					report.chunks.added++;
				}
			}
			return;
		}
		if (chunk.name === "PROP") {
			const owner = place.chunkOwner.get(index)!;
			const entry = owner.entry;
			const prop = owner.prop!;
			const plan = planByName.get(entry.name)!;
			if (plan.members.length === 0) {
				report.chunks.dropped++;
				return;
			}
			const instance = place.instances.get(entry.referents[0]);
			const setting = plan.format === 1 && instance && placeServices.get(entry.name) ? settingsWanted.get(entry.name)?.find((s) => s.prop === prop.name) : undefined;
			const mustDecode = plan.reshaped || plan.newId !== entry.id || prop.type === TYPE.Referent || prop.type === TYPE.Content || setting !== undefined;
			if (!mustDecode) {
				out.push(raw);
				report.chunks.copied++;
				return;
			}
			const values = propValuesFor(plan, prop.name, prop.type);
			let items = values.items;
			let changed = plan.reshaped || plan.newId !== entry.id;
			if ((prop.type === TYPE.Referent || prop.type === TYPE.Content) && !changed) {
				const before = place.values(entry, prop).items as Item[];
				changed = items.some((v, i) => !sameItem(v, before[i]));
			}
			if (setting) {
				const service = placeServices.get(entry.name)!;
				const position = plan.members.findIndex((m) => m.source === service.referent);
				const before = items[position];
				items = items.map((v, i) => (i === position ? setting.value : v));
				const differs = !sameItem(before, setting.value);
				settings.push({ path: `${entry.name}.${prop.name}`, before: formatValue(prop.type, before), after: formatValue(prop.type, setting.value)!, changed: differs });
				changed ||= differs;
				setting.prop = ""; // applied
			}
			if (!changed) {
				out.push(raw);
				report.chunks.copied++;
				return;
			}
			out.push(propChunk(plan, prop.name, prop.type, { items, external: values.external }));
			rewritten.add(plan.name);
			report.chunks.rewritten++;
			return;
		}
		if (chunk.name === "PRNT") {
			// Settings on a service class that had no chunk for that property: add one.
			for (const [service, wanted] of settingsWanted) {
				const plan = planByName.get(service);
				const placeService = placeServices.get(service);
				if (!plan?.place || !placeService) continue;
				for (const setting of wanted) {
					if (!setting.prop) continue;
					const items = plan.members.map((m) => (m.source === placeService.referent ? setting.value : zeroValue(setting.type)));
					extraProps.push(propChunk(plan, setting.prop, setting.type, { items }));
					settings.push({ path: `${service}.${setting.prop}`, after: formatValue(setting.type, setting.value)!, changed: true });
					rewritten.add(plan.name);
					setting.prop = "";
				}
			}
			for (const extra of extraProps) {
				out.push(extra);
				report.chunks.added++;
			}
			const children: number[] = [];
			const parents: number[] = [];
			place.prnt.children.forEach((child, i) => {
				if (removed.has(child)) return;
				children.push(mapRef(child));
				const parent = place.prnt.parents[i];
				if (removed.has(parent)) throw new PlacePatchError(`${place.path(child)} is inside a slot but wasn't removed with it`);
				parents.push(parent === -1 ? -1 : mapRef(parent));
			});
			for (const k of incoming) {
				const instance = kernel.instances.get(k)!;
				children.push(newRef.get(k)!);
				if (incomingSet.has(instance.parent)) parents.push(newRef.get(instance.parent)!);
				else if (slotRootTarget.has(k)) {
					const service = slotRootTarget.get(k)!;
					const target = placeServices.get(service);
					parents.push(target ? mapRef(target.referent) : newRef.get(kernelServices.get(service)!.referent)!);
				} else parents.push(-1); // an added service
			}
			const body = new Bytes();
			body.u8(place.prnt.version);
			body.u32(children.length);
			body.referents(children);
			body.referents(parents);
			out.push(encodeChunk("PRNT", body.done(), compression));
			report.chunks.rewritten++;
			return;
		}
		out.push(raw);
		report.chunks.copied++;
	});
	for (const [service, wanted] of settingsWanted) {
		for (const setting of wanted) {
			if (setting.prop && !placeServices.has(service)) settings.push({ path: `${service}.${setting.prop}`, after: formatValue(setting.type, setting.value)!, changed: true });
		}
	}

	const header = new Uint8Array(place.header);
	const view = new DataView(header.buffer);
	view.setInt32(16, kept.length, true);
	view.setInt32(20, survivors.length + incoming.length, true);
	const total = out.reduce((n, part) => n + part.length, 0) + header.length + place.tail.length;
	const bytes = new Uint8Array(total);
	bytes.set(header, 0);
	let offset = header.length;
	for (const part of out) {
		bytes.set(part, offset);
		offset += part.length;
	}
	bytes.set(place.tail, offset);
	report.chunks.after = out.length;
	report.classes.rewritten = [...rewritten].sort();

	// Per slot: instance counts and script changes.
	for (const slot of input.slots) {
		const before = slotScripts(place, slot);
		const after = slotScripts(kernel, slot);
		const roots = slotRoots(place, slot);
		const scripts = { changed: [] as string[], added: [] as string[], removed: [] as string[], same: 0 };
		for (const [path, hash] of after) {
			if (!before.has(path)) scripts.added.push(path);
			else if (before.get(path) !== hash) scripts.changed.push(path);
			else scripts.same++;
		}
		for (const path of before.keys()) if (!after.has(path)) scripts.removed.push(path);
		report.slots.push({
			slot: slotKey(slot),
			before: roots.reduce((n, r) => n + place.subtree(r.referent).length, 0),
			after: kernel.subtree(slotRoots(kernel, slot)[0].referent).length,
			copies: roots.length,
			scripts,
		});
	}
	return { bytes, report };
}

// Verification (independent of PlaceFile: the CLI's plain reader, readRbxmDetailed) ----------------------------------------

export interface PatchVerification {
	ok: boolean;
	problems: string[];
	/** Instances outside the slots, before and after (must be equal, path by path). */
	outside: { before: number; after: number };
	/** Properties a class had before and lost (classes with instances outside the slots). */
	droppedProps: string[];
	/** Slot services the place didn't have (added with their slots). */
	addedServices: string[];
	/** Classes with the property chunks they had: unchanged count, out of the classes that still exist. */
	classesUnchanged: number;
}

function slotMembers(instances: RbxmInstance[], slots: SlotRef[]): { member: Set<number>; paths: Map<number, string> } {
	const byReferent = new Map(instances.map((i) => [i.referent, i]));
	const children = new Map<number, RbxmInstance[]>();
	for (const instance of instances) {
		const list = children.get(instance.parent) ?? [];
		list.push(instance);
		children.set(instance.parent, list);
	}
	const member = new Set<number>();
	for (const slot of slots) {
		const service = instances.find((i) => i.className === slot.service && (i.parent === -1 || !byReferent.has(i.parent)));
		if (!service) continue;
		const stack = (children.get(service.referent) ?? []).filter((c) => c.name === slot.name);
		while (stack.length) {
			const next = stack.pop()!;
			member.add(next.referent);
			stack.push(...(children.get(next.referent) ?? []));
		}
	}
	const paths = new Map<number, string>();
	for (const instance of instances) paths.set(instance.referent, instancePath(instance, byReferent));
	return { member, paths };
}

function multiset(instances: RbxmInstance[], keep: (i: RbxmInstance) => boolean, paths: Map<number, string>): Map<string, number> {
	const out = new Map<string, number>();
	for (const instance of instances) {
		if (!keep(instance)) continue;
		const key = `${paths.get(instance.referent)}\t${instance.className}`;
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return out;
}

/**
 * Checks a patched place against the original and the kernel build with the plain binary reader: the same instances
 * outside the slots (path and class, as a multiset), each slot path-for-path equal to the kernel build's (with the
 * slot root's attributes), and no property chunk lost by a class that still has instances outside the slots.
 */
export function verifyPatch(original: Uint8Array, patched: Uint8Array, kernelBuild: Uint8Array, slots: SlotRef[]): PatchVerification {
	const before = readRbxmDetailed(original);
	const after = readRbxmDetailed(patched);
	const kernel = readRbxmDetailed(kernelBuild);
	const problems: string[] = [];
	const b = slotMembers(before.instances, slots);
	const a = slotMembers(after.instances, slots);
	const k = slotMembers(kernel.instances, slots);
	// A slot's service the place lacked comes with the slot: not "outside".
	const topLevel = (r: ReturnType<typeof readRbxmDetailed>) => new Set(r.instances.filter((i) => i.parent === -1).map((i) => i.className));
	const hadServices = topLevel(before);
	const slotServices = new Set(slots.map((s) => s.service));
	const addedServices = [...topLevel(after)].filter((c) => slotServices.has(c) && !hadServices.has(c));
	const outsideBefore = multiset(before.instances, (i) => !b.member.has(i.referent), b.paths);
	const outsideAfter = multiset(after.instances, (i) => !a.member.has(i.referent) && !(i.parent === -1 && addedServices.includes(i.className)), a.paths);
	const differences: string[] = [];
	for (const [key, n] of outsideBefore) if (outsideAfter.get(key) !== n) differences.push(`${key.replace("\t", " (")}): ${n} before, ${outsideAfter.get(key) ?? 0} after`);
	for (const [key, n] of outsideAfter) if (!outsideBefore.has(key)) differences.push(`${key.replace("\t", " (")}): new (${n})`);
	if (differences.length) problems.push(`instances outside the slots changed: ${differences.slice(0, 10).join("; ")}${differences.length > 10 ? ` (+${differences.length - 10})` : ""}`);
	const slotList = (r: ReturnType<typeof readRbxmDetailed>, s: ReturnType<typeof slotMembers>) =>
		r.instances.filter((i) => s.member.has(i.referent)).map((i) => `${s.paths.get(i.referent)} (${i.className})`).sort().join("\n");
	if (slotList(after, a) !== slotList(kernel, k)) problems.push("the slots differ from the kernel build (paths or classes)");
	for (const slot of slots) {
		const root = (r: ReturnType<typeof readRbxmDetailed>, s: ReturnType<typeof slotMembers>) =>
			r.instances.find((i) => s.member.has(i.referent) && s.paths.get(i.referent)?.split("/").length === 2 && i.name === slot.name && s.paths.get(i.referent)?.endsWith(`/${slot.name}`));
		const want = root(kernel, k);
		const got = root(after, a);
		if (JSON.stringify(want?.attributes ?? {}) !== JSON.stringify(got?.attributes ?? {})) problems.push(`${slotKey(slot)}: attributes differ from the kernel build`);
	}
	const droppedProps: string[] = [];
	let classesUnchanged = 0;
	const outsideClasses = new Set(before.instances.filter((i) => !b.member.has(i.referent)).map((i) => i.className));
	for (const [name, info] of before.inventory.classes) {
		const next = after.inventory.classes.get(name);
		if (!next || !outsideClasses.has(name)) continue;
		let same = true;
		for (const [prop, type] of info.props) {
			if (!next.props.has(prop)) {
				droppedProps.push(`${name}.${prop}`);
				same = false;
			} else if (next.props.get(prop) !== type) {
				droppedProps.push(`${name}.${prop} (type ${type} -> ${next.props.get(prop)})`);
				same = false;
			}
		}
		if (same) classesUnchanged++;
	}
	if (droppedProps.length) problems.push(`properties lost: ${droppedProps.slice(0, 12).join(", ")}${droppedProps.length > 12 ? ` (+${droppedProps.length - 12})` : ""}`);
	if (JSON.stringify(before.inventory.meta) !== JSON.stringify(after.inventory.meta)) problems.push(`META changed: ${JSON.stringify(before.inventory.meta)} -> ${JSON.stringify(after.inventory.meta)}`);
	if (before.inventory.sharedStrings > after.inventory.sharedStrings) problems.push(`shared strings: ${before.inventory.sharedStrings} -> ${after.inventory.sharedStrings}`);
	const count = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
	return { ok: problems.length === 0, problems, outside: { before: count(outsideBefore), after: count(outsideAfter) }, droppedProps, addedServices, classesUnchanged };
}
