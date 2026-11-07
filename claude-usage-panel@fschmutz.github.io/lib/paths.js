// Where things live on disk - the one place the extension derives them.
// Claude Code's own files follow CLAUDE_CONFIG_DIR when it is set (the
// credentials AND ~/.claude.json move together); our own state follows XDG.

import GLib from 'gi://GLib';

/** Root of the panel's own durable state: history, accounts, ping stamp. */
export function stateDir() {
    const state = GLib.getenv('XDG_STATE_HOME') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return GLib.build_filenamev([state, 'claude-usage-panel']);
}

/** Claude Code's config directory: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function configDir() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

/** Where Claude Code keeps the live credentials. */
export function credentialsPath() {
    return GLib.build_filenamev([configDir(), '.credentials.json']);
}

/** ~/.claude.json, which follows CLAUDE_CONFIG_DIR when that is set. */
export function claudeConfigPath() {
    return GLib.getenv('CLAUDE_CONFIG_DIR')
        ? GLib.build_filenamev([configDir(), '.claude.json'])
        : GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']);
}

/** The claudectl shim ./install.sh cli writes, or the one on PATH; null when
 *  neither is there. */
export function claudectlPath() {
    const shim = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claudectl']);
    return GLib.file_test(shim, GLib.FileTest.IS_EXECUTABLE) ? shim : GLib.find_program_in_path('claudectl');
}
