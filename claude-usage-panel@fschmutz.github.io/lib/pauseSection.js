// "Pause / resume" in the dropdown: send the pause protocol to every live
// Claude Code session (or one), then show per session whether it was
// delivered and what it answered, and the "5/7 safe" summary. Owns its menu
// item and a short follow-up timer while a request is still being answered.
//
// A click runs the installed claudectl - the same binary the waiting section
// focuses through - so the request, the target list and the exactly-once
// delivery are claude-code/pause.js's, never a second writer here. The rows
// are read from the store (lib/pause.js) without blocking the Shell.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {readPauseStatus} from './pause.js';
import {lastOutputLine, run} from './proc.js';
import {claudectlPath} from './snapshots.js';
import {formatClock} from './pure.js';
import {vbox, clipLabel} from './widgets.js';

// While a request is younger than this and not every row is final, re-read
// the store every FOLLOW_SECONDS so a verdict shows up as it lands. Matches
// the CLI's default `--wait` (180 s); after that the normal poll catches up.
const FOLLOW_MS = 180_000;
const FOLLOW_SECONDS = 3;

/** The claudectl argv for a panel action. A single session is named by pid:
 *  two clones of one repo share a name. `--no-wait`: the panel follows the
 *  store itself, the CLI must return at once. */
export function pauseCommand(cli, action, pid = null) {
    const tail = ['--no-wait', '--from=gnome'];
    if (action === 'pause-one')
        return [cli, 'session', 'pause', String(pid), ...tail];
    if (action === 'resume-all')
        return [cli, 'session', 'resume', '--all', ...tail];
    return [cli, 'session', 'pause', '--all', ...tail];
}

/** The words for a row's state; '' for a live session the request does not
 *  name. The Swift port and the terminal have their own. */
export function pauseStateText(row) {
    const via = row.via === 'rewake' ? _('woken') : row.via === 'pretooluse' ? _('next tool call') : null;
    switch (row.state) {
        case 'safe': return _('SAFE');
        case 'not-safe': return row.reason ? _('NOT SAFE: %s').format(row.reason) : _('NOT SAFE');
        case 'resumed': return _('resumed');
        case 'delivered': return via ? _('delivered (%s), pausing').format(via) : _('delivered, pausing');
        case 'pending': return _('delivering');
        case 'unarmed': return _('no waiter yet: gets it on its next turn');
        case 'lost': return _('ended without a verdict');
        case 'superseded': return _('superseded by a newer request');
        case 'expired': return row.via ? _('no verdict within the hour') : _('expired before delivery');
        case 'gone': return _('not running');
        default: return '';
    }
}

/** The summary line: "Pause 14:05 · 5/7 safe · 1 not safe · 1 in progress". */
export function pauseSummaryText(request, summary) {
    if (!request)
        return '';
    const parts = request.kind === 'resume'
        ? [_('Resume %s').format(formatClock(request.at)),
            _('%d/%d resumed').format(summary.resumed, summary.total)]
        : [_('Pause %s').format(formatClock(request.at)),
            _('%d/%d safe').format(summary.safe, summary.total)];
    if (summary.notSafe)
        parts.push(_('%d not safe').format(summary.notSafe));
    if (summary.pending)
        parts.push(_('%d in progress').format(summary.pending));
    return parts.join(' · ');
}

export class PauseController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings  pause-enabled gates every read
     * @param {PopupMenu.PopupMenu} deps.menu
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => boolean} deps.isDestroyed
     */
    constructor({settings, menu, notify, isDestroyed}) {
        this._settings = settings;
        this._notify = notify;
        this._isDestroyed = isDestroyed;
        this._scan = 0;
        this._followId = 0;
        this._busy = false;

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-pause'});
        const head = new St.BoxLayout({style_class: 'cu-pause-head', x_expand: true});
        head.add_child(new St.Label({
            text: _('Pause / resume'),
            style_class: 'cu-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._pauseAll = this._actionButton(_('Pause all'), () => this._act('pause-all'));
        this._resumeAll = this._actionButton(_('Resume all'), () => this._act('resume-all'));
        head.add_child(this._pauseAll);
        head.add_child(this._resumeAll);
        this._summary = new St.Label({text: '', style_class: 'cu-session-meta'});
        this._rows = vbox({x_expand: true});
        box.add_child(head);
        box.add_child(this._summary);
        box.add_child(this._rows);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    _actionButton(label, onClick) {
        const button = new St.Button({
            label, style_class: 'cu-pause-btn', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', onClick);
        return button;
    }

    async refresh() {
        this._cancelFollow();
        // A poll and a follow-up can overlap: only the newest scan paints.
        const scan = ++this._scan;
        // Off (the default): nothing is read.
        if (!this._settings.get_boolean('pause-enabled')) {
            this._item.visible = false;
            return;
        }
        let status = {request: null, rows: [], summary: null};
        try {
            status = await readPauseStatus();
        } catch (e) {
            logError(e, 'claude-usage-panel: pause scan failed');
        }
        if (scan !== this._scan || this._isDestroyed())
            return;
        this._render(status);
        const {request, summary} = status;
        if (request && !summary.done && Date.now() - request.at < FOLLOW_MS)
            this._scheduleFollow();
    }

    _render({request, rows, summary}) {
        this._rows.destroy_all_children();
        this._item.visible = rows.length > 0 || Boolean(request);
        this._summary.text = pauseSummaryText(request, summary);
        this._summary.visible = Boolean(request);
        this._setBusy(this._busy);
        for (const row of rows) {
            const line = new St.BoxLayout({style_class: 'cu-session-row', x_expand: true});
            line.add_child(clipLabel(new St.Label({
                text: row.name,
                style_class: 'cu-session-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            })));
            const state = pauseStateText(row);
            if (state) {
                line.add_child(clipLabel(new St.Label({
                    text: state,
                    style_class: `cu-session-meta cu-pause-${row.state}`,
                    y_align: Clutter.ActorAlign.CENTER,
                })));
            }
            if (row.pid !== null) {
                const button = this._actionButton(_('Pause'), () => this._act('pause-one', row));
                button.reactive = !this._busy;
                line.add_child(button);
            }
            this._rows.add_child(line);
        }
    }

    _setBusy(busy) {
        this._busy = busy;
        this._pauseAll.reactive = !busy;
        this._resumeAll.reactive = !busy;
    }

    async _act(action, row = null) {
        if (this._busy)
            return;
        const cli = claudectlPath();
        if (!cli) {
            this._notify(_('Claude usage'),
                _('Install claudectl and the pause hooks (./install.sh pause) to pause sessions.'));
            return;
        }
        this._setBusy(true);
        const {ok, stdout, stderr} = await run(pauseCommand(cli, action, row?.pid));
        if (this._isDestroyed())
            return;
        this._setBusy(false);
        if (!ok) {
            this._notify(_('Claude usage'), lastOutputLine(stdout, stderr) ||
                (action === 'resume-all' ? _('Could not resume the sessions') : _('Could not pause the sessions')));
        }
        await this.refresh();
    }

    _scheduleFollow() {
        this._followId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, FOLLOW_SECONDS, () => {
            this._followId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelFollow() {
        if (this._followId) {
            GLib.Source.remove(this._followId);
            this._followId = 0;
        }
    }

    destroy() {
        this._cancelFollow();
    }
}
