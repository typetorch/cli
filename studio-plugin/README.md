# TypeTorch Studio plugin

Attaches Roblox Studio to `typetorch serve` by itself and keeps it synced: no Connect button, no reconnecting by hand.
Install it with `typetorch studio install-plugin` (builds this folder with Rojo into Studio's plugins folder as
`TypeTorchSync.rbxm`), then restart Studio. The CLI's README ("Studio: typetorch serve") describes the whole loop.

- `src/Main.server.luau`: the plugin script.
- `src/TypeTorch/App.luau`: finds the server (`GET /tt/hello` on 34880-34887), picks the one whose universeId matches
  the place, runs Rojo's sync, reconnects, reports to the server. In a playtest's server it syncs into the running game
  and sets `ServerStorage.TypeTorchDev`'s `LiveReload` attribute, which makes the kernel (0.5.4+) reload on changes.
- `src/TypeTorch/Agent.luau`: in every DataModel (edit, playtest server and client): runs the commands an agent sends
  through `typetorch studio` / `typetorch mcp` (long poll on `/tt/plugin/poll`), forwards Studio's Output, and in edit
  mode reconnects when the `TypeTorchReconnect` attribute is set on ServerStorage.
- `src/TypeTorch/Assets.luau`: hot assets in the place (mark, unmark, the sync's rules); the panel's Check / Sync /
  Sync + deploy buttons run as jobs in `typetorch serve` (`POST /tt/jobs`).
- `src/TypeTorch/Panel.luau`, `Widgets.luau`: the dock widget, in the TypeTorch dev menu's look.
- `src/TypeTorch/Control.luau`: the control API client (cli `src/serve/protocol.ts` is the contract).
- `vendor/rojo/`: Rojo's plugin core, unchanged except where marked.

## Rojo (vendored, MPL-2.0)

`vendor/rojo/` is the plugin core of [Rojo](https://github.com/rojo-rbx/rojo) **7.7.0-rc.1** (the version
`rokit.toml` pins in TypeTorch games), so it speaks the same protocol as `rojo serve`: `plugin/src` without the
Roact UI (`App/`), assets, sounds, tests and its entry script, plus its packages `http`, `log`, `fmt`, `rbx_dom_lua`
(without `allValues.json`, used only by tests), Promise and t. Those files are under the Mozilla Public License 2.0
(`vendor/rojo/LICENSE.txt`); Promise and t keep their own licenses next to them.

Changed files (MPL-2.0 still applies to them, and each says what changed at its top):

- `Plugin/Settings.lua`: no Roact (`getBinding`/`getBindings` removed); settings are stored as `TypeTorchRojo_<name>`
  so they never mix with the stock Rojo plugin's.

To update Rojo: copy the same files from the new tag, re-apply the change above, and keep `Version.txt` in step with
the `rojo` that `rokit.toml` pins.
