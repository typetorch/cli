/**
 * `typetorch keys`: the two Ed25519 keys that sign prod-channel deploys (decision D1 reopened; format in plans/03
 * "Signed prod messages and heads"). Seeds are written to key files outside every repo and are never printed, logged,
 * put in an env file or passed to a child process. Public keys are not secret and are printed.
 *
 *   keys init               the MAIN pair: key file (default ~/.config/typetorch/keys/<universeId>.key), its public
 *                           key in typetorch.json "signingPublicKeys", and the KEY ASSET (a group-owned Model with
 *                           PublicKeys/RevokedKeys attributes) created through Open Cloud, its id in "keyAssetId".
 *                           Resumes a run that stopped half way.
 *   keys init --fallback    the FALLBACK pair: its own key file (default <universeId>.fallback.key), public key in
 *                           "fallbackPublicKey". `kernel deploy` bakes it into the place.
 *     --force               replaces the fallback pair: the old public key is first added to the key asset's
 *                           RevokedKeys (PATCH + rekey hint); then run `typetorch kernel deploy`.
 *   keys rotate             a new MAIN pair: the key asset gets a new version trusting only it and revoking the old
 *                           main key(s), the key file is replaced, typetorch.json updated, the rekey hint
 *                           (TypeTorch/rekey) is published, and every prod-channel branch's CURRENT head is re-signed
 *                           (`keys resign`). For a lost or leaked main key; no restart.
 *   keys resign             republishes each prod-channel branch's current head as a fresh signed deploy message:
 *                           same artifact and asset, a NEW seq, r = "resign" (kernels update the head, no swap). Under
 *                           the strict rule a head signed by a revoked main key is no longer valid, so this keeps new
 *                           servers booting. Goes through the approval policy like any prod publish.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { flagBool, flagInt, flagString, UsageError, type ParsedArgs } from "../args";
import { updateProjectConfig, type Project } from "../config";
import { registerSecret } from "../env";
import { gitInfo } from "../git";
import { interaction, NotInteractiveError, type Interaction } from "../interact";
import { contentFromConfig, createKeyAsset, mergeKeys, publishRekey, REKEY_TOPIC, updateKeyAsset, type KeyAssetContent } from "../keyasset";
import { assertOutsideRepos, KeyFileError, keyFilePaths, newKeyFile, readKeyFile, writeKeyFile, type KeyRole } from "../keyfiles";
import { bold, dim, emitJson, info, isJson, Stopwatch, warn } from "../log";
import { branchChannel, strictest } from "../naming";
import type { OpenCloud } from "../opencloud";
import { finishRelease, modeFor, type ReleaseRequest } from "./approve";
import { KEY_FILE_FLAGS, openCloud, project, readHistory, registryApi, warnRegistryFallback } from "./common";

export const keysFlags = {
	fallback: "boolean",
	force: "boolean",
	yes: "boolean",
	"moderation-timeout": "string",
	"no-registry": "boolean",
	propose: "boolean",
	"proposed-by": "string",
	...KEY_FILE_FLAGS,
} as const;

/** Open Cloud clients and the terminal, injectable for tests. */
export interface KeysDeps {
	io?: Interaction;
	/** Assets key (create / PATCH the key asset). */
	assets?: OpenCloud;
	/** Deploy key (the rekey hint); optional: without it servers pick up the change on their 10-minute re-read. */
	deploy?: OpenCloud | null;
}

export interface KeysContext {
	proj: Project;
	/** The command line (the approval flags for re-signed heads). */
	args: ParsedArgs;
	paths: Record<KeyRole, string>;
	force: boolean;
	yes: boolean;
	noRegistry: boolean;
	moderationTimeout: number;
	deps: KeysDeps;
}

const assetsClient = (ctx: KeysContext) => ctx.deps.assets ?? openCloud("assets")!;
const deployClient = (ctx: KeysContext) => (ctx.deps.deploy === undefined ? openCloud("deploy", true) : (ctx.deps.deploy ?? undefined));

async function confirm(ctx: KeysContext, question: string) {
	if (ctx.yes) return;
	const io = ctx.deps.io ?? interaction();
	if (!io.interactive) throw new NotInteractiveError(`${question.replace(/\?$/, "")}: needs --yes, or a person at an interactive terminal`);
	if (!(await io.confirm(question))) throw new UsageError("cancelled; nothing changed");
}

function moderationNote(moderation: string, assetId: number) {
	if (moderation !== "Approved") warn(`key asset ${assetId} moderation is ${moderation}: servers can't load the new keys until it is Approved (typetorch doctor checks it)`);
}

