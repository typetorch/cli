/**
 * Phase 3, Roblox: the experience (pasted as a URL or an id), the Open Cloud API key (masked, probed at once), the
 * creator (read from Roblox, never asked), the owner's user id (from a username), then typetorch.json and .env.
 *
 * Lookups without a key go to Roblox's public web APIs (no scope, no secret): a place's universe
 * (apis.roblox.com/universes/v1/places/{id}/universe), a universe's name, root place and creator
 * (games.roblox.com/v1/games?universeIds=), and a username's id (users.roblox.com/v1/usernames/users). The key is
 * probed with the same harmless call `doctor` uses (GET an asset operation that doesn't exist: 404 = the key works).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, findProjectRoot, loadProject } from "../config.ts";
import { registerSecret, Settings, useSettings } from "../env.ts";
import { OpenCloud } from "../opencloud.ts";
import { DOCS } from "../tui.ts";
import { ensureGitignored, upsertDotEnv, type InitContext } from "./common.ts";

export interface ExperienceRef {
	universeId?: number;
	placeId?: number;
}

/**
 * The ids in what a person pastes: a game page (roblox.com/games/<placeId>/...), a Creator Hub page
 * (create.roblox.com/dashboard/creations/experiences/<universeId>/...), a Studio "Copy Universe ID" (a bare number,
 * taken as the universe id), or "universe:<id>" / "place:<id>".
 */
export function parseExperience(input: string): ExperienceRef | undefined {
	const text = input.trim();
	let match = /^(?:universe|u)[:= ]+(\d+)$/i.exec(text);
	if (match) return { universeId: Number(match[1]) };
	match = /^(?:place|p)[:= ]+(\d+)$/i.exec(text);
	if (match) return { placeId: Number(match[1]) };
	if (/^\d{1,20}$/.test(text)) return { universeId: Number(text) };
	match = /roblox\.com\/games\/(\d+)/i.exec(text);
	if (match) return { placeId: Number(match[1]) };
	match = /creations\/experiences\/(\d+)/i.exec(text);
	if (match) return { universeId: Number(match[1]) };
	match = /\/universes\/(\d+)/i.exec(text);
	if (match) return { universeId: Number(match[1]) };
	match = /\/places\/(\d+)/i.exec(text);
	if (match) return { placeId: Number(match[1]) };
	return undefined;
}

export interface UniverseInfo {
	universeId: number;
	rootPlaceId: number;
	name: string;
	creator: { groupId: number } | { userId: number };
	creatorName: string;
}

