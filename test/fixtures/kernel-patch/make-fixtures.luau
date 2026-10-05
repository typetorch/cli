--!nocheck
-- Fixture places for the kernel patch tests (test/kernelpatch.test.ts), made with Lune's rbx-dom:
--   lune run make-fixtures.luau <out dir>
-- game.rbxl            a small game: map, GUI, game scripts, settings off; no ReplicatedFirst and no kernel
-- kernel-v1.rbxl       a kernel build: the three slots (+ a baseplate that is not a slot), settings on
-- kernel-v2.rbxl       Kernel changed, Api removed, Extra added, vendor kept (KernelVersion 1.1.0)
-- kernel-v3.rbxl       shrunk: no Api, no vendor (fewer instances than v1)
-- game-installed.rbxl  the game with kernel v1 inside, two copies of the client slot, and ObjectValues in Workspace
--                      that point at the kernel's Constants and Api and at the game's own Lobby
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local process = require("@lune/process")

local Instance = roblox.Instance
local Vector3 = roblox.Vector3
local Color3 = roblox.Color3
local out = process.args[1] or "."

local function make(className, name, parent, props)
	local instance = Instance.new(className)
	instance.Name = name
	for key, value in props or {} do
		instance[key] = value
	end
	instance.Parent = parent
	return instance
end

local function game()
	local dm = Instance.new("DataModel")
	local workspace = dm:GetService("Workspace")
	local lobby = make("Model", "Lobby", workspace)
	for i = 1, 5 do
		local part = make("Part", "Step" .. i, lobby, { Anchored = true, Size = Vector3.new(4, 1, 4), Position = Vector3.new(i * 4, i, 0), Color = Color3.new(0.2 * i, 0.5, 0.3) })
		part:SetAttribute("Index", i)
		part:AddTag("Step")
	end
	make("SpawnLocation", "Spawn", workspace, { Anchored = true })
	make("ObjectValue", "RefGame", workspace, { Value = lobby })
	local sss = dm:GetService("ServerScriptService")
	sss.LoadStringEnabled = false
	make("Script", "GameMain", sss, { Source = "print('game')\n" })
	local systems = make("Folder", "Systems", sss)
	make("ModuleScript", "Combat", systems, { Source = "return { damage = 10 }\n" })
	make("ModuleScript", "Shop", systems, { Source = "return { items = {} }\n" })
	local rs = dm:GetService("ReplicatedStorage")
	local shared = make("Folder", "Shared", rs)
	make("ModuleScript", "Config", shared, { Source = "return { version = 3 }\n" })
	make("RemoteEvent", "Ping", rs)
	local gui = dm:GetService("StarterGui")
	local screen = make("ScreenGui", "Hud", gui)
	local frame = make("Frame", "Bar", screen, { BackgroundColor3 = Color3.new(1, 0, 0) })
	make("TextLabel", "Coins", frame, { Text = "0 coins" })
	make("ImageLabel", "Icon", frame, { Image = "rbxassetid://1234" })
	dm:GetService("Lighting").ClockTime = 6
	dm:GetService("HttpService").HttpEnabled = false
	return dm
end

local function kernel(version, opts)
	local dm = Instance.new("DataModel")
	make("Part", "Baseplate", dm:GetService("Workspace"), { Anchored = true })
	local sss = dm:GetService("ServerScriptService")
	sss.LoadStringEnabled = true
	dm:GetService("HttpService").HttpEnabled = true
	local folder = make("Folder", "TypeTorchKernel", sss)
	folder:SetAttribute("KernelVersion", version)
	folder:SetAttribute("KernelHash", string.rep(string.sub(version, 1, 1), 64))
	folder:SetAttribute("KeyAssetId", 123456789)
	make("Script", "Kernel", folder, { Source = "-- kernel " .. (opts.kernelSource or version) .. "\n" })
	if opts.api then
		make("ModuleScript", "Api", folder, { Source = "return 'api'\n" })
	end
	if opts.extra then
		make("ModuleScript", "Extra", folder, { Source = "return 'extra'\n" })
	end
	if opts.vendor then
		local vendor = make("Folder", "vendor", folder)
		make("ModuleScript", "Lib", vendor, { Source = "return 'lib'\n" })
		make("ModuleScript", "Lib2", vendor, { Source = "return 'lib2'\n" })
	end
	make("Script", "Entry", folder, { Source = "-- entry\n", Disabled = true })
	local shared = make("Folder", "TypeTorchKernelShared", dm:GetService("ReplicatedStorage"))
	make("ModuleScript", "Constants", shared, { Source = 'return { KERNEL_VERSION = "' .. version .. '" }\n' })
	make("LocalScript", "ClientEntry", shared, { Source = "-- client entry\n", Disabled = true })
	make("LocalScript", "TypeTorchKernelClient", dm:GetService("ReplicatedFirst"), { Source = "-- client " .. version .. "\n" })
	return dm
end

local function write(name, dm)
	fs.writeFile(out .. "/" .. name, roblox.serializePlace(dm))
end

write("game.rbxl", game())
write("kernel-v1.rbxl", kernel("1.0.0", { api = true, vendor = true }))
write("kernel-v2.rbxl", kernel("1.1.0", { api = false, extra = true, vendor = true, kernelSource = "1.1.0 changed" }))
write("kernel-v3.rbxl", kernel("1.2.0", { api = false, vendor = false }))

local installed = game()
local v1 = kernel("1.0.0", { api = true, vendor = true })
local slots = {
	{ "ServerScriptService", "TypeTorchKernel" },
	{ "ReplicatedStorage", "TypeTorchKernelShared" },
	{ "ReplicatedFirst", "TypeTorchKernelClient" },
}
for _, slot in slots do
	v1:GetService(slot[1]):FindFirstChild(slot[2]):Clone().Parent = installed:GetService(slot[1])
end
-- A stale second copy of the client slot (e.g. pasted twice in Studio).
v1:GetService("ReplicatedFirst"):FindFirstChild("TypeTorchKernelClient"):Clone().Parent = installed:GetService("ReplicatedFirst")
local workspace = installed:GetService("Workspace")
make("ObjectValue", "RefConstants", workspace, { Value = installed:GetService("ReplicatedStorage").TypeTorchKernelShared.Constants })
make("ObjectValue", "RefApi", workspace, { Value = installed:GetService("ServerScriptService").TypeTorchKernel.Api })
write("game-installed.rbxl", installed)
print("ok")
