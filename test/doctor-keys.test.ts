/** `typetorch doctor`'s signing checks: key files vs typetorch.json, the key asset and the place (throwaway keys). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherKeyFacts, keyChecks, lastKernelDeploy, type KeyFacts } from "../src/keycheck";
import { newKeyFile, writeKeyFile } from "../src/keyfiles";
import { OpenCloud } from "../src/opencloud";
import { generateSigningKey } from "../src/signing";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "tt-doctor-keys-"));
	const main = newKeyFile("main", 42);
	const fallback = newKeyFile("fallback", 42);
	const paths = { main: join(dir, "42.key"), fallback: join(dir, "42.fallback.key") };
	writeKeyFile(paths.main, main);
	writeKeyFile(paths.fallback, fallback);
	const config = { universeId: 42, placeId: 2, creator: { groupId: 3 }, signingPublicKeys: [main.publicKey], fallbackPublicKey: fallback.publicKey, keyAssetId: 555 } as KeyFacts["config"] & { placeId: number };
	const facts = (patch: Partial<KeyFacts> = {}): KeyFacts => ({
		config,
		main: { path: paths.main, missing: false, info: { path: paths.main, role: "main", universeId: 42, publicKey: main.publicKey, createdAt: "" } },
		fallback: { path: paths.fallback, missing: false, info: { path: paths.fallback, role: "fallback", universeId: 42, publicKey: fallback.publicKey, createdAt: "" } },
		assetMeta: { moderation: "Approved", creator: { groupId: "3" } },
		asset: { publicKeys: [main.publicKey], revokedKeys: [], children: 0 },
		place: { keyAssetId: 555, fallbackPublicKey: fallback.publicKey, source: "the place (Luau Execution)" },
		...patch,
	});
	return { dir, main, fallback, paths, config, facts };
}

const byName = (checks: ReturnType<typeof keyChecks>) => Object.fromEntries(checks.map((c) => [c.name, c]));

describe("doctor: signing checks", () => {
	test("all consistent: every check is ok", () => {
		const { facts } = setup();
		const checks = keyChecks(facts());
		expect(checks.map((c) => [c.name, c.status])).toEqual([
			["signing config", "ok"],
			["main key file", "ok"],
			["fallback key file", "ok"],
			["key asset", "ok"],
			["place keys", "ok"],
		]);
	});
	test("not set up at all: one warning that says what to run", () => {
		const { facts } = setup();
		const checks = keyChecks(facts({ config: { universeId: 42, creator: { groupId: 3 } } }));
		expect(checks).toHaveLength(1);
		expect(checks[0]).toMatchObject({ status: "warn", detail: expect.stringContaining("keys init --fallback") });
	});
	test("key files: missing, mismatched with typetorch.json, revoked, or the same pair", () => {
		const { facts, paths, config } = setup();
		const other = generateSigningKey().publicKey;
		expect(byName(keyChecks(facts({ main: { path: paths.main, missing: true } })))["main key file"]).toMatchObject({ status: "warn", detail: expect.stringContaining("keys rotate") });
		const mismatched = facts({ main: { path: paths.main, missing: false, info: { path: paths.main, role: "main", universeId: 42, publicKey: other, createdAt: "" } } });
		expect(byName(keyChecks(mismatched))["main key file"]).toMatchObject({ status: "warn", detail: expect.stringContaining('not in typetorch.json "signingPublicKeys"') });
		const wrongFallback = facts({ config: { ...config, fallbackPublicKey: other } });
		expect(byName(keyChecks(wrongFallback))["fallback key file"]).toMatchObject({ status: "warn", detail: expect.stringContaining("doesn't match") });
		const revoked = facts({ config: { ...config, revokedKeys: [config.signingPublicKeys![0]] }, asset: { publicKeys: config.signingPublicKeys!, revokedKeys: [config.signingPublicKeys![0]] } });
		expect(byName(keyChecks(revoked))["main key file"].detail).toContain("revoked");
		const f = facts();
		const same = facts({ fallback: { ...f.fallback, info: { ...f.fallback.info!, publicKey: f.main.info!.publicKey } } });
		expect(byName(keyChecks(same))["key pairs"]?.status).toBe("warn");
		expect(byName(keyChecks(facts({ main: { path: paths.main, missing: false, error: "x is an encrypted key file from CLI 0.3" } })))["main key file"].detail).toContain("CLI 0.3");
	});
	test("key asset: lists differ from typetorch.json, not Approved, wrong owner, unreadable, revoked fallback", () => {
		const { facts, config, fallback } = setup();
		const other = generateSigningKey().publicKey;
		const detail = (patch: Partial<KeyFacts>) => byName(keyChecks(facts(patch)))["key asset"];
		expect(detail({ asset: { publicKeys: [other], revokedKeys: [] } })).toMatchObject({ status: "warn", detail: expect.stringContaining("PublicKeys") });
		expect(detail({ asset: { publicKeys: config.signingPublicKeys!, revokedKeys: [other] } }).detail).toContain("RevokedKeys");
		expect(detail({ assetMeta: { moderation: "Rejected", creator: { groupId: "3" } } }).detail).toContain("moderation is Rejected");
		expect(detail({ assetMeta: { moderation: "Approved", creator: { userId: "9" } } }).detail).toContain("not the experience's creator");
		expect(detail({ asset: { error: "LoadAsset failed" } }).detail).toContain("LoadAsset failed");
		const revokedFallback = facts({ config: { ...config, revokedKeys: [fallback.publicKey] }, asset: { publicKeys: config.signingPublicKeys!, revokedKeys: [fallback.publicKey] } });
		expect(byName(keyChecks(revokedFallback))["key asset"].detail).toContain("fallback key");
	});
	test("place: KeyAssetId / FallbackPublicKey differ (kernel deploy), missing, or unknown", () => {
		const { facts } = setup();
		const place = (p: KeyFacts["place"]) => byName(keyChecks(facts({ place: p })))["place keys"];
		expect(place({ keyAssetId: 999, fallbackPublicKey: facts().config.fallbackPublicKey, source: "the place" })).toMatchObject({ status: "warn", detail: expect.stringContaining("kernel deploy") });
		expect(place({ keyAssetId: 555, fallbackPublicKey: generateSigningKey().publicKey, source: "the place" }).detail).toContain("FallbackPublicKey");
		expect(place({ source: "the place" }).detail).toContain("deployed before signing");
		expect(place({ error: "Luau Execution failed", source: "place" }).status).toBe("warn");
		expect(place(undefined).status).toBe("warn");
	});
});

describe("doctor: gathering", () => {
	test("reads the key files, the asset metadata and one Luau Execution task (mocked Open Cloud)", async () => {
		const { paths, config, main, fallback } = setup();
		const requests: string[] = [];
		let script = "";
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
			const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (url.pathname === "/assets/v1/assets/555") return json({ moderationResult: { moderationState: "Approved" }, creationContext: { creator: { groupId: "3" } } });
			if (url.pathname.endsWith("/luau-execution-session-tasks")) {
				script = JSON.parse(String(init?.body)).script;
				return json({ path: "universes/42/places/2/versions/7/luau-execution-session-tasks/t1", state: "QUEUED" });
			}
			if (url.pathname.endsWith("/luau-execution-session-tasks/t1")) {
				return json({
					state: "COMPLETE",
					output: { results: [{ kernel: { keyAssetId: "555", fallbackPublicKey: fallback.publicKey, version: "0.3.0" }, asset: { publicKeys: `${main.publicKey}`, revokedKeys: "", children: 0 } }] },
				});
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const facts = await gatherKeyFacts({ config, paths, stateDir: mkdtempSync(join(tmpdir(), "tt-state-")), assets: new OpenCloud("test-api-key-not-real-0000") });
		expect(script).toContain("InsertService");
		expect(script).toContain("local id = 555");
		expect(script).toContain('string.format("%d", keyAssetId)');
		expect(facts.place).toEqual({ keyAssetId: 555, fallbackPublicKey: fallback.publicKey, source: "the place (Luau Execution)" });
		expect(facts.asset).toEqual({ publicKeys: [main.publicKey], revokedKeys: [], children: 0 });
		expect(keyChecks(facts).every((c) => c.status === "ok")).toBe(true);
		expect(requests[0]).toBe("GET /assets/v1/assets/555");
	});
	test("nothing set up: no network at all", async () => {
		const { paths } = setup();
		globalThis.fetch = (async () => {
			throw new Error("no network expected");
		}) as unknown as typeof fetch;
		const facts = await gatherKeyFacts({ config: { universeId: 42, placeId: 2, creator: { groupId: 3 } }, paths, stateDir: mkdtempSync(join(tmpdir(), "tt-state-")), assets: new OpenCloud("test-api-key-not-real-0000") });
		expect(keyChecks(facts)).toHaveLength(1);
	});
	test("without an assets key: the place comes from the last kernel deploy recorded here", async () => {
		const { paths, config, fallback } = setup();
		const state = mkdtempSync(join(tmpdir(), "tt-state-"));
		mkdirSync(state, { recursive: true });
		writeFileSync(
			join(state, "kernel-deploys.jsonl"),
			[
				JSON.stringify({ at: "2026-10-04T10:00:00.000Z", event: "kernel-published", keyAssetId: 111 }),
				JSON.stringify({ at: "2026-10-04T11:00:00.000Z", event: "kernel-publishing", keyAssetId: 222 }),
				JSON.stringify({ at: "2026-10-04T11:00:01.000Z", event: "kernel-published", keyAssetId: 555, fallbackPublicKey: fallback.publicKey }),
			].join("\n") + "\n",
		);
		expect(lastKernelDeploy(state)).toMatchObject({ keyAssetId: 555, fallbackPublicKey: fallback.publicKey });
		const facts = await gatherKeyFacts({ config, paths, stateDir: state });
		expect(facts.place).toMatchObject({ keyAssetId: 555, source: expect.stringContaining("last kernel deploy recorded here") });
		const checks = byName(keyChecks(facts));
		expect(checks["place keys"].status).toBe("ok");
		expect(checks["key asset"]).toMatchObject({ status: "warn", detail: expect.stringContaining("no assets key") });
	});
});
