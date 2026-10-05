/** Uploading a payload as a NEW Model asset, named from its git identity, and gating on moderation. */
import type { PayloadMeta } from "./build.ts";
import type { ProjectConfig } from "./config.ts";
import { seconds, warn } from "./log.ts";
import { assetDescription, assetDisplayName, branchChannel, looksCensored } from "./naming.ts";
import type { OpenCloud } from "./opencloud.ts";

/** The asset's display name and its minimal, filter-safe description (the notes live in the payload's Notes attribute). */
export function assetNaming(config: ProjectConfig, meta: PayloadMeta, branch: string) {
	const displayName = assetDisplayName({
		branch,
		artifactId: meta.artifactId,
		channel: meta.channel,
		impliedChannel: branchChannel(config, branch),
	});
	const description = assetDescription({ artifactId: meta.artifactId, commit: meta.commit });
	return { displayName, description };
}

/**
 * Moderation did not approve the upload in time (or rejected it). The asset is still recorded in uploads.jsonl; once
 * Roblox approves it, `typetorch promote <branch> <assetId>` publishes it without a rebuild.
 */
export class ModerationError extends Error {
	override name = "ModerationError";
	constructor(
		readonly assetId: number,
		readonly state: string | undefined,
		readonly timedOut: boolean,
		branch = "<branch>",
	) {
		super(
			timedOut
				? `asset ${assetId} is still ${state ?? "in moderation"} after the timeout; nothing was published. Once it is Approved, publish it without a rebuild: typetorch promote ${branch} ${assetId}`
				: `asset ${assetId} moderation is ${state ?? "unknown"}; refusing to publish anything but Approved`,
		);
	}
}

export interface UploadResult {
	assetId: number;
	displayName: string;
	/** The name Roblox stored (after its text filter), when the operation response has it. */
	storedName?: string;
	description: string;
	moderationState: string;
	uploadSeconds: number;
	moderationSeconds: number;
}

/**
 * Creates the asset, waits for the operation, then waits until moderation leaves "Reviewing". Throws ModerationError
 * unless the asset is Approved. `onStage` reports each finished stage (for live progress output).
 */
export async function uploadPayload(
	oc: OpenCloud,
	config: ProjectConfig,
	meta: PayloadMeta,
	bytes: Uint8Array,
	branch: string,
	options: {
		moderationTimeout?: number;
		onStage?: (stage: "upload" | "moderation", s: number, detail: string) => void;
		/** Called once moderation is known (Approved or not), before anything is published: the "uploaded" record. */
		onUploaded?: (result: { assetId: number; displayName: string; moderation: string }) => void;
	} = {},
): Promise<UploadResult> {
	const { displayName, description } = assetNaming(config, meta, branch);
	const uploadStarted = performance.now();
	const operationId = await oc.createModelAsset({
		bytes,
		fileName: `${meta.artifactId}.rbxm`,
		displayName,
		description,
		creator: config.creator,
	});
	const operation = await oc.waitForOperation(operationId);
	const assetId = Number(operation?.response?.assetId);
	if (!assetId) throw new Error(`upload finished without an asset id: ${JSON.stringify(operation?.error ?? operation)}`);
	const uploadSeconds = seconds(performance.now() - uploadStarted);
	options.onStage?.("upload", uploadSeconds, `asset ${assetId}  ${displayName}`);

	const moderationStarted = performance.now();
	// The operation response usually carries the moderation result already (S1); poll the asset otherwise.
	let state: string | undefined = operation?.response?.moderationResult?.moderationState;
	let timedOut = false;
	if (state !== "Approved") {
		const result = await oc.waitForModeration(assetId, options.moderationTimeout ?? 600);
		state = result.state;
		timedOut = result.timedOut;
	}
	const moderationSeconds = seconds(performance.now() - moderationStarted);
	options.onStage?.("moderation", moderationSeconds, state ?? "unknown");
	options.onUploaded?.({ assetId, displayName, moderation: state ?? "unknown" });
	if (state !== "Approved") throw new ModerationError(assetId, state, timedOut, branch);
	const storedName = typeof operation?.response?.displayName === "string" ? operation.response.displayName : undefined;
	return { assetId, displayName, description, storedName, moderationState: state, uploadSeconds, moderationSeconds };
}

