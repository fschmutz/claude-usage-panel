// The two plain rows under the limit cards: prepaid extra usage, and the
// status block (session cost, "Updated", scheduled session pings). Each owns
// its menu item; extension.js only hands them what the poll found.

import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fetchActiveCost} from './cost.js';
import {readLastPing, readSchedule} from './sessionPing.js';
import {compactTokens, formatLastPing, nextPing, severityClass} from './pure.js';
import {vbox} from './widgets.js';

const plainItem = () => new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});

/** Prepaid credit already charged this cycle. Money rather than a window: no
 *  reset, no clock caret, so it gets its own compact row instead of a card,
 *  hidden entirely when the account has extra usage off - a disabled cap is
 *  not headroom. */
export class ExtraUsageSection {
    constructor(menu) {
        this._item = plainItem();
        const box = vbox({x_expand: true, style_class: 'cu-extra'});
        box.add_child(new St.Label({text: _('Extra usage'), style_class: 'cu-section-title'}));
        this._line = new St.Label({text: '', style_class: 'cu-cost'});
        box.add_child(this._line);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    update(extra) {
        this._item.visible = Boolean(extra);
        if (!extra)
            return;
        this._line.text = extra.limitAmount !== null
            ? _('%s (%d%% of the cap)').format(extra.detail, extra.percent)
            : extra.detail;
        this._line.style_class = `cu-cost ${severityClass(extra.severity)}`;
    }
}

/** Cost line, "Updated", and the session-ping line (hidden unless pings are
 *  scheduled or have ever run). */
export class StatusSection {
    constructor({menu, settings, isDestroyed}) {
        this._settings = settings;
        this._isDestroyed = isDestroyed;
        const item = plainItem();
        const box = vbox({x_expand: true, style_class: 'cu-status'});
        this._cost = new St.Label({text: '', style_class: 'cu-cost'});
        this._updated = new St.Label({text: '', style_class: 'cu-updated'});
        this._ping = new St.Label({text: '', style_class: 'cu-updated'});
        this._ping.visible = false;
        box.add_child(this._cost);
        box.add_child(this._updated);
        box.add_child(this._ping);
        item.add_child(box);
        menu.addMenuItem(item);
    }

    /** The "Updated …" line, or why the poll failed. */
    get updatedText() {
        return this._updated.text;
    }

    set updatedText(text) {
        this._updated.text = text;
    }

    // 'est.': cost is reconstructed from local logs and a price table, while
    // the limit percentages come from the usage endpoint.
    async refreshCost() {
        if (!this._settings.get_boolean('show-cost')) {
            this._cost.visible = false;
            return;
        }
        this._cost.visible = true;
        this._cost.text = _('Session cost: computing…');
        const cost = await fetchActiveCost();
        if (this._isDestroyed())
            return;
        this._cost.text = cost
            ? _('Session cost: $%s · %s tokens (est.)')
                .format(cost.costUSD.toFixed(2), compactTokens(cost.tokens))
            : _('Session cost: unavailable (install ccusage)');
    }

    // The 5 h window is anchored to its first message, so a ping at 05:30 is
    // what makes the day's windows line up with the hours worked. The schedule
    // lives in the systemd units (shared with ./install.sh sessionping); this
    // only reports what it did and what it will do next, read without
    // blocking after the poll that drew the cards.
    async renderPing() {
        const [schedule, lastRaw] = await Promise.all([readSchedule(), readLastPing()]);
        if (this._isDestroyed())
            return;
        const last = formatLastPing(lastRaw, Date.now());
        if (!schedule.enabled && !last) {
            this._ping.visible = false;
            return;
        }
        const parts = [_('last %s').format(last || _('never'))];
        if (schedule.enabled) {
            const next = nextPing(schedule.times, schedule.days, Date.now());
            if (next)
                parts.push(_('next %s').format(next));
        }
        this._ping.text = _('Session pings: %s').format(parts.join(' · '));
        this._ping.visible = true;
    }
}
