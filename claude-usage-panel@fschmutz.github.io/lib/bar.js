// The two allocation-driven strips of a limit card: the progress bar and the
// clock caret under it. Both size themselves from the width they are given, so
// the fill stays a true percentage whatever the dropdown ends up being on this
// screen. Shared with the Cursor section's spend gauge.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {barPx} from './pure.js';

// Half the caret glyph, so its point - not its left edge - lands on the
// elapsed fraction of the track above it.
const CLOCK_MARK_HALF = 4;

/**
 * An actor's allocated width in CSS pixels. Allocations are device pixels
 * while inline `width:` styles are multiplied by the scale factor; everything
 * here is stated in CSS pixels so the two never get mixed.
 */
function cssWidth(actor) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    return actor.get_width() / scale;
}

export const ProgressBar = GObject.registerClass(
class ProgressBar extends St.BoxLayout {
    // A BoxLayout, not a Bin, on purpose: St.Bin centers its child and offers
    // no way to say otherwise (its only own property is `child`; the x_align
    // it inherits from ClutterActor places the Bin in its parent, not the
    // child in the Bin). A horizontal BoxLayout packs from the start edge, so
    // a non-expanding fill sits flush left at its CSS width, which is what
    // makes the bar read as a percentage.
    _init(props = {}) {
        super._init({
            style_class: 'cu-track',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            ...props,
        });
        this._fill = new St.Widget({style_class: 'cu-fill', x_expand: false});
        this.add_child(this._fill);
        this._percent = 0;
        this._sev = 'cu-normal';
        this._paintedAt = -1;
        this.connect('notify::width', () => this._paint());
    }

    /** @param {number} percent 0..100 @param {string} sev a cu-* severity class */
    setFill(percent, sev) {
        this._percent = percent;
        this._sev = sev;
        this._paintedAt = -1;
        this._paint();
    }

    _paint() {
        const track = cssWidth(this);
        if (track <= 0 || track === this._paintedAt)
            return;
        this._paintedAt = track;
        this._fill.style_class = `cu-fill ${this._sev}`;
        this._fill.style = `width: ${barPx(this._percent, track)}px;`;
    }
});

export const ClockRow = GObject.registerClass(
class ClockRow extends St.BoxLayout {
    // Where the clock is, under the bar: a caret at the elapsed fraction of
    // the window, pushed into place by a spacer. Two children in a row always
    // allocate in order, unlike an overlay, which St cannot place
    // proportionally without a fixed layout.
    _init() {
        super._init({style_class: 'cu-clock-row', x_expand: true});
        this._spacer = new St.Widget({x_expand: false});
        this._mark = new St.Label({style_class: 'cu-clock-mark', text: '▲'});
        this.add_child(this._spacer);
        this.add_child(this._mark);
        this._percent = 0;
        this._ahead = false;
        this._paintedAt = -1;
        this.connect('notify::width', () => this._paint());
    }

    /** @param {number} percent elapsed share of the window @param {boolean} ahead quota outrunning it */
    setMark(percent, ahead) {
        this._percent = percent;
        this._ahead = ahead;
        this._paintedAt = -1;
        this._paint();
    }

    _paint() {
        const track = cssWidth(this);
        if (track <= 0 || track === this._paintedAt)
            return;
        this._paintedAt = track;
        this._spacer.style =
            `width: ${Math.max(0, barPx(this._percent, track) - CLOCK_MARK_HALF)}px;`;
        this._mark.style_class = `cu-clock-mark${this._ahead ? ' cu-warning' : ''}`;
    }
});
