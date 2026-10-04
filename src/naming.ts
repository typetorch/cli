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
 * Artifact id: `<channel>-<commit>`, or `<channel>-<commit>-dirty-<sha6>` for a build from a dirty tree (sha6 = the
 * first 6 hex of the payload's sha256). A repo without commits uses "uncommitted" and is always dirty.
 */
export function artifactId(input: { channel: Channel; commit: string; dirty: boolean; sha256?: string }): string {
	const commit = input.commit || "uncommitted";
	if (!input.dirty) return `${input.channel}-${commit}`;
	if (!input.sha256) throw new Error("a dirty artifact id needs the payload sha256");
	return `${input.channel}-${commit}-dirty-${input.sha256.slice(0, 6)}`;
}

/** The provisional id stamped into the payload whose hash names a dirty artifact (see build.ts). */
export function provisionalArtifactId(input: { channel: Channel; commit: string }): string {
	return `${input.channel}-${input.commit || "uncommitted"}-dirty`;
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
 * Asset display name: `tt-<branch>-<commit>[-dirty][-<channel>]`, only [a-z0-9-], at most 50 chars. The channel is
 * appended only when it differs from the one the branch implies (a `--channel` override). Roblox's text filter
 * censored the earlier "TT <project> <branch>@<commit>" names; this shape passes it (2026-10-04). The branch part is
 * shortened when needed so the commit always survives.
 */
export function assetDisplayName(input: {
	branch: string;
	commit: string;
	dirty: boolean;
	channel: Channel;
	impliedChannel: Channel;
}): string {
	const suffix = [
		slug(input.commit) || "uncommitted",
		input.dirty ? "dirty" : undefined,
		input.channel !== input.impliedChannel ? input.channel : undefined,
	]
		.filter(Boolean)
		.join("-");
	const budget = ASSET_NAME_MAX - "tt-".length - 1 - suffix.length;
	const branch = slug(input.branch).slice(0, Math.max(0, budget)).replace(/-+$/, "");
	return (branch ? `tt-${branch}-${suffix}` : `tt-${suffix}`).slice(0, ASSET_NAME_MAX);
}

export interface DescriptionInput {
	artifactId: string;
	commitHash: string;
	branch: string;
	channel: Channel;
	dirty: boolean;
	builtAt: string;
	sha256: string;
	ciUrl?: string;
}

/** Asset description: one `key=value` per line, the full git identity (descriptions are not censored). */
export function assetDescription(input: DescriptionInput): string {
	return [
		`artifact=${input.artifactId}`,
		`commit=${input.commitHash || "uncommitted"}`,
		`branch=${input.branch}`,
		`channel=${input.channel}`,
		`dirty=${input.dirty}`,
		`built=${input.builtAt}`,
		`sha256=${input.sha256}`,
		input.ciUrl ? `ci=${input.ciUrl}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n")
		.slice(0, 1000);
}

/** The GitHub Actions run URL, when running in Actions. */
export function ciRunUrl(env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
		return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
	}
	return undefined;
}

/**
 * The generated `src/shared/build.ts` (exact text; the framework imports BUILD from it, and the template's
 * scripts/build-info.ts writes the same). The last line, the build time, makes the text differ on EVERY build:
 * rbxtsc's incremental compile skips files whose text is unchanged, which would leave `$git()`/`$compileTime()` stale.
 */
export function buildFileSource(input: { dirty: boolean; channel: Channel; builtAt: string }): string {
	return [
		"// Generated by `typetorch build`. Do not edit.",
		'import { $compileTime, $git } from "rbxts-transform-debug";',
		'import type { BuildInfo } from "@typetorch/framework";',
		'const GIT = $git("Branch", "Commit");',
		`export const BUILD: BuildInfo = { branch: GIT.Branch, commit: GIT.Commit, dirty: ${input.dirty}, channel: "${input.channel}", builtAt: $compileTime() };`,
		`// ${input.builtAt}`,
		"",
	].join("\n");
}
