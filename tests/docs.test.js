// The docs make claims about the code: which jobs feed ci-gate, which files
// each port has, how the release zip is built, which terminal autodetect
// picks. Every one of them drifted once while nothing went red, so each claim
// that can be read back from the tree is asserted here against the tree.
//
// Also the one workflow rule zizmor does not enforce: the workflow-level
// `permissions:` must grant no write scope (zizmor 1.30 reports a
// workflow-level `contents: write` as "No findings").
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {TERMINALS} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = 'claude-usage-panel@fschmutz.github.io';
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir))
    .filter(f => f.endsWith(ext) && fs.statSync(path.join(ROOT, dir, f)).isFile())
    .sort();
const exists = rel => fs.existsSync(path.join(ROOT, rel));

/** Lines of the top-level `permissions:` block of a workflow, or null when absent. */
export function workflowPermissions(yaml) {
    const lines = yaml.split('\n');
    const i = lines.findIndex(l => /^permissions:/.test(l));
    if (i < 0)
        return null;
    const inline = lines[i].replace(/^permissions:\s*/, '').replace(/\s*#.*$/, '');
    if (inline)
        return [inline];
    const out = [];
    for (const l of lines.slice(i + 1)) {
        if (/^\s*(#.*)?$/.test(l))
            continue;
        if (!/^\s/.test(l))
            break;
        out.push(l.trim().replace(/\s*#.*$/, ''));
    }
    return out;
}

/** True when a top-level permissions block grants nothing beyond read. */
export function grantsNoWrite(perms) {
    if (perms === null)
        return false;
    if (perms.length === 1 && perms[0] === '{}')
        return true;
    if (perms.length === 1 && /^(read-all|write-all)$/.test(perms[0]))
        return perms[0] === 'read-all';
    return perms.length > 0 && perms.every(p => /^[a-z-]+:\s*(read|none)$/.test(p));
}

test('workflowPermissions/grantsNoWrite classify the shapes', () => {
    const wf = body => `on: push\n${body}\njobs:\n  a:\n    runs-on: x\n`;
    assert.equal(grantsNoWrite(workflowPermissions(wf('permissions: {}'))), true);
    assert.equal(grantsNoWrite(workflowPermissions(wf('permissions:\n  contents: read'))), true);
    assert.equal(grantsNoWrite(workflowPermissions(wf('permissions:\n  contents: write'))), false);
    assert.equal(grantsNoWrite(workflowPermissions(wf('permissions:\n  contents: read\n  pages: write'))), false);
    assert.equal(grantsNoWrite(workflowPermissions(wf('permissions: write-all'))), false);
    assert.equal(grantsNoWrite(workflowPermissions(wf(''))), false);
});

test('no workflow grants a write scope at the workflow level', () => {
    const files = list('.github/workflows', '.yml');
    assert.ok(files.length > 0);
    for (const f of files) {
        const perms = workflowPermissions(read(`.github/workflows/${f}`));
        assert.ok(grantsNoWrite(perms),
            `${f}: workflow-level permissions ${JSON.stringify(perms)} - use {} or read-only, write on the job`);
    }
});

test('wiki/CI.md fan-in diagram names exactly the jobs ci-gate needs', () => {
    const needs = read('.github/workflows/ci.yml').match(/^\s+needs:\s*\[([^\]]+)\]/m);
    assert.ok(needs, 'ci-gate needs: not found');
    const jobs = needs[1].split(',').map(s => s.trim()).sort();
    const diagram = read('wiki/CI.md').match(/```text\n([\s\S]*?ci-gate[\s\S]*?)```/);
    assert.ok(diagram, 'CI.md diagram not found');
    const shown = [...diagram[1].matchAll(/^([a-z0-9-]+)\b/gm)].map(m => m[1]).sort();
    assert.deepEqual(shown, jobs);
});

test('wiki/Architecture.md Quality names every non-hygiene pre-commit hook', () => {
    const cfg = read('.pre-commit-config.yaml');
    const blocks = cfg.split(/\n\s+- repo:\s*/).slice(1);
    const ids = blocks
        .filter(b => !b.startsWith('https://github.com/pre-commit/pre-commit-hooks'))
        .flatMap(b => [...b.matchAll(/^\s+- id:\s*([\w-]+)/gm)].map(m => m[1]));
    assert.ok(ids.length > 5);
    const quality = read('wiki/Architecture.md').split('## Quality')[1] ?? '';
    for (const id of ids)
        assert.ok(quality.includes(`\`${id}\``), `Architecture Quality misses hook ${id}`);
});

test('PUBLISHING.md rebuilds the GNOME zip the way release.yml does', () => {
    const pub = read('PUBLISHING.md');
    assert.match(read('.github/workflows/release.yml'), /scripts\/pack-gnome\.sh/);
    assert.match(pub, /^scripts\/pack-gnome\.sh /m);
    const blocks = [...pub.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]).join('\n');
    assert.doesNotMatch(blocks, /gnome-extensions pack/);
});

test('README translation row matches the catalogs and names the one translated client', () => {
    const catalogs = list(`${EXT}/po`, '.po');
    const row = read('README.md').split('\n').find(l => /translations/i.test(l) && l.startsWith('|'));
    assert.ok(row, 'translation row not found');
    assert.match(row, /GNOME/);
    const n = Number(row.match(/English \+ (\d+) translations/)?.[1]);
    assert.equal(n, catalogs.length);
    const names = row.match(/translations \(([^)]+)\)/)[1].split(',');
    assert.equal(names.length, catalogs.length);
});

test('README roadmap does not list a shipped Homebrew cask as open', () => {
    if (!exists('Casks/claude-usage-panel.rb'))
        return;
    const open = read('README.md').split('\n').filter(l => l.startsWith('- [ ]'));
    for (const l of open)
        assert.doesNotMatch(l, /cask/i);
});

test('terminal autodetect order in the docs matches pickTerminal', () => {
    // x-terminal-emulator and xdg-terminal-exec sit in TERMINALS for their
    // argv, but the docs name them in the desktop-default step before the list.
    const desktopStep = ['xdg-terminal-exec', 'x-terminal-emulator'];
    const bins = TERMINALS.map(t => t.bin).filter(b => !desktopStep.includes(b));
    for (const doc of ['docs/GNOME.md', 'wiki/Settings.md']) {
        const text = read(doc).replace(/\s+/g, ' ');
        const at = text.indexOf('`$TERMINAL`, then the desktop\'s default terminal (`xdg-terminal-exec`, then `x-terminal-emulator`), then the first installed of');
        assert.ok(at >= 0, `${doc}: autodetect sentence missing the desktop-default step`);
        assert.ok(text.includes(`installed of ${bins.join(', ')}`), `${doc}: terminal list order differs from TERMINALS`);
    }
});

test('cost docs match whether a client falls back to a downloaded ccusage', () => {
    const npx = /'npx'|"npx"/.test(read(`${EXT}/lib/cost.js`))
        || /"npx"/.test(read('macos/Sources/ClaudeUsagePanel/Cost.swift'));
    const sec = read('SECURITY.md');
    if (npx) {
        assert.match(sec, /npm registry/);
        assert.doesNotMatch(sec, /No telemetry, no third-party servers/);
        return;
    }
    assert.match(sec, /no download-and-run fallback/);
    for (const doc of ['SECURITY.md', 'docs/GNOME.md', 'wiki/Troubleshooting.md'])
        assert.doesNotMatch(read(doc), /npx/, `${doc} still points at an npx ccusage`);
});

test('CONTRIBUTING.md names the real normalizer copies and every top-level dir', () => {
    const c = read('CONTRIBUTING.md');
    const para = c.split('\n\n').find(p => p.includes('normalization contract'));
    assert.ok(para);
    for (const f of ['lib/pure/usage.js', 'claude-code/normalize.js', 'Model.swift'])
        assert.ok(para.includes(f), `normalizer copy ${f} not named`);
    assert.doesNotMatch(para, /mcp\/server\.js/);
    const layout = c.match(/## Layout\n\n```text\n([\s\S]*?)```/)[1];
    const dirs = fs.readdirSync(ROOT, {withFileTypes: true})
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules'
            && fs.readdirSync(path.join(ROOT, d.name)).length > 0)
        .map(d => d.name);
    for (const d of dirs)
        assert.ok(layout.includes(`${d}/`), `CONTRIBUTING layout misses ${d}/`);
});

test('CLAUDE.md names every pure/ module and every ClaudeUsageCore file', () => {
    const md = read('CLAUDE.md');
    const barrel = md.match(/lib\/pure\/\{([^}]+)\}\.js/);
    assert.ok(barrel, 'pure/ barrel list not found');
    const named = barrel[1].split(',').map(s => s.trim()).sort();
    assert.deepEqual(named, list(`${EXT}/lib/pure`, '.js').map(f => f.replace(/\.js$/, '')));
    for (const f of list('macos/Sources/ClaudeUsageCore', '.swift'))
        assert.ok(md.includes(`\`${f}\``), `CLAUDE.md misses ClaudeUsageCore/${f}`);
});

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('wiki/Architecture.md tree names every source file of every port', () => {
    const tree = read('wiki/Architecture.md').match(/```text\n([\s\S]*?)```/)[1];
    const dirs = [
        [`${EXT}/lib`, '.js'], [`${EXT}/lib/pure`, '.js'],
        ['macos/Sources/ClaudeUsageCore', '.swift'], ['macos/Sources/ClaudeUsagePanel', '.swift'],
        ['claude-code', '.js'], ['mcp', '.js'], ['scripts/install', '.sh'],
    ];
    for (const [dir, ext] of dirs) {
        for (const f of list(dir, ext))
            assert.match(tree, new RegExp(`(^|[\\s/])${escapeRegExp(f)}\\b`), `Architecture tree misses ${dir}/${f}`);
    }
    assert.doesNotMatch(tree, /~\d+ lines/, 'line-count estimates go stale; drop them');
});

test('every forecast copy is named where the docs pin forecast.json', () => {
    const copies = [
        ...[`${EXT}/lib/pure`, 'claude-code'].flatMap(dir => list(dir, '.js')
            .filter(f => /export function forecast\(/.test(read(`${dir}/${f}`)))
            .map(f => `${dir.replace(`${EXT}/`, '')}/${f}`)),
        ...list('macos/Sources/ClaudeUsageCore', '.swift')
            .filter(f => /func forecast\(/.test(read(`macos/Sources/ClaudeUsageCore/${f}`))),
    ];
    assert.ok(copies.length >= 3);
    const arch = read('wiki/Architecture.md').split('\n\n').find(p => p.includes('forecast.json'));
    const claude = read('CLAUDE.md').replace(/\s+/g, ' ');
    const around = claude.slice(claude.indexOf('`tests/fixtures/forecast.json` pins'), claude.indexOf('`tests/fixtures/forecast.json` pins') + 200);
    for (const c of copies) {
        assert.ok(arch.includes(c), `Architecture forecast paragraph misses ${c}`);
        assert.ok(around.includes(c), `CLAUDE.md forecast.json line misses ${c}`);
    }
    assert.doesNotMatch(around, /four ports/);
});
