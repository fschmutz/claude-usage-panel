// Claude Usage Panel - GNOME Shell 45-50
// Shows Claude Code plan limits (session / weekly / per-model) in the top bar
// with a designed dropdown, plus optional session cost via ccusage.

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
import {fetchActiveCost} from './lib/cost.js';
import {fetchCursor} from './lib/cursorUsage.js';
import {refreshSessions} from './lib/sessionIndex.js';
import {readLastPing, readSchedule} from './lib/sessionPing.js';
import {storeSecret, lookupSecret} from './lib/secretStore.js';
import {
    severityClass, sparkline, formatResets, alertThreshold, poolNote,
    forecast, formatForecast, normalizeHistory, historyPercents,
    compactTokens, formatLastPing, nextPing, interactiveResume, terminalArgv, TERMINALS,
} from './lib/pure.js';

const TRACK_WIDTH = 300; // px, must match .cu-track min-width in stylesheet.css
// Timestamped samples kept per limit - enough for the forecast's 6 h regression
// window even at the 1-minute minimum refresh interval isn't needed; at the
// 10-minute default this holds ~15 h of context. The sparkline shows the last 12.
const HISTORY_MAX = 90;
// How many of today's sessions the dropdown offers to resume.
const SESSION_ROWS = 5;
// While the index is still catching up (a cold cache, or a heavy day), retry
// sooner than the usual refresh interval instead of leaving the list short for
// ten minutes.
const SESSION_CATCHUP_SECONDS = 20;

