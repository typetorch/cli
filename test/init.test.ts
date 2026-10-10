/**
 * `typetorch init`: the scripted TUI, the resumable state, the files it writes, and every phase against fakes
 * (PATH lookups, child processes, Roblox's public APIs, Open Cloud, the delegated commands). Nothing here touches the
 * network, ~/.config or a real git remote; HOME points at a temp dir.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "tt-init-home-"));
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

import { parseArgs, UsageError } from "../src/args";
import { initCommand, initFlags, runInit } from "../src/commands/init";
import { useSettings } from "../src/env";
import { NotInteractiveError, PromptCancelledError } from "../src/interact";
import { agentPhase, agentPrompt, readAgentPrompt } from "../src/init/agent";
import { backendPhase } from "../src/init/backend";
import { ensureGitignored, slugify, upsertDotEnv, type CommandName, type InitContext, type InitDeps } from "../src/init/common";
import { deployPhase } from "../src/init/deploy";
import { kernelPhase } from "../src/init/kernel";
import { keysPhase } from "../src/init/keys";
import { checkTools, folderKind, preflightPhase } from "../src/init/preflight";
import { nameProblem, projectPhase, TEMPLATE_URL } from "../src/init/project";
import { configFor, parseExperience, probeApiKey, robloxPhase, universeInfo, universeOfPlace, userIdOf } from "../src/init/roblox";
import { emptyState, INIT_STATE_FILE, isDone, markDone, nextPhase, PHASES, readState, writeState, type InitState } from "../src/init/state";
import { setOutputMode } from "../src/log";
import { scriptedTui, type ScriptedTui } from "../src/tui";

const realFetch = globalThis.fetch;
const roots: string[] = [];

afterAll(() => {
	process.env.HOME = realHome.HOME;
	process.env.USERPROFILE = realHome.USERPROFILE;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	rmSync(FAKE_HOME, { recursive: true, force: true });
});
afterEach(() => {
	globalThis.fetch = realFetch;
	useSettings(undefined);
	setOutputMode({ json: false, verbose: false });
});

function temp(prefix = "tt-init-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

const CONFIG = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, defaultBranch: "prod", branches: { main: "prod" }, channels: { prod: "prod" }, members: { "1": "owner" }, devBadgeId: null };

function gameDir(patch: Record<string, unknown> = {}): string {
	const dir = temp();
	writeFileSync(join(dir, "typetorch.json"), JSON.stringify({ ...CONFIG, ...patch }, null, "\t") + "\n");
	return dir;
}

interface Fakes {
	deps: InitDeps;
	tui: ScriptedTui;
	commands: { name: CommandName; argv: string[] }[];
	processes: string[][];
}

/** Deps where every tool exists, every process succeeds, and delegated commands are recorded. */
function fakes(answers: string[], options: { which?: (name: string) => string | undefined; capture?: (cmd: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>; env?: Record<string, string>; command?: (name: CommandName, argv: string[]) => Promise<void>; shell?: (cmd: string[], cwd: string, input: string) => Promise<{ exitCode: number; stdout: string; stderr: string }> } = {}): Fakes {
	const tui = scriptedTui(answers);
	const commands: Fakes["commands"] = [];
	const processes: string[][] = [];
	const capture = async (cmd: string[], cwd: string) => {
		processes.push(cmd);
		if (options.capture) return options.capture(cmd, cwd);
		return { exitCode: 0, stdout: cmd[1] === "--version" ? "1.2.3\n" : "", stderr: "" };
	};
	const deps: InitDeps = {
		tui,
		which: options.which ?? ((name) => `/usr/bin/${name}`),
		capture,
		run: async (cmd, cwd) => {
			const result = await capture(cmd, cwd);
			if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
			return result;
		},
		fetch: realFetch,
		env: options.env ?? {},
		platform: "linux",
		command: async (name, argv) => {
			commands.push({ name, argv });
			await options.command?.(name, argv);
		},
		now: () => new Date("2026-10-10T12:00:00Z"),
		shell: async (cmd, cwd, input) => {
			processes.push([...cmd, input]);
			return options.shell ? options.shell(cmd, cwd, input) : { exitCode: 0, stdout: "", stderr: "" };
		},
		home: FAKE_HOME,
		sleep: async () => {},
	};
	return { deps, tui, commands, processes };
}

function context(dir: string, f: Fakes, state: InitState = emptyState()): InitContext {
	return { deps: f.deps, tui: f.tui, dir, state, total: PHASES.length, index: (phase) => PHASES.indexOf(phase) + 1, save: () => {} };
}

// The scripted TUI --------------------------------------------------------------------------------------------------

describe("scripted tui", () => {
	test("select by value, label or number; text with default and validator; confirm", async () => {
		const tui = scriptedTui(["b", "Option A", "2", "", "hello", "", "y", "no"]);
		const options = [
			{ value: "a", label: "Option A" },
			{ value: "b", label: "Option B" },
		];
		expect(await tui.select("q1", options)).toBe("b");
		expect(await tui.select("q2", options)).toBe("a");
		expect(await tui.select("q3", options)).toBe("b");
		expect(await tui.select("q4", options, "a")).toBe("a");
		expect(await tui.text("t1")).toBe("hello");
		expect(await tui.text("t2", { default: "dflt" })).toBe("dflt");
		expect(await tui.confirm("c1")).toBe(true);
		expect(await tui.confirm("c2", true)).toBe(false);
		expect(tui.asked).toEqual(["q1", "q2", "q3", "q4", "t1", "t2", "c1", "c2"]);
	});

	test("a bad option, a refused answer, an empty queue and a secret", async () => {
		const tui = scriptedTui(["zzz", "short"]);
		await expect(tui.select("q", [{ value: "a", label: "A" }])).rejects.toThrow(/not an option/);
		await expect(tui.text("t", { validate: (a) => (a.length < 6 ? "too short" : undefined) })).rejects.toThrow(/too short/);
		await expect(tui.confirm("c")).rejects.toBeInstanceOf(PromptCancelledError);
		await expect(tui.secret("s")).rejects.toBeInstanceOf(NotInteractiveError);
		expect(scriptedTui(["y"], { interactive: false }).confirm("c")).rejects.toBeInstanceOf(NotInteractiveError);
	});

	test("a checklist prints its lines", () => {
		const tui = scriptedTui([]);
		const list = tui.checklist(["one", "two"]);
		list.done(0, "fine");
		list.fail(1);
		expect(tui.output).toEqual(["- one", "- two", "ok one (fine)", "fail two"]);
	});
});

// State -----------------------------------------------------------------------------------------------------------------

describe("init state", () => {
	test("round trip, resume order, and nothing secret-like is kept", () => {
		const dir = temp();
		const state = emptyState();
		state.answers.project = "game";
		markDone(state, "preflight", () => new Date("2026-10-10T00:00:00Z"));
		markDone(state, "project", () => new Date("2026-10-10T00:00:01Z"));
		writeState(dir, state);
		const text = readFileSync(join(dir, INIT_STATE_FILE), "utf8");
		expect(text).toContain('"project": "game"');
		const back = readState(dir);
		expect(isDone(back, "project")).toBe(true);
		expect(nextPhase(back)).toBe("roblox");
		state.answers.apiKey = "nope";
		expect(() => writeState(dir, state)).toThrow(/secret/);
		writeFileSync(join(dir, INIT_STATE_FILE), JSON.stringify({ version: 1, done: { keys: { at: "x" }, bogus: { at: "y" } }, answers: { token: "leak", n: 2 } }));
		const filtered = readState(dir);
		expect(filtered.done).toEqual({ keys: { at: "x" } });
		expect(filtered.answers).toEqual({ n: 2 });
		writeFileSync(join(dir, INIT_STATE_FILE), "not json");
		expect(readState(dir)).toEqual(emptyState());
	});
});

// Files ------------------------------------------------------------------------------------------------------------------

describe("files init writes", () => {
	test("upsertDotEnv creates, replaces one line and keeps the rest", () => {
		const file = join(temp(), ".env");
		expect(upsertDotEnv(file, { A: "1" })).toEqual({ created: true, changed: ["A"] });
		writeFileSync(file, "# keep me\nA=old\nexport B=2\n\n");
		expect(upsertDotEnv(file, { A: "new", C: "3" })).toEqual({ created: false, changed: ["A", "C"] });
		expect(readFileSync(file, "utf8")).toBe("# keep me\nA=new\nexport B=2\nC=3\n");
		expect(upsertDotEnv(file, { A: "new" }).changed).toEqual([]);
	});

	test("ensureGitignored adds .env once", () => {
		const dir = temp();
		expect(ensureGitignored(dir)).toBe(true);
		expect(ensureGitignored(dir)).toBe(false);
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env\n");
		writeFileSync(join(dir, ".gitignore"), "node_modules/\n/.env\n");
		expect(ensureGitignored(dir)).toBe(false);
	});

	test("slugify and the project name rule", () => {
		expect(slugify("My Game!")).toBe("my-game");
		expect(slugify("  ")).toBe("");
		expect(nameProblem("my-game")).toBeUndefined();
		expect(nameProblem("My Game")).toMatch(/lowercase/);
	});
});

// Preflight --------------------------------------------------------------------------------------------------------------

describe("preflight", () => {
	test("folderKind", () => {
		const empty = temp();
		writeFileSync(join(empty, "README.md"), "x");
		expect(folderKind(empty)).toBe("empty");
		expect(folderKind(join(empty, "missing"))).toBe("empty");
		expect(folderKind(gameDir())).toBe("typetorch");
		const rbx = temp();
		writeFileSync(join(rbx, "package.json"), JSON.stringify({ devDependencies: { "roblox-ts": "^3" } }));
		expect(folderKind(rbx)).toBe("roblox-ts");
		const other = temp();
		writeFileSync(join(other, "notes.txt"), "x");
		expect(folderKind(other)).toBe("other");
	});

	test("all tools found: the phase passes without a question", async () => {
		const f = fakes([]);
		const ctx = context(temp(), f);
		expect((await checkTools(ctx)).map((c) => [c.name, c.found, c.version])).toEqual([
			["bun", true, "1.2.3"],
			["git", true, "1.2.3"],
			["rokit", true, "1.2.3"],
		]);
		await preflightPhase(ctx);
		expect(f.tui.asked).toEqual([]);
	});

	test("rokit missing: pointed at the release, re-checked on yes, refused on no", async () => {
		// Missing on the first lookup only: "installed" between the two checks.
		let lookups = 0;
		const which = (name: string) => (name === "rokit" && lookups++ === 0 ? undefined : `/bin/${name}`);
		const f = fakes(["y"], { which });
		await preflightPhase(context(temp(), f));
		expect(f.tui.output.join("\n")).toContain("rokit/releases");
		const g = fakes(["n"], { which: (name) => (name === "rokit" ? undefined : `/bin/${name}`) });
		await expect(preflightPhase(context(temp(), g))).rejects.toThrow(/missing tools: rokit/);
	});

	test("bun missing: offers its installer and runs it on yes", async () => {
		let lookups = 0;
		const f = fakes(["y", "y"], { which: (name) => (name === "bun" && lookups++ === 0 ? undefined : `/bin/${name}`) });
		await preflightPhase(context(temp(), f));
		expect(f.processes.some((cmd) => cmd.join(" ").includes("bun.sh/install"))).toBe(true);
	});
});

// Project -----------------------------------------------------------------------------------------------------------------

describe("project", () => {
	test("an empty folder: clone into it, drop origin, install, build; the state keeps the name", async () => {
		const dir = temp();
		const f = fakes(["", "ignored"], {
			capture: async (cmd) => ({ exitCode: 0, stdout: cmd.join(" ").includes("typetorch build") ? "x\nbuilt abc1234-9f8e7d (branch prod, channel prod)\n" : "", stderr: "" }),
		});
		const ctx = context(dir, f);
		await projectPhase(ctx);
		expect(ctx.dir).toBe(dir);
		expect(ctx.state.answers.project).toBe(slugify(dir.split(/[\\/]/).pop()!));
		expect(f.processes.map((c) => c.join(" "))).toEqual([
			`git clone --depth 1 ${TEMPLATE_URL} ${dir}`,
			"git remote remove origin",
			"bun install",
			"rokit install --no-trust-check",
			"bun run typetorch build",
		]);
		expect(f.tui.output.join("\n")).toContain("built abc1234-9f8e7d");
	});

	test("a folder with files: a subfolder named after the project", async () => {
		const dir = temp();
		writeFileSync(join(dir, "notes.txt"), "x");
		const f = fakes(["cool-game"]);
		const ctx = context(dir, f);
		await projectPhase(ctx);
		expect(ctx.dir).toBe(join(dir, "cool-game"));
		expect(f.processes[0]).toEqual(["git", "clone", "--depth", "1", TEMPLATE_URL, join(dir, "cool-game")]);
	});

	test("a failed build names the folder and the tail of the output", async () => {
		const f = fakes([""], { capture: async (cmd) => (cmd.join(" ").includes("typetorch build") ? { exitCode: 1, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: "", stderr: "" }) });
		await expect(projectPhase(context(temp(), f))).rejects.toThrow(/first build failed[\s\S]*boom/);
	});

	test("an existing TypeTorch game continues; a roblox-ts game is a migration", async () => {
		const f = fakes([]);
		const ctx = context(gameDir(), f);
		await projectPhase(ctx);
		expect(f.processes).toEqual([]);
		const rbx = temp();
		writeFileSync(join(rbx, "package.json"), JSON.stringify({ devDependencies: { "roblox-ts": "^3" } }));
		await expect(projectPhase(context(rbx, fakes([])))).rejects.toThrow(/migration/);
	});
});

// Roblox -----------------------------------------------------------------------------------------------------------------

describe("roblox", () => {
	test("parseExperience", () => {
		expect(parseExperience("https://www.roblox.com/games/102504202680447/Target-Rush")).toEqual({ placeId: 102504202680447 });
		expect(parseExperience("https://create.roblox.com/dashboard/creations/experiences/10769310634/overview")).toEqual({ universeId: 10769310634 });
		expect(parseExperience("10769310634")).toEqual({ universeId: 10769310634 });
		expect(parseExperience("place: 55")).toEqual({ placeId: 55 });
		expect(parseExperience("universe=7")).toEqual({ universeId: 7 });
		expect(parseExperience("https://apis.roblox.com/cloud/v2/universes/9/places/8")).toEqual({ universeId: 9 });
		expect(parseExperience("nonsense")).toBeUndefined();
	});

	function robloxFetch(options: { creatorType?: "Group" | "User"; keyStatus?: number } = {}): typeof fetch {
		return (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
			if (url.includes("/universes/v1/places/2/universe")) return json(200, { universeId: 42 });
			if (url.includes("games.roblox.com/v1/games?universeIds=42")) return json(200, { data: [{ id: 42, rootPlaceId: 2, name: "Target Rush", creator: { id: options.creatorType === "User" ? 7 : 3, type: options.creatorType ?? "Group", name: "Studio" } }] });
			if (url.includes("users.roblox.com/v1/usernames/users")) {
				const names = JSON.parse(String(init?.body)).usernames as string[];
				return json(200, { data: names[0] === "phasenull" ? [{ id: 409950512, name: "phasenull" }] : [] });
			}
			if (url.includes("/assets/v1/operations/")) return new Response("", { status: options.keyStatus ?? 404 });
			return json(500, { error: `unexpected ${url}` });
		}) as typeof fetch;
	}

	test("the public lookups and the key probe", async () => {
		const f = robloxFetch();
		expect(await universeOfPlace(f, 2)).toBe(42);
		expect(await universeInfo(f, 42)).toEqual({ universeId: 42, rootPlaceId: 2, name: "Target Rush", creator: { groupId: 3 }, creatorName: "Studio" });
		expect(await userIdOf(f, "phasenull")).toEqual({ id: 409950512, name: "phasenull" });
		expect(await userIdOf(f, "nobody")).toBeUndefined();
		const probe = (status: number) => probeApiKey({ request: async () => ({ status, ok: false, body: undefined, text: "", headers: new Headers() }) });
		expect(await probe(404)).toEqual({ ok: true });
		expect((await probe(401)) as any).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid/) });
		expect((await probe(403)) as any).toMatchObject({ ok: false, reason: expect.stringMatching(/asset:read/) });
	});

	test("configFor", () => {
		const config = configFor({ project: "game", info: { universeId: 42, rootPlaceId: 2, name: "x", creator: { groupId: 3 }, creatorName: "g" }, placeId: 2, ownerId: 9 });
		expect(config).toMatchObject({ project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, branches: { main: "prod", dev: "dev" }, members: { "9": "owner" }, approval: "prod", kernel: "node_modules/@typetorch/kernel" });
	});

	test("the phase: a pasted game URL, a key already in the environment, the owner from a username, typetorch.json written", async () => {
		globalThis.fetch = robloxFetch();
		const dir = temp();
		const f = fakes(["https://www.roblox.com/games/2/Target-Rush", "y", "phasenull", "y", "y"], { env: { OPENCLOUD_API_KEY: "test-key-that-is-long-enough-000" } });
		f.deps.fetch = globalThis.fetch;
		const ctx = context(dir, f);
		ctx.state.answers.project = "game";
		await robloxPhase(ctx);
		const written = JSON.parse(readFileSync(join(dir, "typetorch.json"), "utf8"));
		expect(written).toMatchObject({ project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, members: { "409950512": "owner" } });
		expect(existsSync(join(dir, ".env"))).toBe(false); // the key came from the environment: nothing to write
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
		expect(ctx.state.answers).toMatchObject({ universeId: 42, placeId: 2, ownerId: 409950512 });
		expect(f.processes.map((c) => c[1])).toEqual(["add", "commit"]);
		expect(f.tui.output.join("\n")).not.toContain("test-key-that");
	});

	test("the phase: a user-owned experience needs no username; a bad key is refused and the replay cannot supply one", async () => {
		globalThis.fetch = robloxFetch({ creatorType: "User" });
		const dir = temp();
		const f = fakes(["42", "y", "y"], { env: { OPENCLOUD_API_KEY: "test-key-that-is-long-enough-000" } });
		f.deps.fetch = globalThis.fetch;
		const ctx = context(dir, f);
		await robloxPhase(ctx);
		expect(JSON.parse(readFileSync(join(dir, "typetorch.json"), "utf8"))).toMatchObject({ creator: { userId: 7 }, members: { "7": "owner" } });
		globalThis.fetch = robloxFetch({ keyStatus: 401 });
		const g = fakes(["42", "y"], { env: { OPENCLOUD_API_KEY: "test-key-that-is-long-enough-000" } });
		g.deps.fetch = globalThis.fetch;
		await expect(robloxPhase(context(temp(), g))).rejects.toBeInstanceOf(NotInteractiveError);
		expect(g.tui.output.join("\n")).toContain("invalid");
	});
});

