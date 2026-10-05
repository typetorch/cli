import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalNetwork, describeProtocol, FRAMEWORK_NET_RUNTIME, findNetworkCalls, protocolHash, protocolStatus } from "../src/protocol";

// What roblox-ts + @typetorch/transformer emit for a net module (the template's, shortened).
const NET = `-- Compiled with roblox-ts v3.0.0
local TS = require(script.Parent.Parent.include.RuntimeLib)
local t = TS.import(script, script.Parent.Parent, "include", "node_modules", "@rbxts", "t", "lib", "ts").t
local createNetwork = TS.import(script, script.Parent.Parent, "include", "node_modules", "@typetorch", "framework", "out").createNetwork
--[[
	* Client -> server.
]]
local network = createNetwork({
	coins = {
		collect = t.strictArray(t.string),
		balance = t.strictArray(),
	},
	rush = {
		hit = t.strictArray(t.number, t.literal("click", "touch")),
	},
}, {
	rush = {
		phase = t.strictArray(t.interface({
			phase = t.literalList({ "results", "lobby", "countdown", "round" }),
			round = t.number,
		})),
		maybe = t.strictArray(t.union(t.string, t.number, t.none)),
	},
})
return {
	network = network,
}
`;

function game(files: Record<string, string>, runtime?: string) {
	const root = mkdtempSync(join(tmpdir(), "tt-protocol-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	if (runtime !== undefined) {
		mkdirSync(join(root, FRAMEWORK_NET_RUNTIME, ".."), { recursive: true });
		writeFileSync(join(root, FRAMEWORK_NET_RUNTIME), runtime);
	}
	return root;
}
const hashOf = (net: string, runtime = "-- net runtime v1") => {
	const root = game({ "out/shared/net.luau": net }, runtime);
	return protocolHash(root, join(root, "out")).hash;
};
const hashIn = (root: string) => protocolHash(root, join(root, "out")).hash;

describe("finding createNetwork calls", () => {
	test("the arguments of every call, the import line and other names left alone", () => {
		const calls = findNetworkCalls(NET);
		expect(calls).toHaveLength(1);
		expect(calls[0].trim().startsWith("{")).toBe(true);
		expect(calls[0].trim().endsWith("}")).toBe(true);
		expect(findNetworkCalls("local x = createNetworkThing(1)\nlocal y = mycreateNetwork(2)")).toEqual([]);
		// an aliased import (import { createNetwork as net })
		expect(findNetworkCalls(`local net = TS.import(script, x, "@typetorch", "framework", "out").createNetwork\nlocal n = net({ a = { b = t.strictArray() } }, {})`)).toHaveLength(1);
		// strings and comments with parentheses don't break the scan
		expect(findNetworkCalls(`createNetwork({ a = { b = t.literal(")(") } }, {}) -- )`)[0]).toBe(`{ a = { b = t.literal(")(") } }, {}`);
	});
});

describe("canonical form", () => {
	const root = (net: string) => game({ "out/shared/net.luau": net }, "-- net runtime v1");
	test("same protocol, same hash: comments, whitespace, union and literal order, field order", () => {
		const base = hashIn(root(NET));
		expect(base).toMatch(/^p1-[0-9a-f]{16}$/);
		const reordered = NET.replace('t.literal("click", "touch")', 't.literal("touch", "click")')
			.replace('{ "results", "lobby", "countdown", "round" }', '{ "round", "lobby", "results", "countdown" }')
			.replace("t.union(t.string, t.number, t.none)", "t.union(t.none, t.string, t.number)")
			.replace("phase = t.literalList", "round = t.number,\n\t\t\tphase = t.literalList")
			.replace("\t\t\tround = t.number,\n\t\t}))", "\t\t}))")
			.replace("--[[\n\t* Client -> server.\n]]", "-- another comment")
			.replace(/\t/g, "  ");
		expect(hashIn(root(reordered))).toBe(base);
		// moving the module, and other code around it, doesn't matter either
		const moved = game({ "out/shared/net/index.luau": `local unrelated = 1\n${NET}` }, "-- net runtime v1");
		expect(hashIn(moved)).toBe(base);
	});
	test("protocol changes change it: a renamed or added leaf, another guard, an argument added, a direction swapped", () => {
		const base = hashIn(root(NET));
		const variants = [
			NET.replace("collect =", "pickup ="),
			NET.replace("balance = t.strictArray(),", "balance = t.strictArray(),\n\t\twhiff = t.strictArray(),"),
			NET.replace("collect = t.strictArray(t.string)", "collect = t.strictArray(t.number)"),
			NET.replace("t.strictArray(t.number, t.literal", "t.strictArray(t.number, t.number, t.literal"),
			NET.replace('t.literal("click", "touch")', 't.literal("click", "touch", "kick")'),
			NET.replace("hit = t.strictArray(t.number, t.literal(\"click\", \"touch\"))", "hit = t.strictArray(t.literal(\"click\", \"touch\"), t.number)"),
		];
		for (const variant of variants) expect(hashIn(root(variant))).not.toBe(base);
	});
	test("the framework's net runtime is part of it (a new wire format)", () => {
		expect(hashOf(NET, "-- net runtime v1")).not.toBe(hashOf(NET, "-- net runtime v2"));
		expect(hashOf(NET, "-- net runtime v1")).toBe(hashOf(NET, "-- net runtime v1\r\n".replace("\r\n", "")));
	});
	test("canonicalNetwork: sorted fields, sorted literal lists and unions, positional args kept", () => {
		expect(canonicalNetwork(`{ b = t.strictArray(t.literal("y", "x")), a = t.strictArray(t.string, t.number) }, {}`)).toBe(
			'{"a"=t.strictArray(t.string,t.number),"b"=t.strictArray(t.literal("x","y"))},{}',
		);
	});
});

describe("no network, unguarded calls, status", () => {
	test("no createNetwork: no hash (nothing stamped); createNetwork() without guards is counted, not hashed", () => {
		const none = game({ "out/server/a.luau": "return 1" });
		const noneInfo = protocolHash(none, join(none, "out"));
		expect(noneInfo.hash).toBeUndefined();
		expect(noneInfo.networks).toBe(0);
		const bare = game({ "out/shared/net.luau": `local createNetwork = x.createNetwork\nlocal n = createNetwork()` });
		const bareInfo = protocolHash(bare, join(bare, "out"));
		expect(bareInfo.hash).toBeUndefined();
		expect(bareInfo.unguarded).toBe(1);
	});
	test("compared with the previous deploy", () => {
		expect(protocolStatus("p1-a", undefined)).toBe("first");
		expect(protocolStatus("p1-a", { seq: 3, protocolHash: "p1-a" })).toBe("unchanged");
		expect(protocolStatus("p1-a", { seq: 3, protocolHash: "p1-b" })).toBe("changed");
		expect(protocolStatus("p1-a", { seq: 3 })).toBe("unknown");
		expect(describeProtocol({ hash: "p1-a", status: "unchanged", since: 3 })).toContain("protocol unchanged since #3");
		expect(describeProtocol({ hash: "p1-a", status: "changed", since: 3 })).toContain("protocol changed since #3");
		expect(describeProtocol({})).toContain("nothing stamped");
	});
});
