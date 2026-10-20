--!nonstrict
-- The plugin's controller. In edit mode it finds `typetorch serve` by itself (Control.discover every 2 s), attaches to
-- the server whose universeId matches this place, runs Rojo's ServeSession against that server's Rojo, and reconnects
-- on its own whenever the connection drops: nobody clicks Connect. A place that doesn't match (another experience, or
-- an unpublished file) is never synced without a click on "Connect anyway".
-- In every mode it also listens for an agent's commands and forwards Studio's Output (Agent.luau). In a playtest's
-- server it also syncs Rojo into the running game ("Live playtest", on by default) and sets LiveReload on
-- ServerStorage.TypeTorchDev while that sync is up, so the kernel (0.5.4+) remounts the local payload on each change:
-- code changes reach the playtest without Stop + Play.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local Root = script.Parent.Parent
local Rojo = Root.Rojo
local ApiContext = require(Rojo.Plugin.ApiContext)
local ServeSession = require(Rojo.Plugin.ServeSession)
local Log = require(Rojo.Packages.Log)

local Agent = require(script.Parent.Agent)
local Assets = require(script.Parent.Assets)
local Control = require(script.Parent.Control)
local Panel = require(script.Parent.Panel)

local App = {}

local VERSION = "0.4.0"
local PROBE_SECONDS = 2
local HEARTBEAT_SECONDS = 5
local STATUS_SECONDS = 3
local MAX_BACKOFF = 5
-- After this many empty probes in a row, probe less often.
local IDLE_PROBES = 15
local IDLE_PROBE_SECONDS = 5
local AGENT_RECONNECT_WAIT = 10
-- After the playtest sync connects, wait this long before turning LiveReload on: Rojo's first sync isn't a change.
local LIVE_RELOAD_DELAY = 1
local LIVE_SETTING = "TypeTorch_livePlaytest"

type Server = { port: number, hello: Control.Hello }

local state = {
	id = HttpService:GenerateGUID(false),
	mode = "edit",
	plugin = nil :: Plugin?,
	autoConnect = true,
	-- "waiting" (no serve found), "confirm" (found, needs a click), "connecting", "connected", "disconnected", "paused"
	phase = "waiting",
	detail = "",
	server = nil :: Server?,
	candidates = {} :: { Server },
	confirmed = {} :: { [number]: boolean }, -- pid -> clicked "Connect anyway"
	anyway = false, -- an agent asked to connect anyway: accept the server whatever its experience
	emptyProbes = 0,
	session = nil,
	lastSyncAt = nil :: number?,
	patches = 0,
	backoff = 1,
	status = nil, -- the last GET /tt/status (compile state, children)
	-- The Hot assets card: what the place marks (scanned here), what the lockfile knows (GET /tt/assets), the last job.
	assets = { marked = {}, scanned = false, lock = nil, message = "", job = nil, jobText = "" },
	wake = nil :: thread?,
}

local panel

local function settingKey(): string
	return `TypeTorch_autoConnect_{if game.PlaceId ~= 0 then tostring(game.PlaceId) else "local"}`
end

-- The serve pid the user (or an agent) accepted for this place with "Connect anyway"; read by the playtest.
local function confirmedKey(): string
	return `TypeTorch_confirmedPid_{if game.PlaceId ~= 0 then tostring(game.PlaceId) else "local"}`
end

local function livePlaytest(): boolean
	local saved = state.plugin and state.plugin:GetSetting(LIVE_SETTING)
	return saved ~= false
end

local liveGeneration = 0

-- The kernel watches ServerStorage.TypeTorchDev's LiveReload attribute (playtest server only).
local function setLiveReload(on: boolean)
	liveGeneration += 1
	local generation = liveGeneration
	local dev = ServerStorage:FindFirstChild("TypeTorchDev")
	if not dev then
		return
	end
	if not on then
		dev:SetAttribute("LiveReload", nil)
		return
	end
	task.delay(LIVE_RELOAD_DELAY, function()
		if generation == liveGeneration and dev.Parent then
			dev:SetAttribute("LiveReload", true)
		end
	end)
end

local function render()
	if panel then
		panel:render(state)
	end
end

local function setPhase(phase: string, detail: string?)
	state.phase = phase
	state.detail = detail or ""
	render()
end

-- Tells serve what this plugin is doing (also its heartbeat). Failures are fine: serve may be gone.
local function report()
	local server = state.server
	if not server then
		return
	end
	local status = if state.phase == "connected"
		then "connected"
		elseif state.phase == "connecting" then "connecting"
		elseif state.phase == "paused" then "paused"
		elseif state.phase == "confirm" or state.phase == "idle" then "idle"
		else "disconnected"
	local ok = Control.request(server.port, "POST", "/tt/plugin/state", { id = state.id, status = status, detail = state.detail })
	if not ok then
		-- Unknown id after a serve restart: register again.
		Control.request(server.port, "POST", "/tt/plugin/hello", App.helloBody())
	end
