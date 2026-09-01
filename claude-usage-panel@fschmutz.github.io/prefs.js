import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {storeSecret, lookupSecret} from './lib/secretStore.js';
import {formatLastPing, evaluateWindows, parseHHMM, planWindows} from './lib/pure.js';
import {isValidPingTime, normalizePingTime} from './lib/sessionPingUnit.js';
import {applySchedule, hasSystemd, readLastPing, readSchedule} from './lib/sessionPing.js';

export default class ClaudeUsagePanelPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'utilities-system-monitor-symbolic',
        });

        const behavior = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('How often to poll the Claude usage endpoint.'),
        });

        // Refresh interval (minutes, mapped to seconds in the setting).
        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Minutes between updates (min 1)'),
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

        page.add(behavior);

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
        page.add(cost);

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
        // systems without a Secret Service. `loaded` gates the changed handler
        // so prefilling the row can't echo the value back into a store cycle.
        const keyRow = new Adw.PasswordEntryRow({title: _('Cursor Admin API key')});
        let loaded = false;
        lookupSecret('cursor-admin-api-key').then(stored => {
            keyRow.text = stored ?? settings.get_string('cursor-api-key');
            loaded = true;
        });
        keyRow.connect('changed', row => {
            if (!loaded)
                return;
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
        page.add(cursor);


        // ── Today's sessions ────────────────────────────────────────────────
        const sessions = new Adw.PreferencesGroup({
            title: _('Today\u2019s sessions'),
            description: _('List the sessions that spent the most tokens today, biggest first, and resume one in a terminal with a click. Read from the local transcripts in ~/.claude/projects.'),
        });
        const sessionsRow = new Adw.SwitchRow({
            title: _('Show today\u2019s sessions'),
            subtitle: _('Adds up to 5 resume links to the dropdown'),
        });
        settings.bind('show-sessions', sessionsRow, 'active', 0);
        sessions.add(sessionsRow);

        const terminalRow = new Adw.EntryRow({title: _('Terminal')});
        terminalRow.text = settings.get_string('terminal-command');
        terminalRow.connect('changed', row =>
            settings.set_string('terminal-command', row.text.trim()));
        sessions.add(terminalRow);
        const terminalHint = new Adw.ActionRow({
            subtitle: _('Leave empty to autodetect: $TERMINAL, then ghostty, kitty, wezterm, alacritty, foot, gnome-terminal, konsole, tilix, xfce4-terminal, xterm.'),
            sensitive: false,
        });
        sessions.add(terminalHint);
        page.add(sessions);

        // ── Session pings ───────────────────────────────────────────────────
        // The systemd units on disk are the source of truth, shared with
        // ./install.sh sessionping - nothing here is mirrored into GSettings.
        const pings = new Adw.PreferencesGroup({
            title: _('Session pings'),
            description: _('A 5-hour window is anchored to its first message, so pinging claude (haiku, one turn) at a fixed time lines the day\u2019s windows up with the hours you actually work. Same schedule as ./install.sh sessionping.'),
        });
        let schedule = readSchedule();
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
        const startEntry = new Gtk.Entry({
            text: settings.get_string('work-start'),
            max_width_chars: 5,
            width_chars: 5,
            valign: Gtk.Align.CENTER,
        });
        const endEntry = new Gtk.Entry({
            text: settings.get_string('work-end'),
            max_width_chars: 5,
            width_chars: 5,
            valign: Gtk.Align.CENTER,
        });
        dayRow.add_suffix(startEntry);
        dayRow.add_suffix(new Gtk.Label({label: '\u2192', valign: Gtk.Align.CENTER}));
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

        const errorRow = new Adw.ActionRow({title: '', subtitle: ''});
        errorRow.visible = false;
        pings.add(errorRow);
        page.add(pings);

        // Ping times: their own group, rebuilt whenever the list changes (an
        // Adw group has no reorderable slot model, and 1-5 rows is cheap).
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
                errorRow.visible = Boolean(err);
                errorRow.title = err ?? '';
                schedule = readSchedule();
                renderStatus();
            });
        };

        const renderTimes = () => {
            timeRows.splice(0).forEach(row => timesGroup.remove(row));
            times.forEach((time, i) => {
                const row = new Adw.EntryRow({title: _('Ping %d').format(i + 1)});
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
                row.connect('changed', entry => {
                    const normalized = normalizePingTime(entry.text);
                    if (!normalized)
                        return; // mid-typing: leave the schedule alone
                    times[i] = normalized;
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


        // Updates: the same `scripts/auto-update.sh --status --json` the daily
        // timer runs. Surfacing `blocked` is the point - auto-update refuses a
        // dirty, diverged or detached checkout and only logs why, so a paused
        // install used to look exactly like a current one.
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
        page.add(updates);

        const scriptPath = GLib.build_filenamev([this.path, 'scripts', 'auto-update.sh']);

        const runUpdateScript = (args, onDone) => {
            // Async: a git fetch must never freeze the prefs window.
            let proc;
            try {
                proc = Gio.Subprocess.new(
                    ['bash', scriptPath, ...args],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
            } catch {
                onDone(null);
                return;
            }
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    onDone(stdout);
                } catch {
                    onDone(null);
                }
            });
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

        const refreshUpdate = () => {
            updateBtn.sensitive = false;
            runUpdateScript(['--status', '--json'], renderUpdate);
        };

        updateBtn.connect('clicked', () => {
            updateBtn.sensitive = false;
            const applying = updateBtn.label === _('Update now');
            updateRow.subtitle = applying ? _('Updating…') : _('Checking…');
            runUpdateScript(applying ? [] : ['--status', '--json'], (out) => {
                if (applying) refreshUpdate();
                else renderUpdate(out);
            });
        });
        refreshUpdate();

        window.add(page);
    }
}
