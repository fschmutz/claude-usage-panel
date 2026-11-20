// chrome-extension.js: the CRX3 / zip reader and the Preferences entry the
// isolated Chrome profile gets. The end-to-end install is in
// account-chrome.test.js; the real load was proven on Chrome 158 (see the
// module's header).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';

import {compareVersions, crxZip, manifestGrant, settingsEntry, unzip} from '../claude-code/chrome-extension.js';
import {crx} from './accounts-world.js';

test('crx: the zip after the header, every file back; a non-CRX or CRX2 is refused', () => {
  const files = unzip(crxZip(crx({'manifest.json': '{"version":"1.2"}', 'a/b.js': 'x'})));
  assert.deepEqual(files.map((f) => [f.name, f.data.toString()]), [['manifest.json', '{"version":"1.2"}'], ['a/b.js', 'x']]);
  assert.throws(() => crxZip(Buffer.from('PK\x03\x04 not a crx')), /not a CRX file/);
  const v2 = crx({'m': '1'});
  v2.writeUInt32LE(2, 4);
  assert.throws(() => crxZip(v2), /CRX version 2 is not supported/);
  assert.throws(() => unzip(Buffer.from('nothing here at all, no end record')), /not a zip archive/);
});

test('crx: an entry that would leave the extension dir is refused', () => {
  for (const name of ['../evil.js', '/etc/x', 'a/../../b', 'a\\b']) {
    assert.throws(() => unzip(crxZip(crx({[name]: 'x'}))), /unsafe path in zip/, name);
  }
});

test('grant: exactly the API, host and content-script permissions the manifest declares', () => {
  assert.deepEqual(manifestGrant({permissions: ['tabs', 'debugger'], host_permissions: ['<all_urls>'],
    content_scripts: [{matches: ['https://b/*', 'https://a/*']}, {matches: ['https://a/*']}]}),
  {api: ['tabs', 'debugger'], explicit_host: ['<all_urls>'], manifest_permissions: [],
    scriptable_host: ['https://a/*', 'https://b/*']});
  assert.deepEqual(manifestGrant({}), {api: [], explicit_host: [], manifest_permissions: [], scriptable_host: []});
});

test('settings entry: internal, from the Web Store, enabled, Chrome-epoch install time', () => {
  const e = settingsEntry('abc', {version: '1.0.107', permissions: ['tabs']}, 0);
  assert.equal(e.location, 1);
  assert.equal(e.from_webstore, true);
  assert.equal(e.path, 'abc/1.0.107_0');
  assert.deepEqual(e.disable_reasons, []);
  assert.equal(e.first_install_time, '11644473600000000');
  assert.deepEqual(e.granted_permissions, e.active_permissions);
});

test('versions compare numerically', () => {
  assert.ok(compareVersions('1.0.107', '1.0.99') > 0);
  assert.ok(compareVersions('1.2', '1.2.0') === 0);
  assert.ok(compareVersions('0.9', '1') < 0);
});
