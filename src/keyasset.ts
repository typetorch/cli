/**
 * The key asset (plans/03 "Key asset"): a small group-owned Model the kernel loads by the KeyAssetId stamped on it, to
 * learn which MAIN public keys it trusts. One Model named `TypeTorchKeys`, no children, two string attributes:
 *   PublicKeys   trusted main public keys, base64, comma-separated, no spaces
 *   RevokedKeys  revoked public keys (main or fallback), same format, may be ""
 * `keys init` creates it (POST /assets/v1/assets, like payload uploads); `keys rotate` and `keys init --fallback --force`
 * add a version (PATCH /assets/v1/assets/{id}, spike S1b) and then publish the rekey hint (TypeTorch/rekey).
 * Public keys only: nothing here is secret.
 */
import type { ProjectConfig } from "./config.ts";
import { readRbxm, writeSingleInstanceRbxm } from "./rbxm.ts";
import { encodeRekeyMessage, REKEY_TOPIC, type OpenCloud } from "./opencloud.ts";
import { publicKeyError } from "./signing.ts";
import { PLACE_GAME_LUAU } from "./livecheck.ts";

export const KEY_ASSET_ROOT = "TypeTorchKeys";
export const KEY_ASSET_NAME = "TypeTorch keys";
export const KEY_ASSET_DESCRIPTION = "TypeTorch: public keys for signed prod deploys";
export const PUBLIC_KEYS_ATTRIBUTE = "PublicKeys";
export const REVOKED_KEYS_ATTRIBUTE = "RevokedKeys";

export interface KeyAssetContent {
	publicKeys: string[];
	revokedKeys: string[];
}

/** A comma-separated key list: no spaces, no empty entries. */
export function formatKeyList(keys: readonly string[]): string {
	for (const key of keys) if (publicKeyError(key)) throw new Error(`not a base64 Ed25519 public key: ${key}`);
	return keys.join(",");
}

/** Parses a key list the way the kernel does: split on ",", trim, drop empty entries and anything that isn't a key. */
export function parseKeyList(text: unknown): string[] {
	if (typeof text !== "string") return [];
	return text
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key !== "" && !publicKeyError(key));
}

/** The key asset's .rbxm. */
export function keyAssetRbxm(content: KeyAssetContent): Uint8Array {
	return writeSingleInstanceRbxm({
		className: "Model",
		name: KEY_ASSET_ROOT,
		attributes: {
			[PUBLIC_KEYS_ATTRIBUTE]: formatKeyList(content.publicKeys),
			[REVOKED_KEYS_ATTRIBUTE]: formatKeyList(content.revokedKeys),
		},
	});
}

/** Reads a key asset .rbxm back (tests, and checking what was built). */
export function readKeyAssetRbxm(bytes: Uint8Array): KeyAssetContent {
	const instances = readRbxm(bytes);
	const root = instances.find((i) => i.name === KEY_ASSET_ROOT && i.className === "Model");
	if (!root || instances.length !== 1) throw new Error(`not a key asset: expected one Model named ${KEY_ASSET_ROOT}`);
	return {
		publicKeys: parseKeyList(root.attributes?.[PUBLIC_KEYS_ATTRIBUTE]),
		revokedKeys: parseKeyList(root.attributes?.[REVOKED_KEYS_ATTRIBUTE]),
	};
}

/** The key asset's content from typetorch.json (the CLI's copy of what the asset should hold). */
export function contentFromConfig(config: Pick<ProjectConfig, "signingPublicKeys" | "revokedKeys">): KeyAssetContent {
	return { publicKeys: [...(config.signingPublicKeys ?? [])], revokedKeys: [...(config.revokedKeys ?? [])] };
}

/** Union of key lists, first-seen order. */
export function mergeKeys(...lists: (readonly string[] | undefined)[]): string[] {
	const out: string[] = [];
	for (const list of lists) for (const key of list ?? []) if (!out.includes(key)) out.push(key);
	return out;
}

export class KeyAssetError extends Error {
	override name = "KeyAssetError";
}

async function finish(oc: OpenCloud, operationId: string, assetIdHint: number | undefined, moderationTimeout: number) {
	const operation = await oc.waitForOperation(operationId);
	if (operation?.error) throw new KeyAssetError(`the key asset operation failed: ${JSON.stringify(operation.error)}`);
	const assetId = Number(operation?.response?.assetId ?? assetIdHint);
	if (!assetId) throw new KeyAssetError(`the key asset operation finished without an asset id: ${JSON.stringify(operation)}`);
	let state: string | undefined = operation?.response?.moderationResult?.moderationState;
	if (state !== "Approved") state = (await oc.waitForModeration(assetId, moderationTimeout)).state;
	const revisionId = operation?.response?.revisionId;
	return { assetId, moderation: state ?? "unknown", ...(revisionId !== undefined ? { revisionId: String(revisionId) } : {}) };
}

