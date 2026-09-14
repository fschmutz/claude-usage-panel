// One limit row of the dropdown: label, percentage, colored progress bar with
// the clock caret under it, reset line, forecast, sparkline, week-over-week.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {
    severityClass, sparkline, formatResets, poolNote,
    formatForecast, historyPercents, clockPace, formatClockPace, formatWeekOverWeek,
} from './pure.js';
import {vboxProps} from './widgets.js';

export const TRACK_WIDTH = 300; // px, must match .cu-track min-width in stylesheet.css
// Half the caret glyph, so the mark's point - not its left edge - lands on the
// elapsed fraction of the track above it.
const CLOCK_MARK_HALF = 4;

export const UsageCard = GObject.registerClass(
class UsageCard extends St.BoxLayout {
    _init() {
        super._init(vboxProps({style_class: 'cu-card', x_expand: true}));

        const head = new St.BoxLayout({style_class: 'cu-card-head', x_expand: true});
        this._label = new St.Label({style_class: 'cu-card-label', x_expand: true});
        this._pct = new St.Label({style_class: 'cu-card-pct'});
        head.add_child(this._label);
        head.add_child(this._pct);

        // The track is a BoxLayout, not a Bin, on purpose: St.Bin centers its
        // child and offers no way to say otherwise (its only own property is
        // `child`; the x_align it inherits from ClutterActor places the Bin in
        // its parent, not the child in the Bin). A horizontal BoxLayout packs
        // from the start edge, so a non-expanding fill sits flush left at its
        // CSS width, which is what makes the bar read as a percentage.
        const track = new St.BoxLayout({
            style_class: 'cu-track',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        this._fill = new St.Widget({style_class: 'cu-fill', x_expand: false});
        track.add_child(this._fill);

        // Where the clock is, under the bar. A caret at the elapsed fraction
        // of the window, pushed into place by a spacer: two children in a row
        // always allocate in order, unlike an overlay, which St cannot place
        // proportionally without a fixed layout.
        this._clockRow = new St.BoxLayout({
            style_class: 'cu-clock-row',
            x_align: Clutter.ActorAlign.START,
            x_expand: false,
        });
        this._clockSpacer = new St.Widget({x_expand: false});
        this._clockMark = new St.Label({style_class: 'cu-clock-mark', text: '▲'});
        this._clockRow.add_child(this._clockSpacer);
        this._clockRow.add_child(this._clockMark);

        this._reset = new St.Label({style_class: 'cu-card-reset'});
        this._forecast = new St.Label({style_class: 'cu-forecast'});
        this._spark = new St.Label({style_class: 'cu-spark'});
        // Week-over-week peak from the durable history - the one thing the
        // 6-hour forecast window cannot say.
        this._trend = new St.Label({style_class: 'cu-forecast'});

        this.add_child(head);
        this.add_child(track);
        this.add_child(this._clockRow);
        this.add_child(this._reset);
        this.add_child(this._forecast);
        this.add_child(this._spark);
        this.add_child(this._trend);
    }

    update(card, history, fc, trend) {
        const sev = severityClass(card.severity);
        this._label.text = card.label + (card.active ? '  ●' : '');
        this._pct.text = `${card.percent}%`;
        this._pct.style_class = `cu-card-pct ${sev}`;
        const px = Math.round((card.percent / 100) * TRACK_WIDTH);
        this._fill.style_class = `cu-fill ${sev}`;
        this._fill.style = `width: ${px}px;`;
        // How far into the window we are, as a caret under the bar: quota to
        // the left of it is spent on schedule, quota to the right of the fill
        // is what the clock has not yet earned. Hidden when the window length
        // is unknown (no reset, or a group we have no span for).
        const pace = clockPace(card);
        this._clockRow.visible = pace !== null;
        if (pace) {
            const markPx = Math.round((pace.elapsedPercent / 100) * TRACK_WIDTH);
            this._clockSpacer.style = `width: ${Math.max(0, markPx - CLOCK_MARK_HALF)}px;`;
            this._clockMark.style_class =
                `cu-clock-mark${pace.state === 'ahead' ? ' cu-warning' : ''}`;
        }
        // A per-model card (Fable) caps a share of the weekly pool rather than
        // adding one, so its reset line carries that note - same reset as the
        // all-models card it draws from.
        const reset = formatResets(card.resetsAt);
        const note = poolNote(card);
        const paceText = formatClockPace(pace);
        this._reset.text = [reset, note, paceText].filter(s => s).join(' · ');
        // Burn-rate projection: amber when the limit runs out before its reset,
        // quiet grey when the pace outlasts it, hidden when there is no honest
        // pace to project (idle, too few samples).
        const fcText = formatForecast(fc);
        this._forecast.text = fcText;
        this._forecast.visible = fcText.length > 0;
        this._forecast.style_class =
            `cu-forecast${fc?.exhaustsBeforeReset ? ' cu-warning' : ''}`;
        const spark = sparkline(historyPercents(history).slice(-12));
        this._spark.text = spark;
        this._spark.visible = spark.length > 0;
        const trendText = formatWeekOverWeek(trend);
        this._trend.text = trendText;
        this._trend.visible = trendText.length > 0;
    }
});
