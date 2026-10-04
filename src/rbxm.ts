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
			if (propName === "Name" && type === 0x01 && owner) {
				for (const referent of owner.referents) {
					const instance = byReferent.get(referent);
					const value = chunk.string();
					if (instance) instance.name = value;
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
