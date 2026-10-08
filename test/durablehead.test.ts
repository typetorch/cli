/**
 * Durable heads (durablehead.ts, for kernel 0.3.5): the head and history entry the kernel would store, the merge rules
 * (never a lower seq, never unsigned over signed, a re-sent rollout), and the read-merge-write against a fake Open Cloud
 * DataStores v1 API (versions, matchVersion / exclusiveCreate, a conflicting server write, missing scopes), then
 * through `release`.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLocal } from "../src/commands/common";
import { release } from "../src/commands/release";
import { validateConfig, type Project } from "../src/config";
import {
	DEPLOYMENTS_KEPT,
	headReplaces,
	kernelDeployment,
	kernelHead,
	mergeDeploymentList,
	mergeHeads,
	NOT_DURABLE,
	PREV_HEADS_KEPT,
	reportDurableHead,
	storeDurableHead,
	withPrev,
	type KernelHead,
} from "../src/durablehead";
import { Settings, useSettings } from "../src/env";
import { setOutputMode, Stopwatch } from "../src/log";
import { deployMessage, type DeployMessage, type OpenCloud } from "../src/opencloud";

afterEach(() => {
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

const AT = new Date(Date.UTC(2026, 9, 6, 12, 0, 0, 456));
const devMessage = (seq: number, extra: Partial<DeployMessage> = {}): DeployMessage => ({ b: "dev", a: 1000 + seq, i: `dev-${seq}`, s: seq, c: `c${seq}`, ch: "dev", t: 1_790_000_000_000 + seq, ...extra });

/**
 * A fake Open Cloud: DataStores v1 Get/Set Entry (versions, matchVersion, exclusiveCreate, content-md5) and the v2
 * entries API the shared seq reads (GET, :increment). `beforeWrite` runs once between a read and the next write (a game
 * server's concurrent UpdateAsync).
 */
function fakeCloud(initial: Record<string, unknown> = {}, options: { status?: number; v1Status?: number } = {}) {
	const values: Record<string, unknown> = structuredClone(initial);
	const versions: Record<string, number> = Object.fromEntries(Object.keys(initial).map((key) => [key, 1]));
	const calls: string[] = [];
	let beforeWrite: (() => void) | undefined;
	const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
		status,
		ok: status >= 200 && status < 300,
		body,
		text: body === undefined ? "" : JSON.stringify(body),
		headers: new Headers(headers),
	});
	const oc = {
		async request(method: string, path: string, opts: { json?: { amount: number }; body?: string; headers?: Record<string, string> } = {}) {
			const url = new URL(`https://apis.roblox.com${path}`);
			calls.push(`${method} ${url.pathname}${url.search}`);
			if (options.status) return reply(options.status, { message: "scope missing" });
			if (url.pathname.includes("/datastores/v1/")) {
				if (options.v1Status) return reply(options.v1Status, { message: "Insufficient scope" });
				const key = url.searchParams.get("entryKey")!;
				expect(url.searchParams.get("datastoreName")).toBe("TypeTorch");
				if (method === "GET") {
					if (!(key in values)) return reply(404, { error: "NOT_FOUND" });
					return reply(200, values[key], { "roblox-entry-version": `v${versions[key]}` });
				}
				// Set Entry.
				expect(opts.headers?.["content-md5"]).toBe(createHash("md5").update(opts.body!, "utf8").digest("base64"));
				if (beforeWrite) {
					const run = beforeWrite;
					beforeWrite = undefined;
					run();
				}
				const match = url.searchParams.get("matchVersion");
				if (url.searchParams.get("exclusiveCreate") === "true" && key in values) return reply(412, { error: "PRECONDITION_FAILED" });
				if (match !== null && match !== `v${versions[key]}`) return reply(412, { error: "PRECONDITION_FAILED" });
				values[key] = JSON.parse(opts.body!);
				versions[key] = (versions[key] ?? 0) + 1;
				return reply(200, { version: `v${versions[key]}`, deleted: false, contentLength: opts.body!.length });
			}
			// v2 (the shared seq).
			const key = decodeURIComponent(url.pathname.split("/entries/")[1]);
			if (method === "POST" && key.endsWith(":increment")) {
				const name = key.replace(":increment", "");
				values[name] = ((values[name] as number | undefined) ?? 0) + opts.json!.amount;
				return reply(200, { value: values[name] });
			}
			return key in values ? reply(200, { id: key, value: values[key], etag: "e" }) : reply(404, { code: 5 });
		},
	};
	/** A game server writes `key` before our next write (bumps its version). */
	const serverWrites = (key: string, change: (value: any) => void) => {
		beforeWrite = () => {
			change(values[key]);
			versions[key] = (versions[key] ?? 0) + 1;
		};
	};
	return { oc, values, versions, calls, serverWrites };
}

