/** `typetorch access push` (access.ts): the access lists, the pushed-hash record, the warnings (the push itself: test/settings.test.ts). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessConfigured, accessHash, accessStatus, accessValue, accessWarning, describeAccess, readAccessRecord, writeAccessRecord } from "../src/access";
import { validateConfig, type Project } from "../src/config";
import { Settings, useSettings } from "../src/env";

function projectAt(dir: string, patch: Record<string, unknown> = {}): Project {
	const raw = { project: "game", universeId: 42, placeId: 7, creator: { groupId: 3 }, channels: { prod: "prod" }, approval: "none", ...patch };
	writeFileSync(join(dir, "typetorch.json"), JSON.stringify(raw));
	const { config, errors, warnings } = validateConfig(raw);
	if (!config) throw new Error(errors.join("; "));
	useSettings(new Settings({ startDir: dir, env: {} }));
	return { root: dir, configPath: join(dir, "typetorch.json"), config, warnings };
}

describe("the access lists", () => {
	test("sorted ids, roles as typetorch.json has them (admin already read as dev), revoked as {id: true}, badge or null", () => {
		const { config } = validateConfig({ project: "g", universeId: 1, placeId: 2, creator: { userId: 3 }, members: { "900": "dev", "15": "owner", "16": "admin" }, revoked: ["77", "8"], devBadgeId: 123 });
		const value = accessValue(config!);
		expect(value).toEqual({ v: 1, members: { "15": "owner", "16": "dev", "900": "dev" }, revoked: { "8": true, "77": true }, devBadgeId: 123 });
		expect(Object.keys(value.members)).toEqual(["15", "16", "900"]);
		expect(accessConfigured(value)).toBe(true);
		expect(describeAccess(value)).toBe("3 members (1 owner), 2 revoked, dev badge 123");
		// The same lists in another order hash the same.
		const { config: other } = validateConfig({ project: "g", universeId: 1, placeId: 2, creator: { userId: 3 }, members: { "16": "dev", "900": "dev", "15": "owner" }, revoked: { "8": true, "77": true }, devBadgeId: 123 });
		expect(accessHash(accessValue(other!))).toBe(accessHash(value));
		expect(accessHash(accessValue({ ...config!, devBadgeId: null }))).not.toBe(accessHash(value));
	});
	test("nothing listed: not configured, no warning", () => {
		const value = accessValue({ members: {}, revoked: undefined, devBadgeId: null });
		expect(value).toEqual({ v: 1, members: {}, revoked: {}, devBadgeId: null });
		expect(accessConfigured(value)).toBe(false);
		expect(describeAccess(value)).toBe("0 members");
		expect(accessWarning(accessStatus({ members: {}, devBadgeId: null, universeId: 1 }, mkdtempSync(join(tmpdir(), "tt-access-"))))).toBeUndefined();
	});
});

describe("the pushed record and the warnings", () => {
	test("never pushed: warn; pushed: ok; typetorch.json changed: stale", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-access-"));
		const config = { universeId: 42, members: { "15": "owner" as const }, revoked: { "8": true as const }, devBadgeId: null };
		let status = accessStatus(config, dir);
		expect(status).toMatchObject({ configured: true, published: false, stale: false });
		expect(accessWarning(status)).toContain("typetorch access push");
		expect(accessWarning(status)).toContain("signed settings record");
		writeAccessRecord(dir, { v: 1, universeId: 42, sha256: status.sha256, at: "2026-10-06T00:00:00.000Z", configVersion: 9 });
		expect(readAccessRecord(dir, 42)).toEqual({ v: 1, universeId: 42, sha256: status.sha256, at: "2026-10-06T00:00:00.000Z", configVersion: 9 });
		expect(readAccessRecord(dir, 43)).toBeUndefined(); // another universe's record doesn't count
		status = accessStatus(config, dir);
		expect(status).toMatchObject({ configured: true, published: true, stale: false });
		expect(accessWarning(status)).toBeUndefined();
		status = accessStatus({ ...config, revoked: { "8": true, "9": true } }, dir);
		expect(status).toMatchObject({ published: true, stale: true });
		expect(accessWarning(status)).toContain("changed since the last");
		// The record holds a hash, never the lists.
		expect(readFileSync(join(dir, "access.json"), "utf8")).not.toContain('"15"');
	});
	test("a broken record reads as never pushed", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-access-"));
		writeFileSync(join(dir, "access.json"), "{not json");
		expect(readAccessRecord(dir, 42)).toBeUndefined();
	});
});
