// The session board in the dropdown: "Waiting on you", "Pause / resume" and
// "Today's sessions" as ONE Sessions section, one row per session, either as
// a single list (`sessions-layout` 'merged') or under Waiting / Live / Today
// tabs ('tabs'). It draws what the session group (lib/sessionGroup.js) hands
// it - the three sections' reads, once per refresh - and knows nothing of the
// sections. The join, the row parts and the visibility are lib/pure/board.js.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {pauseStateText, pauseSummaryText} from './pauseSection.js';
import {runClaudectl} from './claudectl.js';
import {
    BOARD_TABS, boardDefaultTab, boardMetaParts, boardTab, boardVisible, compactTokens, sessionBoard,
} from './pure.js';
import {vbox, clipLabel} from './widgets.js';

/** The claudectl argv that raises a running session's tab, by pid. */
export function boardFocusCommand(cli, row) {
    return [cli, 'session', 'focus', String(row.pid)];
}

/** The words for boardMetaParts(row). */
export function boardMeta(row) {
    return boardMetaParts(row).map(part => {
        switch (part.kind) {
            case 'waiting': {
                const reason = part.reason === 'permission' ? _('permission')
                    : part.reason === 'idle' ? _('idle') : _('question');
                return `${_('waiting')} ${part.age} · ${reason}`;
            }
            case 'pause': return pauseStateText(part);
            case 'running': return _('running');
            default: return `${compactTokens(part.tokens)}  ${part.when}`.trim();
        }
    }).filter(Boolean).join(' · ');
}

