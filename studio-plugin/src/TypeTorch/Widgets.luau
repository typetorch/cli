--!strict
-- Building blocks of the plugin's panel, in the look of the TypeTorch dev menu (framework src/devtools/widgets.ts):
-- the same colors, BuilderSans, TextSize >= 14, buttons >= 32 px, no emojis or glyph icons (a status dot is a Frame).

local Widgets = {}

Widgets.COLORS = {
	window = Color3.fromRGB(22, 24, 30),
	header = Color3.fromRGB(30, 33, 41),
	row = Color3.fromRGB(36, 40, 50),
	button = Color3.fromRGB(50, 55, 68),
	stroke = Color3.fromRGB(64, 69, 82),
	accent = Color3.fromRGB(255, 138, 61),
	text = Color3.fromRGB(232, 234, 240),
	dim = Color3.fromRGB(150, 157, 172),
	good = Color3.fromRGB(112, 214, 134),
	warn = Color3.fromRGB(255, 196, 87),
	bad = Color3.fromRGB(255, 107, 107),
	info = Color3.fromRGB(122, 178, 255),
	dark = Color3.fromRGB(18, 18, 22),
}

Widgets.BUTTON_HEIGHT = 34

local COLORS = Widgets.COLORS

function Widgets.make(className: string, props: { [string]: any }, parent: Instance?): any
	local instance = Instance.new(className) :: any
	for key, value in props do
		instance[key] = value
	end
	if parent then
		instance.Parent = parent
	end
	return instance
end

local make = Widgets.make

function Widgets.corner(parent: Instance, radius: number)
	make("UICorner", { CornerRadius = UDim.new(0, radius) }, parent)
end

function Widgets.pad(parent: Instance, vertical: number, horizontal: number)
	make("UIPadding", {
		PaddingTop = UDim.new(0, vertical),
		PaddingBottom = UDim.new(0, vertical),
		PaddingLeft = UDim.new(0, horizontal),
		PaddingRight = UDim.new(0, horizontal),
	}, parent)
end

function Widgets.style(gui: any, text: string, size: number?, color: Color3?, font: Enum.Font?)
	gui.Text = text
	gui.TextSize = size or 15
	gui.TextColor3 = color or COLORS.text
	gui.Font = font or Enum.Font.BuilderSans
	gui.TextXAlignment = Enum.TextXAlignment.Left
	gui.TextWrapped = true
	gui.BorderSizePixel = 0
	return gui
end

function Widgets.verticalList(parent: Instance, gap: number)
	make("UIListLayout", {
		FillDirection = Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		Padding = UDim.new(0, gap),
	}, parent)
end

function Widgets.horizontalList(parent: Instance, gap: number)
	make("UIListLayout", {
		FillDirection = Enum.FillDirection.Horizontal,
		SortOrder = Enum.SortOrder.LayoutOrder,
		VerticalAlignment = Enum.VerticalAlignment.Center,
		Padding = UDim.new(0, gap),
	}, parent)
end

-- Script-free scrolling: AutomaticCanvasSize + a layout.
function Widgets.scrolling(parent: Instance): ScrollingFrame
	return make("ScrollingFrame", {
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollingDirection = Enum.ScrollingDirection.Y,
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = COLORS.dim,
		VerticalScrollBarInset = Enum.ScrollBarInset.ScrollBar,
		Size = UDim2.fromScale(1, 1),
	}, parent)
end

local function nextOrder(parent: Instance): number
	return #parent:GetChildren()
end

function Widgets.button(row: Instance, text: string, onClick: () -> (), color: Color3?): TextButton
	local button = Widgets.style(make("TextButton", { AutoButtonColor = true }), text, 15, COLORS.text, Enum.Font.BuilderSansMedium)
	button.TextXAlignment = Enum.TextXAlignment.Center
	button.TextWrapped = false
	button.BackgroundColor3 = color or COLORS.button
	button.Size = UDim2.fromOffset(0, Widgets.BUTTON_HEIGHT)
	button.AutomaticSize = Enum.AutomaticSize.X
	button.LayoutOrder = nextOrder(row)
	Widgets.corner(button, 6)
	Widgets.pad(button, 0, 12)
	button.Parent = row
	button.Activated:Connect(onClick)
	return button
end

-- A full-width text line (wraps); returns the label so callers can update it.
function Widgets.line(parent: Instance, text: string, size: number?, color: Color3?, font: Enum.Font?): TextLabel
	local label = Widgets.style(make("TextLabel", { BackgroundTransparency = 1 }), text, size, color, font)
	label.Size = UDim2.new(1, 0, 0, 0)
	label.AutomaticSize = Enum.AutomaticSize.Y
	label.LayoutOrder = nextOrder(parent)
	label.Parent = parent
	return label
end

-- A full-width one-line text input.
function Widgets.textBox(parent: Instance, placeholder: string): TextBox
	local box = Widgets.style(make("TextBox", { ClearTextOnFocus = false }), "", 15, COLORS.text, Enum.Font.RobotoMono)
	box.PlaceholderText = placeholder
	box.PlaceholderColor3 = COLORS.dim
	box.BackgroundColor3 = COLORS.window
	box.TextWrapped = false
	box.ClipsDescendants = true
	box.Size = UDim2.new(1, 0, 0, Widgets.BUTTON_HEIGHT)
	box.AutomaticSize = Enum.AutomaticSize.None
	box.LayoutOrder = nextOrder(parent)
	Widgets.corner(box, 6)
	Widgets.pad(box, 0, 10)
	make("UIStroke", { Color = COLORS.stroke, Thickness = 1, ApplyStrokeMode = Enum.ApplyStrokeMode.Border }, box)
	box.Parent = parent
	return box
end

-- A rounded card with a vertical list inside.
function Widgets.card(parent: Instance): Frame
	local frame = make("Frame", {
		BackgroundColor3 = COLORS.row,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		LayoutOrder = nextOrder(parent),
	}, parent)
	Widgets.corner(frame, 8)
	Widgets.pad(frame, 10, 12)
	Widgets.verticalList(frame, 6)
	return frame
end

-- A row of buttons that wraps.
function Widgets.buttonRow(parent: Instance): Frame
	local row = make("Frame", {
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		LayoutOrder = nextOrder(parent),
	}, parent)
	make("UIListLayout", {
		FillDirection = Enum.FillDirection.Horizontal,
		SortOrder = Enum.SortOrder.LayoutOrder,
		Wraps = true,
		Padding = UDim.new(0, 8),
	}, row)
	return row
end

-- A status dot (a Frame, no glyphs) next to a label; returns both.
function Widgets.statusLine(parent: Instance): (Frame, TextLabel)
	local row = make("Frame", {
		BackgroundTransparency = 1,
		Size = UDim2.new(1, 0, 0, 24),
		LayoutOrder = nextOrder(parent),
	}, parent)
	Widgets.horizontalList(row, 8)
	local dot = make("Frame", { BackgroundColor3 = COLORS.dim, BorderSizePixel = 0, Size = UDim2.fromOffset(12, 12), LayoutOrder = 1 }, row)
	Widgets.corner(dot, 6)
	local label = Widgets.style(make("TextLabel", { BackgroundTransparency = 1, LayoutOrder = 2 }), "", 16, COLORS.text, Enum.Font.BuilderSansBold)
	label.Size = UDim2.new(1, -20, 1, 0)
	label.TextWrapped = false
	label.TextTruncate = Enum.TextTruncate.AtEnd
	label.Parent = row
	return dot, label
end

return Widgets
