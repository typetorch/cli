/**
 * `typetorch pin`: A/B experiment pins on live servers from the CLI (kernel 0.2.3 topic `TypeTorch/pin`). Messages to a
 * prod-channel branch are signed with both keys (plans/03 "Signed pins"); dev-channel ones are unsigned.
 *
 *   typetorch pin <artifact> --branch <b> (--servers <jobId,...> | --pct <1-99>) [--by <userId>]
 *   typetorch pin --unpin --branch <b> (--servers <jobId,...> | --all) [<artifact>] [--by <userId>]
 *
 * Message (kernel 0.2.3 fields, this order): {j?, pct?, a?, b, by, t, unpin?} plus sig/sigF on prod. `--all` is
 * pct 100. JobIds that don't fit one 1 KiB message are split over several messages, each signed on its own.
 * `by` is the user's id: --by, else the single "owner" in typetorch.json members, else the creator userId; servers
 * check that it is an owner or admin.
 *
 * Approval follows the typetorch.json policy like a deploy: when it applies, a person at the terminal answers y/N
 * (pins can't wait as proposals: the kernel drops pins older than 120 s, and `t` is set when published). Signing
 * happens right before publishing; dry runs show placeholders.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flagBool, flagString, UsageError, type ParsedArgs } from "../args.ts";
import type { Project } from "../config.ts";
import { matchDeployment, type UploadRecord } from "../deployments.ts";
import { gitInfo } from "../git.ts";
import { interaction, NotInteractiveError, type Interaction } from "../interact.ts";
import { bold, emitJson, info, isJson, yellow } from "../log.ts";
import { branchChannel, branchNameError, strictest, type Channel } from "../naming.ts";
import { encodePinMessage, PIN_TOPIC, pinMessage, type OpenCloud, type PinMessage } from "../opencloud.ts";
import { JOB_ID_PATTERN, type DualSigner, type PinFields } from "../signing.ts";
import { modeFor } from "./approve.ts";
import {
	describeSigning,
	KEY_FILE_FLAGS,
	openCloud,
	project,
	projectStateDir,
	readHistory,
	registryApi,
	signerFor,
	signingKeyPaths,
	signingStatus,
	warnRegistryFallback,
	type History,
} from "./common.ts";
import { SIGNATURE_PLACEHOLDER } from "./release.ts";

export const pinFlags = {
	branch: "string",
	servers: "string",
	pct: "string",
	all: "boolean",
	unpin: "boolean",
	by: "string",
	"dry-run": "boolean",
	"no-registry": "boolean",
	...KEY_FILE_FLAGS,
} as const;

export const PIN_LOG = "pins.jsonl";
/** kernel 0.2.3 refuses more JobIds in one message. */
export const MAX_JOBS = 100;

export interface PinTarget {
	/** JobIds, or undefined for a percentage. */
	jobs?: string[];
	/** 1-99 for a pin; 100 = every server of the branch (unpin --all). */
	pct?: number;
}

/** --servers / --pct / --all, checked: pin takes servers or pct 1-99; unpin takes servers or all. */
export function pinTarget(input: { unpin: boolean; servers?: string; pct?: string; all: boolean }): PinTarget {
	const given = [input.servers !== undefined, input.pct !== undefined, input.all].filter(Boolean).length;
	const choices = input.unpin ? "--servers <jobId,...> or --all" : "--servers <jobId,...> or --pct <1-99>";
	if (given !== 1) throw new UsageError(`pass exactly one of ${choices}`);
	if (input.unpin && input.pct !== undefined) throw new UsageError("--unpin takes --servers or --all (not --pct)");
	if (!input.unpin && input.all) throw new UsageError("--all is only for --unpin; a pin takes --servers or --pct <1-99>");
	if (input.all) return { pct: 100 };
	if (input.pct !== undefined) {
		if (!/^\d+$/.test(input.pct) || Number(input.pct) < 1 || Number(input.pct) > 99) throw new UsageError(`--pct must be a whole number from 1 to 99, got "${input.pct}"`);
		return { pct: Number(input.pct) };
	}
	const jobs: string[] = [];
	for (const raw of input.servers!.split(",")) {
		const job = raw.trim();
		if (job === "") continue;
		if (!JOB_ID_PATTERN.test(job)) throw new UsageError(`not a JobId: "${job}"`);
		if (!jobs.includes(job)) jobs.push(job);
	}
	if (jobs.length === 0) throw new UsageError("--servers needs at least one JobId");
	if (jobs.length > MAX_JOBS) throw new UsageError(`at most ${MAX_JOBS} servers per pin (got ${jobs.length}); use --pct`);
	return { jobs };
}

