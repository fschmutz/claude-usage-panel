// The General tab's update group.
// Split out of prefs.js by tab: `prefs` is the ExtensionPreferences
// instance, for its path, its cancellable and `_closed()` (see prefs.js).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {run} from '../lib/proc.js';

// Updates: the same `scripts/auto-update.sh --status --json` the daily
// timer runs. Surfacing `blocked` is the point - auto-update refuses a
// dirty, diverged or detached checkout and only logs why, so a paused
// install used to look exactly like a current one.
export function buildUpdates(prefs) {
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

    const scriptPath = GLib.build_filenamev([prefs.path, 'scripts', 'auto-update.sh']);

    // Async so a git fetch never freezes the prefs window. The STATUS read
    // is cancelled with the window; APPLYING is not. Cancelling kills the
    // script, and closing the window mid-update used to do exactly that
    // between the fast-forward and the reinstall - which leaves the
    // clients on the old release with no run left to fix them. For the
    // same reason applying has no time limit; a status read keeps run()'s.
    const runUpdateScript = async (args, {cancel = true} = {}) =>
        run(['bash', scriptPath, ...args], cancel
            ? {cancellable: prefs._cancellable}
            : {cancellable: null, timeoutSeconds: 0});

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
            // The code is here but was never installed - a manual `git
            // pull`, or a reinstall that failed. "Update now" reinstalls
            // it: the run decides on the DEPLOYED version, not the
            // checkout's, so this is no longer a button that does nothing.
            updateRow.title = _('Installed %s, checkout %s').format(st.installed, st.checkout_version);
            updateRow.subtitle = _('The clients are behind the code - reinstall them.');
            updateBtn.label = _('Update now');
        } else if (st.reloadNeeded) {
            // Installed, but not running: GNOME Shell keeps the extension
            // it loaded until the session restarts.
            updateRow.title = _('Installed %s, running %s').format(st.installed, st.loadedVersion);
            updateRow.subtitle = _('Log out and back in to load it.');
            updateBtn.label = _('Check now');
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
        } else if (st.latest) {
            updateRow.title = _('Up to date (%s)').format(st.installed);
            updateRow.subtitle = _('Last checked %s').format(st.lastCheck);
            updateBtn.label = _('Check now');
        } else {
            // Not "up to date": the lookup failed, and remoteError says
            // which failure - an auth, DNS or URL problem is not offline
            // and will not fix itself by waiting.
            updateRow.title = _('%s (could not check)').format(st.installed);
            updateRow.subtitle = st.remoteError || _('Last checked %s').format(st.lastCheck);
            updateBtn.label = _('Check now');
        }
    };

    const refreshUpdate = async () => {
        updateBtn.sensitive = false;
        const {ok, stdout} = await runUpdateScript(['--status', '--json']);
        if (!prefs._closed())
            renderUpdate(ok ? stdout : null);
    };

    updateBtn.connect('clicked', async () => {
        updateBtn.sensitive = false;
        const applying = updateBtn.label === _('Update now');
        updateRow.subtitle = applying ? _('Updating…') : _('Checking…');
        const {ok, stdout, stderr} = await runUpdateScript(
            applying ? [] : ['--status', '--json'], {cancel: !applying});
        if (prefs._closed())
            return;
        if (!applying) {
            renderUpdate(ok ? stdout : null);
            return;
        }
        if (ok) {
            refreshUpdate();
            return;
        }
        // An update that failed said why, on one of the two pipes. Showing
        // "Up to date" over it - which is what discarding the status did -
        // is how a broken install stayed invisible.
        updateBtn.sensitive = true;
        updateRow.title = _('The update failed');
        const lines = `${stdout}${stderr}`.trim().split('\n');
        updateRow.subtitle = lines[lines.length - 1] || _('See the log for details.');
    });
    refreshUpdate();
    return updates;
}
