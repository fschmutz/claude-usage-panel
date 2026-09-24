// lib/cursorSection.js: the Cursor section's keyring gate, loaded under
// plain node through the GJS stubs (tests/gjs-stub.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {load, stub} from './gjs-stub.js';

// ── The Cursor section stays off the keyring while it is off ────────────────

async function cursorController({enabled, secret = null}) {
    const lookups = [];
    stub.overrides['gi://Secret'] = {
        password_lookup: (_schema, attrs, _c, cb) => { lookups.push(attrs.name); cb(null, null); },
        password_lookup_finish: () => secret,
        password_store: (_s, _a, _c, _l, _v, _cn, cb) => cb(null, null),
        password_store_finish: () => true,
    };
    const {CursorController} = await load('lib/cursorSection.js');
    const settings = {
        get_boolean: k => (k === 'cursor-enabled' ? enabled : false),
        get_string: () => '',
        set_string: () => {},
    };
    const ctl = new CursorController({
        settings, session: {}, menu: {addMenuItem: () => {}}, isDestroyed: () => false,
    });
    return {ctl, lookups};
}

test('Cursor disabled: refresh() never touches the keyring', async t => {
    t.after(() => { stub.overrides = {}; });
    const {ctl, lookups} = await cursorController({enabled: false});
    await ctl.refresh();
    await ctl.refresh();
    assert.deepEqual(lookups, []);
    assert.equal(ctl._item.visible, false);
});

test('Cursor enabled: refresh() reads the key from the keyring', async t => {
    t.after(() => { stub.overrides = {}; });
    const {ctl, lookups} = await cursorController({enabled: true});
    await ctl.refresh();
    assert.deepEqual(lookups, ['cursor-admin-api-key']);
    assert.equal(ctl._item.visible, false, 'no key anywhere - still hidden');
});