async function rekey(ctx: KeysContext): Promise<{ published: boolean; error?: string }> {
	const oc = deployClient(ctx);
	if (!oc) {
		warn(`no Open Cloud deploy key: the ${REKEY_TOPIC} hint was not sent; servers pick up the key asset on their next 10-minute re-read`);
		return { published: false, error: "no deploy key" };
	}
	try {
		await publishRekey(oc, ctx.proj.config.universeId);
		return { published: true };
	} catch (error) {
		warn(`could not publish ${REKEY_TOPIC} (${(error as Error).message}); servers pick up the key asset on their next 10-minute re-read`);
		return { published: false, error: (error as Error).message };
	}
}

// keys init (main) -----------------------------------------------------------------------------------------------------

export async function initMain(ctx: KeysContext) {
	const { proj, paths } = ctx;
	if (ctx.force) throw new UsageError("--force replaces only the fallback key (keys init --fallback --force); a main key is replaced with `typetorch keys rotate`");
	const path = paths.main;
	assertOutsideRepos(path, proj.root);
	const c = proj.config;
	let existing: string | undefined;
	if (existsSync(path)) {
		existing = readKeyFile(path, { role: "main", universeId: c.universeId }).info.publicKey;
		if (c.signingPublicKeys?.length && !c.signingPublicKeys.includes(existing)) {
			throw new KeyFileError(
				`${path} (public ${existing}) is not in typetorch.json "signingPublicKeys" (${c.signingPublicKeys.join(", ")}); use the matching key file (--key-file), or \`typetorch keys rotate\` to replace the main key`,
			);
		}
		if (c.signingPublicKeys?.includes(existing) && c.keyAssetId) {
			if (isJson()) return emitJson({ status: "unchanged", keyFile: path, publicKey: existing, keyAssetId: c.keyAssetId });
			info(`the main key is already set up: ${path}, public ${existing}, key asset ${c.keyAssetId}`);
			info(dim("  `typetorch doctor` checks the key asset and the place; `typetorch keys rotate` replaces the key"));
			return;
		}
	} else if (c.signingPublicKeys?.length) {
		throw new KeyFileError(
			`typetorch.json already lists main keys (${c.signingPublicKeys.join(", ")}) but there is no key file at ${path}. Lost it: \`typetorch keys rotate\` makes a new one and updates the key asset. On another machine: copy the file here, or pass --key-file / set TYPETORCH_KEY_FILE`,
		);
	}
	// The key asset needs the assets key: check for it before anything is written.
	const assets = assetsClient(ctx);
	let publicKey: string;
	let created = false;
	if (existing) {
		publicKey = existing;
		info(`using the existing main key file ${path} (public ${publicKey})`);
	} else {
		const file = newKeyFile("main", c.universeId);
		registerSecret(file.seed);
		writeKeyFile(path, file);
		publicKey = file.publicKey;
		created = true;
		info(`  key file     ${path} (new main key; keep it safe, it is not encrypted)`);
	}
	if (c.fallbackPublicKey === publicKey) throw new KeyFileError("the main key equals the fallback key; they must be separate pairs");
	if (!c.signingPublicKeys?.includes(publicKey)) updateProjectConfig(proj, { signingPublicKeys: [publicKey] });

	const content: KeyAssetContent = { publicKeys: [publicKey], revokedKeys: [...(c.revokedKeys ?? [])] };
	let assetId: number;
	let moderation: string;
	if (proj.config.keyAssetId) {
		({ assetId, moderation } = await updateKeyAsset(assets, proj.config.keyAssetId, content, { moderationTimeout: ctx.moderationTimeout }));
		info(`  key asset    ${assetId} (new version: PublicKeys = this key)`);
	} else {
		({ assetId, moderation } = await createKeyAsset(assets, proj.config, content, {
			moderationTimeout: ctx.moderationTimeout,
			onCreated: (id) => updateProjectConfig(proj, { keyAssetId: id }),
		}));
		info(`  key asset    ${assetId} (created, owned by ${JSON.stringify(proj.config.creator)})`);
	}
	moderationNote(moderation, assetId);
	if (isJson()) return emitJson({ status: created ? "created" : "resumed", keyFile: path, publicKey, keyAssetId: assetId, moderation, config: proj.configPath });
	info(bold(`main signing key ${created ? "created" : "set up"}: public ${publicKey}`));
	info(`  typetorch.json  "signingPublicKeys" and "keyAssetId" updated (${proj.configPath}); commit it`);
	if (!proj.config.fallbackPublicKey) info("  next: `typetorch keys init --fallback`, then `typetorch kernel deploy`, then `typetorch doctor`");
	else info("  next: `typetorch kernel deploy` (stamps KeyAssetId), then `typetorch doctor`");
}

