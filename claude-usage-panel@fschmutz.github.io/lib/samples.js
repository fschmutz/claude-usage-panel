// The bookkeeping every poll does before anything is drawn: one timestamped
// sample per limit (what the sparkline draws and the burn-rate forecast reads),
// the forecasts themselves, and the notifications their latches fire.
//
// Split out of extension.js, which is the poll loop and the dropdown. The
// rules are all pure (lib/pure/pace.js for the forecast, lib/pure/events.js
// for the latches); this owns the GSettings-backed history and the notifier.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    forecast, formatForecast, formatResets, latchCrossings, latchPaceAlerts, normalizeHistory,
} from './pure.js';

/** Samples kept per limit - enough for the forecast's 6 h regression window at
 *  the 10-minute default (~15 h of context). The sparkline shows the last 12. */
export const HISTORY_MAX = 90;

export class SampleHistory {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings  holds the history across restarts
     * @param {(title: string, body: string) => void} deps.notify
     */
    constructor({settings, notify}) {
        this._settings = settings;
        this._notify = notify;
        /** limit id -> [[epochMs, percent], …] */
        this._history = this._load();
        /** limit id -> the latest forecast (or null) */
        this.forecasts = new Map();
        /** limit id -> the highest threshold already alerted */
        this._alertFired = new Map();
        /** limit ids already warned about projected exhaustion */
        this._paceAlerted = new Set();
    }

    /** One limit's samples, oldest first; [] for a limit with none yet. */
    history(key) {
        return this._history.get(key) ?? [];
    }

    /** Record this poll's samples, refresh the forecasts, fire what is due. */
    record(cards, now) {
        for (const card of cards) {
            const hist = this.history(card.key);
            hist.push([now, card.percent]);
            if (hist.length > HISTORY_MAX)
                hist.shift();
            this._history.set(card.key, hist);
            this.forecasts.set(card.key, forecast(hist, card.resetsAt, now));
        }
        this._save();
        this.checkAlerts(cards);
    }

    /**
     * Notify when a limit first crosses 90% or 100%, and once per window when
     * the pace projects it running dry at least 1 h before its reset. The
     * latches (lib/pure/events.js) hold the hysteresis; this only notifies.
     */
    checkAlerts(cards) {
        if (!this._settings.get_boolean('alerts-enabled'))
            return;
        for (const {card, threshold} of latchCrossings(this._alertFired, cards)) {
            const tail = card.resetsAt ? ` - ${formatResets(card.resetsAt)}` : '';
            this._notify(_('Claude usage'),
                _('%s reached %d%%').format(card.label, threshold) + tail);
        }
        for (const {card, forecast: fc} of latchPaceAlerts(this._paceAlerted, cards, this.forecasts)) {
            this._notify(_('Claude usage'),
                _('%s is on pace to run out before it resets').format(card.label) +
                ` - ${formatForecast(fc)}`);
        }
    }

    // Entries are [epochMs, percent] pairs; history written by versions that
    // stored bare percents migrates via normalizeHistory (the sparkline keeps
    // working, the forecast simply ignores the timestampless entries).
    _load() {
        try {
            const obj = JSON.parse(this._settings.get_string('history'));
            return new Map(Object.entries(obj)
                .map(([k, v]) => [k, normalizeHistory(v).slice(-HISTORY_MAX)]));
        } catch {
            return new Map();
        }
    }

    _save() {
        try {
            this._settings.set_string('history',
                JSON.stringify(Object.fromEntries(this._history)));
        } catch {
            // non-fatal: sparkline history is best-effort
        }
    }
}
