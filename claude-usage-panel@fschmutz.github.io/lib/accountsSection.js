// The "Accounts" section of the dropdown: one row per saved Claude Code login,
// the active one marked and every other one a click away from becoming the
// live login. The auto-switch control is the header's button, painted from
// here through deps.syncAutoSwitch. Rows are rebuilt on every
// refresh inside ONE widget (like the sessions rows) so the menu never
// reshuffles. AccountsController at the bottom owns the whole flow -
// extension.js only calls refresh() and reads activeName for the panel prefix.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    listProfiles, liveAccountName, readLastSwitchMs, readLiveAccount, readPendingSwitch,
    saveCurrent, switchTo, syncBack, updateWeeklyResets, usageFor, writeUsageCache,
} from './accounts.js';
import {
    OUTCOME_TTL_MS, accountHealth, accountNotices, accountSummary, autoSwitchTarget,
    formatAccountUsage, isTorn, needsAttention, nextInRotation, outcome, outcomeVisible, parkName,
    rotationOrder, rowError, severityClass, usageSeverity, worstPercent,
} from './pure.js';
import {NoticeList, OutcomeLabel} from './noticeRow.js';
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
        const row = (cards, r) => ({
            ...summary, cards,
            error: r && !r.ok ? rowError(profile.name, r.message) : null,
            // The stored dates alone call a refused token "valid"; health folds
            // in what the fetch actually said, so the row stops looking fine.
            // A live token's refusal is Claude Code's to refresh, not the row's.
            health: accountHealth({
                tokenState: summary.tokenState, errorCode: r && !r.ok ? r.code : null,
                live: r?.source === 'live',
            }),
        });
        if (profile.name === active) {
            results[profile.name] = {ok: true, cards: activeCards};
            return row(activeCards, null);
        }
        if (summary.tokenState === 'expired')
            return row(null, null);
        // A parked account's stale token is refreshed here - into OUR store
        // only; accessTokenFor returns the live one untouched when this
        // account is the live login.
        const r = await usageFor(session, profile.name);
        results[profile.name] = r;
        return row(r.ok ? r.cards : null, r);
    }));
    writeUsageCache(results);
    const kept = updateWeeklyResets(results, profiles.map(p => p.name));
    for (const r of rows)
        r.weeklyResetMs = kept[r.name] ?? null;
    const worst = Object.fromEntries(
        profiles.map(p => [p.name, results[p.name]?.ok ? worstPercent(results[p.name].cards) : null]));
    return {rows, worst};
}

// The sentence each notice kind shows. Translated here rather than in the
// shared contract, which pins only WHICH notice appears and what its one
// button does (lib/pure/notices.js).
function noticeText(notice) {
    const who = notice.arg ?? '?';
    switch (notice.kind) {
    case 'pending-switch':
        return _('Incomplete switch to %s - the login may be half-installed.').format(who);
    case 'torn-login':
        return _("%s's credentials and account block disagree.").format(who);
    case 'unsaved-login':
        return _('Signed in as %s, but this login is not saved.').format(who);
    case 'login-expired':
        return _('%s: login expired - a new sign-in is the only fix.').format(who);
    case 'refresh-failed':
        return _('%s: the stored login was refused - sign in again.').format(who);
    default:
        return _('%s: no usage reading right now.').format(who);
    }
}

/** The one button on that row. `saveAs` is the name a save would use. */
function noticeButton(notice, saveAs) {
    switch (notice.action) {
    case 'finish-switch':
        return _('Finish switch');
    case 'repair':
        return _('Repair');
    case 'save':
        return _('Save as %s').format(saveAs);
    case 'relogin':
        return _('Copy sign-in command');
    default:
        return _('Retry');
    }
}

