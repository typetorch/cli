/**
 * A fake of the analytics backend's public surface for the endpoint checks (endpoints.ts): GET /healthz,
 * GET /v1/auth/check (role "game" | "admin" and `parts`, like analytics/src/server/app.ts) and GET /v1/settings (older
 * servers). Records every request so tests can assert that only side-effect-free GETs were made. Tokens are made up.
 */
export const INGEST = "ingest-token-for-tests-0123456789";
export const ADMIN = "admin-token-for-tests-0123456789ab";
export const HOST = "https://fleet.example.com";

export interface FakeOptions {
	ingest?: string[];
	admin?: string;
	parts?: { analytics: boolean; fleet: boolean };
	/** Servers before /v1/auth/check answer 404 there. */
	authCheck?: boolean;
	/** The first version of the route: role "ingest" and `valid` instead of role "game" and `parts`. */
	legacyShape?: boolean;
	/** Answers every path with this (a dead tunnel, a wrong server). */
	everything?: () => Response;
	/** Throws instead of answering (no connection). */
	throws?: () => Error;
	/** Milliseconds to wait before answering. */
	delayMs?: number;
	/** The server sits under this path (a reverse proxy prefix). */
	prefix?: string;
}

/**
 * A fake of the backend's surface: /healthz, /v1/auth/check, /v1/settings, and the owner list (GET / PUT /v1/access,
 * admin token only, with the backend's seq rules: a lower seq or the same seq with another list is 409). Records every
 * request and every PUT body.
 */
export function fakeServer(options: FakeOptions & { access?: { seq: number | null; owners: number[] }; accessStatus?: number } = {}) {
	const calls: { method: string; path: string; auth: boolean }[] = [];
	const access = options.access ?? { seq: null as number | null, owners: [] as number[] };
	const puts: { seq: number; owners: number[] }[] = [];
	const parts = options.parts ?? { analytics: true, fleet: true };
	const ingest = options.ingest ?? [INGEST];
	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (options.prefix && url.pathname.startsWith(options.prefix)) url.pathname = url.pathname.slice(options.prefix.length) || "/";
		const headers = new Headers(init?.headers);
		const auth = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
		calls.push({ method: init?.method ?? "GET", path: url.pathname, auth: auth !== undefined });
		if (options.delayMs) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.delayMs);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(init.signal!.reason);
				});
			});
		}
		if (options.throws) throw options.throws();
		if (options.everything) return options.everything();
		const role = auth && ingest.includes(auth) ? "ingest" : auth && auth === (options.admin ?? ADMIN) ? "admin" : undefined;
		if (url.pathname === "/healthz") return json(200, { ok: true });
		if (url.pathname === "/v1/auth/check") {
			if (options.authCheck === false) return json(404, { error: "not found" });
			if (!role) return json(401, { error: "sign in required", login: { token: true, roblox: false } });
			if (options.legacyShape) return json(200, { ok: true, service: "typetorch-analytics", role, parts, valid: { ...parts } });
			return json(200, { ok: true, role: role === "ingest" ? "game" : role, via: "bearer", service: "typetorch-backend", version: "0.0.0-test", parts });
		}
		if (url.pathname === "/v1/settings") return role ? json(200, {}) : json(401, { error: "token required" });
		if (url.pathname === "/v1/access") {
			if (role !== "admin") return json(401, { error: "admin token required" });
			if (options.accessStatus) return json(options.accessStatus, { error: "the fake says no" });
			if ((init?.method ?? "GET") === "GET") return json(200, { ...access, updatedAt: access.seq === null ? null : "2026-10-09T12:00:00.000Z" });
			const body = JSON.parse(String(init?.body)) as { seq: number; owners: number[] };
			puts.push(body);
			const owners = [...body.owners].sort((a, b) => a - b);
			if (access.seq !== null && body.seq < access.seq) return json(409, { error: `seq ${body.seq} is older than the stored seq ${access.seq}`, seq: access.seq });
			if (access.seq !== null && body.seq === access.seq && owners.join(",") !== access.owners.join(",")) return json(409, { error: "same seq, other list", seq: access.seq });
			const changed = access.seq !== body.seq;
			access.seq = body.seq;
			access.owners = owners;
			return json(200, { seq: body.seq, owners, updatedAt: "2026-10-09T12:00:00.000Z", changed, sessionsEnded: 0 });
		}
		if (url.pathname === "/v1/fleet/servers") return role === "admin" ? json(200, { servers: [] }) : json(401, { error: "admin token required" });
		return json(404, { error: "not found" });
	}) as typeof fetch;
	return { fetch: fetchFake, calls, access, puts };
}

