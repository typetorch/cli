/**
 * Phase 6, the backend (optional; plans "typetorch init", backend phase). Where it runs:
 *   coolify   a VPS with Coolify, reached over SSH or this machine (coolify.ts): Coolify detected or installed, the
 *             backend added by hand with printed settings or through Coolify's API, a domain or an sslip.io name
 *   linux     a plain Linux service on a VPS (or this machine): Bun, systemd, Caddy with a certificate for a domain or
 *             an sslip.io name, no Docker (linuxservice.ts)
 *   this PC   the backend next to the game behind a Cloudflare quick tunnel, kept pointed by `backend run` as a login
 *             task (thispc.ts)
 *   existing  a backend that already runs: its URL and two keys
 *   skip      nothing; the summary says what is lost
 * Every path that installs one generates the two 32-byte keys here, writes them to the game's .env and nowhere else on
 * this PC; they reach the server only inside its environment. Then `backend setup` signs the address into the settings
 * record. `typetorch init --teardown` removes what the chosen path installed (backendTeardown).
 */
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_TOKEN_VAR, BACKEND_KEY_VAR, Settings, registerSecret, useSettings } from "../env.ts";
import { DOCS } from "../tui.ts";
import { configFlag, slugify, upsertDotEnv, type InitContext } from "./common.ts";
import { chooseHostname, coolifyBackend } from "./coolify.ts";
import { linuxServiceInstall, runSteps, teardownSteps } from "./linuxservice.ts";
import { loginTask } from "./logintask.ts";
import { localMachine, privateKeys, probeMachine, sshMachine, type Machine } from "./ssh.ts";
import { thisPcBackend } from "./thispc.ts";

export const BACKEND_README = "https://github.com/typetorch/backend#readme";

export type BackendChoice = "coolify" | "linux" | "thispc" | "existing" | "skip";

/** The two keys from the environment or the game's .env; missing ones are generated and written to .env. */
export function ensureBackendKeys(ctx: InitContext): { key: string; admin: string; generated: string[] } {
	const current = new Settings({ gameDir: ctx.dir, env: ctx.deps.env });
	const values: Record<string, string> = {};
	const out: Record<string, string> = {};
	for (const name of [BACKEND_KEY_VAR, ADMIN_TOKEN_VAR]) {
		const have = current.get(name)?.value;
		if (have && have.length >= 32) out[name] = have;
		else values[name] = out[name] = randomBytes(32).toString("hex");
		registerSecret(out[name]);
	}
	if (out[BACKEND_KEY_VAR] === out[ADMIN_TOKEN_VAR]) values[ADMIN_TOKEN_VAR] = out[ADMIN_TOKEN_VAR] = randomBytes(32).toString("hex");
	if (Object.keys(values).length) {
		upsertDotEnv(join(ctx.dir, ".env"), values);
		useSettings(new Settings({ gameDir: ctx.dir, env: ctx.deps.env }));
	}
	return { key: out[BACKEND_KEY_VAR], admin: out[ADMIN_TOKEN_VAR], generated: Object.keys(values) };
}

