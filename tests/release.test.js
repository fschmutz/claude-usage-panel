// Releases: the version the commits imply (scripts/release-version.mjs) and
// scripts/release.sh, which tags only a commit whose ci-gate is green. The
// script runs for real against a throwaway repo and a local bare origin, with
// gh stubbed (its ci-gate answers scripted per commit) and bump-version.sh
// stubbed (tested on its own in cask.test.js); nothing reaches GitHub.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {commitKind, compareVersions, nextVersion} from '../scripts/release-version.mjs';
import {run, sandboxHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ENV = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};

// ── The version the commits imply ───────────────────────────────────────────

test('commitKind: breaking is major, feat minor, anything else patch', () => {
    assert.equal(commitKind('feat(cli)!: drop the old flags'), 'major');
    assert.equal(commitKind('fix: x\n\nBREAKING CHANGE: the cache moved'), 'major');
    assert.equal(commitKind('feat(cli): session focus'), 'minor');
    for (const m of ['fix(pause): lock', 'refactor: split', 'docs: wiki', 'not conventional']) {
        assert.equal(commitKind(m), 'patch', m);
    }
});

test('nextVersion: the highest kind wins, release commits never count', () => {
    assert.deepEqual(nextVersion('3.5.0', ['fix: a', 'feat(cli): b', 'docs: c']),
        {version: '3.6.0', kind: 'minor', why: ['feat(cli): b']});
    assert.equal(nextVersion('3.5.0', ['fix: a']).version, '3.5.1');
    assert.equal(nextVersion('3.5.2', ['feat!: a', 'feat: b']).version, '4.0.0');
    assert.equal(nextVersion('3.5.0', ['chore(release): v3.5.0', '  ']), null);
    assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(compareVersions('3.5.0', '3.5.0'), 0);
});

// ── scripts/release.sh ──────────────────────────────────────────────────────

/**
 * A repo whose main is pushed to a bare origin and tagged v1.0.0, holding
 * the real release.sh + release-version.mjs. `ci(sha, ...states)` scripts
 * the answers gh gives for that commit's ci-gate, one per call (the last
 * repeats); an unscripted commit answers "none".
 */
function world(t) {
    const io = sandboxHome(t, {prefix: 'cup-rel-'});
    const dir = io.home;
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'work');
    const ciDir = path.join(dir, 'ci');
    const bin = path.join(dir, 'bin');
    const git = (...args) => execFileSync('git', ['-C', work, ...args], {encoding: 'utf8', env: GIT_ENV}).trim();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], {env: GIT_ENV});
    fs.mkdirSync(path.join(work, 'scripts'), {recursive: true});
    fs.mkdirSync(ciDir);
    fs.mkdirSync(bin);
    for (const f of ['release.sh', 'release-version.mjs']) {
        fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(work, 'scripts', f));
    }
    fs.chmodSync(path.join(work, 'scripts', 'release.sh'), 0o755);
    fs.writeFileSync(path.join(work, 'scripts', 'bump-version.sh'), `#!/bin/sh
sed -i.bak "s/\\"version\\": \\"[^\\"]*\\"/\\"version\\": \\"$1\\"/" package.json && rm package.json.bak
printf '## [Unreleased]\\n\\n## [%s]\\n' "$1" > CHANGELOG.new && sed 1d CHANGELOG.md >> CHANGELOG.new && mv CHANGELOG.new CHANGELOG.md
`, {mode: 0o755});
    fs.writeFileSync(path.join(work, 'package.json'), '{"version": "1.0.0"}\n');
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), '## [Unreleased]\n\n## [1.0.0]\n');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "repo view") echo me/repo; exit 0 ;;
esac
sha=$(printf '%s' "$2" | sed -n 's#.*/commits/\\([0-9a-f]*\\)/check-runs.*#\\1#p')
f="${ciDir}/$sha"
[ -f "$f" ] || { echo none; exit 0; }
head -1 "$f"
[ "$(wc -l < "$f")" -gt 1 ] && sed -i.bak 1d "$f" && rm -f "$f.bak"
exit 0
`, {mode: 0o755});
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('remote', 'add', 'origin', origin);
    git('add', '-A');
    git('commit', '-qm', 'chore(release): v1.0.0');
    git('tag', 'v1.0.0');
    git('push', '-q', 'origin', 'main', 'v1.0.0');
    const ci = (sha, ...states) => fs.writeFileSync(path.join(ciDir, sha), `${states.join('\n')}\n`);
    const work_ = (subject, entry = '- something') => {
        fs.writeFileSync(path.join(work, 'CHANGELOG.md'),
            fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8').replace('## [Unreleased]\n', `## [Unreleased]\n\n${entry}\n`));
        fs.appendFileSync(path.join(work, 'file.txt'), `${subject}\n`);
        git('add', '-A');
        git('commit', '-qm', subject);
        git('push', '-q', 'origin', 'main');
        return git('rev-parse', 'HEAD');
    };
    const release = (...args) => run('bash', [path.join(work, 'scripts', 'release.sh'), ...args], {
        cwd: work,
        env: {...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, CUP_PUSH: 'git push -q', CUP_CI_POLL: '0', CUP_CI_TIMEOUT: '2'},
    });
    const remoteTag = (tag) => execFileSync('git', ['-C', origin, 'tag', '--list', tag], {encoding: 'utf8', env: GIT_ENV}).trim();
    return {work, git, ci, work_, release, remoteTag};
}

