/**
 * `typetorch doctor`'s signing checks (plans/03 "Signed prod messages and heads"): both key files exist and match
 * typetorch.json, the key asset (moderation, creator, PublicKeys/RevokedKeys) and the place (the kernel's KeyAssetId
 * and FallbackPublicKey). Every mismatch is a warning. Gathering hits Open Cloud; `keyChecks` is pure (tested).
 *
 * The key asset's content and the place's attributes are read with one Luau Execution task (the assets key; scopes
 * universe.place.luau-execution-session:read + :write): it loads the key asset the way servers do. Without that, the
 * place falls back to the last kernel deploy recorded in the state dir. The same task reports
 * ServerStorage.TypeTorchDev (kernel 0.3.1's Studio local payload): live servers ignore it, but it bloats the place.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./config.ts";
import { parseKeyList, placeKeysScript } from "./keyasset.ts";
import { inspectKeyFile, type KeyFileInfo, type KeyRole } from "./keyfiles.ts";
import { isRecord } from "./json.ts";
import { keyFingerprint } from "./signing.ts";
import type { OpenCloud } from "./opencloud.ts";

export type Status = "ok" | "warn" | "fail";
export interface Check {
	name: string;
	status: Status;
	detail: string;
}

export interface KeyFileFacts {
	path: string;
	info?: KeyFileInfo;
	error?: string;
	missing: boolean;
}

export interface KeyFacts {
	config: Pick<ProjectConfig, "universeId" | "creator" | "signingPublicKeys" | "revokedKeys" | "fallbackPublicKey" | "keyAssetId">;
	main: KeyFileFacts;
	fallback: KeyFileFacts;
	/** The key asset's metadata (Assets API). */
	assetMeta?: { moderation?: string; creator?: { groupId?: string | number; userId?: string | number }; error?: string };
	/** The key asset's content as servers load it. */
	asset?: { publicKeys: string[]; revokedKeys: string[]; children?: number } | { error: string };
	/** The kernel's attributes in the place. */
	place?: { keyAssetId?: number; fallbackPublicKey?: string; source: string } | { error: string; source: string };
	/** ServerStorage.TypeTorchDev in the place (Luau Execution only; undefined when the task didn't run). */
	devFolder?: { present: boolean; payload?: boolean; descendants?: number };
}

/** Keys are shown by fingerprint, like the kernel's dev menu (first 8 hex of the SHA-256 of the raw key). */
const short = (key: string) => keyFingerprint(key);
const list = (keys: readonly string[] | undefined) => (keys?.length ? keys.map(short).join(", ") : "(none)");
const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined) => {
	const x = new Set(a ?? []);
	const y = new Set(b ?? []);
	return x.size === y.size && [...x].every((k) => y.has(k));
};

function keyFileCheck(role: KeyRole, facts: KeyFileFacts, config: KeyFacts["config"]): Check {
	const name = `${role} key file`;
	const fix = role === "main" ? "typetorch keys init (or keys rotate if the key is lost)" : "typetorch keys init --fallback (--force to replace a lost one, then kernel deploy)";
	if (facts.missing) return { name, status: "warn", detail: `none at ${facts.path}: this machine can't sign prod deploys (${fix})` };
	if (facts.error || !facts.info) return { name, status: "warn", detail: facts.error ?? `unreadable: ${facts.path}` };
	const key = facts.info.publicKey;
	const revoked = (config.revokedKeys ?? []).includes(key);
	if (role === "main" && !(config.signingPublicKeys ?? []).includes(key)) {
		return { name, status: "warn", detail: `${facts.path} (public ${key}) is not in typetorch.json "signingPublicKeys" (${list(config.signingPublicKeys)})` };
	}
	if (role === "fallback" && config.fallbackPublicKey !== key) {
		return { name, status: "warn", detail: `${facts.path} (public ${key}) doesn't match typetorch.json "fallbackPublicKey" (${config.fallbackPublicKey ?? "none"})` };
	}
	if (revoked) return { name, status: "warn", detail: `${facts.path} (public ${key}) is revoked in typetorch.json "revokedKeys"` };
	return { name, status: "ok", detail: `${facts.path}, public ${key} (fingerprint ${keyFingerprint(key)})` };
}

