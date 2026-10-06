/** Helpers shared by the commands. */
import { flagString, UsageError, type ParsedArgs } from "../args.ts";
import { loadProject, type Project } from "../config.ts";
import {
	liveHeads,
	mergeDeployments,
	readLocalLog,
	readUploads,
	type DeploymentRow,
	type LiveHead,
	type LocalDeployment,
	type UploadRecord,
} from "../deployments.ts";
import { settings, type KeyJob } from "../env.ts";
import { dim, info, warn } from "../log.ts";
import { isChannel, type Channel } from "../naming.ts";
import { OpenCloud } from "../opencloud.ts";
import { stateDir } from "../state.ts";
import { keyFilePaths, loadSigner, SigningSetupError, type KeyRole } from "../keyfiles.ts";
import { keyFingerprint, type DualSigner } from "../signing.ts";

export function project(args: ParsedArgs): Project {
	const loaded = loadProject(flagString(args, "config"));
	for (const warning of loaded.warnings) warn(`typetorch.json: ${warning}`);
	return loaded;
}

export function channelFlag(args: ParsedArgs): Channel | undefined {
	const value = flagString(args, "channel");
	if (value === undefined) return undefined;
	if (!isChannel(value)) throw new UsageError(`--channel must be "prod" or "dev", got "${value}"`);
	return value;
}

/**
 * An Open Cloud client holding the key for one job (its own key, else the shared one); with `optional`, undefined when
 * no key is configured (dry runs). The key goes only into this client, never into the environment.
 */
export function openCloud(job: KeyJob, optional = false): OpenCloud | undefined {
	if (optional) {
		const key = settings().apiKey(job);
		return key ? new OpenCloud(key.key) : undefined;
	}
	return new OpenCloud(settings().requireApiKey(job).key);
}

/** The project's state dir (TYPETORCH_STATE_DIR, else `<root>/.typetorch`). */
export function projectStateDir(proj: Project): string {
	return stateDir(proj.root);
}

/** The local log (and what it knows of each branch). CLI 0.8: there is no ConfigService registry to merge any more. */
export interface History {
	local: LocalDeployment[];
	rows: DeploymentRow[];
	heads: Map<string, LiveHead>;
	uploads: UploadRecord[];
	stateDir: string;
}

let registryFlagNoted = false;

/**
 * CLI 0.8: `--no-registry` and `--require-registry` are accepted and do nothing (scripts pass them); one note per run.
 * There is no ConfigService registry any more (kernel 0.3.8 reads the signed settings record; plans/20).
 */
export function noteRegistryFlags(args: ParsedArgs) {
	const used = ["no-registry", "require-registry"].filter((flag) => args.flags[flag] !== undefined);
	if (used.length === 0 || registryFlagNoted) return;
	registryFlagNoted = true;
	info(dim(`note: --${used.join(" and --")} ${used.length > 1 ? "do" : "does"} nothing since CLI 0.8 (no ConfigService registry; settings live in the signed settings record)`));
}

/** The local log, with each branch's live head. */
export async function readHistory(proj: Project): Promise<History> {
	return withLocal(proj);
}

export function withLocal(proj: Project): History {
	const dir = projectStateDir(proj);
	const local = readLocalLog(dir, proj.config.universeId);
	const rows = mergeDeployments([], local);
	return {
		local,
		rows,
		heads: liveHeads(undefined, rows),
		uploads: readUploads(dir, proj.config.universeId),
		stateDir: dir,
	};
}

// Signing (prod-channel branches only) -------------------------------------------------------------------------------

/** The flags every releasing command takes for the key files. */
export const KEY_FILE_FLAGS = { "key-file": "string", "fallback-key-file": "string" } as const;

/** The key files for this command: --key-file / --fallback-key-file, else the real environment, else the defaults. */
export function signingKeyPaths(proj: Project, args?: ParsedArgs): Record<KeyRole, string> {
	return keyFilePaths(proj, { keyFile: args ? flagString(args, "key-file") : undefined, fallbackKeyFile: args ? flagString(args, "fallback-key-file") : undefined });
}

/**
 * Both keys for something that is always signed (the settings record, plans/20): throws SigningSetupError that starts
 * with `why` and says to run `typetorch keys init` (+ `--fallback`) when they aren't set up.
 */
export function loadSignerOrExplain(proj: Project, paths: Record<KeyRole, string>, why: string): DualSigner {
	try {
		return loadSigner(proj, paths);
	} catch (error) {
		if (!(error instanceof SigningSetupError)) throw error;
		throw new SigningSetupError(`${why}: ${error.message}. Set them up with \`typetorch keys init\` and \`typetorch keys init --fallback\``);
	}
}

/** Both keys for a prod-channel branch (throws SigningSetupError with what to do); undefined for a dev-channel one. */
export function signerFor(proj: Project, branchChannel: Channel, paths: Record<KeyRole, string>): DualSigner | undefined {
	return branchChannel === "prod" ? loadSigner(proj, paths) : undefined;
}

export type SigningStatus =
	| { required: false }
	| { required: true; ready: true; mainKey: string; fallbackKey: string }
	| { required: true; ready: false; problem: string };

/** Whether a release to this channel will be signed, and whether the keys are there (dry runs; no signature is made). */
export function signingStatus(proj: Project, branchChannel: Channel, paths: Record<KeyRole, string>): SigningStatus {
	if (branchChannel !== "prod") return { required: false };
	try {
		const signer = loadSigner(proj, paths);
		return { required: true, ready: true, mainKey: signer.files.main.publicKey, fallbackKey: signer.files.fallback.publicKey };
	} catch (error) {
		return { required: true, ready: false, problem: (error as Error).message };
	}
}

export function describeSigning(status: SigningStatus): string {
	if (!status.required) return "unsigned (dev-channel branch)";
	if (status.ready) return `sig (main key ${keyFingerprint(status.mainKey)}) + sigF (fallback key ${keyFingerprint(status.fallbackKey)}), made when published`;
	return `NOT READY: ${status.problem}`;
}
