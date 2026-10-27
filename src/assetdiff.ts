/**
 * What changed inside a hot asset: the data behind the Studio plugin's "Diff" button (`assets status --json`, each
 * change's `diff`; the contract is serve/protocol.ts).
 *
 * The lockfile keeps only a hash per asset, so the bytes of the lockfile's version come from the state dir
 * (`hot-assets/<hash>.rbxm`): every `assets status|sync` on this machine keeps a copy of each export it saw and drops
 * the copies no lockfile entry or current export refers to. Without that copy (a lockfile synced elsewhere, or synced
 * before this feature) the diff is a summary of the new export alone, and the next sync here fills the gap.
 *
 * Two binary models are compared instance by instance. Instances are matched by path (the root's name, then each
 * child's name; same-named siblings get "#2", "#3" in file order), so a renamed instance shows as removed and added.
 * Property values are decoded for the common binary types (strings, bools, ints, floats, enums, refs, UDim, UDim2,
 * Vector2, Vector3, Color3, CFrame, BrickColor, NumberRange, Rect, Faces, Axes, Font, shared strings, attributes,
 * tags); a property chunk of another type whose bytes differ is listed by name in `undecoded`. The output is bounded:
 * MAX_ENTRIES instances, MAX_PROPS properties each, values cut at MAX_VALUE characters.
 *
 * Format: https://dom.rojo.space/binary.html
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkData, readAttributes, Reader, RbxmError } from "./rbxm.ts";

export interface AssetDiffProp {
	name: string;
	/** The value in the lockfile's version; missing when the property wasn't in that file. */
	from?: string;
	/** The value in the export; missing when the property isn't in it any more. */
	to?: string;
}

export interface AssetDiffEntry {
	kind: "added" | "removed" | "changed";
	/** The instance's path inside the asset, from its root (`Shop/Frame/Title`). */
	path: string;
	className: string;
	/** Changed properties (`kind: "changed"` only), at most MAX_PROPS. */
	props?: AssetDiffProp[];
	/** How many changed properties are not listed. */
	moreProps?: number;
}

export interface TreeSummary {
	instances: number;
	bytes: number;
	/** Class name -> count, the most frequent MAX_CLASSES. */
	classes: Record<string, number>;
}

export interface AssetDiff {
	/** "state": the lockfile's version was read from the state dir and compared; "none": only the export is known. */
	baseline: "state" | "none";
	/** Why there is no baseline, or what else to know. */
	note?: string;
	/** The lockfile's version, when its bytes were available. */
	before?: TreeSummary;
	/** The export (missing for a removed asset). */
	after?: TreeSummary;
	/** Instances added, removed or changed, root first, then by path; at most MAX_ENTRIES. */
	entries: AssetDiffEntry[];
	/** How many entries are not listed. */
	more: number;
	/** `Class.Property` chunks that differ but hold a type this reader doesn't decode per instance. */
	undecoded?: string[];
}

export const MAX_ENTRIES = 30;
export const MAX_PROPS = 8;
export const MAX_VALUE = 48;
export const MAX_CLASSES = 8;
export const BASELINE_DIR = "hot-assets";

/** Properties that change on every save or clone without meaning anything to the asset. */
const IGNORED_PROPS = new Set(["UniqueId", "HistoryId", "SourceAssetId", "Capabilities", "DefinesCapabilities"]);
const IGNORED_TYPES = new Set([0x1f, 0x21]); // UniqueId, SecurityCapabilities

// Decoding -----------------------------------------------------------------------------------------------------------

interface Node {
	referent: number;
	className: string;
	name: string;
	parent: number;
	/** Property name -> rendered value (refs are rendered after the tree is known). */
	props: Map<string, string>;
	path?: string;
}

interface Tree {
	nodes: Map<number, Node>;
	order: Node[];
	byPath: Map<string, Node>;
	/** `Class.Property` -> raw chunk bytes, for the types that aren't decoded per instance. */
	undecoded: Map<string, Uint8Array>;
	bytes: number;
}

function num(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	const rounded = Math.round(value * 1000) / 1000;
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

function floatBits(u: number): number {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, u);
	return view.getFloat32(0);
}