describe("what the kernel would store", () => {
	test("a dev head and its history entry, from the message", () => {
		const message = devMessage(47, { ro: 25 });
		expect(kernelHead(message, AT)).toEqual({ assetId: 1047, artifactId: "dev-47", seq: 47, commit: "c47", channel: "dev", deployedAt: "2026-10-06T12:00:00Z", t: message.t, rollout: 25 });
		expect(kernelDeployment(message, AT)).toEqual({ assetId: 1047, artifactId: "dev-47", seq: 47, commit: "c47", channel: "dev", at: "2026-10-06T12:00:00Z", t: message.t, rollout: 25, branch: "dev" });
	});
	test("a signed prod rollback: r, rollback, sig and sigF go with it", () => {
		const message: DeployMessage = { b: "prod", a: 9, i: "prod-x", s: 12, c: "x", ch: "prod", t: 5, r: 1, sig: "S".repeat(88), sigF: "F".repeat(88) };
		expect(kernelHead(message, AT)).toMatchObject({ rollback: true, r: 1, sig: "S".repeat(88), sigF: "F".repeat(88), channel: "prod", t: 5 });
		// a real message from deployMessage(): same fields
		const built = deployMessage({ b: "dev", a: 5, i: "i", s: 3, c: "c", ch: "dev", resign: true });
		expect(kernelHead(built).r).toBe("resign");
	});
});

describe("merge rules", () => {
	const head = (seq: number, extra: Record<string, unknown> = {}) => ({ ...kernelHead(devMessage(seq), AT), ...extra });
	test("never a lower seq; a higher one wins; other branches are kept", () => {
		expect(headReplaces(undefined, head(47))).toBe(true);
		expect(headReplaces(head(44), head(47))).toBe(true);
		expect(headReplaces(head(50), head(47))).toBe(false);
		expect(headReplaces(head(47), head(47))).toBe(false);
		const merged = mergeHeads({ dev: head(44), prod: { assetId: 1, seq: 9 } }, "dev", head(47));
		expect(merged).toMatchObject({ dev: { seq: 47 }, prod: { seq: 9 } });
		expect(mergeHeads({ dev: head(50) }, "dev", head(47))).toBeUndefined();
	});
	test("CLI 0.8.1 (kernel 0.3.9): the head it replaces goes into prev (newest first, at most 3, the same shape without its own prev)", () => {
		const first = mergeHeads({}, "dev", head(44))!;
		expect((first.dev as KernelHead).prev).toBeUndefined();
		const second = mergeHeads(first, "dev", head(45))!;
		expect((second.dev as KernelHead).prev!.map((entry) => entry.seq)).toEqual([44]);
		const third = mergeHeads(second, "dev", head(46))!;
		const fourth = mergeHeads(third, "dev", head(47))!;
		const fifth = mergeHeads(fourth, "dev", head(48))!;
		const prev = (fifth.dev as KernelHead).prev!;
		expect(prev.map((entry) => entry.seq)).toEqual([47, 46, 45]);
		expect(PREV_HEADS_KEPT).toBe(3);
		for (const entry of prev) expect((entry as { prev?: unknown }).prev).toBeUndefined();
		expect(prev[0]).toMatchObject({ assetId: 1047, artifactId: "dev-47", channel: "dev" });
	});
	test("prev: an old record without prev is readable (it becomes the first entry); the same deploy re-sent keeps the list; signatures ride along", () => {
		const old = { assetId: 1, artifactId: "prod-1", seq: 9, commit: "a", channel: "prod", deployedAt: "2026-10-01T00:00:00Z", t: 1, sig: "S", sigF: "F" };
		const merged = mergeHeads({ prod: old }, "prod", { ...head(10), channel: "prod", sig: "S2", sigF: "F2" })!;
		expect((merged.prod as KernelHead).prev).toEqual([old]);
		const resent = { ...(merged.prod as KernelHead), rollout: 50, t: (merged.prod as KernelHead).t + 1 };
		const again = mergeHeads(merged, "prod", resent)!;
		expect((again.prod as KernelHead).prev).toEqual([old]);
		expect(withPrev(head(3), undefined).prev).toBeUndefined();
	});
	test("the same deploy re-sent with another rollout and a newer t replaces it; an unsigned head never replaces a signed one", () => {
		const first = head(47, { rollout: 10, t: 100 });
		expect(headReplaces(first, { ...first, rollout: 50, t: 200 })).toBe(true);
		expect(headReplaces(first, { ...first, rollout: 50, t: 50 })).toBe(false);
		expect(headReplaces({ ...head(9), sig: "s" }, head(10))).toBe(false);
		expect(headReplaces({ ...head(9), sig: "s" }, { ...head(10), sig: "s2" })).toBe(true);
	});
	test("history: added once, newest first, at most 100", () => {
		const list = Array.from({ length: DEPLOYMENTS_KEPT }, (_, i) => ({ seq: i + 1, branch: "dev", assetId: i }));
		const merged = mergeDeploymentList({ list }, kernelDeployment(devMessage(500), AT))!;
		expect(merged.list).toHaveLength(DEPLOYMENTS_KEPT);
		expect((merged.list[0] as { seq: number }).seq).toBe(500);
		expect((merged.list.at(-1) as { seq: number }).seq).toBe(2);
		expect(mergeDeploymentList(merged, kernelDeployment(devMessage(500), AT))).toBeUndefined();
		expect(mergeDeploymentList(undefined, kernelDeployment(devMessage(1), AT))).toEqual({ list: [kernelDeployment(devMessage(1), AT)] });
	});
});

