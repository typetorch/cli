/**
 * End-to-end check against test-fixture/ (a minimal roblox-ts Model project): copies it to a temp git repo and runs
 * the real CLI there. Needs `bun install` in test-fixture/ and Rojo (via Rokit) on PATH. Never uploads or publishes:
 * deploy and rollback run with --dry-run.
 *   bun test/fixture.e2e.ts                       offline (example ids; registry not used)
 *   TT_E2E_CONFIG=path/to/typetorch.json bun test/fixture.e2e.ts
 *                                                 also reads the real registry (read-only) for that experience
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "..", "src", "index.ts");
const fixture = resolve(import.meta.dir, "..", "test-fixture");
if (!existsSync(join(fixture, "node_modules"))) throw new Error("run `bun install` in test-fixture/ first");

const dir = mkdtempSync(join(tmpdir(), "tt-e2e-"));
cpSync(fixture, dir, {
	recursive: true,
	filter: (src) => !/[\\/](node_modules|out|include|\.typetorch)([\\/]|$)/.test(src.slice(fixture.length)) && !src.endsWith("typetorch.json"),
});
symlinkSync(join(fixture, "node_modules"), join(dir, "node_modules"), "junction");
writeFileSync(join(dir, "typetorch.json"), readFileSync(process.env.TT_E2E_CONFIG ?? join(fixture, "typetorch.example.json")));
writeFileSync(join(dir, ".gitignore"), "node_modules/\nout/\ninclude/\n.typetorch/\nsrc/shared/build.ts\n");

function sh(cmd: string[]) {
	const result = Bun.spawnSync(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function tt(...args: string[]): { code: number; json?: any; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", cli, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString();
	let json;
	try {
		json = JSON.parse(stdout);
	} catch {}
	return { code: result.exitCode, json, stdout, stderr: result.stderr.toString() };
}

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	if (!ok) failures++;
}

function compiledBuild(): string {
	for (const ext of [".luau", ".lua"]) {
		const path = join(dir, "out", "shared", `build${ext}`);
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

// 1. Clean build on main -> prod branch, prod channel
let r = tt("build", "--json");
check("build (clean, main -> prod)", r.code === 0 && r.json?.artifactId === `prod-${c1}` && r.json?.dirty === false && r.json?.branch === "prod", r.stderr || r.json);
check("build.ts compiled with the commit", compiledBuild().includes(`"${c1}"`), compiledBuild());
check("tree still clean after the build", sh(["git", "status", "--porcelain"]) === "");

// 2. New commit, identical build.ts text: the compiled commit must still update (incremental staleness fix)
writeFileSync(join(dir, "src", "shared", "extra.ts"), "export const EXTRA = 1;\n");
sh(["git", "add", "-A"]);
sh(["git", "commit", "-m", "second"]);
const c2 = sh(["git", "rev-parse", "HEAD"]).slice(0, 7);
r = tt("build", "--json");
check("second commit rebuilds build.ts", r.code === 0 && r.json?.artifactId === `prod-${c2}` && compiledBuild().includes(`"${c2}"`), r.stderr || compiledBuild());

// 3. Feature branch -> dev channel, then dirty
sh(["git", "checkout", "-b", "feature/Thing"]);
r = tt("build", "--json");
check("feature/Thing -> feature-thing, dev", r.json?.branch === "feature-thing" && r.json?.channel === "dev" && r.json?.artifactId === `dev-${c2}`, r.stderr || r.json);
writeFileSync(join(dir, "src", "shared", "extra.ts"), "export const EXTRA = 2;\n");
r = tt("build", "--json");
check("dirty id", r.code === 0 && new RegExp(`^dev-${c2}-dirty-[0-9a-f]{6}$`).test(r.json?.artifactId) && r.json?.dirty === true, r.stderr || r.json);

// 4. deploy --dry-run without the registry
r = tt("deploy", "--dry-run", "--no-registry", "--no-build", "--json");
check(
	"deploy --dry-run plan",
	r.code === 0 &&
		r.json?.asset?.displayName === `tt-feature-thing-${c2}-dirty` &&
		r.json?.message?.data?.ch === "dev" &&
		r.json?.message?.data?.b === "feature-thing" &&
		r.json?.seq === 1 &&
		r.json?.asset?.description.includes(`commit=${sh(["git", "rev-parse", "HEAD"])}`),
	r.stderr || r.json,
);
r = tt("deploy", "--dry-run", "--no-registry", "--no-build", "--branch", "prod");
check("dirty dev artifact refused on prod", r.code === 1 && /refusing to deploy a dev-channel artifact and a dirty build/.test(r.stderr), r.stderr);
r = tt("deploy", "--dry-run", "--no-registry", "--no-build", "--branch", "prod", "--force", "--json");
check("--force overrides the channel guard", r.code === 0 && r.json?.branch === "prod", r.stderr);

// 5. Local-log fallback: deployments, branch ls, rollback --dry-run
const entries = [1, 2, 3].map((seq) => ({
	seq,
	at: `2026-10-04T12:00:0${seq}.000Z`,
	action: "deploy",
	branch: "feature-thing",
	channel: "dev",
	artifactId: `dev-000000${seq}`,
	assetId: 900000000 + seq,
	commit: `000000${seq}`,
	commitHash: `000000${seq}`.padEnd(40, "0"),
	dirty: false,
	by: "e2e",
	registry: "unavailable",
}));
writeFileSync(join(dir, ".typetorch", "deployments.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
r = tt("deployments", "--json");
check("deployments from the local log", r.code === 0 && r.json?.deployments?.length === 3 && r.json?.heads?.["feature-thing"]?.seq === 3, r.stderr || r.json);
r = tt("deployments");
check("deployments table", r.code === 0 && r.stdout.includes("* ") && r.stdout.includes("#3"), r.stdout + r.stderr);
console.log(r.stdout.trimEnd());
r = tt("branch", "ls", "--json");
check("branch ls", r.code === 0 && r.json?.branches?.find((b: any) => b.branch === "feature-thing")?.head?.artifactId === "dev-0000003", r.stderr || r.json);
r = tt("rollback", "--dry-run", "--no-registry", "--json");
check("rollback picks the previous artifact", r.code === 0 && r.json?.to?.artifactId === "dev-0000002" && r.json?.seq === 4 && r.json?.message?.data?.r === 1, r.stderr || r.json);
r = tt("rollback", "--dry-run", "--no-registry", "--to", "#1", "--json");
check("rollback --to #1", r.code === 0 && r.json?.to?.artifactId === "dev-0000001", r.stderr || r.json);
r = tt("rollback", "--dry-run", "--no-registry", "--to", "#3");
check("rollback to the live artifact is refused", r.code === 1 && /already live/.test(r.stderr), r.stderr);

// 6. With a real config: the registry read path (read-only) and its fallback
if (process.env.TT_E2E_CONFIG) {
	r = tt("deploy", "--dry-run", "--no-build", "--json");
	check("deploy --dry-run with registry read (or fallback)", r.code === 0 && typeof r.json?.registry?.readable === "boolean", r.stderr || r.json);
	console.log(`registry: ${JSON.stringify(r.json?.registry)}\nstderr: ${r.stderr.trim()}`);
}

console.log(failures ? `${failures} failure(s) (${dir})` : `all e2e checks passed (${dir})`);
process.exit(failures ? 1 : 0);
