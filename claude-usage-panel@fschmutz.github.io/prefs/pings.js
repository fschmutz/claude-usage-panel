// The Sessions tab's scheduled session pings.
// Split out of prefs.js by tab: `prefs` is the ExtensionPreferences
// instance, for its path, its cancellable and `_closed()` (see prefs.js).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {formatLastPing, evaluateWindows, parseHHMM, planWindows} from '../lib/pure.js';
import {isValidPingTime, normalizePingTime} from '../lib/sessionPingUnit.js';
import {applySchedule, hasSystemd, readLastPing, readSchedule} from '../lib/sessionPing.js';

// ── Session pings ───────────────────────────────────────────────────────
// The systemd units on disk are the source of truth, shared with
// ./install.sh sessionping - nothing here is mirrored into GSettings.
// Three groups (switches + status, the ping times, the buttons), because
// the times are rebuilt whenever the list changes and an Adw group has no
// reorderable slot model.
export function buildPings(prefs, settings, page) {
    const pings = new Adw.PreferencesGroup({
        title: _('Session pings'),
        description: _('A 5-hour window is anchored to its first message, so pinging claude (haiku, one turn) at a fixed time lines the day’s windows up with the hours you actually work. Same schedule as ./install.sh sessionping.'),
    });
    const schedule = readSchedule();
    let times = schedule.times.slice();
    const days = new Set(schedule.days);

    const enableRow = new Adw.SwitchRow({
        title: _('Open the 5h session window on schedule'),
        subtitle: hasSystemd()
            ? _('Runs scripts/session-ping.sh from a systemd user timer')
            : _('Needs a systemd user session - use ./install.sh sessionping here'),
    });
    enableRow.active = schedule.enabled;
    enableRow.sensitive = hasSystemd();
    pings.add(enableRow);

    const statusRow = new Adw.ActionRow({title: _('Last ping'), subtitle: ''});
    pings.add(statusRow);

    const coverageRow = new Adw.ActionRow({title: _('Coverage'), subtitle: ''});
    pings.add(coverageRow);

    // The working day, which is the input the suggestion is computed from.
    const dayRow = new Adw.ActionRow({title: _('Working day')});
    const timeEntry = text => new Gtk.Entry({
        text, max_width_chars: 5, width_chars: 5, valign: Gtk.Align.CENTER,
    });
    const startEntry = timeEntry(settings.get_string('work-start'));
    const endEntry = timeEntry(settings.get_string('work-end'));
    dayRow.add_suffix(startEntry);
    dayRow.add_suffix(new Gtk.Label({label: '→', valign: Gtk.Align.CENTER}));
    dayRow.add_suffix(endEntry);
    pings.add(dayRow);

    const daysRow = new Adw.ActionRow({title: _('Days')});
    const dayNames = [_('Mon'), _('Tue'), _('Wed'), _('Thu'), _('Fri'), _('Sat'), _('Sun')];
    const daysBox = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
    const dayButtons = dayNames.map((name, i) => {
        const btn = new Gtk.ToggleButton({label: name, valign: Gtk.Align.CENTER});
        btn.active = days.has(i + 1);
        daysBox.append(btn);
        return btn;
    });
    daysRow.add_suffix(daysBox);
    pings.add(daysRow);

    // An ActionRow doubling as the error line: its title is the message.
    const errorRow = new Adw.ActionRow({title: '', subtitle: ''});
    errorRow.visible = false;
    pings.add(errorRow);
    page.add(pings);

    const timesGroup = new Adw.PreferencesGroup();
    page.add(timesGroup);
    const timeRows = [];

    const buttonsGroup = new Adw.PreferencesGroup();
    const buttonsRow = new Adw.ActionRow({});
    const addBtn = new Gtk.Button({label: _('Add a ping'), valign: Gtk.Align.CENTER});
    // Stop making the user guess where the chain should start: compute the
    // times that blanket the working day instead.
    const suggestBtn = new Gtk.Button({label: _('Suggest times'), valign: Gtk.Align.CENTER});
    buttonsRow.add_suffix(addBtn);
    buttonsRow.add_suffix(suggestBtn);
    buttonsGroup.add(buttonsRow);
    page.add(buttonsGroup);

    const workDay = () => ({
        startMinute: parseHHMM(startEntry.text) ?? 9 * 60,
        endMinute: parseHHMM(endEntry.text) ?? 18 * 60,
    });

    const renderStatus = () => {
        const last = formatLastPing(readLastPing(), Date.now());
        statusRow.subtitle = last || _('never');
        const plan = evaluateWindows(times, workDay());
        coverageRow.subtitle = plan
            ? _('%d%% of %s-%s covered').format(
                plan.coveragePercent, startEntry.text, endEntry.text)
            : _('no valid times yet');
    };

    const apply = () => {
        applySchedule({
            enabled: enableRow.active,
            times: times.filter(isValidPingTime),
            days: [...days],
            extensionPath: prefs.path,
        }).then(err => {
            if (prefs._closed())
                return;
            errorRow.visible = Boolean(err);
            errorRow.title = err ?? '';
            renderStatus();
        });
    };

    const renderTimes = () => {
        timeRows.splice(0).forEach(row => timesGroup.remove(row));
        times.forEach((time, i) => {
            const row = new Adw.EntryRow({title: _('Ping %d').format(i + 1)});
            row.set_show_apply_button(true);
            row.text = time;
            const remove = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                valign: Gtk.Align.CENTER,
                has_frame: false,
                sensitive: times.length > 1,
            });
            remove.connect('clicked', () => {
                times.splice(i, 1);
                renderTimes();
                apply();
            });
            row.add_suffix(remove);
            // On Apply (or Enter), not per keystroke: every change rewrites
            // two systemd units and reloads the daemon.
            row.connect('apply', entry => {
                const normalized = normalizePingTime(entry.text);
                if (!normalized)
                    return;
                times[i] = normalized;
                entry.text = normalized;
                renderStatus();
                apply();
            });
            timesGroup.add(row);
            timeRows.push(row);
        });
        renderStatus();
    };

    addBtn.connect('clicked', () => {
        times.push('09:00');
        renderTimes();
        apply();
    });
    suggestBtn.connect('clicked', () => {
        times = planWindows(workDay(), Math.max(2, times.length)).pingTimes;
        renderTimes();
        apply();
    });
    for (const entry of [startEntry, endEntry]) {
        entry.connect('changed', () => {
            const start = parseHHMM(startEntry.text);
            const end = parseHHMM(endEntry.text);
            if (start === null || end === null || end <= start)
                return;
            settings.set_string('work-start', startEntry.text);
            settings.set_string('work-end', endEntry.text);
            renderStatus();
        });
    }
    dayButtons.forEach((btn, i) => btn.connect('toggled', () => {
        if (btn.active) {
            days.add(i + 1);
        } else if (days.size > 1) {
            days.delete(i + 1);
        } else {
            btn.active = true; // never leave a schedule with no days
            return;
        }
        apply();
    }));
    enableRow.connect('notify::active', () => apply());
    renderTimes();
}
