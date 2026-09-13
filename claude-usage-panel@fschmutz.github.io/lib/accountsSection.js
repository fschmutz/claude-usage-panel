// The "Accounts" section of the dropdown: one row per saved Claude Code login,
// the active one marked, every other one a click away from becoming the live
// login. Rows are rebuilt on every refresh inside ONE widget (like the
// sessions rows in extension.js) so the menu never reshuffles.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {usageFor, writeUsageCache} from './accounts.js';
import {accountSummary, formatAccountUsage, severityClass, worstPercent} from './pure.js';

/**
 * The rows for the section, and the worst limit per account for the
 * auto-switch decision. The active account's usage is what the cards above
 * already show; every other account is fetched with its own stored token
 * (refreshed if stale); an expired login is not fetched at all. The results
 * are also dropped into the usage cache the status line reads.
 */
export async function collectAccountRows(session, profiles, active, activeCards) {
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
        return {...summary, cards: r.ok ? r.cards : null, error: r.ok ? null : r.message};
    }));
    writeUsageCache(results);
    const worst = Object.fromEntries(
        profiles.map(p => [p.name, results[p.name]?.ok ? worstPercent(results[p.name].cards) : null]));
    return {rows, worst};
}

// Colour the usage figures by the worst limit, with the same thresholds the
// status line uses for values that carry no API severity.
function usageSeverity(cards) {
    const worst = worstPercent(cards);
    if (worst === null)
        return 'normal';
    return worst >= 90 ? 'critical' : worst >= 70 ? 'warning' : 'normal';
}

export const AccountsSection = GObject.registerClass(
class AccountsSection extends St.BoxLayout {
    /**
     * @param {(name: string) => void} onSwitch called with the name of the
     *   row the user clicked (never the active one)
     */
    _init(onSwitch) {
        super._init({vertical: true, x_expand: true, style_class: 'cu-accounts'});
        this._onSwitch = onSwitch;
        this._title = new St.Label({text: _('Accounts'), style_class: 'cu-section-title'});
        this._rows = new St.BoxLayout({vertical: true, x_expand: true});
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
            line.add_child(new St.Label({
                text: `${active ? '●' : '○'} ${row.name}`,
                style_class: 'cu-account-name',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            line.add_child(new St.Label({
                text: row.email ?? '',
                style_class: 'cu-account-meta',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const meta = new St.Label({
                text: this._metaText(row),
                style_class: `cu-account-meta ${severityClass(usageSeverity(row.cards))}`,
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