async function getJson(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<any> {
	const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
	const text = await response.text();
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
	return text ? JSON.parse(text) : undefined;
}

/** A place's universe id (public). */
export async function universeOfPlace(fetchFn: typeof fetch, placeId: number): Promise<number> {
	const body = await getJson(fetchFn, `https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
	const id = Number(body?.universeId);
	if (!Number.isInteger(id) || id <= 0) throw new Error(`place ${placeId}: Roblox returned no universe id (is the place id right?)`);
	return id;
}

/** A universe's name, root place and creator (public). */
export async function universeInfo(fetchFn: typeof fetch, universeId: number): Promise<UniverseInfo> {
	const body = await getJson(fetchFn, `https://games.roblox.com/v1/games?universeIds=${universeId}`);
	const game = body?.data?.[0];
	if (!game) throw new Error(`universe ${universeId}: Roblox returned no experience (is the id right, and is the experience published?)`);
	const type = String(game.creator?.type ?? "");
	const creatorId = Number(game.creator?.id);
	if (!Number.isInteger(creatorId) || !(type === "Group" || type === "User")) throw new Error(`universe ${universeId}: Roblox returned no creator`);
	return {
		universeId,
		rootPlaceId: Number(game.rootPlaceId),
		name: String(game.name ?? ""),
		creator: type === "Group" ? { groupId: creatorId } : { userId: creatorId },
		creatorName: String(game.creator?.name ?? ""),
	};
}

/** A Roblox username's user id (public). */
export async function userIdOf(fetchFn: typeof fetch, username: string): Promise<{ id: number; name: string } | undefined> {
	const body = await getJson(fetchFn, "https://users.roblox.com/v1/usernames/users", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
	});
	const found = body?.data?.[0];
	if (!found) return undefined;
	return { id: Number(found.id), name: String(found.name ?? username) };
}

export type KeyProbe = { ok: true } | { ok: false; reason: string };

/** The harmless probe doctor uses: an asset operation that doesn't exist answers 404 with a working key. */
export async function probeApiKey(oc: Pick<OpenCloud, "request">): Promise<KeyProbe> {
	const response = await oc.request("GET", "/assets/v1/operations/00000000-0000-0000-0000-000000000000", { retry: false, timeoutMs: 15_000 });
	if (response.status === 404 || response.status === 400) return { ok: true };
	if (response.status === 401) return { ok: false, reason: "Roblox says the key is invalid (401): paste it again, or make a new one" };
	if (response.status === 403) return { ok: false, reason: "the key has no asset:read (403): add the asset scopes in Creator Hub and select your experience" };
	return { ok: false, reason: `unexpected answer ${response.status} from Open Cloud` };
}

/** The scope table the key needs, printed next to the key question. */
export const SCOPES_TABLE = [
	"Assets API:            asset:read, asset:write                               (uploads, the key asset, hot assets)",
	"Luau Execution:        universe.place.luau-execution-session:read + :write    (the cloud test, kernel deploy)",
	"Messaging Service:     universe-messaging-service:publish                    (the deploy message)",
	"Data Stores:           universe-datastores.objects:read + :create + :update  (the shared deploy number, signed settings)",
];

export function configFor(input: { project: string; info: UniverseInfo; placeId: number; ownerId: number }): Record<string, unknown> {
	return {
		project: input.project,
		universeId: input.info.universeId,
		placeId: input.placeId,
		creator: input.info.creator,
		defaultBranch: "prod",
		branches: { main: "prod", dev: "dev" },
		channels: { prod: "prod", dev: "dev" },
		members: { [String(input.ownerId)]: "owner" },
		devBadgeId: null,
		approval: "prod",
		kernel: "node_modules/@typetorch/kernel",
	};
}

export async function robloxPhase(ctx: InitContext): Promise<void> {
	const { tui, deps } = ctx;
	tui.step(ctx.index("roblox"), ctx.total, "Roblox", "Your experience, the Open Cloud key the CLI uses, and who owns the game.", `${DOCS}/getting-started/fresh-setup.md#3-create-the-group-and-the-experience-owner`);
	tui.note("You need an experience to deploy to. New game: in Studio, File > New > Baseplate, then File > Publish to Roblox As...");
	tui.note("(pick your group as the creator for a group game). Then copy its URL from Creator Hub or the Roblox site.");

	// The experience.
	let ref: ExperienceRef | undefined;
	let info: UniverseInfo | undefined;
	for (;;) {
		const pasted = await tui.text("Paste the experience's URL (or its universe id)", { validate: (text) => (parseExperience(text) ? undefined : "paste a roblox.com/games/... or create.roblox.com/... URL, or the universe id") });
		ref = parseExperience(pasted)!;
		try {
			const universeId = ref.universeId ?? (await universeOfPlace(deps.fetch, ref.placeId!));
			info = await universeInfo(deps.fetch, universeId);
			break;
		} catch (error) {
			tui.warn((error as Error).message);
		}
	}
	const placeId = ref.placeId ?? info.rootPlaceId;
	const creatorWords = "groupId" in info.creator ? `group ${info.creatorName} (${info.creator.groupId})` : `user ${info.creatorName} (${info.creator.userId})`;
	tui.note(`${info.name}: universe ${info.universeId}, place ${placeId}, owned by ${creatorWords}`);
	if (!(await tui.confirm("Is that the right experience?", true))) throw new Error("run `typetorch init` again and paste the right experience");
	ctx.state.answers.universeId = info.universeId;
	ctx.state.answers.placeId = placeId;

	// The key.
	tui.note("The Open Cloud API key. Create it in Creator Hub > Open Cloud > API Keys (as the owner, or a group member who");
	tui.note("may upload and publish): https://create.roblox.com/dashboard/credentials . Add these and select your experience:");
	for (const line of SCOPES_TABLE) tui.note(`  ${line}`);
	tui.note("Set an expiry date. The key goes into the game repo's .env (gitignored); it is never printed.");
	const envFile = join(ctx.dir, ".env");
	let key: string | undefined;
	const existing = new Settings({ gameDir: ctx.dir, env: deps.env }).apiKey();
	if (existing) {
		tui.note(`an Open Cloud key is already set (${existing.name} in ${existing.source}); checking it`);
		key = existing.key;
	}
	for (;;) {
		if (!key) key = await tui.secret("Paste the API key", { validate: (text) => (text.length < 20 ? "that is too short for an Open Cloud key" : undefined) });
		registerSecret(key);
		const probe = await probeApiKey(new OpenCloud(key));
		if (probe.ok) break;
		tui.warn(probe.reason);
		key = undefined;
	}
	if (!existing || existing.key !== key) {
		upsertDotEnv(envFile, { OPENCLOUD_API_KEY: key });
		tui.note(`written to ${envFile}`);
	}
	ensureGitignored(ctx.dir);

	// The owner.
	let ownerId = ctx.state.answers.ownerId as number | undefined;
	if ("userId" in info.creator) ownerId ??= info.creator.userId;
	while (!ownerId) {
		const username = await tui.text("Your Roblox username (you become the first owner in typetorch.json)", { validate: (t) => (t.length < 3 ? "a Roblox username" : undefined) });
		try {
			const found = await userIdOf(deps.fetch, username);
			if (!found) {
				tui.warn(`no Roblox user named ${username}`);
				continue;
			}
			if (await tui.confirm(`${found.name} is user ${found.id}. Right?`, true)) ownerId = found.id;
		} catch (error) {
			tui.warn((error as Error).message);
		}
	}
	ctx.state.answers.ownerId = ownerId;

	// typetorch.json.
	const project = (ctx.state.answers.project as string | undefined) ?? "my-game";
	const config = configFor({ project, info, placeId, ownerId });
	const text = JSON.stringify(config, null, "\t") + "\n";
	tui.note(`${CONFIG_FILE} will be:`);
	for (const line of text.trimEnd().split("\n")) tui.note(`  ${line}`);
	if (!(await tui.confirm(`Write ${CONFIG_FILE}?`, true))) throw new Error("not written; run `typetorch init` again to change the answers");
	writeFileSync(join(ctx.dir, CONFIG_FILE), text);
	// Later phases read this project and this .env.
	useSettings(new Settings({ gameDir: ctx.dir, env: deps.env }));
	const root = findProjectRoot(ctx.dir);
	if (root) loadProject(undefined, ctx.dir);
	await deps.capture(["git", "add", CONFIG_FILE, ".gitignore"], ctx.dir);
	await deps.capture(["git", "commit", "-q", "-m", `typetorch init: ${project}`], ctx.dir);
	tui.note(`${CONFIG_FILE} written and committed`);
}