// keys init --fallback ---------------------------------------------------------------------------------------------------

export async function initFallback(ctx: KeysContext) {
	const { proj, paths } = ctx;
	const path = paths.fallback;
	assertOutsideRepos(path, proj.root);
	if (paths.fallback === paths.main) throw new UsageError("the fallback key file must be a different file than the main key file");
	const c = proj.config;
	const exists = existsSync(path);

	if (!ctx.force) {
		if (exists) {
			const { info: file } = readKeyFile(path, { role: "fallback", universeId: c.universeId });
			if (c.fallbackPublicKey === file.publicKey) {
				if (isJson()) return emitJson({ status: "unchanged", keyFile: path, publicKey: file.publicKey });
				info(`the fallback key is already set up: ${path}, public ${file.publicKey}`);
				return;
			}
			if (c.fallbackPublicKey) {
				throw new KeyFileError(
					`${path} (public ${file.publicKey}) is not typetorch.json "fallbackPublicKey" (${c.fallbackPublicKey}); use the matching file (--fallback-key-file), or replace the fallback key with --force (revokes the old one; then kernel deploy)`,
				);
			}
			if (c.signingPublicKeys?.includes(file.publicKey)) throw new KeyFileError(`${path} holds a main key; the fallback must be a separate pair`);
			updateProjectConfig(proj, { fallbackPublicKey: file.publicKey });
			if (isJson()) return emitJson({ status: "resumed", keyFile: path, publicKey: file.publicKey, config: proj.configPath });
			info(bold(`fallback key set up from ${path}: public ${file.publicKey}`));
			info("  next: `typetorch kernel deploy` (bakes it into the place as FallbackPublicKey), then `typetorch doctor`");
			return;
		}
		if (c.fallbackPublicKey) {
			throw new KeyFileError(
				`typetorch.json has a "fallbackPublicKey" (${c.fallbackPublicKey}) but there is no key file at ${path}. Copy it here (or pass --fallback-key-file / set TYPETORCH_FALLBACK_KEY_FILE), or replace the fallback key with \`typetorch keys init --fallback --force\` (revokes the old one) and then \`typetorch kernel deploy\``,
			);
		}
		const file = newKeyFile("fallback", c.universeId);
		registerSecret(file.seed);
		writeKeyFile(path, file);
		updateProjectConfig(proj, { fallbackPublicKey: file.publicKey });
		if (isJson()) return emitJson({ status: "created", keyFile: path, publicKey: file.publicKey, config: proj.configPath });
		info(bold(`fallback signing key created: public ${file.publicKey}`));
		info(`  key file     ${path} (keep it safe and separate from the main key; it is not encrypted)`);
		info(`  typetorch.json  "fallbackPublicKey" updated (${proj.configPath}); commit it`);
		info("  next: `typetorch kernel deploy` (bakes it into the place as FallbackPublicKey), then `typetorch doctor`");
		return;
	}

	// --force: replace the fallback pair; the old public key is revoked in the key asset first.
	let old = c.fallbackPublicKey;
	if (!old && exists) {
		try {
			old = readKeyFile(path, { role: "fallback" }).info.publicKey;
		} catch {}
	}
	const assets = old && c.keyAssetId ? assetsClient(ctx) : undefined; // before anything is written
	await confirm(
		ctx,
		old
			? `Replace the fallback key ${old}? It is added to RevokedKeys in the key asset first; servers keep the old baked-in key until \`typetorch kernel deploy\`.`
			: "Create a new fallback key (replacing any file at the path)?",
	);
	let revokedKeys = c.revokedKeys ?? [];
	let assetResult: { assetId: number; moderation: string } | undefined;
	let rekeyResult: Awaited<ReturnType<typeof rekey>> | undefined;
	if (old) {
		if (!c.keyAssetId) {
			warn(`no key asset yet (typetorch keys init), so the old fallback key ${old} can't be revoked; servers that still have it baked in trust it until \`typetorch kernel deploy\``);
		} else {
			revokedKeys = mergeKeys(c.revokedKeys, [old]);
			assetResult = await updateKeyAsset(assets!, c.keyAssetId, { ...contentFromConfig(c), revokedKeys }, { moderationTimeout: ctx.moderationTimeout });
			updateProjectConfig(proj, { revokedKeys });
			moderationNote(assetResult.moderation, assetResult.assetId);
			info(`  key asset    ${assetResult.assetId}: ${old} added to RevokedKeys`);
			rekeyResult = await rekey(ctx);
		}
	}
	const file = newKeyFile("fallback", proj.config.universeId);
	registerSecret(file.seed);
	writeKeyFile(path, file, { replace: true });
	updateProjectConfig(proj, { fallbackPublicKey: file.publicKey });
	if (isJson()) {
		return emitJson({ status: "replaced", keyFile: path, publicKey: file.publicKey, revoked: old ?? null, keyAsset: assetResult ?? null, rekey: rekeyResult ?? null, config: proj.configPath });
	}
	info(bold(`fallback signing key replaced: public ${file.publicKey}${old ? ` (revoked ${old})` : ""}`));
	info(`  key file     ${path}`);
	info(`  typetorch.json  "fallbackPublicKey"${old && c.keyAssetId ? ` and "revokedKeys"` : ""} updated (${proj.configPath}); commit it`);
	info(bold("  next: `typetorch kernel deploy` to bake the new fallback key into the place (servers restart), then `typetorch doctor`"));
}

