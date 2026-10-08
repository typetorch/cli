/**
 * A dev deploy without a terminal never waits on stdin and never prompts (bug: a background `typetorch deploy --branch
 * dev` with stdin left open hung for 10+ minutes after the upload). The real CLI runs as a child process with stdin an
 * open pipe that is never written or closed, against a fake apis.roblox.com (fetch redirected by a preload); no real
 * network, no keys.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseMode } from "../src/commands/approve";
import { isInteractiveTerminal } from "../src/interact";
import type { OpenCloud } from "../src/opencloud";
import { writeSingleInstanceRbxm } from "../src/rbxm";
import { fixCensoredName } from "../src/upload";

const CLI = resolve(import.meta.dir, "..", "src", "index.ts");
const requests: string[] = [];
const seqClaims: number[] = [];
let counter = 0;
/** Non-zero: the DataStore answers this (a missing scope). */
let dataStoreStatus = 0;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const method = req.method;
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (method === "POST" && url.pathname === "/assets/v1/assets") {
			await req.arrayBuffer();
			requests.push("create");
			return json({ operationId: "op1" });
		}
		if (url.pathname === "/assets/v1/operations/op1") return json({ done: true, response: { assetId: "123456789012", moderationResult: { moderationState: "Approved" } } });
		if (method === "GET" && url.pathname === "/assets/v1/assets/123456789012") {
			requests.push("name check");
			return json({ displayName: "tt-dev-x", description: "artifact=x\ncommit=y" });
		}
		if (method === "POST" && url.pathname.endsWith(":publishMessage")) {
			const body = JSON.parse(await req.text());
			requests.push(`publish ${body.topic} ${JSON.parse(body.message).b}`);
			return json({});
		}
		// The shared seq (seqstore.ts): an empty DataStore, and an atomic counter.
		if (url.pathname.startsWith("/cloud/v2/universes/42/data-stores/TypeTorch/entries/")) {
			if (dataStoreStatus) {
				requests.push("seq read refused");
				return json({ code: 7, message: "The required scope <universe-datastores.objects:read> is missing." }, dataStoreStatus);
			}
			if (method === "POST" && url.pathname.endsWith("/seq:increment")) {
				const { amount } = JSON.parse(await req.text());
				counter += amount;
				seqClaims.push(counter);
				return json({ id: "seq", value: counter });
			}
			if (method === "GET") return json({ code: 5, message: "NOT_FOUND" }, 404);
		}
		// The durable head (durablehead.ts): DataStores v1 Get / Set Entry, empty here.
		if (url.pathname === "/datastores/v1/universes/42/standard-datastores/datastore/entries/entry") {
			if (method === "GET") return json({ error: "NOT_FOUND" }, 404);
			await req.text();
			requests.push(`store ${url.searchParams.get("entryKey")}`);
			return json({ version: "v1", deleted: false });
		}
		requests.push(`unexpected ${method} ${url.pathname}`);
		return json({ message: "not faked" }, 404);
	},
});
afterAll(() => server.stop(true));

function game(): string {
	const root = mkdtempSync(join(tmpdir(), "tt-nontty-"));
	writeFileSync(
		join(root, "typetorch.json"),
		JSON.stringify({ project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "prod" }, null, "\t"),
	);
	mkdirSync(join(root, ".typetorch"), { recursive: true });
	const bytes = writeSingleInstanceRbxm({ className: "Model", name: "TypeTorchPayload", attributes: { ArtifactId: "abc1234-0f0f0f" } });
	writeFileSync(join(root, ".typetorch", "payload.rbxm"), bytes);
	const meta = {
		artifactId: "abc1234-0f0f0f",
		project: "game",
		channel: "dev",
		branch: "dev",
		gitBranch: "dev",
		commit: "abc1234",
		commitHash: "abc1234".padEnd(40, "0"),
		dirty: false,
		builtAt: "2026-10-05T00:00:00.000Z",
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		kernelApi: 1,
		file: ".typetorch/payload.rbxm",
	};
	writeFileSync(join(root, ".typetorch", "payload.json"), JSON.stringify(meta, null, "\t"));
	writeFileSync(
		join(root, "redirect.ts"),
		`const real = globalThis.fetch;\nglobalThis.fetch = ((input: any, init?: any) => real(String(input instanceof Request ? input.url : input).replace("https://apis.roblox.com", "http://localhost:${server.port}"), init)) as typeof fetch;\n`,
	);
	return root;
}

