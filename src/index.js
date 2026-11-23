// DWEM module entry point. Load it with Tampermonkey + DWEM (see README).
// Opt in per game from your RC (all default off):
//     fx_move_anim = true    step slide
//     fx_move_ms   = 110     (optional, ms per step)
//     fx_hop_anim  = true    extra: little body hop + squash while stepping (implies the slide)
//     fx_hop_height = 0.12   (optional, peak lift in cells)
//     fx_bump_anim = true    attack effects: lunge, recoil + hit flash, dodge on a miss
//     fx_bump_ms   = 190     (optional, ms per attack effect)
//     fx_light     = true    smooth ray-cast light around the player instead of lit/dim tiles
//     fx_light_radius / fx_light_core / fx_light_edge / fx_light_shadow / fx_light_ambient  (optional tuning)
//     fx_light_key = F8      key that toggles the light on/off to compare (e.g. Alt+L, Ctrl+Shift+L; 'off' = none)
import {createFx} from './fx.js';

export default class DcssFx {
    static name = 'DcssFx'
    static version = '0.7.3'
    static dependencies = ['RCManager']
    static description = 'Client-side visual effects: step slide, optional hop, attack bumps, smooth light. RC: fx_move_anim / fx_hop_anim / fx_bump_anim / fx_light = true.'

    onLoad() {
        const {RCManager} = DWEM.Modules;
        this.fx = createFx();
        window.DWEM_FX = this.fx; // console handle for debugging: DWEM_FX.configure({debug: true})
        this.fx.start();
        RCManager.addHandlers('dcss-fx', {
            onGameInitialize: rcfile => {
                this.fx.configure({
                    move: RCManager.getRCOption(rcfile, 'fx_move_anim', 'boolean', false),
                    hop: RCManager.getRCOption(rcfile, 'fx_hop_anim', 'boolean', false),
                    bump: RCManager.getRCOption(rcfile, 'fx_bump_anim', 'boolean', false),
                    moveMs: RCManager.getRCOption(rcfile, 'fx_move_ms', 'float', 110),
                    bumpMs: RCManager.getRCOption(rcfile, 'fx_bump_ms', 'float', 190),
                    hopHeight: RCManager.getRCOption(rcfile, 'fx_hop_height', 'float', 0.12),
                    light: RCManager.getRCOption(rcfile, 'fx_light', 'boolean', false),
                    lightRadius: RCManager.getRCOption(rcfile, 'fx_light_radius', 'float', 7.5),
                    lightCore: RCManager.getRCOption(rcfile, 'fx_light_core', 'float', 0.3),
                    lightEdge: RCManager.getRCOption(rcfile, 'fx_light_edge', 'float', 0.85),
                    lightShadow: RCManager.getRCOption(rcfile, 'fx_light_shadow', 'float', 0.7),
                    lightAmbient: RCManager.getRCOption(rcfile, 'fx_light_ambient', 'float', 0.38),
                    lightKey: RCManager.getRCOption(rcfile, 'fx_light_key', 'string', 'F8'),
                });
            },
            onGameEnd: () => this.fx.configure({move: false, hop: false, bump: false, light: false}),
        });
    }
}
