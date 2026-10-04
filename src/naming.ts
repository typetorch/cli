/**
 * Git-based identity (plans/03 "Identity and hashing", plans/04 "Git identity on everything uploaded").
 * Pure functions only, so they are unit-tested.
 */

export type Channel = "prod" | "dev";
export const CHANNELS: readonly Channel[] = ["prod", "dev"];

export function isChannel(value: unknown): value is Channel {
	return value === "prod" || value === "dev";
}

/** TypeTorch branch names: lowercase, digits, `.`, `_`, `-`; start with a letter or digit; at most 64 chars. */
export const BRANCH_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function branchNameError(name: string): string | undefined {
	if (BRANCH_PATTERN.test(name)) return undefined;
	return `"${name}" is not a valid TypeTorch branch name (lowercase letters, digits, ".", "_", "-"; at most 64 chars)`;
}

/**
 * The TypeTorch branch for a git branch: the `branches` mapping in typetorch.json if it has one, otherwise the git
 * branch lowercased with `/` turned into `-` (feature/Login → feature-login).
 */
export function branchFromGit(gitBranch: string, mapping: Record<string, string> = {}): string {
	const mapped = mapping[gitBranch];
	if (mapped !== undefined) return mapped;
	return gitBranch.toLowerCase().replace(/\//g, "-");
}

export interface ChannelConfig {
	defaultBranch: string;
	channels: Record<string, Channel>;
}

/** The channel a branch has by configuration: `channels[branch]`, else prod for the default branch, else dev. */
export function branchChannel(config: ChannelConfig, branch: string): Channel {
	return config.channels[branch] ?? (branch === config.defaultBranch ? "prod" : "dev");
}

/** The stricter of two channels (prod wins). */
export function strictest(...channels: (Channel | undefined)[]): Channel {
	return channels.includes("prod") ? "prod" : "dev";
}

/**
 * Artifact ids (plans/03 "How to read an artifact id"):
 *   <commit7>-<hash6>          a clean build, e.g. 12b63b9-3fa91c
 *   <commit7>-dirty-<hash6>    a build from a working tree with uncommitted changes (local only)
 *   uncommitted-dirty-<hash6>  a repo without commits
 * commit7 = the first 7 hex of the game repo's HEAD (what `$git("Commit")` compiles in). hash6 = the first 6 hex of
 * the SHA-256 of the payload built with ArtifactId = the id without its hash (`<commit7>` or `<commit7>-dirty`), so
 * the same bytes always give the same id and different bytes a different one. The channel is not part of the id (it is
 * metadata: one artifact can be promoted from dev to prod and keeps its id). Ids use only [a-z0-9-].
 * Older ids (`<channel>-<commit>[.r<N>]`, `<channel>-<commit>-dirty-<sha6>`, `asset-<assetId>`) are still read.
 */
export function artifactId(input: { commit: string; dirty: boolean; sha256: string }): string {
	if (!/^[0-9a-f]{6,}$/.test(input.sha256)) throw new Error("an artifact id needs the payload sha256 (hex)");
	return `${provisionalArtifactId(input)}-${input.sha256.slice(0, 6)}`;
}

/** The id stamped into the payload whose hash completes the id: `<commit7>` or `<commit7>-dirty`. */
export function provisionalArtifactId(input: { commit: string; dirty: boolean }): string {
	const commit = input.commit || "uncommitted";
	return input.dirty || !input.commit ? `${commit}-dirty` : commit;
}

export interface ParsedArtifactId {
	/** "hash": the current scheme; "legacy": <channel>-<commit>...; "asset": asset-<id>; "unknown": anything else. */
	format: "hash" | "legacy" | "asset" | "unknown";
	commit?: string;
	dirty?: boolean;
	hash?: string;
	/** Legacy ids only. */
	channel?: Channel;
	/** Legacy `.r<N>` suffix. */
	revision?: number;
	assetId?: number;
}

const HASH_ID = /^([0-9a-f]{7}|uncommitted)(-dirty)?-([0-9a-f]{6})$/;
const LEGACY_ID = /^(prod|dev)-([0-9a-f]{4,40}|uncommitted)(?:-dirty-([0-9a-f]{6}))?(?:\.r([1-9]\d{0,5}))?$/;

/** Reads any artifact id the CLI ever wrote (history keeps old ones). */
export function parseArtifactId(id: string): ParsedArtifactId {
	let m = HASH_ID.exec(id);
	if (m) return { format: "hash", commit: m[1] === "uncommitted" ? "" : m[1], dirty: m[2] !== undefined, hash: m[3] };
	m = LEGACY_ID.exec(id);
	if (m) {
		return {
			format: "legacy",
			channel: m[1] as Channel,
			commit: m[2] === "uncommitted" ? "" : m[2],
			dirty: m[3] !== undefined,
			hash: m[3],
			revision: m[4] ? Number(m[4]) : undefined,
		};
	}
	m = /^asset-(\d+)$/.exec(id);
	if (m) return { format: "asset", assetId: Number(m[1]) };
	return { format: "unknown" };
}

/** An artifact known from the deployment history; `sha256` is absent on entries logged before it was recorded. */
export interface EarlierArtifact {
	artifactId: string;
	sha256?: string;
}

/**
 * How the earlier artifacts named `artifactId` compare with a payload hashing to `sha256`: "new" (none), "same" (all
 * have these exact bytes) or "different" (any has other bytes, or no recorded sha256: unknown counts as different).
 */
export function compareEarlier(artifactId: string, sha256: string, earlier: EarlierArtifact[]): "new" | "same" | "different" {
	const matches = earlier.filter((e) => e.artifactId === artifactId);
	if (matches.length === 0) return "new";
	return matches.every((e) => e.sha256 === sha256) ? "same" : "different";
}

export const ASSET_NAME_MAX = 50;

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Asset display name: `tt-<branch>-<artifactId>[-<channel>]`, only [a-z0-9-], at most 50 chars. The channel is
 * appended only when it differs from the one the branch implies (a `--channel` override). The branch part is shortened
 * when needed so the artifact id always survives. Roblox's text filter still censors some names (deploy renames them).
 */
export function assetDisplayName(input: { branch: string; artifactId: string; channel: Channel; impliedChannel: Channel }): string {
	const suffix = [slug(input.artifactId) || "unknown", input.channel !== input.impliedChannel ? input.channel : undefined]
		.filter(Boolean)
		.join("-");
	const budget = ASSET_NAME_MAX - "tt-".length - 1 - suffix.length;
	const branch = slug(input.branch).slice(0, Math.max(0, budget)).replace(/-+$/, "");
	return (branch ? `tt-${branch}-${suffix}` : `tt-${suffix}`).slice(0, ASSET_NAME_MAX);
}

/**
 * Where the code in a payload came from: the game repo's commit (`template`) and the @typetorch packages it was built
 * with. Each is `<commit7>`, `<commit7>*` (a dirty working tree), or `v<version>` (an npm release), when known.
 */
export interface BuildSources {
	template: string;
	framework?: string;
	kernel?: string;
}

export const SOURCE_NAMES = ["template", "framework", "kernel"] as const;

/** Written by template/scripts/packages.ts when it packs the local @typetorch packages. */
export const PACKAGES_MANIFEST = ".typetorch/packages/manifest.json";

/** `template 12b63b9, framework 9a6547f*, kernel 7706b13` */
export function formatSources(sources: Partial<BuildSources> | undefined): string {
	if (!sources) return "";
	return SOURCE_NAMES.filter((name) => sources[name])
		.map((name) => `${name} ${sources[name]}`)
		.join(", ");
}

/**
 * Asset description: `artifact=<id>` and `commit=<sha7>`, nothing else. Roblox's text filter DOES censor
 * descriptions: #21's longer description (identity + change lines) came back as all '#' (2026-10-04), while short ones
 * passed. The full identity and the change notes live in the payload's attributes (Notes, Source*, Channel...), the
 * logs and the registry; the upload reads the description back and warns when it was censored.
 */
export function assetDescription(input: { artifactId: string; commit: string }): string {
	return [`artifact=${input.artifactId}`, `commit=${input.commit ? input.commit.slice(0, 7) : "uncommitted"}`].join("\n");
}

/** `key=value` lines of a description (anything after a `---` line, as older descriptions had, is ignored). */
export function parseAssetDescription(text: string): Record<string, string> {
	const identity: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (line === "---") break;
		const eq = line.indexOf("=");
		if (eq > 0) identity[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return identity;
}

/** True when Roblox's text filter replaced (most of) a text with '#'. */
export function looksCensored(text: string | undefined): boolean {
	const visible = (text ?? "").replace(/\s+/g, "");
	if (visible.length === 0) return false;
	return (visible.match(/#/g)?.length ?? 0) * 2 >= visible.length;
}

/** The GitHub Actions run URL, when running in Actions. */
export function ciRunUrl(env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
		return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
	}
	return undefined;
}

/**
 * The generated `src/shared/build.ts` (the framework imports BUILD from it; the template's scripts/build-info.ts
 * writes the same). The last line, the build time, makes the text differ on EVERY build: rbxtsc's incremental compile
 * skips files whose text is unchanged, which would leave `$git()`/`$compileTime()` stale. `SOURCES` sits beside BUILD
 * (whose fields stay as they are) and names the commits of the game and the @typetorch packages.
 */
export function buildFileSource(input: { dirty: boolean; channel: Channel; builtAt: string; sources?: BuildSources }): string {
	const sources = SOURCE_NAMES.filter((name) => input.sources?.[name])
		.map((name) => `${name}: ${JSON.stringify(input.sources![name])}`)
		.join(", ");
	return [
		"// Generated by `typetorch build`. Do not edit.",
		'import { $compileTime, $git } from "rbxts-transform-debug";',
		'import type { BuildInfo } from "@typetorch/framework";',
		'const GIT = $git("Branch", "Commit");',
		`export const BUILD: BuildInfo = { branch: GIT.Branch, commit: GIT.Commit, dirty: ${input.dirty}, channel: "${input.channel}", builtAt: $compileTime() };`,
		`export const SOURCES: { readonly template?: string; readonly framework?: string; readonly kernel?: string } = { ${sources} };`,
		`// ${input.builtAt}`,
		"",
	].join("\n");
}
