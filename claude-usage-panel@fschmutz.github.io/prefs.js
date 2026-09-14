import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {storeSecret, lookupSecret} from './lib/secretStore.js';
import {
    accountSummary, formatLastPing, evaluateWindows, isValidName, parseHHMM, planWindows,
} from './lib/pure.js';
import {
    listProfiles, liveAccountName, readLiveAccount, removeProfile, saveCurrent,
} from './lib/accounts.js';
import {run} from './lib/proc.js';
import {isValidPingTime, normalizePingTime} from './lib/sessionPingUnit.js';
import {applySchedule, hasSystemd, readLastPing, readSchedule} from './lib/sessionPing.js';

// One group per concern, each a method below. Every async continuation that
// touches a widget checks `this._cancellable` first: the window can be closed
// while a keyring lookup, a systemctl call or a git fetch is still running,
// and writing to a disposed widget is a GJS error per callback.
export default class ClaudeUsagePanelPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        window.connect('close-request', () => {
            this._cancellable.cancel();
            return false;
        });

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'utilities-system-monitor-symbolic',
        });
        page.add(this._buildBehavior(settings));
        page.add(this._buildCost(settings));
        page.add(this._buildCursor(settings));
        this._buildAccountsGroups(settings, page);
        page.add(this._buildSessions(settings));
        this._buildPings(settings, page);
        page.add(this._buildUpdates());
        window.add(page);
    }

    // True once the window is gone: the continuation must not touch widgets.
    _closed() {
        return this._cancellable.is_cancelled();
    }

    _buildBehavior(settings) {
        const behavior = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('How often to poll the Claude usage endpoint.'),
        });

        // Refresh interval (minutes, mapped to seconds in the setting).
        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _(
                'Minutes between updates (min 1). Idle windows back off to 15 minutes, ' +
                'and a poll always lands just after a reset, on wake and when the ' +
                'network returns.'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        intervalRow.set_value(Math.max(1, Math.round(settings.get_int('refresh-interval') / 60)));
        intervalRow.connect('notify::value', row =>
            settings.set_int('refresh-interval', Math.round(row.get_value()) * 60));
        behavior.add(intervalRow);

        // Panel display mode.
        const modeRow = new Adw.ComboRow({
            title: _('Top bar shows'),
            subtitle: _('Which limit to display in the panel'),
            model: Gtk.StringList.new([_('Worst limit'), _('Current session')]),
        });
        modeRow.set_selected(settings.get_string('panel-mode') === 'session' ? 1 : 0);
        modeRow.connect('notify::selected', row =>
            settings.set_string('panel-mode', row.get_selected() === 1 ? 'session' : 'worst'));
        behavior.add(modeRow);

        const alertsRow = new Adw.SwitchRow({
            title: _('Limit-crossing alerts'),
            subtitle: _('Notify when a limit reaches 90% or 100%'),
        });
        settings.bind('alerts-enabled', alertsRow, 'active', 0);
        behavior.add(alertsRow);

        // Run something of your own at the two moments worth acting on. Values
        // are shell-quoted when substituted, so a label from the API cannot
        // turn into part of the command.
        const commandRow = new Adw.EntryRow({
            title: _('Run on limit crossing or reset'),
        });
        commandRow.set_show_apply_button(true);
        commandRow.set_text(settings.get_string('event-command'));
        commandRow.connect('apply', row =>
            settings.set_string('event-command', row.get_text().trim()));
        behavior.add(commandRow);

        const commandHelp = new Adw.ActionRow({
            title: _('Placeholders'),
            subtitle: _(
                '%e event (threshold or reset) · %l label · %p percent · ' +
                '%t threshold · %k key · %% a literal %. Empty disables it. ' +
                'Example: notify-send "Claude %l" "%e at %p%%"'),
        });
        commandHelp.add_css_class('dim-label');
        behavior.add(commandHelp);
        return behavior;
    }

    _buildCost(settings) {
        const cost = new Adw.PreferencesGroup({
            title: _('Cost'),
            description: _('The official API does not expose dollar cost on subscription plans. Enable this to compute it locally with ccusage (requires Node/npx).'),
        });
        const costRow = new Adw.SwitchRow({
            title: _('Show session cost'),
            subtitle: _('Runs `ccusage blocks --active` on each refresh'),
        });
        settings.bind('show-cost', costRow, 'active', 0);
        cost.add(costRow);
        return cost;
    }

    _buildCursor(settings) {
        const cursor = new Adw.PreferencesGroup({
            title: _('Cursor (optional)'),
            description: _('Show Cursor team spend using the Cursor Admin API. Create a key at cursor.com → team → Settings → Admin API. Stored in the system keyring.'),
        });
        const cursorRow = new Adw.SwitchRow({
            title: _('Show Cursor usage'),
            subtitle: _('Adds a Cursor spend section to the dropdown'),
        });
        settings.bind('cursor-enabled', cursorRow, 'active', 0);
        cursor.add(cursorRow);

        // The key lives in the system keyring (libsecret). The dconf slot is
        // only a legacy source (migrated by the extension) and a fallback for
        // systems without a Secret Service. Stored on Apply (or Enter), not per
        // keystroke: each store is a keyring write plus an extension poll.
        const keyRow = new Adw.PasswordEntryRow({title: _('Cursor Admin API key')});
        keyRow.set_show_apply_button(true);
        lookupSecret('cursor-admin-api-key').then(stored => {
            if (this._closed())
                return;
            keyRow.text = stored ?? settings.get_string('cursor-api-key');
        });
        keyRow.connect('apply', row => {
            storeSecret('cursor-admin-api-key', row.text).then(ok => {
                if (ok) {
                    // Scrub any legacy cleartext copy and nudge the running
                    // extension (the stamp carries no secret).
                    if (settings.get_string('cursor-api-key'))
                        settings.set_string('cursor-api-key', '');
                    settings.set_string('cursor-key-stamp', String(Date.now()));
                } else {
                    // No Secret Service on this system: keep the old dconf
                    // path so the feature still works.
                    settings.set_string('cursor-api-key', row.text);
                }
            });
        });
        cursor.add(keyRow);
        return cursor;
    }

    _buildSessions(settings) {
        const sessions = new Adw.PreferencesGroup({
            title: _('Today’s sessions'),
            description: _('List the sessions that spent the most tokens today, biggest first, and resume one in a terminal with a click. Read from the local transcripts in ~/.claude/projects.'),
        });
        const sessionsRow = new Adw.SwitchRow({
            title: _('Show today’s sessions'),
            subtitle: _('Adds up to 5 resume links to the dropdown'),
        });
        settings.bind('show-sessions', sessionsRow, 'active', 0);
        sessions.add(sessionsRow);

        const terminalRow = new Adw.EntryRow({title: _('Terminal')});
        terminalRow.set_show_apply_button(true);
        terminalRow.text = settings.get_string('terminal-command');
        terminalRow.connect('apply', row =>
            settings.set_string('terminal-command', row.text.trim()));
        sessions.add(terminalRow);
        const terminalHint = new Adw.ActionRow({
            subtitle: _('Leave empty to autodetect: $TERMINAL, then ghostty, kitty, wezterm, alacritty, foot, gnome-terminal, konsole, tilix, xfce4-terminal, xterm.'),
            sensitive: false,
        });
        sessions.add(terminalHint);
        return sessions;
    }

    // ── Session pings ───────────────────────────────────────────────────────
    // The systemd units on disk are the source of truth, shared with
    // ./install.sh sessionping - nothing here is mirrored into GSettings.
    // Three groups (switches + status, the ping times, the buttons), because
    // the times are rebuilt whenever the list changes and an Adw group has no
    // reorderable slot model.
    _buildPings(settings, page) {
        const pings = new Adw.PreferencesGroup({
            title: _('Session pings'),
            description: _('A 5-hour window is anchored to its first message, so pinging claude (haiku, one turn) at a fixed time lines the day’s windows up with the hours you actually work. Same schedule as ./install.sh sessionping.'),
        });
        const schedule = readSchedule();
        let times = schedule.times.slice();
        const days = new Set(schedule.days);

        const enableRow = new Adw.SwitchRow({
            title: _('Open the 5h session window on schedule'),
            subtitle: hasSystemd()
                ? _('Runs scripts/session-ping.sh from a systemd user timer')
                : _('Needs a systemd user session - use ./install.sh sessionping here'),
        });
        enableRow.active = schedule.enabled;
        enableRow.sensitive = hasSystemd();
        pings.add(enableRow);

        const statusRow = new Adw.ActionRow({title: _('Last ping'), subtitle: ''});
        pings.add(statusRow);

        const coverageRow = new Adw.ActionRow({title: _('Coverage'), subtitle: ''});
        pings.add(coverageRow);

        // The working day, which is the input the suggestion is computed from.
        const dayRow = new Adw.ActionRow({title: _('Working day')});
        const timeEntry = text => new Gtk.Entry({
            text, max_width_chars: 5, width_chars: 5, valign: Gtk.Align.CENTER,
        });
        const startEntry = timeEntry(settings.get_string('work-start'));
        const endEntry = timeEntry(settings.get_string('work-end'));
        dayRow.add_suffix(startEntry);
        dayRow.add_suffix(new Gtk.Label({label: '→', valign: Gtk.Align.CENTER}));
        dayRow.add_suffix(endEntry);
        pings.add(dayRow);

        const daysRow = new Adw.ActionRow({title: _('Days')});
        const dayNames = [_('Mon'), _('Tue'), _('Wed'), _('Thu'), _('Fri'), _('Sat'), _('Sun')];
        const daysBox = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
        const dayButtons = dayNames.map((name, i) => {
            const btn = new Gtk.ToggleButton({label: name, valign: Gtk.Align.CENTER});
            btn.active = days.has(i + 1);
            daysBox.append(btn);
            return btn;
        });
        daysRow.add_suffix(daysBox);
        pings.add(daysRow);

        // An ActionRow doubling as the error line: its title is the message.
        const errorRow = new Adw.ActionRow({title: '', subtitle: ''});
        errorRow.visible = false;
        pings.add(errorRow);
        page.add(pings);

        const timesGroup = new Adw.PreferencesGroup();
        page.add(timesGroup);
        const timeRows = [];

        const buttonsGroup = new Adw.PreferencesGroup();
        const buttonsRow = new Adw.ActionRow({});
        const addBtn = new Gtk.Button({label: _('Add a ping'), valign: Gtk.Align.CENTER});
        // Stop making the user guess where the chain should start: compute the
        // times that blanket the working day instead.
        const suggestBtn = new Gtk.Button({label: _('Suggest times'), valign: Gtk.Align.CENTER});
        buttonsRow.add_suffix(addBtn);
        buttonsRow.add_suffix(suggestBtn);
        buttonsGroup.add(buttonsRow);
        page.add(buttonsGroup);

        const workDay = () => ({
            startMinute: parseHHMM(startEntry.text) ?? 9 * 60,
            endMinute: parseHHMM(endEntry.text) ?? 18 * 60,
        });

        const renderStatus = () => {
            const last = formatLastPing(readLastPing(), Date.now());
            statusRow.subtitle = last || _('never');
            const plan = evaluateWindows(times, workDay());
            coverageRow.subtitle = plan
                ? _('%d%% of %s-%s covered').format(
                    plan.coveragePercent, startEntry.text, endEntry.text)
                : _('no valid times yet');
        };

        const apply = () => {
            applySchedule({
                enabled: enableRow.active,
                times: times.filter(isValidPingTime),
                days: [...days],
                extensionPath: this.path,
            }).then(err => {
                if (this._closed())
                    return;
                errorRow.visible = Boolean(err);
                errorRow.title = err ?? '';
                renderStatus();
            });
        };

        const renderTimes = () => {
            timeRows.splice(0).forEach(row => timesGroup.remove(row));
            times.forEach((time, i) => {
                const row = new Adw.EntryRow({title: _('Ping %d').format(i + 1)});
                row.set_show_apply_button(true);
                row.text = time;
                const remove = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                    sensitive: times.length > 1,
                });
                remove.connect('clicked', () => {
                    times.splice(i, 1);
                    renderTimes();
                    apply();
                });
                row.add_suffix(remove);
                // On Apply (or Enter), not per keystroke: every change rewrites
                // two systemd units and reloads the daemon.
                row.connect('apply', entry => {
                    const normalized = normalizePingTime(entry.text);
                    if (!normalized)
                        return;
                    times[i] = normalized;
                    entry.text = normalized;
                    renderStatus();
                    apply();
                });
                timesGroup.add(row);
                timeRows.push(row);
            });
            renderStatus();
        };

        addBtn.connect('clicked', () => {
            times.push('09:00');
            renderTimes();
            apply();
        });
        suggestBtn.connect('clicked', () => {
            times = planWindows(workDay(), Math.max(2, times.length)).pingTimes;
            renderTimes();
            apply();
        });
        for (const entry of [startEntry, endEntry]) {
            entry.connect('changed', () => {
                const start = parseHHMM(startEntry.text);
                const end = parseHHMM(endEntry.text);
                if (start === null || end === null || end <= start)
                    return;
                settings.set_string('work-start', startEntry.text);
                settings.set_string('work-end', endEntry.text);
                renderStatus();
            });
        }
        dayButtons.forEach((btn, i) => btn.connect('toggled', () => {
            if (btn.active) {
                days.add(i + 1);
            } else if (days.size > 1) {
                days.delete(i + 1);
            } else {
                btn.active = true; // never leave a schedule with no days
                return;
            }
            apply();
        }));
        enableRow.connect('notify::active', () => apply());
        renderTimes();
    }

    // Updates: the same `scripts/auto-update.sh --status --json` the daily
    // timer runs. Surfacing `blocked` is the point - auto-update refuses a
    // dirty, diverged or detached checkout and only logs why, so a paused
    // install used to look exactly like a current one.
    _buildUpdates() {
        const updates = new Adw.PreferencesGroup({
            title: _('Updates'),
            description: _('Daily check, and whether it is actually running.'),
        });
        const updateRow = new Adw.ActionRow({
            title: _('Checking…'),
            subtitle: '',
        });
        const updateBtn = new Gtk.Button({
            label: _('Check now'),
            valign: Gtk.Align.CENTER,
        });
        updateRow.add_suffix(updateBtn);
        updates.add(updateRow);

        const scriptPath = GLib.build_filenamev([this.path, 'scripts', 'auto-update.sh']);

        // Async, cancelled with the window: a git fetch must never freeze the
        // prefs window, nor write into it after it is gone.
        const runUpdateScript = async args => {
            const {ok, stdout} = await run(['bash', scriptPath, ...args],
                {cancellable: this._cancellable});
            return ok ? stdout : null;
        };

        const renderUpdate = (stdout) => {
            updateBtn.sensitive = true;
            if (!stdout) {
                updateRow.title = _('Cannot self-update');
                updateRow.subtitle = _('No git checkout found for auto-update.sh.');
                updateBtn.label = _('Check now');
                return;
            }
            let st;
            try {
                st = JSON.parse(stdout);
            } catch {
                updateRow.title = _('Could not read the update status');
                updateRow.subtitle = '';
                return;
            }
            if (st.clientsStale && !st.updateAvailable) {
                // The code is here but was never installed - the daily run only
                // reinstalls after a fast-forward it performed itself, so a
                // manual `git pull` leaves the clients behind indefinitely.
                updateRow.title = _('Installed %s, checkout %s').format(st.installed, st.checkout_version);
                updateRow.subtitle = _('Run ./install.sh update to install the newer code.');
                updateBtn.label = _('Update now');
            } else if (st.blocked) {
                updateRow.title = _('Paused: %s').format(st.blockedReason);
                updateRow.subtitle = _(
                    'The daily check will not touch this checkout until that is resolved. ' +
                        'It only ever fast-forwards a clean checkout.',
                );
                updateBtn.label = _('Check now');
            } else if (st.updateAvailable) {
                updateRow.title = _('Update available: %s → %s').format(st.installed, st.latest);
                updateRow.subtitle = _('Last checked %s').format(st.lastCheck);
                updateBtn.label = _('Update now');
            } else {
                updateRow.title = st.latest
                    ? _('Up to date (%s)').format(st.installed)
                    : _('%s (could not reach the remote)').format(st.installed);
                updateRow.subtitle = _('Last checked %s').format(st.lastCheck);
                updateBtn.label = _('Check now');
            }
        };

        const refreshUpdate = async () => {
            updateBtn.sensitive = false;
            const out = await runUpdateScript(['--status', '--json']);
            if (!this._closed())
                renderUpdate(out);
        };

        updateBtn.connect('clicked', async () => {
            updateBtn.sensitive = false;
            const applying = updateBtn.label === _('Update now');
            updateRow.subtitle = applying ? _('Updating…') : _('Checking…');
            const out = await runUpdateScript(applying ? [] : ['--status', '--json']);
            if (this._closed())
                return;
            if (applying)
                refreshUpdate();
            else
                renderUpdate(out);
        });
        refreshUpdate();
        return updates;
    }

    // ── Saved accounts ──────────────────────────────────────────────────────
    // Two groups: the switches (master switch first, everything else hidden
    // until it is on) and the list of saved logins, rebuilt after every save
    // or remove. A saved login is the credentials Claude Code holds right now
    // plus the account block of ~/.claude.json, kept under a name. Switching
    // swaps exactly those two; nothing else in ~/.claude changes.
    _buildAccountsGroups(settings, page) {
        const accounts = new Adw.PreferencesGroup({
            title: _('Accounts'),
            description: _('Save the login Claude Code holds now under a name (PRO, PERSO) and switch between saved logins from the dropdown, no browser needed. Only the credentials and the account block of ~/.claude.json change; settings, hooks, plugins and history stay. Claude Code sessions already running keep the old login until they restart.'),
        });
        page.add(accounts);

        // The master switch. Everything below it is hidden while it is off, so
        // a user who never asked for accounts never sees them.
        const accountsEnableRow = new Adw.SwitchRow({
            title: _('Enable named accounts'),
            subtitle: _('Off by default - nothing account-related is shown until you turn it on'),
        });
        settings.bind('accounts-enabled', accountsEnableRow, 'active', 0);
        accounts.add(accountsEnableRow);

        // An EntryRow has no subtitle, so the "which login is this" line is a
        // row of its own right above it.
        const loginRow = new Adw.ActionRow({title: _('Current login'), subtitle: ''});
        accounts.add(loginRow);
        const saveRow = new Adw.EntryRow({title: _('Save the current login as')});
        const saveBtn = new Gtk.Button({label: _('Save'), valign: Gtk.Align.CENTER});
        saveRow.add_suffix(saveBtn);
        accounts.add(saveRow);
        // An ActionRow doubling as the error line: its title is the message.
        const errorRow = new Adw.ActionRow({title: '', subtitle: ''});
        errorRow.visible = false;
        accounts.add(errorRow);

        const autoRow = new Adw.SwitchRow({
            title: _('Switch accounts automatically'),
            subtitle: _('When the active account reaches the threshold, move to the saved account with the most headroom'),
        });
        settings.bind('accounts-auto-switch', autoRow, 'active', 0);
        accounts.add(autoRow);
        const thresholdRow = new Adw.SpinRow({
            title: _('Auto-switch threshold'),
            subtitle: _('Worst limit percentage that counts as full'),
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 100, step_increment: 5, page_increment: 10,
            }),
        });
        settings.bind('accounts-switch-threshold', thresholdRow, 'value', 0);
        accounts.add(thresholdRow);
        const showRow = new Adw.SwitchRow({
            title: _('Show the account name in the top bar'),
            subtitle: _('"PRO · Session 42%" instead of "Session 42%"'),
        });
        settings.bind('panel-show-account', showRow, 'active', 0);
        accounts.add(showRow);

        // One row per saved login, rebuilt after every save or remove.
        const listGroup = new Adw.PreferencesGroup();
        page.add(listGroup);
        for (const w of [loginRow, saveRow, autoRow, thresholdRow, showRow, listGroup])
            settings.bind('accounts-enabled', w, 'visible', 0);
        const accountRows = [];
        const renderAccounts = () => {
            accountRows.splice(0).forEach(row => listGroup.remove(row));
            const live = readLiveAccount();
            const active = liveAccountName();
            loginRow.subtitle = live?.emailAddress
                ? (active
                    ? _('%s, saved as %s').format(live.emailAddress, active)
                    : _('%s (not saved yet)').format(live.emailAddress))
                : _('No Claude Code login found');
            for (const profile of listProfiles()) {
                const a = accountSummary(profile);
                const row = new Adw.ActionRow({
                    title: `${profile.name === active ? '● ' : ''}${a.name}`,
                    subtitle: [a.email, a.plan, a.tokenState === 'expired'
                        ? _('login expired - sign in and save it again') : null]
                        .filter(x => x).join(' · '),
                });
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                    tooltip_text: _('Forget this saved login'),
                });
                remove.connect('clicked', () => {
                    try {
                        removeProfile(profile.name);
                    } catch (e) {
                        errorRow.title = e.message;
                        errorRow.visible = true;
                    }
                    renderAccounts();
                });
                row.add_suffix(remove);
                listGroup.add(row);
                accountRows.push(row);
            }
        };
        saveBtn.connect('clicked', () => {
            const name = saveRow.text.trim();
            errorRow.visible = false;
            if (!isValidName(name)) {
                errorRow.title = _('Names use letters, digits, . _ - only (up to 32 characters)');
                errorRow.visible = true;
                return;
            }
            try {
                saveCurrent(name);
                saveRow.text = '';
            } catch (e) {
                errorRow.title = e.message;
                errorRow.visible = true;
            }
            renderAccounts();
        });
        saveRow.connect('entry-activated', () => saveBtn.emit('clicked'));
        renderAccounts();
    }
}