// Keys, kernel, backend, deploy, agent -----------------------------------------------------------------------------------

describe("delegating phases", () => {
	test("keys: init, init --fallback, the backup reminder, a commit", async () => {
		const dir = gameDir();
		const f = fakes(["y"]);
		await keysPhase(context(dir, f));
		expect(f.commands).toEqual([
			{ name: "keys", argv: ["init", "--config", join(dir, "typetorch.json")] },
			{ name: "keys", argv: ["init", "--fallback", "--config", join(dir, "typetorch.json")] },
		]);
		expect(f.tui.output.join("\n")).toContain("42.key");
		expect(f.processes.map((c) => c[1])).toEqual(["add", "commit"]);
	});

	test("kernel: an empty place is a dry run then --replace-place --yes; content is a patch; an unconfirmed check fails the phase", async () => {
		const dir = gameDir();
		const f = fakes(["empty", "y", "y"]);
		await kernelPhase(context(dir, f));
		expect(f.commands.map((c) => c.argv.slice(0, 3))).toEqual([
			["deploy", "--dry-run", "--config"],
			["deploy", "--replace-place", "--yes"],
		]);
		const g = fakes(["content", "y"]);
		await kernelPhase(context(dir, g));
		expect(g.commands.map((c) => c.argv.slice(0, 2))).toEqual([["deploy", "--install"]]);
		const h = fakes(["empty", "y", "n"]);
		await expect(kernelPhase(context(dir, h))).rejects.toThrow(/not confirmed/);
	});

	test("backend: skip writes nothing; an existing backend takes the URL, the keys from the environment, and runs setup", async () => {
		const dir = gameDir();
		const f = fakes(["skip"]);
		await backendPhase(context(dir, f));
		expect(f.commands).toEqual([]);
		const g = fakes(["existing", "https://backend.example.com"], { env: { TYPETORCH_API_KEY: "a".repeat(40), TYPETORCH_ADMIN_TOKEN: "b".repeat(40) } });
		const ctx = context(dir, g);
		await backendPhase(ctx);
		expect(g.commands).toEqual([{ name: "backend", argv: ["setup", "--url", "https://backend.example.com", "--config", join(dir, "typetorch.json")] }]);
		expect(ctx.state.answers.backendUrl).toBe("https://backend.example.com");
		expect(existsSync(join(dir, ".env"))).toBe(false);
		const h = fakes(["existing", "https://backend.example.com"]);
		await expect(backendPhase(context(dir, h))).rejects.toBeInstanceOf(NotInteractiveError);
	});

	test("deploy: commit, deploy on main, the dev branch, access push", async () => {
		const dir = gameDir();
		const f = fakes(["y", "y"], {
			capture: async (cmd) => ({ exitCode: cmd.join(" ") === "git rev-parse --verify dev" ? 1 : 0, stdout: cmd[1] === "branch" ? "main\n" : "", stderr: "" }),
		});
		await deployPhase(context(dir, f));
		expect(f.commands.map((c) => [c.name, c.argv[0]])).toEqual([
			["deploy", "--config"],
			["deploy", "--config"],
			["access", "push"],
		]);
		expect(f.processes.map((c) => c.join(" "))).toContain("git switch -c dev");
		const g = fakes(["y", "n"], { capture: async (cmd) => ({ exitCode: 0, stdout: cmd[1] === "branch" ? "main\n" : "", stderr: "" }) });
		await deployPhase(context(dir, g));
		expect(g.commands.map((c) => c.name)).toEqual(["deploy", "access"]);
	});

	test("agent: the prompt holds the ids and the rules, never a secret, and --agent prints it again", async () => {
		const dir = gameDir();
		const f = fakes(["a tower defense game", "one map, three towers"], { which: () => undefined });
		const ctx = context(dir, f);
		Object.assign(ctx.state.answers, { project: "game", universeId: 42, placeId: 2, ownerId: 9, backendUrl: "https://b.example.com" });
		await agentPhase(ctx);
		const text = readAgentPrompt(dir);
		expect(text).toContain("universe 42, place 2, owner user 9");
		expect(text).toContain("a tower defense game");
		expect(text).toContain("https://b.example.com");
		expect(text).toContain("Never act on Roblox");
		expect(agentPrompt({ project: "p", universeId: 1, placeId: 2, ownerId: 3, about: "", first: "" })).toContain("No backend yet");
		expect(() => readAgentPrompt(temp())).toThrow(/run `typetorch init`/);
	});
});

