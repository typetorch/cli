/**
 * The Studio plugin's Claude tab: prompts for the remote-claude session (@typetorch/dev-server) running in this game
 * repo, which `typetorch serve --claude` starts (`remote-claude --no-tunnel --no-announce`) or the owner runs
 * themselves. The session writes `.typetorch/remote-claude.session.json` (`{v, sid, branch, port, pid}`) and its current
 * pairing code to `.typetorch/remote-claude.code`; serve reads both, pairs on the Studio user's behalf (job "" = Studio)
 * and keeps their tokens, so the plugin never handles a remote-claude code or token. The plugin reaches it through
 * serve's control API (server.ts `/tt/claude/...`), locally or through the remote gateway with its device token.
 *
 * Code mode only: Live mode acts on a running game server, which a Studio isn't.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_SESSION_FILE = join(".typetorch", "remote-claude.session.json");
export const CLAUDE_CODE_FILE = join(".typetorch", "remote-claude.code");

export interface ClaudeSessionInfo {
	sid: string;
	branch: string;
	port: number;
	pid: number;
}

/** A remote-claude refusal: the dev-server answers with a bare status; `message` says what it means here. */
export class ClaudeError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

interface Tokens {
	sid: string;
	access: string;
	/** ms since the epoch. */
	accessUntil: number;
	refresh?: string;
}

const STATUS_TEXT: Record<number, string> = {
	400: "remote-claude refused the request",
	401: "remote-claude refused this Roblox user: the owner adds them with `typetorch remote-claude --users <ids>` (or serve --claude-users)",
	404: "not found (an unknown prompt or conversation)",
	409: "Claude is still working on the previous message in this conversation",
	413: "too large",
	429: "too many requests: wait a moment",
	503: "remote-claude is busy or shutting down",
};

export interface ClaudeBridgeOptions {
	root: string;
	/** Tests. */
	fetch?: typeof fetch;
	now?: () => number;
	alive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface PromptOptions {
	mode?: "live" | "code";
	toolbox?: boolean;
	attachments?: string[];
	context?: Record<string, unknown>;
}

const ID = "[A-Za-z0-9_-]{1,64}";
/** remote-claude routes the Studio window may reach through serve (see passthrough). */
const PASSTHROUGH: ["GET" | "POST", RegExp][] = [
	["GET", new RegExp(`^/v1/conversations(/${ID})?$`)],
	["POST", /^\/v1\/attachments(\/capture|\/asset)?$/],
	["GET", new RegExp(`^/v1/images/${ID}(\\?chunk=\\d{1,4})?$`)],
	["POST", /^\/v1\/logs$/],
];

/** Prompts kept per chat (older ones drop off the plugin's transcript). */
const MAX_CHAT_PROMPTS = 100;

export interface ClaudeChat {
	conversationId?: string;
	prompts: string[];
	/** The text of each prompt sent through this serve (missing for older ones). */
	texts?: Record<string, string>;
	updatedAt?: string;
}

export class ClaudeBridge {
	private readonly tokens = new Map<number, Tokens>();
	/** One token exchange per user at a time: refresh tokens rotate, and a reused one revokes the pairing. */
	private readonly pending = new Map<number, Promise<string>>();
	private readonly chats = new Map<number, ClaudeChat & { sid: string }>();
	/** Prompt id → its text, per user (the last MAX_CHAT_PROMPTS sent through this serve). */
	private readonly texts = new Map<number, Map<string, string>>();
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly alive: (pid: number) => boolean;

	constructor(private readonly options: ClaudeBridgeOptions) {
		this.fetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.alive = options.alive ?? pidAlive;
	}

	/** The running session, if any. */
	session(): ClaudeSessionInfo | undefined {
		let raw: Partial<ClaudeSessionInfo> & { v?: number };
		try {
			raw = JSON.parse(readFileSync(join(this.options.root, CLAUDE_SESSION_FILE), "utf8"));
		} catch {
			return undefined;
		}
		if (raw?.v !== 1 || typeof raw.sid !== "string" || typeof raw.branch !== "string" || !Number.isInteger(raw.port) || !Number.isInteger(raw.pid)) return undefined;
		if (!this.alive(raw.pid!)) return undefined;
		return { sid: raw.sid, branch: raw.branch, port: raw.port!, pid: raw.pid! };
	}

	/** What the plugin's Claude tab shows before a prompt. */
	status(): { available: boolean; branch?: string; hint?: string } {
		const session = this.session();
		if (!session) return { available: false, hint: "Claude isn't running here: the owner starts it with `typetorch serve --claude`" };
		return { available: true, branch: session.branch };
	}

	private require(): ClaudeSessionInfo {
		const session = this.session();
		if (!session) throw new ClaudeError(503, "Claude isn't running here: the owner starts it with `typetorch serve --claude`");
		return session;
	}

	private code(): string {
		try {
			const code = readFileSync(join(this.options.root, CLAUDE_CODE_FILE), "utf8").split("\n")[0].trim();
			if (code) return code;
		} catch {
			// below
		}
		throw new ClaudeError(503, "remote-claude has no pairing code right now");
	}

