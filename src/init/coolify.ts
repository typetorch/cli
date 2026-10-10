/**
 * The backend on Coolify (plans "typetorch init", backend phase): the machine is reached over SSH or is this one;
 * Coolify is detected, not asked about (its data folder, the coolify and coolify-proxy containers, the panel on port
 * 8000), and installed with its own script only when it is missing and the user says yes. The hostname is the user's
 * domain (its A record checked against the machine) or `backend.<ip>.sslip.io` (no account, nothing to create).
 *
 * Adding the backend to Coolify has two ways. Clicked (the default): the exact resource settings are printed and the
 * environment block, which holds the two keys, goes to `.typetorch/coolify.env` (mode 600, gitignored) instead of the
 * screen; then Enter, and the health and key probes. Automated (when the user gives a Coolify API token, typed masked
 * or COOLIFY_API_TOKEN): the project, the Docker Compose resource, its domain and its variables are created through
 * Coolify's API (over an SSH port forward, so the token never crosses the internet in the clear) and the deploy starts.
 * A rerun finds the resource by name and only re-checks it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve4 } from "node:dns/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { childEnv, registerSecret } from "../env.ts";
import { ensureGitignored, type InitContext } from "./common.ts";
import { execOk, isIpv4, readKeyValues, sslipName, type Machine, PUBLIC_IP_SCRIPT } from "./ssh.ts";

export const BACKEND_REPO_URL = "https://github.com/typetorch/backend";
export const COOLIFY_ENV_FILE = join(".typetorch", "coolify.env");
export const COOLIFY_INSTALL = "curl -fsSL https://cdn.coollabs.io/coolify/install.sh | $SUDO bash";
/** The resource's name in Coolify, so a rerun finds it. */
export const RESOURCE_NAME = "typetorch-backend";

export const DETECT_SCRIPT = `if [ -d /data/coolify ]; then echo data=yes; else echo data=no; fi
names="$($SUDO docker ps --format '{{.Names}}' 2>/dev/null || true)"
case "$names" in *coolify-proxy*) echo proxy=yes ;; *) echo proxy=no ;; esac
if printf '%s\\n' "$names" | grep -qx coolify; then echo app=yes; else echo app=no; fi
if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:8000; then echo panel=yes; else echo panel=no; fi
`;

export interface CoolifyFound {
	data: boolean;
	app: boolean;
	proxy: boolean;
	panel: boolean;
}

export function parseDetect(output: string): CoolifyFound {
	const v = readKeyValues(output);
	return { data: v.data === "yes", app: v.app === "yes", proxy: v.proxy === "yes", panel: v.panel === "yes" };
}

/** Coolify counts as installed when its data folder and its container are there. */
export function coolifyInstalled(found: CoolifyFound): boolean {
	return found.data && found.app;
}

/** The variables the compose file reads, for Coolify's environment. */
export function coolifyEnv(o: { key: string; admin: string; hostname: string }): Record<string, string> {
	return {
		TYPETORCH_API_KEY: o.key,
		TYPETORCH_ADMIN_TOKEN: o.admin,
		TYPETORCH_PUBLIC_URL: `https://${o.hostname}`,
		TYPETORCH_TRUST_PROXY: "1",
	};
}

export function envBlock(values: Record<string, string>): string {
	return Object.entries(values)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n") + "\n";
}

/** The hostname: the user's domain (checked) or the sslip.io name of the machine's IPv4. */
export async function chooseHostname(ctx: InitContext, machine: Machine): Promise<{ hostname: string; ip: string }> {
	const { tui } = ctx;
	const ip = await machineIp(machine);
	tui.note(`the server's public address is ${ip}`);
	const hasDomain = await tui.confirm("Do you have a domain pointed at this server?", ctx.state.answers.backendDomain !== undefined);
	if (!hasDomain) {
		const hostname = sslipName(ip);
		tui.note(`using ${hostname} (sslip.io answers it with ${ip}; no account, nothing to set up)`);
		delete ctx.state.answers.backendDomain;
		return { hostname, ip };
	}
	const domain = await tui.text("The domain (for example backend.example.com)", {
		default: ctx.state.answers.backendDomain as string | undefined,
		validate: (t) => (/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(t) ? undefined : "a host name like backend.example.com, no https:// and no path"),
	});
	ctx.state.answers.backendDomain = domain.toLowerCase();
	let addresses: string[] = [];
	try {
		addresses = await resolve4(domain);
	} catch {}
	if (!addresses.includes(ip)) {
		tui.warn(`${domain} resolves to ${addresses.length ? addresses.join(", ") : "nothing"}, not ${ip}. Add an A record ${domain} -> ${ip} at your DNS provider; the certificate needs it`);
		if (!(await tui.confirm("Continue anyway (the record may still be on its way)?", true))) throw new Error(`point ${domain} at ${ip}, then run \`typetorch init\` again; it continues here`);
	}
	return { hostname: domain.toLowerCase(), ip };
}