describe("the read-merge-write", () => {
	test("no keys yet: both are created (exclusiveCreate)", async () => {
		const cloud = fakeCloud();
		const result = await storeDurableHead(cloud.oc, 42, devMessage(47), AT);
		expect(result).toEqual({ heads: { outcome: "written" }, deployments: { outcome: "written" } });
		expect(cloud.values.heads).toEqual({ dev: kernelHead(devMessage(47), AT) });
		expect(cloud.values.deployments).toEqual({ list: [kernelDeployment(devMessage(47), AT)] });
		expect(cloud.calls.filter((c) => c.startsWith("POST")).every((c) => c.includes("exclusiveCreate=true"))).toBe(true);
	});
	test("existing keys: written with matchVersion, other branches kept", async () => {
		const cloud = fakeCloud({ heads: { dev: kernelHead(devMessage(44), AT), prod: { assetId: 1, seq: 9, channel: "prod" } }, deployments: { list: [kernelDeployment(devMessage(44), AT)] } });
		await storeDurableHead(cloud.oc, 42, devMessage(47), AT);
		expect(cloud.values.heads).toMatchObject({ dev: { seq: 47, assetId: 1047 }, prod: { seq: 9 } });
		expect((cloud.values.deployments as { list: { seq: number }[] }).list.map((e) => e.seq)).toEqual([47, 44]);
		expect(cloud.calls).toContain("POST /datastores/v1/universes/42/standard-datastores/datastore/entries/entry?datastoreName=TypeTorch&entryKey=heads&matchVersion=v1");
	});
	test("a server wrote the key meanwhile: the write is refused, read again, merged with its change", async () => {
		const cloud = fakeCloud({ heads: { dev: kernelHead(devMessage(44), AT) } });
		cloud.serverWrites("heads", (value) => {
			value.feature = { assetId: 77, seq: 46, channel: "dev" };
		});
		const result = await storeDurableHead(cloud.oc, 42, devMessage(47), AT);
		expect(result.heads).toEqual({ outcome: "written" });
		expect(cloud.values.heads).toMatchObject({ dev: { seq: 47 }, feature: { seq: 46 } });
		expect(cloud.calls.filter((c) => c.startsWith("GET") && c.includes("entryKey=heads"))).toHaveLength(2);
	});
	test("never lowers a seq: a newer stored head stays (nothing written)", async () => {
		const cloud = fakeCloud({ heads: { dev: kernelHead(devMessage(50), AT) }, deployments: { list: [kernelDeployment(devMessage(47), AT)] } });
		const result = await storeDurableHead(cloud.oc, 42, devMessage(47), AT);
		expect(result).toEqual({ heads: { outcome: "unchanged" }, deployments: { outcome: "unchanged" } });
		expect((cloud.values.heads as { dev: { seq: number } }).dev.seq).toBe(50);
		expect(cloud.calls.some((c) => c.startsWith("POST"))).toBe(false);
	});
	test("missing scopes: one warning line, nothing thrown; fakes without request are skipped", async () => {
		const result = await storeDurableHead(fakeCloud({}, { v1Status: 403 }).oc, 42, devMessage(47), AT);
		expect(result.heads.scopeMissing).toBe(true);
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			reportDurableHead(result, devMessage(47));
			expect(errors).toHaveBeenCalledTimes(1);
			expect(String(errors.mock.calls[0][0])).toContain(NOT_DURABLE);
			expect(String(errors.mock.calls[0][0])).toContain("universe-datastores.objects:read, :create and :update");
		} finally {
			errors.mockRestore();
		}
		expect(await storeDurableHead({ publishMessage: async () => {} } as never, 42, devMessage(47))).toMatchObject({ skipped: true });
	});
});

