// The Sessions tab's first two groups: today's sessions and the saved
// snapshots.
// Split out of prefs.js by tab: `prefs` is the ExtensionPreferences
// instance, for its path, its cancellable and `_closed()` (see prefs.js).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {claudectlPath} from '../lib/paths.js';
import {lastOutputLine, run} from '../lib/proc.js';
import {readSnapshots} from '../lib/snapshots.js';
import {DEFAULT_SESSIONS_LAYOUT, SESSIONS_LAYOUTS, sessionsLayout} from '../lib/pure.js';

export function buildSessions(prefs, settings) {
    const sessions = new Adw.PreferencesGroup({
        title: _('Today’s sessions'),
        description: _('List the sessions that spent the most tokens today, biggest first, and resume one in a terminal with a click. Read from the local transcripts in $CLAUDE_CONFIG_DIR/projects (~/.claude/projects by default).'),
    });
    const sessionsRow = new Adw.SwitchRow({
        title: _('Show today’s sessions'),
        subtitle: _('Adds up to 5 resume links to the dropdown'),
    });
    settings.bind('show-sessions', sessionsRow, 'active', 0);
    sessions.add(sessionsRow);

    // One Sessions list, tabs, or the three sections apart (lib/pure/board.js).
    const layoutRow = new Adw.ComboRow({
        title: _('Session sections'),
        subtitle: _('Waiting on you, Pause / resume and Today’s sessions'),
        model: Gtk.StringList.new([_('One merged list'), _('Tabs'), _('Separate sections')]),
    });
    layoutRow.set_selected(Math.max(0, SESSIONS_LAYOUTS.indexOf(sessionsLayout(settings.get_string('sessions-layout')))));
    layoutRow.connect('notify::selected', row =>
        settings.set_string('sessions-layout', SESSIONS_LAYOUTS[row.get_selected()] ?? DEFAULT_SESSIONS_LAYOUT));
    sessions.add(layoutRow);

    const terminalRow = new Adw.EntryRow({title: _('Terminal')});
    terminalRow.set_show_apply_button(true);
    terminalRow.text = settings.get_string('terminal-command');
    terminalRow.connect('apply', row =>
        settings.set_string('terminal-command', row.text.trim()));
    sessions.add(terminalRow);
    const terminalHint = new Adw.ActionRow({
        subtitle: _('Leave empty for the desktop default terminal ($TERMINAL first); without one: ghostty, kitty, wezterm, alacritty, foot, gnome-terminal, konsole, tilix, xfce4-terminal, xterm. Also used by claudectl session open.'),
        sensitive: false,
    });
    sessions.add(terminalHint);
    return sessions;
}

// What `claudectl session` keeps: is the autosave scheduled, what is the
// newest snapshot, and a button that reopens it as tabs.
export function buildSnapshots(prefs) {
    const group = new Adw.PreferencesGroup({
        title: _('Saved sessions'),
        description: _('claudectl session keeps the running Claude Code sessions in snapshots and reopens them as tabs of one terminal window.'),
    });
    const autosaveRow = new Adw.ActionRow({title: _('Autosave'), subtitle: ''});
    group.add(autosaveRow);
    const newestRow = new Adw.ActionRow({title: _('Newest snapshot'), subtitle: ''});
    const reopenBtn = new Gtk.Button({label: _('Reopen'), valign: Gtk.Align.CENTER});
    newestRow.add_suffix(reopenBtn);
    group.add(newestRow);

    const cli = claudectlPath();
    const render = async () => {
        const {newest} = await readSnapshots();
        if (prefs._closed())
            return;
        if (!cli)
            newestRow.subtitle = _('claudectl is not installed - run ./install.sh cli');
        else if (!newest)
            newestRow.subtitle = _('None yet - run claudectl session save, or wait for the autosave');
        else
            newestRow.subtitle = [newest.label,
                GLib.DateTime.new_from_unix_local(Math.floor(newest.savedAt / 1000)).format('%Y-%m-%d %H:%M'),
                newest.sessions.map(r => r.name).join(', ')].join(' · ');
        reopenBtn.sensitive = Boolean(cli && newest);
    };
    render().catch(logError);
    run(['systemctl', '--user', 'is-active', 'claude-usage-panel-autosave.timer'],
        {cancellable: prefs._cancellable}).then(({ok}) => {
        if (!prefs._closed())
            autosaveRow.subtitle = ok ? _('Every 30 minutes') : _('Not scheduled - run ./install.sh cli');
    });
    reopenBtn.connect('clicked', async () => {
        reopenBtn.sensitive = false;
        const {stdout, stderr} = await run([cli, 'session', 'open'], {cancellable: prefs._cancellable});
        if (prefs._closed())
            return;
        await render();
        if (prefs._closed())
            return;
        // the CLI's own last line says what it did, or why it opened nothing
        newestRow.subtitle = lastOutputLine(stdout, stderr) || newestRow.subtitle;
    });
    return group;
}
