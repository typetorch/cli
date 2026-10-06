import { describe, expect, test } from "bun:test";
import { closestCommand, HELP_ALIASES, HELP_GROUPS, renderHelp } from "../src/help.ts";

const summaries = { deploy: "ship it", build: "pack it", dev: "claude", "remote-claude": "claude", shiny: "new" };

describe("help", () => {
	test("groups commands under titles, aliases on their command's line, ungrouped ones under Other", () => {
		const page = renderHelp("9.9.9", summaries);
		expect(page).toContain("typetorch 9.9.9");
		expect(page.indexOf("Ship a build")).toBeLessThan(page.indexOf("  deploy"));
		expect(page).toMatch(/\n {2}dev +claude \(also: remote-claude\)/);
		expect(page).not.toMatch(/\n {2}remote-claude /);
		expect(page.indexOf("Other")).toBeLessThan(page.indexOf("  shiny"));
		// Empty groups (no command of theirs exists) are not printed.
		expect(page).not.toContain("Approvals");
	});

	test("every command is in at most one group", () => {
		const names = HELP_GROUPS.flatMap(([, commands]) => commands);
		expect(new Set(names).size).toBe(names.length);
		for (const alias of Object.keys(HELP_ALIASES)) expect(names).not.toContain(alias);
	});

	test("did you mean: close typos only", () => {
		const names = ["deploy", "doctor", "rollback", "servers"];
		expect(closestCommand("deplyo", names)).toBe("deploy");
		expect(closestCommand("DOCTOR", names)).toBe("doctor");
		expect(closestCommand("-H", names)).toBeUndefined();
		expect(closestCommand("xyzzy", names)).toBeUndefined();
	});
});
