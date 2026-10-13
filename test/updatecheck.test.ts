/** The post-command update notice (updatecheck.ts): when it runs, the cached daily check, ask once per version. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interaction } from "../src/interact";
import { quiet } from "./fixtures/kernel-luau/lune-cloud";
import { afterCommandUpdateCheck, CHECK_EVERY_MS, decideNotice, readUpdateCache, updateCheckSkip } from "../src/updatecheck";

const NOW = Date.parse("2026-10-13T08:00:00.000Z");
const answer = (yes: boolean, asked: string[] = []): Interaction => ({
	interactive: true,
	async confirm(question) {
		asked.push(question);
		return yes;
	},
	async ask() {
		return "";
	},
});

describe("the update notice", () => {
	test("skipped for the update command, --json, non-interactive runs, CI and TYPETORCH_UPDATE_CHECK=off", () => {
		const base = { command: "deploy", interactive: true, json: false, env: {} };
		expect(updateCheckSkip(base)).toBeUndefined();
		expect(updateCheckSkip({ ...base, command: "update" })).toBe("the update command itself");
		expect(updateCheckSkip({ ...base, json: true })).toBe("--json");
		expect(updateCheckSkip({ ...base, interactive: false })).toBe("not an interactive terminal");
		expect(updateCheckSkip({ ...base, env: { CI: "true" } })).toBe("CI");
		expect(updateCheckSkip({ ...base, env: { CI: "false" } })).toBeUndefined();
		expect(updateCheckSkip({ ...base, env: { TYPETORCH_UPDATE_CHECK: "off" } })).toBe("TYPETORCH_UPDATE_CHECK=off");
	});

	test("decide: ask about a newer version once; after a no, a daily reminder until a newer one", () => {
		expect(decideNotice("0.10.1", { latest: "0.10.1" }, NOW)).toEqual({ kind: "none" });
		expect(decideNotice("0.10.1", { latest: "0.10.0" }, NOW)).toEqual({ kind: "none" });
		expect(decideNotice("0.10.1", {}, NOW)).toEqual({ kind: "none" });
		expect(decideNotice("0.10.1", { latest: "0.11.0" }, NOW)).toEqual({ kind: "ask", latest: "0.11.0" });
		expect(decideNotice("0.10.1", { latest: "0.11.0", declined: "0.11.0", remindedAt: NOW - 1000 }, NOW)).toEqual({ kind: "none" });
		expect(decideNotice("0.10.1", { latest: "0.11.0", declined: "0.11.0", remindedAt: NOW - CHECK_EVERY_MS }, NOW)).toEqual({ kind: "remind", latest: "0.11.0" });
		expect(decideNotice("0.10.1", { latest: "0.12.0", declined: "0.11.0", remindedAt: NOW }, NOW)).toEqual({ kind: "ask", latest: "0.12.0" });
	});

	test("the registry is asked at most once a day (a failure counts); yes updates, no is remembered", async () => {
		const cachePath = join(mkdtempSync(join(tmpdir(), "tt-update-")), "update-check.json");
		let fetches = 0;
		const fetchLatest = async () => {
			fetches++;
			return "0.11.0";
		};
		const updated: string[] = [];
		const update = async (version: string) => {
			updated.push(version);
		};
		const asked: string[] = [];
		const first = await quiet(() => afterCommandUpdateCheck({ current: "0.10.1", interaction: answer(false, asked), update, fetchLatest, cachePath, now: NOW }));
		expect(first.value).toEqual({ kind: "ask", latest: "0.11.0" });
		expect(asked).toEqual(["Update now?"]);
		expect(readUpdateCache(cachePath)).toMatchObject({ checkedAt: NOW, latest: "0.11.0", declined: "0.11.0" });
		// Same day: no fetch, no question.
		const again = await quiet(() => afterCommandUpdateCheck({ current: "0.10.1", interaction: answer(true, asked), update, fetchLatest, cachePath, now: NOW + 60_000 }));
		expect(again.value).toEqual({ kind: "none" });
		expect(fetches).toBe(1);
		expect(asked.length).toBe(1);
		// A newer version the next day: asked again; yes runs the update.
		const next = await quiet(() =>
			afterCommandUpdateCheck({ current: "0.10.1", interaction: answer(true, asked), update, fetchLatest: async () => "0.12.0", cachePath, now: NOW + CHECK_EVERY_MS }),
		);
		expect(next.value).toEqual({ kind: "ask", latest: "0.12.0" });
		expect(updated).toEqual(["0.12.0"]);

		// Offline: silent, and not retried until tomorrow.
		const offlinePath = join(mkdtempSync(join(tmpdir(), "tt-update-")), "update-check.json");
		const offline = await quiet(() =>
			afterCommandUpdateCheck({ current: "0.10.1", interaction: answer(true), update, fetchLatest: async () => Promise.reject(new Error("offline")), cachePath: offlinePath, now: NOW }),
		);
		expect(offline.value).toEqual({ kind: "none" });
		expect(readUpdateCache(offlinePath)).toEqual({ checkedAt: NOW });
	});
});