/** Creates the key asset (owned by the experience's creator, like payloads). `onCreated` runs as soon as the id is known. */
export async function createKeyAsset(
	oc: OpenCloud,
	config: Pick<ProjectConfig, "creator" | "universeId">,
	content: KeyAssetContent,
	options: { moderationTimeout?: number; onCreated?: (assetId: number) => void } = {},
): Promise<{ assetId: number; moderation: string }> {
	const operationId = await oc.createModelAsset({
		bytes: keyAssetRbxm(content),
		fileName: "typetorch-keys.rbxm",
		displayName: KEY_ASSET_NAME,
		description: KEY_ASSET_DESCRIPTION,
		creator: config.creator,
	});
	const operation = await oc.waitForOperation(operationId);
	if (operation?.error) throw new KeyAssetError(`creating the key asset failed: ${JSON.stringify(operation.error)}`);
	const assetId = Number(operation?.response?.assetId);
	if (!assetId) throw new KeyAssetError(`creating the key asset returned no asset id: ${JSON.stringify(operation)}`);
	options.onCreated?.(assetId);
	let state: string | undefined = operation?.response?.moderationResult?.moderationState;
	if (state !== "Approved") state = (await oc.waitForModeration(assetId, options.moderationTimeout ?? 600)).state;
	return { assetId, moderation: state ?? "unknown" };
}

/** Adds a version with new content to the key asset (PATCH). */
export async function updateKeyAsset(
	oc: OpenCloud,
	assetId: number,
	content: KeyAssetContent,
	options: { moderationTimeout?: number } = {},
): Promise<{ assetId: number; moderation: string; revisionId?: string }> {
	const operationId = await oc.updateModelAsset({ assetId, bytes: keyAssetRbxm(content), fileName: "typetorch-keys.rbxm" });
	return finish(oc, operationId, assetId, options.moderationTimeout ?? 600);
}

/** Publishes the rekey hint: servers re-read the key asset now. */
export async function publishRekey(oc: OpenCloud, universeId: number, t = Date.now()): Promise<string> {
	const text = encodeRekeyMessage(t);
	await oc.publishMessage(universeId, REKEY_TOPIC, text);
	return text;
}

/**
 * Luau for a Luau Execution task (doctor): reads the kernel's KeyAssetId / FallbackPublicKey / KernelVersion
 * attributes in the place, and loads the key asset the way servers do. Also reports ServerStorage.TypeTorchDev
 * (`devFolder`: the Studio local payload of kernel 0.3.1, which a place shouldn't ship) and ServerStorage.TypeTorchBackup
 * (`backup`: kernel 0.3.6's backup build). Returns one table.
 */
export function placeKeysScript(keyAssetId: number | undefined): string {
	return `
local result = {}
local dev = game:GetService("ServerStorage"):FindFirstChild("TypeTorchDev")
if dev then
	result.devFolder = { payload = dev:FindFirstChild("Payload") ~= nil, descendants = #dev:GetDescendants() }
end
-- Kernel 0.3.6: the backup build kernel deploy bakes in (artifact, seq, branch, channel, when, ModuleScripts).
local backup = game:GetService("ServerStorage"):FindFirstChild("TypeTorchBackup")
if backup then
	local modules = 0
	for _, descendant in backup:GetDescendants() do
		if descendant:IsA("ModuleScript") then
			modules += 1
		end
	end
	result.backup = {
		artifactId = backup:GetAttribute("BackupArtifactId") or backup:GetAttribute("ArtifactId"),
		seq = backup:GetAttribute("BackupSeq"),
		branch = backup:GetAttribute("BackupBranch"),
		channel = backup:GetAttribute("BackupChannel") or backup:GetAttribute("Channel"),
		at = backup:GetAttribute("BackupAt"),
		modules = modules,
	}
end
local slot = game:GetService("ServerScriptService"):FindFirstChild("TypeTorchKernel")
if slot then
	-- Asset ids go back as decimal strings, so no JSON encoder can turn them into 1.2e+14.
	local keyAssetId = slot:GetAttribute("KeyAssetId")
	result.kernel = {
		keyAssetId = if typeof(keyAssetId) == "number" then string.format("%d", keyAssetId) else keyAssetId,
		fallbackPublicKey = slot:GetAttribute("FallbackPublicKey"),
		version = slot:GetAttribute("KernelVersion"),
		bootstrapHeads = slot:GetAttribute("BootstrapHeads"),
	}
end
${PLACE_GAME_LUAU}
local id = ${keyAssetId ?? "nil"}
if id then
	local ok, err = pcall(function()
		local container = game:GetService("InsertService"):LoadAsset(id)
		local root = if container:GetAttribute("${PUBLIC_KEYS_ATTRIBUTE}") ~= nil then container else container:FindFirstChild("${KEY_ASSET_ROOT}")
		if not root then
			error("no ${KEY_ASSET_ROOT} in the asset")
		end
		result.asset = {
			publicKeys = root:GetAttribute("${PUBLIC_KEYS_ATTRIBUTE}"),
			revokedKeys = root:GetAttribute("${REVOKED_KEYS_ATTRIBUTE}"),
			children = #root:GetChildren(),
		}
		container:Destroy()
	end)
	if not ok then
		result.assetError = tostring(err)
	end
end
return result
`;
}

export { REKEY_TOPIC };
