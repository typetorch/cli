/** Helpers shared by the commands. */
import { flagString, UsageError, type ParsedArgs } from "../args";
import { loadProject, type Project } from "../config";
import {
	liveHeads,
	mergeDeployments,
	readLocalLog,
	readUploads,
	type DeploymentRow,
	type LiveHead,
	type LocalDeployment,
	type UploadRecord,
} from "../deployments";
import { settings, type KeyJob } from "../env";
import { debug, warn } from "../log";
import { isChannel, type Channel } from "../naming";
import { OpenCloud } from "../opencloud";
import { REGISTRY_FALLBACK_NOTE, RegistryApi, tryReadRegistry, type RegistrySnapshot } from "../registry";
import { TEST_VECTOR_PUBLIC_KEY, type SigningKey } from "../signing";
import { stateDir } from "../state";

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

let unsignedWarned = false;

/**
 * The deploy signing key (TYPETORCH_SIGNING_KEY), checked against typetorch.json "signingPublicKey". Without a key
 * messages go out unsigned, with a warning (kernel 0.3 servers refuse them).
 */
export function signingKey(proj: Project): SigningKey | undefined {
	const key = settings().signingKey();
	const configured = proj.config.signingPublicKey;
	if (!key) {
		if (!unsignedWarned) {
			unsignedWarned = true;
			warn(
				`deploy messages are unsigned (no TYPETORCH_SIGNING_KEY): kernel 0.3 servers will refuse them. Run \`typetorch keys init\`${configured ? " or restore the key for typetorch.json signingPublicKey" : ""}.`,
			);
		}
		return undefined;
	}
	if (key.publicKey === TEST_VECTOR_PUBLIC_KEY || configured === TEST_VECTOR_PUBLIC_KEY) {
		throw new Error("the signing key is the public test-vector key from plans/03; run `typetorch keys init --force` for a real one");
	}
	if (configured && configured !== key.publicKey) {
		throw new Error(
			`TYPETORCH_SIGNING_KEY (from ${key.source}) does not match typetorch.json "signingPublicKey"; servers would refuse its signatures. Use the matching key, or run \`typetorch keys init --force\` and redeploy the kernel.`,
		);
	}
	if (!configured) warn(`typetorch.json has no "signingPublicKey" for the signing key from ${key.source}; add it (typetorch keys init prints it) so kernel deploys bake it in`);
	return key;
}

export interface History {
	snapshot?: RegistrySnapshot;
	/** Why the registry wasn't read (no key, --no-registry, missing scope...). */
	unavailable?: string;
	local: LocalDeployment[];
	rows: DeploymentRow[];
	heads: Map<string, LiveHead>;
	uploads: UploadRecord[];
	stateDir: string;
}

let fallbackWarned = false;

/** Warns once per run that deploys continue without the registry. */
export function warnRegistryFallback(reason: string) {
	if (fallbackWarned) return;
	fallbackWarned = true;
	warn(REGISTRY_FALLBACK_NOTE);
	debug(`registry unavailable: ${reason}`);
}

/** Registry (when readable) + local log, merged, with each branch's live head. */
export async function readHistory(
	proj: Project,
	api: RegistryApi | undefined,
	reasonIfNoApi = "no API key",
): Promise<History> {
	let snapshot: RegistrySnapshot | undefined;
	let unavailable: string | undefined;
	if (api) {
		const read = await tryReadRegistry(api);
		snapshot = read.snapshot;
		unavailable = read.unavailable;
	} else {
		unavailable = reasonIfNoApi;
	}
	return withLocal(proj, snapshot, unavailable);
}

export function withLocal(proj: Project, snapshot: RegistrySnapshot | undefined, unavailable?: string): History {
	const dir = projectStateDir(proj);
	const local = readLocalLog(dir, proj.config.universeId);
	const rows = mergeDeployments(snapshot?.value.deployments ?? [], local);
	return {
		snapshot,
		unavailable,
		local,
		rows,
		heads: liveHeads(snapshot?.value, rows),
		uploads: readUploads(dir, proj.config.universeId),
		stateDir: dir,
	};
}

export function registryApi(oc: OpenCloud | undefined, proj: Project, disabled: boolean): RegistryApi | undefined {
	return oc && !disabled ? new RegistryApi(oc, proj.config.universeId) : undefined;
}