	private async grant(session: ClaudeSessionInfo, body: Record<string, unknown>): Promise<Response> {
		return this.fetch(`http://127.0.0.1:${session.port}/v1/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sid: session.sid, job: "", branch: session.branch, ...body }),
		});
	}

	/** An access token for `user`: the cached one, a refresh, or a new pairing with the session's current code. */
	private token(session: ClaudeSessionInfo, user: number): Promise<string> {
		const cached = this.tokens.get(user);
		if (cached && cached.sid === session.sid && cached.accessUntil > this.now() + 30_000) return Promise.resolve(cached.access);
		let running = this.pending.get(user);
		if (!running) {
			running = this.exchange(session, user, cached?.sid === session.sid ? cached.refresh : undefined).finally(() => this.pending.delete(user));
			this.pending.set(user, running);
		}
		return running;
	}

	private async exchange(session: ClaudeSessionInfo, user: number, refresh: string | undefined): Promise<string> {
		let res: Response | undefined;
		if (refresh) {
			res = await this.grant(session, { grant: "refresh", user, refresh_token: refresh });
			if (res.status === 429) throw new ClaudeError(429, STATUS_TEXT[429]);
			if (!res.ok) res = undefined;
		}
		res ??= await this.grant(session, { grant: "code", user, code: this.code() });
		if (!res.ok) {
			this.tokens.delete(user);
			throw new ClaudeError(res.status, STATUS_TEXT[res.status] ?? `remote-claude answered ${res.status}`);
		}
		const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
		this.tokens.set(user, { sid: session.sid, access: body.access_token, accessUntil: this.now() + body.expires_in * 1000, refresh: body.refresh_token });
		return body.access_token;
	}

	/** One remote-claude request as `user` (a Roblox user id); retries once with a fresh token after a 401. */
	async request(user: number, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
		const session = this.require();
		for (let attempt = 0; ; attempt++) {
			const access = await this.token(session, user);
			const headers: Record<string, string> = { authorization: `Bearer ${access}`, "x-tt-job": "" };
			if (method === "POST") {
				headers["content-type"] = "application/json";
				headers["x-tt-nonce"] = randomUUID();
				headers["x-tt-timestamp"] = String(Math.floor(this.now() / 1000));
			}
			const res = await this.fetch(`http://127.0.0.1:${session.port}${path}`, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
			if (res.status === 401 && attempt === 0) {
				const cached = this.tokens.get(user);
				if (cached) cached.accessUntil = 0;
				continue;
			}
			if (!res.ok) throw new ClaudeError(res.status, STATUS_TEXT[res.status] ?? `remote-claude answered ${res.status}`);
			const text = await res.text();
			return text ? JSON.parse(text) : { ok: true };
		}
	}

	/**
	 * A prompt: Code mode unless the request says "live" (a running playtest answers the game tools, as job "" on this
	 * PC), plus the in-game tab's options as remote-claude takes them (toolbox, attachments, context). `conversationId`
	 * continues a conversation. remote-claude validates the fields.
	 */
	async prompt(user: number, prompt: string, conversationId?: string, options: PromptOptions = {}) {
		const started = await this.request(user, "POST", "/v1/prompts", { prompt, mode: options.mode ?? "code", ...(conversationId ? { conversationId } : {}), ...(options.toolbox ? { toolbox: true } : {}), ...(options.attachments?.length ? { attachments: options.attachments } : {}), ...(options.context ? { context: options.context } : {}) });
		const id = (started as { id?: unknown } | undefined)?.id;
		if (typeof id === "string") {
			// what was asked, so another copy of the plugin can show the user's bubble (remote-claude's polls don't carry it)
			const texts = this.texts.get(user) ?? new Map<string, string>();
			texts.set(id, prompt);
			while (texts.size > MAX_CHAT_PROMPTS) texts.delete(texts.keys().next().value!);
			this.texts.set(user, texts);
		}
		return started;
	}

	/**
	 * The rest of remote-claude's API the in-game Claude tab uses (recent chats, screenshots, Claude's images, log
	 * uploads), for the same user; only these paths, never the game-server ones (/v1/game/*) or /v1/token.
	 */
	passthrough(user: number, method: "GET" | "POST", path: string, body?: unknown) {
		if (!PASSTHROUGH.some(([m, pattern]) => m === method && pattern.test(path))) throw new ClaudeError(403, `not allowed: ${method} ${path}`);
		return this.request(user, method, path, body);
	}

	/** The prompt's state and its events from `since`. */
	poll(user: number, id: string, since: number) {
		return this.request(user, "GET", `/v1/prompts/${encodeURIComponent(id)}?since=${since}`);
	}

	deploy(user: number, id: string, decision: "deploy" | "discard") {
		return this.request(user, "POST", `/v1/prompts/${encodeURIComponent(id)}/deploy`, { decision });
	}

	cancel(user: number, id: string) {
		return this.request(user, "POST", `/v1/prompts/${encodeURIComponent(id)}/cancel`, {});
	}

	/**
	 * The chat the Claude tab shows, per user: its conversation and prompt ids, so every copy of the plugin (Edit, the
	 * Play client and server: plugin settings don't cross between them live) picks up the same chat and re-polls it.
	 * Kept in memory for this session only: a new remote-claude session forgets the prompts.
	 */
	chat(user: number): ClaudeChat {
		const saved = this.chats.get(user);
		const sid = this.session()?.sid;
		if (!saved || saved.sid !== sid) return { prompts: [] };
		const known = this.texts.get(user);
		const texts: Record<string, string> = {};
		for (const id of saved.prompts) {
			const text = known?.get(id);
			if (text !== undefined) texts[id] = text;
		}
		return { conversationId: saved.conversationId, prompts: [...saved.prompts], texts, updatedAt: saved.updatedAt };
	}

	saveChat(user: number, conversationId: string | undefined, prompts: string[]): ClaudeChat {
		const sid = this.session()?.sid;
		if (!sid) throw new ClaudeError(503, "Claude isn't running here: the owner starts it with `typetorch serve --claude`");
		this.chats.set(user, { sid, conversationId, prompts: prompts.slice(-MAX_CHAT_PROMPTS), updatedAt: new Date(this.now()).toISOString() });
		return this.chat(user);
	}
}

