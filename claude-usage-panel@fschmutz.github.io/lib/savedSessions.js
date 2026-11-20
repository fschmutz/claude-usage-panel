// The header's `claudectl session` buttons: Reopen (the newest snapshot as
// tabs), Save (the open sessions, now) and the autosave pause (until the next
// boot), whose state also drives the amber banner and the top-bar mark. The store is written by the CLI and
// by the 30-minute autosave, both outside this process: opening the menu
// paints the last summary at once and re-reads the store without blocking,
// repainting when it lands; a save or a reopen re-reads it too.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {runClaudectl} from './claudectl.js';
import {claudectlPath} from './paths.js';
import {firstOutputLine, lastOutputLine, run} from './proc.js';
import {readAutosavePause, readSnapshots} from './snapshots.js';

const DEFAULT_IO = {
    readSnapshots,
    readAutosavePause,
    claudectlPath,
    run,
    notify: (title, body) => Main.notify(title, body),
};

export class SavedSessionsController {
    /**
     * @param {object} deps
     * @param {{syncReopen: (state: object) => void, syncPause: (state: object) => void}} deps.header the HeaderBar
     * @param {{close: () => void}} deps.menu the dropdown
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     * @param {(pause: {paused: boolean, since: number|null}) => void} [deps.onPause]
     *   the banner and the top-bar mark, on every pause read
     * @param {object} [deps.io] readSnapshots / readAutosavePause / claudectlPath / run / notify, for tests
     */
    constructor({header, menu, isDestroyed, onPause = () => {}, io = {}}) {
        this._header = header;
        this._onPause = onPause;
        /** The last pause read: {paused, since}. */
        this._pause = {paused: false, since: null};
        this._pauseReading = null;
        this._menu = menu;
        this._isDestroyed = isDestroyed;
        this._io = {...DEFAULT_IO, ...io};
        /** The last summary read, null until the first read lands. */
        this._newest = undefined;
        this._reading = null;
    }

    /** The menu opened: paint what is known, then re-read the store. */
    sync() {
        if (this._newest !== undefined)
            this._paint();
        return Promise.all([this._reload(), this.syncPause()]);
    }

    /** Re-read the autosave pause: on every poll, so the top-bar mark
     *  follows a pause or resume typed in a terminal. One read at a time. */
    syncPause() {
        this._pauseReading ??= this._io.readAutosavePause().then(({paused, since}) => {
            this._pauseReading = null;
            if (this._isDestroyed())
                return;
            this._pause = {paused, since};
            this._paintPause();
        });
        return this._pauseReading;
    }

    _paintPause() {
        const {paused} = this._pause;
        this._header.syncPause({
            visible: Boolean(this._io.claudectlPath()) || paused,
            paused,
            title: paused ? _('Autosave paused until restart - click to resume')
                : _('Pause the autosave until restart'),
        });
        this._onPause(this._pause);
    }

    // `claudectl session autosave pause|resume`: the CLI writes the pause
    // file, this only reads it back. The pause keeps the newest snapshot the
    // one to reopen until the next boot; a forced Save still writes.
    async togglePause() {
        const verb = this._pause.paused ? 'resume' : 'pause';
        const r = await this._run(cli => [cli, 'session', 'autosave', verb],
            _('Could not change the autosave'));
        if (r.status === 'done')
            await this.syncPause();
    }

    // One read at a time: a menu opened twice in a row shares it.
    _reload() {
        this._reading ??= this._io.readSnapshots().then(({newest}) => {
            this._reading = null;
            if (this._isDestroyed())
                return;
            this._newest = newest ?? null;
            this._paint();
        });
        return this._reading;
    }

    // Reopen offers exactly one thing - the newest snapshot - and only when it
    // holds a session: a forced save with nothing open writes an empty one on
    // purpose, and that one means "nothing to reopen".
    _paint() {
        const newest = this._newest;
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

    _run(argvFor, failTitle) {
        return runClaudectl(argvFor, {
            notify: this._io.notify, isDestroyed: this._isDestroyed, failTitle, io: this._io,
        });
    }

    // `claudectl session open` with no argument: the newest snapshot, one tab
    // per session. It skips a session that is still running, so pressing this
    // after a crash reopens what died and leaves what survived alone.
    async reopen() {
        if (!this._io.claudectlPath())
            return;
        this._menu.close();
        const r = await this._run(cli => [cli, 'session', 'open'], _('Could not reopen the sessions'));
        if (r.status !== 'done')
            return;
        // The CLI's last line says what it opened.
        if (r.ok)
            this._io.notify(_('Reopened your sessions'), lastOutputLine(r.stdout, r.stderr));
        await this._reload();
    }

    // `claudectl session autosave --force`: what is open right now becomes the
    // newest snapshot, none included, instead of at the next 30-minute tick -
    // which a lid shut in between never reaches, so threads closed since then
    // came back on the next Reopen.
    async save() {
        const r = await this._run(cli => [cli, 'session', 'autosave', '--force'],
            _('Could not save every session'));
        if (r.status !== 'done')
            return;
        // Success: "saved auto-… (N sessions)". Failure: the last line names
        // the session it could not save (runClaudectl notified it).
        if (r.ok)
            this._io.notify(_('Saved your open sessions'), firstOutputLine(r.stdout, r.stderr));
        await this._reload();
    }
}