// One limit row: label, percentage, colored progress bar, reset time.
const UsageCard = GObject.registerClass(
class UsageCard extends St.BoxLayout {
    _init() {
        super._init({vertical: true, style_class: 'cu-card', x_expand: true});

        const head = new St.BoxLayout({style_class: 'cu-card-head', x_expand: true});
        this._label = new St.Label({style_class: 'cu-card-label', x_expand: true});
        this._pct = new St.Label({style_class: 'cu-card-pct'});
        head.add_child(this._label);
        head.add_child(this._pct);

        // St.Bin centers its child by default; force START so the fill grows
        // from the left edge instead of sitting centered in the track.
        const track = new St.Bin({
            style_class: 'cu-track',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        this._fill = new St.Widget({style_class: 'cu-fill'});
        track.set_child(this._fill);

        this._reset = new St.Label({style_class: 'cu-card-reset'});
        this._forecast = new St.Label({style_class: 'cu-forecast'});
        this._spark = new St.Label({style_class: 'cu-spark'});

        this.add_child(head);
        this.add_child(track);
        this.add_child(this._reset);
        this.add_child(this._forecast);
        this.add_child(this._spark);
    }

    update(card, history, fc) {
        const sev = severityClass(card.severity);
        this._label.text = card.label + (card.active ? '  ●' : '');
        this._pct.text = `${card.percent}%`;
        this._pct.style_class = `cu-card-pct ${sev}`;
        const px = Math.round((card.percent / 100) * TRACK_WIDTH);
        this._fill.style_class = `cu-fill ${sev}`;
        this._fill.style = `width: ${px}px;`;
        // A per-model card (Fable) caps a share of the weekly pool rather than
        // adding one, so its reset line carries that note - same reset as the
        // all-models card it draws from.
        const reset = formatResets(card.resetsAt);
        const note = poolNote(card);
        this._reset.text = [reset, note].filter(s => s).join(' · ');
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
    }
});

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
        this._lastCost = null;
        this._refreshing = false;
        this._destroyed = false;
        this._history = this._loadHistory();  // limit id -> [[epochMs, percent], …]
        this._alertFired = new Map();  // limit id -> highest threshold already alerted
        this._paceAlerted = new Set();  // limit ids already warned about projected exhaustion
        this._forecasts = new Map();   // limit id -> latest forecast (or null)
        this._sessionCatchupId = 0;

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
            this
        );

        this.refresh();
        this._restartTimer();
    }

    _buildMenu() {
        // Header
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const hbox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cu-header'});
        const titleRow = new St.BoxLayout({x_expand: true});
        const title = new St.Label({text: 'Claude usage', style_class: 'cu-title', x_expand: true});
        this._planLabel = new St.Label({text: '', style_class: 'cu-plan'});
        titleRow.add_child(title);
        titleRow.add_child(this._planLabel);
        hbox.add_child(titleRow);
        header.add_child(hbox);
        this.menu.addMenuItem(header);

        // Cards container
        this._cardsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._cardsBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cu-cards'});
        this._cardsItem.add_child(this._cardsBox);
        this.menu.addMenuItem(this._cardsItem);

        // Status / cost line
        this._statusItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._statusBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cu-status'});
        this._costLabel = new St.Label({text: '', style_class: 'cu-cost'});
        this._updatedLabel = new St.Label({text: '', style_class: 'cu-updated'});
        // Scheduled session pings: when they last opened a window, and when the
        // next one is due. Hidden unless pings are scheduled or have ever run.
        this._pingLabel = new St.Label({text: '', style_class: 'cu-updated'});
        this._pingLabel.visible = false;
        this._statusBox.add_child(this._costLabel);
        this._statusBox.add_child(this._updatedLabel);
        this._statusBox.add_child(this._pingLabel);
        this._statusItem.add_child(this._statusBox);
        this.menu.addMenuItem(this._statusItem);

        // Today's sessions: the work the plan was actually spent on, biggest
        // spender first, each row a click away from being resumed in a terminal.
        // Built as buttons inside ONE non-reactive item (like Refresh below) so
        // the rows can be rebuilt on every refresh without reshuffling the menu.
        this._sessionsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._sessionsBox = new St.BoxLayout({
            vertical: true, x_expand: true, style_class: 'cu-sessions'});
        this._sessionsTitle = new St.Label({
            text: _('Today\u2019s sessions'), style_class: 'cu-section-title'});
        this._sessionsRows = new St.BoxLayout({vertical: true, x_expand: true});
        this._sessionsBox.add_child(this._sessionsTitle);
        this._sessionsBox.add_child(this._sessionsRows);
        this._sessionsItem.add_child(this._sessionsBox);
        this.menu.addMenuItem(this._sessionsItem);
        this._sessionsItem.visible = false;

        // Optional Cursor section (hidden unless enabled + key set)
        this._cursorItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const cursorBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'cu-cursor'});
        this._cursorTitle = new St.Label({text: 'Cursor', style_class: 'cu-section-title'});
        this._cursorCycle = new St.Label({text: '', style_class: 'cu-cost'});
        // Gauge bar, shown only when the team has a monthly spend limit set.
        this._cursorTrack = new St.Bin({
            style_class: 'cu-track',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        this._cursorFill = new St.Widget({style_class: 'cu-fill'});
        this._cursorTrack.set_child(this._cursorFill);
        this._cursorTrack.visible = false;
        this._cursorToday = new St.Label({text: '', style_class: 'cu-updated'});
        this._cursorTop = new St.Label({text: '', style_class: 'cu-updated'});
        cursorBox.add_child(this._cursorTitle);
        cursorBox.add_child(this._cursorCycle);
        cursorBox.add_child(this._cursorTrack);
        cursorBox.add_child(this._cursorToday);
        cursorBox.add_child(this._cursorTop);
        this._cursorItem.add_child(cursorBox);
        this.menu.addMenuItem(this._cursorItem);
        this._cursorItem.visible = false;

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

    _restartTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        const interval = Math.max(60, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
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
            this._latest = result.cards;
            this._renderCards(result.cards);
            this._renderPanel();
            this._updatedLabel.text = _('Updated %s').format(this._nowString());
            this._renderPing();

            // Plan label from the raw spend/extra hints, best-effort.
            this._planLabel.text = result.raw?.plan_label ?? '';

            if (this._settings.get_boolean('show-cost')) {
                this._costLabel.visible = true;
                this._costLabel.text = _('Session cost: computing…');
                const cost = await fetchActiveCost();
                if (this._destroyed)
                    return;
                if (cost) {
                    this._lastCost = cost;
                    // 'est.': cost is reconstructed from local logs and a price table, while
                    // the limit percentages come from the usage endpoint.
                    this._costLabel.text = _('Session cost: $%s · %s tokens (est.)')
                        .format(cost.costUSD.toFixed(2), this._compact(cost.tokens));
                } else {
                    this._costLabel.text = _('Session cost: unavailable (install ccusage)');
                }
            } else {
                this._costLabel.visible = false;
            }

            await this._refreshSessions();
            await this._refreshCursor();
        } finally {
            this._refreshing = false;
        }
    }

    // The key lives in the system keyring; the dconf slot is only the legacy
    // location and the fallback for systems without a Secret Service. A value
    // found in dconf while the keyring works is migrated in and scrubbed.
    async _cursorKey() {
        const stored = await lookupSecret('cursor-admin-api-key');
        if (stored)
            return stored;
        const legacy = this._settings.get_string('cursor-api-key');
        if (legacy && await storeSecret('cursor-admin-api-key', legacy))
            this._settings.set_string('cursor-api-key', '');
        return legacy;
    }

    async _refreshCursor() {
        const key = await this._cursorKey();
        if (this._destroyed)
            return;
        if (!this._settings.get_boolean('cursor-enabled') || !key) {
            this._cursorItem.visible = false;
            return;
        }
        this._cursorItem.visible = true;
        this._cursorCycle.text = _('Loading…');
        this._cursorToday.text = '';
        this._cursorTop.text = '';
        try {
            const c = await fetchCursor(this._httpSession, key);
            if (this._destroyed)
                return;
            if (c.percent !== null) {
                // Team has a monthly limit → show a % gauge.
                this._cursorCycle.text = _('This cycle: $%s / $%s (%d%%) · %d members')
                    .format(c.cycleUSD.toFixed(2), c.limitUSD.toFixed(0), c.percent, c.members);
                const sev = c.percent >= 100 ? 'cu-critical'
                    : (c.percent >= 90 ? 'cu-warning' : 'cu-normal');
                this._cursorFill.style_class = `cu-fill ${sev}`;
                this._cursorFill.style = `width: ${Math.round((c.percent / 100) * TRACK_WIDTH)}px;`;
                this._cursorTrack.visible = true;
            } else {
                this._cursorCycle.text = _('This cycle: $%s · %d members')
                    .format(c.cycleUSD.toFixed(2), c.members);
                this._cursorTrack.visible = false;
            }
            this._cursorToday.text = c.todayUSD === null
                ? '' : _('Today: $%s').format(c.todayUSD.toFixed(2));
            this._cursorTop.text = c.topSpender
                ? _('Top: %s $%s').format(c.topSpender.email, c.topSpender.usd.toFixed(2)) : '';
        } catch (e) {
            if (this._destroyed)
                return;
            this._cursorCycle.text = _('Cursor: %s').format(e.message);
            this._cursorTrack.visible = false;
            this._cursorToday.text = '';
            this._cursorTop.text = '';
        }
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

    // ── Today's sessions ────────────────────────────────────────────────────
    async _refreshSessions() {
        this._cancelSessionCatchup();
        if (!this._settings.get_boolean('show-sessions')) {
            this._sessionsItem.visible = false;
            return;
        }
        try {
            const {sessions, pending} = await refreshSessions({limit: SESSION_ROWS});
            if (this._destroyed)
                return;
            this._renderSessions(sessions, pending);
            if (pending)
                this._scheduleSessionCatchup();
        } catch (e) {
            logError(e, 'claude-usage-panel: session scan failed');
            this._sessionsItem.visible = false;
        }
    }

    _scheduleSessionCatchup() {
        this._sessionCatchupId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, SESSION_CATCHUP_SECONDS, () => {
                this._sessionCatchupId = 0;
                this._refreshSessions();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelSessionCatchup() {
        if (this._sessionCatchupId) {
            GLib.Source.remove(this._sessionCatchupId);
            this._sessionCatchupId = 0;
        }
    }

    _renderSessions(sessions, pending) {
        this._sessionsRows.destroy_all_children();
        this._sessionsItem.visible = sessions.length > 0;
        if (!sessions.length)
            return;
        // "est." for the same reason the cost line carries it: these tokens are
        // reconstructed from the local transcripts, not reported by the API.
        this._sessionsTitle.text = pending
            ? _('Today\u2019s sessions (est., still indexing)')
            : _('Today\u2019s sessions (est.)');
        for (const session of sessions) {
            const row = new St.BoxLayout({style_class: 'cu-session-row', x_expand: true});
            row.add_child(new St.Label({
                text: session.label,
                style_class: 'cu-session-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                text: `${compactTokens(session.tokens)}  ${session.when}`,
                style_class: 'cu-session-meta',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                style_class: 'cu-session-btn',
                x_expand: true,
                can_focus: true,
                child: row,
            });
            button.connect('clicked', () => this._openSession(session));
            this._sessionsRows.add_child(button);
        }
    }

    // The terminal to open: the explicit setting first, then $TERMINAL, then
    // the first emulator we know how to drive that is actually installed.
    _detectTerminal() {
        const configured = this._settings.get_string('terminal-command').trim();
        if (configured)
            return configured;
        const env = GLib.getenv('TERMINAL');
        if (env && GLib.find_program_in_path(env))
            return env;
        for (const term of TERMINALS) {
            if (GLib.find_program_in_path(term.bin))
                return term.bin;
        }
        return null;
    }

    _openSession(session) {
        const bin = this._detectTerminal();
        if (!bin) {
            Main.notify(_('Claude usage'),
                _('No terminal found - set one in the extension preferences.'));
            return;
        }
        const argv = terminalArgv(bin, session.cwd, interactiveResume(session));
        this.menu.close();
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'claude-usage-panel: could not open a terminal');
            Main.notify(_('Claude usage'), _('Could not open %s').format(bin));
        }
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

    _renderCards(cards) {
        const now = Date.now();
        const seen = new Set();
        for (const card of cards) {
            seen.add(card.key);
            // append a timestamped sample (sparkline + burn-rate forecast)
            const hist = this._history.get(card.key) ?? [];
            hist.push([now, card.percent]);
            if (hist.length > HISTORY_MAX)
                hist.shift();
            this._history.set(card.key, hist);
            this._forecasts.set(card.key, forecast(hist, card.resetsAt, now));
        }
        this._saveHistory();
        this._checkAlerts(cards);
        for (const card of cards) {
            const hist = this._history.get(card.key) ?? [];

            let widget = this._cards.get(card.key);
            if (!widget) {
                widget = new UsageCard();
                this._cards.set(card.key, widget);
                this._cardsBox.add_child(widget);
            }
            widget.update(card, hist, this._forecasts.get(card.key));
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

        const shortLabel = card.label.split('·').pop().trim();
        this._panelLabel.text = `${shortLabel} ${card.percent}%`;
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

    _compact(n) {
        if (n >= 1_000_000)
            return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000)
            return `${Math.round(n / 1_000)}k`;
        return String(n);
    }

    _nowString() {
        const now = GLib.DateTime.new_now_local();
        return now.format('%H:%M');
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._cancelSessionCatchup();
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
