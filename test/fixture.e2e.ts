/**
 * End-to-end check against test-fixture/ (a minimal roblox-ts Model project): copies it to a temp git repo and runs
 * the real CLI there. Needs `bun install` in test-fixture/, and Rojo + Lune (via Rokit) on PATH. Never uploads or
 * publishes: deploy, rollback, promote and kernel deploy run with --dry-run, and the CLI gets no API key.
 *   bun test/fixture.e2e.ts
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ASSETS_LOCK_FILE, assetsAttribute, formatAssetsLock, stampExport, type AssetsLock } from "../src/assets";
import { newKeyFile, writeKeyFile } from "../src/keyfiles";
import { readRbxm } from "../src/rbxm";

const cli = resolve(import.meta.dir, "..", "src", "index.ts");
const fixture = resolve(import.meta.dir, "..", "test-fixture");
const kernelSource = resolve(import.meta.dir, "..", "..", "kernel");
if (!existsSync(join(fixture, "node_modules"))) throw new Error("run `bun install` in test-fixture/ first");

const dir = mkdtempSync(join(tmpdir(), "tt-e2e-"));
cpSync(fixture, dir, {
	recursive: true,
	filter: (src) => !/[\\/](node_modules|out|include|\.typetorch)([\\/]|$)/.test(src.slice(fixture.length)) && !src.endsWith("typetorch.json"),
});
symlinkSync(join(fixture, "node_modules"), join(dir, "node_modules"), "junction");
writeFileSync(join(dir, "typetorch.json"), readFileSync(join(fixture, "typetorch.example.json")));
writeFileSync(join(dir, ".gitignore"), "node_modules/\nout/\ninclude/\n.typetorch/\nsrc/shared/build.ts\nsrc/local-secret.ts\n.env\n");

// The CLI runs without any key from this process's environment, and with a throwaway home: the default key paths
// (~/.config/typetorch/keys) point into a temp dir, never at the real ones. Rokit keeps finding its tools.
const cleanEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (value !== undefined && !/(_KEY|TOKEN|SECRET|^TYPETORCH_)/i.test(key)) cleanEnv[key] = value;
}
const realHome = process.env.USERPROFILE ?? process.env.HOME ?? "";
cleanEnv.ROKIT_ROOT ??= join(realHome, ".rokit");
const fakeHome = mkdtempSync(join(tmpdir(), "tt-e2e-home-"));
cleanEnv.HOME = fakeHome;
cleanEnv.USERPROFILE = fakeHome;

function sh(cmd: string[], cwd = dir) {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function tt(args: string[], env: Record<string, string> = {}): { code: number; json?: any; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", cli, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...cleanEnv, ...env } });
	const stdout = result.stdout.toString();
	let json;
	try {
		json = JSON.parse(stdout);
	} catch {}
	return { code: result.exitCode, json, stdout, stderr: result.stderr.toString() };
}

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${typeof detail === "string" ? detail.slice(0, 3000) : JSON.stringify(detail)?.slice(0, 3000)}`}`);
	if (!ok) failures++;
}

function compiled(file: string): string {
	for (const ext of [".luau", ".lua"]) {
		const path = join(dir, "out", "shared", `${file}${ext}`);
		if (existsSync(path)) return readFileSync(path, "utf8");
	}
	return "";
}

sh(["git", "init", "-b", "main"]);
sh(["git", "config", "user.name", "e2e"]);
sh(["git", "config", "user.email", "e2e@example.invalid"]);
sh(["git", "add", "-A"]);
sh(["git", "commit", "-m", "fixture"]);
const c1 = sh(["git", "rev-parse", "HEAD"]).slice(0, 7);
const hashId = (commit: string, dirty = false) => new RegExp(`^${commit}${dirty ? "-dirty" : ""}-[0-9a-f]{6}$`);

// 1. Clean build on main -> prod branch, prod channel: hash id, debug macros compiled away
let r = tt(["build", "--json"]);
check("build (clean, main -> prod): <commit7>-<hash6>", r.code === 0 && hashId(c1).test(r.json?.artifactId) && r.json?.dirty === false && r.json?.branch === "prod" && r.json?.channel === "prod", r.stderr || r.json);
check("build.ts compiled with the commit", compiled("build").includes(`"${c1}"`), compiled("build"));
check("prod: $print/$warn and source paths compiled away", !compiled("describe").includes("fixture-debug-print") && !compiled("describe").includes("src/shared") && compiled("describe").includes("fixture-assert-message"), compiled("describe"));
check("sources recorded", r.json?.sources?.template === c1 && r.json?.debugMacros === false, r.json);
check("tree still clean after the build (generated tsconfig removed)", sh(["git", "status", "--porcelain"]) === "" && !existsSync(join(dir, ".tsconfig.typetorch.json")), sh(["git", "status", "--porcelain"]));
const prodId = r.json?.artifactId;
r = tt(["build", "--json"]);
check("rebuild of the same commit: different bytes (BuiltAt), different id, no .rN", r.code === 0 && hashId(c1).test(r.json?.artifactId) && r.json?.artifactId !== prodId, r.json);

// 2. New commit: the compiled commit must update (incremental staleness fix)
writeFileSync(join(dir, "src", "shared", "extra.ts"), "export const EXTRA = 1;\n");
sh(["git", "add", "-A"]);
sh(["git", "commit", "-m", "second change"]);
const c2 = sh(["git", "rev-parse", "HEAD"]).slice(0, 7);
r = tt(["build", "--json"]);
check("second commit rebuilds build.ts", r.code === 0 && hashId(c2).test(r.json?.artifactId) && compiled("build").includes(`"${c2}"`), r.stderr || compiled("build"));

// 3. Feature branch -> dev channel: macros kept (incremental build after a prod build), then dirty
sh(["git", "checkout", "-b", "feature/Thing"]);
r = tt(["build", "--json"]);
check("feature/Thing -> feature-thing, dev, hash id", r.json?.branch === "feature-thing" && r.json?.channel === "dev" && hashId(c2).test(r.json?.artifactId), r.stderr || r.json);
check("dev: $print keeps its source prefix", compiled("describe").includes("fixture-debug-print") && compiled("describe").includes("src/shared/describe.ts"), compiled("describe"));
writeFileSync(join(dir, "src", "shared", "extra.ts"), "export const EXTRA = 2;\n");
r = tt(["build", "--json"]);
check("dirty id", r.code === 0 && hashId(c2, true).test(r.json?.artifactId) && r.json?.dirty === true, r.stderr || r.json);
const dirtyId = r.json?.artifactId;

// 4. deploy --dry-run without the registry (no key: nothing leaves the machine)
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--json", "--message", "make coins spin"]);
check(
	"deploy --dry-run plan",
	r.code === 0 &&
		r.json?.asset?.displayName === `tt-feature-thing-${dirtyId}` &&
		r.json?.message?.data?.ch === "dev" &&
		r.json?.message?.data?.b === "feature-thing" &&
		r.json?.message?.data?.i === dirtyId &&
		r.json?.seq === 1 &&
		Object.keys(r.json?.message?.data ?? {}).join() === "b,a,i,s,c,ch,t" &&
		r.json?.asset?.description === `artifact=${dirtyId}\ncommit=${c2}`,
	r.stderr || r.json,
);
check(
	"notes: the message and what changed",
	r.json?.notes?.message === "make coins spin" && r.json?.notes?.changes?.join("|") === "first deploy of feature-thing|template: uncommitted changes",
	r.json?.notes,
);
check("without a terminal, approval \"all\" only proposes", r.json?.approval?.policy === "all" && r.json?.approval?.ending === "propose", r.json?.approval);
const root = readRbxm(new Uint8Array(readFileSync(join(dir, ".typetorch", "payload.rbxm")))).find((i) => i.className === "Model");
const notes = JSON.parse(String(root?.attributes?.Notes ?? "{}"));
check(
	"Notes attribute on the payload root",
	notes.v === 1 && notes.branch === "feature-thing" && notes.changes?.[0] === "first deploy of feature-thing" && notes.sources?.template === `${c2}*` && Object.keys(notes).join() === "v,message,changes,sources,built,branch",
	root?.attributes,
);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--branch", "prod"]);
check("dirty dev artifact refused on prod", r.code === 1 && /refusing to deploy a dev-channel artifact and a dirty build/.test(r.stderr), r.stderr);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--branch", "prod", "--force", "--json"]);
check("--force overrides the channel guard", r.code === 0 && r.json?.branch === "prod", r.stderr);

// 5. Local-log fallback: deployments, branch ls, rollback --dry-run, with old and new ids
const entries = [1, 2, 3].map((seq) => ({
	seq,
	at: `2026-10-04T12:00:0${seq}.000Z`,
	action: "deploy",
	branch: "feature-thing",
	channel: "dev",
	artifactId: seq === 3 ? `${c2}-00000${seq}` : `dev-000000${seq}`, // old (legacy) and new ids side by side
	assetId: 900000000 + seq,
	commit: `000000${seq}`,
	commitHash: `000000${seq}`.padEnd(40, "0"),
	dirty: false,
	by: "e2e",
	registry: "unavailable",
}));
writeFileSync(join(dir, ".typetorch", "deployments.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
r = tt(["deployments", "--json"]);
check("deployments from the local log", r.code === 0 && r.json?.deployments?.length === 3 && r.json?.heads?.["feature-thing"]?.seq === 3, r.stderr || r.json);
r = tt(["deployments"]);
check("deployments table", r.code === 0 && r.stdout.includes("* ") && r.stdout.includes("#3"), r.stdout + r.stderr);
console.log(r.stdout.trimEnd());
r = tt(["branch", "ls", "--json"]);
check("branch ls", r.code === 0 && r.json?.branches?.find((b: any) => b.branch === "feature-thing")?.head?.artifactId === `${c2}-000003`, r.stderr || r.json);
r = tt(["rollback", "--dry-run", "--no-registry", "--json"]);
check("rollback picks the previous artifact (a legacy id)", r.code === 0 && r.json?.to?.artifactId === "dev-0000002" && r.json?.seq === 4 && r.json?.message?.data?.r === 1, r.stderr || r.json);
r = tt(["rollback", "--dry-run", "--no-registry", "--to", "dev-0000001", "--json"]);
check("rollback --to a legacy id", r.code === 0 && r.json?.to?.artifactId === "dev-0000001" && r.json?.message?.data?.a === 900000001, r.stderr || r.json);
r = tt(["rollback", "--dry-run", "--no-registry", "--to", "#3"]);
check("rollback to the live artifact is refused", r.code === 1 && /already live/.test(r.stderr), r.stderr);

// 6. TYPETORCH_STATE_DIR: the log lives where the env says (the dev-server's worktree deploys share the main repo's)
const shared = mkdtempSync(join(tmpdir(), "tt-e2e-state-"));
writeFileSync(join(shared, "deployments.jsonl"), JSON.stringify({ ...entries[0], seq: 41 }) + "\n");
r = tt(["deployments", "--json"], { TYPETORCH_STATE_DIR: shared });
check("TYPETORCH_STATE_DIR is the log", r.code === 0 && r.json?.deployments?.length === 1 && r.json?.deployments[0].seq === 41 && r.json?.stateDir === shared, r.stderr || r.json);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--json"], { TYPETORCH_STATE_DIR: shared });
check("...and the next seq comes from it", r.code === 0 && r.json?.seq === 42, r.stderr || r.json);

// 7. promote: from the deployments, and from an upload that never went out
r = tt(["promote", "dev", `${c2}-000003`, "--dry-run", "--no-registry", "--json"]);
check("promote an earlier artifact to another branch (new seq, same id)", r.code === 0 && r.json?.to?.artifactId === `${c2}-000003` && r.json?.seq === 4 && r.json?.message?.data?.b === "dev" && r.json?.message?.data?.r === undefined, r.stderr || r.json);
appendFileSync(
	join(dir, ".typetorch", "uploads.jsonl"),
	JSON.stringify({ event: "uploaded", at: "2026-10-04T13:00:00.000Z", artifactId: `${c2}-abcdef`, assetId: 123456789012, moderation: "Approved", branch: "feature-thing", channel: "dev", commit: c2, commitHash: c2.padEnd(40, "0"), dirty: false, sha256: "a".repeat(64) }) + "\n",
);
r = tt(["deployments"]);
check("an unpublished upload is listed with its promote command", r.code === 0 && r.stdout.includes(`typetorch promote feature-thing 123456789012`), r.stdout);
r = tt(["promote", "feature-thing", "123456789012", "--dry-run", "--no-registry", "--json"]);
check("promote an upload by asset id", r.code === 0 && r.json?.to?.artifactId === `${c2}-abcdef` && r.json?.message?.data?.a === 123456789012, r.stderr || r.json);

// 8. Approval: proposals without a terminal, approve refuses, reject; signing is gone
r = tt(["rollback", "--no-registry", "--proposed-by", "dev-server/claude", "--json"]);
const proposalId: string = r.json?.proposal?.id ?? "";
check(
	"rollback without a terminal writes a proposal and publishes nothing (no key needed)",
	r.code === 0 && /^[0-9a-f]{8}$/.test(proposalId) && r.json?.proposal?.kind === "rollback" && r.json?.proposal?.proposedBy === "dev-server/claude" && r.json?.approve === `typetorch approve ${proposalId}`,
	r.stderr || r.json,
);
r = tt(["proposals", "--json"]);
check("proposals lists it as pending", r.code === 0 && r.json?.proposals?.[0]?.proposal?.id === proposalId && r.json?.proposals?.[0]?.status === "pending", r.stderr || r.json);
r = tt(["approve", proposalId]);
check("approve refuses without an interactive terminal", r.code !== 0 && /interactive terminal/.test(r.stderr), r.stderr);
r = tt(["reject", proposalId, "--reason", "e2e"]);
r = tt(["proposals", "--all", "--json"]);
check("reject", r.json?.proposals?.find((p: any) => p.proposal.id === proposalId)?.status === "rejected", r.json);
r = tt(["keys", "status"]);
check("keys status is gone (keys init / init --fallback / rotate)", r.code === 2 && /unknown keys subcommand "status"/.test(r.stderr), r.stderr);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--json", "--propose"]);
check("--propose: the dry run says it would only propose", r.code === 0 && r.json?.approval?.ending === "propose", r.stderr || r.json);
writeFileSync(join(dir, "typetorch.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "typetorch.json"), "utf8")), approval: "none", signingPublicKey: "old" }, null, "\t"));
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--json"]);
check("approval none: publishes at once; an old signingPublicKey is ignored silently", r.code === 0 && r.json?.approval?.ending === "publish" && !/signingPublicKey|unknown key/.test(r.stderr), r.stderr || r.json);
sh(["git", "checkout", "--", "typetorch.json"]);

// 8b. Prod signing (plans/03): throwaway keys in a temp dir only; nothing is uploaded or published.
const keyDir = mkdtempSync(join(tmpdir(), "tt-e2e-keys-"));
const mainKey = join(keyDir, "main.key");
const fallbackKey = join(keyDir, "fallback.key");
r = tt(["keys", "init", "--key-file", mainKey]);
check("keys init without an assets key writes nothing", r.code === 1 && /no Open Cloud API key for assets/.test(r.stderr) && !existsSync(mainKey), r.stderr);
r = tt(["keys", "init", "--key-file", join(dir, "keys", "main.key")]);
check("a key file inside the repo is refused", r.code === 1 && /outside the repo/.test(r.stderr), r.stderr);
r = tt(["keys", "rotate", "--yes", "--key-file", mainKey]);
check("keys rotate needs keys init first", r.code === 2 && /keys init/.test(r.stderr), r.stderr);
r = tt(["keys", "init", "--fallback", "--fallback-key-file", fallbackKey, "--json"]);
const fallbackPublic = r.json?.publicKey;
check(
	"keys init --fallback: key file + fallbackPublicKey, no network, no seed printed",
	r.code === 0 && r.json?.status === "created" && JSON.parse(readFileSync(join(dir, "typetorch.json"), "utf8")).fallbackPublicKey === fallbackPublic &&
		!(r.stdout + r.stderr).includes(JSON.parse(readFileSync(fallbackKey, "utf8")).seed),
	r.stderr || r.json,
);
// A main key as `keys init` would leave it (its key asset needs Open Cloud, so it is written here directly).
const main = newKeyFile("main", JSON.parse(readFileSync(join(dir, "typetorch.json"), "utf8")).universeId);
writeKeyFile(mainKey, main);
writeFileSync(join(dir, "typetorch.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "typetorch.json"), "utf8")), signingPublicKeys: [main.publicKey], keyAssetId: 987654321 }, null, "\t"));
const keyFlags = ["--key-file", mainKey, "--fallback-key-file", fallbackKey];
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--branch", "prod", "--force", "--json", ...keyFlags]);
check(
	"prod dry run: signing ready (both keys), placeholders instead of real signatures",
	r.code === 0 && r.json?.signing?.ready === true && r.json?.signing?.mainKey === main.publicKey && r.json?.signing?.fallbackKey === fallbackPublic && /^<signature/.test(r.json?.message?.data?.sig) && /^<signature/.test(r.json?.message?.data?.sigF),
	r.stderr || r.json,
);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--branch", "prod", "--force", "--json", "--key-file", join(keyDir, "missing.key")]);
check("prod dry run with a missing key file: reported as not ready", r.code === 0 && r.json?.signing?.ready === false && /no main key file/.test(r.json?.signing?.problem), r.stderr || r.json);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--json", ...keyFlags]);
check("dev dry run: unsigned", r.code === 0 && r.json?.signing?.required === false && r.json?.message?.data?.sig === undefined, r.stderr || r.json);
r = tt(["promote", "prod", `${c2}-000003`, "--dry-run", "--no-registry", "--force"]);
check("promote of a dev-channel artifact to prod: rebuild for prod, even with --force", r.code === 1 && /rebuild for prod/.test(r.stderr), r.stderr);
r = tt(["promote", "dev-0000001", "feature-thing", "--dry-run", "--no-registry", "--json"]);
check("promote <artifact> <branch> order (the second is a known branch)", r.code === 0 && r.json?.branch === "feature-thing" && r.json?.to?.artifactId === "dev-0000001", r.stderr || r.json);
sh(["git", "checkout", "--", "typetorch.json"]);

// 9. Clean builds: ignored source files and non-ModuleScripts are refused
sh(["git", "checkout", "--", "."]);
writeFileSync(join(dir, "src", "local-secret.ts"), "export const SECRET = 1;\n");
r = tt(["build", "--json"]);
check("an ignored file in src/ blocks a clean build", r.code === 1 && /git-ignored files/.test(r.stderr) && r.stderr.includes("src/local-secret.ts"), r.stderr);
rmSync(join(dir, "src", "local-secret.ts"));
writeFileSync(join(dir, "src", "server", "evil.server.ts"), 'print("runs by itself");\nexport {};\n');
r = tt(["build", "--json"]);
check("a Script in the payload is refused (S-L4)", r.code === 1 && /only Folders and ModuleScripts/.test(r.stderr) && /evil \(Script\)/.test(r.stderr), r.stderr);
rmSync(join(dir, "src", "server", "evil.server.ts"));
mkdirSync(join(dir, "out", "server"), { recursive: true });
writeFileSync(join(dir, "out", "server", "stray.luau"), "return nil\n");
r = tt(["build", "--clean", "--json"]);
check("build --clean removes stray outputs and builds clean", r.code === 0 && r.json?.dirty === false && !existsSync(join(dir, "out", "server", "stray.luau")), r.stderr || r.json);

// 10. kernel deploy: lune check, version + hash, --dry-run, --replace-place needs --yes
const kernel = mkdtempSync(join(tmpdir(), "tt-e2e-kernel-"));
mkdirSync(join(kernel, "src", "shared"), { recursive: true });
mkdirSync(join(kernel, "src", "server"), { recursive: true });
mkdirSync(join(kernel, "scripts"), { recursive: true });
cpSync(join(kernelSource, "scripts", "check.luau"), join(kernel, "scripts", "check.luau"));
cpSync(join(kernelSource, "rokit.toml"), join(kernel, "rokit.toml"));
writeFileSync(join(kernel, "package.json"), JSON.stringify({ name: "@typetorch/kernel", version: "9.9.9", typetorch: { kernelApi: 1 } }));
writeFileSync(join(kernel, "src", "shared", "Constants.luau"), 'return {\n\tKERNEL_API = 1,\n\tKERNEL_VERSION = "9.9.9",\n}\n');
writeFileSync(join(kernel, "src", "server", "Kernel.server.luau"), "print('kernel')\n");
writeFileSync(
	join(kernel, "place.project.json"),
	JSON.stringify({ name: "P", tree: { $className: "DataModel", ServerScriptService: { $className: "ServerScriptService", TypeTorchKernel: { $className: "Folder", Kernel: { $path: "src/server/Kernel.server.luau" } } } } }),
);
r = tt(["kernel", "deploy", "--kernel", kernel, "--dry-run", "--json"]);
check("kernel deploy --dry-run: check, version, hash, build; patch mode not built yet", r.code === 0 && r.json?.kernel?.version === "9.9.9" && /^[0-9a-f]{64}$/.test(r.json?.kernel?.hash) && r.json?.mode === "patch (not implemented)", r.stderr || r.json);
check("kernel deploy stamps BootstrapHeads (the prod-channel heads known here) and reports the missing keys", typeof r.json?.bootstrapHeads === "object" && /BootstrapHeads/.test(r.stderr) && /no "keyAssetId"/.test(r.stderr), r.stderr || r.json);
check("the check ran (lune)", /files, 0 failed/.test(r.stderr), r.stderr);
r = tt(["kernel", "deploy", "--kernel", kernel, "--replace-place", "--dry-run", "--json"]);
check("--replace-place --dry-run warns that it wipes Studio content", r.code === 0 && r.json?.mode === "replace-place" && /WIPES|wiped/i.test(r.stderr), r.stderr || r.json);
r = tt(["kernel", "deploy", "--kernel", kernel, "--replace-place"]);
check("--replace-place without --yes refuses", r.code === 2 && /without --yes/.test(r.stderr), r.stderr);
r = tt(["kernel", "deploy", "--kernel", kernel]);
check("without --replace-place nothing can be published yet", r.code === 2 && /not implemented/.test(r.stderr), r.stderr);
writeFileSync(join(kernel, "src", "server", "Broken.luau"), "local x = = 1\n");
r = tt(["kernel", "deploy", "--kernel", kernel, "--dry-run"]);
check("a Luau syntax error stops the kernel deploy first", r.code === 1 && /kernel check failed/.test(r.stderr), r.stderr);
rmSync(join(kernel, "src", "server", "Broken.luau"));
writeFileSync(join(kernel, "package.json"), JSON.stringify({ name: "@typetorch/kernel", version: "9.9.8" }));
r = tt(["kernel", "deploy", "--kernel", kernel, "--dry-run"]);
check("a version mismatch stops the kernel deploy", r.code === 1 && /9.9.8 != Constants.luau KERNEL_VERSION 9.9.9/.test(r.stderr), r.stderr);

// 11. Hot assets (plans/13): the lockfile rides the payload as the Assets attribute, on the root Model and on its
// Server folder (the kernel drops the root; the framework reads Server)
const payloadInstances = () => readRbxm(new Uint8Array(readFileSync(join(dir, ".typetorch", "payload.rbxm"))));
const payloadRoot = () => payloadInstances().find((i) => i.className === "Model");
const payloadServer = () => {
	const all = payloadInstances();
	const model = all.find((i) => i.className === "Model");
	return all.find((i) => i.name === "Server" && i.parent === model?.referent);
};
r = tt(["build", "--json"]);
check(
	'no typetorch.assets.lock.json: Assets = {"v":1,"assets":{}} on the root and on Server',
	r.code === 0 && payloadRoot()?.attributes?.Assets === '{"v":1,"assets":{}}' && payloadServer()?.attributes?.Assets === '{"v":1,"assets":{}}' && r.json?.assets?.count === 0 && r.json?.assets?.placeVersion === undefined,
	r.stderr || { root: payloadRoot()?.attributes, server: payloadServer()?.attributes },
);
const assetsLock: AssetsLock = {
	v: 1,
	placeVersion: 57,
	assets: {
		"ui/shop": { id: 123456789012, ver: 44838191841145, n: 4, hash: "abc123def456", realm: "replicated", path: "ReplicatedStorage/Assets/UI", className: "ScreenGui" },
		"props/crate": { id: 123456789013, ver: 44838191841146, n: 2, hash: "0123456789ab", realm: "server", path: "ServerStorage/Props", className: "Model" },
	},
};
writeFileSync(join(dir, ASSETS_LOCK_FILE), formatAssetsLock(assetsLock));
r = tt(["build", "--json"]);
const stampedAssets = JSON.parse(String(payloadRoot()?.attributes?.Assets ?? "null"));
check(
	"Assets on the payload root = the lockfile with placeVersion (numbers stay numbers)",
	r.code === 0 && JSON.stringify(stampedAssets) === assetsAttribute(assetsLock) && stampedAssets?.v === 1 && stampedAssets?.placeVersion === 57 &&
		stampedAssets?.assets?.["ui/shop"]?.ver === 44838191841145 && stampedAssets?.assets?.["ui/shop"]?.id === 123456789012 &&
		Object.keys(stampedAssets?.assets ?? {}).join() === "props/crate,ui/shop" && r.json?.assets?.count === 2 && r.json?.assets?.placeVersion === 57 &&
		typeof payloadRoot()?.attributes?.Notes === "string",
	r.stderr || payloadRoot()?.attributes,
);
check("...and the same Assets on the payload's Server folder", payloadServer()?.className === "Folder" && payloadServer()?.attributes?.Assets === assetsAttribute(assetsLock), payloadServer());
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build", "--json"]);
check("deploy --dry-run shows the hot assets", r.code === 0 && r.json?.assets?.count === 2 && r.json?.assets?.placeVersion === 57, r.stderr || r.json);
r = tt(["deploy", "--dry-run", "--no-registry", "--no-build"]);
check("...also in its human output", r.code === 0 && /assets\s+2 hot asset\(s\) from place v57/.test(r.stdout), r.stdout + r.stderr);
r = tt(["assets", "list", "--json"]);
check("assets list reads the lockfile", r.code === 0 && r.json?.exists === true && r.json?.assets?.["ui/shop"]?.id === 123456789012, r.stderr || r.json);
r = tt(["assets", "status"]);
check("assets status without a key: refused before any network, naming the scopes", r.code === 1 && /no Open Cloud API key for assets/.test(r.stderr) && /luau-execution-session/.test(r.stderr), r.stderr);
writeFileSync(join(dir, ASSETS_LOCK_FILE), "{ broken");
r = tt(["build", "--json"]);
check("an invalid lockfile stops the build", r.code === 1 && /typetorch\.assets\.lock\.json is not valid JSON/.test(r.stderr), r.stderr);
rmSync(join(dir, ASSETS_LOCK_FILE));
// A stamped export (TypeTorchAssetId + TypeTorchAssetHash on the root) reads back in Lune's rbx_binary (rbx-dom).
writeFileSync(join(kernel, "stamped.rbxm"), stampExport(new Uint8Array(readFileSync(join(dir, ".typetorch", "payload.rbxm"))), 123456789012345, "abc123def456"));
writeFileSync(
	join(kernel, "read-stamped.luau"),
	`local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local root = roblox.deserializeModel(fs.readFile("stamped.rbxm"))[1]
print(root.Name, root:GetAttribute("TypeTorchAssetId"), root:GetAttribute("TypeTorchAssetHash"), #root:GetDescendants(), typeof(root:GetAttribute("Notes")))
`,
);
const lune = Bun.spawnSync(["lune", "run", "read-stamped.luau"], { cwd: kernel, stdout: "pipe", stderr: "pipe", env: cleanEnv });
const luneOut = lune.stdout.toString().trim();
check("Lune reads the stamped export: id, hash, and everything else intact", lune.exitCode === 0 && /^TypeTorchPayload\s+123456789012345\s+abc123def456\s+\d+\s+string$/.test(luneOut), luneOut + lune.stderr.toString());

console.log(failures ? `${failures} failure(s) (${dir})` : `all e2e checks passed (${dir})`);
process.exit(failures ? 1 : 0);