/** Only what the OS and Bun need, a fake key, and a throwaway home: nothing real reaches the child. */
function childEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "BUN_INSTALL"]) {
		if (process.env[name]) env[name] = process.env[name]!;
	}
	return { ...env, HOME: home, USERPROFILE: home, NO_COLOR: "1", OPENCLOUD_API_KEY: "fake-not-real-key-0000" };
}

describe("non-interactive deploys never wait on stdin", () => {
	test("interactive only when stdin, stdout and stderr are all TTYs", () => {
		const tty = { isTTY: true };
		const pipe = { isTTY: undefined };
		expect(isInteractiveTerminal({ stdin: tty, stdout: tty, stderr: tty })).toBe(true);
		expect(isInteractiveTerminal({ stdin: pipe, stdout: tty, stderr: tty })).toBe(false);
		expect(isInteractiveTerminal({ stdin: tty, stdout: pipe, stderr: tty })).toBe(false);
		expect(isInteractiveTerminal({ stdin: tty, stdout: tty, stderr: pipe })).toBe(false);
	});
	test('approval "prod": a dev branch publishes at once, whoever runs it (never a prompt)', () => {
		for (const interactive of [true, false]) {
			for (const proposer of [{ name: "cli", explicit: false }, { name: "agent", explicit: false }]) {
				expect(releaseMode({ policy: "prod", branchChannel: "dev", proposer, interactive, propose: false }).kind).toBe("publish");
			}
		}
	});
	test(
		"the real CLI: `deploy --branch dev` with stdin an open, silent pipe publishes and exits; the name check runs after the message",
		async () => {
			const root = game();
			requests.length = 0;
			const child = Bun.spawn(["bun", "--preload", join(root, "redirect.ts"), CLI, "deploy", "--branch", "dev", "--no-registry", "--no-build", "--message", "non-tty"], {
				cwd: root,
				stdin: "pipe", // open and never written or closed: any read would hang
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv(join(root, "home")),
			});
			const timeout = setTimeout(() => child.kill(), 30_000);
			const code = await child.exited;
			clearTimeout(timeout);
			const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
			expect({ code, output }).toMatchObject({ code: 0 });
			expect(output).toContain("deployed #1 dev");
			expect(requests.filter((r) => !r.startsWith("store "))).toEqual(["create", "publish TypeTorch/deploy dev", "name check"]);
			// The durable head after the message: heads and deployments (in parallel).
			const stores = requests.filter((r) => r.startsWith("store "));
			expect([...stores].sort()).toEqual(["store deployments", "store heads"]);
			for (const store of stores) expect(requests.indexOf(store)).toBeGreaterThan(requests.indexOf("publish TypeTorch/deploy dev"));
			expect(seqClaims).toEqual([1]); // the seq was claimed from the shared counter
		},
		45_000,
	);
	test(
		"--require-shared-seq (and the old --require-registry) stop before the upload when no shared seq source answers",
		async () => {
			const root = game();
			dataStoreStatus = 403;
			try {
				for (const flag of ["--require-shared-seq", "--require-registry"]) {
					requests.length = 0;
					const child = Bun.spawn(["bun", "--preload", join(root, "redirect.ts"), CLI, "deploy", "--branch", "dev", "--no-registry", "--no-build", flag], {
						cwd: root,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						env: childEnv(join(root, "home")),
					});
					const code = await child.exited;
					const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
					expect(code).toBe(1);
					expect(output).toContain("--require-shared-seq: no shared seq source is readable");
					expect(output).toContain("universe-datastores.objects:read");
					expect(requests.filter((r) => r !== "seq read refused")).toEqual([]); // nothing uploaded
				}
			} finally {
				dataStoreStatus = 0;
			}
		},
		45_000,
	);
	test("the name check is bounded: a stalled Assets API is skipped, not waited on", async () => {
		const stalled = { call: () => new Promise(() => {}) } as unknown as OpenCloud;
		const started = performance.now();
		const result = await fixCensoredName(stalled, { assetId: 1, displayName: "x", description: "", moderationState: "Approved", uploadSeconds: 0, moderationSeconds: 0 }, { budgetMs: 200 });
		expect(result).toMatchObject({ renamed: false, skipped: true });
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});