test('release.sh tags only after ci-gate is green on the release commit', (t) => {
    const w = world(t);
    w.ci(w.work_('feat: a feature'), 'completed:success');
    const r0 = w.release('--dry-run');
    assert.equal(r0.status, 0, r0.stderr);
    assert.match(r0.stdout, /v1\.0\.0 -> v1\.1\.0 \(minor\)/);
    // the release commit is CI's next answer: running, then green
    const r = w.release('1.1.0');
    assert.notEqual(r.status, 0, 'the release commit has no ci-gate yet: untagged');
    assert.match(r.stderr, /still none after 2s: left untagged/);
    assert.equal(w.remoteTag('v1.1.0'), '');
    assert.equal(w.git('log', '-1', '--format=%s'), 'chore(release): v1.1.0', 'committed and pushed');

    w.ci(w.git('rev-parse', 'HEAD'), 'in_progress:', 'completed:success');
    const resumed = w.release();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /resuming v1\.1\.0/);
    assert.match(resumed.stdout, /v1\.1\.0 tagged on green/);
    assert.equal(w.remoteTag('v1.1.0'), 'v1.1.0');
});

test('release.sh stops untagged on a red release commit', (t) => {
    const w = world(t);
    w.ci(w.work_('fix: a fix'), 'completed:success');
    const head = w.git('rev-parse', 'HEAD');
    // whatever commit comes next is red: script it once it exists
    const r = w.release('1.0.1');
    assert.notEqual(r.status, 0);
    w.ci(w.git('rev-parse', 'HEAD'), 'completed:failure');
    const red = w.release();
    assert.notEqual(red.status, 0);
    assert.match(red.stderr, /is failure: left untagged/);
    assert.equal(w.remoteTag('v1.0.1'), '');
    assert.notEqual(w.git('rev-parse', 'HEAD'), head);
});

test('release.sh refuses what CI has not passed, a version below the commits, an empty changelog', (t) => {
    const w = world(t);
    const sha = w.work_('feat: new');
    w.ci(sha, 'in_progress:');
    assert.match(w.release('--dry-run').stderr, /ci-gate on HEAD is 'in_progress:', not green/);
    w.ci(sha, 'completed:success');
    assert.match(w.release('1.0.1', '--dry-run').stderr, /v1\.0\.1 is below what the commits since v1\.0\.0 imply \(v1\.1\.0, minor\)/);
    assert.match(w.release('1.0.0', '--dry-run').stderr, /not above the last release/);

    fs.writeFileSync(path.join(w.work, 'stray'), 'x');
    assert.match(w.release('--dry-run').stderr, /working tree is not clean/);
    fs.rmSync(path.join(w.work, 'stray'));

    w.git('commit', '-q', '--allow-empty', '-m', 'fix: local only');
    assert.match(w.release('--dry-run').stderr, /HEAD is not origin\/main/);
    w.git('push', '-q', 'origin', 'main');
    w.ci(w.git('rev-parse', 'HEAD'), 'completed:success');
    fs.writeFileSync(path.join(w.work, 'CHANGELOG.md'), '## [Unreleased]\n\n## [1.0.0]\n');
    w.git('commit', '-qam', 'docs: changelog emptied');
    w.git('push', '-q', 'origin', 'main');
    w.ci(w.git('rev-parse', 'HEAD'), 'completed:success');
    assert.match(w.release('--dry-run').stderr, /\[Unreleased\] is empty/);
});

test('release.yml refuses a tag whose commit is not ci-gate green, with checks: read', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const guard = yml.indexOf('Refuse a tag whose commit is not ci-gate green');
    assert.ok(guard > 0);
    assert.ok(guard < yml.indexOf('- uses: actions/checkout'), 'before anything is built');
    assert.match(yml, /checks: read/);
    assert.match(yml.slice(guard), /check-runs\?check_name=ci-gate/);
});
