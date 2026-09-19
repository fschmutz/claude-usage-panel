// The "Accounts" section of the dropdown: one row per saved Claude Code login,
// the active one marked, every other one a click away from becoming the live
// login, and the auto-switch toggle under them. Rows are rebuilt on every
// refresh inside ONE widget (like the sessions rows) so the menu never
// reshuffles. AccountsController at the bottom owns the whole flow -
// extension.js only calls refresh() and reads activeName for the panel prefix.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    listProfiles, liveAccountName, readLastSwitchMs, switchTo, syncBack, usageFor,
    writeUsageCache,
} from './accounts.js';
import {
    accountSummary, autoSwitchTarget, formatAccountUsage, rowError, severityClass,
    usageSeverity, worstPercent,
} from './pure.js';
import {vbox, vboxProps, clipLabel} from './widgets.js';

/**
 * The rows for the section, and the worst limit per account for the
 * auto-switch decision. The active account's usage is what the cards above
 * already show; every other account is fetched with its own stored token
 * (refreshed if stale); an expired login is not fetched at all. The results
 * are also dropped into the usage cache the status line reads.
 */
async function collectAccountRows(session, profiles, active, activeCards) {
    const results = {};
    const rows = await Promise.all(profiles.map(async profile => {
        const summary = accountSummary(profile);
        if (profile.name === active) {
            results[profile.name] = {ok: true, cards: activeCards};
            return {...summary, cards: activeCards, error: null};
        }
        if (summary.tokenState === 'expired')
            return {...summary, cards: null, error: null};
        const r = await usageFor(session, profile.name);
        results[profile.name] = r;
        return {
            ...summary, cards: r.ok ? r.cards : null,
            error: r.ok ? null : rowError(profile.name, r.message),
        };
    }));
    writeUsageCache(results);
    const worst = Object.fromEntries(
        profiles.map(p => [p.name, results[p.name]?.ok ? worstPercent(results[p.name].cards) : null]));
    return {rows, worst};
}

