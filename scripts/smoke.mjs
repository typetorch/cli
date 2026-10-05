#!/usr/bin/env node
// Smoke test of the COMPILED CLI under plain Node (no Bun): `bun run build`, then `node scripts/smoke.mjs [--pack]`.
//   - the bin (dist/index.js, `#!/usr/bin/env node`): --help, --version, doctor --help, help deploy, an unknown command;
//   - runtime.ts as compiled: PATH lookup, child processes (Windows: an npm .cmd shim and a plain .cmd script get
//     hostile arguments through unharmed), zstd, an .rbxm round trip;
//   - `doctor --json` in an empty temp folder with a minimal environment (no keys, so nothing is probed online);
//   --pack: `npm pack`, the file list (only dist/*.js, README.md, LICENSE, package.json), a scan of every packed file
//   for key-like strings, local paths and this machine's user name, then `npx <tarball> --help` in a temp folder
//   (offline: the CLI has no dependencies). Nothing is published.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bin = join(root, pkg.bin.typetorch);
const win = process.platform === "win32";
let failures = 0;

function check(name, ok, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures += 1;
}

function node(args, options = {}) {
	const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, ...options });
	return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

if (process.versions.bun) console.log("warning: run this with node (it is the Node smoke test); bun is running it");
console.log(`smoke: ${pkg.name} ${pkg.version} under node ${process.version} (${process.platform})`);
if (!existsSync(bin)) {
	console.error(`missing ${relative(root, bin)}: run \`bun run build\` first`);
	process.exit(1);
}