/** `count` big-endian u32s stored byte-plane interleaved. */
function interleavedU32(reader: Reader, count: number): number[] {
	const raw = reader.take(count * 4);
	const values: number[] = [];
	for (let i = 0; i < count; i++) values.push(((raw[i] << 24) | (raw[count + i] << 16) | (raw[2 * count + i] << 8) | raw[3 * count + i]) >>> 0);
	return values;
}

/** Interleaved "Roblox floats": the sign bit is rotated to the lowest bit so small values compress. */
function interleavedF32(reader: Reader, count: number): number[] {
	return interleavedU32(reader, count).map((u) => floatBits(((u >>> 1) | (u << 31)) >>> 0));
}

function interleavedI64(reader: Reader, count: number): bigint[] {
	const raw = reader.take(count * 8);
	const values: bigint[] = [];
	for (let i = 0; i < count; i++) {
		let u = 0n;
		for (let k = 0; k < 8; k++) u = (u << 8n) | BigInt(raw[k * count + i]);
		values.push((u >> 1n) ^ -(u & 1n));
	}
	return values;
}

function f32le(reader: Reader): number {
	const slice = reader.take(4);
	return new DataView(slice.buffer, slice.byteOffset, 4).getFloat32(0, true);
}

function f64le(reader: Reader): number {
	const slice = reader.take(8);
	return new DataView(slice.buffer, slice.byteOffset, 8).getFloat64(0, true);
}

function i16le(reader: Reader): number {
	const slice = reader.take(2);
	return new DataView(slice.buffer, slice.byteOffset, 2).getInt16(0, true);
}

function text(value: string): string {
	return JSON.stringify(value);
}

function tuple(...parts: number[]): string {
	return `(${parts.map(num).join(", ")})`;
}

function attributeValue(value: unknown): string {
	return typeof value === "string" ? text(value) : typeof value === "number" ? num(value) : String(value);
}

/** The shared string table: index -> a short rendering (its length and the file's MD5 prefix). */
function readSharedStrings(data: Uint8Array): string[] {
	const reader = new Reader(data);
	reader.u32(); // version
	const count = reader.u32();
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const md5 = reader.take(16);
		const bytes = reader.take(reader.u32());
		out.push(`shared(${bytes.length} bytes, ${Array.from(md5.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join("")})`);
	}
	return out;
}

/**
 * Decodes one PROP chunk's values for `count` instances; returns one rendering per instance, or undefined when the
 * type isn't decoded per instance. Refs come back as `ref:<referent>` and are resolved once the tree is complete.
 */
