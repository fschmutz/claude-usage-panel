// Claude Usage Panel - GNOME Shell 45-50
// Shows Claude Code plan limits (session / weekly / per-model) in the top bar
// with a designed dropdown, plus optional session cost via ccusage.
//
// This file is the poll loop and the top-level dropdown; each optional
// section (today's sessions, Cursor spend, saved accounts) is a controller in
// lib/ that owns its own menu item, and the limit card is lib/usageCard.js.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fetchUsage} from './lib/claudeUsage.js';
import {readLiveAccount} from './lib/claudeFiles.js';
import {loadWarehouse, appendWarehouse} from './lib/warehouse.js';
import {fetchActiveCost} from './lib/cost.js';
import {readLastPing, readSchedule} from './lib/sessionPing.js';
import {AccountsController} from './lib/accountsSection.js';
import {CursorController} from './lib/cursorSection.js';
import {SessionsController} from './lib/sessionsSection.js';
import {UsageCard} from './lib/usageCard.js';
import {vbox} from './lib/widgets.js';
import {
    severityClass, formatResets, alertThreshold,
    forecast, formatForecast, normalizeHistory,
    nextPollSeconds, nextResetMs, sameUsage, detectEvents, expandEventCommand,
    warehouseAccount, warehouseEntry, weekOverWeek,
    formatLastPing, nextPing, compactTokens, formatClock, panelText,
} from './lib/pure.js';

// How long to let a resume or a network change settle before polling: DNS and
// the token file are not necessarily ready the instant logind says "resumed".
const WAKE_SETTLE_SECONDS = 5;
// Timestamped samples kept per limit - enough for the forecast's 6 h regression
// window at the 10-minute default (~15 h of context). The sparkline shows the
// last 12.
const HISTORY_MAX = 90;

