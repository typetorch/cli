/**
 * A small unified diff (no dependencies) for `typetorch migrate --dry-run`: Myers' O(ND) line diff, grouped into hunks
 * with 3 lines of context, the way `git diff` prints them.
 */

type Op = { kind: " " | "-" | "+"; line: string };

function lines(text: string): string[] {
	if (text === "") return [];
	const split = text.replace(/\r\n/g, "\n").split("\n");
	if (split[split.length - 1] === "") split.pop();
	return split;
}

/** The edit script turning `a` into `b`, line by line (Myers, with a trace for the backtrack). */
function diffLines(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const offset = max;
	const v = new Int32Array(2 * max + 2);
	const trace: Int32Array[] = [];
	let done = false;
	for (let d = 0; d <= max && !done; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				done = true;
				break;
			}
		}
	}
	const ops: Op[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vd = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = vd[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ kind: " ", line: a[x - 1] });
			x--;
			y--;
		}
		if (d > 0) {
			if (x === prevX) ops.push({ kind: "+", line: b[y - 1] });
			else ops.push({ kind: "-", line: a[x - 1] });
		}
		x = prevX;
		y = prevY;
	}
	return ops.reverse();
}

/**
 * A unified diff of one file (`--- a/<path>` / `+++ b/<path>`); `before` undefined = a new file, `after` undefined =
 * a deleted one. Empty when nothing changed.
 */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined, context = 3): string {
	const a = lines(before ?? "");
	const b = lines(after ?? "");
	const ops = diffLines(a, b);
	if (!ops.some((op) => op.kind !== " ")) return "";
	const out = [`--- ${before === undefined ? "/dev/null" : `a/${path}`}`, `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`];
	// Indices of changed ops, grouped into hunks whose context windows touch.
	let index = 0;
	while (index < ops.length) {
		while (index < ops.length && ops[index].kind === " ") index++;
		if (index >= ops.length) break;
		const start = Math.max(0, index - context);
		let end = index;
		for (;;) {
			while (end < ops.length && ops[end].kind !== " ") end++;
			let next = end;
			while (next < ops.length && ops[next].kind === " ") next++;
			if (next < ops.length && next - end <= context * 2) end = next;
			else break;
		}
		const stop = Math.min(ops.length, end + context);
		let aLine = 1;
		let bLine = 1;
		for (let i = 0; i < start; i++) {
			if (ops[i].kind !== "+") aLine++;
			if (ops[i].kind !== "-") bLine++;
		}
		const hunk = ops.slice(start, stop);
		const aCount = hunk.filter((op) => op.kind !== "+").length;
		const bCount = hunk.filter((op) => op.kind !== "-").length;
		out.push(`@@ -${aCount === 0 ? aLine - 1 : aLine},${aCount} +${bCount === 0 ? bLine - 1 : bLine},${bCount} @@`);
		for (const op of hunk) out.push(`${op.kind}${op.line}`);
		index = stop;
	}
	return `${out.join("\n")}\n`;
}
