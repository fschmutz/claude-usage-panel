// "Today's sessions" in the dropdown: the work the plan was actually spent on,
// biggest spender first, each row a click away from being resumed in a
// terminal. Owns its menu item, the catch-up timer while the index is still
// warming, and the terminal launch. The session group (lib/sessionGroup.js) calls
// read() and render(); refresh() is the section on its own.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {run} from './proc.js';
import {refreshSessions} from './sessionIndex.js';
import {compactTokens, interactiveResume, pickTerminal, terminalArgv} from './pure.js';
import {vbox, clipLabel} from './widgets.js';

// How many of today's sessions the dropdown offers to resume.
const SESSION_ROWS = 5;
// While the index is still catching up (a cold cache, or a heavy day), retry
// sooner than the usual refresh interval instead of leaving the list short for
// ten minutes.
const SESSION_CATCHUP_SECONDS = 20;

export class SessionsController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings the extension settings
     * @param {PopupMenu.PopupMenu} deps.menu the dropdown; the section is
     *   appended at construction, so build in menu order
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     * @param {() => void} [deps.requestRefresh]  re-read and redraw while the
     *   index catches up; the session group passes its own, standalone it is
     *   refresh()
     */
    constructor({settings, menu, notify, isDestroyed, requestRefresh}) {
        this._requestRefresh = requestRefresh ?? (() => this.refresh());
        this._settings = settings;
        this._menu = menu;
        this._notify = notify;
        this._isDestroyed = isDestroyed;
        this._catchupId = 0;

        // Built as buttons inside ONE non-reactive item (like Refresh) so the
        // rows can be rebuilt on every refresh without reshuffling the menu.
        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-sessions'});
        this._title = new St.Label({
            text: _('Today\u2019s sessions'), style_class: 'cu-section-title'});
        this._rows = vbox({x_expand: true});
        box.add_child(this._title);
        box.add_child(this._rows);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    /** Today's top sessions {sessions, pending}, or null when the section
     *  is off or the scan failed. Arms the catch-up while the index is still
     *  warming. Never draws. */
    async read() {
        this._cancelCatchup();
        if (this._isDestroyed() || !this._settings.get_boolean('show-sessions'))
            return null;
        try {
            const {sessions, pending} = await refreshSessions({limit: SESSION_ROWS});
            if (pending && !this._isDestroyed())
                this._scheduleCatchup();
            return {sessions, pending};
        } catch (e) {
            logError(e, 'claude-usage-panel: session scan failed');
            return null;
        }
    }

    /** Read, then draw this section: the section on its own. */
    async refresh() {
        const data = await this.read();
        if (!this._isDestroyed())
            this.render(data);
    }

    _scheduleCatchup() {
        // two overlapping reads must never leave an orphaned timer behind
        this._cancelCatchup();
        this._catchupId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, SESSION_CATCHUP_SECONDS, () => {
                this._catchupId = 0;
                this._requestRefresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelCatchup() {
        if (this._catchupId) {
            GLib.Source.remove(this._catchupId);
            this._catchupId = 0;
        }
    }

    /** Draw read()'s result; null (off, failed) or no session hides it. */
    render(data) {
        this._rows.destroy_all_children();
        const {sessions = [], pending = false} = data ?? {};
        this._item.visible = sessions.length > 0;
        if (!sessions.length)
            return;
        // "est." for the same reason the cost line carries it: these tokens are
        // reconstructed from the local transcripts, not reported by the API.
        this._title.text = pending
            ? _('Today\u2019s sessions (est., still indexing)')
            : _('Today\u2019s sessions (est.)');
        for (const session of sessions) {
            const row = new St.BoxLayout({style_class: 'cu-session-row', x_expand: true});
            // The rows are buttons; a static screenshot cannot show a hover,
            // so the glyph is what says "this one is clickable".
            row.add_child(clipLabel(new St.Label({
                text: `\u25b8 ${session.label}`,
                style_class: 'cu-session-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            })));
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
            button.connect('clicked', () => this.open(session));
            this._rows.add_child(button);
        }
    }

    // The terminal to open: pickTerminal() decides (setting, $TERMINAL, the
    // desktop's default, then the first known one installed); this only
    // gathers its inputs. `xdg-terminal-exec --print-id` runs on a click, as
    // a child the main loop waits for without blocking, cut off after 2 s.
    async _detectTerminal() {
        const installed = bin => GLib.find_program_in_path(bin) !== null;
        let desktopId = null;
        if (installed('xdg-terminal-exec')) {
            const r = await run(['xdg-terminal-exec', '--print-id'], {timeoutSeconds: 2});
            desktopId = (r.ok && r.stdout.trim()) || null;
        }
        let alternative = null;
        try {
            alternative = GLib.file_read_link('/etc/alternatives/x-terminal-emulator');
        } catch {
            alternative = null;
        }
        return pickTerminal({
            configured: this._settings.get_string('terminal-command').trim(),
            envTerminal: GLib.getenv('TERMINAL'),
            desktopId,
            alternative,
        }, installed);
    }

    /** Resume `session` in a terminal. The board's ended rows call this too. */
    async open(session) {
        const bin = await this._detectTerminal();
        if (!bin) {
            this._notify(_('Claude usage'),
                _('No terminal found - set one in the extension preferences.'));
            return;
        }
        const argv = terminalArgv(bin, session.cwd, interactiveResume(session));
        this._menu.close();
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'claude-usage-panel: could not open a terminal');
            this._notify(_('Claude usage'), _('Could not open %s').format(bin));
        }
    }

    destroy() {
        this._cancelCatchup();
    }
}
