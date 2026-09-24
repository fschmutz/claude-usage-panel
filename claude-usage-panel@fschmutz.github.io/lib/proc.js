// One promise around Gio.Subprocess: spawn, read both pipes, resolve. Never
// rejects - a missing binary, a non-zero exit or a child that overran its
// time is an outcome (`ok: false`), not an exception, because every caller
// here has a fallback (try the next candidate, show an error line, count zero).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * How long a child may run before it is killed. The poll loop awaits these (a
 * hung `ccusage` used to stop every poll after it), so no call runs unbounded
 * unless it asks to.
 */
export const RUN_TIMEOUT_SECONDS = 60;

/**
 * @param {string[]} argv
 * @param {object} opts
 * @param {?Gio.Cancellable} [opts.cancellable] lets a closing prefs window
 *   drop the result instead of writing to disposed widgets
 * @param {number} [opts.timeoutSeconds] kill the child and resolve `ok: false`
 *   after this long; 0 waits for as long as it takes (only for a job that
 *   must never be cut short, like applying an update)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function run(argv, {cancellable = null, timeoutSeconds = RUN_TIMEOUT_SECONDS} = {}) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: e.message});
            return;
        }
        // Our own cancellable, so the timeout can abort the pipe read: killing
        // the child alone is not enough when a grandchild it spawned still
        // holds its stdout open. The caller's cancellable feeds into it.
        const own = new Gio.Cancellable();
        const forwardId = cancellable ? cancellable.connect(() => own.cancel()) : 0;
        let timerId = 0;
        let settled = false;
        const finish = outcome => {
            if (settled)
                return;
            settled = true;
            if (timerId)
                GLib.Source.remove(timerId);
            timerId = 0;
            if (forwardId)
                cancellable.disconnect(forwardId);
            resolve(outcome);
        };
        if (timeoutSeconds > 0) {
            timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                timerId = 0;
                proc.force_exit();
                own.cancel();
                finish({ok: false, stdout: '', stderr: `${argv[0]}: timed out after ${timeoutSeconds} s`});
                return GLib.SOURCE_REMOVE;
            });
        }
        proc.communicate_utf8_async(null, own, (self, res) => {
            try {
                const [, stdout, stderr] = self.communicate_utf8_finish(res);
                finish({ok: self.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                finish({ok: false, stdout: '', stderr: e.message});
            }
        });
    });
}