function decodeValues(type: number, reader: Reader, count: number, name: string, shared: string[]): (string | undefined)[] | undefined {
	const each = (fn: () => string) => Array.from({ length: count }, fn);
	switch (type) {
		case 0x01: {
			if (name === "AttributesSerialize") {
				return each(() => {
					const blob = reader.take(reader.u32());
					if (blob.length === 0) return "";
					const decoded = readAttributes(blob);
					const keys = Object.keys(decoded).sort();
					// Types readAttributes skips still count through the blob's bytes.
					const digest = Array.from(blob.subarray(0, 64), (b) => b.toString(16).padStart(2, "0")).join("");
					return `${keys.map((k) => `${k}=${attributeValue(decoded[k])}`).join("; ")}|${blob.length}:${digest}`;
				});
			}
			if (name === "Tags") {
				return each(() => {
					const raw = new TextDecoder().decode(reader.take(reader.u32()));
					return raw ? raw.split("\0").filter(Boolean).sort().map(text).join(", ") : "";
				});
			}
			return each(() => text(reader.string()));
		}
		case 0x02:
			return each(() => (reader.u8() !== 0 ? "true" : "false"));
		case 0x03:
			return reader.interleavedI32(count).map(num);
		case 0x04:
			return interleavedF32(reader, count).map(num);
		case 0x05:
			return each(() => num(f64le(reader)));
		case 0x06: {
			const scale = interleavedF32(reader, count);
			const offset = reader.interleavedI32(count);
			return scale.map((s, i) => `{${num(s)}, ${num(offset[i])}}`);
		}
		case 0x07: {
			const sx = interleavedF32(reader, count);
			const sy = interleavedF32(reader, count);
			const ox = reader.interleavedI32(count);
			const oy = reader.interleavedI32(count);
			return sx.map((_, i) => `{${num(sx[i])}, ${num(ox[i])}}, {${num(sy[i])}, ${num(oy[i])}}`);
		}
		case 0x08:
			return each(() => `origin ${tuple(f32le(reader), f32le(reader), f32le(reader))} direction ${tuple(f32le(reader), f32le(reader), f32le(reader))}`);
		case 0x09:
		case 0x0a:
			return each(() => String(reader.u8()));
		case 0x0b:
			return interleavedU32(reader, count).map((v) => `BrickColor ${v}`);
		case 0x0c: {
			const r = interleavedF32(reader, count);
			const g = interleavedF32(reader, count);
			const b = interleavedF32(reader, count);
			return r.map((_, i) => tuple(r[i], g[i], b[i]));
		}
		case 0x0d: {
			const x = interleavedF32(reader, count);
			const y = interleavedF32(reader, count);
			return x.map((_, i) => tuple(x[i], y[i]));
		}
		case 0x0e: {
			const x = interleavedF32(reader, count);
			const y = interleavedF32(reader, count);
			const z = interleavedF32(reader, count);
			return x.map((_, i) => tuple(x[i], y[i], z[i]));
		}
		case 0x10: {
			const rotations: string[] = [];
			for (let i = 0; i < count; i++) {
				const id = reader.u8();
				if (id === 0) {
					const m: number[] = [];
					for (let k = 0; k < 9; k++) m.push(f32le(reader));
					rotations.push(`rot [${m.map(num).join(", ")}]`);
				} else rotations.push(`rot #${id}`);
			}
			const x = interleavedF32(reader, count);
			const y = interleavedF32(reader, count);
			const z = interleavedF32(reader, count);
			return rotations.map((rot, i) => `${tuple(x[i], y[i], z[i])} ${rot}`);
		}
		case 0x12:
			return interleavedU32(reader, count).map((v) => `enum ${v}`);
		case 0x13:
			return reader.referents(count).map((r) => `ref:${r}`);
		case 0x14:
			return each(() => tuple(i16le(reader), i16le(reader), i16le(reader)));
		case 0x15:
			return each(() => {
				const n = reader.u32();
				const points: string[] = [];
				for (let i = 0; i < n; i++) points.push(`${num(f32le(reader))}:${num(f32le(reader))}~${num(f32le(reader))}`);
				return points.join(" ");
			});
		case 0x16:
			return each(() => {
				const n = reader.u32();
				const points: string[] = [];
				for (let i = 0; i < n; i++) {
					const t = f32le(reader);
					const rgb = tuple(f32le(reader), f32le(reader), f32le(reader));
					f32le(reader); // envelope
					points.push(`${num(t)}:${rgb}`);
				}
				return points.join(" ");
			});
		case 0x17:
			return each(() => `${num(f32le(reader))}..${num(f32le(reader))}`);
		case 0x18: {
			const x0 = interleavedF32(reader, count);
			const y0 = interleavedF32(reader, count);
			const x1 = interleavedF32(reader, count);
			const y1 = interleavedF32(reader, count);
			return x0.map((_, i) => `${tuple(x0[i], y0[i])}..${tuple(x1[i], y1[i])}`);
		}
		case 0x19:
			return each(() => {
				if (reader.u8() === 0) return "default";
				const v: number[] = [];
				for (let k = 0; k < 5; k++) v.push(f32le(reader));
				return `custom ${tuple(...v)}`;
			});
		case 0x1a: {
			const r = reader.take(count);
			const g = reader.take(count);
			const b = reader.take(count);
			return Array.from(r, (_, i) => `(${r[i]}, ${g[i]}, ${b[i]})`);
		}
		case 0x1b:
			return interleavedI64(reader, count).map(String);
		case 0x1c:
			return interleavedU32(reader, count).map((i) => shared[i] ?? `shared #${i}`);
		case 0x1d:
			return each(() => text(reader.string()));
		case 0x20:
			return each(() => {
				const family = reader.string();
				const weight = reader.u8() | (reader.u8() << 8);
				const style = reader.u8();
				reader.string(); // cachedFaceId
				return `${family} ${weight}${style ? " italic" : ""}`;
			});
		default:
			return undefined;
	}
}

