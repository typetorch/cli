import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { loadTypeScript, migrateFlamework, migrationReport, type MigrateResult } from "../src/migrate";
import { unifiedDiff } from "../src/textdiff";

const FIXTURE = resolve(import.meta.dir, "fixtures", "flamework-game");
const CLI = resolve(import.meta.dir, "..", "src", "index.ts");

const run = (net: "compat" | "native") => migrateFlamework({ projectDir: FIXTURE, net, typescript: ts });
const after = (result: MigrateResult, path: string) => result.changes.find((change) => change.path === path)?.after;
const flagged = (result: MigrateResult, kind: string, file: string, text: string) =>
	result.flags.some((flag) => flag.kind === kind && flag.file === file && flag.message.includes(text));

describe("migrate --from flamework (compat, the default)", () => {
	const result = run("compat");

	test("@flamework/core imports move to @typetorch/framework; unused unsupported names are dropped", () => {
		const hud = after(result, "src/client/controllers/hud.controller.ts")!;
		expect(hud).toContain('import { Controller, Dependency, OnStart, Module } from "@typetorch/framework";');
		expect(hud).not.toContain("@flamework/core");
		expect(hud).not.toContain("Optional");
		expect(result.notes).toContain("src/client/controllers/hud.controller.ts: dropped the unused import Optional from @flamework/core");
	});

	test("@Service / @Controller classes extend Module; constructors call super()", () => {
		const hud = after(result, "src/client/controllers/hud.controller.ts")!;
		expect(hud).toContain("export class HudController extends Module implements OnStart {");
		const shop = after(result, "src/client/controllers/shop.controller.ts")!;
		expect(shop).toContain("export class ShopController extends Module {}");
		const price = after(result, "src/server/services/price.service.ts")!;
		expect(price).toContain("export class PriceService extends Module {\n\tconstructor() {\n\t\tsuper();\n\t}");
	});

	test("a local base class gets `extends Module` instead (its subclass keeps its super())", () => {
		const base = after(result, "src/server/services/base.ts")!;
		expect(base).toContain('import { Module } from "@typetorch/framework";\n\n/** A base class');
		expect(base).toContain("export abstract class BaseService extends Module {");
		const shop = after(result, "src/server/services/shop.service.ts")!;
		expect(shop).toContain("export class ShopService extends BaseService implements OnStart {");
		expect(shop.match(/super\(\)/g)).toHaveLength(1);
	});

	test("a module's own `trove = new Trove()` gives way to Module's trove", () => {
		const shop = after(result, "src/server/services/shop.service.ts")!;
		expect(shop).not.toContain("private readonly trove");
		expect(shop).toContain("implements OnStart {\n\tconstructor(");
	});

	test("@metadata flamework:parameters -> typetorch:parameters", () => {
		expect(after(result, "src/server/services/price.service.ts")).toContain("/** @metadata typetorch:parameters injectable */");
	});

	test("networking: createEvent / createFunction -> createFlameworkCompat; call sites untouched", () => {
		const network = after(result, "src/shared/network.ts")!;
		expect(network).toContain('import { createFlameworkCompat } from "@typetorch/framework";');
		expect(network).toContain("export const GlobalEvents = createFlameworkCompat<ClientToServerEvents, ServerToClientEvents>().GlobalEvents;");
		expect(network).toContain(
			"export const GlobalFunctions = createFlameworkCompat<{}, {}, ClientToServerFunctions, ServerToClientFunctions>().GlobalFunctions;",
		);
		expect(network).toContain("aim: (x: number) => void;");
		// A name it can't map stays, flagged; the call sites and handler files don't change.
		expect(network).toContain('import { NetworkingFunctionError } from "@flamework/networking";');
		expect(flagged(result, "networking", "src/shared/network.ts", "NetworkingFunctionError")).toBe(true);
		expect(result.changes.some((change) => change.path === "src/server/network.ts")).toBe(false);
		expect(after(result, "src/client/controllers/hud.controller.ts")).toContain('Events.shop.bought.connect((item) => print(item));');
	});

	test("ignite files become boot.ts; other top-level code moves into a generated module", () => {
		const boot = after(result, "src/server/boot.ts")!;
		expect(boot).toContain('import { startServer, type ServerKernel } from "@typetorch/framework";');
		expect(boot).toContain('import { BUILD } from "../shared/build";');
		expect(boot).toContain('\treturn startServer(kernel, { modules: [script.Parent!.FindFirstChild("services")!], build: BUILD });');
		expect(after(result, "src/client/boot.ts")).toContain('startClient(kernel, { modules: [script.Parent!.FindFirstChild("controllers")!], build: BUILD })');
		const deleted = result.changes.filter((change) => change.after === undefined).map((change) => change.path);
		expect(deleted).toEqual(["src/client/main.client.ts", "src/server/main.server.ts"]);
		const moved = after(result, "src/server/services/main.service.ts")!;
		expect(moved).toContain('import { Logger } from "../../shared/logger";');
		expect(moved).toContain("@Service()\nexport class MainService extends Module implements OnStart {\n\tonStart() {\n\t\tconst logger = new Logger(\"main\");");
		expect(moved).not.toContain("Flamework");
		expect(flagged(result, "moved", "src/server/main.server.ts", "2 top-level statements moved")).toBe(true);
		expect(flagged(result, "moved", "src/server/main.server.ts", "`script` was the ignite Script")).toBe(true);
	});

	test("flags what needs judgment, with file and line", () => {
		const legacy = "src/shared/legacy.ts";
		expect(flagged(result, "module-state", legacy, "top-level let joined")).toBe(true);
		expect(flagged(result, "module-state", legacy, "cooldowns = new Map")).toBe(true);
		expect(result.flags.some((flag) => flag.message.includes("LIMIT"))).toBe(false);
		expect(flagged(result, "player-added", legacy, "Players.PlayerAdded.Connect")).toBe(true);
		expect(flagged(result, "global", legacy, "_G")).toBe(true);
		expect(flagged(result, "loadstring", legacy, "loadstring")).toBe(true);
		expect(flagged(result, "task", legacy, "task.delay")).toBe(true);
		expect(flagged(result, "loop", legacy, "at the top level")).toBe(true);
		expect(flagged(result, "bind-to-close", legacy, "BindToClose")).toBe(true);
		expect(flagged(result, "messaging", legacy, "MessagingService.SubscribeAsync")).toBe(true);
		expect(flagged(result, "data", legacy, "DataStoreService.GetDataStore")).toBe(true);
		expect(flagged(result, "remotes", legacy, 'new Instance("RemoteEvent")')).toBe(true);
		expect(flagged(result, "dependency", "src/client/controllers/hud.controller.ts", "in a field initializer")).toBe(true);
		expect(flagged(result, "components", "src/client/controllers/shop.controller.ts", "Component from @flamework/components")).toBe(true);
		expect(flagged(result, "toolchain", "package.json", "remove @flamework/core")).toBe(true);
		expect(flagged(result, "toolchain", "tsconfig.json", "typeRoots")).toBe(true);
		const line = result.flags.find((flag) => flag.kind === "player-added")!;
		expect(line.line).toBe(7);
		expect(line.code).toBe("Players.PlayerAdded.Connect(() => {");
	});

	test("the report lists every flag under its section, and what was rewritten", () => {
		const report = migrationReport(result, { net: "compat", dryRun: true, project: "flamework-game" });
		expect(report).toContain("# TypeTorch migration report (from Flamework)");
		expect(report).toContain("## Module-level state");
		expect(report).toContain("- `src/shared/legacy.ts:3`: top-level let joined");
		expect(report).toContain("## Rewritten");
		expect(report).toContain("src/server/services/base.ts: BaseService extends Module (base of ShopService)");
	});

	test("the compat diff touches no call site", () => {
		const shop = result.changes.find((change) => change.path === "src/server/services/shop.service.ts")!;
		const diff = unifiedDiff(shop.path, shop.before, shop.after);
		expect(diff).not.toContain("connect(");
		expect(diff).toContain("-import { OnStart, Service } from \"@flamework/core\";");
	});
});

