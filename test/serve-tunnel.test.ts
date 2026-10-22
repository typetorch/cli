/** `typetorch serve --remote`'s quick tunnel (tunnel.ts), with a stand-in for cloudflared. */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickTunnel } from "../src/serve/tunnel";

const dir = mkdtempSync(join(tmpdir(), "tt-tunnel-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Prints a trycloudflare.com address the way cloudflared does (on stderr), records its arguments, then stays up. */
function fakeCloudflared(name: string): string {
	const exe = join(dir, name);
	writeFileSync(exe, `#!/bin/sh\necho "$@" > "${exe}.args"\necho "INF |  https://quiet-river-1234.trycloudflare.com  |" 1>&2\nexec sleep 30\n`);
	chmodSync(exe, 0o755);
	return exe;
}

test.skipIf(process.platform === "win32")("hands out the address once it reaches the gateway, with an empty config", async () => {
	const exe = fakeCloudflared("cloudflared");
	const pings: string[] = [];
	let answers = 0;
	const fetch = (async (url: string) => {
		pings.push(url);
		// the first try hits Cloudflare's "not ready" page, the second our gateway
		answers += 1;
		return answers === 1 ? new Response("<html>", { status: 530 }) : Response.json({ app: "typetorch-remote" });
	}) as unknown as typeof globalThis.fetch;
	const urls: string[] = [];
	const lines: string[] = [];
	const tunnel = new QuickTunnel({ exe, port: 34890, log: (_, text) => lines.push(text), onUrl: (url) => urls.push(url), fetch });
	tunnel.start();
	for (let i = 0; i < 100 && urls.length === 0; i++) await Bun.sleep(50);
	tunnel.stop();
	expect(urls).toEqual(["https://quiet-river-1234.trycloudflare.com"]);
	expect(pings.every((url) => url === "https://quiet-river-1234.trycloudflare.com/tt/ping")).toBe(true);
	const args = readFileSync(`${exe}.args`, "utf8").trim().split(" ");
	expect(args.slice(0, 2)).toEqual(["tunnel", "--config"]);
	expect(readFileSync(args[2], "utf8")).toStartWith("# empty");
	expect(args.slice(3)).toEqual(["--no-autoupdate", "--url", "http://127.0.0.1:34890"]);
	expect(lines.some((line) => line.includes("waiting for it to answer"))).toBe(true);
});
