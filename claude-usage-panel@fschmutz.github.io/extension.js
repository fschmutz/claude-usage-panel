// Claude Usage Panel - GNOME Shell 45-51
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
import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fetchUsage} from './lib/claudeUsage.js';
import {readLiveAccount, readLiveCredentials} from './lib/claudeFiles.js';
import {loadWarehouse, appendWarehouse} from './lib/warehouse.js';
import {fetchActiveCost} from './lib/cost.js';
import {readLastPing, readSchedule} from './lib/sessionPing.js';
import {AccountsController} from './lib/accountsSection.js';
import {CursorController} from './lib/cursorSection.js';
import {SessionsController} from './lib/sessionsSection.js';
import {UsageCard} from './lib/usageCard.js';
import {HeaderBar} from './lib/headerBar.js';
import {hideTooltip, destroyTooltip} from './lib/tooltip.js';
import {vbox} from './lib/widgets.js';
import {writeText} from './lib/fs.js';
import {run} from './lib/proc.js';
import {stateDir} from './lib/paths.js';
import {readSnapshots, claudectlPath} from './lib/snapshots.js';
import {
    severityClass, formatResets, latchCrossings, latchPaceAlerts, refreshSections,
    forecast, formatForecast, normalizeHistory,
    nextPollSeconds, nextResetMs, sameUsage, detectEvents, expandEventCommand,
    warehouseAccount, warehouseEntry, weekOverWeek, planLabel,
    formatLastPing, nextPing, compactTokens, formatClock, panelText, popupWidth,
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
        /** The last poll failed with a "not now" status - retry soon, not next interval. */
        this._retry = false;
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

        // Fit the screen the panel is actually on: re-measured when the menu
        // opens, when monitors change and when the scale factor moves (moving
        // the laptop between a HiDPI panel and an external 1080p one does all
        // three).
        this._menuWidth = 0;
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open) {
                this._applyWidth();
                this._syncReopen();
            } else {
                hideTooltip();
            }
        }, this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._applyWidth(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._applyWidth(), this);
        this._applyWidth();

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

        // Header: title left, plan label, then the controls as icon buttons.
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._header = new HeaderBar({
            // Refresh is a plain button, not a menu item, so the poll happens
            // in place WITHOUT closing the popup.
            onRefresh: () => this.refresh(),
            onReopen: () => this._reopenSessions(),
            onSettings: () => {
                this.menu.close();
                this._extension.openPreferences();
            },
            onAutoSwitch: () => this._accounts.toggleAutoSwitch(),
            onQuit: () => this._quit(),
        });
        header.add_child(this._header);
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
            syncAutoSwitch: state => this._header.syncAutoSwitch(state),
        });
    }

    // The reopen button offers exactly one thing - the newest snapshot - and
    // only when there is one. The store is written by `claudectl session` and
    // by the 30-minute autosave, both outside this process, so it is re-read
    // every time the menu opens rather than cached.
    _syncReopen() {
        const {newest} = readSnapshots();
        const visible = Boolean(claudectlPath() && newest);
        this._header.syncReopen({
            visible,
            title: visible
                ? ngettext('Reopen %s (%d session)', 'Reopen %s (%d sessions)', newest.sessions.length)
                    .format(newest.label, newest.sessions.length)
                : '',
        });
    }

    // `claudectl session open` with no argument: the newest snapshot, one tab
    // per session. It skips a session that is still running, so pressing this
    // after a crash reopens what died and leaves what survived alone.
    _reopenSessions() {
        const cli = claudectlPath();
        if (!cli)
            return;
        this.menu.close();
        run([cli, 'session', 'open']).then(({ok, stdout, stderr}) => {
            if (this._destroyed)
                return;
            // The CLI's last line says what it opened, or why it opened nothing.
            const lines = `${stdout}${stderr}`.trim().split('\n');
            Main.notify(
                ok ? _('Reopened your sessions') : _('Could not reopen the sessions'),
                lines[lines.length - 1] || '');
        });
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
            retry: this._retry,
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
            this._retry = !result.ok && result.code === 'transient';
            if (result.ok)
                this._renderUsage(result);
            // A "not now" answer (424, 429, 5xx) keeps the last good cards
            // up and says so under them; only a real failure blanks them.
            else if (this._retry && this._latest.length)
                this._updatedLabel.text = _('%s - retrying, showing the last reading').format(result.message);
            else
                this._renderError(result.message);

            // After a failed poll too: none of these needs the Claude token,
            // and the account switcher is the fix for an expired login.
            await this._refreshSections(result);
        } finally {
            this._refreshing = false;
            // Re-arm from the numbers this poll just produced: the timer is
            // one-shot, so a missed re-arm would stop the panel dead.
            if (!this._destroyed)
                this._restartTimer();
        }
    }

    _renderUsage(result) {
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
        // The usage endpoint names no plan; the live login's credentials do.
        this._header.setPlan(planLabel(readLiveCredentials()?.claudeAiOauth));
    }

    // Each section is bounded by refreshSections' deadline, so a hung child
    // process (a stalled `ccusage`) costs one section one poll instead of
    // stopping every poll after it.
    async _refreshSections(result) {
        const outcomes = await refreshSections({
            cost: () => this._refreshCost(),
            sessions: () => this._sessions.refresh(),
            cursor: () => this._cursor.refresh(),
            accounts: cards => this._accounts.refresh(cards),
        }, {result, latest: this._latest});
        for (const {section, outcome, error} of outcomes) {
            if (outcome === 'failed')
                logError(error, `claude-usage-panel: the ${section} section failed to refresh`);
            else if (outcome === 'timeout')
                console.warn(`claude-usage-panel: the ${section} section is still refreshing, polling on`);
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

    // Notify when a limit first crosses 90% or 100%, and once per window when
    // the pace projects it running dry at least 1 h before its reset. The
    // latches (lib/pure/events.js) hold the hysteresis; this only notifies.
    _checkAlerts(cards) {
        if (!this._settings.get_boolean('alerts-enabled'))
            return;
        for (const {card, threshold} of latchCrossings(this._alertFired, cards)) {
            const tail = card.resetsAt ? ` - ${formatResets(card.resetsAt)}` : '';
            Main.notify(_('Claude usage'),
                _('%s reached %d%%').format(card.label, threshold) + tail);
        }
        for (const {card, forecast: fc} of latchPaceAlerts(this._paceAlerted, cards, this._forecasts)) {
            Main.notify(_('Claude usage'),
                _('%s is on pace to run out before it resets').format(card.label) +
                ` - ${formatForecast(fc)}`);
        }
    }

    // The dropdown takes a share of the monitor rather than a fixed width, so
    // a long reset line wraps instead of stretching the popup past its own
    // progress bars - which is what made a percentage read against a different
    // track length on every card.
    _applyWidth() {
        const monitor = Main.layoutManager.findMonitorForActor(this)
            ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const width = popupWidth(monitor.width, scale);
        if (width === this._menuWidth)
            return;
        this._menuWidth = width;
        this.menu.box.style = `width: ${width}px;`;
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
        this.menu?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        destroyTooltip();
        this._httpSession?.abort();
        this._httpSession = null;
        super.destroy();
    }
});

export default class ClaudeUsagePanelExtension extends Extension {
    enable() {
        this._button = new ClaudeUsageButton(this);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
        this._stampLoadedVersion();
    }

    // What the RUNNING shell loaded, as opposed to what is on disk. An update
    // replaces the extension directory, but GNOME Shell keeps the code it
    // already loaded until the next login - so every surface reported the new
    // version as installed while the old one was still running. This is the
    // only place that knows the difference; auto-update.sh --status compares
    // it with the installed version and reports reloadNeeded.
    _stampLoadedVersion() {
        try {
            writeText(GLib.build_filenamev([stateDir(), 'loaded-version']),
                `${this.metadata['version-name'] ?? ''}\n`);
        } catch {
            // a read-only state dir is not a reason to fail the enable
        }
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
