// The top bar's gauge: the logo's 270-degree arc, drawn live - filled to the
// panel card's honest reading and tinted by its tone. What to draw is
// lib/pure/usage.js panelGauge (pinned by tests/fixtures/gauge.json); this
// file is only the Cairo. The macOS twin is MenuBarGauge.swift.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';

import {GAUGE_COLORS} from './pure.js';

const SIZE = 16;
const STROKE = 3;
// The arc opens at the bottom: from 135 degrees clockwise through the top to
// 45 degrees, like the logo (svg/mark.svg rotates 135 and dashes 270 of 360).
const START = 0.75 * Math.PI;
const SWEEP = 1.5 * Math.PI;

function rgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

export const PanelGauge = GObject.registerClass(
class PanelGauge extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'cu-panel-gauge',
            width: SIZE,
            height: SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fraction = 0;
        this._tone = 'normal';
        this.connect('repaint', () => this._paint());
    }

    /** @param {{fraction: number, tone: string}} gauge - from panelGauge() */
    update({fraction, tone}) {
        if (fraction === this._fraction && tone === this._tone)
            return;
        this._fraction = fraction;
        this._tone = tone;
        this.queue_repaint();
    }

    _paint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const r = Math.min(w, h) / 2 - STROKE / 2;
        const cx = w / 2;
        // The opening at the bottom makes a centered arc look high; sit it
        // a little lower so the shape itself is centered.
        const cy = h / 2 + r * 0.15;
        cr.setLineWidth(STROKE);
        cr.setLineCap(Cairo.LineCap.ROUND);
        // The track follows the panel's foreground, so it stays visible on
        // light and dark shell themes alike.
        const fg = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.3);
        cr.arc(cx, cy, r, START, START + SWEEP);
        cr.stroke();
        if (this._fraction > 0) {
            cr.setSourceRGB(...rgb(GAUGE_COLORS[this._tone] ?? GAUGE_COLORS.normal));
            cr.arc(cx, cy, r, START, START + SWEEP * this._fraction);
            cr.stroke();
        }
        cr.$dispose();
    }
});