const ClaudeUsageButton = GObject.registerClass(
class ClaudeUsageButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Claude Usage Panel');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._httpSession = new Soup.Session({timeout: 20});
        this._httpSession.set_user_agent('claude-usage-panel/1.0');
        this._cards = new Map();
        this._timerId = 0;
        this._wakeId = 0;
        this._logindId = 0;
        // Consecutive polls in which no limit moved - drives the backoff.
        this._idleStreak = 0;
        this._latest = [];
        // 90 days of poll samples, for the week-over-week line. Loaded once;
        // every later poll that moved appends to both the file and this list.
        this._warehouse = loadWarehouse();
        /** Identity of the login the last poll ran as - what its entries are filed under. */
        this._warehouseAccount = null;
        this._refreshing = false;
        this._destroyed = false;
        this._history = this._loadHistory();  // limit id -> [[epochMs, percent], …]
        this._alertFired = new Map();  // limit id -> highest threshold already alerted
        this._paceAlerted = new Set();  // limit ids already warned about projected exhaustion
        this._forecasts = new Map();   // limit id -> latest forecast (or null)

        // Panel button: brand glyph + compact worst-limit readout.
        const box = new St.BoxLayout({style_class: 'cu-panel'});
        this._panelIcon = new St.Label({text: '✳', style_class: 'cu-panel-icon'});
        this._panelLabel = new St.Label({
            text: '…',
            style_class: 'cu-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();

        // Follow the desktop light/dark preference for the dropdown.
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._ifaceSettings.connectObject(
            'changed::color-scheme', () => this._applyTheme(), this);
        this._applyTheme();

        this._settings.connectObject(
            'changed::refresh-interval', () => this._restartTimer(),
            'changed::show-cost', () => this.refresh(),
            'changed::panel-mode', () => this._renderPanel(),
            'changed::cursor-enabled', () => this.refresh(),
            'changed::cursor-api-key', () => this.refresh(),
            'changed::cursor-key-stamp', () => this.refresh(),
            'changed::show-sessions', () => this.refresh(),
            'changed::accounts-enabled', () => this.refresh(),
            'changed::accounts-auto-switch', () => this._accounts.syncToggle(),
            'changed::accounts-switch-threshold', () => this._accounts.syncToggle(),
            'changed::accounts-menu-toggle', () => this._accounts.syncToggle(),
            'changed::panel-show-account', () => this._renderPanel(),
            this
        );

        this._watchWakeAndNetwork();
        this.refresh();
        this._restartTimer();
    }

    _buildMenu() {
        const deps = {
            settings: this._settings,
            session: this._httpSession,
            menu: this.menu,
            notify: (t, b) => Main.notify(t, b),
            isDestroyed: () => this._destroyed,
        };

        // Header: title left, plan label right.
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const titleRow = new St.BoxLayout({x_expand: true, style_class: 'cu-header'});
        titleRow.add_child(new St.Label({text: 'Claude usage', style_class: 'cu-title', x_expand: true}));
        this._planLabel = new St.Label({text: '', style_class: 'cu-plan'});
        titleRow.add_child(this._planLabel);
        header.add_child(titleRow);
        this.menu.addMenuItem(header);

        // One card per limit.
        const cardsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._cardsBox = vbox({x_expand: true, style_class: 'cu-cards'});
        cardsItem.add_child(this._cardsBox);
        this.menu.addMenuItem(cardsItem);

        // Prepaid credits, when the account has extra usage switched on. Money
        // rather than a window: no reset, no clock caret, so it gets its own
        // compact row instead of a card.
        this._extraItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const extraBox = vbox({x_expand: true, style_class: 'cu-extra'});
        extraBox.add_child(new St.Label({text: _('Extra usage'), style_class: 'cu-section-title'}));
        this._extraLine = new St.Label({text: '', style_class: 'cu-cost'});
        extraBox.add_child(this._extraLine);
        this._extraItem.add_child(extraBox);
        this.menu.addMenuItem(this._extraItem);
        this._extraItem.visible = false;

        // Status: cost line, "Updated", and the session-ping line (hidden
        // unless pings are scheduled or have ever run).
        const statusItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const statusBox = vbox({x_expand: true, style_class: 'cu-status'});
        this._costLabel = new St.Label({text: '', style_class: 'cu-cost'});
        this._updatedLabel = new St.Label({text: '', style_class: 'cu-updated'});
        this._pingLabel = new St.Label({text: '', style_class: 'cu-updated'});
        this._pingLabel.visible = false;
        statusBox.add_child(this._costLabel);
        statusBox.add_child(this._updatedLabel);
        statusBox.add_child(this._pingLabel);
        statusItem.add_child(statusBox);
        this.menu.addMenuItem(statusItem);

        // The optional sections, each owning its menu item, in menu order.
        this._sessions = new SessionsController(deps);
        this._cursor = new CursorController(deps);
        this._accounts = new AccountsController({
            ...deps,
            refreshSoon: () => this._refreshSoon(),
            onActiveChanged: () => this._renderPanel(),
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh as a St.Button (not a menu item) so clicking it refreshes
        // in place WITHOUT closing the popup.
        const refreshRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const refreshBox = new St.BoxLayout({style_class: 'cu-refresh-box'});
        refreshBox.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'popup-menu-icon',
        }));
        refreshBox.add_child(new St.Label({
            text: _('Refresh now'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const refreshBtn = new St.Button({
            style_class: 'cu-refresh-btn',
            x_expand: true,
            can_focus: true,
            child: refreshBox,
        });
        refreshBtn.connect('clicked', () => this.refresh());
        refreshRow.add_child(refreshBtn);
        this.menu.addMenuItem(refreshRow);

        const prefsItem = new PopupMenu.PopupImageMenuItem(_('Settings'), 'emblem-system-symbolic');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        const quitItem = new PopupMenu.PopupImageMenuItem(_('Quit'), 'application-exit-symbolic');
        quitItem.connect('activate', () => this._quit());
        this.menu.addMenuItem(quitItem);
    }

    // Disable the extension: unloads it now and keeps it off across logins
    // until re-enabled (gnome-extensions enable … or ./install.sh).
    _quit() {
        this.menu.close();
        try {
            Gio.Subprocess.new(
                ['gnome-extensions', 'disable', this._extension.uuid],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            logError(e, 'claude-usage-panel: failed to disable');
        }
    }

    // One-shot timer, re-armed after every poll: a fixed interval polls hardest
    // exactly when nothing is happening, and lands minutes late on the one tick
    // that matters (the reset). nextPollSeconds() decides the delay; this only
    // arms it.
    _restartTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        const delay = nextPollSeconds({
            baseSeconds: this._settings.get_int('refresh-interval'),
            idleStreak: this._idleStreak,
            nextResetMs: nextResetMs(this._latest),
            nowMs: Date.now(),
        });
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timerId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Two things that make a poll worth doing right now, whatever the timer
    // says: the machine came back from suspend (every countdown on screen is
    // stale by however long the lid was shut), and the network came back (the
    // polls during the outage all failed).
    _watchWakeAndNetwork() {
        try {
            this._logindId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    // true = about to suspend, false = just resumed.
                    if (!params.deepUnpack()[0])
                        this._refreshSoon();
                });
        } catch (e) {
            logError(e, 'claude-usage-panel: no logind resume signal');
        }
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkMonitor?.connectObject('network-changed', (_m, available) => {
            if (available)
                this._refreshSoon();
        }, this);
    }

    // Coalesce a burst of wake/network signals into one refresh a few seconds
    // later - DNS and the token file are not necessarily ready the instant
    // logind says "resumed".
    _refreshSoon() {
        if (this._wakeId)
            GLib.Source.remove(this._wakeId);
        this._wakeId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WAKE_SETTLE_SECONDS, () => {
            this._wakeId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async refresh() {
        // Skip if a refresh is already in flight (e.g. a slow ccusage call
        // straddling the next timer tick) - avoids piling up requests.
        if (this._refreshing)
            return;
        this._refreshing = true;
        try {
            const result = await fetchUsage(this._httpSession);
            if (this._destroyed)
                return;
            if (!result.ok) {
                this._renderError(result.message);
                return;
            }
            const now = Date.now();
            const moved = !sameUsage(this._latest, result.cards);
            this._idleStreak = moved ? 0 : this._idleStreak + 1;
            // Only record what moved: a flat afternoon would otherwise write
            // one identical line every poll for 90 days.
            // Filed under the live login: the file is shared by every account
            // on the machine and a peak must never come from another one.
            this._warehouseAccount = warehouseAccount(readLiveAccount());
            if (moved) {
                const entry = warehouseEntry(result.cards, now, this._warehouseAccount);
                this._warehouse.push(entry);
                appendWarehouse(entry);
            }
            this._runEventCommand(detectEvents(this._latest, result.cards));
            this._latest = result.cards;
            this._recordSamples(result.cards, now);
            this._renderCards(result.cards, now);
            this._renderExtraUsage(result.extraUsage);
            this._renderPanel();
            this._updatedLabel.text = _('Updated %s').format(formatClock(now));
            this._renderPing();
            // Plan label from the raw spend/extra hints, best-effort.
            this._planLabel.text = result.raw?.plan_label ?? '';

            await this._refreshCost();
            await this._sessions.refresh();
            await this._cursor.refresh();
            await this._accounts.refresh(result.cards);
        } finally {
            this._refreshing = false;
            // Re-arm from the numbers this poll just produced: the timer is
            // one-shot, so a missed re-arm would stop the panel dead.
            if (!this._destroyed)
                this._restartTimer();
        }
    }

    // 'est.': cost is reconstructed from local logs and a price table, while
    // the limit percentages come from the usage endpoint.
    async _refreshCost() {
        if (!this._settings.get_boolean('show-cost')) {
            this._costLabel.visible = false;
            return;
        }
        this._costLabel.visible = true;
        this._costLabel.text = _('Session cost: computing…');
        const cost = await fetchActiveCost();
        if (this._destroyed)
            return;
        this._costLabel.text = cost
            ? _('Session cost: $%s · %s tokens (est.)')
                .format(cost.costUSD.toFixed(2), compactTokens(cost.tokens))
            : _('Session cost: unavailable (install ccusage)');
    }

    // The user's own command for the two moments worth acting on: a limit
    // crossing 90/100 %, and a window rolling over. Run through bash -lc so a
    // one-liner with a pipe works, with every substituted value shell-quoted -
    // the label comes from the API.
    _runEventCommand(events) {
        if (!events.length)
            return;
        const template = this._settings.get_string('event-command').trim();
        if (!template)
            return;
        for (const event of events) {
            const command = expandEventCommand(template, event);
            try {
                Gio.Subprocess.new(['bash', '-lc', command], Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError(e, `claude-usage-panel: event command failed (${event.event})`);
            }
        }
    }

    // Prepaid credit already charged this cycle. Hidden entirely when the
    // account has extra usage off - a disabled cap is not headroom.
    _renderExtraUsage(extra) {
        this._extraItem.visible = Boolean(extra);
        if (!extra)
            return;
        this._extraLine.text = extra.limitAmount !== null
            ? _('%s (%d%% of the cap)').format(extra.detail, extra.percent)
            : extra.detail;
        this._extraLine.style_class = `cu-cost ${severityClass(extra.severity)}`;
    }

    // ── Scheduled session pings ─────────────────────────────────────────────
    // The 5 h window is anchored to its first message, so a ping at 05:30 is
    // what makes the day's windows line up with the hours worked. The schedule
    // lives in the systemd units (shared with ./install.sh sessionping); this
    // only reports what it did and what it will do next.
    _renderPing() {
        const schedule = readSchedule();
        const last = formatLastPing(readLastPing(), Date.now());
        if (!schedule.enabled && !last) {
            this._pingLabel.visible = false;
            return;
        }
        const parts = [_('last %s').format(last || _('never'))];
        if (schedule.enabled) {
            const next = nextPing(schedule.times, schedule.days, Date.now());
            if (next)
                parts.push(_('next %s').format(next));
        }
        this._pingLabel.text = _('Session pings: %s').format(parts.join(' · '));
        this._pingLabel.visible = true;
    }

    // Notify when a limit first crosses 90% or 100% (with hysteresis so a
    // fresh window can alert again after the usage drops back down).
    _checkAlerts(cards) {
        if (!this._settings.get_boolean('alerts-enabled'))
            return;
        for (const card of cards) {
            const prev = this._alertFired.get(card.key) ?? 0;
            const threshold = alertThreshold(card.percent);
            if (threshold > prev) {
                this._alertFired.set(card.key, threshold);
                const tail = card.resetsAt ? ` - ${formatResets(card.resetsAt)}` : '';
                Main.notify(_('Claude usage'),
                    _('%s reached %d%%').format(card.label, threshold) + tail);
            } else if (threshold < prev && card.percent < 85) {
                this._alertFired.set(card.key, threshold); // re-arm for the next cycle
            }

            // Predictive: warn ONCE per window when the pace first projects the
            // limit running dry at least 1 h before its reset. Re-arm only once
            // the projection clears by a 2 h margin (or goes away), so a pace
            // hovering at the edge can't ping-pong notifications.
            const fc = this._forecasts.get(card.key);
            if (fc?.exhaustsBeforeReset && fc.marginHours <= -1) {
                if (!this._paceAlerted.has(card.key)) {
                    this._paceAlerted.add(card.key);
                    Main.notify(_('Claude usage'),
                        _('%s is on pace to run out before it resets').format(card.label) +
                        ` - ${formatForecast(fc)}`);
                }
            } else if (!fc || (!fc.exhaustsBeforeReset && (fc.marginHours ?? 99) >= 2)) {
                this._paceAlerted.delete(card.key);
            }
        }
    }

    _applyTheme() {
        const dark = this._ifaceSettings.get_string('color-scheme') === 'prefer-dark';
        if (dark)
            this.menu.box.remove_style_class_name('cu-light');
        else
            this.menu.box.add_style_class_name('cu-light');
    }

    _loadHistory() {
        // Entries are [epochMs, percent] pairs; history written by versions that
        // stored bare percents migrates via normalizeHistory (sparkline keeps
        // working, the forecast simply ignores the timestampless entries).
        try {
            const obj = JSON.parse(this._settings.get_string('history'));
            return new Map(Object.entries(obj)
                .map(([k, v]) => [k, normalizeHistory(v).slice(-HISTORY_MAX)]));
        } catch {
            return new Map();
        }
    }

    _saveHistory() {
        try {
            this._settings.set_string('history',
                JSON.stringify(Object.fromEntries(this._history)));
        } catch {
            // non-fatal: sparkline history is best-effort
        }
    }

    // The bookkeeping a poll does before anything is drawn: one timestamped
    // sample per limit (sparkline + burn-rate forecast), the forecasts, and
    // the alerts they may fire. Rendering below only reads what this wrote.
    _recordSamples(cards, now) {
        for (const card of cards) {
            const hist = this._history.get(card.key) ?? [];
            hist.push([now, card.percent]);
            if (hist.length > HISTORY_MAX)
                hist.shift();
            this._history.set(card.key, hist);
            this._forecasts.set(card.key, forecast(hist, card.resetsAt, now));
        }
        this._saveHistory();
        this._checkAlerts(cards);
    }

    _renderCards(cards, now) {
        const seen = new Set();
        for (const card of cards) {
            seen.add(card.key);
            let widget = this._cards.get(card.key);
            if (!widget) {
                widget = new UsageCard();
                this._cards.set(card.key, widget);
                this._cardsBox.add_child(widget);
            }
            widget.update(card, this._history.get(card.key) ?? [], this._forecasts.get(card.key),
                weekOverWeek(this._warehouse, card.key, now, this._warehouseAccount));
        }
        // Drop cards that disappeared.
        for (const [key, widget] of this._cards) {
            if (!seen.has(key)) {
                widget.destroy();
                this._cards.delete(key);
            }
        }
    }

    _renderPanel() {
        if (!this._latest || !this._latest.length) {
            this._panelLabel.text = '…';
            return;
        }
        const mode = this._settings.get_string('panel-mode'); // 'worst' | 'session'
        let card;
        if (mode === 'session')
            card = this._latest.find(c => c.key.startsWith('session')) ?? this._latest[0];
        else
            card = [...this._latest].sort((a, b) => b.percent - a.percent)[0];

        // The saved name of the live login leads the readout, so a glance at
        // the bar says which account is being spent - but only once there is
        // more than one saved account, and only while it fits the top bar's
        // character budget (panelText decides; the dropdown always names it).
        const showAccount = this._settings.get_boolean('panel-show-account')
            && this._accounts.savedCount > 1;
        this._panelLabel.text = panelText({
            account: showAccount ? this._accounts.activeName ?? '' : '',
            label: card.label,
            percent: card.percent,
        });
        // Predictive tint: a limit reading normal but on pace to run out before
        // its reset shows amber in the top bar - trouble at 50%, not at 90%.
        let sev = severityClass(card.severity);
        if (sev === 'cu-normal' && this._forecasts.get(card.key)?.exhaustsBeforeReset)
            sev = 'cu-warning';
        this._panelLabel.style_class = `cu-panel-label ${sev}`;
        this._panelIcon.style_class = `cu-panel-icon ${sev}`;
    }

    _renderError(message) {
        this._panelLabel.text = _('Claude ?');
        this._panelLabel.style_class = 'cu-panel-label cu-warning';
        for (const [, widget] of this._cards)
            widget.destroy();
        this._cards.clear();
        this._updatedLabel.text = message;
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._wakeId) {
            GLib.Source.remove(this._wakeId);
            this._wakeId = 0;
        }
        if (this._logindId) {
            Gio.DBus.system.signal_unsubscribe(this._logindId);
            this._logindId = 0;
        }
        this._networkMonitor?.disconnectObject(this);
        this._networkMonitor = null;
        this._sessions.destroy();
        this._settings?.disconnectObject(this);
        this._ifaceSettings?.disconnectObject(this);
        this._httpSession?.abort();
        this._httpSession = null;
        super.destroy();
    }
});

export default class ClaudeUsagePanelExtension extends Extension {
    enable() {
        this._button = new ClaudeUsageButton(this);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
