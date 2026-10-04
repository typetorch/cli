/** Uploading a payload as a NEW Model asset, named from its git identity, and gating on moderation. */
import type { PayloadMeta } from "./build";
import type { ProjectConfig } from "./config";
import { seconds, warn } from "./log";
import { assetDescription, assetDisplayName, branchChannel, ciRunUrl } from "./naming";
import type { OpenCloud } from "./opencloud";

export function assetNaming(config: ProjectConfig, meta: PayloadMeta, branch: string, changes?: string[]) {
	const displayName = assetDisplayName({
		branch,
		artifactId: meta.artifactId,
		channel: meta.channel,
		impliedChannel: branchChannel(config, branch),
	});
	const description = assetDescription({
		artifactId: meta.artifactId,
		commitHash: meta.commitHash,
		branch,
		channel: meta.channel,
		dirty: meta.dirty,
		builtAt: meta.builtAt,
		sha256: meta.sha256,
		sources: meta.sources,
		ciUrl: ciRunUrl(),
		changes,
	});
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
		/** "What changed" lines for the description (changes.ts). */
		changes?: string[];
		moderationTimeout?: number;
		onStage?: (stage: "upload" | "moderation", s: number, detail: string) => void;
		/** Called once moderation is known (Approved or not), before anything is published: the "uploaded" record. */
		onUploaded?: (result: { assetId: number; displayName: string; moderation: string }) => void;
	} = {},
): Promise<UploadResult> {
	const { displayName, description } = assetNaming(config, meta, branch, options.changes);
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

/**
 * Roblox's text filter turns some names into "####" (seen: tt-dev-59daad8, tt-dev-c3698d4, even "tt dev"; while
 * tt-main-a17a22c passed), unpredictably. The identity is in the description either way; a censored name is renamed
 * to FALLBACK_ASSET_NAME so the Creator Hub list stays readable. Run it after the deploy message (off the critical
 * path). Returns the final name, or undefined when it couldn't tell.
 */
export async function fixCensoredName(oc: OpenCloud, upload: UploadResult): Promise<{ name?: string; renamed: boolean }> {
	try {
		const stored =
			upload.storedName ??
			(await oc.call("GET", `/assets/v1/assets/${upload.assetId}?readMask=displayName`))?.displayName;
		// Our names never contain "#", so any "#" is the filter's.
		if (typeof stored !== "string" || !stored.includes("#")) return { name: stored, renamed: false };
		const form = new FormData();
		form.append("request", JSON.stringify({ assetId: upload.assetId, displayName: FALLBACK_ASSET_NAME }));
		const op = await oc.call("PATCH", `/assets/v1/assets/${upload.assetId}?updateMask=displayName`, { body: form });
		const operationId = op?.operationId ?? String(op?.path ?? "").split("/").pop();
		if (operationId && !op?.done) await oc.waitForOperation(operationId, 60);
		return { name: FALLBACK_ASSET_NAME, renamed: true };
	} catch (error) {
		warn(`could not check or fix the asset name: ${(error as Error).message}`);
		return { renamed: false };
	}
}
