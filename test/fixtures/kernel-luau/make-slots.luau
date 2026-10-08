--!nocheck
-- The kernel slots .rbxm the luau engine sends as binary input, made from a kernel place (a fixture of
-- test/fixtures/kernel-patch/make-fixtures.luau): one Folder TypeTorchKernelSlots, a Folder per service, the slots.
--   lune run make-slots.luau <kernel.rbxl> <out.rbxm> [extra]
-- "extra" also puts a non-slot instance in (ServerScriptService.NotASlot), which the task must refuse.
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local process = require("@lune/process")

local kernel = roblox.deserializePlace(fs.readFile(process.args[1]))
local root = roblox.Instance.new("Folder")
root.Name = "TypeTorchKernelSlots"
for _, slot in { { "ServerScriptService", "TypeTorchKernel" }, { "ReplicatedStorage", "TypeTorchKernelShared" }, { "ReplicatedFirst", "TypeTorchKernelClient" } } do
	local folder = root:FindFirstChild(slot[1])
	if folder == nil then
		folder = roblox.Instance.new("Folder")
		folder.Name = slot[1]
		folder.Parent = root
	end
	kernel:GetService(slot[1]):FindFirstChild(slot[2]):Clone().Parent = folder
end
if process.args[3] == "extra" then
	local extra = roblox.Instance.new("Folder")
	extra.Name = "NotASlot"
	extra.Parent = root:FindFirstChild("ServerScriptService")
end
fs.writeFile(process.args[2], roblox.serializeModel({ root }))
print("ok")