/** SSH or this machine, the details, and a test connection that must show root or passwordless sudo. */
export async function reachMachine(ctx: InitContext): Promise<Machine> {
	const { tui, deps } = ctx;
	const options = [
		{ value: "ssh" as const, label: "Over SSH from this PC", hint: "the server's address, a user, and a key file (or a password)" },
		...(deps.platform === "linux" ? [{ value: "local" as const, label: "I am on the server now", hint: "commands run here, with sudo" }] : []),
	];
	const how = options.length === 1 ? "ssh" : await tui.select("How do we reach the server?", options, (ctx.state.answers.reach as "ssh" | "local" | undefined) ?? "ssh");
	ctx.state.answers.reach = how;
	let machine: Machine;
	if (how === "local") machine = localMachine(deps, ctx.dir);
	else {
		const host = await tui.text("The server's address (IP or host name)", {
			default: ctx.state.answers.sshHost as string | undefined,
			validate: (t) => (/^[A-Za-z0-9.:-]+$/.test(t) ? undefined : "an IP address or a host name, no user@ and no port"),
		});
		const user = await tui.text("SSH user", { default: (ctx.state.answers.sshUser as string | undefined) ?? "root", validate: (t) => (/^[a-z_][a-z0-9_.-]*$/i.test(t) ? undefined : "a user name") });
		const portText = await tui.text("SSH port", { default: String(ctx.state.answers.sshPort ?? 22), validate: (t) => (/^\d+$/.test(t) && Number(t) > 0 && Number(t) < 65536 ? undefined : "a port number") });
		const keys = privateKeys(deps.home);
		const auth = await tui.select(
			"How do you log in?",
			[
				{ value: "key", label: "An SSH key file", hint: keys.length ? `found: ${keys.join(", ")}` : "for example ~/.ssh/id_ed25519" },
				{ value: "password", label: "A password", hint: "typed into ssh's own prompt for each step; a key is faster" },
			],
			(ctx.state.answers.sshAuth as "key" | "password" | undefined) ?? (keys.length ? "key" : "password"),
		);
		let keyFile: string | undefined;
		if (auth === "key") {
			keyFile = await tui.text("Key file", {
				default: (ctx.state.answers.sshIdentity as string | undefined) ?? keys.find((k) => k.endsWith("id_ed25519")) ?? keys[0] ?? join(deps.home, ".ssh", "id_ed25519"),
				validate: (t) => (t.endsWith(".pub") ? "the private key (the file without .pub)" : undefined),
			});
			ctx.state.answers.sshIdentity = keyFile;
		}
		Object.assign(ctx.state.answers, { sshHost: host, sshUser: user, sshPort: Number(portText), sshAuth: auth });
		machine = sshMachine({ host, user, port: Number(portText), keyFile }, deps, ctx.dir);
	}
	const info = await probeMachine(machine);
	tui.note(`${machine.label}: ${info.os} (${info.arch})`);
	if (info.root === "no") throw new Error(`${machine.label} needs root or sudo without a password for the install steps: log in as root, or add the user to sudoers with NOPASSWD, then run \`typetorch init\` again`);
	if (!/^(ubuntu|debian)$/.test(info.osId)) tui.warn(`${info.os} is not Debian or Ubuntu, which is what the install steps are written for; continuing`);
	return machine;
}

/** Polls `<url>/healthz` until it answers, asking to keep waiting every few minutes. */
export async function waitHealthy(ctx: InitContext, url: string): Promise<void> {
	const { tui, deps } = ctx;
	for (;;) {
		for (let i = 0; i < 30; i++) {
			try {
				const response = await deps.fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
				if (response.ok) return;
			} catch {}
			await deps.sleep(10_000);
		}
		if (!(await tui.confirm(`${url}/healthz does not answer yet (a first deploy and its certificate can take several minutes). Keep waiting?`, true))) {
			throw new Error(`${url} does not answer. When it does, run \`typetorch init\` again; it continues here`);
		}
	}
}

async function pointGame(ctx: InitContext, url: string): Promise<void> {
	ctx.tui.note("Checking the address and both keys, then writing the signed settings record (servers follow it within seconds).");
	await ctx.deps.command("backend", ["setup", "--url", url, ...configFlag(ctx)]);
	await ctx.deps.capture(["git", "add", "typetorch.json"], ctx.dir);
	await ctx.deps.capture(["git", "commit", "-q", "-m", "Backend"], ctx.dir);
}

export async function backendPhase(ctx: InitContext): Promise<void> {
	const { tui } = ctx;
	tui.step(ctx.index("backend"), ctx.total, "Backend (optional)", "A self-hosted server: live servers, deploy reports, alerts, automatic rollback and your own analytics.", `${DOCS}/guides/fleet-and-alerts.md`);
	const choice = await tui.select<BackendChoice>(
		"Where should the backend run?",
		[
			{ value: "coolify", label: "A VPS with Coolify", hint: "installs Coolify when it is missing; a domain, or a free sslip.io name" },
			{ value: "linux", label: "A VPS, no Docker", hint: "a plain Linux service with Caddy in front; lightest on a small server" },
			{ value: "thispc", label: "This PC", hint: "for testing: a free Cloudflare quick tunnel, no account; runs while the PC is on" },
			{ value: "existing", label: "I already run one", hint: `its https address and its two keys (${BACKEND_README})` },
			{ value: "skip", label: "Skip for now", hint: "everything else works; you lose alerts, the automatic rollback after a bad deploy, and analytics" },
		],
		(ctx.state.answers.backend as BackendChoice | undefined) ?? "skip",
	);
	ctx.state.answers.backend = choice;
	if (choice === "skip") {
		tui.note(`later: \`typetorch init --phase backend\`, or ${BACKEND_README} by hand`);
		return;
	}
	if (choice === "existing") return existingBackend(ctx);
	const keys = ensureBackendKeys(ctx);
	if (keys.generated.length) tui.note(`generated ${keys.generated.join(" and ")} into ${join(ctx.dir, ".env")} (never printed)`);
	if (choice === "thispc") return thisPcBackend(ctx);
	const machine = await reachMachine(ctx);
	const url = choice === "coolify" ? await coolifyBackend(ctx, machine, keys) : await linuxBackend(ctx, machine, keys);
	ctx.state.answers.backendUrl = url;
	tui.note(`waiting for ${url}/healthz`);
	await waitHealthy(ctx, url);
	await pointGame(ctx, url);
}

