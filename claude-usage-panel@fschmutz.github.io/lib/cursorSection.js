// The optional Cursor section of the dropdown: team spend this cycle (with a
// gauge when the team has a monthly limit), today's spend, the top spender.
// Owns its menu item, the Admin API key (system keyring, with the legacy
// dconf slot as source and fallback) and the fetch. extension.js only calls
// refresh().

import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fetchCursor} from './cursorUsage.js';
import {storeSecret, lookupSecret} from './secretStore.js';
import {thresholdClass} from './pure.js';
import {ProgressBar} from './bar.js';
import {vbox, wrapLabel} from './widgets.js';

export class CursorController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings the extension settings
     * @param {Soup.Session} deps.session for the Admin API calls
     * @param {PopupMenu.PopupMenu} deps.menu the dropdown; the section is
     *   appended at construction, so build in menu order
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     */
    constructor({settings, session, menu, isDestroyed}) {
        this._settings = settings;
        this._session = session;
        this._isDestroyed = isDestroyed;

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-cursor'});
        this._cycle = wrapLabel(new St.Label({text: '', style_class: 'cu-cost'}));
        // Gauge bar, shown only when the team has a monthly spend limit set.
        this._track = new ProgressBar();
        this._track.visible = false;
        this._today = wrapLabel(new St.Label({text: '', style_class: 'cu-updated'}));
        this._top = wrapLabel(new St.Label({text: '', style_class: 'cu-updated'}));
        box.add_child(new St.Label({text: 'Cursor', style_class: 'cu-section-title'}));
        box.add_child(this._cycle);
        box.add_child(this._track);
        box.add_child(this._today);
        box.add_child(this._top);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    // The key lives in the system keyring; the dconf slot is only the legacy
    // location and the fallback for systems without a Secret Service. A value
    // found in dconf while the keyring works is migrated in and scrubbed.
    async _key() {
        const stored = await lookupSecret('cursor-admin-api-key');
        if (stored)
            return stored;
        const legacy = this._settings.get_string('cursor-api-key');
        if (legacy && await storeSecret('cursor-admin-api-key', legacy))
            this._settings.set_string('cursor-api-key', '');
        return legacy;
    }

    async refresh() {
        const key = await this._key();
        if (this._isDestroyed())
            return;
        if (!this._settings.get_boolean('cursor-enabled') || !key) {
            this._item.visible = false;
            return;
        }
        this._item.visible = true;
        this._cycle.text = _('Loading…');
        this._today.text = '';
        this._top.text = '';
        try {
            const c = await fetchCursor(this._session, key);
            if (this._isDestroyed())
                return;
            if (c.percent !== null) {
                // Team has a monthly limit → show a % gauge.
                this._cycle.text = _('This cycle: $%s / $%s (%d%%) · %d members')
                    .format(c.cycleUSD.toFixed(2), c.limitUSD.toFixed(0), c.percent, c.members);
                this._track.setFill(c.percent, thresholdClass(c.percent));
                this._track.visible = true;
            } else {
                this._cycle.text = _('This cycle: $%s · %d members')
                    .format(c.cycleUSD.toFixed(2), c.members);
                this._track.visible = false;
            }
            this._today.text = c.todayUSD === null
                ? '' : _('Today: $%s').format(c.todayUSD.toFixed(2));
            this._top.text = c.topSpender
                ? _('Top: %s $%s').format(c.topSpender.email, c.topSpender.usd.toFixed(2)) : '';
        } catch (e) {
            if (this._isDestroyed())
                return;
            this._cycle.text = _('Cursor: %s').format(e.message);
            this._track.visible = false;
            this._today.text = '';
            this._top.text = '';
        }
    }
}