// 1. The bin.
check("bin starts with #!/usr/bin/env node", readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
let r = node([bin, "--help"]);
check("typetorch --help", r.code === 0 && r.out.includes("usage: typetorch <command>"), `exit ${r.code}`);
r = node([bin, "--version"]);
check("typetorch --version", r.code === 0 && r.out.trim() === pkg.version, r.out.trim());
r = node([bin, "doctor", "--help"]);
check("typetorch doctor --help", r.code === 0 && r.out.includes("typetorch doctor"), `exit ${r.code}`);
r = node([bin, "help", "deploy"]);
check("typetorch help deploy", r.code === 0 && r.out.includes("typetorch deploy"), `exit ${r.code}`);
r = node([bin, "no-such-command"]);
check("unknown command exits 2", r.code === 2 && r.err.includes("unknown command"), `exit ${r.code}`);
// remote-claude runs @typetorch/dev-server's bin with the same arguments (a fake one here) and returns its exit code.
{
	const game = mkdtempSync(join(tmpdir(), "tt-smoke-rc-"));
	try {
		const pkgDir = join(game, "node_modules", "@typetorch", "dev-server");
		mkdirSync(join(pkgDir, "dist"), { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@typetorch/dev-server", bin: { "typetorch-dev-server": "dist/index.js" } }));
		writeFileSync(join(pkgDir, "dist", "index.js"), "console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n");
		// (The env file exists: Node itself exits 9 with "<file>: not found" for an --env-file argument naming a missing file,
		// even after the script name.)
		writeFileSync(join(game, "a b.env"), "");
		const args = ["--users", "1,2", "--env-file", "a b.env", "--help"];
		r = node([bin, "remote-claude", ...args], { cwd: game });
		check("remote-claude: runs the installed dev-server with the same arguments", r.code === 7 && r.out.trim() === JSON.stringify(["remote-claude", ...args]), `exit ${r.code}: ${r.out.trim()}`);
		r = node([bin, "remote-claude", "--users", "1"], { cwd: game, env: { ...process.env, TYPETORCH_DEV_SERVER: join(game, "missing.js") } });
		check("remote-claude: not installed -> a clear error, exit 1", r.code === 1 && r.err.includes("@typetorch/dev-server is not installed"), `exit ${r.code}`);
	} finally {
		rmSync(game, { recursive: true, force: true });
	}
}

// 2. runtime.ts as compiled.
const rt = await import(pathToFileURL(join(root, "dist", "runtime.js")).href);
check("runtime is node", rt.isBun === false && rt.runtimeName().startsWith("node v"), rt.runtimeName());
const git = rt.which("git");
check("which(git)", Boolean(git), git ?? "not found");
if (git) {
	const env = { ...process.env };
	const ran = await rt.captureAsync(["git", "--version"], { cwd: root, env });
	check("captureAsync(git --version)", ran.exitCode === 0 && /^git version /.test(ran.stdout), ran.stdout.trim());
	const sync = rt.captureSync(["git", "--version"], { cwd: root, env });
	check("captureSync(git --version)", sync.exitCode === 0 && sync.stdout === ran.stdout);
}
const missing = await rt.captureAsync(["typetorch-no-such-binary"], { cwd: root, env: { ...process.env } });
check("a missing executable gives exit 127", missing.exitCode === 127, missing.stderr.trim());
const hostile = ["a b", "c&echo INJECTED", 'x"y', "%PATH%", "^caret", "100%", "trail\\", "(paren)|pipe<lt>gt;"];
if (win) {
	const dir = mkdtempSync(join(tmpdir(), "tt-smoke-cmd-"));
	try {
		// An npm (cmd-shim) script: its JS target runs with node, no cmd.exe in between.
		mkdirSync(join(dir, "node_modules", "fake"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "fake", "cli.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
		writeFileSync(
			join(dir, "fake.cmd"),
			'@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\cli.js" %*\r\n',
		);
		const shim = await rt.captureAsync([join(dir, "fake.cmd"), ...hostile], { cwd: dir, env: { ...process.env } });
		let parsed;
		try {
			parsed = JSON.parse(shim.stdout);
		} catch {}
		check("npm .cmd shim: arguments arrive unchanged", JSON.stringify(parsed) === JSON.stringify(hostile), shim.stdout.trim() || shim.stderr.trim());
		// Any other .cmd script runs through cmd.exe with every argument quoted and escaped: nothing is injected.
		writeFileSync(join(dir, "plain.cmd"), "@echo off\r\necho ARGS %*\r\n");
		// (A double quote would unbalance the script's own parse of %*, so those arguments are refused below.)
		const plainArgs = hostile.filter((a) => !a.includes('"'));
		const plain = await rt.captureAsync([join(dir, "plain.cmd"), ...plainArgs], { cwd: dir, env: { ...process.env } });
		const expected = `ARGS ${plainArgs.map((a) => `"${a.replace(/(\\*)$/, "$1$1")}"`).join(" ")}`;
		check("plain .cmd: arguments arrive quoted, nothing injected", plain.exitCode === 0 && plain.stdout.trim() === expected, plain.stdout.trim());
		for (const bad of ['x"y', "two\nlines"]) {
			let refused = false;
			try {
				rt.resolveCommand([join(dir, "plain.cmd"), bad]);
			} catch {
				refused = true;
			}
			check(`plain .cmd: ${JSON.stringify(bad)} is refused`, refused);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const rbxm = await import(pathToFileURL(join(root, "dist", "rbxm.js")).href);
const tree = [
	{ className: "Model", name: "Payload", parent: -1, attributes: { ArtifactId: "smoke" } },
	{ className: "Folder", name: "Server", parent: 0 },
	{ className: "ModuleScript", name: "main", parent: 1 },
];
for (const compression of rt.hasZstd() ? ["lz4", "zstd", "none"] : ["lz4", "none"]) {
	const back = rbxm.readRbxm(rbxm.writeRbxm(tree, { compression }));
	check(`rbxm round trip (${compression})`, JSON.stringify(back.map((i) => [i.className, i.name, i.parent])) === JSON.stringify(tree.map((i) => [i.className, i.name, i.parent])));
}
if (!rt.hasZstd()) console.log(`note: ${rt.runtimeName()} has no zstd (Node 22.15+): hot-asset exports can't be read here`);

// 3. doctor in an empty folder with no keys (nothing is probed online without a key).
const doctorDir = mkdtempSync(join(tmpdir(), "tt-smoke-doctor-"));
try {
	const dotEnvAbove = [];
	for (let dir = doctorDir; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".env"))) dotEnvAbove.push(join(dir, ".env"));
		if (dirname(dir) === dir) break;
	}
	if (dotEnvAbove.length) console.log(`skip  doctor --json  (${dotEnvAbove.join(", ")} could hold keys)`);
	else {
		const keep = ["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"];
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k.toUpperCase())));
		r = node([bin, "doctor", "--json"], { cwd: doctorDir, env });
		let report;
		try {
			report = JSON.parse(r.out);
		} catch {}
		const runtime = report?.checks?.find((c) => c.name === "runtime");
		check("doctor --json (empty folder)", Boolean(runtime?.detail?.startsWith("node v")) && report.checks.some((c) => c.name === "git"), `exit ${r.code}, ${report?.checks?.length ?? 0} checks${r.err.trim() ? `, stderr: ${r.err.trim().slice(0, 200)}` : ""}`);
	}
} finally {
	rmSync(doctorDir, { recursive: true, force: true });
}

// 4. --pack: the packed file list and contents, then npx on the tarball.
if (process.argv.includes("--pack")) {
	const out = mkdtempSync(join(tmpdir(), "tt-smoke-pack-"));
	try {
		const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", out], { cwd: root, encoding: "utf8", shell: win, windowsHide: true });
		let info;
		try {
			info = JSON.parse(packed.stdout)[0];
		} catch {}
		check("npm pack", packed.status === 0 && Boolean(info?.filename), info ? `${info.filename}, ${info.files.length} files, ${info.size} bytes` : packed.stderr.trim().slice(-300));
		if (info) {
			const files = info.files.map((f) => f.path.replace(/\\/g, "/"));
			const allowed = (p) => p === "package.json" || p === "README.md" || p === "LICENSE" || /^dist\/[\w./-]+\.(js|d\.ts)$/.test(p);
			const bad = files.filter((p) => !allowed(p) || /(^|\/)(test|tests|fixtures?|test-fixture|\.typetorch|node_modules)(\/|$)|\.env|\.key$|CHANGELOG/i.test(p));
			check("packed files: dist + README + LICENSE + package.json only", bad.length === 0, bad.join(", "));
			const user = userInfo().username;
			const home = homedir();
			const hard = [
				{ what: "this machine's user name", re: new RegExp(`(^|[^a-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i") },
				{ what: "the home folder", re: new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\/g, "[\\\\/]+"), "i") },
				{ what: "a Windows user folder", re: /[A-Za-z]:[\\/]+Users[\\/]+(?!<|\{|\$|%|\*|\.\.\.)[\w.-]+/ },
				{ what: "a macOS/Linux user folder", re: /(?<![\w.])\/(?:Users|home)\/(?!<|\{|\$|\*|\.\.\.)[a-z][\w.-]+/ },
				{ what: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
				{ what: "an Anthropic/OpenAI-style key", re: /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{20,}/ },
				{ what: "a JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
				{ what: "a Roblox cookie", re: /_\|WARNING:-DO-NOT-SHARE-THIS/ },
			];
			const soft = /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;
			const findings = [];
			const review = [];
			for (const file of files) {
				const text = readFileSync(join(root, file), "utf8");
				for (const { what, re } of hard) if (re.test(text)) findings.push(`${file}: ${what} (${re.exec(text)[0].slice(0, 40)})`);
				for (const m of text.matchAll(soft)) review.push(`${file}: ${m[0].slice(0, 12)}… (${m[0].length} chars)`);
			}
			check("packed contents: no user name, local paths, keys or tokens", findings.length === 0, findings.join("; "));
			if (review.length) console.log(`note: ${review.length} long mixed-case token(s) to eyeball:\n  ${review.join("\n  ")}`);
			// npx on the tarball, in a folder of its own (no dependencies: works offline).
			const tarball = join(out, info.filename);
			const run = spawnSync("npx", ["--yes", "--offline", `./${info.filename}`, "--help"], { cwd: out, encoding: "utf8", shell: win, windowsHide: true });
			check("npx ./<tarball> --help", run.status === 0 && run.stdout.includes("usage: typetorch <command>"), `exit ${run.status}${run.status ? `: ${(run.stderr || run.stdout).trim().slice(-300)}` : ""}`);
			const version = spawnSync("npx", ["--yes", "--offline", `./${info.filename}`, "--version"], { cwd: out, encoding: "utf8", shell: win, windowsHide: true });
			check("npx ./<tarball> --version", version.status === 0 && version.stdout.trim() === pkg.version, version.stdout.trim());
			rmSync(tarball, { force: true });
		}
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