// keys rotate ------------------------------------------------------------------------------------------------------------

export async function rotateMain(ctx: KeysContext) {
	const { proj, paths } = ctx;
	const c = proj.config;
	if (!c.keyAssetId) throw new UsageError("there is no key asset yet (typetorch.json \"keyAssetId\"): run `typetorch keys init` first");
	if (!c.signingPublicKeys?.length) throw new UsageError("typetorch.json has no \"signingPublicKeys\": run `typetorch keys init` first");
	const path = paths.main;
	assertOutsideRepos(path, proj.root);
	// The current key file's public key is revoked too (best effort: the file may be lost, which is why we rotate).
	let filePublicKey: string | undefined;
	if (existsSync(path)) {
		try {
			filePublicKey = readKeyFile(path, { role: "main" }).info.publicKey;
		} catch {}
	}
	const revokedKeys = mergeKeys(c.revokedKeys, c.signingPublicKeys, filePublicKey ? [filePublicKey] : []);
	if (c.fallbackPublicKey && revokedKeys.includes(c.fallbackPublicKey)) {
		// never revoke the fallback by rotating the main key
		revokedKeys.splice(revokedKeys.indexOf(c.fallbackPublicKey), 1);
	}
	const assets = assetsClient(ctx); // before anything is written
	await confirm(
		ctx,
		`Rotate the main signing key? The key asset will trust only a new key and revoke ${mergeKeys(c.signingPublicKeys, filePublicKey ? [filePublicKey] : []).join(", ")}; ${path} is replaced.`,
	);

	// The new seed is on disk (next to the key file) before the key asset changes, so it is never lost.
	const fresh = newKeyFile("main", c.universeId);
	registerSecret(fresh.seed);
	const pending = `${path}.new`;
	writeKeyFile(pending, fresh, { replace: true });
	let asset: Awaited<ReturnType<typeof updateKeyAsset>>;
	try {
		asset = await updateKeyAsset(assets, c.keyAssetId, { publicKeys: [fresh.publicKey], revokedKeys }, { moderationTimeout: ctx.moderationTimeout });
	} catch (error) {
		rmSync(pending, { force: true });
		throw new Error(`the key asset was not updated, nothing changed: ${(error as Error).message}`);
	}
	// The key asset now trusts only the new key: put it in place.
	renameSync(pending, path);
	updateProjectConfig(proj, { signingPublicKeys: [fresh.publicKey], revokedKeys });
	moderationNote(asset.moderation, asset.assetId);
	const hint = await rekey(ctx);
	info(bold(`main signing key rotated: public ${fresh.publicKey}`));
	info(`  key file     ${path} (replaced)`);
	info(`  key asset    ${asset.assetId}: PublicKeys = the new key; RevokedKeys = ${revokedKeys.length} key(s)${asset.revisionId ? `; revision ${asset.revisionId}` : ""}`);
	info(`  rekey        ${hint.published ? `${REKEY_TOPIC} published: servers re-read the key asset now` : "not sent (servers re-read the key asset within 10 minutes)"}`);
	info(`  typetorch.json  "signingPublicKeys" and "revokedKeys" updated (${proj.configPath}); commit it`);
	// Heads signed by the revoked key are no longer valid once servers reload the key asset: re-sign the live ones.
	const resigned = await resignHeads(ctx);
	if (isJson()) {
		return emitJson({ status: "rotated", keyFile: path, publicKey: fresh.publicKey, revokedKeys, keyAsset: asset, rekey: hint, resigned, config: proj.configPath });
	}
	info(dim("  no restart needed"));
}

// keys resign --------------------------------------------------------------------------------------------------------

