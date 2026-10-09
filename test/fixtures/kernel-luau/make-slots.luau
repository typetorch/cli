--!nocheck
-- The slots .rbxm the luau engine sends as binary input: one Folder TypeTorchKernelSlots, a Folder per service, the slots.
--   lune run make-slots.luau <kernel.rbxl> <out.rbxm> [extra]
--     the three kernel slots of a kernel place (a fixture of test/fixtures/kernel-patch/make-fixtures.luau); "extra"
--     also puts a non-slot instance in (ServerScriptService.NotASlot), which the task must refuse
--   lune run make-slots.luau <kernel.rbxl> <out.rbxm> loader
--     the loader slots (install-loader): ServerScriptService.TypeTorchLoader, ReplicatedFirst.TypeTorchLoaderClient and
--     ServerStorage.TypeTorchKernelBaked holding the kernel slots of <kernel.rbxl>
--   lune run make-slots.luau - <out.rbxm> backup <artifactId>
--     only ServerStorage.TypeTorchBackup: a small prod payload (Model, Server/boot ModuleScript) stamped like
--     payloads.ts backupRbxm (BackupArtifactId and the other Backup* attributes)
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local process = require("@lune/process")

local root = roblox.Instance.new("Folder")
root.Name = "TypeTorchKernelSlots"
local function serviceFolder(name)
	local folder = root:FindFirstChild(name)
	if folder == nil then
		folder = roblox.Instance.new("Folder")
		folder.Name = name
		folder.Parent = root
	end
	return folder
end

if process.args[3] == "loader" then
	-- install-loader: the loader Script (identity on it), its client, and the kernel of <kernel.rbxl> baked in ServerStorage.
	local kernel = roblox.deserializePlace(fs.readFile(process.args[1]))
	local loader = roblox.Instance.new("Script")
	loader.Name = "TypeTorchLoader"
	loader.Source = "-- loader"
	for _, key in { "KernelVersion", "KernelHash", "KeyAssetId" } do
		loader:SetAttribute(key, kernel:GetService("ServerScriptService").TypeTorchKernel:GetAttribute(key))
	end
	loader.Parent = serviceFolder("ServerScriptService")
	local client = roblox.Instance.new("LocalScript")
	client.Name = "TypeTorchLoaderClient"
	client.Source = "-- loader client"
	client.Parent = serviceFolder("ReplicatedFirst")
	local baked = roblox.Instance.new("Folder")
	baked.Name = "TypeTorchKernelBaked"
	for _, slot in { { "ServerScriptService", "TypeTorchKernel" }, { "ReplicatedStorage", "TypeTorchKernelShared" }, { "ReplicatedFirst", "TypeTorchKernelClient" } } do
		local holder = baked:FindFirstChild(slot[1]) or roblox.Instance.new("Folder")
		holder.Name = slot[1]
		holder.Parent = baked
		kernel:GetService(slot[1]):FindFirstChild(slot[2]):Clone().Parent = holder
	end
	baked.Parent = serviceFolder("ServerStorage")
elseif process.args[3] == "backup" then
	local id = process.args[4]
	local model = roblox.Instance.new("Model")
	model.Name = "TypeTorchBackup"
	for key, value in { ArtifactId = id, Channel = "prod", BackupArtifactId = id, BackupSeq = 7, BackupBranch = "prod", BackupChannel = "prod", BackupAt = "2026-10-09T00:00:00.000Z" } do
		model:SetAttribute(key, value)
	end
	for _, name in { "Server", "Shared", "Client", "include" } do
		local folder = roblox.Instance.new("Folder")
		folder.Name = name
		folder.Parent = model
	end
	local boot = roblox.Instance.new("ModuleScript")
	boot.Name = "boot"
	boot.Source = "return { boot = function() return function() end end } -- " .. id .. "\n"
	boot.Parent = model:FindFirstChild("Server")
	model.Parent = serviceFolder("ServerStorage")
else
	local kernel = roblox.deserializePlace(fs.readFile(process.args[1]))
	for _, slot in { { "ServerScriptService", "TypeTorchKernel" }, { "ReplicatedStorage", "TypeTorchKernelShared" }, { "ReplicatedFirst", "TypeTorchKernelClient" } } do
		kernel:GetService(slot[1]):FindFirstChild(slot[2]):Clone().Parent = serviceFolder(slot[1])
	end
	if process.args[3] == "extra" then
		local extra = roblox.Instance.new("Folder")
		extra.Name = "NotASlot"
		extra.Parent = serviceFolder("ServerScriptService")
	end
end
fs.writeFile(process.args[2], roblox.serializeModel({ root }))
print("ok")
