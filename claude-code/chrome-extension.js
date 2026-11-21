// Installs the Claude extension into an isolated Chrome profile
// (`claudectl account chrome`), so no human click is needed.
//
// Measured on branded Google Chrome 158, Linux, 2026-11-20, on fresh scratch
// profiles: an extension whose files sit in Default/Extensions/<id>/<ver>_0
// and whose entry sits in Default/Preferences extensions.settings.<id>
// (location 1 = internal, from_webstore, its granted permissions) loads at the
// next start: its service worker runs and it survives relaunches. Without the
// granted permissions it loads disabled (disable_reasons [2]). What does NOT
// work: --load-extension (removed from branded Chrome 137+), an
// "External Extensions/<id>.json" in the user-data-dir (nothing after 60 s),
// the Web Store tab of a fresh profile (consent.google.com first), and system
// policy (root, every profile).
//
// The files come from the user's own main Chrome when one of its profiles
// has the extension (offline, the version they already run), else from the
// Web Store's update service as a CRX3 (a zip after a signed header). The
// grant written is exactly the permissions the extension's manifest declares:
// what clicking "Add to Chrome" grants. Chrome rewrites Preferences when it
// exits, so a profile whose Chrome is running is never touched.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';

import {writeAtomic} from './private-fs.js';

/** Chrome's own extension version grammar: 1 to 4 dotted integers. The version names a folder, so nothing else may reach a path. */
const VERSION_FORM = /^\d{1,9}(?:\.\d{1,9}){0,3}$/;
/** What one file of a downloaded extension may inflate to: a bound against a zip bomb. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function checkedVersion(version) {
  if (typeof version !== 'string' || !VERSION_FORM.test(version)) throw new Error(`the extension's version is not a plain dotted number: ${JSON.stringify(version)}`);
  return version;
}

const CRX_URL = (id, prodversion) => 'https://clients2.google.com/service/update2/crx?response=redirect' +
  `&prodversion=${prodversion}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;

/** Dotted versions compared numerically: >0 when a is newer. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The permissions "Add to Chrome" grants: what the manifest declares. */
export function manifestGrant(manifest) {
  const scriptable = new Set();
  for (const c of manifest.content_scripts ?? []) for (const m of c?.matches ?? []) scriptable.add(m);
  return {
    api: [...(manifest.permissions ?? [])].filter((p) => typeof p === 'string' && !p.includes('://') && p !== '<all_urls>'),
    explicit_host: [...(manifest.host_permissions ?? [])],
    manifest_permissions: [],
    scriptable_host: [...scriptable].sort(),
  };
}

/** The Preferences entry of an extension installed from the Web Store. */
export function settingsEntry(id, manifest, nowMs) {
  const grant = manifestGrant(manifest);
  // Chrome dates: microseconds since 1601-01-01, as a decimal string
  const stamp = ((BigInt(Math.floor(nowMs)) + 11_644_473_600_000n) * 1000n).toString();
  return {
    location: 1, from_webstore: true, path: `${id}/${manifest.version}_0`, creation_flags: 13,
    disable_reasons: [], manifest, granted_permissions: grant, active_permissions: grant,
    first_install_time: stamp, last_update_time: stamp,
    was_installed_by_default: false, was_installed_by_oem: false,
  };
}

