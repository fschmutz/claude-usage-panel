// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there (the Node clients import
// this file directly).
//
// Awake, part two: the platform half. Every command the feature runs (the
// inhibitor children, the four sudo pmset commands, the sudoers rule that
// grants exactly those) and every reading it parses (pmset, sysfs, thermal
// zones). Twin of ClaudeUsageCore/AwakePower.swift; tests/fixtures/awake.json
// pins both. ./awake.js holds the session arithmetic, the floors and the
// recovery journal.

import {AWAKE_MAX_SECONDS} from './awake.js';

/** The ONLY four commands the macOS lid mode ever runs as root, and the only
 *  ones the sudoers rule grants - the same shape Insomnia's installer writes.
 *  Each is an exact argv: a rule that ended in a wildcard would hand the
 *  account every pmset setting there is. Every darwin argv below is taken
 *  from this list (awakeSudoArgv), so the rule and the runner cannot drift;
 *  scripts/awake-backstop.sh and `install.sh awakelid` are held to it by
 *  tests/awake-install.test.js, which runs them. */
export const AWAKE_SUDO_COMMANDS = Object.freeze([
    Object.freeze(['/usr/bin/pmset', '-a', 'disablesleep', '1']),
    Object.freeze(['/usr/bin/pmset', '-a', 'disablesleep', '0']),
    Object.freeze(['/usr/bin/pmset', '-b', 'lowpowermode', '1']),
    Object.freeze(['/usr/bin/pmset', '-b', 'lowpowermode', '0']),
]);

/** The pmset setting each journal key owns. */
const PMSET_SETTING = Object.freeze({sleepDisabled: 'disablesleep', lowPower: 'lowpowermode'});

/**
 * `sudo -n <the granted command>` that turns the setting a journal key owns
 * on or off, or null for a key the rule does not grant. `-n` NEVER prompts:
 * without the rule it fails fast with a readable error instead of hanging on
 * a password prompt.
 */
export function awakeSudoArgv(key, on) {
    const setting = Object.hasOwn(PMSET_SETTING, key) ? PMSET_SETTING[key] : null;
    const value = on ? '1' : '0';
    const granted = AWAKE_SUDO_COMMANDS.find((argv) => argv[2] === setting && argv[3] === value);
    return granted ? ['/usr/bin/sudo', '-n', ...granted] : null;
}

// ── Platform commands ───────────────────────────────────────────────────────
// Every privileged or long-lived command this feature runs, written down once
// so the tests can drive a fake runner and the docs can quote the real thing.

/**
 * The child that holds the idle/sleep assertion. It is a CHILD on purpose:
 * the kernel releases the assertion when it exits, so a holder that is
 * SIGKILLed cannot leave the machine awake forever.
 *
 *  - darwin: `caffeinate -i -w <pid>` - released when the holder exits.
 *  - linux:  `systemd-inhibit --what=idle:sleep --mode=block … sleep <n>` -
 *    bounded by its own sleep, so an orphan still expires on time.
 */
export function awakeInhibitArgv(platform, {
    seconds = AWAKE_MAX_SECONDS, pid = 0, who = 'claude-usage-panel',
    why = 'Claude Code is working',
} = {}) {
    const secs = String(Math.max(1, Math.floor(Number(seconds) || 0)));
    if (platform === 'darwin')
        return ['/usr/bin/caffeinate', '-i', '-w', String(pid)];
    if (platform === 'linux') {
        return ['systemd-inhibit', '--what=idle:sleep', '--mode=block',
            `--who=${who}`, `--why=${why}`, 'sleep', secs];
    }
    return null;
}

/**
 * Closed-lid mode, which is the dangerous half and is off by default.
 *
 *  - darwin: `sudo -n pmset -a disablesleep 1|0`, one of the four commands the
 *    sudoers rule grants (awakeSudoArgv).
 *  - linux: a logind inhibitor on the lid switch, which needs no root at all
 *    when polkit allows it, and expires by itself.
 */
export function awakeLidArgv(platform, on, {
    seconds = AWAKE_MAX_SECONDS, who = 'claude-usage-panel',
    why = 'Claude Code is working with the lid closed',
} = {}) {
    if (platform === 'darwin')
        return awakeSudoArgv('sleepDisabled', on);
    if (platform === 'linux') {
        // There is nothing to run for "off": the inhibitor is a child, and
        // letting it go is the release.
        if (!on)
            return null;
        return ['systemd-inhibit', '--what=handle-lid-switch', '--mode=block',
            `--who=${who}`, `--why=${why}`, 'sleep',
            String(Math.max(1, Math.floor(Number(seconds) || 0)))];
    }
    return null;
}