/** The whole tree of a binary model with every decoded property. */
export function readTree(bytes: Uint8Array): Tree {
	const header = new Reader(bytes);
	if (new TextDecoder().decode(header.take(8)) !== "<roblox!") throw new RbxmError("not a binary Roblox model (.rbxm)");
	header.take(6 + 2 + 4 + 4 + 8); // signature, version, class count, instance count, reserved
	const chunks: { name: string; data: Uint8Array }[] = [];
	while (header.offset < bytes.length) {
		const name = new TextDecoder().decode(header.take(4)).replace(/\0+$/, "");
		const compressedLength = header.u32();
		const length = header.u32();
		header.u32(); // reserved
		chunks.push({ name, data: chunkData(header.take(compressedLength === 0 ? length : compressedLength), compressedLength, length) });
		if (name === "END") break;
	}
	let shared: string[] = [];
	for (const chunk of chunks) if (chunk.name === "SSTR") shared = readSharedStrings(chunk.data);
	const tree: Tree = { nodes: new Map(), order: [], byPath: new Map(), undecoded: new Map(), bytes: bytes.length };
	const classes = new Map<number, { className: string; referents: number[] }>();
	for (const chunk of chunks) {
		const reader = new Reader(chunk.data);
		if (chunk.name === "INST") {
			const classId = reader.u32();
			const className = reader.string();
			reader.u8();
			const count = reader.u32();
			const referents = reader.referents(count);
			classes.set(classId, { className, referents });
			for (const referent of referents) {
				const node: Node = { referent, className, name: "", parent: -1, props: new Map() };
				tree.nodes.set(referent, node);
				tree.order.push(node);
			}
		} else if (chunk.name === "PROP") {
			const classId = reader.u32();
			const propName = reader.string();
			const type = reader.u8();
			const owner = classes.get(classId);
			if (!owner || IGNORED_PROPS.has(propName) || IGNORED_TYPES.has(type)) continue;
			let values: (string | undefined)[] | undefined;
			try {
				values = decodeValues(type, reader, owner.referents.length, propName, shared);
			} catch {
				values = undefined;
			}
			if (!values) {
				tree.undecoded.set(`${owner.className}.${propName}`, chunk.data);
				continue;
			}
			for (const [i, referent] of owner.referents.entries()) {
				const node = tree.nodes.get(referent);
				const value = values[i];
				if (!node || value === undefined) continue;
				if (propName === "Name") node.name = JSON.parse(value) as string;
				else node.props.set(propName, value);
			}
		} else if (chunk.name === "PRNT") {
			reader.u8();
			const count = reader.u32();
			const children = reader.referents(count);
			const parents = reader.referents(count);
			for (let i = 0; i < count; i++) {
				const node = tree.nodes.get(children[i]);
				if (node) node.parent = parents[i];
			}
		}
	}
	// Paths: root name first; same-named siblings numbered in file order.
	const siblings = new Map<string, number>();
	const pathOf = (node: Node): string => {
		if (node.path !== undefined) return node.path;
		const parent = tree.nodes.get(node.parent);
		const base = parent && parent !== node ? `${pathOf(parent)}/${node.name}` : node.name;
		const seen = siblings.get(base) ?? 0;
		siblings.set(base, seen + 1);
		node.path = seen === 0 ? base : `${base}#${seen + 1}`;
		return node.path;
	};
	for (const node of tree.order) tree.byPath.set(pathOf(node), node);
	// Refs: the target's path, or nil.
	for (const node of tree.order) {
		for (const [name, value] of node.props) {
			if (!value.startsWith("ref:")) continue;
			const target = tree.nodes.get(Number(value.slice(4)));
			node.props.set(name, target ? `-> ${target.path ?? target.name}` : "nil");
		}
	}
	return tree;
}

// Diff ---------------------------------------------------------------------------------------------------------------