describe("release stores the head", () => {
	function project(): Project {
		const root = mkdtempSync(join(tmpdir(), "tt-durable-"));
		const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "none" };
		writeFileSync(join(root, "typetorch.json"), JSON.stringify(raw));
		const { config } = validateConfig(raw);
		useSettings(new Settings({ startDir: root, env: {} }));
		return { root, configPath: join(root, "typetorch.json"), config: config!, warnings: [] };
	}
	const artifact = { artifactId: "dev-47", assetId: 1047, channel: "dev" as const, commit: "c47", commitHash: "", dirty: false };
	const silenced = <T>(fn: () => Promise<T>) => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const errors = spyOn(console, "error").mockImplementation(() => {});
		return fn().finally(() => {
			log.mockRestore();
			errors.mockRestore();
		});
	};
	test("no server running (the #46/#47 case): after the message, heads and deployments hold the deploy", async () => {
		const proj = project();
		const cloud = fakeCloud({ heads: { dev: kernelHead(devMessage(44), AT) }, deployments: { list: [kernelDeployment(devMessage(44), AT)] }, seq: 44 });
		const published: string[] = [];
		const oc = {
			...cloud.oc,
			publishMessage: async (_u: number, _t: string, m: string) => {
				published.push(m);
				cloud.calls.push("PUBLISH");
			},
		} as unknown as OpenCloud;
		const result = await silenced(() => release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" }));
		expect(result.entry.seq).toBe(45);
		expect(published).toHaveLength(1);
		const message = JSON.parse(published[0]);
		expect(cloud.values.heads).toMatchObject({ dev: { seq: 45, assetId: 1047, artifactId: "dev-47", t: message.t } });
		expect((cloud.values.deployments as { list: { seq: number }[] }).list[0].seq).toBe(45);
		expect(result.durable?.heads.outcome).toBe("written");
		// written after the message went out
		const store = cloud.calls.findIndex((c) => c.startsWith("POST") && c.includes("entryKey=heads"));
		expect(store).toBeGreaterThan(cloud.calls.indexOf("PUBLISH"));
		expect(cloud.calls.indexOf("PUBLISH")).toBeGreaterThan(-1);
	});
	test("without the DataStore write scopes the deploy still succeeds", async () => {
		const proj = project();
		const cloud = fakeCloud({}, { v1Status: 403 });
		const oc = { ...cloud.oc, publishMessage: async () => {} } as unknown as OpenCloud;
		const result = await silenced(() => release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" }));
		expect(result.entry.seq).toBeGreaterThan(0);
		expect(result.durable?.heads.scopeMissing).toBe(true);
	});
});
