/**
 * `/tt/claude/stream`: the Claude tab's events over a WebSocket instead of polling. The plugin sends
 * `{"watch": <prompt id>, "since": <n>}` (or `{"unwatch": <id>}`); serve polls remote-claude on this machine every
 * POLL_MS for it and pushes `{"type": "prompt", ...}` (the same view GET /tt/claude/prompt returns) whenever there are
 * new events or the state changed, until the prompt finishes. Errors come as `{"type": "error", id, status, error}`.
 * A ping every PING_MS keeps tunnels (Cloudflare drops idle sockets after 100 s) open.
 */
import { ClaudeError, type ClaudeBridge } from "./claude.ts";
import type { WebSocketConnection } from "./ws.ts";

const POLL_MS = 150;
/** While a change waits for the user (proposed, committed): nothing moves until they answer. */
const IDLE_POLL_MS = 1000;
const PING_MS = 20_000;
const MAX_WATCHES = 4;
const FINISHED = new Set(["deployed", "discarded", "answered", "failed", "cancelled"]);
const WAITING = new Set(["proposed", "committed"]);

interface PromptView {
	state?: string;
	events?: unknown[];
	next?: number;
	more?: boolean;
}

export function serveClaudeStream(connection: WebSocketConnection, bridge: ClaudeBridge, user: number) {
	const watches = new Map<string, { stop: boolean }>();
	const ping = setInterval(() => connection.ping(), PING_MS);
	connection.on("close", () => {
		clearInterval(ping);
		for (const watch of watches.values()) watch.stop = true;
		watches.clear();
	});
	const send = (value: unknown) => connection.send(JSON.stringify(value));

	const watch = async (id: string, since: number) => {
		watches.get(id)?.stop && watches.delete(id);
		const previous = watches.get(id);
		if (previous) previous.stop = true;
		const handle = { stop: false };
		watches.set(id, handle);
		let cursor = since;
		let lastState: string | undefined;
		while (!handle.stop && connection.open) {
			let view: PromptView;
			try {
				view = (await bridge.poll(user, id, cursor)) as PromptView;
			} catch (error) {
				const status = error instanceof ClaudeError ? error.status : 500;
				send({ type: "error", id, status, error: (error as Error).message });
				break;
			}
			if (handle.stop) break;
			const events = Array.isArray(view.events) ? view.events : [];
			if (events.length > 0 || view.state !== lastState) send({ type: "prompt", id, since: cursor, ...view });
			lastState = view.state;
			if (typeof view.next === "number") cursor = view.next;
			if (view.more) continue; // more events waiting: fetch them now
			if (view.state !== undefined && FINISHED.has(view.state)) break;
			await new Promise((done) => setTimeout(done, view.state !== undefined && WAITING.has(view.state) ? IDLE_POLL_MS : POLL_MS));
		}
		if (watches.get(id) === handle) watches.delete(id);
	};

	connection.on("message", (text) => {
		let message: { watch?: unknown; since?: unknown; unwatch?: unknown };
		try {
			message = JSON.parse(text);
		} catch {
			return send({ type: "error", status: 400, error: "expected JSON" });
		}
		if (typeof message.unwatch === "string") {
			const handle = watches.get(message.unwatch);
			if (handle) handle.stop = true;
			watches.delete(message.unwatch);
			return;
		}
		if (typeof message.watch !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(message.watch)) return send({ type: "error", status: 400, error: "watch: a prompt id" });
		if (!watches.has(message.watch) && watches.size >= MAX_WATCHES) return send({ type: "error", id: message.watch, status: 429, error: `at most ${MAX_WATCHES} prompts at a time` });
		const since = typeof message.since === "number" && Number.isFinite(message.since) ? Math.max(0, Math.floor(message.since)) : 0;
		void watch(message.watch, since);
	});
	send({ type: "ready" });
}
