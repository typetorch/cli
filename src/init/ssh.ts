/**
 * The machine a backend installer works on: this one (commands run here, with sudo when not root) or a VPS over SSH.
 * Every step is one bash script fed to `bash -s` on stdin, so a password is typed once per step into the real `ssh`
 * prompt (never on a command line, never in a file) and on Linux and macOS a control socket reuses the first login
 * for a minute. Key files go to `ssh -i`; the agent (SSH_AUTH_SOCK) is passed on when there is one.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../env.ts";
import type { RunResult } from "../proc.ts";
import { resolveCommand } from "../runtime.ts";
import type { InitDeps } from "./common.ts";

/** Runs a command with `input` on stdin; never throws for a non-zero exit (a missing binary gives 127). */
export function withStdin(cmd: string[], cwd: string, input: string, extra: Record<string, string> = {}): Promise<RunResult> {
	const env = childEnv({ ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}), ...extra });
	let resolved;
	try {
		resolved = resolveCommand(cmd, env);
	} catch (error) {
		return Promise.resolve({ exitCode: 127, stdout: "", stderr: String((error as Error).message ?? error) });
	}
	return new Promise((done) => {
		const child = spawn(resolved.file, resolved.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => err.push(Buffer.from(String(error.message))));
		child.on("close", (code) => done({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

export interface SshTarget {
	host: string;
	user: string;
	port: number;
	/** A private key file; undefined means a password (or the agent). */
	keyFile?: string;
}

export interface Machine {
	/** "this machine" or "root@1.2.3.4". */
	label: string;
	/** The address the user typed, when it is a remote one. */
	host?: string;
	ssh?: SshTarget;
	/** Runs a bash script (with `$SUDO` set to "sudo" or "" first). */
	exec(script: string): Promise<RunResult>;
}

/** The prelude every script gets: stop on the first error, and `$SUDO` for the steps that need root. */
export const PRELUDE = 'set -eu\nif [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi\n';

export function sshArgs(target: SshTarget, platform: NodeJS.Platform, home: string): string[] {
	const args = ["ssh", "-p", String(target.port), "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];
	if (target.keyFile) args.push("-i", target.keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes");
	if (platform !== "win32") args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${join(home, ".ssh", "typetorch-%C")}`, "-o", "ControlPersist=60");
	args.push(`${target.user}@${target.host}`, "bash -s");
	return args;
}

export function sshMachine(target: SshTarget, deps: Pick<InitDeps, "shell" | "platform" | "home">, cwd: string): Machine {
	return {
		label: `${target.user}@${target.host}`,
		host: target.host,
		ssh: target,
		exec: (script) => deps.shell(sshArgs(target, deps.platform, deps.home), cwd, PRELUDE + script),
	};
}

export function localMachine(deps: Pick<InitDeps, "shell">, cwd: string): Machine {
	return { label: "this machine", exec: (script) => deps.shell(["bash", "-s"], cwd, PRELUDE + script) };
}

/** Throws with the script's last lines when it failed. */
export async function execOk(machine: Machine, script: string, what: string): Promise<string> {
	const result = await machine.exec(script);
	if (result.exitCode !== 0) {
		const tail = [result.stdout, result.stderr].join("\n").trim().split(/\r?\n/).slice(-15).join("\n");
		const hint = result.exitCode === 255 && machine.ssh ? " (ssh could not connect or log in: check the address, the user and the key)" : "";
		throw new Error(`${what} failed on ${machine.label} (exit ${result.exitCode})${hint}${tail ? `:\n${tail}` : ""}`);
	}
	return result.stdout;
}

/** `KEY=value` lines a script printed. */
export function readKeyValues(output: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = /^([a-z_]+)=(.*)$/.exec(line.trim());
		if (match) values[match[1]] = match[2];
	}
	return values;
}

/** The first look at a machine: its OS and whether root steps can run without a password prompt. */
export const PROBE_SCRIPT = `echo "kernel=$(uname -sr)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=\${PRETTY_NAME:-unknown}"; echo "os_id=\${ID:-unknown}"; fi
echo "arch=$(uname -m)"
if [ "$(id -u)" = 0 ]; then echo root=yes; elif sudo -n true 2>/dev/null; then echo root=sudo; else echo root=no; fi
`;

export interface MachineInfo {
	os: string;
	osId: string;
	arch: string;
	root: "yes" | "sudo" | "no";
}

export async function probeMachine(machine: Machine): Promise<MachineInfo> {
	const values = readKeyValues(await execOk(machine, PROBE_SCRIPT, "the test connection"));
	return { os: values.os ?? values.kernel ?? "unknown", osId: values.os_id ?? "unknown", arch: values.arch ?? "unknown", root: (values.root as MachineInfo["root"]) ?? "no" };
}

/** Private key files in ~/.ssh (not .pub, known_hosts, config or authorized_keys), for the key question. */
export function privateKeys(home: string): string[] {
	const dir = join(home, ".ssh");
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".pub") || /^(known_hosts|config|authorized_keys|environment)/.test(name) || name.startsWith("typetorch-")) continue;
		try {
			if (readFileSync(join(dir, name), "utf8").slice(0, 200).includes("PRIVATE KEY")) out.push(join(dir, name));
		} catch {}
	}
	return out.sort();
}

/** A machine's public IPv4, asked from the machine itself. */
export const PUBLIC_IP_SCRIPT = `curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me\n`;

export function isIpv4(text: string): boolean {
	const parts = text.split(".");
	return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** `backend.1-2-3-4.sslip.io`: a public name for an address, no account (sslip.io answers it with the address). */
export function sslipName(ip: string): string {
	return `backend.${ip.replace(/\./g, "-")}.sslip.io`;
}
