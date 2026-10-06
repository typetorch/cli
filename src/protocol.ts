/**
 * The payload's network protocol hash (`ProtocolHash` attribute on the payload root; kernel 0.3.2, audit P-N1). When
 * the running and the next payload carry the same hash, client events sent by a client still on the old generation
 * pass through a hot swap instead of being dropped (requests always get the resync).
 *
 * Source: the arguments of every `createNetwork(...)` call in the game's compiled Luau (out/), which
 * @typetorch/transformer generates from the ClientToServer / ServerToClient interfaces: every leaf's dotted path and
 * its argument guard, both directions. That is exactly what decides whether an old client's message means the same
 * thing to the new server (paths and argument shapes). It is canonicalized before hashing, so only protocol changes
 * change the hash: comments, whitespace, file names and lines, and the order of union members and literal lists
 * (TypeScript orders unions by internal type id, which moves when unrelated code changes) don't. Request return types
 * aren't guarded and don't matter (requests never cross a swap).
 *
 * The framework's net runtime (node_modules/@typetorch/framework/out/net/runtime.luau, how a leaf call travels) is
 * hashed in too: a new framework version may encode messages differently, so it counts as a protocol change (the safe
 * direction: a changed hash only means the pre-0.3.2 resync).
 *
 * Alternatives considered: hashing the whole compiled net module (changes with comments, imports and debug-macro line
 * numbers, and misses networks declared elsewhere), or a manifest emitted by the framework/transformer (the most
 * explicit; see the report). Without any createNetwork call (no networking, or the transformer isn't running and the
 * call has no arguments) nothing is stamped.
 *
 * `createFlameworkCompat(...)` (the framework's @flamework/networking compatibility layer, the same wire format) is
 * hashed the same way, and listed (`compatFiles`) so `typetorch build` can say the game still uses it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const PROTOCOL_ATTRIBUTE = "ProtocolHash";
export const PROTOCOL_VERSION = "p1";
export const FRAMEWORK_NET_RUNTIME = "node_modules/@typetorch/framework/out/net/runtime.luau";

// A tiny reader for the Luau expressions roblox-ts emits for guards -------------------------------------------------

type Node =
	| { k: "call"; fn: string; args: Node[] }
	| { k: "table"; items: Node[]; fields: [string, Node][] }
	| { k: "str"; v: string }
	| { k: "atom"; v: string };

class Reader {
	i = 0;
	constructor(readonly s: string) {}
	skip() {
		for (;;) {
			const c = this.s[this.i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
			else if (this.s.startsWith("--", this.i)) {
				const long = /^--\[(=*)\[/.exec(this.s.slice(this.i, this.i + 20));
				if (long) {
					const end = this.s.indexOf(`]${long[1]}]`, this.i);
					this.i = end === -1 ? this.s.length : end + long[1].length + 2;
				} else {
					const end = this.s.indexOf("\n", this.i);
					this.i = end === -1 ? this.s.length : end;
				}
			} else return;
		}
	}
	peek(): string {
		this.skip();
		return this.s[this.i] ?? "";
	}
	expect(c: string) {
		if (this.peek() !== c) throw new Error(`expected "${c}" at ${this.i}, found "${this.s.slice(this.i, this.i + 20)}"`);
		this.i++;
	}
	name(): string {
		this.skip();
		const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(this.s.slice(this.i));
		if (!m) throw new Error(`expected a name at ${this.i}: "${this.s.slice(this.i, this.i + 20)}"`);
		this.i += m[0].length;
		return m[0];
	}
	string(): string {
		const quote = this.s[this.i];
		let out = "";
		this.i++;
		while (this.i < this.s.length && this.s[this.i] !== quote) {
			if (this.s[this.i] === "\\") {
				const next = this.s[this.i + 1];
				out += next === "n" ? "\n" : next === "t" ? "\t" : next;
				this.i += 2;
			} else out += this.s[this.i++];
		}
		this.i++;
		return out;
	}
	expr(): Node {
		const c = this.peek();
		if (c === "{") return this.table();
		if (c === '"' || c === "'") return { k: "str", v: this.string() };
		if (/[-0-9.]/.test(c)) {
			const m = /^-?[0-9][0-9a-fA-FxX._]*(?:[eE][-+]?[0-9]+)?/.exec(this.s.slice(this.i))!;
			this.i += m[0].length;
			return { k: "atom", v: m[0] };
		}
		const name = this.name();
		if (this.peek() === "(") {
			this.i++;
			const args: Node[] = [];
			while (this.peek() !== ")") {
				args.push(this.expr());
				if (this.peek() === ",") this.i++;
			}
			this.i++;
			return { k: "call", fn: name, args };
		}
		if (this.peek() === "{") return { k: "call", fn: name, args: [this.table()] }; // f{...} sugar
		return { k: "atom", v: name };
	}
	table(): Node {
		this.expect("{");
		const items: Node[] = [];
		const fields: [string, Node][] = [];
		while (this.peek() !== "}") {
			if (this.peek() === "[") {
				this.i++;
				const key = this.expr();
				this.expect("]");
				this.expect("=");
				fields.push([serialize(key), this.expr()]);
			} else {
				const at = this.i;
				const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.s.slice(at));
				if (m) {
					this.i += m[0].length;
					fields.push([JSON.stringify(m[0].replace(/\s*=$/, "")), this.expr()]);
				} else items.push(this.expr());
			}
			const sep = this.peek();
			if (sep === "," || sep === ";") this.i++;
		}
		this.i++;
		return { k: "table", items, fields };
	}
}

/** Guards whose arguments (or literal list) are unordered sets. */
const UNORDERED_CALLS = /(^|\.)(union|literal|intersection)$/;
const UNORDERED_LIST_CALLS = /(^|\.)literalList$/;

