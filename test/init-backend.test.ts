/**
 * `typetorch init`, backend phase (milestones 2 and 3): `backend run` (the local backend, its quick tunnel and the
 * re-pointing loop) against fake processes, the login task files per OS, the SSH helpers, Coolify detection and its API path
 * against a fake API, and the phase end to end for Coolify over SSH, the Linux service (and its teardown) and this PC. Nothing here opens a socket, runs
 * ssh or touches the real home folder.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "tt-initb-home-"));
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

import { BACKEND_STATUS_FILE, readLocalBackendConfig, readRunStatus, runLocalBackend, serverEnv, tunnelUrlIn, type Child, type RunDeps } from "../src/backendrun";
import { backendPhase, backendTeardown, ensureBackendKeys } from "../src/init/backend";
import type { CommandName, InitContext, InitDeps } from "../src/init/common";
import { COOLIFY_ENV_FILE, coolifyEnv, coolifyInstalled, ensureCoolify, parseDetect, provisionWithApi, type CoolifyApi } from "../src/init/coolify";
import { loginTask } from "../src/init/logintask";
import { caddySite, DATA_DIR, ENV_FILE, installSteps, teardownSteps } from "../src/init/linuxservice";
import { isIpv4, localMachine, PRELUDE, privateKeys, probeMachine, readKeyValues, sshArgs, sshMachine, sslipName } from "../src/init/ssh";
import { emptyState, PHASES, type InitState } from "../src/init/state";
import { cloudflaredInstall } from "../src/init/thispc";
import { useSettings } from "../src/env";
import { scriptedTui, type ScriptedTui } from "../src/tui";

const roots: string[] = [];
afterAll(() => {
	process.env.HOME = realHome.HOME;
	process.env.USERPROFILE = realHome.USERPROFILE;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	rmSync(FAKE_HOME, { recursive: true, force: true });
});
afterEach(() => useSettings(undefined));

function temp(prefix = "tt-initb-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

const CONFIG = { project: "game", universeId: 42, placeId: 2, creator: { groupId: 3 }, defaultBranch: "prod", branches: { main: "prod" }, channels: { prod: "prod" }, members: { "1": "owner" }, devBadgeId: null };

function gameDir(): string {
	const dir = temp();
	writeFileSync(join(dir, "typetorch.json"), JSON.stringify(CONFIG, null, "\t") + "\n");
	return dir;
}

type Result = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ exitCode: 0, stdout, stderr: "" });

interface Fakes {
	deps: InitDeps;
	tui: ScriptedTui;
	commands: { name: CommandName; argv: string[] }[];
	processes: string[][];
	scripts: { cmd: string[]; input: string }[];
}

function fakes(answers: string[], o: { shell?: (cmd: string[], input: string) => Result; capture?: (cmd: string[]) => Result; fetch?: typeof fetch; env?: Record<string, string>; platform?: NodeJS.Platform; which?: (name: string) => string | undefined; now?: () => Date } = {}): Fakes {
	const tui = scriptedTui(answers);
	const commands: Fakes["commands"] = [];
	const processes: string[][] = [];
	const scripts: Fakes["scripts"] = [];
	const capture = async (cmd: string[]) => {
		processes.push(cmd);
		return o.capture ? o.capture(cmd) : ok();
	};
	const deps: InitDeps = {
		tui,
		which: o.which ?? ((name) => `/usr/bin/${name}`),
		capture,
		run: async (cmd) => {
			const result = await capture(cmd);
			if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
			return result;
		},
		fetch: o.fetch ?? ((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
		env: o.env ?? {},
		platform: o.platform ?? "linux",
		command: async (name, argv) => void commands.push({ name, argv }),
		now: o.now ?? (() => new Date("2026-10-10T12:00:00Z")),
		shell: async (cmd, _cwd, input) => {
			scripts.push({ cmd, input });
			return o.shell ? o.shell(cmd, input) : ok();
		},
		home: FAKE_HOME,
		sleep: async () => {},
	};
	return { deps, tui, commands, processes, scripts };
}

function context(dir: string, f: Fakes, state: InitState = emptyState()): InitContext {
	return { deps: f.deps, tui: f.tui, dir, state, total: PHASES.length, index: (phase) => PHASES.indexOf(phase) + 1, save: () => {} };
}

// backend run --------------------------------------------------------------------------------------------------------

class FakeChild implements Child {
	outputs: ((text: string) => void)[] = [];
	exits: ((code: number | null) => void)[] = [];
	killed = false;
	constructor(readonly cmd: string[], readonly env: Record<string, string>) {}
	onOutput(listener: (text: string) => void) {
		this.outputs.push(listener);
	}
	onExit(listener: (code: number | null) => void) {
		this.exits.push(listener);
	}
	say(text: string) {
		for (const listener of this.outputs) listener(text);
	}
	exit(code: number | null) {
		for (const listener of this.exits) listener(code);
	}
	kill() {
		this.killed = true;
	}
}

describe("backend run", () => {
	test("tunnelUrlIn and serverEnv (only the basics and the two keys reach the server)", () => {
		expect(tunnelUrlIn("2026 INF |  https://quiet-river-12.trycloudflare.com  |")).toBe("https://quiet-river-12.trycloudflare.com");
		expect(tunnelUrlIn("https://api.trycloudflare.com/x")).toBe("https://api.trycloudflare.com");
		expect(tunnelUrlIn("nothing here")).toBeUndefined();
		const env = serverEnv({ PATH: "/bin" }, { key: "k".repeat(40), admin: "a".repeat(40), port: 8787, dataDir: "/b/data" });
		expect(env).toEqual({
			PATH: "/bin",
			TYPETORCH_API_KEY: "k".repeat(40),
			TYPETORCH_ADMIN_TOKEN: "a".repeat(40),
			TYPETORCH_DATA_DIR: "/b/data",
			HOST: "127.0.0.1",
			PORT: "8787",
			TYPETORCH_PUBLIC_URL: "http://localhost:8787",
			TYPETORCH_TOKEN_LOGIN: "on",
			TYPETORCH_TRUST_PROXY: "1",
		});
	});

	test("starts the server and a tunnel, points the game, and re-points it when the tunnel comes back with a new address", async () => {
		const gameDirPath = gameDir();
		const children: FakeChild[] = [];
		const setups: string[] = [];
		const logs: string[] = [];
		const up = new Set<string>();
		const controller = new AbortController();
		let tunnels = 0;
		let clock = Date.parse("2026-10-10T12:00:00Z");
		const deps: RunDeps = {
			spawn: (cmd, _cwd, env) => {
				const child = new FakeChild(cmd, env);
				children.push(child);
				if (cmd[1] === "src/server/main.ts") up.add("http://127.0.0.1:8787");
				else {
					const url = `https://t${++tunnels}.trycloudflare.com`;
					queueMicrotask(() => {
						child.say(`INF | ${url} |`);
						up.add(url);
					});
				}
				return child;
			},
			fetch: (async (input: string | URL | Request) => {
				const base = String(input).replace(/\/healthz$/, "");
				return new Response("", { status: up.has(base) ? 200 : 503 });
			}) as typeof fetch,
			setup: async (url) => {
				setups.push(url);
				if (setups.length === 1) {
					// The first tunnel drops: the loop must open a second one and point the game again.
					const tunnel = children.find((c) => c.cmd.includes("tunnel"))!;
					queueMicrotask(() => tunnel.exit(1));
				} else queueMicrotask(() => controller.abort());
			},
			sleep: async () => {
				clock += 1000;
				await new Promise((r) => setTimeout(r, 1));
			},
			log: (line) => void logs.push(line),
			now: () => new Date(clock),
			pid: 4242,
		};
		await runLocalBackend({ gameDir: gameDirPath, backendDir: "/b", port: 8787, cloudflared: "/usr/bin/cloudflared", bun: "/usr/bin/bun", key: "k".repeat(40), admin: "a".repeat(40), baseEnv: { PATH: "/bin" }, signal: controller.signal }, deps);
		expect(setups).toEqual(["https://t1.trycloudflare.com", "https://t2.trycloudflare.com"]);
		const servers = children.filter((c) => c.cmd[1] === "src/server/main.ts");
		expect(servers).toHaveLength(1);
		expect(servers[0].env.TYPETORCH_API_KEY).toBe("k".repeat(40));
		const tunnelChild = children.find((c) => c.cmd.includes("tunnel"))!;
		expect(tunnelChild.cmd).toContain("--url");
		expect(tunnelChild.env.TYPETORCH_API_KEY).toBeUndefined();
		expect(readRunStatus(gameDirPath)?.state).toBe("stopped");
		expect(logs.join("\n")).not.toContain("k".repeat(40));
		expect(logs.some((l) => l.startsWith("ready: game servers use https://t1"))).toBe(true);
	});

	test("a refused setup is recorded with the reason and the backend keeps running", async () => {
		const dir = gameDir();
		const controller = new AbortController();
		const up = new Set<string>(["http://127.0.0.1:8787"]);
		const deps: RunDeps = {
			spawn: (cmd, _cwd, env) => {
				const child = new FakeChild(cmd, env);
				queueMicrotask(() => {
					child.say("https://x1.trycloudflare.com");
					up.add("https://x1.trycloudflare.com");
				});
				return child;
			},
			fetch: (async (input: string | URL | Request) => new Response("", { status: up.has(String(input).replace(/\/healthz$/, "")) ? 200 : 503 })) as typeof fetch,
			setup: async () => {
				throw new Error("TYPETORCH_API_KEY isn't usable\nmore");
			},
			sleep: async () => {
				const status = readRunStatus(dir);
				if (status?.state === "refused") controller.abort();
				await new Promise((r) => setTimeout(r, 1));
			},
			log: () => {},
			now: () => new Date("2026-10-10T12:00:00Z"),
			pid: 1,
		};
		const statuses: string[] = [];
		const realDeps = { ...deps, sleep: async () => {
			statuses.push(readRunStatus(dir)?.state ?? "");
			await deps.sleep(0);
		} };
		await runLocalBackend({ gameDir: dir, backendDir: "/b", port: 8787, cloudflared: "cf", bun: "bun", key: "k".repeat(40), admin: "a".repeat(40), baseEnv: {}, signal: controller.signal }, realDeps);
		expect(statuses).toContain("refused");
		expect(existsSync(join(dir, BACKEND_STATUS_FILE))).toBe(true);
	});
});

// Login tasks ---------------------------------------------------------------------------------------------------------

describe("login task", () => {
	const base = { home: "/home/u", slug: "my-game", gameDir: "/home/u/my game", bun: "/home/u/.bun/bin/bun", path: "/home/u/.bun/bin:/usr/bin" };
	test("linux: a systemd user unit that runs `bun run typetorch backend run` in the game and logs to .typetorch", () => {
		const task = loginTask({ ...base, platform: "linux" });
		expect(task.files[0].path).toBe("/home/u/.config/systemd/user/typetorch-backend-my-game.service");
		expect(task.files[0].content).toContain('WorkingDirectory="/home/u/my game"');
		expect(task.files[0].content).toContain("ExecStart=/home/u/.bun/bin/bun run typetorch backend run");
		expect(task.files[0].content).toContain("StandardOutput=append:/home/u/my game/.typetorch/backend.log");
		expect(task.install).toContainEqual(["systemctl", "--user", "enable", "typetorch-backend-my-game.service"]);
	});
	test("macOS: a LaunchAgent with RunAtLoad; Windows: a hidden launcher in the Startup folder", () => {
		const mac = loginTask({ ...base, platform: "darwin" });
		expect(mac.files[0].path).toBe("/home/u/Library/LaunchAgents/dev.typetorch.backend.my-game.plist");
		expect(mac.files[0].content).toContain("<key>RunAtLoad</key><true/>");
		expect(mac.install.at(-1)).toEqual(["launchctl", "load", "-w", mac.files[0].path]);
		const win = loginTask({ ...base, platform: "win32", home: "C:\\Users\\u", appData: "C:\\Users\\u\\AppData\\Roaming", gameDir: "C:\\games\\my-game", bun: "C:\\bun.exe" });
		expect(win.files.map((f) => f.path.replace(/\\/g, "/"))).toEqual(["C:/games/my-game/.typetorch/backend-run.cmd", "C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/typetorch-backend-my-game.vbs"]);
		expect(win.files[0].content).toContain('"C:\\bun.exe" run typetorch backend run >> ');
		expect(win.files[1].content).toContain(", 0, False");
		expect(win.install[0][0]).toBe("wscript.exe");
	});
	test("cloudflared's install per OS", () => {
		expect(cloudflaredInstall("win32", "x64", "/h").cmd?.slice(0, 2)).toEqual(["winget", "install"]);
		expect(cloudflaredInstall("darwin", "arm64", "/h").cmd).toEqual(["brew", "install", "cloudflared"]);
		const linux = cloudflaredInstall("linux", "arm64", "/h");
		expect(linux.path).toBe("/h/.local/bin/cloudflared");
		expect(linux.cmd?.join(" ")).toContain("cloudflared-linux-arm64");
	});
});

// SSH ------------------------------------------------------------------------------------------------------------------

describe("ssh helpers", () => {
	test("sshArgs: a key file means BatchMode; a control socket off Windows; one `bash -s`", () => {
		const args = sshArgs({ host: "203.0.113.5", user: "root", port: 2222, keyFile: "/h/.ssh/id_ed25519" }, "linux", "/h");
		expect(args.slice(0, 3)).toEqual(["ssh", "-p", "2222"]);
		expect(args).toContain("BatchMode=yes");
		expect(args).toContain("ControlPath=/h/.ssh/typetorch-%C");
		expect(args.slice(-2)).toEqual(["root@203.0.113.5", "bash -s"]);
		const win = sshArgs({ host: "h", user: "u", port: 22 }, "win32", "C:\\h");
		expect(win.join(" ")).not.toContain("BatchMode");
		expect(win.join(" ")).not.toContain("ControlMaster");
	});
	test("machines prefix every script with the prelude; probe, key list, sslip.io names", async () => {
		const f = fakes([], { shell: () => ok("kernel=Linux 6\nos=Ubuntu 24.04 LTS\nos_id=ubuntu\narch=x86_64\nroot=sudo\n") });
		const remote = sshMachine({ host: "203.0.113.5", user: "root", port: 22 }, f.deps, "/tmp");
		expect(await probeMachine(remote)).toEqual({ os: "Ubuntu 24.04 LTS", osId: "ubuntu", arch: "x86_64", root: "sudo" });
		expect(f.scripts[0].input.startsWith(PRELUDE)).toBe(true);
		expect(f.scripts[0].cmd.at(-2)).toBe("root@203.0.113.5");
		await localMachine(f.deps, "/tmp").exec("true");
		expect(f.scripts[1].cmd).toEqual(["bash", "-s"]);
		const home = temp();
		mkdirSync(join(home, ".ssh"));
		writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
		writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA");
		writeFileSync(join(home, ".ssh", "known_hosts"), "x");
		expect(privateKeys(home)).toEqual([join(home, ".ssh", "id_ed25519")]);
		expect(sslipName("203.0.113.5")).toBe("backend.203-0-113-5.sslip.io");
		expect(isIpv4("203.0.113.5")).toBe(true);
		expect(isIpv4("example.com")).toBe(false);
		expect(readKeyValues("a=1\n junk \nb_c=x=y")).toEqual({ a: "1", b_c: "x=y" });
	});
});

// Coolify --------------------------------------------------------------------------------------------------------------

function fakeApi(existing: { name: string; uuid: string }[] = []): CoolifyApi & { calls: string[]; bodies: unknown[] } {
	const calls: string[] = [];
	const bodies: unknown[] = [];
	return {
		calls,
		bodies,
		async get<T>(path: string) {
			calls.push(`GET ${path}`);
			if (path === "/servers") return [{ uuid: "s1", name: "localhost" }] as T;
			if (path === "/projects") return [] as T;
			if (path === "/applications") return existing as T;
			return {} as T;
		},
		async send<T>(method: string, path: string, body: unknown) {
			calls.push(`${method} ${path}`);
			bodies.push(body);
			if (path === "/projects") return { uuid: "p1" } as T;
			if (path === "/applications/public") return { uuid: "a1" } as T;
			return {} as T;
		},
	};
}

describe("coolify", () => {
	test("detection: installed needs the data folder and the coolify container", () => {
		const found = parseDetect("data=yes\nproxy=yes\napp=yes\npanel=no\n");
		expect(found).toEqual({ data: true, proxy: true, app: true, panel: false });
		expect(coolifyInstalled(found)).toBe(true);
		expect(coolifyInstalled(parseDetect("data=yes\napp=no"))).toBe(false);
	});

	test("installed: no install question; missing: the install script runs only on yes", async () => {
		const dir = gameDir();
		const f = fakes([], { shell: () => ok("data=yes\napp=yes\nproxy=yes\npanel=yes\n") });
		await ensureCoolify(context(dir, f), localMachine(f.deps, dir), "203.0.113.5");
		expect(f.tui.asked).toEqual([]);
		expect(f.scripts).toHaveLength(1);
		const g = fakes(["y", "y"], { shell: (_c, input) => ok(input.includes("install.sh") ? "" : "data=no\napp=no\n") });
		await ensureCoolify(context(dir, g), localMachine(g.deps, dir), "203.0.113.5");
		expect(g.scripts[1].input).toContain("https://cdn.coollabs.io/coolify/install.sh | $SUDO bash");
		expect(g.tui.output.join("\n")).toContain("http://203.0.113.5:8000");
		const h = fakes(["n"], { shell: () => ok("data=no\napp=no\n") });
		await expect(ensureCoolify(context(dir, h), localMachine(h.deps, dir), "1.2.3.4")).rejects.toThrow("Coolify is needed");
		expect(h.scripts).toHaveLength(1);
	});

	test("API: creates the project and the compose resource, sets the domain and variables, deploys; a rerun reuses the resource", async () => {
		const env = coolifyEnv({ key: "k".repeat(64), admin: "a".repeat(64), hostname: "backend.203-0-113-5.sslip.io" });
		expect(env.TYPETORCH_PUBLIC_URL).toBe("https://backend.203-0-113-5.sslip.io");
		const api = fakeApi();
		expect(await provisionWithApi(api, { hostname: "backend.203-0-113-5.sslip.io", env, log: () => {} })).toBe("a1");
		expect(api.calls).toEqual(["GET /servers", "GET /projects", "POST /projects", "GET /applications", "POST /applications/public", "PATCH /applications/a1", "PATCH /applications/a1/envs/bulk", "GET /deploy?uuid=a1&force=false"]);
		expect(api.bodies[1]).toMatchObject({ build_pack: "dockercompose", docker_compose_location: "/compose.yaml", git_repository: "https://github.com/typetorch/backend", server_uuid: "s1", project_uuid: "p1" });
		expect(api.bodies[2]).toEqual({ docker_compose_domains: [{ name: "backend", domain: "https://backend.203-0-113-5.sslip.io:8787" }] });
		const again = fakeApi([{ name: "typetorch-backend", uuid: "old" }]);
		await provisionWithApi(again, { hostname: "h.example.com", env, log: () => {} });
		expect(again.calls).not.toContain("POST /applications/public");
		expect(again.calls.at(-1)).toBe("GET /deploy?uuid=old&force=false");
	});
});

// The phase ------------------------------------------------------------------------------------------------------------

describe("backend phase", () => {
	test("keys: generated once into .env, kept on a rerun, never equal", () => {
		const dir = gameDir();
		const f = fakes([]);
		const first = ensureBackendKeys(context(dir, f));
		expect(first.generated).toEqual(["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN"]);
		expect(first.key).toHaveLength(64);
		expect(first.key).not.toBe(first.admin);
		const second = ensureBackendKeys(context(dir, fakes([])));
		expect(second.generated).toEqual([]);
		expect(second.key).toBe(first.key);
	});

	test("Coolify over SSH with a password, sslip.io, clicked: the env block goes to a private file, then health and setup", async () => {
		const dir = gameDir();
		const fetched: string[] = [];
		const f = fakes(["coolify", "ssh", "203.0.113.5", "", "", "password", "n", "clicked", "y"], {
			shell: (_cmd, input) => {
				if (input.includes("uname")) return ok("os=Ubuntu 24.04\nos_id=ubuntu\narch=x86_64\nroot=yes\n");
				if (input.includes("/data/coolify")) return ok("data=yes\napp=yes\nproxy=yes\npanel=yes\n");
				return ok();
			},
			fetch: (async (input: string | URL | Request) => {
				fetched.push(String(input));
				return new Response('{"ok":true}', { status: 200 });
			}) as typeof fetch,
		});
		const ctx = context(dir, f);
		await backendPhase(ctx);
		const url = "https://backend.203-0-113-5.sslip.io";
		expect(fetched).toEqual([`${url}/healthz`]);
		expect(f.commands).toEqual([{ name: "backend", argv: ["setup", "--url", url, "--config", join(dir, "typetorch.json")] }]);
		expect(f.scripts[0].cmd.slice(-2)).toEqual(["root@203.0.113.5", "bash -s"]);
		const dotEnv = readFileSync(join(dir, ".env"), "utf8");
		const key = /TYPETORCH_API_KEY=(\w+)/.exec(dotEnv)![1];
		const block = readFileSync(join(dir, COOLIFY_ENV_FILE), "utf8");
		expect(block).toContain(`TYPETORCH_API_KEY=${key}`);
		expect(block).toContain(`TYPETORCH_PUBLIC_URL=${url}`);
		if (process.platform !== "win32") expect(statSync(join(dir, COOLIFY_ENV_FILE)).mode & 0o777).toBe(0o600);
		expect(f.tui.output.join("\n")).not.toContain(key);
		expect(f.tui.output.join("\n")).toContain(`https://${url.slice(8)}:8787`);
		expect(ctx.state.answers).toMatchObject({ backend: "coolify", reach: "ssh", sshHost: "203.0.113.5", sshUser: "root", sshPort: 22, sshAuth: "password", coolifyMode: "clicked", backendUrl: url });
	});

	test("a machine without root or sudo is refused before anything is installed", async () => {
		const dir = gameDir();
		const f = fakes(["coolify", "local"], { shell: () => ok("os=Ubuntu\nos_id=ubuntu\nroot=no\n") });
		await expect(backendPhase(context(dir, f))).rejects.toThrow("needs root or sudo");
		expect(f.scripts).toHaveLength(1);
	});

	test("a VPS with no Docker over SSH with a key: each install step in order, the keys only on stdin, then health and setup", async () => {
		const dir = gameDir();
		const fetched: string[] = [];
		const f = fakes(["linux", "ssh", "203.0.113.5", "", "", "key", "", "n", "y"], {
			shell: (_cmd, input) => (input.includes("uname") ? ok("os=Debian 12\nos_id=debian\narch=x86_64\nroot=sudo\n") : ok()),
			fetch: (async (input: string | URL | Request) => {
				fetched.push(String(input));
				return new Response("ok", { status: 200 });
			}) as typeof fetch,
		});
		const ctx = context(dir, f);
		await backendPhase(ctx);
		const url = "https://backend.203-0-113-5.sslip.io";
		const key = /TYPETORCH_API_KEY=(\w+)/.exec(readFileSync(join(dir, ".env"), "utf8"))![1];
		const steps = installSteps({ hostname: url.slice(8), key, admin: "x" });
		// The probe, then one script per step.
		expect(f.scripts).toHaveLength(1 + steps.length);
		expect(f.scripts[0].cmd).toContain("BatchMode=yes");
		expect(f.scripts[0].cmd).toContain(join(FAKE_HOME, ".ssh", "id_ed25519"));
		for (const [i, step] of steps.entries()) expect(f.scripts[i + 1].input).toContain(step.script.split("\n")[0]);
		const envScript = f.scripts.find((s) => s.input.includes(ENV_FILE) && s.input.includes("TYPETORCH_ENV"))!;
		expect(envScript.input).toContain(`TYPETORCH_API_KEY=${key}`);
		expect(envScript.input).toContain(`TYPETORCH_PUBLIC_URL=${url}`);
		expect(f.scripts.some((s) => s.cmd.join(" ").includes(key))).toBe(false);
		expect(f.tui.output.join("\n")).not.toContain(key);
		expect(f.scripts.at(-1)!.input).toContain(`${url.slice(8)} {`);
		expect(fetched).toEqual([`${url}/healthz`]);
		expect(f.commands).toEqual([{ name: "backend", argv: ["setup", "--url", url, "--config", join(dir, "typetorch.json")] }]);
		expect(ctx.state.answers).toMatchObject({ backend: "linux", sshAuth: "key", sshIdentity: join(FAKE_HOME, ".ssh", "id_ed25519") });
	});

	test("a VPS with no Docker: a failed step stops the install with its output", async () => {
		const dir = gameDir();
		const f = fakes(["linux", "local", "n", "y"], {
			shell: (_cmd, input) => {
				if (input.includes("uname")) return ok("os=Ubuntu 24.04\nos_id=ubuntu\nroot=yes\n");
				if (input.includes("api.ipify.org")) return ok("198.51.100.7\n");
				if (input.includes("ss -ltnpH")) return { exitCode: 3, stdout: "another program listens on 80, 443 or 8787:\nLISTEN 0 511 *:80 users:((\"nginx\"))", stderr: "" };
				return ok();
			},
		});
		await expect(backendPhase(context(dir, f))).rejects.toThrow("nginx");
		expect(f.scripts.some((s) => s.input.includes("apt-get"))).toBe(false);
		expect(f.commands).toEqual([]);
	});

	test("teardown: the Linux service goes after a yes, the data only on a second yes; the phase runs again next time", async () => {
		const dir = gameDir();
		const f = fakes(["local", "y", "n"], { shell: (_cmd, input) => (input.includes("uname") ? ok("os=Ubuntu\nos_id=ubuntu\nroot=yes\n") : ok()) });
		const ctx = context(dir, f);
		ctx.state.answers.backend = "linux";
		ctx.state.done.backend = { at: "2026-10-10T12:00:00Z" };
		await backendTeardown(ctx);
		const scripts = f.scripts.slice(1).map((s) => s.input).join("\n");
		expect(scripts).toContain("systemctl disable");
		expect(scripts).not.toContain(`rm -rf ${DATA_DIR}`);
		expect(ctx.state.done.backend).toBeUndefined();
		expect(ctx.state.answers.backend).toBe("skip");

		const g = fakes(["local", "n"], { shell: () => ok("os=Ubuntu\nos_id=ubuntu\nroot=yes\n") });
		const kept = context(dir, g);
		kept.state.answers.backend = "linux";
		await backendTeardown(kept);
		expect(g.scripts).toHaveLength(1);
		expect(kept.state.answers.backend).toBe("linux");
	});

	test("the install and teardown scripts are valid bash; the Caddy site and env file", () => {
		const o = { hostname: "backend.example.com", key: "k".repeat(64), admin: "a".repeat(64) };
		for (const step of [...installSteps(o), ...teardownSteps({ deleteData: true })]) {
			const check = spawnSync("bash", ["-n"], { input: PRELUDE + step.script, encoding: "utf8" });
			expect(`${step.label}: ${check.stderr}`).toBe(`${step.label}: `);
		}
		expect(caddySite(o.hostname)).toContain("reverse_proxy 127.0.0.1:8787");
		expect(teardownSteps({ deleteData: false }).some((s) => s.script.includes(DATA_DIR))).toBe(false);
	});

	test("this PC: checkout, install, explorer build, backend.json, the login task, and the wait for a pointed tunnel", async () => {
		const dir = gameDir();
		const backendDir = join(temp(), "game-backend");
		writeFileSync(join(dir, ".env"), `TYPETORCH_API_KEY=${"k".repeat(64)}\nTYPETORCH_ADMIN_TOKEN=${"a".repeat(64)}\n`);
		let pointedWritten = false;
		const f = fakes(["thispc", backendDir, "y"], {
			capture: (cmd) => {
				// The login task starts the backend; the fake writes what `backend run` would.
				if (cmd[0] === "systemctl" && cmd[2] === "restart") {
					mkdirSync(join(dir, ".typetorch"), { recursive: true });
					writeFileSync(join(dir, BACKEND_STATUS_FILE), JSON.stringify({ state: "pointed", url: "https://q.trycloudflare.com", local: "http://localhost:8787", pid: 1, at: "2026-10-10T12:00:05Z" }));
					pointedWritten = true;
				}
				return ok();
			},
			env: { PATH: "/usr/bin" },
		});
		const ctx = context(dir, f);
		ctx.state.answers.project = "game";
		await backendPhase(ctx);
		expect(pointedWritten).toBe(true);
		expect(f.processes).toContainEqual(["git", "clone", "--depth", "1", "https://github.com/typetorch/backend", backendDir]);
		expect(f.processes).toContainEqual(["bun", "run", "web:build"]);
		expect(readLocalBackendConfig(dir)).toEqual({ dir: backendDir, port: 8787 });
		const unit = join(FAKE_HOME, ".config", "systemd", "user", "typetorch-backend-game.service");
		expect(readFileSync(unit, "utf8")).toContain("ExecStart=/usr/bin/bun run typetorch backend run");
		expect(f.tui.output.join("\n")).toContain("game servers use https://q.trycloudflare.com");
		expect(f.commands).toEqual([]);
		expect(ctx.state.answers.backendTask).toBe(true);
	});

	test("this PC: a refused setup fails the phase with the reason and where the log is", async () => {
		const dir = gameDir();
		writeFileSync(join(dir, ".env"), `TYPETORCH_API_KEY=${"k".repeat(64)}\nTYPETORCH_ADMIN_TOKEN=${"a".repeat(64)}\n`);
		mkdirSync(join(dir, ".typetorch"), { recursive: true });
		writeFileSync(join(dir, BACKEND_STATUS_FILE), JSON.stringify({ state: "refused", url: "https://q.trycloudflare.com", local: "x", pid: 1, at: "2026-10-10T12:00:01Z", error: "the deploy key lacks DataStore scopes" }));
		const f = fakes(["thispc", join(temp(), "b"), "n"]);
		await expect(backendPhase(context(dir, f))).rejects.toThrow("the deploy key lacks DataStore scopes");
	});
});

// backend bless --------------------------------------------------------------------------------------------------------

describe("backend bless", () => {
	test("sends the public keys when they changed, signs the challenge with the main key, and opens the single-use link", async () => {
		const { backendCommand, backendFlags } = await import("../src/commands/backend");
		const { parseArgs } = await import("../src/args");
		const { Settings } = await import("../src/env");
		const { generateSigningKey, parseSigningKey } = await import("../src/signing");
		const { blessMessage } = await import("../src/backend");
		const { verify, createPublicKey } = await import("node:crypto");
		const dir = gameDir();
		writeFileSync(join(dir, ".env"), `TYPETORCH_ADMIN_TOKEN=${"a".repeat(64)}\n`);
		useSettings(new Settings({ gameDir: dir, env: {} }));
		const signer = { main: parseSigningKey(generateSigningKey().seed), fallback: parseSigningKey(generateSigningKey().seed) };
		const calls: string[] = [];
		let stored: string[] = [];
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
			if (url.pathname === "/v1/access/keys") {
				expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"a".repeat(64)}`);
				if (init?.method === "PUT") stored = JSON.parse(String(init.body)).keys;
				return Response.json({ keys: stored });
			}
			if (url.pathname === "/auth/bless/challenge") return Response.json({ challenge: "ch-1", fingerprint: "tt1-abc", expires_in: 300 });
			return new Response("", { status: 404 });
		}) as typeof fetch;
		const opened: string[] = [];
		const run = () => backendCommand(parseArgs(["bless", "--url", "https://backend.example.com", "--config", join(dir, "typetorch.json")], backendFlags), { signer, fetch: fetcher, open: async (u) => void opened.push(u) });
		await run();
		expect(calls).toEqual(["GET /v1/access/keys", "PUT /v1/access/keys", "GET /auth/bless/challenge"]);
		expect(stored).toEqual([signer.main.publicKey, signer.fallback.publicKey]);
		const link = new URL(opened[0]);
		expect(`${link.origin}${link.pathname}`).toBe("https://backend.example.com/auth/bless");
		expect(link.searchParams.get("challenge")).toBe("ch-1");
		const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(signer.main.publicKey, "base64").toString("base64url") }, format: "jwk" });
		expect(verify(null, Buffer.from(blessMessage("tt1-abc", "ch-1")), pub, Buffer.from(link.searchParams.get("sig")!, "base64url"))).toBe(true);
		calls.length = 0;
		await run();
		expect(calls).toEqual(["GET /v1/access/keys", "GET /auth/bless/challenge"]);
	});
});