const AccountsSection = GObject.registerClass(
class AccountsSection extends St.BoxLayout {
    /**
     * @param {(name: string) => void} onSwitch called with the name of the
     *   row the user clicked (never the active one)
     */
    _init(onSwitch) {
        super._init(vboxProps({x_expand: true, style_class: 'cu-accounts'}));
        this._onSwitch = onSwitch;
        this._title = new St.Label({text: _('Accounts'), style_class: 'cu-section-title'});
        this._rows = vbox({x_expand: true});
        this.add_child(this._title);
        this.add_child(this._rows);
        this.visible = false;
    }

    /**
     * Rebuild the rows.
     * @param {Array<{name: string, email: ?string, tokenState: string,
     *   cards: ?object[], error: ?string}>} rows saved accounts, store order
     * @param {?string} activeName the saved name of the live login
     */
    update(rows, activeName) {
        this._rows.destroy_all_children();
        this.visible = rows.length > 0;
        for (const row of rows) {
            const active = row.name === activeName;
            const line = new St.BoxLayout({
                style_class: `cu-account-row${active ? ' cu-account-active' : ''}`,
                x_expand: true,
            });
            line.add_child(clipLabel(new St.Label({
                text: `${active ? '●' : '○'} ${row.name}`,
                style_class: 'cu-account-name',
                y_align: Clutter.ActorAlign.CENTER,
            })));
            // The email is the one field that can be arbitrarily long, so it
            // is the one that gives way: it takes the slack and clips.
            line.add_child(clipLabel(new St.Label({
                text: row.email ?? '',
                style_class: 'cu-account-meta',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            })));
            const meta = new St.Label({
                text: this._metaText(row),
                style_class: `cu-account-meta ${severityClass(usageSeverity(worstPercent(row.cards)))}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            line.add_child(meta);
            if (active) {
                this._rows.add_child(line);
                continue;
            }
            const button = new St.Button({
                style_class: 'cu-account-btn',
                x_expand: true,
                can_focus: true,
                child: line,
            });
            button.connect('clicked', () => this._onSwitch(row.name));
            this._rows.add_child(button);
        }
    }

    // What the right-hand column says: the usage figures when we have them, a
    // plain "login expired" when the stored tokens cannot be refreshed, else
    // the short error from the fetch.
    _metaText(row) {
        if (row.tokenState === 'expired')
            return _('(login expired)');
        if (row.cards)
            return formatAccountUsage(row.cards);
        if (row.error)
            return row.error;
        return '';
    }
});

// ── The flow behind the section ─────────────────────────────────────────────────

export class AccountsController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings the extension settings
     * @param {Soup.Session} deps.session for the usage + refresh calls
     * @param {PopupMenu.PopupMenu} deps.menu the dropdown; both items are
     *   appended at construction, so build in menu order
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => void} deps.refreshSoon re-poll shortly (as the new account)
     * @param {() => void} deps.onActiveChanged the panel prefix may have moved
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     */
    constructor({settings, session, menu, notify, refreshSoon, onActiveChanged, isDestroyed}) {
        this._settings = settings;
        this._session = session;
        this._notify = notify;
        this._refreshSoon = refreshSoon;
        this._onActiveChanged = onActiveChanged;
        this._isDestroyed = isDestroyed;
        this._switching = false;
        /** The saved name of the live login, for the top-bar prefix. */
        this.activeName = null;
        /** How many logins are saved - the prefix is noise below two. */
        this.savedCount = 0;

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._section = new AccountsSection(name => this.switchTo(name));
        this._item.add_child(this._section);
        menu.addMenuItem(this._item);
        this._item.visible = false;

        // Label and state of the toggle follow the settings, not the other way
        // round, so the preferences window and the menu never disagree.
        this._autoSwitchItem = new PopupMenu.PopupSwitchMenuItem('', false);
        this._autoSwitchItem.connect('toggled', (_item, state) => {
            if (this._settings.get_boolean('accounts-auto-switch') !== state)
                this._settings.set_boolean('accounts-auto-switch', state);
        });
        menu.addMenuItem(this._autoSwitchItem);
        this._autoSwitchItem.visible = false;
        this.syncToggle();
    }

    syncToggle() {
        const threshold = this._settings.get_int('accounts-switch-threshold');
        this._autoSwitchItem.label.text = _('Auto-switch at %d%%').format(threshold);
        const on = this._settings.get_boolean('accounts-auto-switch');
        if (this._autoSwitchItem.state !== on)
            this._autoSwitchItem.setToggleState(on);
        this._autoSwitchItem.visible = this._showToggle();
    }

    // The toggle is for choosing between logins: below two it has nothing to
    // do, and the user can keep it out of the menu (it stays in the prefs).
    _showToggle() {
        return this._settings.get_boolean('accounts-enabled') && this.savedCount > 1 &&
            this._settings.get_boolean('accounts-menu-toggle');
    }

    // Both feed the top-bar readout, so both re-render it when they move.
    _setActive(name, savedCount = this.savedCount) {
        if (this.activeName === name && this.savedCount === savedCount)
            return;
        this.activeName = name;
        this.savedCount = savedCount;
        this._onActiveChanged();
    }

    /**
     * One row per saved login, then - if auto-switch is on and the active
     * account is over the threshold - move to the freest one.
     * @param {object[]} activeCards the cards the poll just fetched
     */
    async refresh(activeCards) {
        // Off by default: no rows, no toggle, no panel prefix, no fetch.
        if (!this._settings.get_boolean('accounts-enabled')) {
            this._setActive(null, 0);
            this._item.visible = false;
            this._autoSwitchItem.visible = false;
            return;
        }
        let profiles;
        try {
            // Claude Code rotates the live login's tokens as it runs, and the
            // refresh token it replaces is revoked. A profile only written at
            // save time therefore rots while its account is the live one, and
            // the switch back fails with HTTP 400. Sync first, every poll: it
            // compares and writes only when the blob actually moved.
            syncBack();
            profiles = listProfiles();
        } catch (e) {
            logError(e, 'claude-usage-panel: could not read the saved accounts');
            profiles = [];
        }
        const active = liveAccountName();
        this._setActive(active, profiles.length);
        this._item.visible = profiles.length > 0;
        this._autoSwitchItem.visible = this._showToggle();
        if (!profiles.length) {
            this._section.update([], active);
            return;
        }
        const {rows, worst} = await collectAccountRows(
            this._session, profiles, active, activeCards);
        if (this._isDestroyed())
            return;
        this._section.update(rows, active);

        if (!this._settings.get_boolean('accounts-auto-switch') || this._switching)
            return;
        // The cooldown anchor is store state: a switch made by the CLI, the
        // MCP tool or another panel counts here too.
        const target = autoSwitchTarget({
            active, worst,
            threshold: this._settings.get_int('accounts-switch-threshold'),
            lastSwitchMs: readLastSwitchMs(),
        });
        if (target)
            await this.switchTo(target.to, target);
    }

    /**
     * Make `name` the live login, tell the user, and poll again as that
     * account. `auto` carries the numbers when the switch was automatic.
     */
    async switchTo(name, auto = null) {
        if (this._switching)
            return;
        this._switching = true;
        try {
            const r = await switchTo(this._session, name);
            if (this._isDestroyed() || !r.changed)
                return;
            let body = auto
                ? _('Switched %s → %s: %s was at %d%%').format(
                    r.from ?? '?', r.to, r.from ?? '?', auto.activePercent)
                : _('Switched %s → %s').format(r.from ?? '?', r.to);
            if (r.running > 0) {
                body += _(' - %d running session(s) keep the old login until restarted')
                    .format(r.running);
            }
            this._notify(_('Claude usage'), body);
            this._refreshSoon();
        } catch (e) {
            if (this._isDestroyed())
                return;
            logError(e, 'claude-usage-panel: account switch failed');
            this._notify(_('Claude usage'),
                _('Could not switch to %s: %s').format(name, e.message));
        } finally {
            this._switching = false;
        }
    }
}
