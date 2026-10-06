import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLocal } from "../src/commands/common";
import { release } from "../src/commands/release";
import { validateConfig, type Project } from "../src/config";
import { appendLocalLog, readLocalLog } from "../src/deployments";
import { Settings, useSettings } from "../src/env";
import { setOutputMode, Stopwatch } from "../src/log";
import type { OpenCloud } from "../src/opencloud";
import { claimSeq, DS_READ_SCOPE, highestInDeployments, highestInHeads, nextSharedSeq, readSharedSeq } from "../src/seqstore";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

// The shapes the kernel writes, as read from the test universe on 2026-10-05 (a Luau Execution task, read-only).
const LIVE_HEADS = { dev: { commit: "4363e8c", assetId: 128525130415605, channel: "dev", artifactId: "4363e8c-d2b6d6", t: 1791210465389, seq: 36, deployedAt: "2026-10-05T14:27:45Z" } };
const LIVE_DEPLOYMENTS = {
	list: [
		{ commit: "4363e8c", assetId: 128525130415605, artifactId: "4363e8c-d2b6d6", channel: "dev", at: "2026-10-05T14:27:45Z", seq: 36, branch: "dev" },
		{ commit: "12b63b9", assetId: 93599756899164, channel: "prod", at: "2026-10-04T12:45:42Z", artifactId: "prod-12b63b9.r2", seq: 9, branch: "prod" },
	],
};

/** A fake DataStore over the Open Cloud v2 entries API: GET entries, POST :increment (atomic), or a fixed status. */
function fakeStore(entries: Record<string, unknown>, options: { status?: number; incrementStatus?: number } = {}) {
	const calls: string[] = [];
	const values = { ...entries };
	const oc = {
		async request(method: string, path: string, opts: { json?: { amount: number } } = {}) {
			calls.push(`${method} ${path}`);
			const reply = (status: number, body: unknown) => ({ status, ok: status < 300, body, text: JSON.stringify(body), headers: new Headers() });
			if (options.status) return reply(options.status, { code: 7, message: `The required scope <${DS_READ_SCOPE}> is missing.` });
			const key = decodeURIComponent(path.split("/entries/")[1]);
			if (method === "POST" && key.endsWith(":increment")) {
				if (options.incrementStatus) return reply(options.incrementStatus, { message: "forbidden" });
				const name = key.replace(":increment", "");
				values[name] = ((values[name] as number | undefined) ?? 0) + opts.json!.amount;
				return reply(200, { path, id: name, value: values[name] });
			}
			return key in values ? reply(200, { path, id: key, value: values[key], etag: "e" }) : reply(404, { code: 5, message: "not found" });
		},
	};
	return { oc, calls, values };
}

describe("reading the kernel's DataStore records", () => {
	test("the highest seq in heads ({branch: head}) and deployments ({list}, or a bare list)", () => {
		expect(highestInHeads(LIVE_HEADS)).toBe(36);
		expect(highestInHeads({ dev: { seq: 4 }, prod: { seq: 9 }, junk: "x" })).toBe(9);
		expect(highestInHeads(undefined)).toBeUndefined();
		expect(highestInDeployments(LIVE_DEPLOYMENTS)).toBe(36);
		expect(highestInDeployments([{ seq: 3 }, { seq: "7" }])).toBe(3);
		expect(highestInDeployments(null)).toBeUndefined();
	});
	test("readSharedSeq: all three keys in parallel; missing keys still count as readable", async () => {
		const { oc, calls } = fakeStore({ heads: LIVE_HEADS, deployments: LIVE_DEPLOYMENTS });
		const shared = await readSharedSeq(oc, 10769310634);
		expect(shared).toMatchObject({ readable: true, highest: 36, heads: 36, deployments: 36 });
		expect(shared.counter).toBeUndefined();
		expect(calls).toEqual([
			"GET /cloud/v2/universes/10769310634/data-stores/TypeTorch/entries/heads",
			"GET /cloud/v2/universes/10769310634/data-stores/TypeTorch/entries/deployments",
			"GET /cloud/v2/universes/10769310634/data-stores/TypeTorch/entries/seq",
		]);
		const empty = await readSharedSeq(fakeStore({}).oc, 1);
		expect(empty.readable).toBe(true);
		expect(empty.highest).toBeUndefined();
		// a value stored as a JSON string is decoded too
		expect((await readSharedSeq(fakeStore({ heads: JSON.stringify({ dev: { seq: 5 } }) }).oc, 1)).highest).toBe(5);
	});
	test("a missing scope: not readable, and the error names the scope", async () => {
		const shared = await readSharedSeq(fakeStore({}, { status: 403 }).oc, 1);
		expect(shared.readable).toBe(false);
		expect(shared.scopeMissing).toBe(true);
		expect(shared.error).toContain("the deploy key needs universe-datastores.objects:read");
	});
});

