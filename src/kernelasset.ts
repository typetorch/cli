/**
 * The kernel as an uploaded asset (kernel 0.4.0 loader; plans/22): the pure parts.
 *   - packageProject: the Rojo project of the KERNEL PACKAGE, the Model uploaded as a version of the group-owned kernel
 *     asset: a Folder per service holding that service's kernel slot, every Script and LocalScript disabled (nothing
 *     runs on insert; the loader enables them), identity attributes on the root, NO trust roots (only the place's
 *     loader carries KeyAssetId, FallbackPublicKey, BootstrapHeads);
 *   - bakedProject: the same slots under ServerStorage.TypeTorchKernelBaked, the fallback kernel the loader installs when
 *     the asset can't be used;
 *   - the pointer in the signed settings record: `kernel = { prod: KernelPointer, dev: KernelPointer }`, set, promoted
 *     (dev -> prod) and checked.
 */
import { isRecord } from "./json.ts";
import type { SlotRef } from "./placepatch.ts";

/** The loader contract this CLI builds packages for (the kernel's src/loader/LoaderCore.luau LOADER_API). */
export const LOADER_API = 1;
export const PACKAGE_ROOT = "TypeTorchKernelPackage";
export const BAKED_FOLDER = "TypeTorchKernelBaked";
/** The three kernel slots a package holds (the backup build is not part of the kernel). */
export const PACKAGE_SLOTS: SlotRef[] = [
	{ service: "ServerScriptService", name: "TypeTorchKernel" },
	{ service: "ReplicatedStorage", name: "TypeTorchKernelShared" },
	{ service: "ReplicatedFirst", name: "TypeTorchKernelClient" },
];
/** Attributes only the place's loader may carry (stamped onto the installed kernel at boot). */
export const TRUST_ROOTS = ["KeyAssetId", "FallbackPublicKey", "BootstrapHeads", "BootScreen", "KernelScreen", "OverrideOwnerOnly"];
export const CHANNELS = ["prod", "dev"] as const;
export type KernelChannel = (typeof CHANNELS)[number];

export interface KernelPointer {
	/** The kernel asset's id. */
	asset: number;
	/** The asset VERSION id LoadAssetVersion takes (immutable). */
	versionId: number;
	/** The kernel version (package.json). */
	version: string;
	/** The kernel content hash (64 hex), also on the package root as KernelHash. */
	hash: string;
	loaderApi: number;
	commit?: string;
	/** When it was pointed at (ISO). */
	at: string;
}

const isScriptNode = (node: Record<string, unknown>) =>
	node.$className === "Script" || node.$className === "LocalScript" || (typeof node.$path === "string" && /\.(server|client)\.luau?$/.test(node.$path));

/** A copy of a slot node with every script node disabled and the trust roots taken out of its attributes. */
function packageNode(node: unknown, top = true): unknown {
	if (!isRecord(node)) return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$attributes" && top && isRecord(value)) {
			const kept = Object.fromEntries(Object.entries(value).filter(([name]) => !TRUST_ROOTS.includes(name)));
			if (Object.keys(kept).length) out.$attributes = kept;
		} else if (key.startsWith("$")) out[key] = value;
		else out[key] = packageNode(value, false);
	}
	if (isScriptNode(node)) out.$properties = { ...(isRecord(node.$properties) ? node.$properties : {}), Disabled: true };
	return out;
}

function slotNodes(stamped: unknown): Record<string, Record<string, unknown>> {
	const tree = isRecord(stamped) && isRecord(stamped.tree) ? (stamped.tree as Record<string, unknown>) : {};
	const out: Record<string, Record<string, unknown>> = {};
	for (const slot of PACKAGE_SLOTS) {
		const key = Object.keys(tree).find((name) => isRecord(tree[name]) && ((tree[name] as Record<string, unknown>).$className ?? name) === slot.service);
		const node = key ? (tree[key] as Record<string, unknown>)[slot.name] : undefined;
		if (!isRecord(node)) throw new Error(`the kernel project has no ${slot.service}.${slot.name}`);
		out[slot.service] = { $className: "Folder", [slot.name]: packageNode(node) };
	}
	return out;
}

/** The kernel package's Rojo project (build it to an .rbxm). */
export function packageProject(stamped: unknown, identity: { version: string; hash: string; commit?: string; api?: number }): { name: string; tree: Record<string, unknown> } {
	const attributes: Record<string, string | number> = { KernelVersion: identity.version, KernelHash: identity.hash, LoaderApi: LOADER_API };
	if (identity.commit) attributes.KernelCommit = identity.commit;
	if (identity.api !== undefined) attributes.KernelApi = identity.api;
	return { name: PACKAGE_ROOT, tree: { $className: "Model", $attributes: attributes, ...slotNodes(stamped) } };
}

/** The fallback kernel baked into the place: ServerStorage.TypeTorchKernelBaked (as a slots project for the luau engine). */
export function bakedSlotNode(stamped: unknown): Record<string, unknown> {
	return { $className: "Folder", ...slotNodes(stamped) };
}

/** What is wrong with a pointer, or []. */
export function pointerProblems(pointer: unknown): string[] {
	if (!isRecord(pointer)) return ["not an object"];
	const problems: string[] = [];
	const whole = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
	if (!whole(pointer.asset)) problems.push("asset must be the kernel asset's id");
	if (!whole(pointer.versionId)) problems.push("versionId must be an asset version id");
	if (typeof pointer.version !== "string" || !/^\d+\.\d+\.\d+/.test(pointer.version)) problems.push("version must be the kernel version");
	if (typeof pointer.hash !== "string" || !/^[0-9a-f]{64}$/.test(pointer.hash)) problems.push("hash must be the 64-hex kernel hash");
	if (!whole(pointer.loaderApi)) problems.push("loaderApi must be a whole number");
	return problems;
}

/** The settings body with `kernel.<channel>` set (a copy). */
export function withPointer<T extends { kernel?: unknown }>(body: T, channel: KernelChannel, pointer: KernelPointer): T {
	const problems = pointerProblems(pointer);
	if (problems.length) throw new Error(`refusing a bad kernel pointer: ${problems.join("; ")}`);
	const kernel = isRecord(body.kernel) ? { ...(body.kernel as Record<string, unknown>) } : {};
	kernel[channel] = pointer;
	return { ...body, kernel };
}

/** The pointer a channel has now, if any. */
export function pointerOf(body: { kernel?: unknown } | undefined, channel: KernelChannel): KernelPointer | undefined {
	const kernel = body && isRecord(body.kernel) ? (body.kernel as Record<string, unknown>) : undefined;
	const pointer = kernel?.[channel];
	return pointer && pointerProblems(pointer).length === 0 ? (pointer as KernelPointer) : undefined;
}

/** dev's pointer copied to prod (`typetorch kernel promote`); throws when dev has none. */
export function promoted<T extends { kernel?: unknown }>(body: T, now = new Date()): T {
	const dev = pointerOf(body, "dev");
	if (!dev) throw new Error("the settings record has no kernel.dev pointer to promote (typetorch kernel deploy --asset --channel dev first)");
	return withPointer(body, "prod", { ...dev, at: now.toISOString() });
}
