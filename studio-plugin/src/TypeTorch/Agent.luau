--!nonstrict
-- What lets an agent drive Studio through `typetorch serve` (cli src/serve/protocol.ts, COMMAND_KINDS):
--   * a long poll on GET /tt/plugin/poll that runs the commands it gets (ping, reconnect, play, stop) and answers each
--     with POST /tt/plugin/result. It runs whatever Rojo's sync is doing, so a broken sync can still be fixed remotely.
--   * Studio's Output (LogService.MessageOut), sent in batches to POST /tt/plugin/logs (`typetorch studio logs`).
--   * in edit mode, the ServerStorage attribute TypeTorchReconnect: setting it (command bar, or the Roblox Studio MCP's
--     execute_luau) makes the plugin reconnect even when nothing else reaches it. The attribute is cleared at once.

local LogService = game:GetService("LogService")
local ServerStorage = game:GetService("ServerStorage")

local Control = require(script.Parent.Control)

local Agent = {}

local RECONNECT_ATTRIBUTE = "TypeTorchReconnect"
local POLL_WAIT_SECONDS = 15
local LOG_FLUSH_SECONDS = 1
local LOG_BUFFER_MAX = 500

local LEVELS = {
	[Enum.MessageType.MessageOutput] = "info",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warn",
	[Enum.MessageType.MessageError] = "error",
}

export type Options = {
	id: string,
	mode: string,
	-- The serve this plugin talks to right now, or nil.
	server: () -> { port: number }?,
	helloBody: () -> any,
	alive: () -> boolean,
	-- kind -> handler(args) -> (ok, result table or error text)
	handlers: { [string]: (args: any) -> (boolean, any) },
	-- Called when someone sets the TypeTorchReconnect attribute (edit mode only).
	onReconnectAttribute: (() -> ())?,
}

local function run(options: Options, command)
	local handler = options.handlers[command.kind]
	local ok, result
	if not handler then
		ok, result = false, `this plugin ({options.mode}) can't run "{command.kind}"`
	else
		local called, a, b = pcall(handler, command.args or {})
		if called then
			ok, result = a, b
		else
			ok, result = false, tostring(a)
		end
	end
	local server = options.server()
	if not server then
		return
	end
	Control.request(server.port, "POST", "/tt/plugin/result", {
		id = options.id,
		command = command.id,
		ok = ok == true,
		result = if ok and type(result) == "table" then result else nil,
		error = if not ok then tostring(result) else nil,
	})
end

local function pollLoop(options: Options)
	while options.alive() do
		local server = options.server()
		if not server then
			task.wait(1)
			continue
		end
		local ok, answer = Control.request(server.port, "GET", `/tt/plugin/poll?id={options.id}&wait={POLL_WAIT_SECONDS}`)
		if ok and type(answer) == "table" and type(answer.commands) == "table" then
			for _, command in answer.commands do
				task.spawn(run, options, command)
			end
		else
			if type(answer) == "string" and string.find(answer, "unknown plugin id", 1, true) then
				Control.request(server.port, "POST", "/tt/plugin/hello", options.helloBody())
			end
			task.wait(1)
		end
	end
end

local function logLoop(options: Options)
	local buffer = {}
	local connection = LogService.MessageOut:Connect(function(text, messageType)
		table.insert(buffer, { level = LEVELS[messageType] or "info", text = text })
		if #buffer > LOG_BUFFER_MAX then
			table.remove(buffer, 1)
		end
	end)
	while options.alive() do
		task.wait(LOG_FLUSH_SECONDS)
		local server = options.server()
		if server and #buffer > 0 then
			local lines = buffer
			buffer = {}
			local ok = Control.request(server.port, "POST", "/tt/plugin/logs", { id = options.id, lines = lines })
			if not ok then
				-- Keep them for the next try (newest win when the buffer is full).
				for i = #lines, 1, -1 do
					table.insert(buffer, 1, lines[i])
				end
				while #buffer > LOG_BUFFER_MAX do
					table.remove(buffer, 1)
				end
			end
		end
	end
	connection:Disconnect()
end

local function watchAttribute(options: Options)
	local function check()
		if ServerStorage:GetAttribute(RECONNECT_ATTRIBUTE) == nil then
			return
		end
		ServerStorage:SetAttribute(RECONNECT_ATTRIBUTE, nil)
		if options.onReconnectAttribute then
			options.onReconnectAttribute()
		end
	end
	local connection = ServerStorage:GetAttributeChangedSignal(RECONNECT_ATTRIBUTE):Connect(check)
	check()
	task.spawn(function()
		while options.alive() do
			task.wait(1)
		end
		connection:Disconnect()
	end)
end

function Agent.start(options: Options)
	task.spawn(pollLoop, options)
	task.spawn(logLoop, options)
	if options.onReconnectAttribute then
		watchAttribute(options)
	end
end

return Agent
