/**
 * A fake Open Cloud for the signed settings (settings.ts): the DataStores v1 entry endpoints (GET with
 * roblox-entry-version, POST with matchVersion / exclusiveCreate) on DataStore TypeTorch, and publishMessage.
 * `serverWrites` changes a key between our read and write once (a conflict); `status` answers every request with it.
 */
import { createHash } from "node:crypto";

export function fakeDataStoreCloud(initial: Record<string, unknown> = {}, options: { status?: number } = {}) {
	const values: Record<string, unknown> = structuredClone(initial);
	const versions: Record<string, number> = Object.fromEntries(Object.keys(initial).map((key) => [key, 1]));
	const published: { topic: string; message: string }[] = [];
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
		async request(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
			const url = new URL(`https://apis.roblox.com${path}`);
			calls.push(`${method} ${url.searchParams.get("entryKey")}`);
			if (options.status) return reply(options.status, { message: "Insufficient scope" });
			if (url.searchParams.get("datastoreName") !== "TypeTorch") throw new Error(`unexpected DataStore ${url.searchParams.get("datastoreName")}`);
			const key = url.searchParams.get("entryKey")!;
			if (method === "GET") {
				if (!(key in values)) return reply(404, { error: "NOT_FOUND" });
				return reply(200, values[key], { "roblox-entry-version": `v${versions[key]}` });
			}
			if (opts.headers?.["content-md5"] !== createHash("md5").update(opts.body!, "utf8").digest("base64")) throw new Error("bad content-md5");
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
			return reply(200, { version: `v${versions[key]}` });
		},
		async publishMessage(_universeId: number, topic: string, message: string) {
			published.push({ topic, message });
		},
	};
	const serverWrites = (key: string, change: (value: any) => unknown) => {
		beforeWrite = () => {
			values[key] = change(values[key]);
			versions[key] = (versions[key] ?? 0) + 1;
		};
	};
	return { oc, values, versions, published, calls, serverWrites };
}
