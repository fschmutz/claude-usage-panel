// The one St construction the Shell versions this extension supports disagree
// on. `vertical: true` is deprecated from Shell 48 (a warning per widget) in
// favour of `orientation`, which does not exist before 48. Pick by what the
// running Shell's St.BoxLayout actually has, once.

import Clutter from 'gi://Clutter';
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
