--!strict
-- HTTP calls to `typetorch serve`'s control API (cli src/serve/protocol.ts). Every request carries X-TypeTorch: 1.

local HttpService = game:GetService("HttpService")

local Control = {}

-- Must match CONTROL_PORTS in cli src/serve/protocol.ts.
Control.PORTS = { 34880, 34881, 34882, 34883, 34884, 34885, 34886, 34887 }
Control.HOST = "localhost"

export type Hello = {
	app: string,
	api: number,
	project: string,
	universeId: number,
	placeId: number,
	rojoPort: number,
	projectFile: string,
	pid: number,
	startedAt: string,
}

-- One request; returns (ok, decoded body or error text). Never throws.
function Control.request(port: number, method: string, path: string, body: any?): (boolean, any)
	local ok, response = pcall(HttpService.RequestAsync, HttpService, {
		Url = `http://{Control.HOST}:{port}{path}`,
		Method = method,
		Headers = { ["X-TypeTorch"] = "1", ["Content-Type"] = "application/json" },
		Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
	})
	if not ok then
		return false, tostring(response)
	end
	local decoded
	local decodedOk = pcall(function()
		decoded = HttpService:JSONDecode(response.Body)
	end)
	if not decodedOk then
		return false, `bad response from port {port}`
	end
	if not response.Success then
		return false, if type(decoded) == "table" and decoded.error then decoded.error else `HTTP {response.StatusCode}`
	end
	return true, decoded
end

-- Probes every control port at once; returns the servers that answered as typetorch serve.
function Control.discover(): { { port: number, hello: Hello } }
	local found = {}
	local pending = #Control.PORTS
	local thread = coroutine.running()
	local waiting = false
	for _, port in Control.PORTS do
		task.spawn(function()
			local ok, hello = Control.request(port, "GET", "/tt/hello")
			if ok and type(hello) == "table" and hello.app == "typetorch-serve" then
				table.insert(found, { port = port, hello = hello })
			end
			pending -= 1
			if pending == 0 and waiting then
				task.spawn(thread)
			end
		end)
	end
	if pending > 0 then
		waiting = true
		coroutine.yield()
	end
	table.sort(found, function(a, b)
		return a.port < b.port
	end)
	return found
end

return Control