export interface ResignResult {
	branch: string;
	artifactId: string;
	assetId: number;
	/** The head's seq before the re-sign. */
	fromSeq: number;
	outcome: "published" | "proposed" | "declined" | "failed";
	seq?: number;
	proposalId?: string;
	error?: string;
}

/**
 * Republishes each prod-channel branch's current head as a fresh signed deploy message: same artifact and asset, a new
 * seq, r = "resign". Each one follows the approval policy (a person's y/N, a proposal, or published at once) like any
 * prod publish. Failures are reported, not thrown: `typetorch keys resign` retries.
 */
export async function resignHeads(ctx: KeysContext): Promise<ResignResult[]> {
	const { proj } = ctx;
	const oc = deployClient(ctx);
	const api = registryApi(oc, proj, ctx.noRegistry);
	const history = await readHistory(proj, api, ctx.noRegistry ? "--no-registry" : "no deploy key");
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	const heads = [...history.heads.values()]
		.filter((head) => strictest(branchChannel(proj.config, head.branch), history.snapshot?.value.channels[head.branch]) === "prod")
		.sort((a, b) => a.branch.localeCompare(b.branch));
	if (heads.length === 0) {
		info("  resign       no prod-channel heads to re-sign");
		return [];
	}
	const io = ctx.deps.io ?? interaction();
	const by = gitInfo(proj.root).userName;
	const results: ResignResult[] = [];
	for (const head of heads) {
		const base = { branch: head.branch, artifactId: head.artifactId, assetId: head.assetId, fromSeq: head.seq };
		const request: ReleaseRequest = {
			kind: "resign",
			branch: head.branch,
			branchChannel: "prod",
			artifact: {
				artifactId: head.artifactId,
				assetId: head.assetId,
				channel: head.channel,
				commit: head.commit,
				commitHash: head.commitHash,
				dirty: head.dirty ?? false,
				...(head.sources ? { sources: head.sources } : {}),
			},
			changes: [`re-signed with the current keys (was #${head.seq})`],
			force: false,
			by,
			from: head,
		};
		try {
			const { mode, proposer } = modeFor(proj, ctx.args, "prod", io);
			const outcome = await finishRelease({ proj, mode, proposer, request, oc, api: history.snapshot ? api : undefined, history, watch: new Stopwatch(), noRegistry: ctx.noRegistry, keyPaths: ctx.paths, io });
			if (outcome.kind === "published") {
				results.push({ ...base, outcome: "published", seq: outcome.result.entry.seq });
				info(`  resign       ${head.branch}: ${head.artifactId} (asset ${head.assetId}) #${head.seq} -> #${outcome.result.entry.seq}, signed with the current keys`);
			} else {
				results.push({ ...base, outcome: outcome.kind, proposalId: outcome.proposal.id });
				info(`  resign       ${head.branch}: ${outcome.kind === "proposed" ? `proposed, approve with: typetorch approve ${outcome.proposal.id}` : `not published (proposal ${outcome.proposal.id} stays pending)`}`);
			}
		} catch (error) {
			results.push({ ...base, outcome: "failed", error: (error as Error).message });
			warn(`could not re-sign ${head.branch} (${(error as Error).message}); run \`typetorch keys resign\` again`);
		}
	}
	return results;
}

export async function resignCommand(ctx: KeysContext) {
	const results = await resignHeads(ctx);
	if (isJson()) return emitJson({ resigned: results });
	const failed = results.filter((r) => r.outcome === "failed").length;
	if (failed) process.exitCode = 1;
}

export async function keysCommand(args: ParsedArgs, deps: KeysDeps = {}) {
	const sub = args.positionals[0];
	if (sub !== "init" && sub !== "rotate" && sub !== "resign") throw new UsageError(`unknown keys subcommand "${sub ?? ""}" (init, init --fallback, rotate, resign)`);
	const proj = project(args);
	const ctx: KeysContext = {
		proj,
		args,
		paths: keyFilePaths(proj, { keyFile: flagString(args, "key-file"), fallbackKeyFile: flagString(args, "fallback-key-file") }),
		force: flagBool(args, "force"),
		yes: flagBool(args, "yes"),
		noRegistry: flagBool(args, "no-registry"),
		moderationTimeout: flagInt(args, "moderation-timeout", 600),
		deps,
	};
	if (sub === "resign") return resignCommand(ctx);
	if (sub === "rotate") {
		if (flagBool(args, "fallback")) throw new UsageError("keys rotate replaces the main key; the fallback key is replaced with `keys init --fallback --force` + `kernel deploy`");
		if (ctx.force) throw new UsageError("keys rotate takes no --force");
		return rotateMain(ctx);
	}
	return flagBool(args, "fallback") ? initFallback(ctx) : initMain(ctx);
}
