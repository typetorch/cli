/**
 * `typetorch backend run` as a login task, so the local backend and its tunnel come back after a reboot with no step:
 * a systemd user unit on Linux, a LaunchAgent on macOS, and on Windows a hidden launcher in the Startup folder (a
 * scheduled task "at logon" needs an administrator; the Startup folder does not). Output goes to
 * `.typetorch/backend.log` in the game repo. Nothing here holds a key: the command reads them from the game's .env.
 */
import { posix, win32 } from "node:path";
import { BACKEND_LOG_FILE } from "../backendrun.ts";

export interface LoginTask {
	/** What to tell the user ("a systemd user unit ~/.config/..."). */
	describe: string;
	files: { path: string; content: string }[];
	/** Commands that register it and start it now. */
	install: string[][];
	/** Commands that stop and unregister it (files are removed by the caller). */
	remove: string[][];
}

export interface LoginTaskOptions {
	platform: NodeJS.Platform;
	home: string;
	/** %APPDATA% on Windows. */
	appData?: string;
	/** The game's slug, so two games get two tasks. */
	slug: string;
	gameDir: string;
	/** Bun's full path. */
	bun: string;
	/** PATH for the task (bun, git and cloudflared must be on it). */
	path: string;
}

function xml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** systemd quoting for one argument. */
function unitArg(text: string): string {
	return /[\s"\\]/.test(text) ? `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : text;
}

export function loginTask(o: LoginTaskOptions): LoginTask {
	// Paths follow the target OS, not the OS running the CLI (so tests and previews are stable everywhere).
	const join = o.platform === "win32" ? win32.join : posix.join;
	const log = join(o.gameDir, BACKEND_LOG_FILE);
	if (o.platform === "linux") {
		const unit = `typetorch-backend-${o.slug}.service`;
		const path = join(o.home, ".config", "systemd", "user", unit);
		const content = [
			"[Unit]",
			`Description=TypeTorch backend for ${o.slug} (typetorch backend run)`,
			"After=network-online.target",
			"",
			"[Service]",
			`WorkingDirectory=${unitArg(o.gameDir)}`,
			`Environment=${unitArg(`PATH=${o.path}`)}`,
			`ExecStart=${unitArg(o.bun)} run typetorch backend run`,
			"Restart=on-failure",
			"RestartSec=10",
			`StandardOutput=append:${log}`,
			`StandardError=append:${log}`,
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
		return {
			describe: `a systemd user unit (${path})`,
			files: [{ path, content }],
			install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", unit], ["systemctl", "--user", "restart", unit]],
			remove: [["systemctl", "--user", "disable", "--now", unit]],
		};
	}
	if (o.platform === "darwin") {
		const label = `dev.typetorch.backend.${o.slug}`;
		const path = join(o.home, "Library", "LaunchAgents", `${label}.plist`);
		const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${xml(label)}</string>
	<key>ProgramArguments</key>
	<array><string>${xml(o.bun)}</string><string>run</string><string>typetorch</string><string>backend</string><string>run</string></array>
	<key>WorkingDirectory</key><string>${xml(o.gameDir)}</string>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(o.path)}</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>StandardOutPath</key><string>${xml(log)}</string>
	<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
		return {
			describe: `a LaunchAgent (${path})`,
			files: [{ path, content }],
			// unload first so a rerun picks up a changed file; its failure (not loaded yet) is ignored by the caller.
			install: [["launchctl", "unload", path], ["launchctl", "load", "-w", path]],
			remove: [["launchctl", "unload", "-w", path]],
		};
	}
	const appData = o.appData ?? join(o.home, "AppData", "Roaming");
	const startup = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
	const cmd = join(o.gameDir, ".typetorch", "backend-run.cmd");
	const vbs = join(startup, `typetorch-backend-${o.slug}.vbs`);
	return {
		describe: `a hidden launcher in your Startup folder (${vbs})`,
		files: [
			{ path: cmd, content: `@echo off\r\ncd /d "${o.gameDir}"\r\n"${o.bun}" run typetorch backend run >> "${log}" 2>&1\r\n` },
			// Window style 0: no console window.
			{ path: vbs, content: `CreateObject("WScript.Shell").Run """${cmd}""", 0, False\r\n` },
		],
		install: [["wscript.exe", vbs]],
		// Deleting the launcher is the removal; a running backend stops at logout.
		remove: [],
	};
}
