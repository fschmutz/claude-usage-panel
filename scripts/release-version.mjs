// The version a release must carry, from the commits since the last tag
// (conventional commits): a breaking change ("type!:" or a BREAKING CHANGE
// footer) is a major, a feat a minor, anything else a patch. release.sh uses
// it to refuse a version lower than the commits imply (a feat shipped as a
// patch) and to propose one when none is given.
//
//   git log --format='%s%n%b%n--END--' v3.5.0..HEAD | node scripts/release-version.mjs 3.5.0
//   -> "3.6.0 minor" on stdout, one reason per line on stderr; exit 1 when
//      there is nothing to release.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const HEAD = /^(\w+)(\([^)]*\))?(!)?:\s/;
const RANK = {patch: 0, minor: 1, major: 2};

/** What one commit (subject + body) asks of the version. */
export function commitKind(message) {
  const [subject = '', ...body] = message.split('\n');
  const m = HEAD.exec(subject);
  if (m?.[3] || body.some((l) => /^BREAKING[ -]CHANGE:/.test(l))) return 'major';
  return m?.[1] === 'feat' ? 'minor' : 'patch';
}

/** Is `message` a release commit itself? Those never count. */
const isRelease = (message) => /^chore\(release\):/.test(message);

/**
 * The next version after `last` for these commit messages, the bump kind,
 * and the commits that decided it. null when nothing but release commits
 * landed since `last`.
 */
export function nextVersion(last, messages) {
  const counted = messages.map((m) => m.trim()).filter((m) => m && !isRelease(m));
  if (!counted.length) return null;
  let kind = 'patch';
  for (const m of counted) if (RANK[commitKind(m)] > RANK[kind]) kind = commitKind(m);
  const [maj, min, pat] = last.split('.').map(Number);
  const version = kind === 'major' ? `${maj + 1}.0.0`
    : kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  const why = counted.filter((m) => commitKind(m) === kind).map((m) => m.split('\n')[0]);
  return {version, kind, why};
}

/** -1, 0 or 1: how version `a` compares with `b` (X.Y.Z). */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const last = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(last ?? '')) {
    process.stderr.write('usage: git log --format=%s%n%b%n--END-- vX.Y.Z..HEAD | release-version.mjs X.Y.Z\n');
    process.exit(2);
  }
  const messages = readFileSync(0, 'utf8').split(/^--END--$/m);
  const next = nextVersion(last, messages);
  if (!next) {
    process.stderr.write(`nothing to release since v${last}\n`);
    process.exit(1);
  }
  for (const w of next.why) process.stderr.write(`  ${next.kind}: ${w}\n`);
  process.stdout.write(`${next.version} ${next.kind}\n`);
}