describe("migrate --from flamework --net native", () => {
	const result = run("native");

	test("one network per file: createNetwork over both interface pairs (server -> client requests stay out)", () => {
		const network = after(result, "src/shared/network.ts")!;
		expect(network).toContain('import { createNetwork } from "@typetorch/framework";');
		expect(network).toContain("export const network = createNetwork<ClientToServerEvents & ClientToServerFunctions, ServerToClientEvents>();");
		expect(network).not.toContain("GlobalFunctions");
	});

	test("handler files that only created handlers are deleted; their users import the network", () => {
		const deleted = result.changes.filter((change) => change.after === undefined).map((change) => change.path);
		expect(deleted).toContain("src/server/network.ts");
		expect(deleted).toContain("src/client/network.ts");
		const hud = after(result, "src/client/controllers/hud.controller.ts")!;
		expect(hud).toContain('import { network } from "../../shared/network";');
		expect(hud).not.toContain("client/network");
	});

	test("server call sites: connect -> on in the trove, setCallback -> handle, fire / fireList, except, broadcast", () => {
		const shop = after(result, "src/server/services/shop.service.ts")!;
		expect(shop).toContain("this.trove.add(network.server.shop.buy.on((player, item) => {");
		expect(shop).toContain("network.server.shop.bought.fire(player, item);");
		expect(shop).toContain("network.server.shop.bought.fireList([player], item);");
		expect(shop).toContain("network.server.notify.fireExcept(player, ");
		expect(shop).toContain("this.trove.add(network.server.shop.price.handle((_, item) => this.prices.of(item)));");
		expect(shop).toContain('network.server.notify.fireAll("open");');
		expect(shop).toContain('network.server.notify.fire(new Player(), "hi");');
		// connect's result used as a connection: rewritten, flagged.
		expect(shop).toContain("const connection = network.server.ping.on(() => {});");
		expect(flagged(result, "connection", "src/server/services/shop.service.ts", "connect returns a function now")).toBe(true);
	});

	test("client call sites: on in the trove, predict -> emit, the call shorthand -> fire / invoke", () => {
		const hud = after(result, "src/client/controllers/hud.controller.ts")!;
		expect(hud).toContain("this.trove.add(network.client.shop.bought.on((item) => print(item)));");
		expect(hud).toContain('network.client.notify.emit("local");');
		expect(hud).toContain("network.client.ping.fire();");
		expect(hud).toContain('network.client.shop.price.invoke("shield");');
		expect(hud).toContain('network.client.shop.price.invokeWithTimeout(5, "bow");');
		expect(result.stats.callSites).toBe(15);
	});
});

