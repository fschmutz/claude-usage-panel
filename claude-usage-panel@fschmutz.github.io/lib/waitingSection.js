// "Waiting on you" in the dropdown: live Claude Code sessions blocked on a
// permission prompt, a question, or idle after Stop. Owns its menu item and
// the panel badge count. Click raises the session's terminal through
// `claudectl waiting focus` (the same layout terminals.js already uses).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {run} from './proc.js';
import {claudectlPath} from './snapshots.js';
import {focusArgv, focusPlan} from './pure.js';
import {listWaiting} from './waiting.js';
import {vbox, clipLabel} from './widgets.js';

export class WaitingController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings  waiting-enabled gates the scan
     * @param {PopupMenu.PopupMenu} deps.menu
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => boolean} deps.isDestroyed
     * @param {(n: number) => void} [deps.setBadge]
     */
    constructor({settings, menu, notify, isDestroyed, setBadge}) {
        this._settings = settings;
        this._menu = menu;
        this._notify = notify;
        this._isDestroyed = isDestroyed;
        this._setBadge = setBadge ?? (() => {});

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-waiting'});
        this._title = new St.Label({
            text: _('Waiting on you'), style_class: 'cu-section-title'});
        this._rows = vbox({x_expand: true});
        box.add_child(this._title);
        box.add_child(this._rows);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
        this._scan = 0;
    }

    async refresh() {
        // A poll can start while the last scan is still reading (the poll
        // times sections out): only the newest scan may paint.
        const scan = ++this._scan;
        // Off (the default): nothing is read, no badge. A scan still in
        // flight is dropped by the generation check below.
        if (!this._settings.get_boolean('waiting-enabled')) {
            this._setBadge(0);
            this._render([]);
            return;
        }
        let rows = [];
        try {
            rows = await listWaiting();
        } catch (e) {
            logError(e, 'claude-usage-panel: waiting scan failed');
        }
        if (scan !== this._scan || this._isDestroyed())
            return;
        this._setBadge(rows.length);
        this._render(rows);
    }

    _render(rows) {
        this._rows.destroy_all_children();
        this._item.visible = rows.length > 0;
        if (!rows.length)
            return;
        this._title.text = _('Waiting on you');
        for (const row of rows) {
            const line = new St.BoxLayout({style_class: 'cu-session-row', x_expand: true});
            line.add_child(clipLabel(new St.Label({
                text: `\u25b8 ${row.name}`,
                style_class: 'cu-session-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            })));
            line.add_child(new St.Label({
                text: `${this._reason(row.reason)}  ${row.age}`,
                style_class: 'cu-session-meta',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                style_class: 'cu-session-btn',
                x_expand: true,
                can_focus: true,
                child: line,
            });
            button.connect('clicked', () => this._focus(row));
            this._rows.add_child(button);
        }
    }

    _reason(reason) {
        if (reason === 'permission')
            return _('permission');
        if (reason === 'idle')
            return _('idle');
        return _('question');
    }

    _focus(row) {
        this._menu.close();
        const cli = claudectlPath();
        if (cli) {
            run(focusCommand(cli, row)).then(({ok, stdout, stderr}) => {
                if (this._isDestroyed() || ok)
                    return;
                this._notify(_('Claude usage'),
                    lastLine(stdout, stderr) || _('Could not focus %s').format(row.name));
            });
            return;
        }
        const argv = focusArgv(focusPlan({pid: row.pid}));
        if (!argv || !GLib.find_program_in_path(argv[0])) {
            this._notify(_('Claude usage'),
                _('Install claudectl (./install.sh cli) to jump to a waiting session.'));
            return;
        }
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'claude-usage-panel: could not focus a waiting session');
            this._notify(_('Claude usage'), _('Could not focus %s').format(row.name));
        }
    }

    destroy() {}
}

/** The claudectl argv that raises `row`: by pid, never by name - two clones
 *  of one repo share a basename. */
export function focusCommand(cli, row) {
    return [cli, 'waiting', 'focus', String(row.pid)];
}

function lastLine(stdout, stderr) {
    const text = `${stdout}\n${stderr}`.trim();
    return text.split('\n').filter(Boolean).at(-1) ?? '';
}
