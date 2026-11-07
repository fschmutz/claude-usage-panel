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
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fetchUsage} from './lib/claudeUsage.js';
import {PanelGauge} from './lib/panelGauge.js';
import {readLiveAccount, readLiveCredentials} from './lib/claudeFiles.js';
import {loadWarehouse, appendWarehouse} from './lib/warehouse.js';
import {AccountsController} from './lib/accountsSection.js';
import {AwakeController} from './lib/awakeSection.js';
import {SampleHistory} from './lib/samples.js';
import {CodexController} from './lib/codexSection.js';
import {CursorController} from './lib/cursorSection.js';
import {SessionGroup} from './lib/sessionGroup.js';
import {UsageCard} from './lib/usageCard.js';
import {HeaderBar} from './lib/headerBar.js';
import {hideTooltip, destroyTooltip} from './lib/tooltip.js';
import {watchWakeAndNetwork} from './lib/wakeWatch.js';
import {exportFocusService} from './lib/focusService.js';
import {vbox} from './lib/widgets.js';
import {writeTextAsync} from './lib/fs.js';
import {stateDir} from './lib/paths.js';
import {SavedSessionsController} from './lib/savedSessions.js';
import {ExtraUsageSection, StatusSection} from './lib/statusSection.js';
import {
    panelGauge, refreshSections, isRetryableFailure,
    nextPollSeconds, nextResetMs, sameUsage, detectEvents, eventEnv, expandEventCommand,
    warehouseAccount, warehouseEntry, weekOverWeek, planLabel,
    formatClock, panelCard, panelText, popupWidth, usageReading,
    shownCards,
} from './lib/pure.js';