function cut(value: string): string {
	return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 3)}...` : value;
}

/** Attribute renderings carry the blob's bytes after "|": shown without them. */
function shown(name: string, value: string): string {
	if (name === "AttributesSerialize") {
		const bar = value.lastIndexOf("|");
		return cut(bar >= 0 ? value.slice(0, bar) : value);
	}
	return cut(value);
}

export function summarize(tree: Tree): TreeSummary {
	const counts = new Map<string, number>();
	for (const node of tree.order) counts.set(node.className, (counts.get(node.className) ?? 0) + 1);
	const classes: Record<string, number> = {};
	for (const [className, count] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_CLASSES)) classes[className] = count;
	return { instances: tree.order.length, bytes: tree.bytes, classes };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The differences between the lockfile's version (`before`, when its bytes are known) and the export (`after`). */
export function diffAsset(before: Uint8Array | undefined, after: Uint8Array | undefined, note?: string): AssetDiff {
	const diff: AssetDiff = { baseline: before ? "state" : "none", entries: [], more: 0 };
	if (note) diff.note = note;
	let beforeTree: Tree | undefined;
	let afterTree: Tree | undefined;
	try {
		beforeTree = before ? readTree(before) : undefined;
		afterTree = after ? readTree(after) : undefined;
	} catch (error) {
		return { ...diff, baseline: "none", note: `couldn't read the model: ${(error as Error).message}` };
	}
	if (beforeTree) diff.before = summarize(beforeTree);
	if (afterTree) diff.after = summarize(afterTree);
	if (!beforeTree || !afterTree) return diff;

	const entries: AssetDiffEntry[] = [];
	for (const node of afterTree.order) {
		const path = node.path!;
		const old = beforeTree.byPath.get(path);
		if (!old || old.className !== node.className) {
			entries.push({ kind: "added", path, className: node.className });
			continue;
		}
		const props: AssetDiffProp[] = [];
		const names = new Set([...old.props.keys(), ...node.props.keys()]);
		for (const name of [...names].sort()) {
			const from = old.props.get(name);
			const to = node.props.get(name);
			if (from === to) continue;
			const label = name === "AttributesSerialize" ? "Attributes" : name;
			props.push({ name: label, ...(from !== undefined ? { from: shown(name, from) } : {}), ...(to !== undefined ? { to: shown(name, to) } : {}) });
		}
		if (props.length > 0) {
			const entry: AssetDiffEntry = { kind: "changed", path, className: node.className, props: props.slice(0, MAX_PROPS) };
			if (props.length > MAX_PROPS) entry.moreProps = props.length - MAX_PROPS;
			entries.push(entry);
		}
	}
	for (const node of beforeTree.order) {
		const path = node.path!;
		const now = afterTree.byPath.get(path);
		if (!now || now.className !== node.className) entries.push({ kind: "removed", path, className: node.className });
	}
	// The root first, then by path (so a parent precedes its children); at one path, the removed before the added.
	const rank = { removed: 0, added: 1, changed: 2 };
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : rank[a.kind] - rank[b.kind]));
	diff.entries = entries.slice(0, MAX_ENTRIES);
	diff.more = Math.max(0, entries.length - MAX_ENTRIES);
	const undecoded: string[] = [];
	for (const [name, data] of afterTree.undecoded) {
		const old = beforeTree.undecoded.get(name);
		if (!old || !sameBytes(old, data)) undecoded.push(name);
	}
	for (const name of beforeTree.undecoded.keys()) if (!afterTree.undecoded.has(name)) undecoded.push(name);
	if (undecoded.length) diff.undecoded = undecoded.sort();
	if (entries.length === 0 && undecoded.length === 0) diff.note = "the bytes differ, but nothing this diff decodes changed (ids or metadata)";
	return diff;
}

// The state dir's copies -----------------------------------------------------------------------------------------------

function baselineFile(stateDir: string, hash: string): string {
	return join(stateDir, BASELINE_DIR, `${hash}.rbxm`);
}

/** The bytes of the version with this hash, when a run on this machine kept them. */
export function readBaseline(stateDir: string, hash: string): Uint8Array | undefined {
	if (!/^[0-9a-f]{12}$/.test(hash)) return undefined;
	const file = baselineFile(stateDir, hash);
	try {
		return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Keeps a copy of every export in the state dir (by hash) and drops the copies that neither the lockfile nor this
 * export refers to, so the folder holds at most two versions per key. Never throws: a copy is a convenience.
 */
export function keepBaselines(stateDir: string, exported: { hash: string; bytes: Uint8Array }[], lockHashes: Iterable<string>): void {
	const dir = join(stateDir, BASELINE_DIR);
	try {
		mkdirSync(dir, { recursive: true });
		const keep = new Set<string>(lockHashes);
		for (const asset of exported) {
			keep.add(asset.hash);
			const file = baselineFile(stateDir, asset.hash);
			if (!existsSync(file)) writeFileSync(file, asset.bytes);
		}
		for (const name of readdirSync(dir)) {
			const match = /^([0-9a-f]{12})\.rbxm$/.exec(name);
			if (match && !keep.has(match[1])) rmSync(join(dir, name), { force: true });
		}
	} catch {
		// best effort
	}
}
