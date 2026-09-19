// Small St helpers shared by the dropdown's sections: the one construction the
// Shell versions this extension supports disagree on, plus the two text-fitting
// calls that keep long lines from setting the popup's width.
//
// `vertical: true` is deprecated from Shell 48 (a warning per widget) in
// favour of `orientation`, which does not exist before 48. Pick by what the
// running Shell's St.BoxLayout actually has, once.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

const HAS_ORIENTATION = St.BoxLayout.find_property('orientation') !== null;

/** A vertical St.BoxLayout, whatever the Shell version calls it. */
export function vbox(props = {}) {
    return new St.BoxLayout(HAS_ORIENTATION
        ? {orientation: Clutter.Orientation.VERTICAL, ...props}
        : {vertical: true, ...props});
}

/** The constructor props for a vertical box, for subclasses calling super._init. */
export function vboxProps(props = {}) {
    return HAS_ORIENTATION
        ? {orientation: Clutter.Orientation.VERTICAL, ...props}
        : {vertical: true, ...props};
}

/**
 * Let a label wrap instead of dictating the dropdown's width. A long reset or
 * forecast line is what used to stretch the popup past its own progress bars,
 * which made every percentage read against a different track length.
 */
export function wrapLabel(label) {
    label.x_expand = true;
    const text = label.clutter_text;
    text.line_wrap = true;
    text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

/** Cut a one-line label (a name, an email) at the edge rather than widen the popup. */
export function clipLabel(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}