const AccountsSection = GObject.registerClass(
class AccountsSection extends St.BoxLayout {
    /**
     * @param {object} handlers
     * @param {(name: string) => void} handlers.onSwitch the row the user
     *   clicked (never the active one)
     * @param {() => void} handlers.onRotate the header's "Next" button
     * @param {(id: string) => void} handlers.onRepair a notice's one button
     * @param {(control: string) => ?object} handlers.outcomeFor the answer to
     *   show beside a given control, or null
     */
    _init({onSwitch, onRotate, onRepair, outcomeFor}) {
        super._init(vboxProps({x_expand: true, style_class: 'cu-accounts'}));
        this._onSwitch = onSwitch;
        this._onRepair = onRepair;
        this._outcomeFor = outcomeFor;

        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({
            text: _('Accounts'), style_class: 'cu-section-title', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._next = new St.Button({
            label: _('Next'), style_class: 'cu-notice-action', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._next.connect('clicked', () => onRotate());
        head.add_child(this._next);

        this._rows = vbox({x_expand: true});
        // One quiet line, only while there is a rotation to describe.
        this._rotation = new St.Label({style_class: 'cu-account-meta'});
        this._rotateOutcome = new OutcomeLabel();
        this._notices = new NoticeList();

        this.add_child(head);
        this.add_child(this._rows);
        this.add_child(this._rotation);
        this.add_child(this._rotateOutcome);
        this.add_child(this._notices);
        this.visible = false;
    }

    /**
     * Rebuild the rows, the rotation line and the notices.
     * @param {object} state
     * @param {Array<{name, email, health, cards, error}>} state.rows store order
     * @param {?string} state.activeName the saved name of the live login
     * @param {Array<object>} state.notices lib/pure/notices.js accountNotices()
     * @param {?string} state.rotationTarget where "Next" goes, null below two
     * @param {(email: ?string) => string} state.saveAs the parked name a
     *   "save" notice would use
     */
    update({rows, activeName, notices, rotationTarget, saveAs}) {
        this._rows.destroy_all_children();
        this.visible = rows.length > 0 || notices.length > 0;
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
                style_class: `cu-account-meta ${this._metaClass(row)}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            line.add_child(meta);
            // The row, then the answer to whatever was last asked OF this row -
            // beside it, not in a line at the bottom of the dropdown.
            const holder = vbox({x_expand: true});
            if (active) {
                holder.add_child(line);
            } else {
                const button = new St.Button({
                    style_class: 'cu-account-btn', x_expand: true, can_focus: true, child: line,
                });
                button.connect('clicked', () => this._onSwitch(row.name));
                holder.add_child(button);
            }
            const answer = new OutcomeLabel();
            answer.set(this._outcomeFor(`switch:${row.name}`));
            holder.add_child(answer);
            this._rows.add_child(holder);
        }

        this._next.visible = rotationTarget !== null;
        this._rotation.visible = rotationTarget !== null;
        if (rotationTarget) {
            this._rotation.text = _('Next walks %s and wraps. Up next: %s.')
                .format(rotationOrder(rows.map(r => r.name)).join(' → '), rotationTarget);
        }
        this._rotateOutcome.set(this._outcomeFor('rotate'));
        this._notices.update(
            notices.map(n => ({
                ...n, text: noticeText(n), actionLabel: noticeButton(n, saveAs(n.arg)),
            })),
            id => this._onRepair(id),
            id => this._outcomeFor(`notice:${id}`));
    }

    // What the right-hand column says: the usage figures when we have them,
    // else why there are none. Never the previous poll's figures - a row whose
    // login broke must stop looking like a row that is fine.
    _metaText(row) {
        if (row.cards?.length)
            return formatAccountUsage(row.cards, Date.now(), row.weeklyResetMs);
        // The weekly reset outlives the login: it was read while the login
        // worked and stays true until it passes.
        return [this._reason(row), formatAccountUsage([], Date.now(), row.weeklyResetMs)]
            .filter(Boolean).join(' · ');
    }

    _reason(row) {
        switch (row.health) {
        case 'expired':
            return _('(login expired)');
        case 'refresh-failed':
            return _('(refresh failed)');
        case 'unreachable':
            return row.error ?? _('(no reading)');
        default:
            return row.error ?? '';
        }
    }

    _metaClass(row) {
        if (needsAttention(row.health))
            return 'cu-critical';
        return severityClass(usageSeverity(worstPercent(row.cards)));
    }
});

// ── The flow behind the section ─────────────────────────────────────────────────

export class AccountsController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings the extension settings
     * @param {Soup.Session} deps.session for the usage + refresh calls
     * @param {PopupMenu.PopupMenu} deps.menu the dropdown; the item is
     *   appended at construction, so build in menu order
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => void} deps.refreshSoon re-poll shortly (as the new account)
     * @param {() => void} deps.onActiveChanged the panel prefix may have moved
     * @param {(state: {visible: boolean, on: boolean, title: string}) => void}
     *   deps.syncAutoSwitch paint the header's auto-switch button
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     */
    constructor({
        settings, session, menu, notify, refreshSoon, onActiveChanged,
        syncAutoSwitch, isDestroyed,
    }) {
        this._settings = settings;
        this._session = session;
        this._notify = notify;
        this._refreshSoon = refreshSoon;
        this._onActiveChanged = onActiveChanged;
        this._syncAutoSwitch = syncAutoSwitch;
        this._isDestroyed = isDestroyed;
        this._switching = false;
        /** The saved name of the live login, for the top-bar prefix. */
        this.activeName = null;
        /** How many logins are saved - the prefix is noise below two. */
        this.savedCount = 0;

        /** The answer to the last action, keyed by the control that caused it.
         *  One at a time: the previous answer is not about this action. */
        this._outcome = null;
        this._outcomeTimer = null;
        /** What the last refresh found, so a repair or the outcome timer can
         *  repaint without a poll. Everything update() draws, saveAs included. */
        this._state = {
            rows: [], activeName: null, notices: [], rotationTarget: null,
            saveAs: email => parkName(email, []),
        };

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._section = new AccountsSection({
            onSwitch: name => this.switchTo(name),
            onRotate: () => this.rotate(),
            onRepair: id => this.repair(id),
            outcomeFor: control => this._outcomeFor(control),
        });
        this._item.add_child(this._section);
        menu.addMenuItem(this._item);
        this._item.visible = false;

        this.syncToggle();
    }

    /** The header's button is a view of the setting, never its own state. */
    syncToggle() {
        const threshold = this._settings.get_int('accounts-switch-threshold');
        const on = this._settings.get_boolean('accounts-auto-switch');
        this._syncAutoSwitch({
            visible: this._showToggle(),
            on,
            // The button has no text of its own, so the title is the only
            // thing that can say which way it is set.
            title: on
                ? _('Auto-switch at %d%% · on').format(threshold)
                : _('Auto-switch at %d%% · off').format(threshold),
        });
    }

    /** Clicked in the header: the setting moves, syncToggle() repaints. */
    toggleAutoSwitch() {
        this._settings.set_boolean(
            'accounts-auto-switch', !this._settings.get_boolean('accounts-auto-switch'));
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
            this.syncToggle();
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
        const live = readLiveAccount();
        this._setActive(active, profiles.length);
        this.syncToggle();
        if (!profiles.length) {
            // Still render: "signed in but not saved" has to be reachable
            // before there is a single saved account to list it under.
            this._render({rows: [], activeName: null, live, profiles});
            return;
        }
        const {rows, worst} = await collectAccountRows(
            this._session, profiles, active, activeCards);
        if (this._isDestroyed())
            return;
        this._render({rows, activeName: active, live, profiles});

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

    /** Fold the last poll into what the section draws, and draw it. Split out
     *  so a repair can repaint without waiting for the next poll. */
    _render({rows, activeName, live, profiles}) {
        const notices = accountNotices({
            rows: rows.map(r => ({name: r.name, health: r.health})),
            liveEmail: typeof live?.emailAddress === 'string' ? live.emailAddress : null,
            activeName,
            pending: readPendingSwitch(),
            torn: activeName !== null && isTorn(profiles, activeName, live),
        });
        const names = rows.map(r => r.name);
        this._state = {
            rows, activeName, notices,
            rotationTarget: nextInRotation(names, activeName),
            saveAs: email => parkName(email, names),
        };
        this._item.visible = rows.length > 0 || notices.length > 0;
        this._paint();
    }

    /** The one path that draws the section: whatever the last _render found. */
    _paint() {
        if (!this._isDestroyed())
            this._section.update(this._state);
    }

    /** The dropdown is going away: no timer may fire into it afterwards. */
    destroy() {
        if (this._outcomeTimer) {
            GLib.Source.remove(this._outcomeTimer);
            this._outcomeTimer = null;
        }
    }

    // ── Button-local outcomes ───────────────────────────────────────────────

    _outcomeFor(control) {
        return outcomeVisible(this._outcome, Date.now()) && this._outcome.control === control
            ? this._outcome : null;
    }

    /** Record the answer to one action and repaint. It clears itself after
     *  OUTCOME_TTL_MS, and the next action replaces it. */
    _setOutcome(control, ok, text) {
        this._outcome = outcome(control, ok, text, Date.now());
        if (this._outcomeTimer)
            GLib.Source.remove(this._outcomeTimer);
        this._outcomeTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, OUTCOME_TTL_MS, () => {
                this._outcomeTimer = null;
                this._outcome = null;
                this._paint();
                return GLib.SOURCE_REMOVE;
            });
        this._paint();
    }

    /** The header's "Next": walk the saved list in order, wrapping. */
    async rotate() {
        if (this._state.rotationTarget)
            await this.switchTo(this._state.rotationTarget, null, 'rotate');
    }

    /**
     * Carry out a notice's one repair. `relogin` is the only one no client can
     * do - nothing in this repo ever runs a login - so it hands over the command.
     */
    async repair(id) {
        const notice = this._state.notices.find(n => n.id === id);
        if (!notice)
            return;
        const control = `notice:${id}`;
        switch (notice.action) {
        case 'finish-switch':
        case 'repair':
            // Re-running the switch IS the repair: switchPlan answers `repair`
            // for a torn login and finishes an interrupted one.
            await this.switchTo(notice.arg, null, control);
            break;
        case 'save':
            try {
                const saved = saveCurrent(this._state.saveAs(notice.arg));
                this._setOutcome(control, true, _('saved as %s').format(saved.name));
                this._refreshSoon();
            } catch (e) {
                this._setOutcome(control, false, e.message);
            }
            break;
        case 'relogin': {
            const command = 'claude auth login';
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);
            this._setOutcome(control, true,
                _('copied `%s` - run it, then save the login again').format(command));
            break;
        }
        default:
            this._refreshSoon();
            this._setOutcome(control, true, _('re-reading…'));
        }
    }

    /**
     * Make `name` the live login, tell the user, and poll again as that
     * account. `auto` carries the numbers when the switch was automatic;
     * `control` is the widget the answer belongs beside.
     */
    async switchTo(name, auto = null, control = null) {
        if (this._switching)
            return;
        this._switching = true;
        const where = control ?? `switch:${name}`;
        try {
            const r = await switchTo(this._session, name);
            if (this._isDestroyed())
                return;
            if (!r.changed) {
                this._setOutcome(where, true, _('%s was already the login').format(name));
                return;
            }
            let body = auto
                ? _('Switched %s → %s: %s was at %d%%').format(
                    r.from ?? '?', r.to, r.from ?? '?', auto.activePercent)
                : _('Switched %s → %s').format(r.from ?? '?', r.to);
            if (r.running > 0) {
                body += ngettext(
                    ' - %d running session keeps the old login until restarted',
                    ' - %d running sessions keep the old login until restarted',
                    r.running).format(r.running);
            }
            this._notify(_('Claude usage'), body);
            // The answer goes beside the row that asked as well: a notification
            // is easy to miss, and a manual switch deserves an acknowledgement
            // where the click happened.
            this._setOutcome(where, true, _('now on %s').format(name));
            this._refreshSoon();
        } catch (e) {
            if (this._isDestroyed())
                return;
            logError(e, 'claude-usage-panel: account switch failed');
            this._setOutcome(where, false, rowError(name, e.message));
        } finally {
            this._switching = false;
        }
    }
}
