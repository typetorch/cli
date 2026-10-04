/**
 * A minimal reader for Roblox's binary model format (.rbxm), enough to list every instance with its class, name and
 * parent: the INST, PROP (Name only) and PRNT chunks. Chunks are LZ4-block or zstd compressed (or stored).
 * Used to check that a payload holds only ModuleScripts (security audit S-L4); nothing else is decoded.
 *
 * Format: https://dom.rojo.space/binary.html
 */

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

class Reader {
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

function chunkData(compressed: Uint8Array, compressedLength: number, length: number): Uint8Array {
	if (compressedLength === 0) return compressed;
	if (startsWith(compressed, ZSTD_MAGIC)) {
		const out = new Uint8Array(Bun.zstdDecompressSync(compressed));
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
		if (name === "INST") {
			const classId = chunk.u32();
			const className = chunk.string();
			chunk.u8(); // object format (1 = services; service markers follow and are ignored)
			const count = chunk.u32();
			const referents = chunk.referents(count);
			classes.set(classId, { className, referents });
			for (const referent of referents) {
				const instance: RbxmInstance = { referent, className, name: "", parent: -1 };
				byReferent.set(referent, instance);
				order.push(instance);
			}
		} else if (name === "PROP") {
			const classId = chunk.u32();
			const propName = chunk.string();
			const type = chunk.u8();
			const owner = classes.get(classId);
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
	return order;
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

class Writer {
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

/** An AttributesSerialize blob of string attributes (type 0x02), sorted by name. */
export function writeStringAttributes(attributes: Record<string, string>): Uint8Array {
	const w = new Writer();
	const names = Object.keys(attributes).sort();
	w.u32(names.length);
	for (const name of names) {
		w.string(name);
		w.u8(0x02);
		w.string(attributes[name]);
	}
	return w.done();
}

/**
 * A binary model (.rbxm) holding ONE instance with a Name and string attributes, nothing else (other properties keep
 * their defaults). Chunks: INST, PROP Name, PROP AttributesSerialize, PRNT (LZ4 literal blocks), END (stored).
 * Used for the key asset (keyasset.ts); readRbxm reads it back.
 */
export function writeSingleInstanceRbxm(input: { className: string; name: string; attributes: Record<string, string> }): Uint8Array {
	const chunks: { name: string; data: Uint8Array; compress: boolean }[] = [];
	const inst = new Writer();
	inst.u32(0); // class id
	inst.string(input.className);
	inst.u8(0); // object format: regular instances
	inst.u32(1);
	inst.referents([0]);
	chunks.push({ name: "INST", data: inst.done(), compress: true });
	const name = new Writer();
	name.u32(0);
	name.string("Name");
	name.u8(0x01); // String
	name.string(input.name);
	chunks.push({ name: "PROP", data: name.done(), compress: true });
	const attrs = new Writer();
	attrs.u32(0);
	attrs.string("AttributesSerialize");
	attrs.u8(0x01); // String (binary)
	const blob = writeStringAttributes(input.attributes);
	attrs.u32(blob.length);
	attrs.bytes(blob);
	chunks.push({ name: "PROP", data: attrs.done(), compress: true });
	const prnt = new Writer();
	prnt.u8(0); // version
	prnt.u32(1);
	prnt.referents([0]);
	prnt.referents([-1]);
	chunks.push({ name: "PRNT", data: prnt.done(), compress: true });
	chunks.push({ name: "END", data: new TextEncoder().encode("</roblox>"), compress: false });

	const file = new Writer();
	file.bytes(new TextEncoder().encode(MAGIC));
	file.bytes(SIGNATURE);
	file.u8(0); // version (u16)
	file.u8(0);
	file.u32(1); // class count
	file.u32(1); // instance count
	file.bytes(new Uint8Array(8)); // reserved
	for (const chunk of chunks) {
		const nameBytes = new Uint8Array(4);
		nameBytes.set(new TextEncoder().encode(chunk.name));
		file.bytes(nameBytes);
		const stored = chunk.compress ? lz4LiteralBlock(chunk.data) : chunk.data;
		file.u32(chunk.compress ? stored.length : 0);
		file.u32(chunk.data.length);
		file.u32(0); // reserved
		file.bytes(stored);
	}
	return file.done();
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
