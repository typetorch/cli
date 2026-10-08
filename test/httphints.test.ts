/** Fleet API failures say how to fix them; unknown ones fall back to a short version of the response. */
import { describe, expect, test } from "bun:test";
import { fleetHint, fleetNetworkHint, shortBody } from "../src/httphints";

const tunnel = "goes-corner-belief-unknown.trycloudflare.com";
const cloudflare530 = `<!doctype html><!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--><head><title>example.trycloudflare.com | 530: Origin DNS error</title></head><body>Cloudflare error code 1033</body></html>`;

describe("fleet hints", () => {
	test("530 from a quick tunnel: start bun run local again", () => {
		const hint = fleetHint(530, cloudflare530, tunnel)!;
		expect(hint).toContain("has nothing running behind it");
		expect(hint).toContain("bun run local");
	});
	test("502 behind a tunnel, 404 from a config.yml ingress, fleet part off, tokens, 429", () => {
		expect(fleetHint(502, "Bad gateway cloudflare", tunnel)).toContain("server behind it doesn't answer");
		expect(fleetHint(404, "", tunnel)).toContain("config.yml");
		expect(fleetHint(404, '{"error":"the fleet part is off on this server"}', "fleet.example.com")).toContain("TYPETORCH_PARTS");
		expect(fleetHint(401, "{}", "fleet.example.com")).toContain("TYPETORCH_ADMIN_TOKEN");
		expect(fleetHint(429, "", "fleet.example.com")).toContain("rate-limiting");
	});
	test("no known fix: undefined, and the body is shortened", () => {
		expect(fleetHint(500, '{"error":"disk full"}', "fleet.example.com")).toBeUndefined();
		expect(shortBody('{"error":"disk full"}')).toBe("disk full");
		expect(shortBody(cloudflare530)).toBe("(HTML page) example.trycloudflare.com | 530: Origin DNS error");
		expect(shortBody("")).toBe("(empty response)");
		expect(shortBody("x".repeat(500)).length).toBe(160);
	});
	test("network errors: a dead quick tunnel, nothing listening, timeouts", () => {
		const dns = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
		expect(fleetNetworkHint(dns, tunnel)).toContain("no longer exists");
		const refused = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		expect(fleetNetworkHint(refused, "127.0.0.1:8787")).toContain("nothing listens");
		expect(fleetNetworkHint(new Error("The operation timed out."), "fleet.example.com")).toContain("didn't answer in time");
		expect(fleetNetworkHint(new Error("something else"), "fleet.example.com")).toBeUndefined();
	});
});