end

function App.helloBody()
	return {
		id = state.id,
		mode = state.mode,
		placeId = game.PlaceId,
		gameId = game.GameId,
		placeName = game.Name,
		pluginVersion = VERSION,
	}
end

-- Which server to attach to: the one for this experience; an unpublished place only when exactly one runs.
local function choose(found: { Server }): (Server?, boolean)
	for _, server in found do
		if game.GameId ~= 0 and server.hello.universeId == game.GameId then
			return server, true
		end
	end
	if #found == 1 or (state.anyway and #found > 0) then
		return found[1], false
	end
	return nil, false
end

local function stopSession()
	local session = state.session
	state.session = nil
	if session then
		pcall(session.stop, session)
	end
end

-- Wakes the main loop early (a click, a reconnect request).
local function wake()
	local thread = state.wake
	if thread and coroutine.status(thread) == "suspended" then
		state.wake = nil
		task.spawn(thread)
	end
end

local function waitOrWake(seconds: number)
	state.wake = coroutine.running()
	local timer = task.delay(seconds, function()
		wake()
	end)
	coroutine.yield()
	pcall(task.cancel, timer)
end

-- Starts Rojo's sync against `server`. Returns when the session is connected or failed.
local function connect(server: Server)
	state.server = server
	setPhase("connecting", `{server.hello.project} on port {server.hello.rojoPort}`)
	Control.request(server.port, "POST", "/tt/plugin/hello", App.helloBody())
	local api = ApiContext.new(`http://{Control.HOST}:{server.hello.rojoPort}`)
	local session = ServeSession.new({ apiContext = api, twoWaySync = false })
	state.session = session
	local settled = false
	session:onStatusChanged(function(status, detail)
		if state.session ~= session then
			return
		end
		if status == ServeSession.Status.Connected then
			state.backoff = 1
			state.lastSyncAt = os.time()
			setPhase("connected", `{server.hello.project} ({server.hello.projectFile})`)
		elseif status == ServeSession.Status.Disconnected then
			state.session = nil
			setPhase("disconnected", if detail then tostring(detail) else "connection closed")
		end
		if state.mode == "server" then
			setLiveReload(status == ServeSession.Status.Connected)
		end
		if status ~= ServeSession.Status.Connecting then
			settled = true
			report()
			wake()
		end
	end)
	session:hookPostcommit(function()
		state.lastSyncAt = os.time()
		state.patches += 1
		render()
	end)
	session:start()
	while not settled and state.session == session do
		waitOrWake(1)
	end
end

local function loop()
	local lastHeartbeat = 0
	while state.plugin do
		if state.session then
			-- Connected: heartbeat; notice a restarted serve (new pid) and reattach to it.
			if os.clock() - lastHeartbeat >= HEARTBEAT_SECONDS then
				lastHeartbeat = os.clock()
				local server = state.server
				local ok, hello = Control.request(server.port, "GET", "/tt/hello")
				if ok and hello.pid ~= server.hello.pid then
					stopSession()
					setPhase("disconnected", "typetorch serve restarted")
				else
					report()
				end
			end
			waitOrWake(1)
		else
			-- Keep finding serve even when not syncing, so an agent's commands still reach this plugin.
			local found = Control.discover()
			state.candidates = found
			local server, matches = choose(found)
			if server then
				state.emptyProbes = 0
			else
				state.emptyProbes += 1
			end
			if not state.autoConnect then
				state.server = server
				setPhase("paused", "Auto-connect is off")
				report()
				waitOrWake(PROBE_SECONDS)
			elseif not server then
				state.server = nil
				if #found == 0 then
					setPhase("waiting", "Run `bun run typetorch serve` in the game folder")
				else
					setPhase("waiting", `{#found} servers run, none for this experience ({game.GameId})`)
				end
				waitOrWake(if state.emptyProbes > IDLE_PROBES then IDLE_PROBE_SECONDS else PROBE_SECONDS)
			elseif not matches and not state.confirmed[server.hello.pid] and not state.anyway then
				state.server = server
				setPhase(
					"confirm",
					if game.GameId == 0
						then `This place isn't published. Sync {server.hello.project} into it?`
						else `{server.hello.project} is for experience {server.hello.universeId}, this place is {game.GameId}`
				)
				report()
				waitOrWake(PROBE_SECONDS)
			elseif server.hello.rojoPort == 0 then
				state.server = server
				setPhase("connecting", "Rojo is starting")
				waitOrWake(1)
			else
				connect(server)
				if not state.session then
					-- Failed or dropped: retry with a short backoff, re-probing in case serve moved.
					waitOrWake(state.backoff)
					state.backoff = math.min(state.backoff * 2, MAX_BACKOFF)
				end
			end
		end
	end
