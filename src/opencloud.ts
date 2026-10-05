/**
 * A small Open Cloud client (fetch only): assets (create, operation polling, moderation polling), MessagingService
 * publish and place publishing. The configs API (the interim registry) is in registry.ts.
 * The API key goes only into the `x-api-key` header; it is never logged.
 */
import { debug } from "./log";
import { redact } from "./env";
import type { Channel } from "./naming";
import { RESIGN, signDual, signPinDual, type DualSigner, type PinFields } from "./signing";

export const API = "https://apis.roblox.com";

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly method: string,
		readonly path: string,
		readonly status: number,
		readonly body: unknown,
		readonly text: string,
	) {
		super(redact(`${method} ${path} -> ${status}${text ? `: ${text.slice(0, 2000)}` : ""}`));
	}

	/** True for Open Cloud's "Scope not authorized"-style refusals. */
	get isScopeError(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

export interface ApiResponse {
	status: number;
	ok: boolean;
	body: any;
	text: string;
	headers: Headers;
}

export interface LuauTaskResult {
	state: string;
	results: unknown[];
	error?: unknown;
	/** The task's resource path (it names the place version the task ran on). */
	path?: string;
	/** With `binaryOutput`: where the task's buffer can be downloaded (15 minutes). */
	binaryOutputUri?: string;
}

export interface PlaceVersion {
	version: number;
	published: boolean;
	/** Whether the API sent a `published` boolean at all for this version. */
	hasPublishedField: boolean;
}

export interface RequestOptions {
	headers?: Record<string, string>;
	/** Sent as JSON with content-type application/json. */
	json?: unknown;
	body?: RequestInit["body"];
	/** Per-attempt timeout (default 60 s). */
	timeoutMs?: number;
	/** Retry 429/5xx/network errors (default: only for GET). */
	retry?: boolean;
}

export class OpenCloud {
	constructor(private readonly apiKey: string) {}

	/** One request; never throws for HTTP errors (see `call`). Retries 429, 5xx and network errors when allowed. */
	async request(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
		const url = path.startsWith("http") ? path : `${API}${path}`;
		const headers: Record<string, string> = { "x-api-key": this.apiKey, ...(options.headers ?? {}) };
		let body = options.body;
		if (options.json !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(options.json);
		}
		const retry = options.retry ?? method === "GET";
		const attempts = retry ? 4 : 1;
		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const started = performance.now();
			try {
				const response = await fetch(url, {
					method,
					headers,
					body,
					signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
				});
				const text = await response.text();
				let parsed: any = text;
				try {
					parsed = text ? JSON.parse(text) : undefined;
				} catch {}
				debug(`${method} ${path} -> ${response.status} (${Math.round(performance.now() - started)} ms)`);
				if (retry && attempt < attempts && (response.status === 429 || response.status >= 500)) {
					await Bun.sleep(500 * 2 ** (attempt - 1));
					continue;
				}
				return { status: response.status, ok: response.ok, body: parsed, text, headers: response.headers };
			} catch (error) {
				lastError = error;
				debug(`${method} ${path} failed: ${error}`);
				if (attempt < attempts) await Bun.sleep(500 * 2 ** (attempt - 1));
			}
		}
		throw new Error(redact(`${method} ${path} failed: ${(lastError as Error)?.message ?? lastError}`));
	}

	/** A request that must succeed: returns the parsed body, throws ApiError otherwise. */
	async call(method: string, path: string, options: RequestOptions = {}): Promise<any> {
		const response = await this.request(method, path, options);
		if (!response.ok) throw new ApiError(method, path, response.status, response.body, response.text);
		return response.body;
	}

	// Assets ---------------------------------------------------------------------------------------------------------

	/** Starts creating a NEW Model asset from an .rbxm. Returns the operation id. */
	async createModelAsset(input: {
		bytes: Uint8Array;
		fileName: string;
		displayName: string;
		description: string;
		creator: { groupId: number } | { userId: number };
	}): Promise<string> {
		const creator =
			"groupId" in input.creator ? { groupId: String(input.creator.groupId) } : { userId: String(input.creator.userId) };
		const form = new FormData();
		form.append(
			"request",
			JSON.stringify({
				assetType: "Model",
				displayName: input.displayName,
				description: input.description,
				creationContext: { creator },
			}),
		);
		form.append("fileContent", new Blob([input.bytes], { type: "model/x-rbxm" }), input.fileName);
		const created = await this.call("POST", "/assets/v1/assets", { body: form, timeoutMs: 300_000 });
		const operationId = created?.operationId ?? String(created?.path ?? "").split("/").pop();
		if (!operationId) throw new Error(`asset create returned no operation: ${JSON.stringify(created)}`);
		return operationId;
	}

	/**
	 * Starts adding a NEW VERSION to an existing Model asset from an .rbxm (`PATCH /assets/v1/assets/{id}`; spike S1b:
	 * works for Models, about 1.3 s, Approved). Used for the key asset. Returns the operation id.
	 */
	async updateModelAsset(input: { assetId: number; bytes: Uint8Array; fileName: string }): Promise<string> {
		const form = new FormData();
		form.append("request", JSON.stringify({ assetId: input.assetId }));
		form.append("fileContent", new Blob([input.bytes], { type: "model/x-rbxm" }), input.fileName);
		const patched = await this.call("PATCH", `/assets/v1/assets/${input.assetId}`, { body: form, timeoutMs: 300_000 });
		const operationId = patched?.operationId ?? String(patched?.path ?? "").split("/").pop();
		if (!operationId) throw new Error(`asset update returned no operation: ${JSON.stringify(patched)}`);
		return operationId;
	}

	/** Polls an assets operation until done. `request` sets each poll's timeout and retries (default: 60 s, 4 tries). */
	async waitForOperation(operationId: string, timeoutSeconds = 600, request: Pick<RequestOptions, "timeoutMs" | "retry"> = {}): Promise<any> {
		const started = performance.now();
		let delay = 500;
		while (true) {
			const operation = await this.call("GET", `/assets/v1/operations/${operationId}`, request);
			if (operation?.done) return operation;
			if ((performance.now() - started) / 1000 > timeoutSeconds) {
				throw new Error(`asset operation ${operationId} not done after ${timeoutSeconds} s`);
			}
			await Bun.sleep(delay);
			delay = Math.min(delay * 1.5, 5000);
		}
	}

	/** Polls an asset until moderation leaves "Reviewing" (or the timeout passes). */
	async waitForModeration(assetId: number, timeoutSeconds = 600): Promise<{ state?: string; timedOut: boolean }> {
		const started = performance.now();
		let delay = 500;
		while (true) {
			const asset = await this.call("GET", `/assets/v1/assets/${assetId}?readMask=moderationResult`);
			const state: string | undefined = asset?.moderationResult?.moderationState;
			if (state && state !== "Reviewing") return { state, timedOut: false };
			if ((performance.now() - started) / 1000 > timeoutSeconds) return { state, timedOut: true };
			await Bun.sleep(delay);
			delay = Math.min(delay * 1.5, 15_000);
		}
	}

	// Messaging ------------------------------------------------------------------------------------------------------

	async publishMessage(universeId: number, topic: string, message: string): Promise<void> {
		if (new TextEncoder().encode(message).length > 1024) throw new Error("MessagingService messages are limited to 1 KiB");
		await this.call("POST", `/cloud/v2/universes/${universeId}:publishMessage`, {
			json: { topic, message },
			retry: true,
		});
	}

	// Luau Execution -------------------------------------------------------------------------------------------------

	/**
	 * Runs a Luau script in a headless server of the place (Open Cloud Luau Execution; scopes
	 * universe.place.luau-execution-session:read + :write) and returns its return values. Spike S9.
	 * `version`: run against that place version (`/versions/{n}/...`) instead of the latest one.
	 * `binaryOutput`: `enableBinaryOutput`; the script then returns `{BinaryOutput = buffer, ReturnValues = {...}}`,
	 * `results` are the ReturnValues and `binaryOutputUri` (valid 15 min) holds the buffer (`downloadBinaryOutput`).
	 */
	async runLuau(
		universeId: number,
		placeId: number,
		script: string,
		timeoutSeconds = 60,
		options: { version?: number; binaryOutput?: boolean } = {},
	): Promise<LuauTaskResult> {
		const base = `/cloud/v2/universes/${universeId}/places/${placeId}${options.version !== undefined ? `/versions/${options.version}` : ""}`;
		const task = await this.call("POST", `${base}/luau-execution-session-tasks`, {
			json: { script, timeout: `${timeoutSeconds}s`, ...(options.binaryOutput ? { enableBinaryOutput: true } : {}) },
		});
		let current = task;
		const started = performance.now();
		while (current?.state === "QUEUED" || current?.state === "PROCESSING") {
			if ((performance.now() - started) / 1000 > timeoutSeconds + 60) throw new Error(`Luau Execution task ${task?.path} still ${current.state}`);
			await Bun.sleep(1500);
			current = await this.call("GET", `/cloud/v2/${task.path}`);
		}
		return {
			state: String(current?.state),
			results: Array.isArray(current?.output?.results) ? current.output.results : [],
			error: current?.error,
			path: typeof (current?.path ?? task?.path) === "string" ? (current?.path ?? task?.path) : undefined,
			...(typeof current?.binaryOutputUri === "string" ? { binaryOutputUri: current.binaryOutputUri } : {}),
		};
	}

	/**
	 * Downloads a task's binary output. The URI is presigned: the API key is sent only when it points at
	 * apis.roblox.com, never to another host, and the URI (it carries a signature) is never logged.
	 */
	async downloadBinaryOutput(uri: string, timeoutMs = 300_000): Promise<Uint8Array> {
		const url = new URL(uri);
		if (url.protocol !== "https:") throw new Error(`refusing a binary output URI that isn't https (${url.protocol}//${url.hostname})`);
		const headers: Record<string, string> = url.hostname === "apis.roblox.com" ? { "x-api-key": this.apiKey } : {};
		let last = "";
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
				debug(`GET binary output from ${url.hostname} -> ${response.status}`);
				if (response.ok) return new Uint8Array(await response.arrayBuffer());
				last = `${response.status} ${(await response.text()).slice(0, 300)}`;
				if (response.status !== 429 && response.status < 500) break;
			} catch (error) {
				last = String((error as Error)?.message ?? error);
			}
			if (attempt < 3) await Bun.sleep(500 * 2 ** (attempt - 1));
		}
		throw new Error(redact(`downloading the task's binary output from ${url.hostname} failed: ${last}`));
	}

	/**
	 * A place's versions, newest first (Assets API; asset:read on the place), up to `maxPages` pages of 50.
	 * `published` is the Assets API's flag ("only applies to place asset types"); JSON leaves false out.
	 */
	async placeVersions(placeId: number, maxPages = 3): Promise<PlaceVersion[]> {
		const versions: PlaceVersion[] = [];
		let pageToken: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const query = `maxPageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
			const body = await this.call("GET", `/assets/v1/assets/${placeId}/versions?${query}`);
			for (const entry of Array.isArray(body?.assetVersions) ? body.assetVersions : []) {
				const version = typeof entry?.path === "string" ? Number(entry.path.split("/").pop()) : Number.NaN;
				if (Number.isSafeInteger(version)) versions.push({ version, published: entry.published === true, hasPublishedField: typeof entry.published === "boolean" });
			}
			pageToken = typeof body?.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
			if (!pageToken) break;
		}
		return versions;
	}

	// Places ---------------------------------------------------------------------------------------------------------

	/** Publishes a place file (.rbxl) as the new live version. Returns the response ({ versionNumber }). */
	async publishPlace(universeId: number, placeId: number, bytes: Uint8Array): Promise<any> {
		return this.call("POST", `/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`, {
			headers: { "content-type": "application/octet-stream" },
			body: bytes,
			timeoutMs: 300_000,
		});
	}

	/**
	 * The newest version number of a place (Assets API version list; needs asset:read on the place). Used to record
	 * the version before a kernel deploy. Throws when the key can't read it.
	 */
	async latestPlaceVersion(placeId: number): Promise<number> {
		const body = await this.call("GET", `/assets/v1/assets/${placeId}/versions?maxPageSize=1`);
		const path: unknown = body?.assetVersions?.[0]?.path;
		const version = typeof path === "string" ? Number(path.split("/").pop()) : Number.NaN;
		if (!Number.isSafeInteger(version)) throw new Error(`no version in the place's version list: ${JSON.stringify(body).slice(0, 300)}`);
		return version;
	}
}