async function machineIp(machine: Machine): Promise<string> {
	if (machine.host && isIpv4(machine.host)) return machine.host;
	const out = (await execOk(machine, PUBLIC_IP_SCRIPT, "finding the public address")).trim();
	if (!isIpv4(out)) throw new Error(`could not read ${machine.label}'s public IPv4 (got "${out.slice(0, 60)}")`);
	return out;
}

export async function ensureCoolify(ctx: InitContext, machine: Machine, ip: string): Promise<void> {
	const { tui } = ctx;
	const found = parseDetect(await execOk(machine, DETECT_SCRIPT, "looking for Coolify"));
	if (coolifyInstalled(found)) {
		tui.note(`Coolify is installed on ${machine.label}${found.panel ? " and its panel answers" : ""}: adding the backend to it`);
		return;
	}
	tui.note(`Coolify is not installed on ${machine.label}. Its official script installs Docker and Coolify (a few minutes):`);
	tui.note(`  ${COOLIFY_INSTALL.replace("$SUDO ", "sudo ")}`);
	if (!(await tui.confirm("Install Coolify now?", true))) throw new Error("Coolify is needed for this path: install it (https://coolify.io/docs/get-started/installation) or pick another answer, then run `typetorch init` again");
	await execOk(machine, `${COOLIFY_INSTALL}\n`, "the Coolify install");
	tui.note(`installed. Open http://${ip}:8000 in your browser and create the admin account (the first visitor gets it, so do it now).`);
	await tui.confirm("Created the admin account?", true);
}

// The API (automated path) -------------------------------------------------------------------------------------------

export interface CoolifyApi {
	get<T>(path: string): Promise<T>;
	send<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T>;
}

export function coolifyApi(base: string, token: string, fetcher: typeof fetch): CoolifyApi {
	const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const response = await fetcher(`${base}/api/v1${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Coolify API ${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
		return (text ? JSON.parse(text) : {}) as T;
	};
	return { get: (path) => call("GET", path), send: (method, path, body) => call(method, path, body) };
}

interface Named {
	uuid: string;
	name: string;
}

/**
 * Creates (or finds) the project and the Docker Compose resource, sets the domain and the variables, and starts a
 * deploy. Returns the resource's uuid.
 */
export async function provisionWithApi(api: CoolifyApi, o: { hostname: string; env: Record<string, string>; log: (line: string) => void }): Promise<string> {
	const servers = await api.get<Named[]>("/servers");
	if (!servers.length) throw new Error("Coolify has no server yet: finish its onboarding in the panel");
	const server = servers.find((s) => s.name === "localhost") ?? servers[0];
	const projects = await api.get<Named[]>("/projects");
	const project = projects.find((p) => p.name === "TypeTorch") ?? (await api.send<{ uuid: string }>("POST", "/projects", { name: "TypeTorch", description: "typetorch init" }));
	const apps = await api.get<Named[]>("/applications");
	let uuid = apps.find((a) => a.name === RESOURCE_NAME)?.uuid;
	if (uuid) o.log(`found the ${RESOURCE_NAME} resource: updating its domain and variables`);
	else {
		const created = await api.send<{ uuid: string }>("POST", "/applications/public", {
			project_uuid: project.uuid,
			server_uuid: server.uuid,
			environment_name: "production",
			git_repository: BACKEND_REPO_URL,
			git_branch: "main",
			build_pack: "dockercompose",
			docker_compose_location: "/compose.yaml",
			ports_exposes: "8787",
			name: RESOURCE_NAME,
			instant_deploy: false,
		});
		uuid = created.uuid;
		o.log(`created the ${RESOURCE_NAME} resource in the TypeTorch project`);
	}
	await api.send("PATCH", `/applications/${uuid}`, { docker_compose_domains: [{ name: "backend", domain: `https://${o.hostname}:8787` }] });
	await api.send("PATCH", `/applications/${uuid}/envs/bulk`, { data: Object.entries(o.env).map(([key, value]) => ({ key, value, is_preview: false })) });
	await api.get(`/deploy?uuid=${encodeURIComponent(uuid)}&force=false`);
	o.log("deploy started (the first build takes a few minutes)");
	return uuid;
}

/** A free local port for the SSH forward. */
function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer();
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => done(port));
		});
	});
}

