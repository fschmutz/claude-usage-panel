// Hover titles for the header's icon buttons. St has no tooltip of its own and
// the buttons carry no text, so without one the row is three mystery glyphs.
// One shared label in the UI group, moved under whichever button is hovered;
// the same text is the button's accessible name, which is what a screen reader
// and the keyboard path get.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Gap between the button's bottom edge and the label, in CSS pixels. */
const GAP = 6;

let tip = null;

function label() {
    if (!tip) {
        tip = new St.Label({style_class: 'cu-tooltip', visible: false});
        Main.layoutManager.uiGroup.add_child(tip);
    }
    return tip;
}

function show(actor, text) {
    if (!text || !actor.get_stage())
        return;
    const t = label();
    t.text = text;
    t.show();
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    // The label has just been given its text, so ask for its natural width
    // rather than the allocation it does not have yet.
    const [, width] = t.get_preferred_width(-1);
    const monitor = Main.layoutManager.findMonitorForActor(actor)
        ?? Main.layoutManager.primaryMonitor;
    let left = Math.round(x + w / 2 - width / 2);
    if (monitor)
        left = Math.max(monitor.x, Math.min(left, monitor.x + monitor.width - width));
    t.set_position(left, Math.round(y + h + GAP));
}

/** Hide the shared label, whichever button was showing it. */
export function hideTooltip() {
    tip?.hide();
}

/**
 * Give a button a hover title and an accessible name.
 * @param {St.Button} actor
 * @param {string} text
 */
export function addTooltip(actor, text) {
    actor.accessible_name = text;
    actor.connect('notify::hover',
        () => (actor.hover ? show(actor, actor.accessible_name) : hideTooltip()));
    actor.connect('destroy', () => hideTooltip());
}

/** Change a button's title - the toggle's says which state it is in. */
export function setTooltip(actor, text) {
    actor.accessible_name = text;
    if (actor.hover)
        show(actor, text);
}

/** Drop the shared label; the UI group outlives the extension. */
export function destroyTooltip() {
    tip?.destroy();
    tip = null;
}
