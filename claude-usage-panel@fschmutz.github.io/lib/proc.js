// One promise around Gio.Subprocess: spawn, read both pipes, resolve. Never
// rejects - a missing binary or a non-zero exit is an outcome (`ok: false`),
// not an exception, because every caller here has a fallback (try the next
// candidate, show an error line, count zero).

import Gio from 'gi://Gio';

/**
 * @param {string[]} argv
 * @param {{cancellable?: Gio.Cancellable}} opts a cancellable lets a closing
 *   prefs window drop the result instead of writing to disposed widgets
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function run(argv, {cancellable = null} = {}) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: e.message});
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (self, res) => {
            try {
                const [, stdout, stderr] = self.communicate_utf8_finish(res);
                resolve({ok: self.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                resolve({ok: false, stdout: '', stderr: e.message});
            }
        });
    });
}
