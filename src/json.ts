/** Small JSON helpers: JSONC parsing (tsconfig, project files) and structural equality. */

/** Parses JSON with `//` and `/* *\/` comments and trailing commas (tsconfig style). */
export function parseJsonc(text: string): any {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else {
			out += ch;
		}
	}
	// Trailing commas before } or ] (outside strings: strings were copied verbatim above, so re-scan safely).
	return JSON.parse(stripTrailingCommas(out));
}

function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += text[i + 1] ?? "";
				i++;
			} else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}

/** Deep structural equality for JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const other = b as unknown[];
		return a.length === other.length && a.every((item, i) => jsonEqual(item, other[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const keys = Object.keys(ao).filter((k) => ao[k] !== undefined);
	const otherKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
	if (keys.length !== otherKeys.length) return false;
	return keys.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The [start, end) span of a top-level key's value in a JSON object's text (string and nesting aware). */
export function topLevelValueSpan(text: string, key: string): [number, number] | undefined {
	const skipString = (from: number): number => {
		let j = from + 1;
		while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
		return j + 1;
	};
	const skipSpace = (from: number): number => {
		let j = from;
		while (j < text.length && /\s/.test(text[j])) j++;
		return j;
	};
	const skipValue = (from: number): number => {
		let j = from;
		if (text[j] === '"') return skipString(j);
		if (text[j] === "{" || text[j] === "[") {
			let depth = 0;
			while (j < text.length) {
				const ch = text[j];
				if (ch === '"') {
					j = skipString(j);
					continue;
				}
				if (ch === "{" || ch === "[") depth++;
				else if (ch === "}" || ch === "]") {
					depth--;
					if (depth === 0) return j + 1;
				}
				j++;
			}
			return j;
		}
		while (j < text.length && !/[,}\]\s]/.test(text[j])) j++;
		return j;
	};
	let i = skipSpace(0);
	if (text[i] !== "{") return undefined;
	i++;
	while (i < text.length) {
		i = skipSpace(i);
		if (text[i] === "}") return undefined;
		if (text[i] === ",") {
			i++;
			continue;
		}
		if (text[i] !== '"') return undefined;
		const keyEnd = skipString(i);
		const name = JSON.parse(text.slice(i, keyEnd));
		i = skipSpace(keyEnd);
		if (text[i] !== ":") return undefined;
		const valueStart = skipSpace(i + 1);
		const valueEnd = skipValue(valueStart);
		if (name === key) return [valueStart, valueEnd];
		i = valueEnd;
	}
	return undefined;
}

/**
 * Sets top-level fields in a JSON object's text, keeping everything else as written (formatting, key order). An
 * existing value is replaced in place; a new key goes at the end with the file's indentation. Values are compact JSON.
 */
export function setJsonFields(text: string, updates: Record<string, unknown>): string {
	let next = text;
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		const span = topLevelValueSpan(next, key);
		if (span) {
			next = next.slice(0, span[0]) + JSON.stringify(value) + next.slice(span[1]);
			continue;
		}
		const close = next.lastIndexOf("}");
		if (close === -1) throw new Error("not a JSON object");
		const before = next.slice(0, close).replace(/\s*$/, "");
		const indent = /\n([ \t]+)"/.exec(next)?.[1] ?? "\t";
		const comma = before.endsWith("{") ? "" : ",";
		next = `${before}${comma}\n${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}\n${next.slice(close)}`;
	}
	const parsed = JSON.parse(next);
	for (const [key, value] of Object.entries(updates)) {
		if (value !== undefined && !jsonEqual(parsed[key], value)) throw new Error(`could not set "${key}"`);
	}
	return next;
}
