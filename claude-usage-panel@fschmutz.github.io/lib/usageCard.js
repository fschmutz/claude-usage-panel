// One limit row of the dropdown: label, percentage, colored progress bar with
// the clock caret under it, reset line, forecast, sparkline, week-over-week.
// The bar and the caret size themselves from the card's own width (lib/bar.js)
// and the prose lines wrap, so nothing here decides how wide the popup is.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    severityClass, sparkline, formatResets, poolNote, usageReading,
    formatForecast, historyPercents, clockPace, formatClockPace, formatWeekOverWeek,
} from './pure.js';
import {ProgressBar, ClockRow} from './bar.js';
import {vboxProps, wrapLabel, clipLabel} from './widgets.js';

// Why the card shows `–`. Silence when it shows a percentage: the number is
// its own explanation.
function readingNote(reading) {
    if (reading.reason === 'window_reset')
        return _('window reset - waiting for the first reading of the new one');
    if (reading.reason === 'no_reading')
        return _('the endpoint reported no figure for this limit');
    return '';
}

export const UsageCard = GObject.registerClass(
class UsageCard extends St.BoxLayout {
    _init() {
        super._init(vboxProps({style_class: 'cu-card', x_expand: true}));

        const head = new St.BoxLayout({style_class: 'cu-card-head', x_expand: true});
        this._label = clipLabel(new St.Label({style_class: 'cu-card-label', x_expand: true}));
        this._pct = new St.Label({style_class: 'cu-card-pct'});
        head.add_child(this._label);
        head.add_child(this._pct);

        this._track = new ProgressBar();
        this._clockRow = new ClockRow();

        this._reset = wrapLabel(new St.Label({style_class: 'cu-card-reset'}));
        this._forecast = wrapLabel(new St.Label({style_class: 'cu-forecast'}));
        this._spark = new St.Label({style_class: 'cu-spark'});
        // Week-over-week peak from the durable history - the one thing the
        // 6-hour forecast window cannot say.
        this._trend = wrapLabel(new St.Label({style_class: 'cu-forecast'}));

        this.add_child(head);
        this.add_child(this._track);
        this.add_child(this._clockRow);
        this.add_child(this._reset);
        this.add_child(this._forecast);
        this.add_child(this._spark);
        this.add_child(this._trend);
    }

    update(card, history, fc, trend) {
        // A percentage the endpoint cannot currently stand behind draws as `–`
        // with an empty bar, never as the last one it gave: after a window
        // resets the figure on file belongs to a window that is gone, and a
        // limit the payload never carried a number for is not a limit at 0 %.
        const reading = usageReading(card);
        const sev = reading.known ? severityClass(card.severity) : 'cu-normal';
        this._label.text = card.label + (card.active ? '  ●' : '');
        this._pct.text = reading.text;
        this._pct.style_class = `cu-card-pct ${sev}`;
        this._track.setFill(reading.fill, sev);
        // How far into the window we are, as a caret under the bar: quota to
        // the left of it is spent on schedule, quota to the right of the fill
        // is what the clock has not yet earned. Hidden when the window length
        // is unknown (no reset, or a group we have no span for).
        const pace = clockPace(card);
        this._clockRow.visible = pace !== null;
        if (pace)
            this._clockRow.setMark(pace.elapsedPercent, pace.state === 'ahead');
        // A per-model card (Fable) caps a share of the weekly pool rather than
        // adding one, so its reset line carries that note - same reset as the
        // all-models card it draws from.
        const reset = formatResets(card.resetsAt);
        const note = poolNote(card);
        const paceText = formatClockPace(pace);
        this._reset.text = [reset, note, paceText, readingNote(reading)]
            .filter(s => s).join(' · ');
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
