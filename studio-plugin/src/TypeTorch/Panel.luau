--!nonstrict
-- The plugin's dock widget: sync status, the matched server, the last compile result and the buttons. Same look as
-- the TypeTorch dev menu (Widgets.luau).

local Widgets = require(script.Parent.Widgets)
local COLORS = Widgets.COLORS
local make = Widgets.make

local Panel = {}
Panel.__index = Panel

local PHASES = {
	waiting = { "Waiting for typetorch serve", COLORS.dim },
	confirm = { "Found a server for another place", COLORS.warn },
	connecting = { "Connecting", COLORS.warn },
	connected = { "Synced", COLORS.good },
	disconnected = { "Disconnected, retrying", COLORS.bad },
	paused = { "Paused", COLORS.dim },
}

local MAX_ERRORS = 8

local function ago(t: number?): string
	if not t then
		return "never"
	end
	local seconds = os.time() - t
	if seconds < 5 then
		return "just now"
	elseif seconds < 60 then
		return `{seconds} s ago`
	elseif seconds < 3600 then
		return `{seconds // 60} min ago`
	end
	return `{seconds // 3600} h ago`
end

function Panel.new(plugin: Plugin, actions, version: string)
	local self = setmetatable({}, Panel)
	self.actions = actions
	local toolbar = plugin:CreateToolbar("TypeTorch")
	local button = toolbar:CreateButton("TypeTorchSync", "TypeTorch sync status", "", "TypeTorch")
	button.ClickableWhenViewportHidden = true
	local widget = plugin:CreateDockWidgetPluginGuiAsync(
		"TypeTorchSync",
		DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 420, 260, 240)
	)
	widget.Title = "TypeTorch"
	widget.Name = "TypeTorchSync"
	self.widget = widget
	button.Click:Connect(function()
		widget.Enabled = not widget.Enabled
	end)
	widget:GetPropertyChangedSignal("Enabled"):Connect(function()
		button:SetActive(widget.Enabled)
	end)

	local background = make("Frame", { BackgroundColor3 = COLORS.window, BorderSizePixel = 0, Size = UDim2.fromScale(1, 1) }, widget)
	local scroll = Widgets.scrolling(background)
	Widgets.pad(scroll, 12, 12)
	Widgets.verticalList(scroll, 10)

	local header = Widgets.line(scroll, "TypeTorch Sync", 18, COLORS.text, Enum.Font.BuilderSansBold)
	header.TextWrapped = false
	Widgets.line(scroll, `plugin {version}`, 14, COLORS.dim)

	-- Status card
	local statusCard = Widgets.card(scroll)
	self.dot, self.statusLabel = Widgets.statusLine(statusCard)
	self.detail = Widgets.line(statusCard, "", 14, COLORS.dim)
	self.project = Widgets.line(statusCard, "", 15)
	self.lastSync = Widgets.line(statusCard, "", 14, COLORS.dim)
	local buttons = Widgets.buttonRow(statusCard)
	Widgets.button(buttons, "Reconnect", function()
		actions.reconnect()
	end)
	self.autoButton = Widgets.button(buttons, "Auto-connect: on", function()
		actions.setAutoConnect(not self.autoConnect)
	end)
	self.confirmButton = Widgets.button(buttons, "Connect anyway", function()
		actions.confirm()
	end, COLORS.accent)
	self.confirmButton.TextColor3 = COLORS.dark

	-- Playtest card
	local playCard = Widgets.card(scroll)
	Widgets.line(playCard, "Playtest", 15, COLORS.text, Enum.Font.BuilderSansBold)
	Widgets.line(playCard, "Live playtest: code changes reach a running playtest without Stop + Play (kernel 0.5.4+).", 14, COLORS.dim)
	local playButtons = Widgets.buttonRow(playCard)
	self.liveButton = Widgets.button(playButtons, "Live playtest: on", function()
		actions.setLivePlaytest(not self.livePlaytest)
	end)

	-- Compile card
	local compileCard = Widgets.card(scroll)
	Widgets.line(compileCard, "Compile", 15, COLORS.text, Enum.Font.BuilderSansBold)
	self.compile = Widgets.line(compileCard, "", 14, COLORS.dim)
	self.errors = {}
	for i = 1, MAX_ERRORS do
		local label = Widgets.line(compileCard, "", 14, COLORS.bad, Enum.Font.RobotoMono)
		label.Visible = false
		self.errors[i] = label
	end

	-- Processes card
	local childrenCard = Widgets.card(scroll)
	Widgets.line(childrenCard, "typetorch serve", 15, COLORS.text, Enum.Font.BuilderSansBold)
	self.children = Widgets.line(childrenCard, "", 14, COLORS.dim)

	return self
end

function Panel:isOpen(): boolean
	return self.widget.Enabled
end

function Panel:render(state)
	local phase = PHASES[state.phase] or PHASES.waiting
	self.statusLabel.Text = phase[1]
	self.dot.BackgroundColor3 = phase[2]
	self.detail.Text = state.detail
	self.detail.Visible = state.detail ~= ""
	local server = state.server
	if server then
		self.project.Text = `{server.hello.project}: Rojo {server.hello.rojoPort}, control {server.port}`
	else
		self.project.Text = "No server attached"
	end
	self.lastSync.Text = `Last sync {ago(state.lastSyncAt)}, {state.patches} updates`
	self.autoConnect = state.autoConnect
	self.autoButton.Text = if state.autoConnect then "Auto-connect: on" else "Auto-connect: off"
	self.confirmButton.Visible = state.phase == "confirm"
	self.livePlaytest = state.plugin == nil or state.plugin:GetSetting("TypeTorch_livePlaytest") ~= false
	self.liveButton.Text = if self.livePlaytest then "Live playtest: on" else "Live playtest: off"

	local status = state.status
	if status and status.compile then
		local compile = status.compile
		local errors = compile.errors or {}
		if compile.state == "errors" then
			self.compile.Text = `{#errors} error{if #errors == 1 then "" else "s"}`
			self.compile.TextColor3 = COLORS.bad
		elseif compile.state == "ok" then
			self.compile.Text = "No errors"
			self.compile.TextColor3 = COLORS.good
		else
			self.compile.Text = if compile.state == "compiling" then "Compiling" else "Waiting for the first compile"
			self.compile.TextColor3 = COLORS.dim
		end
		for i, label in self.errors do
			local e = errors[i]
			label.Visible = e ~= nil
			if e then
				label.Text = `{e.file}:{e.line}  {e.message}`
			end
		end
		local lines = {}
		for _, child in status.children or {} do
			table.insert(lines, `{child.name}: {child.state}{if child.restarts > 0 then ` ({child.restarts} restarts)` else ""}`)
		end
		self.children.Text = if #lines > 0 then table.concat(lines, "\n") else "No processes"
	else
		self.compile.Text = if server then "Open this panel to load" else "Not connected"
		self.compile.TextColor3 = COLORS.dim
		for _, label in self.errors do
			label.Visible = false
		end
		self.children.Text = if server then "" else "Start it in the game folder: bun run typetorch serve"
	end
end

return Panel
