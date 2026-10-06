// The header's two `claudectl session` buttons: Reopen (the newest snapshot as
// tabs) and Save (the open sessions, now). The store is written by the CLI and
// by the 30-minute autosave, both outside this process, so it is re-read every
// time the menu opens rather than cached.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {run} from './proc.js';
import {readSnapshots, claudectlPath} from './snapshots.js';

const DEFAULT_IO = {
    readSnapshots,
    claudectlPath,
    run,
    notify: (title, body) => Main.notify(title, body),
};

export class SavedSessionsController {
    /**
     * @param {object} deps
     * @param {{syncReopen: (state: object) => void}} deps.header the HeaderBar
     * @param {{close: () => void}} deps.menu the dropdown
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     * @param {object} [deps.io] readSnapshots / claudectlPath / run / notify, for tests
     */
    constructor({header, menu, isDestroyed, io = {}}) {
        this._header = header;
        this._menu = menu;
        this._isDestroyed = isDestroyed;
        this._io = {...DEFAULT_IO, ...io};
    }

    // Reopen offers exactly one thing - the newest snapshot - and only when it
    // holds a session: a forced save with nothing open writes an empty one on
    // purpose, and that one means "nothing to reopen".
    sync() {
        const {newest} = this._io.readSnapshots();
        const cli = this._io.claudectlPath();
        const visible = Boolean(cli && newest?.sessions.length);
        this._header.syncReopen({
            visible,
            canSave: Boolean(cli),
            title: visible
                ? ngettext('Reopen %s (%d session)', 'Reopen %s (%d sessions)', newest.sessions.length)
                    .format(newest.label, newest.sessions.length)
                : '',
        });
    }

    // `claudectl session open` with no argument: the newest snapshot, one tab
    // per session. It skips a session that is still running, so pressing this
    // after a crash reopens what died and leaves what survived alone.
    reopen() {
        const cli = this._io.claudectlPath();
        if (!cli)
            return Promise.resolve();
        this._menu.close();
        return this._io.run([cli, 'session', 'open']).then(({ok, stdout, stderr}) => {
            if (this._isDestroyed())
                return;
            // The CLI's last line says what it opened, or why it opened nothing.
            this._io.notify(
                ok ? _('Reopened your sessions') : _('Could not reopen the sessions'),
                lastLine(stdout, stderr));
        });
    }

    // `claudectl session autosave --force`: what is open right now becomes the
    // newest snapshot, none included, instead of at the next 30-minute tick -
    // which a lid shut in between never reaches, so threads closed since then
    // came back on the next Reopen.
    save() {
        const cli = this._io.claudectlPath();
        if (!cli)
            return Promise.resolve();
        return this._io.run([cli, 'session', 'autosave', '--force']).then(({ok, stdout, stderr}) => {
            if (this._isDestroyed())
                return;
            // Success: "saved auto-… (N sessions)". Failure: the last line
            // names the session it could not save.
            this._io.notify(
                ok ? _('Saved your open sessions') : _('Could not save every session'),
                ok ? firstLine(stdout, stderr) : lastLine(stdout, stderr));
            this.sync();
        });
    }
}

function lines(stdout, stderr) {
    return `${stdout}${stderr}`.trim().split('\n');
}

function firstLine(stdout, stderr) {
    return lines(stdout, stderr)[0] || '';
}

function lastLine(stdout, stderr) {
    const all = lines(stdout, stderr);
    return all[all.length - 1] || '';
}