// How long to let a resume or a network change settle before polling: DNS and
// the token file are not necessarily ready the instant logind says "resumed".
const WAKE_SETTLE_SECONDS = 5;

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
        // Consecutive polls in which no limit moved - drives the backoff.
        this._idleStreak = 0;
        this._latest = [];
        // 90 days of poll samples, for the week-over-week line, loaded without
        // blocking the enable: the line stays empty until it lands. Every
        // poll that moved appends to this list at once and to the file once
        // the load has read it (so an early poll is never counted twice).
        this._warehouse = [];
        this._warehouseLoaded = loadWarehouse().then(kept => {
            this._warehouse = [...kept, ...this._warehouse];
            if (!this._destroyed)
                this._rerender();
        });
        /** Identity of the login the last poll ran as - what its entries are filed under. */
        this._warehouseAccount = null;
        /** The live login this poll read: {creds, account}. */
        this._live = {creds: null, account: null};
        /** The last poll failed retryably - retry soon, not next interval. */
        this._retry = false;
        /** Retryable failures in a row (backs the retry off), and the last one's Retry-After. */
        this._retryStreak = 0;
        this._retryAfter = null;
        this._refreshing = false;
        this._destroyed = false;
        // The sample history, the forecasts and the alert latches.
        this._samples = new SampleHistory({
            settings: this._settings, notify: (t, b) => Main.notify(t, b)});

        // Panel button: the live gauge + compact worst-limit readout.
        const box = new St.BoxLayout({style_class: 'cu-panel'});
        this._panelGauge = new PanelGauge();
        this._panelLabel = new St.Label({
            text: '…',
            style_class: 'cu-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelGauge);
        this._panelWait = new St.Label({
            text: '',
            style_class: 'cu-panel-wait',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._panelWait);
        // "1:04:12" while this machine is being held awake, so a glance at the
        // bar says the laptop will not drop off mid-run.
        this._panelAwake = new St.Label({
            text: '',
            style_class: 'cu-panel-awake',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._panelAwake);
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
                this._saved.sync();
            } else {
                hideTooltip();
            }
        }, this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._applyWidth(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._applyWidth(), this);
        this._applyWidth();

        // Which part of the button each setting redraws.
        const poll = () => this.refresh();
        const panel = () => this._renderPanel();
        const cards = () => this._rerender();
        const toggle = () => this._accounts.syncToggle();
        const onChange = {
            'refresh-interval': () => this._restartTimer(),
            'show-cost': poll, 'cursor-enabled': poll, 'cursor-api-key': poll, 'cursor-key-stamp': poll,
            'show-sessions': poll, 'accounts-enabled': poll, 'waiting-enabled': poll, 'pause-enabled': poll,
            'awake-enabled': poll,
            'panel-mode': panel, 'panel-show-account': panel,
            'show-model-limits': cards, 'compact-cards': cards,
            'sessions-layout': () => this._sessionGroup.render(),
            'accounts-auto-switch': toggle, 'accounts-switch-threshold': toggle, 'accounts-menu-toggle': toggle,
        };
        for (const [key, handler] of Object.entries(onChange))
            this._settings.connectObject(`changed::${key}`, handler, this);

        this._unwatchWake = watchWakeAndNetwork(() => this._refreshSoon());
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
            onReopen: () => this._saved.reopen(),
            onSaveSessions: () => this._saved.save(),
            onSettings: () => {
                this.menu.close();
                this._extension.openPreferences();
            },
            onAutoSwitch: () => this._accounts.toggleAutoSwitch(),
            onQuit: () => this._quit(),
        });
        header.add_child(this._header);
        this.menu.addMenuItem(header);
        this._saved = new SavedSessionsController({
            header: this._header, menu: this.menu, isDestroyed: deps.isDestroyed});

        // One card per limit.
        const cardsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._cardsBox = vbox({x_expand: true, style_class: 'cu-cards'});
        cardsItem.add_child(this._cardsBox);
        this.menu.addMenuItem(cardsItem);

        // Prepaid credits, then the status block (cost, "Updated", pings).
        this._extra = new ExtraUsageSection(this.menu);
        this._status = new StatusSection(deps);

        // Waiting on you, Pause / resume, Today's sessions and the board that
        // shows them merged or tabbed, first: a permission prompt outranks
        // today's spend ranking.
        this._sessionGroup = new SessionGroup({
            ...deps,
            setBadge: n => {
                this._panelWait.text = n ? String(n) : '';
                this._panelWait.visible = n > 0;
            },
        });
        // Awake sits right under the session sections it exists for: what is
        // keeping the machine up is only interesting next to what is running.
        this._awake = new AwakeController({
            ...deps,
            setBadge: badge => {
                this._panelAwake.text = badge;
                this._panelAwake.visible = Boolean(badge);
            },
        });
        this._cursor = new CursorController(deps);
        this._accounts = new AccountsController({
            ...deps,
            refreshSoon: () => this._refreshSoon(),
            onActiveChanged: () => this._renderPanel(),
            syncAutoSwitch: state => this._header.syncAutoSwitch(state),
        });
        // Codex last, and only when asked for: this extension is Claude-first,
        // and a sibling vault does not get to reorder the dropdown.
        this._codex = new CodexController(deps);
    }

    // Quit: the panel goes away for the rest of this login only.
    _quit() {
        this.menu.close();
        this._extension.quitUntilLogout();
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
            retryStreak: this._retryStreak,
            retryAfterSeconds: this._retryAfter,
        });
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timerId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
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
            // The live login, read once per poll and without blocking: the
            // usage fetch, the plan label, the warehouse key and the accounts
            // section all answer from it.
            const [creds, account] = await Promise.all([readLiveCredentials(), readLiveAccount()]);
            this._live = {creds, account};
            const result = await fetchUsage(this._httpSession, creds?.claudeAiOauth.accessToken ?? null);
            if (this._destroyed)
                return;
            this._retry = isRetryableFailure(result);
            this._retryStreak = this._retry ? this._retryStreak + 1 : 0;
            this._retryAfter = this._retry ? result.retryAfterSeconds ?? null : null;
            if (result.ok) {
                this._renderUsage(result);
            } else if (this._retry && this._latest.length) {
                // A "not now" answer (424, 429, 5xx) or a dropped connection
                // keeps the last good cards up and says so under them; only a
                // real failure blanks them. Redrawn all the same: a window
                // that reset during the outage must turn to `–` now, not at
                // the next success.
                this._renderCards(this._latest, Date.now());
                this._renderPanel();
                this._status.updatedText = _('%s - retrying, showing the last reading').format(result.message);
            } else {
                this._renderError(result.message);
            }

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
        this._warehouseAccount = warehouseAccount(this._live.account);
        if (moved) {
            const entry = warehouseEntry(result.cards, now, this._warehouseAccount);
            this._warehouse.push(entry);
            this._warehouseWrite = this._warehouseLoaded.then(() => appendWarehouse(entry));
        }
        this._runEventCommand(detectEvents(this._latest, result.cards));
        this._latest = result.cards;
        this._samples.record(result.cards, now);
        this._renderCards(result.cards, now);
        this._extra.update(result.extraUsage);
        this._renderPanel();
        this._status.updatedText = _('Updated %s').format(formatClock(now));
        this._status.renderPing().catch(e => logError(e, 'claude-usage-panel: could not read the ping schedule'));
        // The usage endpoint names no plan; the live login's credentials do.
        this._header.setPlan(planLabel(this._live.creds?.claudeAiOauth));
    }

    // Each section is bounded by refreshSections' deadline, so a hung child
    // process (a stalled `ccusage`) costs one section one poll instead of
    // stopping every poll after it.
    async _refreshSections(result) {
        const outcomes = await refreshSections({
            cost: () => this._status.refreshCost(),
            waiting: () => this._sessionGroup.read('waiting'),
            pause: () => this._sessionGroup.read('pause'),
            sessions: () => this._sessionGroup.read('today'),
            awake: () => this._awake.refresh(),
            cursor: () => this._cursor.refresh(),
            accounts: cards => this._accounts.refresh(cards, this._live),
            codex: () => this._codex.refresh(),
        }, {result, latest: this._latest});
        // the session sections draw once, after all three reads
        this._sessionGroup.render();
        for (const {section, outcome, error} of outcomes) {
            if (outcome === 'failed')
                logError(error, `claude-usage-panel: the ${section} section failed to refresh`);
            else if (outcome === 'timeout')
                console.warn(`claude-usage-panel: the ${section} section is still refreshing, polling on`);
        }
    }

    // The user's own command for the two moments worth acting on: a limit
    // crossing 90/100 %, and a window rolling over. Run through bash -lc so a
    // one-liner with a pipe works; the values travel as CUP_* environment
    // variables the expanded template references - the label comes from the
    // API and must never become command text.
    _runEventCommand(events) {
        if (!events.length)
            return;
        const template = this._settings.get_string('event-command').trim();
        if (!template)
            return;
        for (const event of events) {
            const command = expandEventCommand(template, event);
            try {
                const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
                for (const [name, value] of Object.entries(eventEnv(event)))
                    launcher.setenv(name, value, true);
                launcher.spawnv(['bash', '-lc', command]);
            } catch (e) {
                logError(e, `claude-usage-panel: event command failed (${event.event})`);
            }
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

    // The cards the dropdown lists and the top bar ranks (shownCards):
    // per-model limits only while the user wants them.
    _shown(cards) {
        return shownCards(cards, this._settings.get_boolean('show-model-limits'));
    }

    _rerender() {
        if (!this._latest?.length)
            return;
        this._renderCards(this._latest, Date.now());
        this._renderPanel();
    }

    _renderCards(cards, now) {
        const seen = new Set();
        const compact = this._settings.get_boolean('compact-cards');
        for (const card of this._shown(cards)) {
            seen.add(card.key);
            let widget = this._cards.get(card.key);
            if (!widget) {
                widget = new UsageCard();
                this._cards.set(card.key, widget);
                this._cardsBox.add_child(widget);
            }
            widget.setCompact(compact);
            widget.update(card, this._samples.history(card.key), this._samples.forecasts.get(card.key),
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
        // 'worst' | 'session'; panelCard ranks on the honest reading, so a
        // just-reset window's stale 96% never parks in the top bar.
        const now = Date.now();
        const card = panelCard(this._shown(this._latest), this._settings.get_string('panel-mode'), now);
        const reading = usageReading(card, now);

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
            known: reading.known,
        });
        // The gauge fills to the reading; its tone (the severity, lifted to
        // warning by a forecast that runs dry before the reset) also tints
        // the label - trouble at 50%, not at 90%.
        const gauge = panelGauge(reading, card.severity,
            this._samples.forecasts.get(card.key)?.exhaustsBeforeReset === true);
        this._panelGauge.update(gauge);
        this._panelLabel.style_class = `cu-panel-label cu-${gauge.tone}`;
    }

    _renderError(message) {
        this._panelLabel.text = _('Claude ?');
        this._panelLabel.style_class = 'cu-panel-label cu-warning';
        // A full arc in the warning tone, on purpose: the old glyph turned
        // amber on a failed poll, and an empty track next to "Claude ?" would
        // read as "nothing to show" rather than "something is wrong".
        this._panelGauge.update({fraction: 1, tone: 'warning'});
        for (const [, widget] of this._cards)
            widget.destroy();
        this._cards.clear();
        this._status.updatedText = message;
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
        this._unwatchWake?.();
        this._unwatchWake = null;
        this._sessionGroup.destroy();
        this._awake.destroy();
        this._accounts.destroy();
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
        // claudectl session focus raises a terminal window through this
        this._unexportFocus = exportFocusService();
        if (this._quitThisLogin)
            return;
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
        writeTextAsync(GLib.build_filenamev([stateDir(), 'loaded-version']),
            `${this.metadata['version-name'] ?? ''}\n`).catch(() => {
            // a read-only state dir is not a reason to fail the enable
        });
    }

    // Quit from the dropdown. Never `gnome-extensions disable`: that persists
    // across logins, so a Quit clicked to reload after an update left the
    // panel off for good with nothing on screen saying why. The flag lives on
    // this object, which the shell keeps until logout.
    quitUntilLogout() {
        this._quitThisLogin = true;
        // Not from inside the button's own menu callback.
        this._quitId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._quitId = 0;
            this._destroyButton();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        // The screen lock disables every extension and the unlock re-enables
        // it: a Quit survives that. Any other disable (the Extensions app,
        // gnome-extensions) clears it, so the next enable shows the panel.
        if (!Main.sessionMode.isLocked)
            this._quitThisLogin = false;
        if (this._quitId) {
            GLib.Source.remove(this._quitId);
            this._quitId = 0;
        }
        this._unexportFocus?.();
        this._unexportFocus = null;
        this._destroyButton();
    }

    _destroyButton() {
        this._button?.destroy();
        this._button = null;
    }
}
