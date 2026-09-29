// The optional OpenAI Codex section of the dropdown: the saved Codex logins,
// one click from becoming the live one, and the newest rate limits the codex
// CLI recorded. A SIBLING of the Claude accounts section, never a takeover -
// it is off by default, it is drawn last, and every figure in it carries the
// est. badge, because OpenAI publishes no usage endpoint to read.
// extension.js only calls refresh().

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {codexIdentity, formatResets} from './pure.js';
import {listCodexAccounts, recordedCodexUsage, switchCodexTo, syncBackCodex} from './codex.js';
import {OutcomeLabel} from './noticeRow.js';
import {vbox, clipLabel, wrapLabel} from './widgets.js';

const WHY = {
    no_sessions: () =>
        _('No Codex sessions on this machine yet - nothing has recorded a limit.'),
    no_snapshot: () => _('The recent Codex sessions carry no rate limits.'),
    stale: () => _('The newest recorded Codex reading is too old to mean anything now.'),
};

export class CodexController {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings the extension settings
     * @param {PopupMenu.PopupMenu} deps.menu the dropdown; the section is
     *   appended at construction, so build in menu order
     * @param {() => boolean} deps.isDestroyed true once the button is gone
     */
    constructor({settings, menu, isDestroyed}) {
        this._settings = settings;
        this._isDestroyed = isDestroyed;
        this._outcome = null;
        this._generation = 0;
        this._scanning = false;
        this._rescan = false;

        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true, style_class: 'cu-accounts'});
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({
            text: _('OpenAI Codex'), style_class: 'cu-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        // The provenance badge is not decoration: these percentages were read
        // by another program at another time, and they must never be mistaken
        // for the official Claude figures above them.
        head.add_child(new St.Label({
            text: _('est.'), style_class: 'cu-account-meta', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._rows = vbox({x_expand: true});
        this._usage = vbox({x_expand: true});
        this._note = wrapLabel(new St.Label({style_class: 'cu-account-meta'}));
        this._outcomeLabel = new OutcomeLabel();
        box.add_child(head);
        box.add_child(this._rows);
        box.add_child(this._usage);
        box.add_child(this._note);
        box.add_child(this._outcomeLabel);
        this._item.add_child(box);
        menu.addMenuItem(this._item);
        this._item.visible = false;
    }

    /** Rebuild the section. Off (the default) means off: with the setting
     *  unset, nothing under the Codex home is opened at all. The accounts are
     *  a few small files and draw at once; the transcript scan is async, so a
     *  sessions tree of thousands of rollouts never stalls the shell. */
    refresh() {
        if (!this._settings.get_boolean('codex-enabled')) {
            this._generation++;
            this._item.visible = false;
            return;
        }
        let state;
        try {
            // The codex CLI rotates its tokens as it runs; keep the saved copy
            // of the live login current before listing.
            syncBackCodex();
            state = listCodexAccounts();
        } catch (e) {
            logError(e, 'claude-usage-panel: could not read the Codex store');
            this._item.visible = false;
            return;
        }
        this._item.visible = true;
        this._rows.destroy_all_children();
        for (const account of state.accounts)
            this._rows.add_child(this._row(account));
        if (!state.accounts.length) {
            this._rows.add_child(wrapLabel(new St.Label({
                text: state.live
                    ? _('Signed in as %s - `claudectl codex save NAME` keeps it.')
                        .format(codexIdentity(state.live).email ?? '?')
                    : _('No Codex login found. Run `codex login` first.'),
                style_class: 'cu-account-meta',
            })));
        }
        this._outcomeLabel.set(this._outcome);
        this._scanUsage();
    }

    /** One transcript scan at a time: a refresh during a scan asks for one
     *  more after it, and a result that a newer refresh (or disabling the
     *  section, or destroying the button) has overtaken is dropped. */
    _scanUsage() {
        if (this._scanning) {
            this._rescan = true;
            return;
        }
        this._scanning = true;
        this._rescan = false;
        const generation = this._generation;
        recordedCodexUsage().then(usage => {
            if (generation === this._generation && !this._isDestroyed())
                this._showUsage(usage);
        }).catch(e => {
            logError(e, 'claude-usage-panel: could not read the Codex sessions');
        }).finally(() => {
            this._scanning = false;
            if (this._rescan && !this._isDestroyed() && this._item.visible)
                this._scanUsage();
        });
    }

    _showUsage(usage) {
        this._usage.destroy_all_children();
        for (const card of usage.cards) {
            const line = new St.BoxLayout({x_expand: true, style_class: 'cu-account-row'});
            line.add_child(clipLabel(new St.Label({
                text: card.label, style_class: 'cu-account-name', x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            })));
            line.add_child(new St.Label({
                text: `${card.percent}%  ${formatResets(card.resetsAt)}`,
                style_class: 'cu-account-meta', y_align: Clutter.ActorAlign.CENTER,
            }));
            this._usage.add_child(line);
        }
        this._note.text = usage.reason
            ? WHY[usage.reason]?.() ?? usage.reason
            : _('Recorded by the codex CLI at %s, not read now.').format(usage.capturedAt);
    }

    _row(account) {
        const line = new St.BoxLayout({
            style_class: `cu-account-row${account.active ? ' cu-account-active' : ''}`,
            x_expand: true,
        });
        line.add_child(clipLabel(new St.Label({
            text: `${account.active ? '●' : '○'} ${account.name}`,
            style_class: 'cu-account-name', y_align: Clutter.ActorAlign.CENTER,
        })));
        line.add_child(clipLabel(new St.Label({
            text: account.email ?? '', style_class: 'cu-account-meta', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        })));
        line.add_child(new St.Label({
            text: account.tokenState === 'expired'
                ? _('needs `codex login`') : account.planLabel,
            style_class: `cu-account-meta${account.tokenState === 'expired' ? ' cu-critical' : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (account.active)
            return line;
        const button = new St.Button({
            style_class: 'cu-account-btn', x_expand: true, can_focus: true, child: line,
        });
        button.connect('clicked', () => this._switchTo(account.name));
        return button;
    }

    _switchTo(name) {
        try {
            const r = switchCodexTo(name);
            this._outcome = {
                ok: true,
                text: r.changed
                    ? _('now on %s - restart codex to use it').format(name)
                    : _('%s was already the Codex login').format(name),
            };
        } catch (e) {
            this._outcome = {ok: false, text: e.message};
        }
        if (!this._isDestroyed())
            this.refresh();
    }
}
