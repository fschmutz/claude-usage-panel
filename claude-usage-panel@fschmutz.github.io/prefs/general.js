// The General tab's behaviour group: what the top bar shows, how often it
// polls, the alerts and the event command.
// Split out of prefs.js by tab: `prefs` is the ExtensionPreferences
// instance, for its path, its cancellable and `_closed()` (see prefs.js).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export function buildBehavior(prefs, settings) {
    const behavior = new Adw.PreferencesGroup({
        title: _('Behavior'),
        description: _('How often to poll the Claude usage endpoint.'),
    });

    // Refresh interval (minutes, mapped to seconds in the setting).
    const intervalRow = new Adw.SpinRow({
        title: _('Refresh interval'),
        subtitle: _(
            'Minutes between updates (min 1). Idle windows back off to 15 minutes, ' +
            'and a poll always lands just after a reset, on wake and when the ' +
            'network returns.'),
        adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
    });
    intervalRow.set_value(Math.max(1, Math.round(settings.get_int('refresh-interval') / 60)));
    intervalRow.connect('notify::value', row =>
        settings.set_int('refresh-interval', Math.round(row.get_value()) * 60));
    behavior.add(intervalRow);

    // Panel display mode.
    const modeRow = new Adw.ComboRow({
        title: _('Top bar shows'),
        subtitle: _('Which limit to display in the panel'),
        model: Gtk.StringList.new([_('Worst limit'), _('Current session')]),
    });
    modeRow.set_selected(settings.get_string('panel-mode') === 'session' ? 1 : 0);
    modeRow.connect('notify::selected', row =>
        settings.set_string('panel-mode', row.get_selected() === 1 ? 'session' : 'worst'));
    behavior.add(modeRow);

    const alertsRow = new Adw.SwitchRow({
        title: _('Limit-crossing alerts'),
        subtitle: _('Notify when a limit reaches 90% or 100%'),
    });
    settings.bind('alerts-enabled', alertsRow, 'active', 0);
    behavior.add(alertsRow);

    // Run something of your own at the two moments worth acting on. Values
    // are shell-quoted when substituted, so a label from the API cannot
    // turn into part of the command.
    const commandRow = new Adw.EntryRow({
        title: _('Run on limit crossing or reset'),
    });
    commandRow.set_show_apply_button(true);
    commandRow.set_text(settings.get_string('event-command'));
    commandRow.connect('apply', row =>
        settings.set_string('event-command', row.get_text().trim()));
    behavior.add(commandRow);

    const commandHelp = new Adw.ActionRow({
        title: _('Placeholders'),
        subtitle: _(
            '%e event (threshold or reset) · %l label · %p percent · ' +
            '%t threshold · %k key · %% a literal %. Empty disables it. ' +
            'Example: notify-send "Claude %l" "%e at %p%%"'),
    });
    commandHelp.add_css_class('dim-label');
    behavior.add(commandHelp);
    return behavior;
}
