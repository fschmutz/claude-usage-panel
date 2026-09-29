// prefs.js and the GSettings schema: the texts the preferences show match
// what the code does, and the schema describes what it stores.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'claude-usage-panel@fschmutz.github.io');
const read = rel => fs.readFileSync(path.join(EXT, rel), 'utf8');
// prefs.js is the tab dispatcher; the groups are built under prefs/.
const prefsSources = () => ['prefs.js', ...fs.readdirSync(path.join(EXT, 'prefs'))
    .filter(f => f.endsWith('.js')).sort().map(f => `prefs/${f}`)].map(read).join('\n');

// ── Preferences texts describe what the code does ────────────────────────────
test('the cost row names the installed ccusage, not Node/npx', () => {
    const prefs = prefsSources();
    assert.match(prefs, /requires ccusage installed: npm i -g ccusage/);
    assert.doesNotMatch(prefs, /Node\/npx/);
    // lib/cost.js runs only an installed ccusage - the text is true of it.
    const cost = read('lib/cost.js');
    assert.match(cost, /CCUSAGE_ARGV = \['ccusage',/);
    assert.doesNotMatch(cost, /['"]npx['"]/);
});

test('the sessions group points at the Claude config dir, not a fixed ~/.claude', () => {
    const prefs = prefsSources();
    assert.match(prefs, /local transcripts in \$CLAUDE_CONFIG_DIR\/projects \(~\/\.claude\/projects by default\)/);
    assert.doesNotMatch(prefs, /transcripts in ~\/\.claude\/projects\./);
});

test('the history key describes the [epochMs, percent] samples it stores', () => {
    const xml = read('schemas/org.gnome.shell.extensions.claude-usage-panel.gschema.xml');
    const key = /<key name="history"[\s\S]*?<\/key>/.exec(xml)[0];
    assert.match(key, /\[epochMs, percent\] samples/);
    assert.doesNotMatch(key, /recent percentages/);
});

test('prefs.js imports every tab builder under prefs/, and each one is used', () => {
    const main = read('prefs.js');
    const files = fs.readdirSync(path.join(EXT, 'prefs')).filter(f => f.endsWith('.js')).sort();
    assert.ok(files.length > 0);
    for (const f of files) {
        const exported = [...read(`prefs/${f}`).matchAll(/^export function (\w+)\(/gm)].map(m => m[1]);
        assert.ok(exported.length, f);
        for (const name of exported) {
            assert.match(main, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from './prefs/${f}'`), name);
            assert.match(main, new RegExp(`\\b${name}\\(this`), `${name} is called`);
        }
    }
});