function canonical(node: Node): Node {
	if (node.k === "table") {
		return { k: "table", items: node.items.map(canonical), fields: node.fields.map(([key, value]) => [key, canonical(value)] as [string, Node]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
	}
	if (node.k !== "call") return node;
	let args = node.args.map(canonical);
	if (UNORDERED_CALLS.test(node.fn)) args = [...args].sort((a, b) => cmp(serialize(a), serialize(b)));
	if (UNORDERED_LIST_CALLS.test(node.fn) && args[0]?.k === "table") {
		const list = args[0];
		args = [{ ...list, items: [...list.items].sort((a, b) => cmp(serialize(a), serialize(b))) }, ...args.slice(1)];
	}
	return { k: "call", fn: node.fn, args };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function serialize(node: Node): string {
	switch (node.k) {
		case "str":
			return JSON.stringify(node.v);
		case "atom":
			return node.v;
		case "call":
			return `${node.fn}(${node.args.map(serialize).join(",")})`;
		case "table":
			return `{${[...node.items.map(serialize), ...node.fields.map(([k, v]) => `${k}=${serialize(v)}`)].join(",")}}`;
	}
}

/** The canonical text of a createNetwork call's argument list (throws when it can't be read). */
export function canonicalNetwork(args: string): string {
	const reader = new Reader(`(${args})`);
	reader.expect("(");
	const nodes: Node[] = [];
	while (reader.peek() !== ")") {
		nodes.push(reader.expr());
		if (reader.peek() === ",") reader.i++;
	}
	return nodes.map((n) => serialize(canonical(n))).join(",");
}

/** Network macros whose calls carry a game's guards: the native one and the Flamework compatibility layer. */
export const NETWORK_MACROS = ["createNetwork", "createFlameworkCompat"] as const;

/**
 * The text between the parentheses of each `createNetwork(...)` call (the alias roblox-ts gives the import too), or of
 * another macro's (`createFlameworkCompat`).
 */
export function findNetworkCalls(source: string, macro: string = "createNetwork"): string[] {
	const names = new Set([macro]);
	for (const m of source.matchAll(new RegExp(`local\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*TS\\.import\\([^\\n]*\\)\\.${macro}\\b`, "g"))) names.add(m[1]);
	const calls: string[] = [];
	const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(${[...names].join("|")})\\s*\\(`, "g");
	for (const m of source.matchAll(pattern)) {
		const start = m.index! + m[0].length;
		let depth = 1;
		let i = start;
		while (i < source.length && depth > 0) {
			const c = source[i];
			if (c === '"' || c === "'") {
				i++;
				while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
			} else if (source.startsWith("--", i)) {
				const end = source.indexOf("\n", i);
				i = end === -1 ? source.length : end;
				continue;
			} else if (c === "(") depth++;
			else if (c === ")") depth--;
			i++;
		}
		if (depth === 0) calls.push(source.slice(start, i - 1));
	}
	return calls;
}

function luauFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...luauFiles(path));
		else if (/\.luau?$/.test(name)) out.push(path);
	}
	return out;
}

export interface ProtocolInfo {
	/** `p1-<16 hex>`; undefined when the game declares no network. */
	hash?: string;
	/** Files with a createNetwork call (relative). */
	files: string[];
	/** createNetwork calls hashed. */
	networks: number;
	/** The framework net runtime was found and hashed in. */
	runtime: boolean;
	/** Calls that couldn't be read canonically (hashed as normalized text instead). */
	raw: number;
	/** A createNetwork() without arguments: the transformer didn't generate guards. */
	unguarded: number;
	/** Files with a createFlameworkCompat call (relative), and the leaves those calls declare. */
	compatFiles: string[];
	compatLeaves: number;
}

/** The protocol hash of a compiled game: `outDir` (out/), and the project root for the framework runtime. */
export function protocolHash(root: string, outDir: string): ProtocolInfo {
	const parts: string[] = [];
	const files: string[] = [];
	const compatFiles: string[] = [];
	let compatLeaves = 0;
	let raw = 0;
	let unguarded = 0;
	for (const file of luauFiles(outDir)) {
		const source = readFileSync(file, "utf8");
		if (!NETWORK_MACROS.some((macro) => source.includes(macro))) continue;
		const relativePath = relative(root, file).replace(/\\/g, "/");
		for (const macro of NETWORK_MACROS) {
			const calls = source.includes(macro) ? findNetworkCalls(source, macro) : [];
			if (calls.length === 0) continue;
			if (!files.includes(relativePath)) files.push(relativePath);
			// Compat calls carry another argument list (events and functions trees): their own prefix in the hash, so
			// games without the compat layer hash exactly as before.
			const prefix = macro === "createNetwork" ? "" : `${macro}:`;
			if (macro !== "createNetwork") {
				compatFiles.push(relativePath);
				for (const call of calls) compatLeaves += call.match(/\bstrictArray\(/g)?.length ?? 0;
			}
			for (const call of calls) {
				if (call.trim() === "") {
					unguarded++;
					continue;
				}
				try {
					parts.push(prefix + canonicalNetwork(call));
				} catch {
					raw++;
					parts.push(`${prefix}raw:${call.replace(/--[^\n]*/g, "").replace(/\s+/g, "")}`);
				}
			}
		}
	}
	const runtimePath = join(root, FRAMEWORK_NET_RUNTIME);
	const runtime = existsSync(runtimePath);
	if (parts.length === 0) return { files, networks: 0, runtime, raw, unguarded, compatFiles, compatLeaves };
	const hash = createHash("sha256");
	hash.update(`${PROTOCOL_VERSION}\n`);
	for (const part of [...parts].sort()) hash.update(`net\n${part}\n`);
	if (runtime) hash.update(`runtime\n${createHash("sha256").update(readFileSync(runtimePath, "utf8").replace(/\r\n/g, "\n")).digest("hex")}\n`);
	return { hash: `${PROTOCOL_VERSION}-${hash.digest("hex").slice(0, 16)}`, files, networks: parts.length, runtime, raw, unguarded, compatFiles, compatLeaves };
}

/** `typetorch build`'s note for a game still on the Flamework compatibility layer (undefined when it isn't). */
export function compatNote(info: Pick<ProtocolInfo, "compatFiles" | "compatLeaves">): string | undefined {
	if (info.compatFiles.length === 0) return undefined;
	return (
		`Flamework compat layer in use (${info.compatLeaves} leaves, ${info.compatFiles.join(", ")}): it works, but move to ` +
		"createNetwork over time (typetorch migrate --from flamework --net native; guides/from-flamework.md)"
	);
}

export type ProtocolStatus = "first" | "unchanged" | "changed" | "unknown";

/** Compared with the branch's previous deploy: no previous deploy, same hash, other hash, or no hash recorded. */
export function protocolStatus(hash: string | undefined, previous: { seq: number; protocolHash?: string } | undefined): ProtocolStatus {
	if (!previous) return "first";
	if (!previous.protocolHash || !hash) return "unknown";
	return previous.protocolHash === hash ? "unchanged" : "changed";
}

export function describeProtocol(info: { hash?: string; status?: ProtocolStatus; since?: number }): string {
	if (!info.hash) return "no network declared (no createNetwork call): nothing stamped";
	const since = info.since !== undefined ? ` since #${info.since}` : "";
	switch (info.status) {
		case "unchanged":
			return `${info.hash}  protocol unchanged${since} (client events pass through the swap)`;
		case "changed":
			return `${info.hash}  protocol changed${since} (clients mid-swap get a resync)`;
		case "unknown":
			return `${info.hash}  (the previous deploy${info.since !== undefined ? `, #${info.since},` : ""} recorded no protocol hash)`;
		default:
			return `${info.hash}  (first deploy of the branch)`;
	}
}
