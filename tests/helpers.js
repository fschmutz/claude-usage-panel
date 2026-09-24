// Shared test scaffolding: run a command without throwing on a non-zero exit
// (the shell scripts use exit codes as their API), and build a throwaway HOME
// so no test ever reads or writes the developer's real ~/.claude.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The only executables the suite may spawn, and the only directories it looks
// for them in - all constants. Everything under test is a shell script or a
// git command, so the program is resolved HERE and never decided by the
// environment: the sandbox HOMEs come from $TMPDIR and the test PATHs are
// built from process.execPath, so letting either pick the program is a real
// injection path (CodeQL js/shell-command-injection-from-environment, "this
// shell command depends on an uncontrolled absolute path" - the child's PATH
// is what resolves a bare program name). A script that lives in a sandbox is
// run as an ARGUMENT of bash instead: execFileSync takes no shell, so
// arguments cannot inject.
const TOOLS = ['bash', 'git'];
const TOOL_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];

function toolPath(name) {
    for (const dir of TOOL_DIRS) {
        const candidate = `${dir}/${name}`;
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`tests/helpers.js: no ${name} in ${TOOL_DIRS.join(', ')}`);
}

/** {status, stdout, stderr} for any exit code; stderr is captured, not leaked
 *  into the runner's own output. */
export function run(cmd, args, opts = {}) {
    const tool = TOOLS.find((t) => t === cmd);
    if (!tool) {
        throw new Error(
            `tests/helpers.js: run() takes ${TOOLS.join(' | ')}, not ${cmd} - `
                + 'pass the script as an argument (run("bash", [script, …])).',
        );
    }
    try {
        const stdout = execFileSync(toolPath(tool), args, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            ...opts,
        });
        return {status: 0, stdout, stderr: ''};
    } catch (e) {
        return {status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? ''};
    }
}

/**
 * A fresh HOME under the OS tmp dir, removed when the test ends when `t` is
 * given. Returns the io shape the Node clients take (homedir, env, platform,
 * tmpdir all pointing inside the sandbox) with `home` alongside.
 */
export function sandboxHome(t, {prefix = 'cup-'} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    if (t) t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    // procDir: an empty /proc of its own, so nothing reads the machine's real
    // processes (a live Claude session would otherwise show up in a test).
    return {home, homedir: home, env: {}, platform: 'linux', tmpdir: home, procDir: path.join(home, 'proc')};
}

/** Write a live Claude Code login into a sandbox HOME. */
export function writeLiveLogin(home, credentials, oauthAccount, extraConfig = {}) {
    fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(credentials));
    if (oauthAccount) {
        fs.writeFileSync(path.join(home, '.claude.json'),
            JSON.stringify({oauthAccount, ...extraConfig}));
    }
}

// A sandbox HOME with stub executables on its own bin dir: `claude` appends
// its argv to $HOME/claude-calls.log, and `crontab` serves $HOME/crontab.txt
// so no test ever reads (or writes!) the developer's real crontab.
export function stubbedHome(t, {prefix = 'cup-stub-'} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
        path.join(bin, 'claude'),
        '#!/bin/sh\necho "$@" >>"$HOME/claude-calls.log"\n',
    );
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    fs.writeFileSync(
        path.join(bin, 'crontab'),
        '#!/bin/sh\n'
            + 'case "$1" in\n'
            + '    -l) cat "$HOME/crontab.txt" 2>/dev/null || exit 1 ;;\n'
            + '    *) cat >"$HOME/crontab.txt" ;;\n'
            + 'esac\n',
    );
    fs.chmodSync(path.join(bin, 'crontab'), 0o755);
    // launchctl/systemctl operate on the REAL user domain regardless of HOME -
    // a sandboxed uninstall would otherwise boot out the developer's actual
    // scheduled agents. install.sh calls them unqualified, so PATH stubs
    // (which just record the call) keep every test inside the sandbox.
    for (const tool of ['launchctl', 'systemctl']) {
        fs.writeFileSync(
            path.join(bin, tool),
            `#!/bin/sh\necho "${tool} $@" >>"$HOME/scheduler-calls.log"\n`,
        );
        fs.chmodSync(path.join(bin, tool), 0o755);
    }
    return home;
}