end

-- Reads serve's status (compile errors, children) while the panel is open.
local ASSET_SCAN_EVERY = 3 -- status ticks

local function refreshAssets()
	state.assets.marked = Assets.scan()
	state.assets.scanned = true
	if state.server then
		local ok, lock = Control.request(state.server.port, "GET", "/tt/assets")
		state.assets.lock = if ok then lock else nil
	end
end

local function statusLoop()
	local ticks = 0
	while state.plugin do
		if panel and panel:isOpen() then
			if state.server then
				local ok, status = Control.request(state.server.port, "GET", "/tt/status")
				state.status = if ok then status else nil
			end
			if ticks % ASSET_SCAN_EVERY == 0 then
				refreshAssets()
			end
			ticks += 1
			render()
		end
		task.wait(STATUS_SECONDS)
	end
end

local function assetsMessage(text: string)
	state.assets.message = text
	refreshAssets()
	render()
end

function App.markSelection(key: string)
	local _, message = Assets.markSelection(key)
	assetsMessage(message)
end

function App.unmarkSelection()
	local _, message = Assets.unmarkSelection()
	assetsMessage(message)
end

-- Runs a hot asset job in typetorch serve and follows it until it ends.
function App.runJob(kind: string)
	local server = state.server
	if not server then
		assetsMessage("Start typetorch serve first")
		return
	end
	if state.assets.job and state.assets.job.state == "running" then
		return
	end
	for _, entry in Assets.scan() do
		if #entry.problems > 0 then
			assetsMessage(`Fix the problems first ({entry.key}: {entry.problems[1]})`)
			return
		end
	end
	state.assets.message = if kind == "assets-status"
		then ""
		else "Sync reads the PUBLISHED place: publish your changes first (File > Publish to Roblox)."
	local ok, job = Control.request(server.port, "POST", "/tt/jobs", { kind = kind })
	if not ok then
		state.assets.job = nil
		state.assets.jobText = `Couldn't start: {job}`
		render()
		return
	end
	state.assets.job = job
	task.spawn(function()
		while state.plugin and job.state == "running" do
			state.assets.jobText = Assets.describeJob(job)
			render()
			task.wait(1)
			local polled, latest = Control.request(server.port, "GET", `/tt/jobs?id={job.id}`)
			if polled then
				job = latest
				state.assets.job = job
			end
		end
		state.assets.jobText = Assets.describeJob(job)
		refreshAssets()
		render()
	end)
end

-- Drops the connection and starts over (a full resync).
function App.reconnect()
	stopSession()
	state.backoff = 1
	setPhase("disconnected", "reconnecting")
	wake()
end

function App.setAutoConnect(on: boolean)
	state.autoConnect = on
	if state.plugin then
		state.plugin:SetSetting(settingKey(), on)
	end
	if not on then
		stopSession()
	end
	wake()
end

function App.confirm()
	if state.server then
		state.confirmed[state.server.hello.pid] = true
		if state.plugin then
			state.plugin:SetSetting(confirmedKey(), state.server.hello.pid)
		end
	end
	wake()
end

function App.setLivePlaytest(on: boolean)
	if state.plugin then
		state.plugin:SetSetting(LIVE_SETTING, on)
	end
	render()
end

-- An agent's "reconnect": auto-connect on, resync from scratch, and wait (a while) to say how it went.
local function agentReconnect(args)
	if args.anyway then
		state.anyway = true
		if state.server then
			App.confirm()
		end
	end
	if not state.autoConnect then
		App.setAutoConnect(true)
	end
	App.reconnect()
	local started = os.clock()
	while os.clock() - started < AGENT_RECONNECT_WAIT do
		task.wait(0.25)
		if state.phase == "connected" then
			break
		end
		-- Nothing to connect to, or waiting for a click: no use waiting longer.
		if (state.phase == "waiting" or state.phase == "confirm") and os.clock() - started > 3 then
			break
		end
	end
	return true, { phase = state.phase, detail = state.detail }
end

local function testService()
	local ok, service = pcall(game.GetService, game, "StudioTestService")
	return if ok then service else nil
end

