// The amber strip under the dropdown's header while the scheduled autosave is
// paused (`claudectl session autosave pause`): the newest snapshot is frozen
// until the next boot, which is easy to forget. Hidden otherwise. The macOS
// twin is AutosavePauseBanner.swift; the top-bar gauge carries a pause mark too.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatClock} from './pure.js';
import {vbox} from './widgets.js';

export const AutosaveBanner = GObject.registerClass(
class AutosaveBanner extends St.BoxLayout {
    /** @param {() => void} onResume the Resume button */
    _init(onResume) {
        super._init({style_class: 'cu-autosave-banner', x_expand: true, visible: false});
        this.add_child(new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'cu-autosave-banner-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const text = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: _('Autosave paused'), style_class: 'cu-autosave-banner-title'}));
        this._detail = new St.Label({text: '', style_class: 'cu-autosave-banner-detail'});
        text.add_child(this._detail);
        this.add_child(text);
        const resume = new St.Button({
            label: _('Resume'),
            style_class: 'cu-autosave-banner-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        resume.connect('clicked', () => onResume());
        this.add_child(resume);
    }

    /** @param {{paused: boolean, since: number|null}} pause */
    update({paused, since}) {
        this.visible = paused;
        if (!paused)
            return;
        this._detail.text = since === null
            ? _('until restart - Reopen keeps the newest snapshot')
            : _('since %s, until restart - Reopen keeps the newest snapshot').format(formatClock(since));
    }
});