describe("claiming a seq", () => {
	test("one atomic increment to at least the target; concurrent claims never share a value", async () => {
		const store = fakeStore({ seq: 36 });
		expect(await claimSeq(store.oc, 1, 37, 36)).toEqual({ seq: 37 });
		// another machine read 36 too (stale): its increment by 1 still gets a value of its own
		expect(await claimSeq(store.oc, 1, 37, 36)).toEqual({ seq: 38 });
		// the counter behind the heads (servers saw deploys the counter never did): jump to the target
		expect(await claimSeq(fakeStore({ seq: 3 }).oc, 1, 40, 3)).toEqual({ seq: 40 });
		// no counter yet: increment creates it with the target
		expect(await claimSeq(fakeStore({}).oc, 1, 37, undefined)).toEqual({ seq: 37 });
	});
	test("nextSharedSeq: counter when writable, else max + 1 read, else local; fake clients without request stay local", async () => {
		expect(await nextSharedSeq(fakeStore({ heads: LIVE_HEADS }).oc, 1, 5)).toMatchObject({ seq: 37, how: "counter" });
		expect(await nextSharedSeq(fakeStore({ heads: LIVE_HEADS }).oc, 1, 50)).toMatchObject({ seq: 50, how: "counter" });
		const readOnly = await nextSharedSeq(fakeStore({ heads: LIVE_HEADS }, { incrementStatus: 403 }).oc, 1, 5);
		expect(readOnly).toMatchObject({ seq: 37, how: "read", note: expect.stringContaining("universe-datastores.objects:create") });
		expect(await nextSharedSeq(fakeStore({}, { status: 403 }).oc, 1, 5)).toMatchObject({ seq: 5, how: "local" });
		expect(await nextSharedSeq(undefined, 1, 5)).toEqual({ seq: 5, how: "local" });
		expect(await nextSharedSeq({ publishMessage: async () => {} } as never, 1, 5)).toEqual({ seq: 5, how: "local" });
	});
});

describe("release takes the shared seq", () => {
	function project(): Project {
		const root = mkdtempSync(join(tmpdir(), "tt-seq-"));
		const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "none" };
		writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw));
		const { config } = validateConfig(raw);
		useSettings(new Settings({ startDir: root, env: {} }));
		return { root, configPath: join(root, "typetorch.json"), config: config!, warnings: [] };
	}
	const artifact = { artifactId: "12b63b9-3fa91c", assetId: 777, channel: "dev" as const, commit: "12b63b9", commitHash: "", dirty: false };
	test("CI with an empty log: the seq comes from the DataStore counter, not 1", async () => {
		const proj = project();
		const store = fakeStore({ heads: LIVE_HEADS, deployments: LIVE_DEPLOYMENTS });
		const published: string[] = [];
		const oc = { ...store.oc, publishMessage: async (_u: number, _t: string, m: string) => void published.push(m) } as unknown as OpenCloud;
		const result = await release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "ci", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		expect(result.entry.seq).toBe(37);
		expect(JSON.parse(published[0]).s).toBe(37);
		expect(store.values.seq).toBe(37);
		expect(readLocalLog(join(proj.root, ".typetorch"))[0]).toMatchObject({ seq: 37, seqSource: "counter" });
	});
	test("the local log ahead of the DataStore wins (and moves the counter up)", async () => {
		const proj = project();
		appendLocalLog(join(proj.root, ".typetorch"), { seq: 60, at: new Date().toISOString(), action: "deploy", branch: "dev", channel: "dev", artifactId: "x", assetId: 1, commit: "x", commitHash: "", dirty: false, by: "me", universeId: 42 });
		const store = fakeStore({ heads: LIVE_HEADS, seq: 36 });
		const oc = { ...store.oc, publishMessage: async () => {} } as unknown as OpenCloud;
		const result = await release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		expect(result.entry.seq).toBe(61);
		expect(store.values.seq).toBe(61);
	});
});
