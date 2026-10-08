/**
 * The kernel's settings fixtures (kernel/scripts/smoke-settings.json), signed with the PUBLIC plans/03 test-vector keys
 * (never real keys): `bun test/fixtures/settings-fixtures.ts > ../kernel/scripts/smoke-settings.json`. Ed25519 is
 * deterministic, so test/settings.test.ts checks that this CLI still produces the kernel's fixture byte for byte (and
 * the kernel's smoke test verifies them with its own Ed25519 code): CLI signing and kernel verification agree.
 */
import { parseSigningKey, TEST_VECTOR_FALLBACK_SEED, TEST_VECTOR_MAIN_SEED } from "../../src/signing.ts";
import { signSettings, type SettingsBody } from "../../src/settings.ts";

export const FIXTURE_AT = "2026-10-06T12:00:00.000Z";
export const FLEET_TOKEN = "smoke-fleet-token-0123456789abcdef";
const fleet = { url: "https://fleet.example.test/api", token: FLEET_TOKEN };
const settingsBody: SettingsBody = {
	defaultBranch: "prod",
	channels: { prod: "prod", dev: "dev" },
	access: { members: { "5": "owner" }, revoked: {}, devBadgeId: null },
	analytics: { backend: "duckdb", events: "https://analytics.example.test/v1/ingest", token: "analytics-ingest-token-0123456789" },
	game: { "shop.price": 50, flags: { pvp: true } },
};

/** name -> [seq, body, at?] (default FIXTURE_AT). */
export const FIXTURE_BODIES: Record<string, [number, SettingsBody, string?]> = {
	fleet: [1, { fleet }],
	fleetSlash: [1, { fleet: { url: "https://fleet.example.test/api/", token: FLEET_TOKEN } }],
	// `--fleet`: the owner turns the fleet API off (a record without `fleet`), then on again.
	fleetOff: [2, {}],
	fleetOn: [3, { fleet }],
	// `--switch`: members with the old role "admin" (a dev now) and "owner".
	switch: [1, { defaultBranch: "prod", access: { members: { "2": "admin" as "dev", "4": "owner" }, revoked: {}, devBadgeId: null }, fleet }],
	access1: [1, { defaultBranch: "prod" }],
	access2: [2, { defaultBranch: "prod", access: { members: { "9": "dev" }, revoked: {}, devBadgeId: null } }],
	access3: [3, { defaultBranch: "prod", access: { members: {}, revoked: { "9": true }, devBadgeId: null } }],
	s1: [1, settingsBody],
	s2: [2, { ...settingsBody, game: { "shop.price": 75, flags: { pvp: false } } }],
	s5: [5, { ...settingsBody, game: { "shop.price": 999 } }],
	// CLI 0.9 / kernel 0.4 (plans/21): a `backend` section wins over an old `fleet` section that disagrees with it.
	backend: [
		1,
		{ backend: { url: "https://backend.example.test/api", key: FLEET_TOKEN }, fleet: { url: "https://old-fleet.example.test", token: "smoke-old-fleet-token-0123456789" } },
		"2026-10-09T12:00:00.000Z",
	],
};

export function fixtures(): Record<string, unknown> {
	const signer = { main: parseSigningKey(TEST_VECTOR_MAIN_SEED), fallback: parseSigningKey(TEST_VECTOR_FALLBACK_SEED) };
	const out: Record<string, unknown> = {};
	for (const [name, [seq, body, at]] of Object.entries(FIXTURE_BODIES)) out[name] = signSettings(signer, seq, at ?? FIXTURE_AT, body);
	return out;
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(fixtures(), null, "\t")}\n`);
