// The Accounts tab.
// Split out of prefs.js by tab: `prefs` is the ExtensionPreferences
// instance, for its path, its cancellable and `_closed()` (see prefs.js).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {accountSummary, isValidName} from '../lib/pure.js';
import {
    listProfiles, liveAccountName, readLiveAccount, removeProfile, saveCurrent,
} from '../lib/accounts.js';

// ── Saved accounts ──────────────────────────────────────────────────────
// Two groups: the switches (master switch first, everything else hidden
// until it is on) and the list of saved logins, rebuilt after every save
// or remove. A saved login is the credentials Claude Code holds right now
// plus the account block of ~/.claude.json, kept under a name. Switching
// swaps exactly those two; nothing else in ~/.claude changes.
export function buildAccountsGroups(prefs, settings, page) {
    const accounts = new Adw.PreferencesGroup({
        title: _('Accounts'),
        description: _('Save the login Claude Code holds now under a name (PRO, PERSO) and switch between saved logins from the dropdown, no browser needed. Only the credentials and the account block of ~/.claude.json change; settings, hooks, plugins and history stay. Claude Code sessions already running keep the old login until they restart.'),
    });
    page.add(accounts);

    // The master switch. Everything below it is hidden while it is off, so
    // a user who never asked for accounts never sees them.
    const accountsEnableRow = new Adw.SwitchRow({
        title: _('Enable named accounts'),
        subtitle: _('Off by default - nothing account-related is shown until you turn it on'),
    });
    settings.bind('accounts-enabled', accountsEnableRow, 'active', 0);
    accounts.add(accountsEnableRow);

    // An EntryRow has no subtitle, so the "which login is this" line is a
    // row of its own right above it.
    const loginRow = new Adw.ActionRow({title: _('Current login'), subtitle: ''});
    accounts.add(loginRow);
    const saveRow = new Adw.EntryRow({title: _('Save the current login as')});
    const saveBtn = new Gtk.Button({label: _('Save'), valign: Gtk.Align.CENTER});
    saveRow.add_suffix(saveBtn);
    accounts.add(saveRow);
    // An ActionRow doubling as the error line: its title is the message.
    const errorRow = new Adw.ActionRow({title: '', subtitle: ''});
    errorRow.visible = false;
    accounts.add(errorRow);

    const autoRow = new Adw.SwitchRow({
        title: _('Switch accounts automatically'),
        subtitle: _('When the active account reaches the threshold, move to the saved account with the most headroom'),
    });
    settings.bind('accounts-auto-switch', autoRow, 'active', 0);
    accounts.add(autoRow);
    const thresholdRow = new Adw.SpinRow({
        title: _('Auto-switch threshold'),
        subtitle: _('Worst limit percentage that counts as full'),
        adjustment: new Gtk.Adjustment({
            lower: 50, upper: 100, step_increment: 5, page_increment: 10,
        }),
    });
    settings.bind('accounts-switch-threshold', thresholdRow, 'value', 0);
    accounts.add(thresholdRow);
    const menuToggleRow = new Adw.SwitchRow({
        title: _('Show the auto-switch button in the dropdown'),
        subtitle: _('Off hides the auto-switch button from the panel header; the option stays here'),
    });
    settings.bind('accounts-menu-toggle', menuToggleRow, 'active', 0);
    accounts.add(menuToggleRow);
    const showRow = new Adw.SwitchRow({
        title: _('Show the account name in the top bar'),
        subtitle: _('"PRO · Session 42%" - shown once two logins are saved, '
            + 'and only while it fits the bar'),
    });
    settings.bind('panel-show-account', showRow, 'active', 0);
    accounts.add(showRow);

    // One row per saved login, rebuilt after every save or remove.
    const listGroup = new Adw.PreferencesGroup();
    page.add(listGroup);
    for (const w of [loginRow, saveRow, autoRow, thresholdRow, menuToggleRow, showRow, listGroup])
        settings.bind('accounts-enabled', w, 'visible', 0);
    const accountRows = [];
    const renderAccounts = () => {
        accountRows.splice(0).forEach(row => listGroup.remove(row));
        const live = readLiveAccount();
        const active = liveAccountName();
        loginRow.subtitle = live?.emailAddress
            ? (active
                ? _('%s, saved as %s').format(live.emailAddress, active)
                : _('%s (not saved yet)').format(live.emailAddress))
            : _('No Claude Code login found');
        for (const profile of listProfiles()) {
            const a = accountSummary(profile);
            const row = new Adw.ActionRow({
                title: `${profile.name === active ? '● ' : ''}${a.name}`,
                subtitle: [a.email, a.plan, a.tokenState === 'expired'
                    ? _('login expired - sign in and save it again') : null]
                    .filter(x => x).join(' · '),
            });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                has_frame: false,
                tooltip_text: _('Forget this saved login'),
            });
            remove.connect('clicked', () => {
                try {
                    removeProfile(profile.name);
                } catch (e) {
                    errorRow.title = e.message;
                    errorRow.visible = true;
                }
                renderAccounts();
            });
            row.add_suffix(remove);
            listGroup.add(row);
            accountRows.push(row);
        }
    };
    saveBtn.connect('clicked', () => {
        const name = saveRow.text.trim();
        errorRow.visible = false;
        if (!isValidName(name)) {
            errorRow.title = _('Names use letters, digits, . _ - only (up to 32 characters)');
            errorRow.visible = true;
            return;
        }
        try {
            saveCurrent(name);
            saveRow.text = '';
        } catch (e) {
            errorRow.title = e.message;
            errorRow.visible = true;
        }
        renderAccounts();
    });
    saveRow.connect('entry-activated', () => saveBtn.emit('clicked'));
    renderAccounts();
}
