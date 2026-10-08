// One inline row that says something is wrong and carries the single thing
// that fixes it, plus the button-local outcome that answers "did that work?".
// Deliberately IN the list the problem is about - an accounts problem reported
// at the bottom of the dropdown, or in the preferences window, is a problem
// nobody reads. The macOS app draws the same two from the same contract
// (NoticeRow.swift over ClaudeUsageCore/Notices.swift).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {severityClass} from './pure.js';
import {vbox, vboxProps, wrapLabel} from './widgets.js';

/**
 * The answer to the last action, beside the control that caused it. It clears
 * itself (OUTCOME_TTL_MS) and on the next action, so it can never become
 * furniture or describe something two actions old.
 */
export const OutcomeLabel = GObject.registerClass(
class OutcomeLabel extends St.BoxLayout {
    _init() {
        super._init({x_expand: true, style_class: 'cu-outcome'});
        this._label = wrapLabel(new St.Label({style_class: 'cu-outcome-text'}));
        this.add_child(this._label);
        this.visible = false;
    }

    /** @param {?{ok: boolean, text: string}} outcome */
    set(outcome) {
        this.visible = Boolean(outcome?.text);
        if (!this.visible)
            return;
        this._label.text = `${outcome.ok ? '\u2713' : '\u2717'} ${outcome.text}`;
        this._label.style_class =
            `cu-outcome-text ${outcome.ok ? 'cu-normal' : 'cu-critical'}`;
    }
});

/** A severity dot, a sentence, one button, and room for the answer under it. */
const NoticeRow = GObject.registerClass(
class NoticeRow extends St.BoxLayout {
    /**
     * @param {{severity: string, text: string, actionLabel: ?string}} notice
     * @param {?function(): void} onAction called when the one button is pressed
     */
    _init(notice, onAction) {
        super._init(vboxProps({
            x_expand: true,
            style_class: `cu-notice ${severityClass(notice.severity)}`,
        }));
        const line = new St.BoxLayout({x_expand: true});
        line.add_child(new St.Label({
            text: '\u25cf',
            style_class: `cu-notice-dot ${severityClass(notice.severity)}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        line.add_child(wrapLabel(new St.Label({
            text: notice.text,
            style_class: 'cu-notice-text',
            y_align: Clutter.ActorAlign.CENTER,
        })));
        if (notice.actionLabel && onAction) {
            const button = new St.Button({
                label: notice.actionLabel,
                style_class: 'cu-notice-action',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => onAction());
            line.add_child(button);
        }
        this.add_child(line);
        this._outcome = new OutcomeLabel();
        this.add_child(this._outcome);
    }

    /** @param {?{ok: boolean, text: string}} outcome what pressing it did */
    setOutcome(outcome) {
        this._outcome.set(outcome);
    }
});

/** A vertical stack of NoticeRows, rebuilt in place like every other section. */
export const NoticeList = GObject.registerClass(
class NoticeList extends St.BoxLayout {
    _init() {
        super._init(vboxProps({x_expand: true, style_class: 'cu-notices'}));
        this._rows = vbox({x_expand: true});
        this.add_child(this._rows);
        this.visible = false;
    }

    /**
     * @param {Array<{id, severity, text, actionLabel}>} notices
     * @param {function(string): void} onAction given the notice's id
     * @param {function(string): ?object} outcomeFor the answer for that id
     */
    update(notices, onAction, outcomeFor) {
        this._rows.destroy_all_children();
        this.visible = notices.length > 0;
        for (const notice of notices) {
            const row = new NoticeRow(notice, () => onAction(notice.id));
            row.setOutcome(outcomeFor(notice.id));
            this._rows.add_child(row);
        }
    }
});