export const DEPLOY_TOPIC = "TypeTorch/deploy";
/** Tells servers to re-read the key asset now (plans/03 "Rekey hint"): `{"t": unixMs}`, unsigned, a hint only. */
export const REKEY_TOPIC = "TypeTorch/rekey";
/** Experiment pins (kernel 0.2.3; signed for prod-channel branches, plans/03 "Signed pins"). */
export const PIN_TOPIC = "TypeTorch/pin";
export const MESSAGE_LIMIT = 1024;

/**
 * The deploy message the kernel reads (Kernel.server.luau onDeployMessage). At most 1 KiB. Servers on branch `b` swap
 * to it and persist it as their branch head (higher seq wins), so it carries everything a head needs even when the
 * configs registry isn't writable. Messages to prod-channel branches carry `sig` (main key) and `sigF` (fallback key)
 * over the canonical string of the other fields (signing.ts; plans/03 "Signed prod messages and heads"); messages to
 * dev-channel branches are unsigned.
 */
export interface DeployMessage {
	/** Branch: only servers on this branch swap. */
	b: string;
	/** Payload asset id. */
	a: number;
	/** Artifact id. */
	i: string;
	/** Deployment seq (higher wins). */
	s: number;
	/** Short commit. */
	c: string;
	/** Artifact channel. */
	ch: Channel;
	/** Sent at (unix ms, publisher clock). */
	t: number;
	/** 1 for rollbacks; "resign" for a head re-signed after `keys rotate` (same artifact, new seq, no swap). */
	r?: 1 | typeof RESIGN;
	/** Prod only: base64 Ed25519 signature by the main key. */
	sig?: string;
	/** Prod only: base64 Ed25519 signature by the fallback key. */
	sigF?: string;
}

