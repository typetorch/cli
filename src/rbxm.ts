/**
 * A minimal reader for Roblox's binary model format (.rbxm), enough to list every instance with its class, name and
 * parent: the INST, PROP (Name only) and PRNT chunks. Chunks are LZ4-block or zstd compressed (or stored).
 * Used to check that a payload holds only ModuleScripts (security audit S-L4); nothing else is decoded.
 *
 * zstd needs Node 22.15+ under Node (runtime.ts); Roblox-serialized exports (hot assets) use it.
 *
 * Format: https://dom.rojo.space/binary.html
 */
import { zstdCompress, zstdDecompress, ZstdUnavailableError } from "./runtime.ts";

export interface RbxmInstance {
	referent: number;
	className: string;
	name: string;
	/** Referent of the parent; -1 for a root. */
	parent: number;
	/** String, number and boolean attributes (other attribute types are skipped). */
	attributes?: Record<string, string | number | boolean>;
}

export class RbxmError extends Error {
	override name = "RbxmError";
}

const MAGIC = "<roblox!";
const SIGNATURE = [0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Decompresses one LZ4 block (no frame) into exactly `size` bytes. */
export function lz4Block(input: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(size);
	let i = 0;
	let o = 0;
	while (i < input.length) {
		const token = input[i++];
		let literals = token >>> 4;
		if (literals === 15) {
			let b: number;
			do {
				b = input[i++];
				literals += b;
			} while (b === 255 && i < input.length);
		}
		if (o + literals > size || i + literals > input.length) throw new RbxmError("corrupt LZ4 block (literals)");
		out.set(input.subarray(i, i + literals), o);
		i += literals;
		o += literals;
		if (i >= input.length) break; // the last sequence has literals only
		const offset = input[i] | (input[i + 1] << 8);
		i += 2;
		if (offset === 0 || offset > o) throw new RbxmError("corrupt LZ4 block (offset)");
		let length = (token & 15) + 4;
		if ((token & 15) === 15) {
			let b: number;
			do {
				b = input[i++];
				length += b;
			} while (b === 255 && i < input.length);
		}
		if (o + length > size) throw new RbxmError("corrupt LZ4 block (match)");
		for (let k = 0; k < length; k++, o++) out[o] = out[o - offset]; // byte by byte: matches may overlap
	}
	if (o !== size) throw new RbxmError(`corrupt LZ4 block (${o} of ${size} bytes)`);
	return out;
}

export class Reader {
	offset = 0;
	private readonly view: DataView;
	constructor(readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	need(n: number) {
		if (this.offset + n > this.bytes.length) throw new RbxmError("unexpected end of data");
	}
	u8(): number {
		this.need(1);
		return this.bytes[this.offset++];
	}
	u32(): number {
		this.need(4);
		const value = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return value;
	}
	take(n: number): Uint8Array {
		this.need(n);
		const slice = this.bytes.subarray(this.offset, this.offset + n);
		this.offset += n;
		return slice;
	}
	string(): string {
		return new TextDecoder().decode(this.take(this.u32()));
	}
	/** `count` big-endian i32s stored byte-plane interleaved, zigzag-transformed. */
	interleavedI32(count: number): number[] {
		const raw = this.take(count * 4);
		const values: number[] = [];
		for (let i = 0; i < count; i++) {
			const u = ((raw[i] << 24) | (raw[count + i] << 16) | (raw[2 * count + i] << 8) | raw[3 * count + i]) >>> 0;
			values.push((u >>> 1) ^ -(u & 1));
		}
		return values;
	}
	/** Referents: interleaved i32s, delta-encoded. */
	referents(count: number): number[] {
		const values = this.interleavedI32(count);
		for (let i = 1; i < values.length; i++) values[i] += values[i - 1];
		return values;
	}
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
	return prefix.every((b, i) => bytes[i] === b);
}

export function chunkData(compressed: Uint8Array, compressedLength: number, length: number): Uint8Array {
	if (compressedLength === 0) return compressed;
	if (startsWith(compressed, ZSTD_MAGIC)) {
		let out: Uint8Array;
		try {
			out = zstdDecompress(compressed, length);
		} catch (error) {
			if (error instanceof ZstdUnavailableError) throw new RbxmError(`this .rbxm has zstd chunks: ${error.message}`);
			throw new RbxmError(`zstd chunk is invalid: ${(error as Error).message}`);
		}
		if (out.length !== length) throw new RbxmError(`zstd chunk is ${out.length} bytes, expected ${length}`);
		return out;
	}
	return lz4Block(compressed, length);
}

/**
 * An AttributesSerialize blob: u32 count, then per attribute a u32-length name, a type byte and the value. Decodes
 * strings (0x02), booleans (0x03), float32 (0x05) and float64 (0x06); stops at any other type.
 */
export function readAttributes(blob: Uint8Array): Record<string, string | number | boolean> {
	const reader = new Reader(blob);
	const out: Record<string, string | number | boolean> = {};
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	try {
		const count = reader.u32();
		for (let i = 0; i < count; i++) {
			const key = reader.string();
			const type = reader.u8();
			if (type === 0x02) out[key] = reader.string();
			else if (type === 0x03) out[key] = reader.u8() !== 0;
			else if (type === 0x05) {
				reader.need(4);
				out[key] = view.getFloat32(reader.offset, true);
				reader.offset += 4;
			} else if (type === 0x06) {
				reader.need(8);
				out[key] = view.getFloat64(reader.offset, true);
				reader.offset += 8;
			} else break;
		}
	} catch {}
	return out;
}

/** Every instance in a binary model, in INST order. */
export function readRbxm(bytes: Uint8Array): RbxmInstance[] {
	return readRbxmDetailed(bytes).instances;
}

/** One class of a binary file: its instance count and every property chunk (name -> type id). */
export interface RbxmClassInventory {
	instances: number;
	props: Map<string, number>;
}

/** What a binary model or place holds besides the instance tree: chunk counts, META entries, shared strings, classes. */
export interface RbxmInventory {
	/** Chunk name -> how many (INST, PROP, PRNT, META, SSTR, SIGN, END...). */
	chunks: Record<string, number>;
	/** The META chunk's key/value pairs (Roblox writes ExplicitAutoJoints = "true"). */
	meta: Record<string, string>;
	/** Entries in the SSTR (shared strings) chunk. */
	sharedStrings: number;
	/** Class name -> instances and property chunks. */
	classes: Map<string, RbxmClassInventory>;
}

/**
 * readRbxm plus the inventory of the file (kernel patch verification: which classes have which property chunks, so
 * a property that a re-serialization dropped shows up). Decodes only INST, PROP Name/AttributesSerialize, PRNT, META
 * and the SSTR count; other property values are not decoded.
 */
export function readRbxmDetailed(bytes: Uint8Array): { instances: RbxmInstance[]; inventory: RbxmInventory } {
	const inventory: RbxmInventory = { chunks: {}, meta: {}, sharedStrings: 0, classes: new Map() };
	const header = new Reader(bytes);
	if (new TextDecoder().decode(header.take(8)) !== MAGIC || !startsWith(header.take(6), SIGNATURE)) {
		throw new RbxmError("not a binary Roblox model (.rbxm)");
	}
	header.take(2); // version
	header.u32(); // class count
	header.u32(); // instance count
	header.take(8); // reserved

	const classes = new Map<number, { className: string; referents: number[] }>();
	const byReferent = new Map<number, RbxmInstance>();
	const order: RbxmInstance[] = [];
	while (header.offset < bytes.length) {
		const name = new TextDecoder().decode(header.take(4)).replace(/\0+$/, "");
		const compressedLength = header.u32();
		const length = header.u32();
		header.u32(); // reserved
		const data = chunkData(header.take(compressedLength === 0 ? length : compressedLength), compressedLength, length);
		const chunk = new Reader(data);
		inventory.chunks[name] = (inventory.chunks[name] ?? 0) + 1;
		if (name === "INST") {
			const classId = chunk.u32();
			const className = chunk.string();
			chunk.u8(); // object format (1 = services; service markers follow and are ignored)
			const count = chunk.u32();
			const referents = chunk.referents(count);
			classes.set(classId, { className, referents });
			const known = inventory.classes.get(className);
			if (known) known.instances += count;
			else inventory.classes.set(className, { instances: count, props: new Map() });
			for (const referent of referents) {
				const instance: RbxmInstance = { referent, className, name: "", parent: -1 };
				byReferent.set(referent, instance);
				order.push(instance);
			}
		} else if (name === "META") {
			const count = chunk.u32();
			for (let i = 0; i < count; i++) {
				const key = chunk.string();
				inventory.meta[key] = chunk.string();
			}
		} else if (name === "SSTR") {
			chunk.u32(); // version
			inventory.sharedStrings += chunk.u32();
		} else if (name === "PROP") {
			const classId = chunk.u32();
			const propName = chunk.string();
			const type = chunk.u8();
			const owner = classes.get(classId);
			if (owner) inventory.classes.get(owner.className)?.props.set(propName, type);
			if ((propName === "Name" || propName === "AttributesSerialize") && type === 0x01 && owner) {
				for (const referent of owner.referents) {
					const instance = byReferent.get(referent);
					if (propName === "Name") {
						const value = chunk.string();
						if (instance) instance.name = value;
					} else {
						const blob = chunk.take(chunk.u32());
						if (instance && blob.length > 0) instance.attributes = readAttributes(blob);
					}
				}
			}
		} else if (name === "PRNT") {
			chunk.u8(); // version
			const count = chunk.u32();
			const children = chunk.referents(count);
			const parents = chunk.referents(count);
			for (let i = 0; i < count; i++) {
				const instance = byReferent.get(children[i]);
				if (instance) instance.parent = parents[i];
			}
		} else if (name === "END") {
			break;
		}
	}
	return { instances: order, inventory };
}

// Writing ------------------------------------------------------------------------------------------------------------

/** One LZ4 block holding only literals: valid for every LZ4 decoder, no compression needed for tiny chunks. */
export function lz4LiteralBlock(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	const length = data.length;
	if (length < 15) out.push(length << 4);
	else {
		out.push(0xf0);
		let rest = length - 15;
		while (rest >= 255) {
			out.push(255);
			rest -= 255;
		}
		out.push(rest);
	}
	const block = new Uint8Array(out.length + length);
	block.set(out, 0);
	block.set(data, out.length);
	return block;
}

export class Writer {
	private parts: number[] = [];
	u8(value: number) {
		this.parts.push(value & 0xff);
	}
	u32(value: number) {
		for (let i = 0; i < 4; i++) this.parts.push((value >>> (8 * i)) & 0xff);
	}
	bytes(data: Uint8Array | number[]) {
		for (const b of data) this.parts.push(b);
	}
	string(text: string) {
		const data = new TextEncoder().encode(text);
		this.u32(data.length);
		this.bytes(data);
	}
	/** Referents: delta-encoded, zigzag, big-endian, byte-plane interleaved i32s. */
	referents(values: number[]) {
		const deltas = values.map((v, i) => (i === 0 ? v : v - values[i - 1]));
		const encoded = deltas.map((v) => ((v << 1) ^ (v >> 31)) >>> 0);
		for (let plane = 0; plane < 4; plane++) for (const v of encoded) this.parts.push((v >>> (8 * (3 - plane))) & 0xff);
	}
	done(): Uint8Array {
		return new Uint8Array(this.parts);
	}
}

/** Attribute values the writers encode: strings (0x02), booleans (0x03) and numbers as float64 (0x06). */
export type AttributeValue = string | number | boolean;

function writeAttributeValue(w: Writer, name: string, value: AttributeValue) {
	if (typeof value === "string") {
		w.u8(0x02);
		w.string(value);
	} else if (typeof value === "boolean") {
		w.u8(0x03);
		w.u8(value ? 1 : 0);
	} else {
		if (!Number.isFinite(value)) throw new RbxmError(`attribute ${name}: ${value} is not a finite number`);
		const data = new Uint8Array(8);
		new DataView(data.buffer).setFloat64(0, value, true);
		w.u8(0x06);
		w.bytes(data);
	}
}

/** An AttributesSerialize blob (u32 count, then name, type byte and value per attribute), sorted by name. */
export function writeAttributes(attributes: Record<string, AttributeValue>): Uint8Array {
	const w = new Writer();
	const names = Object.keys(attributes).sort();
	w.u32(names.length);
	for (const name of names) {
		w.string(name);
		writeAttributeValue(w, name, attributes[name]);
	}
	return w.done();
}

/** An AttributesSerialize blob of string attributes (type 0x02), sorted by name. */
export function writeStringAttributes(attributes: Record<string, string>): Uint8Array {
	return writeAttributes(attributes);
}

/** One instance for `writeRbxm`: `parent` is the index of its parent in the list, or -1 for a root. */
export interface RbxmWriteInstance {
	className: string;
	name: string;
	parent: number;
	attributes?: Record<string, AttributeValue>;
}

const textBytes = (text: string) => new TextEncoder().encode(text);

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	let size = 0;
	for (const part of parts) size += part.length;
	const out = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function u32Bytes(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0, true);
	return out;
}

export type ChunkCompression = "lz4" | "zstd" | "none";

/** A chunk with its 16-byte header; "lz4" stores one literal-only LZ4 block. */
export function encodeChunk(name: string, data: Uint8Array, compression: ChunkCompression): Uint8Array {
	const header = new Uint8Array(16);
	header.set(textBytes(name).subarray(0, 4), 0);
	const view = new DataView(header.buffer);
	const stored = compression === "lz4" ? lz4LiteralBlock(data) : compression === "zstd" ? zstdCompress(data) : data;
	view.setUint32(4, compression === "none" ? 0 : stored.length, true);
	view.setUint32(8, data.length, true);
	return concatBytes([header, stored]);
}

function fileHeader(classes: number, instances: number): Uint8Array {
	const header = new Uint8Array(32);
	header.set(textBytes(MAGIC), 0);
	header.set(SIGNATURE, 8);
	const view = new DataView(header.buffer);
	view.setUint32(16, classes, true);
	view.setUint32(20, instances, true);
	return header;
}

/**
 * A binary model (.rbxm) of the given instances, each with a Name and attributes only (other properties keep their
 * defaults). Chunks: INST per class, PROP Name and PROP AttributesSerialize per class, PRNT, END. Used for the key
 * asset, the placeholder that reserves a hot asset's id, and tests. `compression` defaults to LZ4 literal blocks.
 */
export function writeRbxm(instances: RbxmWriteInstance[], options: { compression?: ChunkCompression } = {}): Uint8Array {
	const compression = options.compression ?? "lz4";
	const classes: { className: string; members: number[] }[] = [];
	for (const [index, instance] of instances.entries()) {
		if (instance.parent !== -1 && (instance.parent < 0 || instance.parent >= instances.length || instance.parent === index)) {
			throw new RbxmError(`instance ${index} (${instance.name}) has no valid parent (${instance.parent})`);
		}
		let owner = classes.find((c) => c.className === instance.className);
		if (!owner) {
			owner = { className: instance.className, members: [] };
			classes.push(owner);
		}
		owner.members.push(index);
	}
	const chunks: Uint8Array[] = [];
	for (const [classId, owner] of classes.entries()) {
		const inst = new Writer();
		inst.u32(classId);
		inst.string(owner.className);
		inst.u8(0); // object format: regular instances
		inst.u32(owner.members.length);
		inst.referents(owner.members);
		chunks.push(encodeChunk("INST", inst.done(), compression));
	}
	for (const [classId, owner] of classes.entries()) {
		const name = new Writer();
		name.u32(classId);
		name.string("Name");
		name.u8(0x01); // String
		for (const member of owner.members) name.string(instances[member].name);
		chunks.push(encodeChunk("PROP", name.done(), compression));
		const attrs = new Writer();
		attrs.u32(classId);
		attrs.string("AttributesSerialize");
		attrs.u8(0x01); // String (binary)
		for (const member of owner.members) {
			const own = instances[member].attributes;
			const blob = own && Object.keys(own).length > 0 ? writeAttributes(own) : new Uint8Array(0);
			attrs.u32(blob.length);
			attrs.bytes(blob);
		}
		chunks.push(encodeChunk("PROP", attrs.done(), compression));
	}
	const prnt = new Writer();
	prnt.u8(0); // version
	prnt.u32(instances.length);
	prnt.referents(instances.map((_, index) => index));
	prnt.referents(instances.map((instance) => instance.parent));
	chunks.push(encodeChunk("PRNT", prnt.done(), compression));
	chunks.push(encodeChunk("END", textBytes("</roblox>"), "none"));
	return concatBytes([fileHeader(classes.length, instances.length), ...chunks]);
}

/**
 * A binary model (.rbxm) holding ONE instance with a Name and attributes, nothing else (other properties keep their
 * defaults). Chunks: INST, PROP Name, PROP AttributesSerialize, PRNT (LZ4 literal blocks), END (stored).
 * Used for the key asset (keyasset.ts); readRbxm reads it back.
 */
export function writeSingleInstanceRbxm(input: { className: string; name: string; attributes: Record<string, AttributeValue> }): Uint8Array {
	return writeRbxm([{ className: input.className, name: input.name, parent: -1, attributes: input.attributes }]);
}

// Editing ------------------------------------------------------------------------------------------------------------

export interface RawChunk {
	name: string;
	/** Byte range of the chunk (header + payload) in the file. */
	start: number;
	end: number;
	compressedLength: number;
	length: number;
	payload: Uint8Array;
}

export function rawChunks(bytes: Uint8Array): { chunks: RawChunk[]; tail: number } {
	const header = new Reader(bytes);
	if (new TextDecoder().decode(header.take(8)) !== MAGIC || !startsWith(header.take(6), SIGNATURE)) {
		throw new RbxmError("not a binary Roblox model (.rbxm)");
	}
	header.take(18); // version, class count, instance count, reserved
	const chunks: RawChunk[] = [];
	while (header.offset < bytes.length) {
		const start = header.offset;
		const name = new TextDecoder().decode(header.take(4)).replace(/\0+$/, "");
		const compressedLength = header.u32();
		const length = header.u32();
		header.u32(); // reserved
		const payload = header.take(compressedLength === 0 ? length : compressedLength);
		chunks.push({ name, start, end: header.offset, compressedLength, length, payload });
		if (name === "END") break;
	}
	return { chunks, tail: header.offset };
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

/** Appends attributes to an AttributesSerialize blob; refuses a name the blob already holds. */
function addAttributes(blob: Uint8Array, attributes: Record<string, AttributeValue>): Uint8Array {
	const count = blob.length >= 4 ? new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true) : 0;
	const rest = blob.length >= 4 ? blob.subarray(4) : new Uint8Array(0);
	for (const name of Object.keys(attributes)) {
		const encoded = textBytes(name);
		if (indexOfBytes(rest, concatBytes([u32Bytes(encoded.length), encoded])) !== -1) {
			throw new RbxmError(`the root already has a "${name}" attribute`);
		}
	}
	const added = writeAttributes(attributes);
	return concatBytes([u32Bytes(count + Object.keys(attributes).length), rest, added.subarray(4)]);
}

/**
 * Adds attributes to the ONE root instance of a binary model and leaves everything else byte for byte: only the root
 * class's PROP AttributesSerialize chunk is rewritten (as an LZ4 literal block), or added when the class has none.
 * Used to stamp TypeTorchAssetId / TypeTorchAssetHash onto a hot asset's export before the upload. Refuses a model
 * with more than one root, and an attribute name the root already has.
 */
export function setRootAttributes(bytes: Uint8Array, attributes: Record<string, AttributeValue>): Uint8Array {
	const { chunks, tail } = rawChunks(bytes);
	const classes = new Map<number, number[]>();
	const parents = new Map<number, number>();
	const props: { chunk: RawChunk; classId: number; name: string; data: Uint8Array }[] = [];
	for (const chunk of chunks) {
		if (chunk.name !== "INST" && chunk.name !== "PRNT" && chunk.name !== "PROP") continue;
		const data = chunkData(chunk.payload, chunk.compressedLength, chunk.length);
		const reader = new Reader(data);
		if (chunk.name === "INST") {
			const classId = reader.u32();
			reader.string(); // class name
			reader.u8(); // object format
			classes.set(classId, reader.referents(reader.u32()));
		} else if (chunk.name === "PRNT") {
			reader.u8(); // version
			const count = reader.u32();
			const children = reader.referents(count);
			const parentRefs = reader.referents(count);
			for (let i = 0; i < count; i++) parents.set(children[i], parentRefs[i]);
		} else {
			const classId = reader.u32();
			props.push({ chunk, classId, name: reader.string(), data });
		}
	}
	const all = new Set([...classes.values()].flat());
	const roots = [...all].filter((referent) => {
		const parent = parents.get(referent) ?? -1;
		return parent === -1 || !all.has(parent);
	});
	if (roots.length !== 1) throw new RbxmError(`expected one root instance, found ${roots.length}`);
	const root = roots[0];
	const [classId, members] = [...classes.entries()].find(([, referents]) => referents.includes(root))!;
	const index = members.indexOf(root);

	const existing = props.find((p) => p.classId === classId && p.name === "AttributesSerialize");
	const blobs: Uint8Array[] = members.map(() => new Uint8Array(0));
	if (existing) {
		const reader = new Reader(existing.data);
		reader.u32(); // class id
		reader.string(); // property name
		const type = reader.u8();
		if (type !== 0x01) throw new RbxmError(`AttributesSerialize has type ${type}, expected 1 (String)`);
		for (let i = 0; i < members.length; i++) blobs[i] = reader.take(reader.u32());
	}
	blobs[index] = addAttributes(blobs[index], attributes);
	const head = new Writer();
	head.u32(classId);
	head.string("AttributesSerialize");
	head.u8(0x01);
	const replacement = encodeChunk("PROP", concatBytes([head.done(), ...blobs.flatMap((blob) => [u32Bytes(blob.length), blob])]), "lz4");

	const out: Uint8Array[] = [bytes.subarray(0, 32)];
	let placed = false;
	for (const chunk of chunks) {
		if (existing && chunk === existing.chunk) {
			out.push(replacement);
			placed = true;
			continue;
		}
		if (!existing && !placed && (chunk.name === "PRNT" || chunk.name === "END")) {
			out.push(replacement);
			placed = true;
		}
		out.push(bytes.subarray(chunk.start, chunk.end));
	}
	if (!placed) throw new RbxmError("no PRNT or END chunk to put the attributes before");
	out.push(bytes.subarray(tail));
	return concatBytes(out);
}

/** `Root/Child/Grandchild` for an instance. */
export function instancePath(instance: RbxmInstance, byReferent: Map<number, RbxmInstance>): string {
	const parts: string[] = [];
	let current: RbxmInstance | undefined = instance;
	const seen = new Set<number>();
	while (current && !seen.has(current.referent)) {
		seen.add(current.referent);
		parts.unshift(current.name || `<${current.className}>`);
		current = current.parent === -1 ? undefined : byReferent.get(current.parent);
	}
	return parts.join("/");
}

export interface PayloadContents {
	instances: number;
	modules: number;
	/** Instances that may not be in a payload, as "path (Class)". */
	disallowed: string[];
	/** Problems with the root (missing, not a Model, several roots). */
	rootProblems: string[];
}

/**
 * A payload is one Model root holding only Folders and ModuleScripts (plans/03): nothing in an upload can run by
 * itself. Scripts, LocalScripts, values from .txt files, models from .rbxm files and anything else are reported.
 */
export function checkPayloadContents(bytes: Uint8Array): PayloadContents {
	const instances = readRbxm(bytes);
	const byReferent = new Map(instances.map((i) => [i.referent, i]));
	const roots = instances.filter((i) => i.parent === -1 || !byReferent.has(i.parent));
	const rootProblems: string[] = [];
	if (roots.length !== 1) rootProblems.push(`${roots.length} root instances (expected one Model)`);
	else if (roots[0].className !== "Model") rootProblems.push(`the root is a ${roots[0].className}, expected a Model`);
	const disallowed: string[] = [];
	let modules = 0;
	for (const instance of instances) {
		if (instance.className === "ModuleScript") {
			modules++;
			continue;
		}
		if (instance.className === "Folder") continue;
		if (roots.length === 1 && instance === roots[0] && instance.className === "Model") continue;
		disallowed.push(`${instancePath(instance, byReferent)} (${instance.className})`);
	}
	return { instances: instances.length, modules, disallowed, rootProblems };
}
