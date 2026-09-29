// The Integrations tab: session cost, Cursor spend, OpenAI Codex.
// Split out of prefs.js by tab: `prefs` is the ExtensionPreferences
// instance, for its path, its cancellable and `_closed()` (see prefs.js).

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {storeSecret, lookupSecret} from '../lib/secretStore.js';

export function buildCost(prefs, settings) {
    const cost = new Adw.PreferencesGroup({
        title: _('Cost'),
        description: _('The official API does not expose dollar cost on subscription plans. Enable this to compute it locally with ccusage (requires ccusage installed: npm i -g ccusage).'),
    });
    const costRow = new Adw.SwitchRow({
        title: _('Show session cost'),
        subtitle: _('Runs `ccusage blocks --active` on each refresh'),
    });
    settings.bind('show-cost', costRow, 'active', 0);
    cost.add(costRow);
    return cost;
}

export function buildCursor(prefs, settings) {
    const cursor = new Adw.PreferencesGroup({
        title: _('Cursor (optional)'),
        description: _('Show Cursor team spend using the Cursor Admin API. Create a key at cursor.com → team → Settings → Admin API. Stored in the system keyring.'),
    });
    const cursorRow = new Adw.SwitchRow({
        title: _('Show Cursor usage'),
        subtitle: _('Adds a Cursor spend section to the dropdown'),
    });
    settings.bind('cursor-enabled', cursorRow, 'active', 0);
    cursor.add(cursorRow);

    // The key lives in the system keyring (libsecret). The dconf slot is
    // only a legacy source (migrated by the extension) and a fallback for
    // systems without a Secret Service. Stored on Apply (or Enter), not per
    // keystroke: each store is a keyring write plus an extension poll.
    const keyRow = new Adw.PasswordEntryRow({title: _('Cursor Admin API key')});
    keyRow.set_show_apply_button(true);
    lookupSecret('cursor-admin-api-key').then(stored => {
        if (prefs._closed())
            return;
        keyRow.text = stored ?? settings.get_string('cursor-api-key');
    });
    keyRow.connect('apply', row => {
        storeSecret('cursor-admin-api-key', row.text).then(ok => {
            if (ok) {
                // Scrub any legacy cleartext copy and nudge the running
                // extension (the stamp carries no secret).
                if (settings.get_string('cursor-api-key'))
                    settings.set_string('cursor-api-key', '');
                settings.set_string('cursor-key-stamp', String(Date.now()));
            } else {
                // No Secret Service on this system: keep the old dconf
                // path so the feature still works.
                settings.set_string('cursor-api-key', row.text);
            }
        });
    });
    cursor.add(keyRow);
    return cursor;
}

export function buildCodex(prefs, settings) {
    const codex = new Adw.PreferencesGroup({
        title: _('OpenAI Codex (optional)'),
        description: _('A sibling section for the ChatGPT logins the codex CLI holds: save them under a name and switch without a browser. Off by default - with it off, nothing under the Codex home is read. Reads auth.json (and the read-only session transcripts) from $CODEX_HOME, else ~/.codex; saved copies are kept mode 0600 next to, never inside, the Claude store. Nothing is uploaded, and no token is ever minted here.'),
    });
    const row = new Adw.SwitchRow({
        title: _('Show saved Codex logins'),
        subtitle: _('Adds an OpenAI Codex section below the Claude ones'),
    });
    settings.bind('codex-enabled', row, 'active', 0);
    codex.add(row);
    // The honesty note belongs where the feature is turned on, not only in
    // the dropdown: a percentage nobody can refresh needs saying twice.
    codex.add(new Adw.ActionRow({
        title: _('Usage figures are est.'),
        subtitle: _('OpenAI publishes no plan-usage endpoint, so the percentages shown are the ones the codex CLI recorded when the API last returned them, stamped with when. Manage the logins with `claudectl codex`.'),
    }));
    return codex;
}
