import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildAccountsGroups} from './prefs/accounts.js';
import {buildBehavior} from './prefs/general.js';
import {buildCodex, buildCost, buildCursor} from './prefs/integrations.js';
import {buildPings} from './prefs/pings.js';
import {buildSessions, buildSnapshots} from './prefs/sessions.js';
import {buildUpdates} from './prefs/updates.js';

// One group per concern, each a builder under prefs/ (one file per tab, or
// per large group), handed this instance. Every async continuation that
// touches a widget checks `this._cancellable` first (through `_closed()`):
// the window can be closed while a keyring lookup, a systemctl call or a git
// fetch is still running, and writing to a disposed widget is a GJS error per
// callback.
export default class ClaudeUsagePanelPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        window.connect('close-request', () => {
            this._cancellable.cancel();
            return false;
        });

        // One tab per area; the window shows them as a view switcher.
        const tab = (title, icon) => {
            const page = new Adw.PreferencesPage({title, icon_name: icon});
            window.add(page);
            return page;
        };
        const general = tab(_('General'), 'utilities-system-monitor-symbolic');
        general.add(buildBehavior(this, settings));
        general.add(buildUpdates(this));

        buildAccountsGroups(this, settings, tab(_('Accounts'), 'system-users-symbolic'));

        const sessions = tab(_('Sessions'), 'utilities-terminal-symbolic');
        sessions.add(buildSessions(this, settings));
        sessions.add(buildSnapshots(this));
        buildPings(this, settings, sessions);

        const integrations = tab(_('Integrations'), 'application-x-addon-symbolic');
        integrations.add(buildCost(this, settings));
        integrations.add(buildCursor(this, settings));
        integrations.add(buildCodex(this, settings));
    }

    // True once the window is gone: the continuation must not touch widgets.
    _closed() {
        return this._cancellable.is_cancelled();
    }
}
