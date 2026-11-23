// ==UserScript==
// @name         DCSS FX
// @namespace    https://github.com/LootAppraiser/DCSSFX
// @version      1.0
// @description  Adds the DCSS FX module (smooth movement, attack effects, light) to DWEM. Needs the DWEM loader userscript. Install once; updates arrive automatically.
// @match        http://webzook.net:8080/*
// @match        https://crawl.kelbi.org/*
// @match        https://crawl.dcss.io/*
// @match        https://crawl.akrasiac.org:8443/*
// @match        https://underhound.eu:8080/*
// @match        https://cbro.berotato.org:8443/*
// @match        http://lazy-life.ddo.jp:8080/*
// @match        http://lazy-life.ddo.jp:8000/*
// @match        https://crawl.xtahua.com/*
// @match        https://crawl.project357.org/*
// @match        http://joy1999.codns.com:8081/*
// @match        https://crawl.nemelex.cards/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/LootAppraiser/DCSSFX/main/userscript/dcss-fx.user.js
// @downloadURL  https://raw.githubusercontent.com/LootAppraiser/DCSSFX/main/userscript/dcss-fx.user.js
// ==/UserScript==

// Install it by URL (see README), never by pasting: Tampermonkey then keeps this loader up to date from git.
// It rarely changes. What it does: it tells DWEM to load the module from the repo through jsDelivr,
// pinned to the newest commit (looked up from GitHub at most every 5 minutes, like DWEM itself does).
// A new version therefore shows up one page reload after it is pushed.
(function () {
    'use strict';
    const REPO = 'LootAppraiser/DCSSFX';
    const BRANCH = 'main';
    const TTL_SECONDS = 300;
    const K_REF = 'DCSSFX_REF', K_TIME = 'DCSSFX_REF_TIME';
    // Any URL we may have registered before (older pinned commits, the old blob bundle).
    const OURS = /cdn\.jsdelivr\.net\/gh\/LootAppraiser\/DCSSFX@|#dcss-fx$/;

    // localStorage.DCSSFX_PIN = '<commit sha | tag | branch>' freezes the version (debugging / rollback).
    const ref = localStorage.DCSSFX_PIN || localStorage[K_REF] || BRANCH;
    const url = `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/src/index.js`;

    let list = [];
    try { list = JSON.parse(localStorage.DWEM_MODULES || '[]'); } catch (e) { list = []; }
    list = list.filter(u => typeof u === 'string' && !OURS.test(u));
    list.push(url);
    localStorage.DWEM_MODULES = JSON.stringify(list);

    // DWEM also remembers the module list it resolved; drop our stale entries so two versions never load.
    try {
        const cfg = JSON.parse(localStorage.DWEM || 'null');
        if (cfg && Array.isArray(cfg.Modules)) {
            cfg.Modules = cfg.Modules.filter(u => typeof u !== 'string' || !OURS.test(u));
            localStorage.DWEM = JSON.stringify(cfg);
        }
    } catch (e) { /* ignore */ }

    // Refresh the pinned commit in the background for the next page load.
    if (!localStorage.DCSSFX_PIN) {
        const age = (Date.now() - (Number(localStorage[K_TIME]) || 0)) / 1000;
        if (age > TTL_SECONDS) {
            fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {headers: {Accept: 'application/vnd.github+json'}})
                .then(r => (r.ok ? r.json() : null))
                .then(j => {
                    if (j && /^[0-9a-f]{40}$/.test(j.sha)) {
                        localStorage[K_REF] = j.sha;
                        localStorage[K_TIME] = String(Date.now());
                    }
                })
                .catch(() => { /* offline or rate limited: keep the last known commit */ });
        }
    }
})();
