// "Awake" in the dropdown: keep this machine from sleeping while Claude Code
// works, for a timer, or both. Owns its menu item, the top-bar countdown and
// the recovery warning a session that ended badly leaves behind.
//
// Every button runs the installed claudectl, so the holder, the journal and
// the lock are claude-code/awake.js's and there is never a second writer. The
// state is read from the two files directly (lib/awake.js), without blocking
// the Shell.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {awakeCommand, readAwakeState, syncAwakeConfig} from './awake.js';
import {lastOutputLine, run} from './proc.js';
import {claudectlPath} from './snapshots.js';
import {awakeBadge, formatAwakeDuration} from './pure.js';
import {vbox} from './widgets.js';

/** While a session is held, redraw the countdown this often. Not every
 *  second: the dropdown is usually closed, and a timer per second for a
 *  twelve-hour hold is twelve hours of wakeups nobody reads. */
const TICK_SECONDS = 10;

/** The presets the dropdown offers, in minutes. */
export const AWAKE_PRESETS = Object.freeze([30, 60, 120]);

/** The words for the state line. The Swift port and the terminal have their
 *  own: labels are per-port on purpose. */
export function awakeStateText(state) {
    if (!state?.active)
        return state?.endReason ? _('off (last session ended: %s)').format(state.endReason) : _('off');
    const parts = state.holds.map(hold => (hold === 'timer'
        ? _('timer %s').format(state.countdown)
        : _('%d live session(s)').format(state.sessions)));
    const text = parts.join(_(' + '));
    return state.lid ? _('%s · lid mode').format(text) : text;
}

/** The warning a session that ended without giving the machine back leaves:
 *  the one thing in this section that must never be quiet. */
export function awakeRecoveryText(recovery) {
    if (!recovery)
        return '';
    return _('Sleep was not given back (%s), %s ago. Click Recover.')
        .format(recovery.codes.join(', '), recovery.endedAgo);
}

export class AwakeController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings  awake-enabled gates every read
     * @param {PopupMenu.PopupMenu} deps.menu
     * @param {(title: string, body: string) => void} deps.notify
     * @param {() => boolean} deps.isDestroyed
     * @param {(badge: string) => void} [deps.setBadge]  the top-bar countdown
     */
    constructor({settings, menu, notify, isDestroyed, setBadge}) {
        this._settings = settings;
        this._menu = menu;
        this._notify = notify;
        this._isDestroyed = isDestroyed;
        this._setBadge = setBadge ?? (() => {});
        this._scan = 0;
        this._tickId = 0;
        this._busy = false;
        this._state = null;

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-awake'});
        const head = new St.BoxLayout({style_class: 'cu-pause-head', x_expand: true});
        head.add_child(new St.Label({
            text: _('Awake'),
            style_class: 'cu-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._buttons = new St.BoxLayout({x_expand: false});
        head.add_child(this._buttons);
        this._line = new St.Label({text: '', style_class: 'cu-session-meta'});
        this._recovery = new St.Label({text: '', style_class: 'cu-session-meta cu-critical'});
        this._recovery.visible = false;
        box.add_child(head);
        box.add_child(this._line);
        box.add_child(this._recovery);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    _button(label, onClick) {
        const button = new St.Button({
            label, style_class: 'cu-pause-btn', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        button.reactive = !this._busy;
        button.connect('clicked', onClick);
        return button;
    }

    /** The state, or null when the section is off (then nothing is read).
     *  Never draws. */
    async read() {
        if (!this._settings.get_boolean('awake-enabled'))
            return null;
        try {
            // The holder reads the floors from disk, so the preferences have
            // to reach it before a session can be started with them.
            syncAwakeConfig(this._settings);
            return await readAwakeState();
        } catch (e) {
            logError(e, 'claude-usage-panel: awake scan failed');
            return null;
        }
    }

    /** Read, then draw this section and the badge: the section on its own. */
    async refresh() {
        const scan = ++this._scan;
        const state = await this.read();
        if (scan !== this._scan || this._isDestroyed())
            return;
        this.render(state);
    }

    /** Draw read()'s result; null (off) hides the section. */
    render(state) {
        this._state = state;
        this._cancelTick();
        this._buttons.destroy_all_children();
        if (!state) {
            this._item.visible = false;
            this._setBadge('');
            return;
        }
        this._item.visible = true;
        this._setBadge(awakeBadge(state));
        this._line.text = awakeStateText(state);
        this._recovery.text = awakeRecoveryText(state.recovery);
        this._recovery.visible = Boolean(state.recovery);
        if (state.recovery)
            this._buttons.add_child(this._button(_('Recover'), () => this.act('recover')));
        if (state.active) {
            this._buttons.add_child(this._button(_('+30m'), () => this.act('extend', {seconds: 1800})));
            this._buttons.add_child(this._button(_('Off'), () => this.act('off')));
        } else {
            for (const minutes of AWAKE_PRESETS) {
                const label = formatAwakeDuration(minutes * 60);
                this._buttons.add_child(
                    this._button(label, () => this.act('on', {seconds: minutes * 60})));
            }
            this._buttons.add_child(this._button(_('While sessions'),
                () => this.act('on', {whileSessions: true})));
        }
        if (state.active && state.timed)
            this._scheduleTick();
    }

    /** Run one control through claudectl, then re-read. */
    async act(action, opts = {}) {
        if (this._busy)
            return;
        const cli = claudectlPath();
        if (!cli) {
            this._notify(_('Claude usage'),
                _('Install claudectl (./install.sh awake) to keep this machine awake.'));
            return;
        }
        // Lid mode is never implied by a click: it is the one mode that can
        // cook a laptop in a closed bag, so it is a setting the user turned on
        // deliberately, and it only ever rides along with a new session.
        const lid = action === 'on' && this._settings.get_boolean('awake-lid-enabled');
        this._setBusy(true);
        const {ok, stdout, stderr} = await run(awakeCommand(cli, action, {...opts, lid}));
        if (this._isDestroyed())
            return;
        this._setBusy(false);
        if (!ok) {
            this._notify(_('Claude usage'),
                lastOutputLine(stdout, stderr) || _('Could not change the awake state'));
        }
        await this.refresh();
    }

    _setBusy(busy) {
        this._busy = busy;
        for (const child of this._buttons.get_children())
            child.reactive = !busy;
    }

    /** Redraw the countdown in place: no re-read, no subprocess. */
    _scheduleTick() {
        this._cancelTick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TICK_SECONDS, () => {
            this._tickId = 0;
            if (this._isDestroyed())
                return GLib.SOURCE_REMOVE;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTick() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._cancelTick();
    }
}