/** The zip inside a CRX3 file. */
export function crxZip(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('not a CRX file');
  const version = buf.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX version ${version} is not supported`);
  return buf.subarray(12 + buf.readUInt32LE(8));
}

/** Every file of a zip: [{name, data}]. Stored and deflated entries only;
 *  a name that would leave the target dir is refused. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (name.endsWith('/')) continue;
    const norm = path.posix.normalize(name);
    if (path.posix.isAbsolute(norm) || norm.startsWith('../') || norm === '..' || name.includes('\\')) {
      throw new Error(`unsafe path in zip: ${name}`);
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) files.push({name: norm, data: raw});
    else if (method === 8) files.push({name: norm, data: zlib.inflateRawSync(raw, {maxOutputLength: MAX_FILE_BYTES})});
    else throw new Error(`zip method ${method} is not supported (${name})`);
  }
  return files;
}

/**
 * io: fetchImpl, chromeVersion (string), nowMs, exec (execFileSync).
 * `mainDir`: the main Chrome's user-data-dir, searched for a copy.
 */
export function openChromeExtension(io = {}) {
  const now = () => (typeof io.nowMs === 'function' ? io.nowMs() : io.nowMs ?? Date.now());

  /** The newest copy of `id` in any profile of the main Chrome: {dir, version, from} or null. */
  function mainCopy(id, mainDir) {
    let best = null;
    let profiles = [];
    try {
      profiles = fs.readdirSync(mainDir);
    } catch {
      return null;
    }
    for (const prof of profiles) {
      let versions = [];
      try {
        versions = fs.readdirSync(path.join(mainDir, prof, 'Extensions', id));
      } catch {
        continue;
      }
      for (const v of versions) {
        const dir = path.join(mainDir, prof, 'Extensions', id, v);
        let manifest;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        } catch {
          continue;
        }
        if (!best || compareVersions(manifest.version, best.version) > 0) {
          best = {dir, version: manifest.version, from: `main Chrome ${prof}`};
        }
      }
    }
    return best;
  }

  /** The installed Chrome's version, for the update service's prodversion. */
  function chromeVersion(chromeBin) {
    if (io.chromeVersion) return io.chromeVersion;
    try {
      const out = String((io.exec ?? execFileSync)(chromeBin, ['--version'], {encoding: 'utf8', timeout: 10_000}));
      return /(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? '150.0.0.0';
    } catch {
      return '150.0.0.0';
    }
  }

  async function download(id, chromeBin) {
    const res = await (io.fetchImpl ?? fetch)(CRX_URL(id, chromeVersion(chromeBin)), {redirect: 'follow'});
    if (!res.ok) throw new Error(`Web Store download failed: HTTP ${res.status}`);
    return unzip(crxZip(Buffer.from(await res.arrayBuffer())));
  }

  /** Lay `files` (or copy `srcDir`) as Extensions/<id>/<ver>_0, whole or not at all. */
  function layFiles(extDir, version, {files, srcDir}) {
    const dest = path.join(extDir, `${version}_0`);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.rmSync(tmp, {recursive: true, force: true});
    try {
      if (srcDir) {
        fs.cpSync(srcDir, tmp, {recursive: true});
      } else {
        for (const f of files) {
          const out = path.join(tmp, f.name);
          fs.mkdirSync(path.dirname(out), {recursive: true});
          fs.writeFileSync(out, f.data);
        }
      }
      fs.rmSync(dest, {recursive: true, force: true});
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, {recursive: true, force: true});
      throw e;
    }
  }

  /** Merge the entry into Default/Preferences, keeping everything else. */
  function register(profileDefault, id, manifest) {
    const prefs = path.join(profileDefault, 'Preferences');
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`cannot read ${prefs}: ${e.message}`);
    }
    doc.extensions ??= {};
    doc.extensions.settings ??= {};
    doc.extensions.settings[id] = settingsEntry(id, manifest, now());
    writeAtomic(prefs, JSON.stringify(doc));
  }

  /**
   * Install `id` into the profile at `userDataDir` (its Chrome must not be
   * running): from the main Chrome when it has a copy, else downloaded.
   * Resolves to {version, from}.
   */
  async function install(id, {userDataDir, mainDir, chromeBin}) {
    const def = path.join(userDataDir, 'Default');
    const extDir = path.join(def, 'Extensions', id);
    fs.mkdirSync(extDir, {recursive: true, mode: 0o700});
    const copy = mainDir ? mainCopy(id, mainDir) : null;
    let version;
    let from;
    if (copy) {
      layFiles(extDir, checkedVersion(copy.version), {srcDir: copy.dir});
      ({version, from} = copy);
    } else {
      const files = await download(id, chromeBin);
      const m = files.find((f) => f.name === 'manifest.json');
      if (!m) throw new Error('the downloaded extension has no manifest.json');
      version = checkedVersion(JSON.parse(m.data.toString('utf8')).version);
      layFiles(extDir, version, {files});
      from = 'Web Store download';
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, `${version}_0`, 'manifest.json'), 'utf8'));
    register(def, id, manifest);
    return {version, from};
  }

  return {install, mainCopy};
}
