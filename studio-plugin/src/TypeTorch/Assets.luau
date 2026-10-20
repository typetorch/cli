--!nonstrict
-- Hot assets from inside Studio: mark and unmark instances (the TypeTorchAsset attribute), and check the place by the
-- same rules `typetorch assets sync` applies (cli src/assets.ts exportScript): a valid unique key, no scripts inside,
-- not inside another hot asset, not a service, no "/" in a parent's name. Syncing itself runs in `typetorch serve`
-- (POST /tt/jobs), since it uploads with the project's assets key.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")

local Assets = {}

Assets.ATTRIBUTE = "TypeTorchAsset"
local KEY_MAX = 64

export type Marked = {
	key: string,
	instance: Instance,
	path: string,
	className: string,
	problems: { string },
}

function Assets.keyError(key: any): string?
	if type(key) ~= "string" or #key == 0 then
		return "the key is empty"
	elseif #key > KEY_MAX then
		return `the key is longer than {KEY_MAX} characters`
	elseif not string.match(key, "^[a-z0-9/_%-]+$") then
		return `the key may only use lowercase a-z, 0-9, "/", "-" and "_"`
	end
	return nil
end

-- A key from an instance's name: lowercase, anything else becomes "-".
function Assets.suggestKey(instance: Instance): string
	local key = string.lower(instance.Name)
	key = string.gsub(key, "[^a-z0-9/_%-]+", "-")
	key = string.gsub(key, "^%-+", "")
	key = string.gsub(key, "%-+$", "")
	if key == "" then
		key = "asset"
	end
	return string.sub(key, 1, KEY_MAX)
end

local function pathOf(instance: Instance): string
	local parts = {}
	local current = instance.Parent
	while current and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	return table.concat(parts, "/")
end

local function hasScripts(instance: Instance): number
	local count = if instance:IsA("LuaSourceContainer") then 1 else 0
	for _, descendant in instance:GetDescendants() do
		if descendant:IsA("LuaSourceContainer") then
			count += 1
		end
	end
	return count
end

-- Every marked instance in the place with its problems, sorted by key.
function Assets.scan(): { Marked }
	local found = {}
	local byInstance = {}
	for _, service in game:GetChildren() do
		pcall(function()
			if service:GetAttribute(Assets.ATTRIBUTE) ~= nil then
				local entry = {
					key = tostring(service:GetAttribute(Assets.ATTRIBUTE)),
					instance = service,
					path = "",
					className = service.ClassName,
					problems = { "a service can't be a hot asset" },
				}
				table.insert(found, entry)
			end
			for _, instance in service:GetDescendants() do
				local raw = instance:GetAttribute(Assets.ATTRIBUTE)
				if raw ~= nil then
					local entry = {
						key = tostring(raw),
						instance = instance,
						path = pathOf(instance),
						className = instance.ClassName,
						problems = {},
					}
					local keyProblem = Assets.keyError(raw)
					if keyProblem then
						table.insert(entry.problems, keyProblem)
					end
					table.insert(found, entry)
					byInstance[instance] = entry
				end
			end
		end)
	end
	local seen = {}
	for _, entry in found do
		if seen[entry.key] then
			table.insert(entry.problems, `the key is also used at {seen[entry.key].path}`)
		end
		seen[entry.key] = entry
		local instance = entry.instance
		local scripts = hasScripts(instance)
		if scripts > 0 then
			table.insert(entry.problems, `holds {scripts} script{if scripts == 1 then "" else "s"}`)
		end
		local ancestor = instance.Parent
		while ancestor and ancestor ~= game do
			if byInstance[ancestor] then
				table.insert(entry.problems, `inside the hot asset "{byInstance[ancestor].key}"`)
				break
			end
			if string.find(ancestor.Name, "/", 1, true) then
				table.insert(entry.problems, `a parent's name has a "/": {ancestor.Name}`)
			end
			ancestor = ancestor.Parent
		end
	end
	table.sort(found, function(a, b)
		return a.key < b.key
	end)
	return found
end

-- Marks the selected instance. Returns (ok, message).
function Assets.markSelection(key: string): (boolean, string)
	local selected = Selection:Get()
	if #selected ~= 1 then
		return false, "Select one instance first"
	end
	local instance = selected[1]
	if instance.Parent == game then
		return false, "A service can't be a hot asset"
	end
	local problem = Assets.keyError(key)
	if problem then
		return false, problem
	end
	for _, entry in Assets.scan() do
		if entry.key == key and entry.instance ~= instance then
			return false, `"{key}" is already used at {entry.path}`
		end
	end
	local scripts = hasScripts(instance)
	if scripts > 0 then
		return false, `{instance.Name} holds {scripts} script{if scripts == 1 then "" else "s"}: hot assets can't`
	end
	local recording = ChangeHistoryService:TryBeginRecording("TypeTorch: mark hot asset")
	instance:SetAttribute(Assets.ATTRIBUTE, key)
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	return true, `Marked {instance.Name} as "{key}". Publish the place, then Sync.`
end

function Assets.unmarkSelection(): (boolean, string)
	local selected = Selection:Get()
	local count = 0
	local recording = ChangeHistoryService:TryBeginRecording("TypeTorch: unmark hot asset")
	for _, instance in selected do
		if instance:GetAttribute(Assets.ATTRIBUTE) ~= nil then
			instance:SetAttribute(Assets.ATTRIBUTE, nil)
			count += 1
		end
	end
	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end
	if count == 0 then
		return false, "Nothing selected is a hot asset"
	end
	return true, `Unmarked {count}. Publish the place, then Sync.`
end

-- A one-line summary of a finished job's JSON answer (cli `typetorch assets status|sync --json`).
function Assets.describeJob(job): string
	if job.state == "running" then
		local last = job.tail and job.tail[#job.tail]
		return if last then `Running: {last}` else "Running"
	elseif job.state == "failed" then
		return `Failed: {job.error or "see typetorch serve's log"}`
	end
	local result = job.result
	if type(result) ~= "table" then
		return "Done"
	end
	local counts = { added = 0, updated = 0, removed = 0, unchanged = 0 }
	for _, change in result.changes or {} do
		counts[change.status] = (counts[change.status] or 0) + 1
	end
	local summary = `{counts.added} new, {counts.updated} changed, {counts.removed} removed, {counts.unchanged} unchanged`
	if result.dryRun then
		return if result.upToDate then `Up to date ({summary})` else `To sync: {summary}`
	end
	local text = `Synced: {summary}`
	local deploy = result.deploy
	if type(deploy) == "table" then
		if deploy.proposal then
			text ..= `. Deploy waits for approval: {deploy.approve or "typetorch approve"}`
		else
			text ..= ". Deployed"
		end
	end
	return text
end

return Assets
