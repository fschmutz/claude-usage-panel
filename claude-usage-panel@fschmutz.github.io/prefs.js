import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {storeSecret, lookupSecret} from './lib/secretStore.js';

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