/** The signing checks, from gathered facts. Mismatches are warnings. */
export function keyChecks(facts: KeyFacts): Check[] {
	const c = facts.config;
	const checks: Check[] = [];
	const configured = Boolean(c.signingPublicKeys?.length || c.fallbackPublicKey || c.keyAssetId);
	if (!configured) {
		checks.push({
			name: "prod signing",
			status: "warn",
			detail: "not set up: prod-channel deploys need both keys (typetorch keys init, typetorch keys init --fallback, then typetorch kernel deploy)",
		});
		return checks;
	}
	const missing = [
		!c.signingPublicKeys?.length && '"signingPublicKeys" (keys init)',
		!c.keyAssetId && '"keyAssetId" (keys init)',
		!c.fallbackPublicKey && '"fallbackPublicKey" (keys init --fallback)',
	].filter(Boolean);
	checks.push(
		missing.length
			? { name: "signing config", status: "warn", detail: `typetorch.json has no ${missing.join(", ")}` }
			: { name: "signing config", status: "ok", detail: `main ${list(c.signingPublicKeys)}, fallback ${short(c.fallbackPublicKey!)}, key asset ${c.keyAssetId}, revoked ${c.revokedKeys?.length ?? 0}` },
	);
	checks.push(keyFileCheck("main", facts.main, c));
	if (c.fallbackPublicKey || !facts.fallback.missing) checks.push(keyFileCheck("fallback", facts.fallback, c));
	if (facts.main.info && facts.fallback.info && facts.main.info.publicKey === facts.fallback.info.publicKey) {
		checks.push({ name: "key pairs", status: "warn", detail: "the main and fallback key files hold the same key; they must be separate pairs" });
	}

	// The key asset
	if (c.keyAssetId) {
		const problems: string[] = [];
		const meta = facts.assetMeta;
		if (meta?.error) problems.push(`metadata unreadable: ${meta.error}`);
		else if (meta) {
			if (meta.moderation !== "Approved") problems.push(`moderation is ${meta.moderation ?? "unknown"} (servers can't load it until Approved)`);
			const want = "groupId" in c.creator ? { groupId: String(c.creator.groupId) } : { userId: String(c.creator.userId) };
			const got = meta.creator;
			if (got && (("groupId" in want && String(got.groupId) !== want.groupId) || ("userId" in want && String(got.userId) !== want.userId))) {
				problems.push(`owned by ${JSON.stringify(got)}, not the experience's creator ${JSON.stringify(c.creator)} (LoadAsset would refuse it)`);
			}
		}
		const asset = facts.asset;
		if (asset && "error" in asset) problems.push(`content not read: ${asset.error}`);
		else if (asset) {
			if (!sameSet(asset.publicKeys, c.signingPublicKeys)) problems.push(`PublicKeys ${list(asset.publicKeys)} != typetorch.json "signingPublicKeys" ${list(c.signingPublicKeys)}`);
			if (!sameSet(asset.revokedKeys, c.revokedKeys)) problems.push(`RevokedKeys ${list(asset.revokedKeys)} != typetorch.json "revokedKeys" ${list(c.revokedKeys)}`);
			const main = facts.main.info?.publicKey;
			if (main && (!asset.publicKeys.includes(main) || asset.revokedKeys.includes(main))) problems.push(`servers don't trust the main key file's key ${short(main)}`);
			const fallback = facts.fallback.info?.publicKey ?? c.fallbackPublicKey;
			if (fallback && asset.revokedKeys.includes(fallback)) problems.push(`the fallback key ${short(fallback)} is revoked (keys init --fallback --force, then kernel deploy)`);
			if (asset.children) problems.push(`the keys model has ${asset.children} children (expected none)`);
		}
		checks.push(
			problems.length
				? { name: "key asset", status: "warn", detail: `${c.keyAssetId}: ${problems.join("; ")}` }
				: {
						name: "key asset",
						status: asset && !("error" in asset) ? "ok" : "warn",
						detail:
							asset && !("error" in asset)
								? `${c.keyAssetId}: ${meta?.moderation ?? "?"}, PublicKeys ${list(asset.publicKeys)}, RevokedKeys ${asset.revokedKeys.length}`
								: `${c.keyAssetId}: content not checked`,
					},
		);
	}

	// The place
	const place = facts.place;
	if (!place) checks.push({ name: "place keys", status: "warn", detail: "not checked (no Luau Execution and no kernel deploy recorded here)" });
	else if ("error" in place) checks.push({ name: "place keys", status: "warn", detail: `${place.source}: ${place.error}` });
	else {
		const problems: string[] = [];
		if (place.keyAssetId === undefined && place.fallbackPublicKey === undefined) problems.push("the kernel has no KeyAssetId or FallbackPublicKey (deployed before signing)");
		else {
			if (place.keyAssetId !== c.keyAssetId) problems.push(`KeyAssetId ${place.keyAssetId ?? "(none)"} != typetorch.json "keyAssetId" ${c.keyAssetId ?? "(none)"}`);
			if (place.fallbackPublicKey !== c.fallbackPublicKey) problems.push(`FallbackPublicKey ${place.fallbackPublicKey ? short(place.fallbackPublicKey) : "(none)"} != typetorch.json "fallbackPublicKey" ${c.fallbackPublicKey ? short(c.fallbackPublicKey) : "(none)"}`);
		}
		checks.push(
			problems.length
				? { name: "place keys", status: "warn", detail: `${place.source}: ${problems.join("; ")}; run \`typetorch kernel deploy\`` }
				: { name: "place keys", status: "ok", detail: `${place.source}: KeyAssetId ${place.keyAssetId}, FallbackPublicKey ${short(place.fallbackPublicKey!)}` },
		);
	}
	const dev = facts.devFolder;
	if (dev?.present) {
		const what = dev.payload ? `a local payload, ${dev.descendants ?? "?"} instances` : `${dev.descendants ?? "?"} instances`;
		checks.push({
			name: "place dev folder",
			status: "warn",
			detail: `the place holds ServerStorage.TypeTorchDev (${what}): live servers ignore it, but it bloats the place. Delete it in Studio, or republish with \`typetorch kernel deploy\``,
		});
	} else if (dev) {
		checks.push({ name: "place dev folder", status: "ok", detail: "no ServerStorage.TypeTorchDev in the place" });
	}
	return checks;
}