-- Starts a playtest. ExecutePlayModeAsync yields until the test ends, so it runs on its own thread; an error within
-- the first moments is reported as the command's failure.
local function agentPlay(args)
	local service = testService()
	local runMode = args.mode == "run"
	local failure
	task.spawn(function()
		local ok, err
		if service then
			ok, err = pcall(function()
				if runMode then
					service:ExecuteRunModeAsync({})
				else
					service:ExecutePlayModeAsync({})
				end
			end)
		else
			ok, err = false, "StudioTestService isn't available in this Studio"
		end
		if not ok and runMode then
			ok, err = pcall(RunService.Run, RunService)
		end
		if not ok then
			failure = tostring(err)
		end
	end)
	task.wait(1.5)
	if failure then
		return false, `couldn't start the playtest: {failure}`
	end
	return true, { mode = if runMode then "run" else "play" }
end

local function agentStop()
	if state.mode == "server" then
		local service = testService()
		if not service then
			return false, "StudioTestService isn't available in this Studio"
		end
		local ok, err = pcall(service.EndTest, service, {})
		if not ok then
			return false, `couldn't end the playtest: {err}`
		end
		return true, {}
	elseif state.mode == "edit" then
		if not RunService:IsRunning() then
			return false, "no playtest server is attached; is a playtest running?"
		end
		local ok, err = pcall(RunService.Stop, RunService)
		if not ok then
			return false, `couldn't stop Run mode: {err}`
		end
		return true, {}
	end
	return false, "send stop to the playtest server (the default target)"
end

local function startAgent()
	local handlers = {
		ping = function()
			return true, {
				mode = state.mode,
				phase = state.phase,
				detail = state.detail,
				livePlaytest = livePlaytest(),
			}
		end,
		stop = agentStop,
	}
	if state.mode == "edit" then
		handlers.reconnect = agentReconnect
		handlers.play = agentPlay
	end
	Agent.start({
		id = state.id,
		mode = state.mode,
		server = function()
			return state.server
		end,
		helloBody = App.helloBody,
		alive = function()
			return state.plugin ~= nil
		end,
		handlers = handlers,
		onReconnectAttribute = if state.mode == "edit"
			then function()
				task.spawn(agentReconnect, { anyway = false })
			end
			else nil,
	})
end

-- Whether the playtest may sync from `server`: the same rule as the edit session (its experience, or the serve the
-- user accepted with "Connect anyway"), and only while the edit session's auto-connect is on.
local function playtestMaySync(server: Server, matches: boolean): boolean
	if not livePlaytest() or state.plugin:GetSetting(settingKey()) == false then
		return false
	end
	return matches or state.plugin:GetSetting(confirmedKey()) == server.hello.pid
end

-- A playtest's server or client DataModel: the agent's commands and the Output; on the server, the live sync too.
local function playtestLoop()
	while state.plugin do
		local found = Control.discover()
		local server, matches = choose(found)
		if server and (not state.server or state.server.hello.pid ~= server.hello.pid) then
			stopSession() -- serve restarted: start over
			state.server = server
			Control.request(server.port, "POST", "/tt/plugin/hello", App.helloBody())
		elseif not server then
			stopSession()
			state.server = nil
		end
		if state.server then
			local current = state.server
			if
				state.mode == "server"
				and not state.session
				and current.hello.rojoPort ~= 0
				and playtestMaySync(current, matches)
			then
				connect(current)
			elseif state.mode == "server" and state.session and not livePlaytest() then
				stopSession()
				setLiveReload(false)
				setPhase("idle", "Live playtest is off")
			end
			report()
		end
		task.wait(HEARTBEAT_SECONDS)
	end
end

function App.start(plugin: Plugin)
	state.plugin = plugin
	plugin.Unloading:Connect(function()
		state.plugin = nil
		stopSession()
		wake()
	end)
	if not RunService:IsEdit() then
		state.mode = if RunService:IsServer() then "server" else "client"
		state.phase = "idle"
		task.spawn(playtestLoop)
		startAgent()
		return
	end
	local saved = plugin:GetSetting(settingKey())
	state.autoConnect = if saved == nil then true else saved == true
	Log.setLogLevelThunk(function()
		return Log.Level.Warning
	end)
	panel = Panel.new(plugin, {
		reconnect = App.reconnect,
		setAutoConnect = App.setAutoConnect,
		confirm = App.confirm,
		setLivePlaytest = App.setLivePlaytest,
		markSelection = App.markSelection,
		unmarkSelection = App.unmarkSelection,
		runJob = App.runJob,
		suggestKey = Assets.suggestKey,
	}, VERSION)
	render()
	task.spawn(loop)
	task.spawn(statusLoop)
	startAgent()
end

return App