/** Builds a deploy message; signed with both keys when a signer is given (prod-channel branches only). */
export function deployMessage(
	input: Omit<DeployMessage, "t" | "r" | "sig" | "sigF"> & { rollback?: boolean; resign?: boolean; t?: number },
	signer?: DualSigner,
): DeployMessage {
	const message: DeployMessage = {
		b: input.b,
		a: input.a,
		i: input.i,
		s: input.s,
		c: input.c,
		ch: input.ch,
		t: input.t ?? Date.now(),
	};
	if (input.rollback) message.r = 1;
	else if (input.resign) message.r = RESIGN;
	if (signer) Object.assign(message, signDual(signer, message));
	return message;
}

/** The `TypeTorch/pin` message: kernel 0.2.3's fields, in this order, plus `sig`/`sigF` for prod-channel branches. */
export interface PinMessage extends PinFields {
	sig?: string;
	sigF?: string;
}

/** Builds a pin message (absent fields are left out); signed with both keys when a signer is given. */
export function pinMessage(input: Omit<PinFields, "t"> & { t?: number }, signer?: DualSigner): PinMessage {
	const message: PinMessage = { b: input.b, by: input.by, t: input.t ?? Date.now() };
	const ordered: PinMessage = {
		...(input.j !== undefined ? { j: [...input.j] } : {}),
		...(input.pct !== undefined ? { pct: input.pct } : {}),
		...(input.a !== undefined ? { a: input.a } : {}),
		b: message.b,
		by: message.by,
		t: message.t,
		...(input.unpin ? { unpin: true as const } : {}),
	};
	if (signer) Object.assign(ordered, signPinDual(signer, ordered));
	return ordered;
}

/** The pin message's JSON text; throws over MessagingService's 1 KiB limit. */
export function encodePinMessage(message: PinMessage): string {
	const text = JSON.stringify(message);
	const size = new TextEncoder().encode(text).length;
	if (size > MESSAGE_LIMIT) throw new Error(`the pin message is ${size} bytes, over MessagingService's ${MESSAGE_LIMIT}-byte limit (list fewer servers, or use --pct)`);
	return text;
}

/** The rekey hint's text. */
export function encodeRekeyMessage(t = Date.now()): string {
	return JSON.stringify({ t });
}

/** The JSON text sent to MessagingService; throws when it is over the 1 KiB limit. */
export function encodeDeployMessage(message: DeployMessage): string {
	const text = JSON.stringify(message);
	const size = new TextEncoder().encode(text).length;
	if (size > MESSAGE_LIMIT) throw new Error(`the deploy message is ${size} bytes, over MessagingService's ${MESSAGE_LIMIT}-byte limit`);
	return text;
}