/** The userId the pin is sent as: --by, else the only "owner" in typetorch.json members, else the creator userId. */
export function pinBy(proj: Pick<Project, "config">, flag?: string): number {
	if (flag !== undefined) {
		if (!/^\d+$/.test(flag) || !Number.isSafeInteger(Number(flag)) || Number(flag) < 1) throw new UsageError(`--by must be a userId, got "${flag}"`);
		return Number(flag);
	}
	const owners = Object.entries(proj.config.members)
		.filter(([, role]) => role === "owner")
		.map(([id]) => Number(id));
	if (owners.length === 1) return owners[0];
	if ("userId" in proj.config.creator) return proj.config.creator.userId;
	throw new UsageError(`which user sends the pin? pass --by <your userId> (servers accept owners and admins; typetorch.json members has ${owners.length} owners)`);
}

/** Splits the JobIds over as many messages as needed so each signed message fits 1 KiB (order kept). */
export function pinMessages(fields: Omit<PinFields, "j" | "t">, target: PinTarget, signed: boolean, t = Date.now()): Omit<PinFields, "t">[] {
	const placeholder = signed ? { sig: SIGNATURE_PLACEHOLDER, sigF: SIGNATURE_PLACEHOLDER } : {};
	const fits = (jobs: string[]) => {
		try {
			encodePinMessage({ ...pinMessage({ ...fields, j: jobs, t }), ...placeholder });
			return true;
		} catch {
			return false;
		}
	};
	if (!target.jobs) {
		encodePinMessage({ ...pinMessage({ ...fields, pct: target.pct, t }), ...placeholder });
		return [{ ...fields, pct: target.pct }];
	}
	const out: Omit<PinFields, "t">[] = [];
	let chunk: string[] = [];
	for (const job of target.jobs) {
		if (fits([...chunk, job])) chunk.push(job);
		else {
			if (chunk.length === 0) throw new Error(`a pin message for JobId ${job} doesn't fit 1 KiB (branch name too long?)`);
			out.push({ ...fields, j: chunk });
			chunk = [job];
		}
	}
	if (chunk.length) out.push({ ...fields, j: chunk });
	return out;
}

interface Candidate {
	artifactId: string;
	assetId: number;
	channel: Channel;
	moderation: string;
	from: string;
}

function findArtifact(history: History, wanted: string, branch: string): Candidate | undefined {
	const deployed = matchDeployment(history.rows, wanted, branch);
	if (deployed) return { artifactId: deployed.artifactId, assetId: deployed.assetId, channel: deployed.channel, moderation: "Approved", from: `#${deployed.seq} on ${deployed.branch}` };
	const upload = matchDeployment(
		history.uploads.map((u: UploadRecord) => ({ ...u, seq: -1 })),
		wanted,
		branch,
	);
	return upload ? { artifactId: upload.artifactId, assetId: upload.assetId, channel: upload.channel, moderation: upload.moderation, from: "an upload" } : undefined;
}

export interface PinDeps {
	io?: Interaction;
	/** Client with the deploy key (messaging); default from the settings. */
	oc?: OpenCloud;
	signer?: DualSigner;
	now?: () => number;
}

