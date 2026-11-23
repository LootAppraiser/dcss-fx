# dcss-fx

Visual polish for **Dungeon Crawl Stone Soup Webtiles**, running in your browser as a
[DWEM](https://github.com/refracta/dcss-webtiles-extension-module) module. Purely cosmetic:
nothing is sent to the server and the game is never changed, it only changes how the map the
client already received is drawn.

- **Smooth movement**: sprites glide between tiles and the view follows you. Autoexplore and travel
  stay smooth instead of jumping (the picture never trails the game by more than 2 cells).
- **Hop** *(optional)*: a little body hop and squash while stepping.
- **Attack effects**: the attacker lunges, a hit target recoils and flashes (red for you, white for
  monsters), a miss makes the target sidestep. Overlapping hits all show.
- **Smooth light**: replaces the game's hard lit/dim tiles with one continuous ray-cast light pool around you:
  full brightness near you, falling off smoothly to the dim "remembered" level, with soft shadows behind walls
  and doorways. No tile edges show in the lighting. It only uses what the game already shows you, and visible
  monsters and items are never dimmed away. A hotkey toggles it so you can compare.
- HP/MP mini-bars follow your sprite instead of jumping.

Everything is **off until you turn it on in your RC**. Tile mode only (glyph/console mode and the
X map view are left alone).

## Install (once)

Nothing is pasted or maintained locally. You install one small loader **from this repo's URL**;
Tampermonkey keeps that loader up to date from git by itself, and the loader pulls the module from git, so
every push here reaches everyone automatically.

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Firefox, Chrome, Edge).
   *Greasemonkey does not work with DWEM.*
2. Install the **DWEM loader** userscript ("DCSS Webtiles Extension Module Loader"), following the
   [DWEM install instructions](https://github.com/refracta/dcss-webtiles-extension-module#installation-user).
   (Ctrl+F12 on a Webtiles page opens DWEM's module manager once it runs.)
3. Install the **DCSS FX loader** by opening this link and clicking **Install** in Tampermonkey:

   **<https://raw.githubusercontent.com/LootAppraiser/dcss-fx/main/userscript/dcss-fx.user.js>**

4. Add the options you want to your RC (on the server: **edit rc**). A ready-made block is in
   [`examples/rc-options.txt`](examples/rc-options.txt).
5. Reload the page. Ctrl+F12 should list `DcssFx`. Start a game.

**Updates are automatic.** A new version of the module appears one page reload after it is pushed here (at
most about 5 minutes later). Tampermonkey also re-checks the loader script itself from the link above.
If you ever installed a hand-pasted "DCSS FX (DWEM module)" script, delete it: it would load a second copy.

Works on the servers DWEM supports (CDI, CAO, CBR2, CNC, CPO, CXC, ...).

## RC options

| Option | Default | What it does |
|---|---|---|
| `fx_move_anim = true` | off | Step slide + camera follow |
| `fx_move_ms` | 110 | Length of one step (ms) |
| `fx_hop_anim = true` | off | Body hop + squash while stepping (implies the slide) |
| `fx_hop_height` | 0.12 | Peak hop height in cells |
| `fx_bump_anim = true` | off | Attack effects (lunge / recoil + flash / sidestep) |
| `fx_bump_ms` | 190 | Length of one attack effect (ms) |
| `fx_light = true` | off | Smooth ray-cast light around you |
| `fx_light_radius` | 8 | Distance in tiles where the light has faded to the remembered level |
| `fx_light_core` | 0.3 | Fraction of the radius that stays fully bright before the falloff starts |
| `fx_light_ambient` | 0.38 | Brightness of remembered (out of sight) tiles, and of everything past the radius |
| `fx_light_shadow` | 0.55 | Brightness floor for visible monsters and items, so none is lost in the dark |
| `fx_light_key` | F8 | Key that toggles the light on/off (`Alt+L`, `Ctrl+Shift+L`, ... or `off`) |

## Debugging (browser console, F12)

- `DWEM_FX.cfg` shows what your RC enabled (`move`, `bump`, `light`, ... should be `true`).
- `DWEM_FX.stats` has counters, including `maxLag` (worst trail behind the game, in cells) and bump
  diagnostics (`msgLines`, `attackMsgs`, `noAdjacent`).
- `DWEM_FX.configure({debug: true})` logs what the effects see; `DWEM_FX.configure({moveMs: 160})`
  changes things live; `DWEM_FX.toggleLight()` is the hotkey; `DWEM_FX.stop()` unhooks everything.
- Pin a version: `localStorage.DCSSFX_PIN = '<commit or tag>'`, then reload. `delete localStorage.DCSSFX_PIN` to follow
  the newest again.

## How it works

See [`docs/design.md`](docs/design.md). In short: the module hooks the game's dungeon renderer and map
data after the client loads, animates sprites on an overlay canvas while the real canvas is hidden, and
puts the real canvas back when the animation ends. Any error falls back to the game's normal drawing.

## Credits and license

MIT, see [LICENSE](LICENSE). Built on [DWEM](https://github.com/refracta/dcss-webtiles-extension-module)
by refracta. The ideas for attack bumps, a step hop and cadence-matched autoexplore motion were inspired by
[Polished Crawl](https://github.com/vittis/polished-crawl) (AGPL-3.0); it was only read for the concepts and
**no code was copied**. Not affiliated with the DCSS team.