/** A name Roblox's text filter has always let through (2026-10-04). */
export const FALLBACK_ASSET_NAME = "TypeTorch payload";

/** How long the cosmetic name check may take in total; it never blocks or fails a deploy. */
export const NAME_CHECK_BUDGET_MS = 20_000;
/** Each of its requests: one try, short timeout (a stalled Assets API once held a deploy for 10+ minutes). */
const NAME_CHECK_REQUEST = { timeoutMs: 8_000, retry: false } as const;

/**
 * Roblox's text filter censors names AND descriptions to "####", unpredictably (names: tt-dev-59daad8, tt-dev-c3698d4,
 * even "tt dev", while tt-main-a17a22c passed; descriptions: #21's long one, 2026-10-04). Run AFTER the deploy message
 * (off the critical path; `deploy` publishes first): reads the stored name and description back, renames a censored
 * asset to FALLBACK_ASSET_NAME so the Creator Hub list stays readable, and warns about a censored description
 * (harmless: the identity and the notes are in the payload's attributes). Bounded: single-try requests and an overall
 * budget (NAME_CHECK_BUDGET_MS); past it the check is skipped with a note. Returns the final name, or undefined when it
 * couldn't tell.
 */
export async function fixCensoredName(
	oc: OpenCloud,
	upload: UploadResult,
	options: { budgetMs?: number } = {},
): Promise<{ name?: string; renamed: boolean; descriptionCensored?: boolean; skipped?: boolean }> {
	const budgetMs = options.budgetMs ?? NAME_CHECK_BUDGET_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<{ renamed: boolean; skipped: boolean }>((resolve) => {
		timer = setTimeout(() => resolve({ renamed: false, skipped: true }), budgetMs);
	});
	try {
		const result = await Promise.race([checkName(oc, upload), budget]);
		if ("skipped" in result && result.skipped) warn(`skipped the asset name check: Roblox didn't answer within ${Math.round(budgetMs / 1000)} s (harmless)`);
		return result;
	} finally {
		clearTimeout(timer);
	}
}

async function checkName(oc: OpenCloud, upload: UploadResult): Promise<{ name?: string; renamed: boolean; descriptionCensored?: boolean }> {
	try {
		const asset = await oc.call("GET", `/assets/v1/assets/${upload.assetId}?readMask=displayName,description`, NAME_CHECK_REQUEST);
		const stored: unknown = asset?.displayName ?? upload.storedName;
		const descriptionCensored = typeof asset?.description === "string" ? looksCensored(asset.description) : undefined;
		if (descriptionCensored) warn(`Roblox's text filter censored asset ${upload.assetId}'s description (harmless: the identity and notes are in the payload's attributes)`);
		// Our names never contain "#", so any "#" is the filter's.
		if (typeof stored !== "string" || !stored.includes("#")) return { name: typeof stored === "string" ? stored : undefined, renamed: false, descriptionCensored };
		const form = new FormData();
		form.append("request", JSON.stringify({ assetId: upload.assetId, displayName: FALLBACK_ASSET_NAME }));
		const op = await oc.call("PATCH", `/assets/v1/assets/${upload.assetId}?updateMask=displayName`, { body: form, ...NAME_CHECK_REQUEST });
		const operationId = op?.operationId ?? String(op?.path ?? "").split("/").pop();
		if (operationId && !op?.done) await oc.waitForOperation(operationId, 10, NAME_CHECK_REQUEST);
		return { name: FALLBACK_ASSET_NAME, renamed: true, descriptionCensored };
	} catch (error) {
		warn(`could not check or fix the asset name: ${(error as Error).message}`);
		return { renamed: false };
	}
}
