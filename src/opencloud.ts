/**
 * A small Open Cloud client (fetch only): assets (create, operation polling, moderation polling), MessagingService
 * publish and place publishing. The configs API (the interim registry) is in registry.ts.
 * The API key goes only into the `x-api-key` header; it is never logged.
 */
import { debug } from "./log";
import { redact } from "./env";
import type { Channel } from "./naming";

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

	/** Polls an assets operation until done. */
	async waitForOperation(operationId: string, timeoutSeconds = 600): Promise<any> {
		const started = performance.now();
		let delay = 500;
		while (true) {
			const operation = await this.call("GET", `/assets/v1/operations/${operationId}`);
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
export const MESSAGE_LIMIT = 1024;

/**
 * The deploy message the kernel reads (Kernel.server.luau onDeployMessage). At most 1 KiB. Servers on branch `b` swap
 * to it and persist it as their branch head (in-game DataStore `head/<branch>`, higher seq wins), so it carries
 * everything a head needs even when the configs registry isn't writable. Unsigned: signing was removed (user decision,
 * 2026-10-04); a person approves each deploy in the CLI instead (`typetorch approve`).
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
	/** 1 for rollbacks. */
	r?: 1;
}

/** Builds a deploy message. */
export function deployMessage(input: Omit<DeployMessage, "t" | "r"> & { rollback?: boolean; t?: number }): DeployMessage {
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
	return message;
}

/** The JSON text sent to MessagingService; throws when it is over the 1 KiB limit. */
export function encodeDeployMessage(message: DeployMessage): string {
	const text = JSON.stringify(message);
	const size = new TextEncoder().encode(text).length;
	if (size > MESSAGE_LIMIT) throw new Error(`the deploy message is ${size} bytes, over MessagingService's ${MESSAGE_LIMIT}-byte limit`);
	return text;
}