/** An asset id from the place: a number, or a decimal string (how the Luau script returns it). */
function assetIdOf(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
	return undefined;
}

/** The newest published kernel deploy recorded in the state dir. */
export function lastKernelDeploy(stateDir: string): { keyAssetId?: number; fallbackPublicKey?: string; at?: string; placeVersionAfter?: number } | undefined {
	const file = join(stateDir, "kernel-deploys.jsonl");
	if (!existsSync(file)) return undefined;
	let last: any;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		try {
			const record = JSON.parse(line);
			if (record?.event === "kernel-published") last = record;
		} catch {}
	}
	if (!last) return undefined;
	return {
		keyAssetId: typeof last.keyAssetId === "number" ? last.keyAssetId : undefined,
		fallbackPublicKey: typeof last.fallbackPublicKey === "string" ? last.fallbackPublicKey : undefined,
		at: last.at,
		placeVersionAfter: typeof last.placeVersionAfter === "number" ? last.placeVersionAfter : undefined,
	};
}

/** Gathers the facts: key files (local), key asset metadata (Assets API), asset content + place (Luau Execution). */
export async function gatherKeyFacts(input: {
	config: KeyFacts["config"] & { placeId: number };
	paths: Record<KeyRole, string>;
	stateDir: string;
	/** A client with the assets key (also used for Luau Execution); undefined when there is none. */
	assets?: OpenCloud;
}): Promise<KeyFacts> {
	const c = input.config;
	const facts: KeyFacts = {
		config: c,
		main: { path: input.paths.main, ...inspectKeyFile(input.paths.main, { role: "main", universeId: c.universeId }) },
		fallback: { path: input.paths.fallback, ...inspectKeyFile(input.paths.fallback, { role: "fallback", universeId: c.universeId }) },
	};
	// Nothing set up yet: keyChecks says so; no network.
	if (!c.signingPublicKeys?.length && !c.fallbackPublicKey && !c.keyAssetId) return facts;
	const recorded = lastKernelDeploy(input.stateDir);
	const fromRecord = (why: string): KeyFacts["place"] =>
		recorded
			? { keyAssetId: recorded.keyAssetId, fallbackPublicKey: recorded.fallbackPublicKey, source: `last kernel deploy recorded here (${recorded.at ?? "?"}; ${why})` }
			: { error: `${why}; no kernel deploy recorded here either`, source: "place" };
	if (!input.assets) {
		if (c.keyAssetId) facts.asset = { error: "no assets key (OPENCLOUD_ASSETS_KEY or the shared key)" };
		facts.place = fromRecord("no assets key for Luau Execution");
		return facts;
	}
	if (c.keyAssetId) {
		try {
			const meta = await input.assets.call("GET", `/assets/v1/assets/${c.keyAssetId}?readMask=moderationResult,creationContext`);
			facts.assetMeta = { moderation: meta?.moderationResult?.moderationState, creator: meta?.creationContext?.creator };
		} catch (error) {
			facts.assetMeta = { error: (error as Error).message.slice(0, 200) };
		}
	}
	try {
		const run = await input.assets.runLuau(c.universeId, c.placeId, placeKeysScript(c.keyAssetId), 60);
		const result = run.results[0];
		if (run.state !== "COMPLETE" || !isRecord(result)) throw new Error(`task ${run.state}${run.error ? `: ${JSON.stringify(run.error).slice(0, 200)}` : ""}`);
		const kernel = isRecord(result.kernel) ? result.kernel : undefined;
		facts.place = kernel
			? {
					keyAssetId: assetIdOf(kernel.keyAssetId),
					fallbackPublicKey: typeof kernel.fallbackPublicKey === "string" ? kernel.fallbackPublicKey : undefined,
					source: "the place (Luau Execution)",
				}
			: { error: "no ServerScriptService.TypeTorchKernel in the place", source: "the place (Luau Execution)" };
		facts.devFolder = isRecord(result.devFolder)
			? { present: true, payload: result.devFolder.payload === true, descendants: Number(result.devFolder.descendants) || 0 }
			: { present: false };
		if (c.keyAssetId) {
			facts.asset = isRecord(result.asset)
				? { publicKeys: parseKeyList(result.asset.publicKeys), revokedKeys: parseKeyList(result.asset.revokedKeys), children: Number(result.asset.children) || 0 }
				: { error: `LoadAsset failed in the place: ${String(result.assetError ?? "unknown").slice(0, 200)}` };
		}
	} catch (error) {
		const why = `Luau Execution failed (the assets key needs universe.place.luau-execution-session:read/:write): ${(error as Error).message.slice(0, 200)}`;
		facts.place = fromRecord(why);
		if (c.keyAssetId) facts.asset = { error: why };
	}
	return facts;
}