export class BoardController {
    /**
     * @param {object} deps
     * @param {PopupMenu.PopupMenu} deps.menu
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => boolean} deps.isDestroyed
     * @param {{pause: (action: string, row?: object) => void, open: (session: object) => void}} deps.actions
     */
    constructor({menu, notify, isDestroyed, actions}) {
        this._menu = menu;
        this._notify = notify;
        this._isDestroyed = isDestroyed;
        this._actions = actions;
        this._last = null;
        this._tab = null;
        this._showEnded = false;
        this._busy = false;

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-board'});
        const head = new St.BoxLayout({style_class: 'cu-board-head', x_expand: true});
        head.add_child(new St.Label({
            text: _('Sessions'), style_class: 'cu-section-title', y_align: Clutter.ActorAlign.CENTER}));
        this._counts = new St.Label({
            text: '', style_class: 'cu-session-meta', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._counts);
        this._pauseAll = this._button(_('Pause all'), () => this._pause('pause-all'));
        this._resumeAll = this._button(_('Resume all'), () => this._pause('resume-all'));
        head.add_child(this._pauseAll);
        head.add_child(this._resumeAll);
        this._tabs = new St.BoxLayout({style_class: 'cu-board-tabs'});
        this._summary = new St.Label({text: '', style_class: 'cu-session-meta'});
        this._rows = vbox({x_expand: true});
        box.add_child(head);
        box.add_child(this._tabs);
        box.add_child(this._summary);
        box.add_child(this._rows);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    /** The menu item it draws in (the tests read what it shows). */
    get item() {
        return this._item;
    }

    /**
     * Draw the sessions; each section's read is null when that section is off.
     * @param {{layout: string, waiting: object[]|null,
     *   pause: {request, rows, summary, busy}|null, today: {sessions, pending}|null}} data
     */
    render(data) {
        this._last = data;
        this._rows.destroy_all_children();
        this._tabs.destroy_all_children();
        const {layout, waiting, pause, today} = data;
        const {rows, counts} = sessionBoard({
            waiting: waiting ?? [],
            pause: pause?.rows ?? [],
            today: today?.sessions ?? [],
        });
        this._item.visible = boardVisible(layout, rows, pause?.request);
        if (!this._item.visible)
            return;
        const pauseOn = pause !== null;
        this._busy = Boolean(pause?.busy);
        for (const button of [this._pauseAll, this._resumeAll]) {
            button.visible = pauseOn;
            button.reactive = !this._busy;
        }
        this._summary.text = pauseOn ? pauseSummaryText(pause.request, pause.summary) : '';
        this._summary.visible = Boolean(this._summary.text);
        const est = today?.pending ? _('est., still indexing') : _('est.');
        this._counts.text = [
            waiting !== null ? _('%d waiting').format(counts.waiting) : null,
            pauseOn || waiting !== null ? _('%d live').format(counts.live) : null,
            today !== null ? `${_('%d today').format(counts.today)} (${est})` : null,
        ].filter(Boolean).join(' · ');

        if (layout === 'tabs') {
            this._tabs.visible = true;
            this._tab = boardDefaultTab(counts, this._tab);
            const names = {waiting: _('Waiting'), live: _('Live'), today: _('Today')};
            for (const tab of BOARD_TABS) {
                this._tabs.add_child(this._button(`${names[tab]} ${counts[tab]}`, () => {
                    this._tab = tab;
                    this.render(this._last);
                }, `cu-board-tab${tab === this._tab ? ' cu-active' : ''}`));
            }
            for (const row of boardTab(rows, this._tab))
                this._rows.add_child(this._row(row, pauseOn));
            return;
        }
        this._tabs.visible = false;
        const ended = rows.filter(r => r.status === 'ended');
        for (const row of rows.filter(r => r.status !== 'ended'))
            this._rows.add_child(this._row(row, pauseOn));
        if (!ended.length)
            return;
        // Ended today: folded by default, so the live ones stay on screen.
        const fold = this._button(
            `${this._showEnded ? '▾' : '▸'} ${_('%d ended today').format(ended.length)}`,
            () => {
                this._showEnded = !this._showEnded;
                this.render(this._last);
            }, 'cu-session-btn cu-session-meta');
        fold.x_align = Clutter.ActorAlign.START;
        this._rows.add_child(fold);
        if (this._showEnded) {
            for (const row of ended)
                this._rows.add_child(this._row(row, pauseOn));
        }
    }

    _button(label, onClick, style = 'cu-pause-btn') {
        const button = new St.Button({label, style_class: style, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', onClick);
        return button;
    }

    // Grey the pause buttons at once; the pause section's own refresh after
    // the action redraws them from its busy flag.
    _pause(action, row = null) {
        if (this._busy)
            return;
        this._busy = true;
        this._pauseAll.reactive = false;
        this._resumeAll.reactive = false;
        this._actions.pause(action, row);
    }

    _row(row, pauseOn) {
        const line = new St.BoxLayout({style_class: 'cu-session-row', x_expand: true});
        line.add_child(clipLabel(new St.Label({
            text: `▸ ${row.name}`,
            style_class: 'cu-session-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        })));
        line.add_child(clipLabel(new St.Label({
            text: boardMeta(row),
            style_class: `cu-session-meta${row.waiting ? ' cu-board-waiting' : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
        })));
        const button = new St.Button({style_class: 'cu-session-btn', x_expand: true, can_focus: true, child: line});
        button.connect('clicked', () => this._click(row));
        if (!pauseOn || row.pid === null)
            return button;
        // The Pause button sits beside the row, never inside its button.
        const box = new St.BoxLayout({style_class: 'cu-session-row', x_expand: true});
        box.add_child(button);
        const pause = this._button(_('Pause'), () => this._pause('pause-one', row));
        pause.reactive = !this._busy;
        box.add_child(pause);
        return box;
    }

    // A running session: raise its tab. One that ended: resume it in a
    // terminal, like Today's sessions does.
    _click(row) {
        if (row.pid === null) {
            if (row.today)
                this._actions.open({sessionId: row.sessionId, cwd: row.cwd, label: row.name});
            return;
        }
        this._menu.close();
        runClaudectl(cli => boardFocusCommand(cli, row), {
            notify: this._notify, isDestroyed: this._isDestroyed,
            installHint: _('Install claudectl (./install.sh cli) to jump to a session.'),
            failText: _('Could not focus %s').format(row.name),
        });
    }

    /** Hide the board (the separate layout draws the three sections). */
    hide() {
        this._item.visible = false;
    }
}
