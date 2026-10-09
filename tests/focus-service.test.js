// The extension's RaiseWindow (lib/focusService.js), over the GJS stubs: it
// raises the one window whose GTK bus name AND object path both match, and
// nothing else.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {stub} from './gjs-stub.js';

const win = (bus, path) => ({get_gtk_unique_bus_name: () => bus, get_gtk_window_object_path: () => path});

test('findGtkWindow needs both the bus name and the window path to match', async () => {
    const {findGtkWindow} = await import('../claude-usage-panel@fschmutz.github.io/lib/focusService.js');
    const a = win(':1.204', '/org/gnome/Terminal/window/1');
    const b = win(':1.204', '/org/gnome/Terminal/window/2');
    const other = win(':1.300', '/org/gnome/Terminal/window/2');
    const plain = {};
    assert.equal(findGtkWindow([plain, a, other, b], ':1.204', '/org/gnome/Terminal/window/2'), b);
    assert.equal(findGtkWindow([a], ':1.300', '/org/gnome/Terminal/window/1'), null);
    assert.equal(findGtkWindow([a], '', '/org/gnome/Terminal/window/1'), null);
});

test('RaiseWindow activates the matching window and answers whether it found one', async (t) => {
    const raised = [];
    let impl = null;
    let exportedAt = null;
    stub.overrides['gi://Gio'] = {
        DBus: {session: 'session-bus'},
        DBusExportedObject: {
            wrapJSObject: (_xml, obj) => {
                impl = obj;
                return {export: (_bus, p) => (exportedAt = p), unexport: () => (exportedAt = null)};
            },
        },
    };
    stub.overrides['resource:///org/gnome/shell/ui/main.js'] = {activateWindow: (w) => raised.push(w)};
    const b = win(':1.204', '/org/gnome/Terminal/window/2');
    globalThis.global = {get_window_actors: () => [{meta_window: b}]};
    t.after(() => {
        stub.overrides = {};
        delete globalThis.global;
    });
    const {exportFocusService, FOCUS_PATH} = await import('../claude-usage-panel@fschmutz.github.io/lib/focusService.js');
    const unexport = exportFocusService();
    assert.equal(exportedAt, FOCUS_PATH);
    assert.equal(impl.RaiseWindow(':1.204', '/org/gnome/Terminal/window/2'), true);
    assert.deepEqual(raised, [b]);
    assert.equal(impl.RaiseWindow(':1.204', '/org/gnome/Terminal/window/9'), false);
    assert.equal(raised.length, 1);
    unexport();
    assert.equal(exportedAt, null);
});
