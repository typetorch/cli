/**
 * Chart marks (marks.ts): the bodies, the poster over fetch, best-effort sending, and the hooks in release(), kernel
 * publishes and backup refreshes. Every key is made up; fetch is faked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceBackup } from "../src/commands/backup";
import { withLocal } from "../src/commands/common";
import { kernelMark } from "../src/commands/kernel";
import { release } from "../src/commands/release";
import type { Project } from "../src/config";
import { Settings, useSettings } from "../src/env";
import { setOutputMode, Stopwatch } from "../src/log";
import { announce, httpMarkPoster, markBody, markPosterFor, releaseBody, type MarkPoster, type OtherMark, type ReleaseMark } from "../src/marks";
import type { OpenCloud } from "../src/opencloud";

const KEY = "game-key-for-tests-0123456789abcdef0123456789";
const ADMIN = "admin-token-for-tests-0123456789abcdef01234";
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	setOutputMode({ json: false, verbose: false });
});

/** Everything printed while fn runs. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const original = { log: console.log, error: console.error };
	console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
	try {
		await fn();
		return lines.join("\n");
	} finally {
		console.log = original.log;
		console.error = original.error;
	}
}

function recorder() {
	const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify({ ok: true }), { status: 202 });
	}) as typeof fetch;
	return { sent, fetchImpl };
}

function fakePoster() {
	const releases: ReleaseMark[] = [];
	const marks: OtherMark[] = [];
	const poster: MarkPoster = { release: async (m) => void releases.push(m), mark: async (m) => void marks.push(m) };
	return { poster, releases, marks };
}

describe("bodies", () => {
	test("releases: the fleet API's deploy start with the kind, the build before and the note; t in ms", () => {
		expect(releaseBody({ seq: 42, branch: "prod", artifactId: "e4f5a6b-222222", channel: "prod", action: "rollback", fromArtifactId: "a1b2c3d-111111", note: "x".repeat(300) }, NOW)).toEqual({
			j: "cli",
			s: 42,
			b: "prod",
			a: "e4f5a6b-222222",
			ch: "prod",
			k: "rollback",
			fr: "a1b2c3d-111111",
			m: `${"x".repeat(197)}...`,
			t: NOW,
		});
		expect(releaseBody({ seq: 1, branch: "dev", artifactId: "x", action: "deploy" }, NOW)).toEqual({ j: "cli", s: 1, b: "dev", a: "x", k: "deploy", t: NOW });
	});

	test("kernel and backup marks", () => {
		expect(markBody({ kind: "kernel", kernel: "0.4.0", placeVersion: 23, message: "kernel 0.4.0 (patch, luau)" }, NOW)).toEqual({ j: "cli", k: "kernel", v: "0.4.0", pv: 23, m: "kernel 0.4.0 (patch, luau)", t: NOW });
		expect(markBody({ kind: "backup", branch: "prod", seq: 41, artifactId: "a1b2c3d-111111", placeVersion: null }, NOW)).toEqual({ j: "cli", k: "backup", b: "prod", s: 41, a: "a1b2c3d-111111", t: NOW });
	});

	test("kernel marks from the publish records (patch, replace, restore)", () => {
		expect(kernelMark({ mode: "patch", engine: "luau", kernelVersion: "0.4.0", placeVersionBefore: 22, placeVersionAfter: 23 })).toEqual({ kernel: "0.4.0", placeVersion: 23, message: "kernel 0.4.0 (patch, luau), place v22 -> v23" });
		expect(kernelMark({ mode: "replace-place", kernelVersion: "0.4.0", placeVersionBefore: null, placeVersionAfter: null })).toEqual({ kernel: "0.4.0", placeVersion: null, message: "kernel 0.4.0 (replace-place)" });
		expect(kernelMark({ mode: "restore", engine: "luau", fromVersion: 12, fileKernel: "0.3.9", placeVersionAfter: 25 })).toEqual({ kernel: "0.3.9", placeVersion: 25, message: "restored place v12 (kernel 0.3.9)" });
		expect(kernelMark({ mode: "restore", file: ".typetorch/place-backups/1-v3.rbxl", fileKernel: null, placeVersionAfter: 26 })).toEqual({ placeVersion: 26, message: "restored .typetorch/place-backups/1-v3.rbxl" });
	});
});

describe("the poster", () => {
	test("posts to the fleet API with the game key", async () => {
		const { sent, fetchImpl } = recorder();
		const poster = httpMarkPoster({ url: "https://backend.example/", apiKey: KEY, fetch: fetchImpl, now: () => NOW });
		await poster.release({ seq: 42, branch: "prod", artifactId: "e4f5a6b-222222", action: "deploy" });
		await poster.mark({ kind: "kernel", kernel: "0.4.0" });
		expect(sent.map((s) => s.url)).toEqual(["https://backend.example/v1/fleet/deploy", "https://backend.example/v1/fleet/mark"]);
		expect(sent.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
		expect(sent[1]?.body).toEqual({ j: "cli", k: "kernel", v: "0.4.0", t: NOW });
	});

	test("best effort: a refusal, an old backend or no answer is one dim line, never an error; --json stays quiet", async () => {
		const answer = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch;
		const poster = (fetchImpl: typeof fetch) => httpMarkPoster({ url: "https://backend.example", apiKey: KEY, fetch: fetchImpl });
		const send = (p: MarkPoster) => p.mark({ kind: "backup", seq: 1 });
		let ok: boolean | undefined;
		let out = await captureOutput(async () => void (ok = await announce(poster(answer(404)), "the backup refresh", send)));
		expect(ok).toBe(false);
		expect(out).toContain("no chart mark for the backup refresh: the backend has no marks route yet (update it)");
		out = await captureOutput(async () => void (ok = await announce(poster(answer(400, JSON.stringify({ error: "k must be one of kernel, backup" }))), "x", send)));
		expect(out).toContain("the backend answered 400: k must be one of kernel, backup");
		const down = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		out = await captureOutput(async () => void (ok = await announce(poster(down), "x", send)));
		expect(out).toContain("didn't answer (connect ECONNREFUSED)");
		expect(out).not.toContain(KEY);
		setOutputMode({ json: true, verbose: false });
		out = await captureOutput(async () => void (ok = await announce(poster(answer(500)), "x", send)));
		expect(out).toBe("");
		expect(await announce(undefined, "x", send)).toBe(false);
		expect(await announce(fakePoster().poster, "x", send)).toBe(true);
	});

	test("configured from typetorch.json backend.url and the game key in the game repo's environment, else nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "tt-marks-"));
		useSettings(new Settings({ startDir: root, env: { TYPETORCH_API_KEY: KEY, TYPETORCH_ADMIN_TOKEN: ADMIN } }));
		expect(markPosterFor({ config: {} } as unknown as Project)).toBeUndefined();
		expect(markPosterFor({ config: { backend: { url: "https://backend.example" } } } as unknown as Project)).toBeDefined();
		useSettings(new Settings({ startDir: root, env: { TYPETORCH_ADMIN_TOKEN: ADMIN } }));
		expect(markPosterFor({ config: { backend: { url: "https://backend.example" } } } as unknown as Project)).toBeUndefined();
	});
});

describe("hooks", () => {
	const artifact = { artifactId: "12b63b9-3fa91c", assetId: 5, channel: "dev" as const, commit: "12b63b9", commitHash: "12b63b9".padEnd(40, "0"), dirty: false };
	function setup(config: Record<string, unknown> = {}) {
		const root = mkdtempSync(join(tmpdir(), "tt-marks-release-"));
		useSettings(new Settings({ startDir: root, env: { TYPETORCH_API_KEY: KEY, TYPETORCH_ADMIN_TOKEN: ADMIN } }));
		const proj = { root, config: { project: "game", universeId: 42, ...config } } as unknown as Project;
		const oc = { publishMessage: async () => {} } as unknown as OpenCloud;
		return { proj, oc };
	}

	test("release() marks every release with its kind and the build before", async () => {
		const { proj, oc } = setup();
		const fake = fakePoster();
		const first = await release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev", note: "new shop", marks: fake.poster });
		await release({ proj, oc, history: withLocal(proj), action: "rollback", branch: "dev", artifact: { ...artifact, artifactId: "0000000-old000", assetId: 4 }, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev", marks: fake.poster });
		expect(fake.releases).toEqual([
			{ seq: first.entry.seq, branch: "dev", artifactId: "12b63b9-3fa91c", channel: "dev", action: "deploy", note: "new shop" },
			{ seq: first.entry.seq + 1, branch: "dev", artifactId: "0000000-old000", channel: "dev", action: "rollback", fromArtifactId: "12b63b9-3fa91c" },
		]);
	});

	test("release() posts to the configured backend by default, and a backend that is down never fails the release", async () => {
		const { proj, oc } = setup({ backend: { url: "https://backend.example" } });
		const { sent, fetchImpl } = recorder();
		globalThis.fetch = fetchImpl;
		const result = await release({ proj, oc, history: withLocal(proj), action: "promote", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ url: "https://backend.example/v1/fleet/deploy", auth: `Bearer ${KEY}`, body: { j: "cli", s: result.entry.seq, b: "dev", a: "12b63b9-3fa91c", k: "promote" } });
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		let second: Awaited<ReturnType<typeof release>> | undefined;
		const out = await captureOutput(async () => void (second = await release({ proj, oc, history: withLocal(proj), action: "deploy", branch: "dev", artifact, by: "me", force: false, watch: new Stopwatch(), branchChannel: "dev" })));
		expect(second?.entry.seq).toBe(result.entry.seq + 1);
		expect(out).toContain("no chart mark for deploy #");
	});

	test("a refreshed backup is marked with its build and the new place version", async () => {
		const fake = fakePoster();
		const build = { branch: "prod", seq: 41, artifactId: "a1b2c3d-111111" };
		expect(await announceBackup(fake.poster, build, { status: "refreshed", artifactId: build.artifactId, placeVersionBefore: 57, placeVersionAfter: 58 }, "automatic")).toBe(true);
		expect(fake.marks).toEqual([{ kind: "backup", branch: "prod", seq: 41, artifactId: "a1b2c3d-111111", channel: "prod", placeVersion: 58, message: "backup build #41 a1b2c3d-111111 (automatic)" }]);
	});
});
