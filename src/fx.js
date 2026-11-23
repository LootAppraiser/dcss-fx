// dcss-fx core: client-side visual effects for DCSS Webtiles.
// Purely visual. It never sends anything to the server and never changes game
// state; it only changes how the already-received map is drawn.
//
// How it works (see docs/design.md):
//  * hooks the game's dungeon renderer + map_knowledge after the game modules load
//  * detects the player's step (view-centre change) and monster steps
//    (a monster id vanishing from one cell and appearing in another)
//  * hides the real canvas while something animates and draws a "stage" canvas
//    on top: the real canvas blitted with a sliding camera offset, plus every
//    animated actor's sprite drawn at its own interpolated pose
//  * each animated actor is a "mover": an optional step (slide, with an optional
//    hop/squash) plus any number of short overlapping effects (lunge, recoil,
//    dodge, hit flash) that are summed. When all are done the cells are redrawn
//    normally and the stage is hidden.
//  * attack effects come from the message log: "You hit the jackal." /
//    "The jackal bites you." plus the adjacent monster of that name give
//    attacker and target. Attacker lunges, a hit target recoils and flashes, a
//    miss makes the target sidestep.
// The ideas (lunge/recoil, a short body hop while stepping) are common game
// feel; no code from other projects is used here.

const DEFAULTS = {
    move: false,      // step slide (RC: fx_move_anim)
    bump: false,      // attack effects (RC: fx_bump_anim)
    hop: false,       // extra body hop + squash while stepping (RC: fx_hop_anim); needs the step slide
    moveMs: 110,      // length of one step
    bumpMs: 190,      // length of one attack effect
    hopHeight: 0.12,  // peak body lift while stepping, in cells
    minMs: 30,        // shortest step when steps arrive back to back
    maxLag: 2,        // the picture never trails the game by more than this many cells (autoexplore/travel)
    maxJump: 3,       // a move bigger than this (teleport, blink) snaps instead of gliding
    chainMs: 260,     // steps closer together than this are chained
    light: false,       // smooth ray-cast light around the player (RC: fx_light)
    lightRadius: 7.5,   // cells; your vision range. The light ends here, fading over +-0.5 tile
    lightCore: 0.3,     // fraction of the radius that stays fully bright before the gentle falloff starts
    lightEdge: 0.85,    // brightness of lit tiles at the radius (1 = no falloff)
    lightShadow: 0.7,   // floor for every tile the game says you SEE, so seen always reads as seen
    lightAmbient: 0.38, // brightness of remembered (out of sight) cells
    lightFadeMs: 70,    // how fast brightness eases when cells enter/leave sight
    lightKey: 'F8',     // key that toggles the light on/off for comparing (RC: fx_light_key; 'off' disables)
    debug: false,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const linear = t => t;
const outCubic = t => 1 - Math.pow(1 - t, 3);
const noop = () => {};
const smooth = t => t * t * (3 - 2 * t);
const ck = (x, y) => x + ',' + y;
const PLAYER_VERBS = new Set(('hit miss slash slice stab hack chop cleave bludgeon smash crush pound thump whack bash ' +
    'punch kick bite claw pierce impale skewer spear lacerate mangle maul gouge rend slap sting gore headbutt trample ' +
    'wound puncture rake lash whip batter pummel smite').split(' '));
const NOT_MONSTER_VERBS = new Set(('at to for with from behind past toward towards around into onto near next ' +
    'notice notices see sees hear hears').split(' '));

function findGameModules() {
    const defined = window.requirejs?.s?.contexts?._?.defined;
    if (!defined) return null;
    const keys = Object.keys(defined);
    const get = name => {
        const k = keys.find(k => /^game-/.test(k) && k.endsWith('/' + name));
        return k ? defined[k] : null;
    };
    const m = {
        r: get('dungeon_renderer'),
        mk: get('map_knowledge'),
        enums: get('enums'),
        options: get('options'),
        icons: get('tileinfo-icons'),
        dngn: get('tileinfo-dngn'),
    };
    if (!m.r || !m.mk || !m.enums || !m.options || !m.r.element) return null;
    return m;
}

export function createFx(userCfg = {}) {
    const cfg = {...DEFAULTS, ...userCfg};
    const log = (...a) => { if (cfg.debug) console.log('[dcss-fx]', ...a); };
    let hooked = null;
    let timer = null;
    let userLight = true;   // runtime toggle (hotkey); the RC option fx_light is the master switch
    const wanted = () => cfg.move || cfg.bump || cfg.hop || cfg.light;
    const stats = {playerSteps: 0, monsterMoves: 0, bumps: 0, frames: 0, fallbacks: 0, merges: 0,
                   msgLines: 0, attackMsgs: 0, noAdjacent: 0, observerAttaches: 0, lightFrames: 0, maxLag: 0};

    function hook({r, mk, enums, options, icons, dngn}) {
        const movers = new Map();     // key ('player' | 'm<id>') -> mover
        const cellOwner = new Map();  // "x,y" -> mover (cell whose sprite is hidden on the real canvas)
        let raf = 0;
        let active = false;
        const restores = [];

        const stage = document.createElement('canvas');
        stage.id = 'dcss-fx-stage';
        const sctx = stage.getContext('2d');
        const flashCanvas = document.createElement('canvas');
        const fctx = flashCanvas.getContext('2d');

        const patch = (obj, name, wrap) => {
            const own = Object.prototype.hasOwnProperty.call(obj, name);
            const orig = obj[name];
            obj[name] = wrap(orig);
            restores.push(() => { if (own) obj[name] = orig; else delete obj[name]; });
        };

        const baseOk = () => !document.hidden && r.cols > 0
            && options.get('tile_display_mode') === 'tiles'
            && r.ui_state !== enums.ui.VIEW_MAP;
        const canMove = () => (cfg.move || cfg.hop) && baseOk();
        const canBump = () => cfg.bump && baseOk();
        const canLight = () => cfg.light && userLight && baseOk() && !!icons && !!dngn;
        const canAnimate = () => wanted() && baseOk();

        // ---- timing -------------------------------------------------------
        // Measure when the player's steps actually arrive and animate each over that interval, so
        // autoexplore/travel flows instead of stop-start. Coalesced replies (gap < 25 ms) are not
        // evidence of a faster cadence. A long gap means a fresh, isolated step.
        const cad = {last: -1e9, interval: undefined, t: -1e9, out: null};
        function stepTiming(now) {
            if (cad.out && now - cad.t < 8) return cad.out;          // same map message
            const gap = now - cad.last;
            cad.last = now; cad.t = now;
            let out;
            if (gap < 0 || gap > cfg.chainMs) {
                cad.interval = undefined;
                out = {ms: cfg.moveMs, continuous: false};
            } else {
                if (gap >= 25) cad.interval = cad.interval === undefined ? gap : cad.interval * 0.75 + gap * 0.25;
                const iv = cad.interval !== undefined ? cad.interval : gap;
                out = {ms: clamp(iv + 10, cfg.minMs, cfg.moveMs * 1.3), continuous: true};
            }
            cad.out = out;
            return out;
        }
        // Monsters follow whatever rhythm the player's steps currently have.
        const monTiming = now => (cad.out && now - cad.t < cfg.chainMs) ? cad.out : {ms: cfg.moveMs, continuous: false};

        // Position along a step at time `now` (pure step, no attack effects).
        function stepPos(st, now) {
            const t = clamp((now - st.t0) / st.dur, 0, 1);
            const e = st.ease(t);
            return {x: st.fx + (st.tx - st.fx) * e, y: st.fy + (st.ty - st.fy) * e, t, done: t >= 1};
        }

        // ---- mover sampling ----------------------------------------------
        // pose = position (cells) + body lift (cells) + squash + flash + done
        function sample(m, now) {
            let x = m.tx, y = m.ty, lift = 0, sx = 1, sy = 1, stepDone = true;
            const s = m.step;
            if (s) {
                const sp = stepPos(s, now);
                const t = sp.t;
                x = sp.x; y = sp.y;
                stepDone = sp.done;
                if (cfg.hop && t < 1) {
                    const arc = Math.pow(Math.sin(Math.PI * t), 2);
                    const landing = t > 0.65 ? Math.pow(Math.sin(Math.PI * (t - 0.65) / 0.35), 2) : 0;
                    const target = arc * cfg.hopHeight;
                    const tsy = 1 + arc * 0.025 - landing * 0.045;
                    // blend from the pose already on screen so a chained step never resets mid-air
                    const b = smooth(Math.min(1, t * 4));
                    lift = s.lift0 + (target - s.lift0) * b;
                    sy = s.sy0 + (tsy - s.sy0) * b;
                    sx = 1 / sy;
                }
            }
            let ox = 0, oy = 0, flash = null, fxDone = true;
            for (const e of m.fxs) {
                const ms = now - e.t0;
                if (ms >= e.dur) continue;
                fxDone = false;
                const o = e.path(Math.max(0, ms));
                ox += o.x; oy += o.y;
                if (e.flash) {
                    const f = e.flash(Math.max(0, ms));
                    if (f && (!flash || f.a > flash.a)) flash = f;
                }
            }
            const mag = Math.hypot(ox, oy);
            if (mag > 0.35) { ox *= 0.35 / mag; oy *= 0.35 / mag; }
            m.fxs = m.fxs.filter(e => now - e.t0 < e.dur);
            return {x: x + ox, y: y + oy, lift, sx, sy, flash, done: stepDone && fxDone};
        }

        // The camera simply keeps the player's sprite where it is on screen: its offset is whatever
        // distance the player's own step still has to cover. One curve drives both, so they cannot drift.
        function camOffset(now) {
            const pm = movers.get('player');
            if (!pm || !pm.step) return {x: 0, y: 0, done: true};
            const p = stepPos(pm.step, now);
            return {x: pm.tx - p.x, y: pm.ty - p.y, done: p.done};
        }

        // ---- movers -------------------------------------------------------
        function release(m) {
            if (cellOwner.get(ck(m.tx, m.ty)) === m) cellOwner.delete(ck(m.tx, m.ty));
            mk.touch(m.tx, m.ty);
        }

        function startStep(key, from, to, timing, now, monId) {
            const prev = movers.get(key);
            let fx = from.x, fy = from.y, chained = false, lift0 = 0, sy0 = 1;
            if (prev) {
                if (prev.step) {
                    const sp = stepPos(prev.step, now);
                    fx = sp.x; fy = sp.y; chained = !sp.done;
                    const pose = sample(prev, now);
                    lift0 = pose.lift; sy0 = pose.sy;
                }
                release(prev);
            }
            // Bounded lag: never let the picture trail the game by more than maxLag cells.
            let d = Math.max(Math.abs(fx - to.x), Math.abs(fy - to.y));
            if (d > cfg.maxLag) {
                const k = cfg.maxLag / d;
                fx = to.x + (fx - to.x) * k;
                fy = to.y + (fy - to.y) * k;
                d = cfg.maxLag;
            }
            const dur = clamp(Math.max(1, d) * timing.ms, timing.ms, cfg.moveMs * 1.6);
            const m = {key, tx: to.x, ty: to.y, monId, bars: key === 'player',
                       sprite: prev ? prev.sprite : null, sctx: prev ? prev.sctx : null,
                       step: {fx, fy, tx: to.x, ty: to.y, t0: now, dur,
                              ease: (chained || timing.continuous) ? linear : outCubic, lift0, sy0},
                       fxs: []};
            movers.set(key, m);
            cellOwner.set(ck(m.tx, m.ty), m);
            mk.touch(m.tx, m.ty);
        }

        // Attach a short effect to an actor, creating a static mover if it is not already animating.
        function addEffect(key, cell, monId, effect) {
            let m = movers.get(key);
            if (!m) {
                if (cellOwner.has(ck(cell.x, cell.y))) return false;
                m = {key, tx: cell.x, ty: cell.y, monId, bars: key === 'player',
                     sprite: null, sctx: null, step: null, fxs: []};
                movers.set(key, m);
                cellOwner.set(ck(cell.x, cell.y), m);
                mk.touch(cell.x, cell.y);
            } else if (m.tx !== cell.x || m.ty !== cell.y) {
                return false;
            }
            m.fxs.push(effect);
            return true;
        }

        // ---- sprite capture ----------------------------------------------
        // Draw the cell's foreground (monster/player doll, icons) only, into a
        // 3x3-cell canvas so tall/overlapping tiles are not clipped.
        function captureSprite(m, cx, cy, mc, c) {
            const {width: cw, height: ch} = r.scaled_size();
            if (!m.sprite || m.sprite.width !== cw * 3 || m.sprite.height !== ch * 3) {
                m.sprite = document.createElement('canvas');
                m.sprite.width = cw * 3;
                m.sprite.height = ch * 3;
                m.sctx = m.sprite.getContext('2d');
                m.sctx.fillRect = noop; // do_render_cell paints a black cell first; keep transparency
            }
            m.sctx.clearRect(0, 0, m.sprite.width, m.sprite.height);
            const tmp = Object.create(r);
            tmp.ctx = m.sctx;
            tmp.element = m.sprite;
            tmp.draw_background = noop;
            tmp.render_cursors = noop;
            tmp.render_flash = noop;
            tmp.draw_minibars = noop;
            const cs = Object.assign({}, c);
            const mcs = Object.assign({}, mc, {t: cs});
            tmp.do_render_cell(cx, cy, cw, ch, mcs, cs);
        }

        // Sprite tinted with a flash colour (only where the sprite has pixels).
        function flashed(sprite, flash) {
            if (flashCanvas.width !== sprite.width || flashCanvas.height !== sprite.height) {
                flashCanvas.width = sprite.width;
                flashCanvas.height = sprite.height;
            }
            fctx.globalCompositeOperation = 'source-over';
            fctx.clearRect(0, 0, flashCanvas.width, flashCanvas.height);
            fctx.drawImage(sprite, 0, 0);
            fctx.globalCompositeOperation = 'source-atop';
            fctx.fillStyle = `rgba(${flash.c},${flash.a.toFixed(3)})`;
            fctx.fillRect(0, 0, flashCanvas.width, flashCanvas.height);
            fctx.globalCompositeOperation = 'source-over';
            return flashCanvas;
        }

        // ---- stage --------------------------------------------------------
        function placeStage() {
            const el = r.element;
            if (stage.parentNode !== el.parentNode) el.parentNode.insertBefore(stage, el.nextSibling);
            const s = stage.style;
            s.position = 'absolute';
            s.pointerEvents = 'none';
            // No z-index on purpose: the stage sits right after #dungeon in the DOM, so later positioned
            // elements (the top-left action panel, tooltips, menus) still paint above it.
            s.zIndex = '';
            s.left = el.offsetLeft + 'px';
            s.top = el.offsetTop + 'px';
            s.width = el.style.width;
            s.height = el.style.height;
            if (stage.width !== el.width) stage.width = el.width;
            if (stage.height !== el.height) stage.height = el.height;
        }

        // ---- apron --------------------------------------------------------
        // The real canvas only holds the visible cols x rows. While the camera glides, a strip just outside
        // the view (on the side you are walking away from) is on screen. It must show exactly what was there
        // a moment ago, so the apron is a memory of the screen itself: right before every scroll, the cells
        // currently on screen are stamped into a canvas with a ring of PAD cells around the view, anchored to
        // the map. Nothing is re-rendered, so the strip is pixel-identical to what you just saw.
        const PAD = () => Math.ceil(cfg.maxLag) + 1;
        const apron = document.createElement('canvas');
        const actx = apron.getContext('2d');
        const ap = {vx: 0, vy: 0, cols: 0, rows: 0, cw: 0, ch: 0, P: 0, valid: false};
        let apronTmp = null;

        function apronInvalidate() { ap.valid = false; }

        // Called with the OLD view still on the real canvas (before the game scrolls it).
        function rememberScreen() {
            const {width: cw, height: ch} = r.scaled_size();
            const cols = r.cols, rows = r.rows, vx = r.view.x, vy = r.view.y, P = PAD();
            if (!(cols > 0 && rows > 0 && cw > 0 && ch > 0)) return;
            const W = (cols + 2 * P) * cw, H = (rows + 2 * P) * ch;
            if (!ap.valid || ap.cols !== cols || ap.rows !== rows || ap.cw !== cw || ap.ch !== ch || ap.P !== P
                || apron.width !== W || apron.height !== H) {
                if (apron.width !== W || apron.height !== H) { apron.width = W; apron.height = H; }
                actx.clearRect(0, 0, W, H);
                Object.assign(ap, {vx, vy, cols, rows, cw, ch, P, valid: true});
            } else if (ap.vx !== vx || ap.vy !== vy) {
                // keep what is still inside the ring, re-anchored to the current view
                if (!apronTmp) apronTmp = document.createElement('canvas');
                if (apronTmp.width !== W || apronTmp.height !== H) { apronTmp.width = W; apronTmp.height = H; }
                const tctx = apronTmp.getContext('2d');
                tctx.clearRect(0, 0, W, H);
                tctx.drawImage(apron, 0, 0);
                actx.clearRect(0, 0, W, H);
                actx.drawImage(apronTmp, (ap.vx - vx) * cw, (ap.vy - vy) * ch);
                ap.vx = vx; ap.vy = vy;
            }
            actx.drawImage(r.element, 0, 0, cols * cw, rows * ch, P * cw, P * ch, cols * cw, rows * ch);
        }

        function paintApron(off, cw, ch) {
            if (!ap.valid || ap.cw !== cw || ap.ch !== ch || ap.cols !== r.cols || ap.rows !== r.rows) return;
            if (Math.abs(off.x) < 0.001 && Math.abs(off.y) < 0.001) return;
            const x = (ap.vx - r.view.x - ap.P) * cw + Math.round(off.x * cw);
            const y = (ap.vy - r.view.y - ap.P) * ch + Math.round(off.y * ch);
            sctx.drawImage(apron, x, y);
        }

        function activate() {
            if (active) return;
            active = true;
            placeStage();
            stage.style.display = 'block';
            r.element.style.opacity = '0'; // still receives mouse events
        }

        function deactivate() {
            if (!active) return;
            active = false;
            r.element.style.opacity = '';
            stage.style.display = 'none';
        }

        function ensureRunning() {
            if (!raf) raf = requestAnimationFrame(frame);
        }

        // HP/MP mini-bars under the player: drawn on the stage at the sprite's ground position,
        // so they move with the player instead of jumping with the camera.
        function drawBars(x, y) {
            const tmp = Object.create(r);
            tmp.ctx = sctx;
            tmp.draw_minibars(x, y);
        }

        function frame() {
            raf = 0;
            stats.frames++;
            if (!canAnimate()) { cancelAll(); return; }
            const now = performance.now();
            try {
                activate();
                placeStage();
                const {width: cw, height: ch} = r.scaled_size();
                const off = camOffset(now);
                stats.maxLag = Math.max(stats.maxLag, Math.abs(off.x), Math.abs(off.y));
                for (const m of movers.values()) {
                    if (!m.sprite) r.render_grid_cell(m.tx, m.ty); // wrapper captures the sprite
                }
                sctx.fillStyle = '#000';
                sctx.fillRect(0, 0, stage.width, stage.height);
                sctx.imageSmoothingEnabled = false;
                paintApron(off, cw, ch);
                // Blit only the cell area. The game's canvas is floor(cols * cell * dpr) wide but its cells are
                // floor(cell * dpr), so with a fractional devicePixelRatio there is a black margin past the last
                // cell; sliding that margin into the view drew black bars over the edge (walking left / up).
                const gw = r.cols * cw, gh = r.rows * ch;
                sctx.drawImage(r.element, 0, 0, gw, gh, Math.round(off.x * cw), Math.round(off.y * ch), gw, gh);
                // Keep that margin black exactly as the game shows it when nothing animates.
                sctx.fillStyle = '#000';
                if (stage.width > gw) sctx.fillRect(gw, 0, stage.width - gw, stage.height);
                if (stage.height > gh) sctx.fillRect(0, gh, stage.width, stage.height - gh);
                const finished = [];
                for (const m of movers.values()) {
                    const p = sample(m, now);
                    if (m.sprite) {
                        const c = r.canvas_coords(p.x, p.y);
                        const gx = Math.round(c.x + off.x * cw), gy = Math.round(c.y + off.y * ch);
                        const py = gy - Math.round(p.lift * ch);
                        const img = p.flash ? flashed(m.sprite, p.flash) : m.sprite;
                        if (p.sx !== 1 || p.sy !== 1) {
                            sctx.save();
                            sctx.translate(gx + cw / 2, py + ch);   // scale about the feet
                            sctx.scale(p.sx, p.sy);
                            sctx.drawImage(img, -1.5 * cw, -2 * ch);
                            sctx.restore();
                        } else {
                            sctx.drawImage(img, gx - cw, py - ch);
                        }
                        if (m.bars) drawBars(gx, gy);
                    }
                    if (p.done) finished.push(m);
                }
                for (const m of finished) {
                    if (movers.get(m.key) === m) movers.delete(m.key);
                    if (cellOwner.get(ck(m.tx, m.ty)) === m) cellOwner.delete(ck(m.tx, m.ty));
                    r.render_loc(m.tx, m.ty);
                }
                if (movers.size === 0) { deactivate(); return; }
            } catch (e) {
                console.error('[dcss-fx] frame error, disabling animation for this turn', e);
                cancelAll();
                return;
            }
            ensureRunning();
        }

        function cancelAll() {
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            const cells = [...movers.values()].map(m => [m.tx, m.ty]);
            movers.clear();
            cellOwner.clear();
            deactivate();
            for (const [x, y] of cells) {
                try { r.render_loc(x, y); } catch (e) { /* ignore */ }
            }
        }

        // ---- light --------------------------------------------------------
        // Replaces the game's per-tile "lit / dim" look with a smooth light pool around the player.
        // The game's own visible set stays the truth: visible cells never go below `lightShadow`
        // (nothing is ever hidden); rays from the player only shape the brightness inside it.
        const S = 4;                                   // light samples per cell, each axis
        const lightCanvas = document.createElement('canvas');
        lightCanvas.id = 'dcss-fx-light';
        lightCanvas.style.mixBlendMode = 'multiply';
        const lctx = lightCanvas.getContext('2d');
        const lm = document.createElement('canvas');   // low-res brightness map, upscaled smoothly
        const lmctx = lm.getContext('2d');
        const L = {on: false, raf: 0, last: 0, cols: 0, rows: 0, vx: 0, vy: 0, w: 0, h: 0,
                   info: null, target: null, cur: null, dirty: true, ox: NaN, oy: NaN, img: null};
        const D = (name, dflt) => (dngn && dngn[name] !== undefined) ? dngn[name] : dflt;
        const T = {
            wallLo: D('DNGN_STONE_WALL', 1200), clearLo: D('DNGN_FIRST_TRANSPARENT', 1264),
            metalLo: D('DNGN_METAL_WALL', 1282), crystalLo: D('DNGN_CRYSTAL_WALL', 1411),
            crystalHi: D('DNGN_CRYSTAL_WHITE', 1425), wallMax: D('WALL_MAX', 2668),
            treeHi: D('DNGN_MANGROVE', 2703) + 3,
            doors: [[D('DNGN_CLOSED_DOOR', 2726), D('DNGN_OPEN_DOOR', 2733)],
                    [D('DNGN_RUNED_DOOR', 2740), D('DNGN_SEALED_DOOR', 2747)],
                    [D('DNGN_SEALED_DOOR', 2747), D('DNGN_SEALED_DOOR', 2747) + 7],
                    [D('DNGN_CLOSED_DOOR_CRYPT', 2796), D('DNGN_OPEN_DOOR_CRYPT', 2803)]],
        };
        // Does this feature tile block line of sight? (approximate; only shapes the soft shadows)
        function tileOpaque(v) {
            if (v >= T.wallLo && v < T.clearLo) return true;                // stone walls
            if (v >= T.clearLo && v < T.metalLo) return false;              // translucent stone
            if (v >= T.metalLo && v < T.crystalLo) return true;             // metal walls
            if (v >= T.crystalLo && v <= T.crystalHi) return false;         // crystal
            if (v > T.crystalHi && v < T.wallMax) return true;              // other walls
            if (v >= T.wallMax && v < T.treeHi) return true;                // trees, mangroves
            for (const [lo, hi] of T.doors) if (v >= lo && v < hi) return true;  // closed doors
            return false;
        }

        // bit 1 = visible now, 2 = remembered, 4 = magic-mapped, 8 = blocks sight,
        // 16 = visible and holds a monster/item (never dimmed away), 32 = never seen
        function classify(cell) {
            const t = cell.t;
            if (!t) return 8 | 32;
            const bg = enums.prepare_bg_flags(t.bg || 0);
            const v = bg.value;
            if (!(v > 0)) return 8 | 32;                                    // never seen: treat as solid
            let f = 0;
            if (bg.MM_UNSEEN) f |= 4;
            else if (bg.UNSEEN) f |= 2;
            else f |= 1;
            if (tileOpaque(v)) f |= 8;
            if ((f & 1) && t.fg && enums.prepare_fg_flags(t.fg).value) f |= 16;
            return f;
        }

        // The light is computed PAD cells past every edge of the view, so the strip the camera glide
        // uncovers is lit exactly like the rest of the map.
        function ensureWindow() {
            const P = PAD();
            const cols = r.cols + 2 * P, rows = r.rows + 2 * P, vx = r.view.x - P, vy = r.view.y - P;
            const w = cols * S, h = rows * S;
            if (L.cols !== cols || L.rows !== rows || !L.cur) {
                L.cols = cols; L.rows = rows; L.w = w; L.h = h; L.vx = vx; L.vy = vy;
                L.info = new Uint8Array(cols * rows);
                L.target = new Float32Array(w * h);
                L.cur = null; L.dirty = true;
                lm.width = w; lm.height = h; L.img = lmctx.createImageData(w, h);
            } else if (L.vx !== vx || L.vy !== vy) {
                // the view scrolled: carry the eased brightness along so it stays glued to the world
                const dx = (vx - L.vx) * S, dy = (vy - L.vy) * S;
                const next = new Float32Array(w * h).fill(-1);
                for (let j = 0; j < h; j++) {
                    const oj = j + dy;
                    if (oj < 0 || oj >= h) continue;
                    for (let i = 0; i < w; i++) {
                        const oi = i + dx;
                        if (oi >= 0 && oi < w && L.cur) next[j * w + i] = L.cur[oj * w + oi];
                    }
                }
                L.cur = next; L.vx = vx; L.vy = vy; L.dirty = true;
            }
        }

        const opaqueAt = (cx, cy) => {
            const lx = cx - L.vx, ly = cy - L.vy;
            if (lx < 0 || ly < 0 || lx >= L.cols || ly >= L.rows) return true;
            return (L.info[ly * L.cols + lx] & 8) !== 0;
        };

        // Fraction of light from (ox,oy) that reaches (qx,qy): 0 if a sight-blocking cell is in the way.
        // The target cell itself is exempt, so a wall face is lit; light then fades into the wall with depth,
        // so the lit side of a wall has no hard tile-sized edge.
        function castV(ox, oy, qx, qy) {
            const dx = qx - ox, dy = qy - oy;
            const len = Math.hypot(dx, dy);
            const n = Math.max(1, Math.ceil(len / 0.2));
            const ocx = Math.floor(ox), ocy = Math.floor(oy), tcx = Math.floor(qx), tcy = Math.floor(qy);
            let enter = -1;
            for (let k = 1; k <= n; k++) {
                const cx = Math.floor(ox + dx * k / n), cy = Math.floor(oy + dy * k / n);
                if (cx === ocx && cy === ocy) continue;
                if (cx === tcx && cy === tcy) { if (enter < 0) enter = k; continue; }
                if (opaqueAt(cx, cy)) return 0;
            }
            if (enter >= 0 && opaqueAt(tcx, tcy)) {
                const depth = (n - enter) * (len / n);
                return 1 - smooth(clamp(depth / 0.9, 0, 1));
            }
            return 1;
        }

        const PEN = [-0.4, -0.2, 0, 0.2, 0.4];             // ray origins across the light's width: soft shadow edges
        const blurTmp = {a: null};

        // One continuous light pool, anchored to the game's own truth so it never loses information.
        //   geometry : A + (1 - A) * rim(distance) * rayVisibility * gentleFalloff(distance)   (smooth, no tile edges)
        //   truth    : a tile the game says you SEE is never darker than `lightShadow`;
        //              a tile it says you only REMEMBER is never brighter than halfway between ambient and that.
        // So seen and remembered always read differently, while the smooth geometry supplies the gradient between.
        function computeTarget(ox, oy) {
            for (let cy = 0; cy < L.rows; cy++) {
                for (let cx = 0; cx < L.cols; cx++) {
                    L.info[cy * L.cols + cx] = classify(mk.get(L.vx + cx, L.vy + cy));
                }
            }
            const R = Math.max(1, cfg.lightRadius), core = clamp(cfg.lightCore, 0, 0.9) * R;
            const A = cfg.lightAmbient, E = cfg.lightEdge;
            const seenMin = Math.max(A, cfg.lightShadow), memMax = (A + seenMin) / 2;
            for (let j = 0; j < L.h; j++) {
                const cy = Math.floor(j / S);
                for (let i = 0; i < L.w; i++) {
                    const f = L.info[cy * L.cols + Math.floor(i / S)];
                    let v;
                    if (f & 32) {
                        v = A;                                              // never seen: the tile is black anyway
                    } else if (f & 4) {
                        v = 1;                                              // magic-mapped: the game's own mesh stays
                    } else {
                        const qx = L.vx + (i + 0.5) / S, qy = L.vy + (j + 0.5) / S;
                        const dx = qx - ox, dy = qy - oy, d = Math.hypot(dx, dy);
                        const rim = 1 - smooth(clamp(d - (R - 0.5), 0, 1));      // light ends at the vision range
                        let vis = 0;
                        if (rim > 0.002) {
                            if (d < 0.6) vis = 1;
                            else {
                                const px = -dy / d, py = dx / d;
                                let sum = 0;
                                for (const o of PEN) sum += castV(ox + px * o, oy + py * o, qx, qy);
                                vis = sum / PEN.length;
                            }
                        }
                        const lit = 1 - (1 - E) * smooth(clamp((d - core) / Math.max(0.01, R - core), 0, 1));
                        v = A + (1 - A) * rim * vis * lit;
                        if (f & 1) { if (v < seenMin) v = seenMin; }              // the game says you see it
                        else if (f & 2) { if (v > memMax) v = memMax; }           // the game says you only remember it
                    }
                    L.target[j * L.w + i] = v;
                }
            }
            // light blur (1-2-1 both ways) so no quantisation of the sample grid is left to see
            const w = L.w, h = L.h, T = L.target;
            if (!blurTmp.a || blurTmp.a.length !== T.length) blurTmp.a = new Float32Array(T.length);
            const B = blurTmp.a;
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                const l = T[j * w + Math.max(0, i - 1)], c = T[j * w + i], r2 = T[j * w + Math.min(w - 1, i + 1)];
                B[j * w + i] = (l + 2 * c + r2) / 4;
            }
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                const u = B[Math.max(0, j - 1) * w + i], c = B[j * w + i], dn = B[Math.min(h - 1, j + 1) * w + i];
                T[j * w + i] = (u + 2 * c + dn) / 4;
            }
        }

        function lightOn() {
            if (L.on) return;
            L.on = true; L.cur = null; L.dirty = true;
            lightCanvas.style.display = 'block';
            redrawAll();
        }

        function lightOff() {
            if (L.raf) { cancelAnimationFrame(L.raf); L.raf = 0; }
            if (!L.on) return;
            L.on = false;
            lightCanvas.style.display = 'none';
            redrawAll();                                                    // bring the game's own dim mesh back
        }

        // The game only repaints cells that changed, so repaint the view when the mesh look switches.
        function redrawAll() {
            try {
                for (let cy = r.view.y; cy < r.view.y + r.rows; cy++)
                    for (let cx = r.view.x; cx < r.view.x + r.cols; cx++) r.render_grid_cell(cx, cy);
            } catch (e) { log('redrawAll', e); }
        }

        function ensureLight() {
            if (!L.raf) L.raf = requestAnimationFrame(lightTick);
        }

        function lightTick() {
            L.raf = 0;
            if (!canLight()) { lightOff(); return; }
            lightOn();
            stats.lightFrames++;
            const now = performance.now();
            const dt = clamp(now - (L.last || now), 1, 100);
            L.last = now;
            try {
                ensureWindow();
                let ox = r.view_center.x + 0.5, oy = r.view_center.y + 0.5;
                const pm = movers.get('player');
                if (pm) { const p = sample(pm, now); ox = p.x + 0.5; oy = p.y + 0.5; }
                if (L.dirty || Math.abs(ox - L.ox) > 0.01 || Math.abs(oy - L.oy) > 0.01) {
                    computeTarget(ox, oy);
                    L.ox = ox; L.oy = oy; L.dirty = false;
                    if (!L.cur) L.cur = Float32Array.from(L.target);
                    else for (let k = 0; k < L.cur.length; k++) if (L.cur[k] < 0) L.cur[k] = L.target[k];
                }
                const k = 1 - Math.exp(-dt / cfg.lightFadeMs);
                let moving = 0;
                for (let q = 0; q < L.cur.length; q++) {
                    const dv = L.target[q] - L.cur[q];
                    L.cur[q] += dv * k;
                    if (Math.abs(dv) > moving) moving = Math.abs(dv);
                }
                paintLight(camOffset(now));
                if (moving > 0.004 || movers.size) ensureLight();
            } catch (e) {
                console.error('[dcss-fx] light error, turning light off', e);
                cfg.light = false;
                lightOff();
            }
        }

        function paintLight(off) {
            const el = r.element;
            if (lightCanvas.parentNode !== el.parentNode) {
                const after = stage.parentNode === el.parentNode ? stage : el;
                el.parentNode.insertBefore(lightCanvas, after.nextSibling);
            }
            const s = lightCanvas.style;
            s.position = 'absolute'; s.pointerEvents = 'none'; s.zIndex = '';
            s.left = el.offsetLeft + 'px'; s.top = el.offsetTop + 'px';
            s.width = el.style.width; s.height = el.style.height;
            if (lightCanvas.width !== el.width) lightCanvas.width = el.width;
            if (lightCanvas.height !== el.height) lightCanvas.height = el.height;
            const {width: cw, height: ch} = r.scaled_size();
            const d = L.img.data;
            for (let q = 0, p = 0; q < L.cur.length; q++, p += 4) {
                const g = clamp(Math.round(L.cur[q] * 255), 0, 255);
                d[p] = d[p + 1] = d[p + 2] = g; d[p + 3] = 255;
            }
            lmctx.putImageData(L.img, 0, 0);
            lctx.globalCompositeOperation = 'source-over';
            const amb = Math.round(clamp(cfg.lightAmbient, 0, 1) * 255);
            lctx.fillStyle = 'rgb(' + amb + ',' + amb + ',' + amb + ')';   // beyond the view: remembered-level light
            lctx.fillRect(0, 0, lightCanvas.width, lightCanvas.height);
            lctx.imageSmoothingEnabled = true;
            lctx.imageSmoothingQuality = 'high';
            const lp = (L.cols - r.cols) / 2;
            lctx.drawImage(lm, 0, 0, L.w, L.h, Math.round(off.x * cw) - lp * cw, Math.round(off.y * ch) - lp * ch, L.cols * cw, L.rows * ch);
        }

        // ---- hooks --------------------------------------------------------
        patch(r, 'render_cell', orig => function (cx, cy, x, y, map_cell, cell) {
            const m = cellOwner.size ? cellOwner.get(ck(cx, cy)) : null;
            if (!m) return orig.apply(this, arguments);
            try {
                const mc = map_cell || mk.get(cx, cy);
                const c = cell || mc.t;
                if (!c) return orig.apply(this, arguments);
                captureSprite(m, cx, cy, mc, c);
                const c2 = Object.assign({}, c, {fg: 0, base: 0, doll: null, mcache: null});
                const mc2 = Object.assign({}, mc, {t: c2});
                if (!m.bars) return orig.call(this, cx, cy, x, y, mc2, c2);
                const hadOwn = Object.prototype.hasOwnProperty.call(this, 'draw_minibars');
                const prevBars = this.draw_minibars;
                this.draw_minibars = noop;
                try { return orig.call(this, cx, cy, x, y, mc2, c2); }
                finally { if (hadOwn) this.draw_minibars = prevBars; else delete this.draw_minibars; }
            } catch (e) {
                stats.fallbacks++;
                log('render_cell fallback', e);
                return orig.apply(this, arguments);
            }
        });

        patch(r, 'draw_icon', orig => function (idx) {
            if (L.on && icons && idx === icons.MESH) return undefined;   // our smooth light replaces the dim mesh
            return orig.apply(this, arguments);
        });

        patch(r, 'set_view_center', orig => function (x, y) {
            const ox = this.view_center.x, oy = this.view_center.y;
            if (x !== ox || y !== oy) { try { rememberScreen(); } catch (e) { apronInvalidate(); log('apron', e); } }
            const res = orig.apply(this, arguments);
            try {
                const dx = x - ox, dy = y - oy;
                if (!dx && !dy) return res;
                if (cfg.light) { L.dirty = true; ensureLight(); }
                if (!canMove() || Math.max(Math.abs(dx), Math.abs(dy)) > cfg.maxJump) {
                    if (active || movers.size) cancelAll();   // teleport / blink / level change: snap
                    return res;
                }
                const now = performance.now();
                stats.playerSteps++;
                startStep('player', {x: ox, y: oy}, {x, y}, stepTiming(now), now);
                ensureRunning();
            } catch (e) { log('set_view_center', e); }
            return res;
        });

        patch(mk, 'clear', orig => function () {
            try { cancelAll(); apronInvalidate(); L.cur = null; L.dirty = true; } catch (e) { /* ignore */ }
            return orig.apply(this, arguments);
        });

        function findMoves(vals) {
            let lx, ly;
            const cleared = new Map();
            const arrived = [];
            for (const v of vals) {
                const x = v.x !== undefined ? v.x : (lx === undefined ? undefined : lx + 1);
                const y = v.y !== undefined ? v.y : ly;
                if (x === undefined || y === undefined) return [];
                lx = x; ly = y;
                if (!('mon' in v)) continue;
                const old = mk.get(x, y).mon;
                if (!v.mon) {
                    if (old && old.id) cleared.set(old.id, {x, y});
                } else if (v.mon.id && !(old && old.id === v.mon.id)) {
                    arrived.push({id: v.mon.id, to: {x, y}});
                }
            }
            const moves = [];
            for (const a of arrived) {
                const from = cleared.get(a.id);
                if (!from) continue;
                if (from.x === a.to.x && from.y === a.to.y) continue;
                if (Math.abs(from.x - a.to.x) > 2 || Math.abs(from.y - a.to.y) > 2) continue;
                moves.push({id: a.id, from, to: a.to});
            }
            return moves;
        }

        patch(mk, 'merge', orig => function (vals) {
            if (cfg.light) { L.dirty = true; ensureLight(); }
            if (!canAnimate() || !Array.isArray(vals)) return orig.apply(this, arguments);
            stats.merges++;
            const doMoves = canMove();
            let moves = [];
            try { if (doMoves) moves = findMoves(vals); } catch (e) { log('findMoves', e); }
            const res = orig.apply(this, arguments);
            try {
                // drop monster movers whose monster is no longer at its cell
                for (const m of [...movers.values()]) {
                    if (m.monId === undefined) continue;
                    const mon = mk.get(m.tx, m.ty).mon;
                    if (!mon || mon.id !== m.monId) { movers.delete(m.key); release(m); }
                }
                if (moves.length) {
                    stats.monsterMoves += moves.length;
                    const now = performance.now();
                    const timing = monTiming(now);
                    for (const mv of moves) startStep('m' + mv.id, mv.from, mv.to, timing, now, mv.id);
                    ensureRunning();
                }
            } catch (e) { log('merge', e); }
            return res;
        });

        // ---- attack effects -----------------------------------------------
        // All times are fractions of the effect length, so fx_bump_ms scales the whole feel.
        const CONTACT = 0.22;
        const lunge = (dx, dy, amp, dur, now) => ({
            t0: now, dur,
            path: ms => {
                const u = ms / dur, wind = 0.05, hold = 0.12;
                let l;
                if (u < wind) l = -0.025 * Math.sin(u / wind * Math.PI);
                else if (u < CONTACT) l = amp * smooth((u - wind) / (CONTACT - wind));
                else if (u < CONTACT + hold) l = amp;
                else l = amp * (1 - smooth(clamp((u - CONTACT - hold) / (1 - CONTACT - hold), 0, 1)));
                return {x: dx * l, y: dy * l};
            },
        });
        // Target pushed away from the attacker after contact, flashing the hit colour.
        const recoil = (dx, dy, amp, dur, now, colour) => ({
            t0: now, dur,
            path: ms => {
                const u = ms / dur;
                if (u < CONTACT) return {x: 0, y: 0};
                const w = (u - CONTACT) / (1 - CONTACT), rise = 0.22;
                const l = amp * (w < rise ? 1 - Math.pow(1 - w / rise, 3) : 1 - smooth((w - rise) / (1 - rise)));
                return {x: dx * l, y: dy * l};
            },
            flash: ms => {
                const u = ms / dur;
                if (u < CONTACT) return null;
                const w = (u - CONTACT) / 0.35;
                return w >= 1 ? null : {c: colour, a: 0.6 * (1 - w) * (1 - w)};
            },
        });
        // A miss: target sidesteps instead of being hit, no flash.
        const dodge = (dx, dy, amp, dur, now) => ({
            t0: now, dur,
            path: ms => {
                const u = ms / dur;
                if (u < CONTACT) return {x: 0, y: 0};
                const w = (u - CONTACT) / (1 - CONTACT);
                const l = amp * Math.sin(Math.PI * smooth(w));
                return {x: dx * l, y: dy * l};
            },
        });

        function adjacentNamed(name, used) {
            const px = r.view_center.x, py = r.view_center.y;
            let fallback = null;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const mon = mk.get(px + dx, py + dy).mon;
                    const mn = mon && mon.name ? mon.name.toLowerCase() : '';
                    if (mn && (mn === name || name.startsWith(mn + ' '))) {
                        const hit = {x: px + dx, y: py + dy, dx, dy, mon};
                        if (!used.has(mon.id)) return hit;  // spread same-name attackers over different monsters
                        if (!fallback) fallback = hit;
                    }
                }
            }
            return fallback;
        }

        // Returns {player: bool, name, hit} for an attack message, else null.
        function parseAttack(text) {
            let m = /^You ([a-z]+) (?:the |an? )?(.+?)(?:[.!]| \(|$)/.exec(text);
            if (m && PLAYER_VERBS.has(m[1])) {
                return {player: true, name: m[2].toLowerCase(), hit: m[1] !== 'miss'};
            }
            m = /^(?:The |An? )?(.+?) ([a-z]+) you(?:[.! ]|$)/.exec(text);
            if (m && !NOT_MONSTER_VERBS.has(m[2])) {
                return {player: false, name: m[1].toLowerCase(), hit: !/^miss/.test(m[2])};
            }
            return null;
        }

        function onSentence(clean, used) {
            const a = parseAttack(clean);
            if (!a) return;
            stats.attackMsgs++;
            const t = adjacentNamed(a.name, used);
            log('attack msg', clean, a, t ? 'adjacent found' : 'NO adjacent monster with that name');
            if (!t) { stats.noAdjacent++; return; }
            used.add(t.mon.id);
            const len = Math.hypot(t.dx, t.dy);
            const ux = t.dx / len, uy = t.dy / len; // unit vector player -> monster
            const now = performance.now();
            const dur = cfg.bumpMs;
            const pcell = {x: r.view_center.x, y: r.view_center.y};
            const mcell = {x: t.x, y: t.y};
            const mkey = 'm' + t.mon.id;
            let ok;
            if (a.player) {            // you attack the monster
                ok = addEffect('player', pcell, undefined, lunge(ux, uy, 0.2, dur, now));
                addEffect(mkey, mcell, t.mon.id, a.hit ? recoil(ux, uy, 0.08, dur, now, '255,255,255')
                                                       : dodge(-uy, ux, 0.1, dur, now));
            } else {                   // the monster attacks you
                ok = addEffect(mkey, mcell, t.mon.id, lunge(-ux, -uy, 0.2, dur, now));
                addEffect('player', pcell, undefined, a.hit ? recoil(-ux, -uy, 0.08, dur, now, '255,40,40')
                                                            : dodge(uy, -ux, 0.1, dur, now));
            }
            if (ok) { stats.bumps++; ensureRunning(); }
        }

        function onLines(lines) {
            if (!canBump()) return;
            const used = new Set();  // one attack message consumes one monster, per batch of messages
            for (const text of lines) {
                stats.msgLines++;
                const clean = text.replace(/^[\s_\u00a0]+/, '').trim();
                // The game joins several messages on one line ("You hit the jackal. The jackal bites you.")
                for (const sentence of clean.split(/(?<=[.!])\s+/)) onSentence(sentence, used);
            }
        }

        let obs = null, obsEl = null;
        function attachObserver() {
            const el = document.getElementById('messages');
            if (el === obsEl) return;
            if (obs) obs.disconnect();
            obs = null; obsEl = el;
            if (!el) return;
            obs = new MutationObserver(muts => {
                const lines = [];
                for (const mu of muts) {
                    for (const n of mu.addedNodes) {
                        if (n.nodeType === 1 && n.classList && n.classList.contains('game_message')) lines.push(n.textContent || '');
                    }
                }
                if (lines.length === 0 || lines.length > 8) return; // none, or history reload
                try { onLines(lines); } catch (e) { log('onLines', e); }
            });
            obs.observe(el, {childList: true});
            stats.observerAttaches++;
            log('message observer attached');
        }
        attachObserver();
        restores.push(() => { if (obs) obs.disconnect(); });
        restores.push(() => { lightOff(); lightCanvas.remove(); });
        if (cfg.light) ensureLight();

        log('hooked');
        return {
            r,
            check() {                // called every poll tick
                attachObserver();    // the game rebuilds #messages when a new game starts
                if (cfg.light && userLight && !L.on) ensureLight();
                if (!(cfg.light && userLight) && L.on) lightOff();
            },
            unhook() {
                try { cancelAll(); } catch (e) { /* ignore */ }
                while (restores.length) { try { restores.pop()(); } catch (e) { /* ignore */ } }
                stage.remove();
                log('unhooked');
            },
        };
    }

    function poll() {
        if (!wanted()) { if (hooked) { hooked.unhook(); hooked = null; } return; }
        const m = findGameModules();
        if (!m) { if (hooked) { hooked.unhook(); hooked = null; } return; }
        if (hooked && hooked.r === m.r) { hooked.check(); return; }
        if (hooked) hooked.unhook();
        try { hooked = hook(m); } catch (e) { console.error('[dcss-fx] hook failed', e); hooked = null; }
    }

    // ---- light hotkey -----------------------------------------------------
    // Caught in the capture phase and swallowed, so the key never reaches the game or the server.
    function parseKey(spec) {
        if (!spec || /^(off|none|false)$/i.test(spec)) return null;
        const parts = String(spec).split('+').map(x => x.trim()).filter(Boolean);
        if (!parts.length) return null;
        const key = parts.pop().toLowerCase();
        const mods = parts.map(x => x.toLowerCase());
        return {key, ctrl: mods.includes('ctrl'), alt: mods.includes('alt'),
                shift: mods.includes('shift'), meta: mods.includes('meta') || mods.includes('cmd')};
    }

    let toastEl = null, toastTimer = 0;
    function toast(text) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'dcss-fx-toast';
            Object.assign(toastEl.style, {
                position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
                padding: '4px 14px', background: 'rgba(0,0,0,0.78)', color: '#ddd',
                border: '1px solid #7d623c', borderRadius: '3px', font: '16px monospace',
                pointerEvents: 'none', transition: 'opacity 0.25s', opacity: '0', zIndex: '99999',
            });
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 1100);
    }

    function toggleLight(force) {
        userLight = force === undefined ? !userLight : !!force;
        if (hooked) hooked.check();
        toast('fx light: ' + (userLight ? 'on' : 'off') + (cfg.light ? '' : ' (fx_light is off in your RC)'));
        return userLight;
    }

    function onKeyDown(e) {
        const k = parseKey(cfg.lightKey);
        if (!k || e.repeat) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.ctrlKey !== k.ctrl || e.altKey !== k.alt || e.shiftKey !== k.shift || e.metaKey !== k.meta) return;
        if ((e.key || '').toLowerCase() !== k.key && (e.code || '').toLowerCase() !== k.key) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleLight();
    }

    return {
        cfg,
        stats,
        start() {
            if (!timer) timer = setInterval(poll, 400);
            window.addEventListener('keydown', onKeyDown, true);
            poll();
        },
        stop() {
            clearInterval(timer); timer = null;
            window.removeEventListener('keydown', onKeyDown, true);
            if (hooked) { hooked.unhook(); hooked = null; }
        },
        configure(o) { Object.assign(cfg, o); poll(); },
        toggleLight,
        get userLight() { return userLight; },
        get hooked() { return !!hooked; },
    };
}
