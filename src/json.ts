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
