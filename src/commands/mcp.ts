/**
 * `typetorch mcp`: an MCP server on stdio (JSON-RPC 2.0, one message per line) for agents that would rather call tools
 * than run commands. Its tools are `typetorch serve` and `typetorch studio`: start and stop the dev loop, read its
 * status and logs, and drive the attached Studio (reconnect, play, stop). Run it in the game repo:
 *   claude mcp add typetorch -- bunx typetorch mcp
 */
import { findProjectRoot } from "../config.ts";
import { ServeClientError } from "../serve/client.ts";
import { serveLogs, serveStatus, serveStop, startDetached, studioSend } from "../serve/ops.ts";
import { RECONNECT_LUAU, type CommandKind } from "../serve/protocol.ts";

export const MCP_USAGE = `typetorch mcp

  An MCP server on stdio for agents (Claude Code: \`claude mcp add typetorch -- bunx typetorch mcp\`, from the game
  repo). Tools:
    serve_status      children, compile errors, attached Studios and their sync state
    serve_start       starts typetorch serve in the background (no-op when it runs)
    serve_stop        stops it
    serve_logs        serve's log (compiler, Rojo, scripts)
    studio_logs       Studio's Output (edit and playtest)
    studio_reconnect  makes the Studio plugin resync from scratch (anyway: also into another experience's place)
    studio_play       starts a playtest (mode: play or run)
    studio_stop       ends the playtest
  When no Studio is attached, the tools say how to unstick it, including the Luau for the Roblox Studio MCP:
    ${RECONNECT_LUAU}`;

interface Tool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; additionalProperties?: boolean };
	run: (root: string, input: Record<string, unknown>) => Promise<unknown>;
}

const logsSchema = {
	since: { type: "number", description: "only lines after this seq (the `last` of an earlier call)" },
	limit: { type: "number", description: "most lines to return (default 200)" },
};

function command(kind: CommandKind, args: (input: Record<string, unknown>) => Record<string, unknown> = () => ({})) {
	return (root: string, input: Record<string, unknown>) =>
		studioSend(root, kind, args(input), typeof input.target === "string" ? input.target : undefined);
}

const target = { type: "string", description: "a Studio id from serve_status, or edit / server / client" };

export const TOOLS: Tool[] = [
	{
		name: "serve_status",
		description: "Whether typetorch serve runs here; its children (watch, rojo, scripts), the last compile and its errors, and the Studios the plugin attached (edit, playtest server/client) with their sync state.",
		inputSchema: { type: "object", properties: {} },
		run: (root) => serveStatus(root),
	},
	{
		name: "serve_start",
		description: "Starts typetorch serve in the background (rbxtsc -w, rojo serve and the control API the Studio plugin attaches to). Returns at once when it already runs.",
		inputSchema: {
			type: "object",
			properties: {
				with: { type: "array", items: { type: "string" }, description: "package.json scripts to run alongside (e.g. live)" },
				project: { type: "string", description: "project file for Rojo (default studio.project.json, else default.project.json)" },
				noWatch: { type: "boolean", description: "don't run rbxtsc -w" },
			},
		},
		run: (root, input) => {
			const argv = ["serve"];
			if (typeof input.project === "string") argv.push("--project", input.project);
			if (input.noWatch === true) argv.push("--no-watch");
			const scripts = Array.isArray(input.with) ? input.with.filter((s): s is string => typeof s === "string") : [];
			if (scripts.length) argv.push("--with", scripts.join(","));
			return startDetached(root, argv);
		},
	},
	{
		name: "serve_stop",
		description: "Stops typetorch serve and everything it runs.",
		inputSchema: { type: "object", properties: {} },
		run: (root) => serveStop(root),
	},
	{
		name: "serve_logs",
		description: "typetorch serve's log: the compiler, Rojo and extra scripts. Pass the returned `last` as `since` to get only new lines.",
		inputSchema: { type: "object", properties: logsSchema },
		run: (root, input) => serveLogs(root, "serve", num(input.since), num(input.limit) ?? 200),
	},
	{
		name: "studio_logs",
		description: "Roblox Studio's Output (edit mode and playtests; source = edit, server or client), as the TypeTorch plugin forwards it. Pass the returned `last` as `since` to get only new lines.",
		inputSchema: { type: "object", properties: logsSchema },
		run: (root, input) => serveLogs(root, "studio", num(input.since), num(input.limit) ?? 200),
	},
	{
		name: "studio_reconnect",
		description: "Makes the TypeTorch Studio plugin turn auto-connect on and resync from scratch, then reports whether it connected. Use when sync is down or stuck.",
		inputSchema: {
			type: "object",
			properties: {
				anyway: { type: "boolean", description: "also sync into a place of another experience or an unpublished place" },
				target,
			},
		},
		run: command("reconnect", (input) => ({ anyway: input.anyway === true })),
	},
	{
		name: "studio_play",
		description: "Starts a playtest in Studio. Studio's Output from the playtest comes through studio_logs.",
		inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["play", "run"] }, target } },
		run: command("play", (input) => ({ mode: input.mode === "run" ? "run" : "play" })),
	},
	{
		name: "studio_stop",
		description: "Ends the running playtest in Studio.",
		inputSchema: { type: "object", properties: { target } },
		run: command("stop"),
	},
];

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type Message = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Answers one JSON-RPC message (undefined for notifications). */
export async function handleMessage(message: Message, root: string | undefined, version: string): Promise<unknown> {
	const { id, method, params } = message;
	const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
	const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
	if (id === undefined || id === null) return undefined; // notification (notifications/initialized and the like)
	switch (method) {
		case "initialize":
			return reply({
				protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "typetorch", version },
				instructions:
					"typetorch serve runs the Roblox Studio dev loop (compiler, Rojo, the TypeTorch Studio plugin's control API). Check serve_status first; if Studio's sync is down, call studio_reconnect.",
			});
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: TOOLS.map(({ run: _, ...tool }) => tool) });
		case "tools/call": {
			const tool = TOOLS.find((t) => t.name === params?.name);
			if (!tool) return fail(-32602, `unknown tool ${String(params?.name)}`);
			const input = (params?.arguments ?? {}) as Record<string, unknown>;
			try {
				if (!root) throw new ServeClientError("run typetorch mcp inside a TypeTorch game repo (no typetorch.json here or above)");
				const result = await tool.run(root, input);
				const failed = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
				return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: failed });
			} catch (error) {
				return reply({ content: [{ type: "text", text: (error as Error).message ?? String(error) }], isError: true });
			}
		}
		default:
			return fail(-32601, `method not found: ${method}`);
	}
}

/** Reads JSON-RPC lines from stdin until it closes; answers on stdout. Logs nothing to stdout. */
export async function mcpServe(version: string): Promise<number> {
	const root = findProjectRoot();
	let buffer = "";
	const inflight = new Set<Promise<void>>();
	const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let message: Message;
		try {
			message = JSON.parse(line);
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			return;
		}
		const job = handleMessage(message, root, version).then((answer) => {
			if (answer !== undefined) write(answer);
		});
		inflight.add(job);
		void job.finally(() => inflight.delete(job));
	};
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			handleLine(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	handleLine(buffer);
	await Promise.all(inflight);
	return 0;
}
