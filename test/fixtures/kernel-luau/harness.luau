--!nocheck
-- Runs a generated kernel task script (src/kernelpatch-task.ts) under Lune against a mock DataModel:
--   lune run harness.luau <task.luau> <place.rbxl> <input.rbxm|-> <options.json> <out.json> [<saved.rbxl>]
-- The place is deserialized with rbx-dom; `game` is a proxy whose GetService returns mocks for the engine services a
-- task uses (SerializationService through rbx-dom's serializeModel/deserializeModel, EncodingService's SHA-256,
-- AssetService:SavePlaceAsync, which writes the DataModel to <saved.rbxl>) and the real rbx-dom services otherwise.
-- options.json:
--   placeId, placeVersion      what game.PlaceId / game.PlaceVersion read
--   saveError                  SavePlaceAsync raises this text
--   denySetting                writing this HttpService property raises (a property tasks can't set)
--   tamperOnSetting            reading HttpService.HttpEnabled changes Workspace.Lobby.Step1 (an engine side effect)
--   noEncoding                 no EncodingService mock (the script falls back to FNV)
--   unstableBytes              SerializeInstancesAsync appends a counter (bytes differ on every read)
-- Writes {result, calls} as JSON to <out.json>.
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local luau = require("@lune/luau")
local process = require("@lune/process")

local args = process.args
local source = fs.readFile(args[1])
local dm = roblox.deserializePlace(fs.readFile(args[2]))
local options = serde.decode("json", fs.readFile(args[4]))
local calls = { save = 0, deserialize = 0, serialize = 0, hash = 0 }

local function hexToBuffer(hex)
	local out = buffer.create(#hex // 2)
	for i = 0, #hex // 2 - 1 do
		buffer.writeu8(out, i, tonumber(string.sub(hex, i * 2 + 1, i * 2 + 2), 16))
	end
	return out
end

local mocks = {}
local counter = 0
mocks.SerializationService = {
	DeserializeInstancesAsync = function(_, buf)
		calls.deserialize += 1
		return roblox.deserializeModel(buffer.tostring(buf))
	end,
	SerializeInstancesAsync = function(_, list)
		calls.serialize += 1
		local bytes = roblox.serializeModel(list)
		if options.unstableBytes then
			counter += 1
			bytes ..= tostring(counter)
		end
		return buffer.fromstring(bytes)
	end,
}
if not options.noEncoding then
	mocks.EncodingService = {
		ComputeBufferHash = function(_, buf, algorithm)
			assert(algorithm == "Sha256", "unexpected hash algorithm " .. tostring(algorithm))
			calls.hash += 1
			return hexToBuffer(serde.hash("sha256", buffer.tostring(buf)))
		end,
	}
else
	-- An EncodingService without the method: the script must fall back.
	mocks.EncodingService = {}
end
mocks.AssetService = {
	SavePlaceAsync = function(_)
		calls.save += 1
		if options.saveError then
			error(options.saveError, 0)
		end
		if args[6] then
			fs.writeFile(args[6], roblox.serializePlace(dm))
		end
	end,
}
if options.denySetting or options.tamperOnSetting then
	local http = dm:GetService("HttpService")
	mocks.HttpService = setmetatable({}, {
		__index = function(_, key)
			if key == "HttpEnabled" and options.tamperOnSetting then
				dm:GetService("Workspace"):FindFirstChild("Lobby"):FindFirstChild("Step1"):SetAttribute("Index", 99)
			end
			return http[key]
		end,
		__newindex = function(_, key, value)
			if key == options.denySetting then
				error("The current thread cannot write '" .. key .. "' (lacking capability)", 0)
			end
			http[key] = value
		end,
	})
end

local game = setmetatable({}, {
	__index = function(_, key)
		if key == "GetService" then
			return function(_, name)
				return mocks[name] or dm:GetService(name)
			end
		elseif key == "FindService" then
			return function(_, name)
				return mocks[name] or dm:FindService(name)
			end
		elseif key == "GetChildren" then
			return function()
				return dm:GetChildren()
			end
		elseif key == "PlaceId" then
			return options.placeId or 0
		elseif key == "PlaceVersion" then
			return options.placeVersion or 0
		end
		return dm[key]
	end,
})

local chunk = luau.load(source, { debugName = "kernel-task", environment = { game = game, Enum = { HashAlgorithm = { Sha256 = "Sha256" } } } })
local input = if args[3] ~= "-" then { BinaryInput = buffer.fromstring(fs.readFile(args[3])) } else {}
local result = chunk(input)
fs.writeFile(args[5], serde.encode("json", { result = result, calls = calls }))