/** Low Power Mode, macOS only (Linux has no single equivalent). */
export function awakeLowPowerArgv(platform, on) {
    if (platform !== 'darwin')
        return null;
    return awakeSudoArgv('lowPower', on);
}

/** The sudoers file `./install.sh awakelid` writes, for this user only. */
export function awakeSudoersBody(user) {
    const lines = [
        '# Installed by claude-usage-panel (./install.sh awakelid).',
        '# Exactly four commands, nothing else. Remove with ./install.sh --uninstall awakelid.',
    ];
    for (const argv of AWAKE_SUDO_COMMANDS)
        lines.push(`${user} ALL=(root) NOPASSWD: ${argv.join(' ')}`);
    return `${lines.join('\n')}\n`;
}

/**
 * The first `SleepDisabled` line of `pmset -g`: true for 1, false for 0, null
 * when there is no such line or its value is anything else. null is NOT
 * "off": output we cannot read is not proof the bit was set, and a lid mode
 * that cannot be read back is reported as failed rather than trusted.
 */
export function parseSleepDisabled(output) {
    for (const rawLine of String(output ?? '').split(/\r?\n/)) {
        const parts = rawLine.trim().split(/[ \t]+/);
        if (parts[0] !== 'SleepDisabled')
            continue;
        if (parts[1] === '1')
            return true;
        if (parts[1] === '0')
            return false;
        return null;
    }
    return null;
}

/**
 * `pmset -g batt`: the percentage, whether it is charging, and whether there
 * is a battery at all. A Mac mini prints "Now drawing from 'AC Power'" and no
 * battery line; `hasBattery` tells that apart from a battery we failed to
 * read, which is the difference between "no floor applies" and "end the
 * session".
 */
export function parsePmsetBattery(output) {
    const text = String(output ?? '');
    const drawing = /Now drawing from '([^']+)'/.exec(text);
    const onAC = drawing ? /ac/i.test(drawing[1]) : false;
    const line = /InternalBattery[^\n]*/.exec(text)?.[0] ?? '';
    const hasBattery = line !== '';
    const pct = /(\d{1,3})%/.exec(line);
    const percent = pct ? Math.min(100, Math.max(0, Number(pct[1]))) : null;
    if (!hasBattery)
        return {percent: null, charging: true, hasBattery: false};
    // The battery line is the honest one: it says discharging even while the
    // adapter is plugged in but not actually charging. Only without a word of
    // its own does the "Now drawing from" line decide.
    let charging;
    if (/discharging/i.test(line))
        charging = false;
    else if (/charging|charged|AC attached/i.test(line))
        charging = true;
    else
        charging = onAC;
    return {percent, charging, hasBattery: true};
}

/**
 * Linux `/sys/class/power_supply/BAT*`: `capacity` (a percentage) and
 * `status` (Charging / Discharging / Full / Not charging / Unknown). Either
 * file missing or unreadable is an unreadable battery, not a full one.
 */
export function parseSysfsBattery({capacity = null, status = null, present = true} = {}) {
    if (!present)
        return {percent: null, charging: true, hasBattery: false};
    const raw = String(capacity ?? '').trim();
    const percent = /^\d{1,3}$/.test(raw) ? Math.min(100, Number(raw)) : null;
    const state = String(status ?? '').trim().toLowerCase();
    return {
        percent,
        charging: state === 'charging' || state === 'full' || state === 'not charging',
        hasBattery: true,
    };
}

/**
 * A thermal state from the only number Linux offers without a kernel-specific
 * driver: the hottest thermal zone, in millidegrees. The thresholds are a
 * heuristic (there is no portable "serious" bit), chosen so `serious` asks
 * for Low Power Mode and `critical` ends the session well before a CPU
 * throttles itself into the ground.
 */
export function thermalFromMillidegrees(milli, {serious = 85_000, critical = 95_000} = {}) {
    const n = Number(milli);
    if (!Number.isFinite(n) || n <= 0)
        return 'nominal';
    if (n >= critical)
        return 'critical';
    if (n >= serious)
        return 'serious';
    if (n >= serious - 10_000)
        return 'fair';
    return 'nominal';
}

/**
 * macOS `pmset -g therm`: `CPU_Speed_Limit` is 100 on a cool Mac and drops as
 * the SMC throttles it. Mapped onto the same four states so both ports read
 * one vocabulary.
 */
export function thermalFromSpeedLimit(output) {
    const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(String(output ?? ''));
    if (!m)
        return 'nominal';
    const limit = Number(m[1]);
    if (limit >= 100)
        return 'nominal';
    if (limit >= 75)
        return 'fair';
    if (limit >= 50)
        return 'serious';
    return 'critical';
}
