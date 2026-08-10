/**
 * osd_layout.js — Système Drag & Drop des éléments OSD
 * Permet de repositionner les éléments OSD à la souris/tactile,
 * avec sauvegarde indépendante par profil (screen / goggles).
 *
 * Architecture :
 *   - 12 éléments OSD draggables avec bounding boxes exactes
 *   - Pointer events (mouse + touch) sur le canvas OSD
 *   - Overlay visuel (cadres pointillés + highlight) dessiné APRÈS le rendu OSD
 *   - Positions en pourcentage (0-100) de la taille du canvas
 *   - Sauvegarde asynchrone vers /api/osd/layout
 */
'use strict';

const OSDLayout = (() => {

    // ==========================================================
    // DÉFINITION DES ÉLÉMENTS GLISSABLES (12 éléments)
    // ==========================================================
    // Chaque entrée décrit un bloc OSD draggable :
    //   name      : libellé affiché dans le cadre d'édition
    //   configX/Y : clés dans osdConfig pour les positions (%)
    //   anchor    : point d'ancrage du rendu ('tl'=top-left, 'c'=center, 'tr'=top-right, 'br'=bottom-right)
    //
    //   Les hitW/hitH ne sont plus utilisés pour l'affichage des cadres
    //   (les bounds exactes sont calculées dynamiquement via _getBounds),
    //   mais servent de zone de tolérance élargie pour le hit-test souris.
    const ELEMENTS = [
        { name: 'Horizon',      configX: 'horizon_x',      configY: 'horizon_y',      anchor: 'c'  },
        { name: 'Profondeur',   configX: 'depth_x',        configY: 'depth_y',        anchor: 'tl' },
        { name: 'Température',  configX: 'temperature_x',  configY: 'temperature_y',  anchor: 'tr' },
        { name: 'Boussole',     configX: 'compass_x',      configY: 'compass_y',      anchor: 'c'  },
        { name: 'Batterie',     configX: 'battery_x',      configY: 'battery_y',      anchor: 'tr' },
        { name: 'FPS',          configX: 'fps_x',           configY: 'fps_y',           anchor: 'tl' },
        { name: 'Propulseurs',  configX: 'motors_x',       configY: 'motors_y',        anchor: 'br' },
        { name: 'Rov 3D',       configX: 'rov3d_x',        configY: 'rov3d_y',         anchor: 'br' },
        { name: 'Horloge',      configX: 'clock_x',        configY: 'clock_y',         anchor: 'br' },
        { name: 'Armé/Désarmé', configX: 'armed_x',        configY: 'armed_y',         anchor: 'c'  },
        { name: 'Bat. Manette', configX: 'gamepad_battery_x', configY: 'gamepad_battery_y', anchor: 'tl' },
        { name: 'Mode Affichage', configX: 'display_mode_x', configY: 'display_mode_y', anchor: 'tr' },
    ];

    // ==========================================================
    // ÉTAT MODULE
    // ==========================================================
    let canvas = null;
    let editing = false;
    let activeProfile = 'screen';   // 'screen' | 'goggles'
    let dragging = null;            // { elem, offsetX, offsetY }
    let hoverElem = null;

    // ==========================================================
    // HELPERS DE CALCUL
    // ==========================================================

    /** Récupère l'osdConfig courant via Telemetry. */
    function _getConfig() {
        return (typeof Telemetry !== 'undefined' && Telemetry.osdConfig)
            ? Telemetry.osdConfig() : {};
    }

    /**
     * Calcule scale et fontSize exactement comme telemetry.renderOSD().
     * Ces valeurs sont critiques pour que les bounding boxes coïncident
     * avec le rendu réel des éléments OSD.
     */
    function _calcMetrics(w, h) {
        const cfg = _getConfig();
        const scale = Math.min(w / 1280, h / 720);
        const fontSize = Math.max(11, Math.round(14 * scale * (cfg.font_scale || 0.8)));
        return { scale, fontSize, cfg };
    }

    // ==========================================================
    // BOUNDING BOXES EXACTES (miroir des formules telemetry.js)
    // ==========================================================

    /**
     * Calcule la bounding box PRÉCISE (en pixels CSS) d'un élément OSD
     * en utilisant les MÊMES formules que les fonctions de dessin de
     * telemetry.js (drawHorizon, drawGauge, drawCompass, drawBattery,
     * drawText, drawMotors, _compositeRov3D).
     *
     * Le cadre pointillé épouse ainsi strictement le contour réel de
     * chaque bloc OSD.
     */
    function _getBounds(elem, w, h) {
        const { scale, fontSize, cfg } = _calcMetrics(w, h);
        const pad = 4;   // marge visuelle autour du cadre
        const cx = (cfg[elem.configX] || 0) * w / 100;
        const cy = (cfg[elem.configY] || 0) * h / 100;

        let x, y, bw, bh;

        switch (elem.configX) {

            // --- HORIZON (drawHorizon) ---
            // Cercle de rayon = min(w,h) * radius_pct/100
            // + arc de roulis (radius + 10*scale) + texte sous le cercle
            case 'horizon_x': {
                const rPct = (cfg.horizon_radius_pct != null ? cfg.horizon_radius_pct : 18) / 100;
                const radius = Math.min(w, h) * rPct;
                const rollArcR = radius + 10 * scale;
                const txtH = cfg.horizon_show_text ? (fontSize * 0.75 + 6) : 0;
                const halfW = rollArcR + 14 * scale;
                x  = cx - halfW - pad;
                y  = cy - halfW - pad;
                bw = (halfW + pad) * 2;
                bh = halfW + pad + radius + 14 * scale + txtH + pad;
                break;
            }

            // --- PROFONDEUR (drawGauge) ---
            // Fond rect : [x-2, y-18] → [x+barW+53, y+barH+17]
            case 'depth_x': {
                const barW = 14 * scale;
                const barH = h * 0.3;
                x  = cx - 2 - pad;
                y  = cy - 18 - pad;
                bw = barW + 55 + pad * 2;
                bh = barH + 35 + pad * 2;
                break;
            }

            // --- TEMPÉRATURE (drawText, align='right') ---
            // Fond drawText : [x - textW - 4, y - fs/2 - 2] taille [textW + 8, fs + 4]
            case 'temperature_x': {
                const fs = fontSize;
                const textW = fs * 0.6 * 14; // estimation "TEMP: XX.X°C" (~14 chars mono)
                x  = cx - textW - pad - pad;
                y  = cy - fs / 2 - 2 - pad;
                bw = textW + pad * 4;
                bh = fs + 4 + pad * 2;
                break;
            }

            // --- BOUSSOLE (drawCompass) ---
            // Fond : [cx - barW/2 - 8, cy - 16] taille [barW + 16, 32]
            // + texte CAP à droite : barW/2 + 8 + ~80px
            case 'compass_x': {
                const barW = w * 0.3;
                const extraRight = fontSize * 0.9 * 8; // "CAP XXX°" ~8 chars
                const totalW = barW + 16 + 8 + extraRight;
                x  = cx - barW / 2 - 8 - pad;
                y  = cy - 16 - pad;
                bw = totalW + pad * 2;
                bh = 32 + pad * 2;
                break;
            }

            // --- BATTERIE (drawBattery) ---
            // Fond : [x-4, y-4] taille [barW+45, barH+8]
            case 'battery_x': {
                const barW = 80 * scale;
                const barH = 12 * scale;
                x  = cx - 4 - pad;
                y  = cy - 4 - pad;
                bw = barW + 45 + pad * 2;
                bh = barH + 8 + pad * 2;
                break;
            }

            // --- FPS (drawText, align='left') ---
            // Fond drawText : [x - 4, y - fs/2 - 2] taille [textW + 8, fs + 4]
            case 'fps_x': {
                const fs = Math.round(fontSize * 0.85);
                const textW = fs * 0.6 * 7; // "FPS: XX" ~7 chars mono
                x  = cx - pad - pad;
                y  = cy - fs / 2 - 2 - pad;
                bw = textW + pad * 4;
                bh = fs + 4 + pad * 2;
                break;
            }

            // --- PROPULSEURS (drawMotors) ---
            // Widget : [baseX, baseY] taille [widgetW, widgetH]
            // Position : configX/Y → coin bas-droite du widget (anchor br)
            case 'motors_x': {
                const widgetW = Math.round(150 * scale);
                const widgetH = Math.round(130 * scale);
                x  = cx - widgetW - pad;
                y  = cy - widgetH - pad;
                bw = widgetW + pad * 2;
                bh = widgetH + pad * 2;
                break;
            }

            // --- ROV 3D (_compositeRov3D) ---
            // Taille : size = round(min(w,h) * 0.3)
            // Position : configX/Y → coin bas-droite (anchor br)
            case 'rov3d_x': {
                const size = Math.round(Math.min(w, h) * 0.3);
                x  = cx - size - pad;
                y  = cy - size - pad;
                bw = size + pad * 2;
                bh = size + pad * 2;
                break;
            }

            // --- HORLOGE (drawText, align='right') ---
            // Fond drawText : [x - textW - 4, y - fs/2 - 2] taille [textW + 8, fs + 4]
            case 'clock_x': {
                const fs = Math.round(fontSize * 0.85);
                const textW = fs * 0.6 * 8;
                x  = cx - textW - pad - pad;
                y  = cy - fs / 2 - 2 - pad;
                bw = textW + pad * 4;
                bh = fs + 4 + pad * 2;
                break;
            }

            // --- ARMÉ/DÉSARMÉ (fillText, align='center') ---
            // "○ DÉSARMÉ" ou "● ARMÉ" ~7 chars, fontSize * 1.1, centré
            case 'armed_x': {
                const fs = Math.round(fontSize * 1.1);
                const textW = fs * 0.6 * 7;
                x  = cx - textW / 2 - pad;
                y  = cy - fs / 2 - pad;
                bw = textW + pad * 2;
                bh = fs + pad * 2;
                break;
            }

            // --- BATTERIE MANETTE (drawText, align='left', conditionnel) ---
            // "🎮 XX%" ~6 chars, fontSize * 0.85
            case 'gamepad_battery_x': {
                const fs = Math.round(fontSize * 0.85);
                const textW = fs * 0.6 * 6;
                x  = cx - pad;
                y  = cy - fs / 2 - 2 - pad;
                bw = textW + pad * 2 + pad;
                bh = fs + 4 + pad * 2;
                break;
            }

            // --- MODE D'AFFICHAGE (drawText, align='right', conditionnel) ---
            // "🖥️ ÉCRAN" ou "🥽 LUNETTES" ~10 chars, fontSize * 0.9
            case 'display_mode_x': {
                const fs = Math.round(fontSize * 0.9);
                const textW = fs * 0.6 * 10;
                x  = cx - textW - pad;
                y  = cy - fs / 2 - 2 - pad;
                bw = textW + pad * 2;
                bh = fs + 4 + pad * 2;
                break;
            }

            // Fallback : hitbox générique
            default: {
                const hitW = 12, hitH = 5;
                bw = hitW * w / 100;
                bh = hitH * h / 100;
                x  = cx - bw / 2;
                y  = cy - bh / 2;
                break;
            }
        }

        return { x, y, w: bw, h: bh, cx, cy };
    }

    // ==========================================================
    // HIT DETECTION (utilise les bounds exactes)
    // ==========================================================

    /**
     * Retourne l'élément OSD sous le point (mx, my) en pixels CSS.
     * Utilise les bounding boxes exactes pour une détection précise.
     */
    function _hitTest(mx, my) {
        if (!canvas) return null;
        const w = parseFloat(canvas.style.width) || canvas.clientWidth || 1;
        const h = parseFloat(canvas.style.height) || canvas.clientHeight || 1;

        // Parcourir en ordre inverse (les éléments au-dessus d'abord)
        for (let i = ELEMENTS.length - 1; i >= 0; i--) {
            const elem = ELEMENTS[i];
            const b = _getBounds(elem, w, h);
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                return elem;
            }
        }
        return null;
    }

    // ==========================================================
    // OVERLAY VISUEL (cadres pointillés épousant les bounds réelles)
    // ==========================================================

    /**
     * Dessine les cadres de sélection sur le canvas OSD.
     * Appelée depuis renderOSD() de telemetry.js à la fin de chaque frame.
     * Les cadres épousent strictement les contours réels des éléments
     * grâce aux formules de _getBounds qui reproduisent le code de rendu.
     */
    function drawEditOverlay(ctx, w, h) {
        if (!editing) return;

        const labelSize = Math.max(9, Math.round(w * 0.012));

        for (const elem of ELEMENTS) {
            const b = _getBounds(elem, w, h);
            const isHover  = (hoverElem  === elem);
            const isDrag   = (dragging   && dragging.elem === elem);

            // Fond semi-transparent
            ctx.fillStyle = isDrag
                ? 'rgba(0, 255, 136, 0.12)'
                : isHover
                    ? 'rgba(0, 200, 255, 0.08)'
                    : 'rgba(255, 255, 255, 0.03)';
            ctx.fillRect(b.x, b.y, b.w, b.h);

            // Cadre pointillé
            ctx.strokeStyle = isDrag
                ? 'rgba(0, 255, 136, 0.9)'
                : isHover
                    ? 'rgba(0, 200, 255, 0.7)'
                    : 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = isDrag ? 2 : 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(b.x, b.y, b.w, b.h);
            ctx.setLineDash([]);

            // Label au-dessus du cadre
            ctx.font = `bold ${labelSize}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            const labelY = Math.max(labelSize + 2, b.y - 2);
            ctx.fillText(elem.name, b.x + 3, labelY);
        }

        // Curseur global
        if (canvas) {
            canvas.style.cursor = dragging ? 'grabbing' : (hoverElem ? 'grab' : 'default');
        }
    }

    // ==========================================================
    // POINTER EVENTS
    // ==========================================================

    function _onPointerDown(e) {
        if (!editing || !canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const elem = _hitTest(mx, my);
        if (!elem) return;

        e.preventDefault();
        e.stopPropagation();

        const w = rect.width  || 1;
        const h = rect.height || 1;
        const cfg = _getConfig();
        const cx = (cfg[elem.configX] || 0) * w / 100;
        const cy = (cfg[elem.configY] || 0) * h / 100;

        dragging = { elem, offsetX: mx - cx, offsetY: my - cy };
        canvas.setPointerCapture(e.pointerId);
    }

    function _onPointerMove(e) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (dragging) {
            e.preventDefault();
            const w = rect.width  || 1;
            const h = rect.height || 1;
            const newCx = mx - dragging.offsetX;
            const newCy = my - dragging.offsetY;
            const pctX = Math.max(0, Math.min(100, Math.round(newCx / w * 100)));
            const pctY = Math.max(0, Math.min(100, Math.round(newCy / h * 100)));

            const cfg = _getConfig();
            cfg[dragging.elem.configX] = pctX;
            cfg[dragging.elem.configY] = pctY;
            if (typeof Telemetry !== 'undefined') {
                Telemetry.updateOSDConfig({
                    [dragging.elem.configX]: pctX,
                    [dragging.elem.configY]: pctY
                });
            }
        } else if (editing) {
            hoverElem = _hitTest(mx, my);
        }
    }

    function _onPointerUp(e) {
        if (dragging) {
            dragging = null;
            if (canvas) canvas.releasePointerCapture(e.pointerId);
            // Sauvegarde automatique à chaque fin de déplacement
            _saveLayout(activeProfile);
        }
    }

    function _attachCanvasEvents() {
        if (!canvas) return;
        canvas.addEventListener('pointerdown',  _onPointerDown);
        canvas.addEventListener('pointermove',  _onPointerMove);
        canvas.addEventListener('pointerup',    _onPointerUp);
        canvas.addEventListener('pointercancel', _onPointerUp);
    }

    function _detachCanvasEvents() {
        if (!canvas) return;
        canvas.removeEventListener('pointerdown',  _onPointerDown);
        canvas.removeEventListener('pointermove',  _onPointerMove);
        canvas.removeEventListener('pointerup',    _onPointerUp);
        canvas.removeEventListener('pointercancel', _onPointerUp);
    }

    /**
     * Active/désactive pointer-events sur les canvas OSD.
     * En mode édition, le canvas doit recevoir les clics pour le drag.
     */
    function _setCanvasPointerEvents(enabled) {
        if (!canvas) return;
        canvas.style.pointerEvents = enabled ? 'auto' : 'none';
        const goggleCanvas = document.getElementById('goggle-osd-canvas');
        if (goggleCanvas) {
            goggleCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    }

    // ==========================================================
    // LOAD / SAVE LAYOUT (backend)
    // ==========================================================

    async function _loadLayout(profile) {
        try {
            const resp = await fetch(`/api/osd/layout?profile=${encodeURIComponent(profile)}`);
            const json = await resp.json();
            if (json.status === 'ok' && json.layout) {
                if (typeof Telemetry !== 'undefined') {
                    Telemetry.updateOSDConfig(json.layout);
                }
                console.log(`[OSDLayout] Layout '${profile}' chargé`, json.layout);
                return json.layout;
            }
        } catch (e) {
            console.warn('[OSDLayout] Erreur chargement layout:', e);
        }
        return null;
    }

    async function _saveLayout(profile) {
        const cfg = _getConfig();
        const layout = {};
        for (const elem of ELEMENTS) {
            layout[elem.configX] = cfg[elem.configX] ?? 0;
            layout[elem.configY] = cfg[elem.configY] ?? 0;
        }
        try {
            const resp = await fetch('/api/osd/layout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile, layout })
            });
            const json = await resp.json();
            console.log(`[OSDLayout] Layout '${profile}' sauvegardé`, json);
            return json;
        } catch (e) {
            console.warn('[OSDLayout] Erreur sauvegarde:', e);
            return null;
        }
    }

    // ==========================================================
    // INITIALISATION
    // ==========================================================

    /**
     * Charge le layout APRÈS un délai pour garantir que loadOSDConfig()
     * et osd_config.load() ont terminé d'écraser osdConfig avec les
     * valeurs de /api/config. Le layout a toujours la priorité.
     */
    function init() {
        canvas = document.getElementById('osd-canvas');
        if (canvas) {
            _attachCanvasEvents();
            // Délai de 300ms pour laisser les autres modules finir leur init
            setTimeout(() => _loadLayout('screen'), 300);
        } else {
            console.warn('[OSDLayout] Canvas OSD introuvable');
        }
    }

    // ==========================================================
    // API PUBLIQUE
    // ==========================================================

    return {
        init,

        setEditMode(enabled) {
            editing = !!enabled;
            _setCanvasPointerEvents(editing);
            if (!editing) {
                dragging = null;
                hoverElem = null;
                if (canvas) canvas.style.cursor = '';
            }
        },

        isEditMode() { return editing; },
        getProfile() { return activeProfile; },

        async setProfile(profile, saveCurrent = true) {
            if (profile === activeProfile) return;
            if (saveCurrent) await _saveLayout(activeProfile);
            activeProfile = profile;
            await _loadLayout(profile);
        },

        save()       { return _saveLayout(activeProfile); },
        reload()     { return _loadLayout(activeProfile); },

        async reset() {
            try {
                const resp = await fetch('/api/osd/layout/default');
                const json = await resp.json();
                if (json.status === 'ok' && json.layout) {
                    if (typeof Telemetry !== 'undefined') {
                        Telemetry.updateOSDConfig(json.layout);
                    }
                    await _saveLayout(activeProfile);
                }
            } catch (e) {
                console.warn('[OSDLayout] Erreur reset:', e);
            }
        },

        drawEditOverlay,
        ELEMENTS,
    };
})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => OSDLayout.init());
} else {
    OSDLayout.init();
}
