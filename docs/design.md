# dcss-fx design (v0.5)

## Delivery
A DWEM module (`src/index.js`, default export class with `onLoad`) that depends on `RCManager` for RC
options. `src/fx.js` is the core and has no DWEM dependency. DWEM loads modules from the URLs in
`localStorage.DWEM_MODULES`, so a tiny stable userscript (`userscript/dcss-fx.user.js`) registers
`https://cdn.jsdelivr.net/gh/LootAppraiser/dcss-fx@<commit>/src/index.js`. jsDelivr serves the files with a
JavaScript MIME type and CORS (GitHub's raw links do not, and are refused as modules). The loader pins
the newest commit (GitHub API, cached 5 min, applied on the next load) so updates need no Tampermonkey edit.
It also removes stale copies of our URL that DWEM saved in `localStorage.DWEM`, so two versions never load.
Rejected: a localhost dev server (Chromium blocks/prompts for public pages loading from loopback) and a
blob/data-URL bundle pasted into the userscript (every update needed a re-paste). No browser extension.

## How the animation works
The Webtiles client draws everything on one `#dungeon` canvas, one cell at a
time, only for cells that changed. There is no per-frame loop and no sub-cell
position, so v0.1 hooks the client after its AMD modules are loaded
(`requirejs.s.contexts._.defined`, keys `game-<ver>/<module>`):

- `dungeon_renderer.set_view_center`: the view is always centred on the player,
  so a 1-cell centre change = the player stepped. Starts a camera slide and a
  player "mover" (from old to new centre).
- `map_knowledge.merge` (wrapped): before merging a map diff, scan it for a
  monster id cleared in one cell and appearing in another within 2 cells = a
  monster step. Starts a mover.
- `dungeon_renderer.render_cell` (wrapped): for a mover's destination cell,
  capture its sprite (foreground only) to a 3x3-cell offscreen canvas, then
  render the cell without the sprite.
- While anything is animating, `#dungeon` gets `opacity: 0` (still receives
  mouse events) and a `#dcss-fx-stage` canvas sits on top: the real canvas
  blitted with the sliding camera offset plus the sprites at interpolated
  positions, driven by `requestAnimationFrame`.
- When done, destination cells are redrawn normally and the stage is hidden.
- Steps that arrive while an animation runs are chained (positions carry over,
  linear easing, duration = gap between steps, clamped to `minMs..moveMs`).

## Safety / limits
- Only in tile mode and not in map view (X); big jumps (teleport, stairs) and
  `map_knowledge.clear` cancel animations and snap.
- Any exception in a hook falls back to the original draw path.
- Unverified assumptions (to check against a live game): the server sends
  `mon: null` for the vacated cell and a monster with `id` for the new one; the
  view centre equals the player position; minibars on the player cell move with
  the camera.
- Not done yet: attack bumps (needs message parsing), lighting, ranged/spell
  effects, farview (right-click minimap) detection.

## Tested so far (2026-11-23, headless Chromium, spectating live CDI games)
- Blob-URL module import works on crawl.dcss.io; hooks install on the live
  client (`game-<hash>/dungeon_renderer`, `map_knowledge`, `enums`, `options`).
- Glyph-mode players are correctly left alone (`tile_display_mode != tiles`).
- Tile-mode spectate: 15 map merges -> 1 monster move detected, 8 frames
  animated, 0 render fallbacks, no errors.
- NOT yet checked visually (needs a human): smoothness, camera glide direction,
  sprite look, flicker at start/end, behaviour with travel/explore.

## v0.2 additions
- **Mini-bars**: the game draws the player's HP/MP bars into the player cell of the
  real canvas, so they rode the camera slide and "jumped". While the player mover
  exists, bars are suppressed on the real canvas and drawn on the stage at the
  sprite's position (`draw_minibars` called on a renderer clone pointing at the stage).
- **Attack bumps** (`fx_bump_anim`): a MutationObserver on `#messages` reads new
  `.game_message` lines. Player attacks match `You <verb> the <name>` with a verb
  allow-list; monster attacks match `<name> <verb> you` minus a preposition deny-list.
  The attacker/target is the adjacent monster whose `mon.name` equals the name. The
  attacker lunges 0.2 cell toward the target (wind-up, strike at ~55 ms, hold, ease
  back; 240 ms total); on a hit the defender recoils 0.07 cell after contact. Bumps are
  movers with a custom `path(ms)` offset, so they reuse sprite capture and the stage.
- Skipped when a step animation is running for that actor, or >6 new lines arrive at
  once (history reload).
- Known gaps: killing blows have no bump (the monster is already gone from the map when
  the message is read); several adjacent monsters with the same name can pick the wrong
  one; ranged attacks and spells are not animated.
- Design idea (lunge + recoil) is common to many games; Polished Crawl (AGPL-3.0) was
  read only to confirm the concept, no code was copied.

## v0.3 changes
- **Movers are unified**: every animated actor ('player' or 'm<id>') is one mover with an
  optional step (slide, + optional hop/squash) and a list of overlapping short effects.
  Effects are summed (clamped to 0.35 cell), so several attackers/hits in one turn all show,
  and a bump can attach to an actor that is mid-step instead of being skipped.
- **Hop** (`fx_hop_anim`): during a step, lift = sin^2(pi t) * hopHeight (cells), squash
  sy = 1 + arc*0.025 - landing*0.045, sx = 1/sy, scaled about the feet; a chained step blends
  from the pose already on screen. Bars stay on the ground position.
- **Attack effects**: attacker lunges 0.2 cell toward the target (contact at 22% of the
  duration); a hit target recoils 0.08 cell and flashes (white for monsters, red for the
  player); a miss makes the target sidestep 0.1 cell perpendicular, no flash. Each attack
  sentence consumes one adjacent monster per message batch so same-name monsters take turns.
  Default length 190 ms (was 240).
- Known gaps: killing blows have no effect (monster already gone from the map); ranged
  attacks/spells not animated.
- Smoke-tested headless only (no visual check): 3 attack sentences -> 3 effects, no fallbacks.

## Hard rules
- dcss-fx is animations/effects only. It must never modify, hide, reorder, recolour or add to
  the message log, send input to the game, change RC/game state, or react to anything that is
  not needed for an animation. The `#messages` watcher is read-only and only acts on lines
  that parse as melee attacks; all other lines are ignored.

## v0.3.1
- Fixed: the action panel (top-left `#action-panel`, `position:absolute`, no z-index) flickered
  away while animating because the stage had `z-index: 1` and an opaque base. The stage now has
  no z-index, so DOM order decides and the panel (later in the DOM) paints above it.

## v0.4: smooth light (`fx_light`)
- DCSS has no lighting model. The client only knows per cell: visible now / remembered
  (`bg.UNSEEN`, game draws the dim `icons.MESH` over it) / magic-mapped (`MM_UNSEEN`) / never seen.
  So this is purely cosmetic, built only from data the game already shows.
- The game's visible set is the truth; we never recompute vision. Per sample (3x3 per cell):
  visible cell -> brightness = lerp(shadowFloor, distanceFalloff, rayLit), where rayLit is the
  fraction of 3 rays (centre + two offsets, soft penumbra) from the player that reach the sample
  without crossing a sight-blocking cell. Visible cells never drop below `lightShadow`, so no
  monster/item is ever hidden. Remembered cells get `lightAmbient`; magic-mapped/unknown 1.0.
- Sight-blocking is approximated from tile indexes (stone/metal/other walls, trees, closed doors;
  translucent stone and crystal do not block). It only shapes shadows, never visibility.
- The game's own remembered-cell mesh is suppressed (`draw_icon` for `icons.MESH` while light is on)
  and the view repainted; turning light off restores it.
- A small brightness map is eased per sample (`lightFadeMs`) so cells fade as they enter/leave
  sight, scrolled with the view, and drawn upscaled (bilinear) onto an overlay canvas with
  `mix-blend-mode: multiply`, offset by the camera glide. No z-index, so the action panel stays on top.
  The ray origin follows the player's interpolated position during a step.
- Disabled in glyph mode and the X map view (the game's own look returns).
- Smoke-tested headless on a live game (6 light frames, no errors, screenshot looked plausible).
  Not tuned: radius/edge/shadow/ambient defaults are first guesses.

## v0.4.1: light hotkey
- `fx_light_key` (default F8) toggles the light at runtime to compare with the game's own look.
  It is a capture-phase `keydown` listener on `window` that swallows only the exact combo
  (`preventDefault` + `stopImmediatePropagation`), so the key never reaches the game or the server.
  Ignored while typing in inputs/textareas and on key repeat. Feedback is our own fixed label at the
  top of the page ("fx light: on/off"), never the message log. `fx_light` in the RC stays the master
  switch; the key only flips a runtime flag. Runtime state resets on page reload.

## v0.5: autoexplore / travel smoothness
Problem: with `o` the server delivers steps faster than our minimum animation length and sometimes
several steps in one update. The old per-step camera offset *accumulated* (view trailing many cells,
then rushing to catch up) and any update with a move > 1 cell hard-snapped and reset the chain.
- **Cadence**: `stepTiming()` measures the real arrival interval of the player's steps (EMA; replies
  closer than 25 ms are treated as coalesced and ignored) and animates each step over interval+10 ms
  (30 ms .. 1.3*moveMs). Steady walking uses linear (constant speed) per step instead of an ease-out per
  tile; an isolated step (gap > chainMs) keeps the ease-out.
- **Bounded lag**: a retarget starts from the sprite's current visual position, trimmed so it is never
  more than `maxLag` (2) cells from the destination. The excess is caught up instantly.
- **Bursts**: moves of up to `maxJump` (3) cells glide (straight line, duration scaled by length, lag
  bounded); larger moves (teleport, blink, level change) snap.
- **One curve for feet and camera**: the camera offset is no longer its own state; it is the distance the
  player's own step still has to cover, so sprite and view cannot drift apart or settle at different times.
- `stats.maxLag` records the worst trail. Headless stress (40 steps at ~22 ms with 2-step bursts):
  max trail 1.96 cells, clean settle, 10-cell jump snapped, no errors. Not yet seen in a real
  autoexplore by a human.
- Polished Crawl (AGPL-3.0) was read for the ideas (cadence-matched duration, bounded lag, burst = no
  animation, one curve for feet and camera); no code was copied.
