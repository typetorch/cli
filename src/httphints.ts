/**
 * Turns common HTTP failures into one line that says how to fix them; only unknown cases fall back to the response,
 * shortened (HTML pages reduced to their title or text). Used for the fleet API (servers, report, alerts, doctor,
 * --wait), which on a dev's PC usually sits behind a Cloudflare quick tunnel.
 */

/** How to start the local fleet API again (analytics repo). */
export const LOCAL_FLEET_HINT =
	"start it again on the dev PC: in analytics/, bun run local -- --env-file <server env file> --game <game repo> (a new tunnel URL; it updates the game settings and typetorch.json)";

/**
 * How to get the right token for a fleet / analytics endpoint. The server has two kinds: ingest tokens
 * (TT_ANALYTICS_INGEST_TOKENS, write-only: what game servers hold in the settings record) and the admin token
 * (TT_ANALYTICS_ADMIN_TOKEN, reads: stays on the dev's PC).
 */
export function INGEST_TOKEN_HINT(part: "fleet" | "analytics"): string {
	const where = part === "fleet" ? "TYPETORCH_FLEET_INGEST_TOKEN (the CLI's env file)" : 'the "token" field of the analytics settings';
	return `put one of the server's TT_ANALYTICS_INGEST_TOKENS in ${where}; TT_ANALYTICS_ADMIN_TOKEN is the read token and never goes to game servers`;
}

/** The response as one short line: JSON `error`/`message`, an HTML page's title, else the text. */
export function shortBody(text: string, max = 160): string {
	const trimmed = text.trim();
	if (!trimmed) return "(empty response)";
	try {
		const json = JSON.parse(trimmed) as { error?: unknown; message?: unknown; errors?: { message?: unknown }[] };
		const message = json.error ?? json.message ?? json.errors?.[0]?.message;
		if (typeof message === "string" && message) return message.slice(0, max);
	} catch {}
	if (/^<!doctype html|^<html|<head[\s>]/i.test(trimmed)) {
		const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
		const text = (title ?? trimmed.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
			.replace(/&[a-z#0-9]+;/gi, " ")
			.replace(/\s+/g, " ")
			.trim();
		return `(HTML page) ${text}`.slice(0, max);
	}
	return trimmed.replace(/\s+/g, " ").slice(0, max);
}

/** A fix for a failed fleet API call, or undefined when there is no known one. */
export function fleetHint(status: number, body: string, host: string): string | undefined {
	const quickTunnel = /\.trycloudflare\.com$/i.test(host);
	const cloudflarePage = /cloudflare/i.test(body) || quickTunnel;
	if (status === 530 || (cloudflarePage && /error code:? *1033|\b1033\b/.test(body))) {
		return `the tunnel ${host} has nothing running behind it (Cloudflare ${status}): the fleet API or its tunnel stopped; ${LOCAL_FLEET_HINT}`;
	}
	if ((status === 502 || status === 504) && cloudflarePage) {
		return `the tunnel ${host} is up but the server behind it doesn't answer (${status}): start the analytics server, or ${LOCAL_FLEET_HINT}`;
	}
	if (status === 404 && quickTunnel && !body.trim().startsWith("{")) {
		return `the tunnel answers 404 without reaching the server: a ~/.cloudflared/config.yml with a catch-all ingress overrides --url; run cloudflared with an empty --config (bun run local does)`;
	}
	if (status === 404 && /part is off/i.test(body)) {
		return `the fleet part is off on that server: set TT_SERVER_PARTS=analytics,fleet (or fleet) in its env file and restart it`;
	}
	if (status === 401 || status === 403) {
		return `the fleet API refused the token (${status}): TYPETORCH_FLEET_TOKEN must equal the server's TT_ANALYTICS_ADMIN_TOKEN (reads) and TYPETORCH_FLEET_INGEST_TOKEN one of its TT_ANALYTICS_INGEST_TOKENS (posts)`;
	}
	if (status === 429) return `the fleet API is rate-limiting this client (429): wait a minute and try again`;
	return undefined;
}

/** A fix for a fleet API call that got no HTTP answer at all, or undefined. */
export function fleetNetworkHint(error: Error, host: string): string | undefined {
	const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code ?? "";
	const text = `${code} ${error.message}`;
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text) && /\.trycloudflare\.com$/i.test(host)) {
		return `${host} no longer exists (quick tunnel URLs die with their cloudflared); ${LOCAL_FLEET_HINT}`;
	}
	// Bun's fetch says "ConnectionRefused" for a refused connection AND for a host name that doesn't resolve.
	if (/ECONNREFUSED|ConnectionRefused|FailedToOpenSocket|Unable to connect/i.test(text)) {
		if (/\.trycloudflare\.com$/i.test(host)) return `${host} doesn't answer: quick tunnel URLs die with their cloudflared (a new run gets a new URL), or the server behind it stopped; ${LOCAL_FLEET_HINT}`;
		return `nothing listens at ${host} (or the host name doesn't exist): start the analytics server (or ${LOCAL_FLEET_HINT})`;
	}
	if (/timeout|timed out|ETIMEDOUT|aborted/i.test(text)) return `${host} didn't answer in time: check that the server and its tunnel are running`;
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return `${host} doesn't resolve: check the URL for typos (and this PC's internet connection)`;
	if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|certificate|ERR_TLS|SSL/i.test(text)) {
		return `${host} has no valid TLS certificate (Roblox servers refuse it too): use a host with a real certificate (the Cloudflare tunnel, or Caddy on a VPS)`;
	}
	if (/ECONNRESET|socket hang up|UND_ERR_SOCKET|closed unexpectedly/i.test(text)) {
		return `${host} dropped the connection: the server or its tunnel is restarting or overloaded; ${LOCAL_FLEET_HINT}`;
	}
	return undefined;
}