async function linuxBackend(ctx: InitContext, machine: Machine, keys: { key: string; admin: string }): Promise<string> {
	const { tui } = ctx;
	const { hostname } = await chooseHostname(ctx, machine);
	tui.note(`on ${machine.label}: packages, 2 GB swap, the firewall (SSH, 80 and 443 only), Bun, a typetorch user, the backend in /opt/typetorch-backend as a systemd service, Caddy with a certificate for ${hostname}`);
	if (!(await tui.confirm(`Install the backend on ${machine.label}?`, true))) throw new Error("nothing was installed. Run `typetorch init` again to choose another way");
	await linuxServiceInstall(tui, machine, { hostname, key: keys.key, admin: keys.admin });
	return `https://${hostname}`;
}

/**
 * `typetorch init --teardown`: removes what the backend phase installed, after a y/N. The Linux service: the service,
 * the code, the settings and the Caddy site (the data only when asked). This PC: the login task. Coolify: the
 * resource is deleted in its panel. The game keeps pointing at the old address until the backend phase runs again.
 */
export async function backendTeardown(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	const choice = ctx.state.answers.backend as BackendChoice | undefined;
	if (choice === "linux") {
		const machine = await reachMachine(ctx);
		if (!(await tui.confirm(`Remove the backend service, its code, its settings and its Caddy site from ${machine.label}?`, false))) return;
		const deleteData = await tui.confirm("Also delete its data (deploy reports, analytics) and the typetorch user? This cannot be undone", false);
		await runSteps(tui, machine, teardownSteps({ deleteData }));
		tui.note("kept: Bun, Caddy, the swap file and the firewall rules (other programs may use them)");
	} else if (choice === "thispc") {
		const bun = deps.which("bun") ?? "bun";
		const task = loginTask({ platform: deps.platform, home: deps.home, appData: deps.env.APPDATA, slug: slugify(String(ctx.state.answers.project ?? "")) || "game", gameDir: ctx.dir, bun, path: deps.env.PATH ?? "" });
		if (!(await tui.confirm(`Remove the login task that runs the backend on this PC? (${task.describe})`, false))) return;
		for (const cmd of task.remove) await deps.capture(cmd, ctx.dir);
		for (const file of task.files) if (existsSync(file.path)) rmSync(file.path);
		tui.note(`the backend's code stays in ${String(ctx.state.answers.backendDir ?? "its folder")}; delete it by hand if you want`);
	} else if (choice === "coolify") {
		tui.note("delete the typetorch-backend resource in the Coolify panel (Projects, TypeTorch); Coolify itself stays");
	} else {
		tui.note("no backend was installed by `typetorch init` here; nothing to remove");
		return;
	}
	ctx.state.answers.backend = "skip";
	delete ctx.state.done.backend;
	ctx.save();
	tui.warn("the game still points at the old address: `typetorch init --phase backend` points it at a new backend");
}

async function existingBackend(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	const url = await tui.text("The backend's public https address", {
		default: ctx.state.answers.backendUrl as string | undefined,
		validate: (text) => (/^https:\/\/[^/\s]+$/.test(text) ? undefined : "an https:// address with no path, for example https://backend.example.com"),
	});
	ctx.state.answers.backendUrl = url;
	const current = new Settings({ gameDir: ctx.dir, env: deps.env });
	const values: Record<string, string> = {};
	for (const [name, what] of [
		[BACKEND_KEY_VAR, "the backend's game key (TYPETORCH_API_KEY on the server)"],
		[ADMIN_TOKEN_VAR, "the backend's admin token (TYPETORCH_ADMIN_TOKEN on the server)"],
	] as const) {
		if (current.get(name)) {
			tui.note(`${name} is already set in ${current.get(name)!.source}`);
			continue;
		}
		const value = await tui.secret(`Paste ${what}`, { validate: (t) => (t.length < 32 ? "32 characters or more" : undefined) });
		registerSecret(value);
		values[name] = value;
	}
	if (Object.keys(values).length) {
		upsertDotEnv(join(ctx.dir, ".env"), values);
		useSettings(new Settings({ gameDir: ctx.dir, env: deps.env }));
	}
	await pointGame(ctx, url);
}