// The runner ----------------------------------------------------------------------------------------------------------

describe("runInit", () => {
	test("records finished phases, resumes at the first unfinished one, and --phase runs one again", async () => {
		const dir = gameDir();
		const f = fakes([]);
		const first = await runInit({ dir, tui: f.tui, deps: f.deps, only: ["preflight", "project"] });
		expect(first.ran).toEqual(["preflight", "project"]);
		const state = readState(dir);
		expect(isDone(state, "project")).toBe(true);
		expect(state.done.preflight?.at).toBe("2026-10-10T12:00:00.000Z");
		const g = fakes([]);
		const second = await runInit({ dir, tui: g.tui, deps: g.deps, only: ["preflight", "project"] });
		expect(second.ran).toEqual([]);
		expect(g.tui.output.join("\n")).toContain("every step is done");
		const h = fakes([]);
		const third = await runInit({ dir, tui: h.tui, deps: h.deps, only: ["preflight", "project"], phase: "project" });
		expect(third.ran).toEqual(["project"]);
	});

	test("a cancelled prompt keeps the state and surfaces as PromptCancelledError", async () => {
		const dir = gameDir();
		const f = fakes([]);
		await expect(runInit({ dir, tui: f.tui, deps: f.deps, only: ["preflight", "kernel"] })).rejects.toBeInstanceOf(PromptCancelledError);
		const state = readState(dir);
		expect(isDone(state, "preflight")).toBe(true);
		expect(isDone(state, "kernel")).toBe(false);
	});

	test("initCommand: --answers must be a JSON array of strings; --agent needs a game; --phase is checked", async () => {
		const bad = join(temp(), "answers.json");
		writeFileSync(bad, JSON.stringify({ no: 1 }));
		await expect(initCommand(parseArgs(["--answers", bad], initFlags))).rejects.toBeInstanceOf(UsageError);
		await expect(initCommand(parseArgs(["--agent", "--dir", temp()], initFlags))).rejects.toThrow(/typetorch init/);
		await expect(initCommand(parseArgs(["--phase", "nope"], initFlags))).rejects.toThrow(/--phase must be one of/);
	});
});