/** `ssh -N -L` to the panel; resolves with the local base URL once it answers, and a close function. */
async function forwardPanel(ctx: InitContext, machine: Machine): Promise<{ base: string; close: () => void }> {
	if (!machine.ssh) return { base: "http://127.0.0.1:8000", close: () => {} };
	const port = await freePort();
	const t = machine.ssh;
	const args = ["-N", "-p", String(t.port), "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:8000`, ...(t.keyFile ? ["-i", t.keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"] : []), `${t.user}@${t.host}`];
	const child: ChildProcess = spawn("ssh", args, { stdio: ["inherit", "ignore", "inherit"], env: childEnv(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) });
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 60; i++) {
		try {
			await ctx.deps.fetch(base, { signal: AbortSignal.timeout(2000) });
			return { base, close: () => child.kill() };
		} catch {}
		if (child.exitCode !== null) break;
		await ctx.deps.sleep(500);
	}
	child.kill();
	throw new Error("the SSH port forward to Coolify's panel did not come up");
}

/** Clicked path: the settings to type into Coolify, the env block in a private file. */
export function printClickedSteps(ctx: InitContext, o: { hostname: string; ip: string; env: Record<string, string> }): string {
	const { tui } = ctx;
	const file = join(ctx.dir, COOLIFY_ENV_FILE);
	mkdirSync(join(ctx.dir, ".typetorch"), { recursive: true });
	writeFileSync(file, envBlock(o.env), { mode: 0o600 });
	try {
		chmodSync(file, 0o600);
	} catch {}
	ensureGitignored(ctx.dir, ".typetorch/");
	tui.note(`In Coolify (http://${o.ip}:8000):`);
	tui.note(`  1. Projects, + Add, name it TypeTorch; open it, + New resource, Public Repository`);
	tui.note(`  2. Repository URL ${BACKEND_REPO_URL}, branch main, Build Pack: Docker Compose, Docker Compose Location /compose.yaml`);
	tui.note(`  3. Name the resource ${RESOURCE_NAME}. On the backend service, Domains: https://${o.hostname}:8787`);
	tui.note(`  4. Environment Variables, Developer view: paste the contents of ${file}`);
	tui.note(`     (it holds the two keys; it is not printed here, it is gitignored, delete it once Coolify has them)`);
	tui.note(`  5. Deploy, and wait until the backend container is healthy`);
	return file;
}

export async function coolifyBackend(ctx: InitContext, machine: Machine, keys: { key: string; admin: string }): Promise<string> {
	const { tui } = ctx;
	const { hostname, ip } = await chooseHostname(ctx, machine);
	await ensureCoolify(ctx, machine, ip);
	const env = coolifyEnv({ ...keys, hostname });
	const how = await tui.select(
		"How should the backend be added to Coolify?",
		[
			{ value: "clicked", label: "I click it in the panel", hint: "the exact settings are printed; the two keys go to a private file" },
			{ value: "api", label: "Through Coolify's API", hint: "paste an API token from the panel (Keys & Tokens, API tokens, with write and deploy)" },
		],
		(ctx.state.answers.coolifyMode as "clicked" | "api" | undefined) ?? "clicked",
	);
	ctx.state.answers.coolifyMode = how;
	if (how === "api") {
		const token = ctx.deps.env.COOLIFY_API_TOKEN ?? (await tui.secret("Coolify API token", { validate: (t) => (t.length < 10 ? "paste the whole token" : undefined) }));
		registerSecret(token);
		let forward: { base: string; close: () => void } | undefined;
		try {
			forward = await forwardPanel(ctx, machine);
			await provisionWithApi(coolifyApi(forward.base, token, ctx.deps.fetch), { hostname, env, log: (line) => tui.note(line) });
		} catch (error) {
			tui.warn(`${(error as Error).message}`);
			tui.warn("the API path did not finish; doing it in the panel instead");
			printClickedSteps(ctx, { hostname, ip, env });
			await tui.confirm("Deployed in Coolify? (Enter checks it)", true);
		} finally {
			forward?.close();
		}
	} else {
		printClickedSteps(ctx, { hostname, ip, env });
		await tui.confirm("Deployed in Coolify? (Enter checks it)", true);
	}
	return `https://${hostname}`;
}