describe("loading TypeScript and the diff", () => {
	test("the game's own typescript first, this CLI's otherwise", () => {
		const empty = mkdtempSync(join(tmpdir(), "tt-migrate-ts-"));
		writeFileSync(join(empty, "package.json"), "{}");
		expect(typeof loadTypeScript(empty).createProgram).toBe("function");
	});

	test("unifiedDiff: hunks with context; created and deleted files", () => {
		const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
		const changed = before.replace("e\n", "E\n");
		expect(unifiedDiff("x.ts", before, changed)).toBe(
			["--- a/x.ts", "+++ b/x.ts", "@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h", ""].join("\n"),
		);
		expect(unifiedDiff("x.ts", before, before)).toBe("");
		expect(unifiedDiff("n.ts", undefined, "one\n")).toBe("--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+one\n");
		expect(unifiedDiff("d.ts", "one\ntwo\n", undefined)).toBe("--- a/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n");
	});
});

describe("typetorch migrate (the command)", () => {
	function copy() {
		const dir = mkdtempSync(join(tmpdir(), "tt-migrate-"));
		cpSync(FIXTURE, dir, { recursive: true });
		const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		git("init", "-q");
		git("add", "-A");
		git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "fixture");
		return dir;
	}
	const cli = (dir: string, ...args: string[]) => spawnSync("bun", [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

	test("--dry-run prints the diff and writes nothing", () => {
		const dir = copy();
		const out = cli(dir, "migrate", "--from", "flamework", "--dry-run");
		expect(out.status).toBe(0);
		expect(out.stdout).toContain("+++ b/src/server/boot.ts");
		expect(out.stdout).toContain("(dry run: nothing written)");
		expect(existsSync(join(dir, "src", "server", "boot.ts"))).toBe(false);
		expect(existsSync(join(dir, "typetorch-migrate-report.md"))).toBe(false);
	});

	test("a run writes the files and the report; a dirty tree is refused", () => {
		const dir = copy();
		const out = cli(dir, "migrate", "--from", "flamework");
		expect(out.status).toBe(0);
		expect(readFileSync(join(dir, "src", "server", "boot.ts"), "utf8")).toContain("startServer");
		expect(existsSync(join(dir, "src", "server", "main.server.ts"))).toBe(false);
		expect(readFileSync(join(dir, "typetorch-migrate-report.md"), "utf8")).toContain("## Toolchain leftovers");
		const again = cli(dir, "migrate", "--from", "flamework");
		expect(again.status).toBe(1);
		expect(again.stderr).toContain("uncommitted changes");
	});

	test("usage errors", () => {
		const dir = copy();
		expect(cli(dir, "migrate").stderr).toContain("--from flamework is required");
		expect(cli(dir, "migrate", "--from", "knit").stderr).toContain("only flamework is supported");
		expect(cli(dir, "migrate", "--from", "flamework", "--net", "x").stderr).toContain("use compat or native");
	});
});
