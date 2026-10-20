--[[
	Persistent plugin settings.

	TypeTorch: changed from Rojo 7.7.0-rc.1 (MPL-2.0): no Roact (getBinding/getBindings removed), settings stored as
	"TypeTorchRojo_<name>" so they never mix with the stock Rojo plugin's.
]]

local plugin = plugin or script:FindFirstAncestorWhichIsA("Plugin")
local Rojo = script:FindFirstAncestor("Rojo")
local Packages = Rojo.Packages

local Log = require(Packages.Log)

local defaultSettings = {
	openScriptsExternally = false,
	twoWaySync = false,
	autoReconnect = false,
	showNotifications = true,
	enableSyncFallback = true,
	syncReminderMode = "Notify" :: "None" | "Notify" | "Fullscreen",
	syncReminderPolling = true,
	checkForUpdates = true,
	checkForPrereleases = false,
	autoConnectPlaytestServer = false,
	confirmationBehavior = "Initial" :: "Never" | "Initial" | "Large Changes" | "Unlisted PlaceId",
	largeChangesConfirmationThreshold = 5,
	playSounds = true,
	typecheckingEnabled = false,
	logLevel = "Info",
	timingLogsEnabled = false,
	priorEndpoints = {},
}

local Settings = {}

Settings._values = table.clone(defaultSettings)
Settings._updateListeners = {}
Settings._bindings = {}

if plugin then
	for name, defaultValue in pairs(Settings._values) do
		local savedValue = plugin:GetSetting("TypeTorchRojo_" .. name)

		if savedValue == nil then
			-- plugin:SetSetting hits disc instead of memory, so it can be slow. Spawn so we don't hang.
			task.spawn(plugin.SetSetting, plugin, "TypeTorchRojo_" .. name, defaultValue)
			Settings._values[name] = defaultValue
		else
			Settings._values[name] = savedValue
		end
	end
	Log.trace("Loaded settings from plugin store")
end

function Settings:get(name)
	if defaultSettings[name] == nil then
		error("Invalid setings name " .. tostring(name), 2)
	end

	return self._values[name]
end

function Settings:set(name, value)
	self._values[name] = value
	if plugin then
		-- plugin:SetSetting hits disc instead of memory, so it can be slow. Spawn so we don't hang.
		task.spawn(plugin.SetSetting, plugin, "TypeTorchRojo_" .. name, value)
	end

	if self._updateListeners[name] then
		for callback in pairs(self._updateListeners[name]) do
			task.spawn(callback, value)
		end
	end

	Log.trace(string.format("Set setting '%s' to '%s'", name, tostring(value)))
end

function Settings:onChanged(name, callback)
	local listeners = self._updateListeners[name]
	if listeners == nil then
		listeners = {}
		self._updateListeners[name] = listeners
	end
	listeners[callback] = true

	Log.trace(string.format("Added listener for setting '%s' changes", name))

	return function()
		listeners[callback] = nil
		Log.trace(string.format("Removed listener for setting '%s' changes", name))
	end
end

-- TypeTorch: getBinding/getBindings (Roact bindings for Rojo's own UI) removed; this plugin has no Roact.

return Settings