export async function pinCommand(args: ParsedArgs, deps: PinDeps = {}) {
	const proj = project(args);
	const unpin = flagBool(args, "unpin");
	const dryRun = flagBool(args, "dry-run");
	const branch = flagString(args, "branch");
	if (!branch) throw new UsageError("which branch? pass --branch <b>");
	if (branchNameError(branch)) throw new UsageError(branchNameError(branch)!);
	const wanted = args.positionals[0];
	if (!unpin && !wanted) throw new UsageError("usage: typetorch pin <artifactId|assetId|#seq|commit> --branch <b> (--servers <jobId,...> | --pct <1-99>)");
	const target = pinTarget({ unpin, servers: flagString(args, "servers"), pct: flagString(args, "pct"), all: flagBool(args, "all") });
	const by = pinBy(proj, flagString(args, "by"));

	const noRegistry = flagBool(args, "no-registry");
	const oc = deps.oc ?? openCloud("deploy", true);
	const api = registryApi(oc, proj, noRegistry);
	const history = await readHistory(proj, api, noRegistry ? "--no-registry" : "no API key");
	if (!history.snapshot && api) warnRegistryFallback(history.unavailable ?? "unknown");
	const channel = strictest(branchChannel(proj.config, branch), history.snapshot?.value.channels[branch]);

	let artifact: Candidate | undefined;
	if (wanted) {
		artifact = findArtifact(history, wanted, branch);
		if (!artifact) throw new Error(`nothing matches "${wanted}" in the deployments or uploads (${history.stateDir}); try a #seq, asset id, artifact id or commit from \`typetorch deployments\``);
		if (artifact.moderation !== "Approved") throw new Error(`asset ${artifact.assetId} moderation is ${artifact.moderation}; only Approved assets can be pinned`);
	}
	const signed = channel === "prod";
	const fields = { b: branch, by, ...(artifact ? { a: artifact.assetId } : {}), ...(unpin ? { unpin: true as const } : {}) };
	const now = deps.now ?? Date.now;
	const planned = pinMessages(fields, target, signed, now());
	const keyPaths = signingKeyPaths(proj, args);
	const what = `${unpin ? "unpin" : "pin"}${artifact ? ` ${artifact.artifactId} (asset ${artifact.assetId}, ${artifact.channel} channel, from ${artifact.from})` : ""} on ${branch} (${channel}-channel branch), ${target.jobs ? `${target.jobs.length} server(s)` : target.pct === 100 ? "every server" : `${target.pct}% of servers`}, by ${by}`;

	if (dryRun) {
		const signing = signingStatus(proj, channel, keyPaths);
		const ending = modeFor(proj, args, channel, deps.io).mode.kind;
		const messages = planned.map((m) => ({ ...pinMessage({ ...m, t: now() }), ...(signed ? { sig: SIGNATURE_PLACEHOLDER, sigF: SIGNATURE_PLACEHOLDER } : {}) }));
		if (isJson()) return emitJson({ dryRun: true, branch, channel, artifact: artifact ?? null, target, by, approval: { policy: proj.config.approval, ending }, signing, topic: PIN_TOPIC, messages });
		info(bold(`dry run: would ${what}`));
		info(`  approval  policy "${proj.config.approval}": ${ending === "propose" ? "needs you at a terminal (pins can't be proposed)" : ending}`);
		info(`  signing   ${describeSigning(signing)}`);
		for (const m of messages) info(`  message   ${PIN_TOPIC} ${JSON.stringify(m)}`);
		return;
	}

	// Approval (the policy, like a deploy), then the keys, then publish.
	const io = deps.io ?? interaction();
	const { mode, proposer } = modeFor(proj, args, channel, io);
	if (signed && proposer.name.startsWith("dev-server")) throw new Error(`the dev-server never pins on prod-channel branch ${branch}`);
	if (mode.kind === "propose") {
		throw new NotInteractiveError(`${unpin ? "unpinning" : "pinning"} on ${branch} needs your approval at an interactive terminal (pins can't wait as proposals: servers drop them after 120 s)`);
	}
	const signer = signed ? (deps.signer ?? signerFor(proj, channel, keyPaths)) : undefined;
	const client = oc ?? openCloud("deploy")!;
	if (mode.kind === "approve-now") {
		info(bold(what));
		if (artifact && channel === "prod" && artifact.channel !== "prod") info(yellow("  DEV-CHANNEL artifact on prod servers (an A/B experiment): players on the picked servers run it"));
		if (channel === "prod") info(yellow("  PROD       public servers") + "; signed with sig (main key) + sigF (fallback key) when published");
		info(`  messages   ${planned.length} on ${PIN_TOPIC}`);
		if (!(await io.confirm(`Publish this ${unpin ? "unpin" : "pin"}?`))) {
			info("not published");
			return;
		}
	}
	const approver = gitInfo(proj.root).userName;
	const sent: PinMessage[] = [];
	for (const planned1 of planned) {
		const message = pinMessage({ ...planned1, t: now() }, signer);
		await client.publishMessage(proj.config.universeId, PIN_TOPIC, encodePinMessage(message));
		sent.push(message);
	}
	const dir = projectStateDir(proj);
	mkdirSync(dir, { recursive: true });
	appendFileSync(
		join(dir, PIN_LOG),
		JSON.stringify({
			at: new Date().toISOString(),
			event: unpin ? "unpinned" : "pinned",
			universeId: proj.config.universeId,
			branch,
			channel,
			...(artifact ? { artifactId: artifact.artifactId, assetId: artifact.assetId, artifactChannel: artifact.channel } : {}),
			...(target.jobs ? { jobs: target.jobs } : { pct: target.pct }),
			by,
			signed,
			messages: sent.length,
			approvedBy: mode.kind === "approve-now" ? approver : undefined,
			proposedBy: proposer.name,
		}) + "\n",
	);
	if (isJson()) return emitJson({ branch, channel, artifact: artifact ?? null, target, by, signed, topic: PIN_TOPIC, messages: sent });
	info(bold(`${unpin ? "unpinned" : "pinned"}: ${what}${signed ? " (signed)" : ""}`));
	if (!unpin) info("  holds until the next deploy reaches those servers, an unpin, or the server closes");
}
