// The dropdown's top row: title, plan label, and the controls as small icon
// buttons - auto-switch (only when there is something to switch between),
// refresh, settings. They live up here rather than at the foot of the panel so
// the list below stays one column of data with nothing to scroll past, and
// each carries a hover title (lib/tooltip.js) since an icon alone says little.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {addTooltip, setTooltip} from './tooltip.js';

function iconButton(iconName, title, onClick) {
    const button = new St.Button({
        style_class: 'cu-icon-btn',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName, style_class: 'cu-icon'}),
    });
    addTooltip(button, title);
    button.connect('clicked', onClick);
    return button;
}

export const HeaderBar = GObject.registerClass(
class HeaderBar extends St.BoxLayout {
    /**
     * @param {object} handlers
     * @param {() => void} handlers.onRefresh poll now, without closing the menu
     * @param {() => void} handlers.onSettings open the preferences window
     * @param {() => void} handlers.onAutoSwitch flip the auto-switch setting
     */
    _init({onRefresh, onSettings, onAutoSwitch}) {
        super._init({style_class: 'cu-header', x_expand: true});

        this.add_child(new St.Label({
            text: 'Claude usage',
            style_class: 'cu-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._plan = new St.Label({
            text: '',
            style_class: 'cu-plan',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._plan);

        // Hidden until the accounts section says it has something to switch
        // between; the settings window keeps the toggle either way.
        this._autoSwitch = iconButton(
            'system-switch-user-symbolic', '', () => onAutoSwitch());
        this._autoSwitch.visible = false;
        this.add_child(this._autoSwitch);

        this.add_child(iconButton(
            'view-refresh-symbolic', _('Refresh now'), () => onRefresh()));
        this.add_child(iconButton(
            'emblem-system-symbolic', _('Settings'), () => onSettings()));
    }

    /** @param {string} text the plan name from the API, '' when unknown */
    setPlan(text) {
        this._plan.text = text;
    }

    /**
     * @param {object} state
     * @param {boolean} state.visible there is more than one login to switch between
     * @param {boolean} state.on auto-switch is armed - the button reads as lit
     * @param {string} state.title hover text, which is what says which state it is in
     */
    syncAutoSwitch({visible, on, title}) {
        this._autoSwitch.visible = visible;
        this._autoSwitch.style_class = `cu-icon-btn${on ? ' cu-icon-on' : ''}`;
        setTooltip(this._autoSwitch, title);
    }
});
