// Every dropdown button that acts through `claudectl` (awake, pause, waiting,
// the board, the saved sessions) does the same four things: find the CLI or
// say how to install it, mark the section busy, run it, and turn a refusal
// into a notification in the CLI's own words. Written once here.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {claudectlPath} from './paths.js';
import {lastOutputLine, run} from './proc.js';

/**
 * Run `claudectl` with the argv `argvFor(cli)` builds.
 * @param {(cli: string) => string[]} argvFor the full argv, from the CLI's path
 * @param {object} opts
 * @param {(title: string, body: string) => void} opts.notify
 * @param {() => boolean} [opts.isDestroyed] true once the dropdown is gone:
 *   nothing is notified or un-busied into it afterwards
 * @param {?string} [opts.installHint] notified when claudectl is missing (null: say nothing)
 * @param {string} [opts.failText] the body when a refusal printed nothing
 * @param {string} [opts.failTitle] the title of the refusal notification
 * @param {?(busy: boolean) => void} [opts.onBusy] around the run
 * @param {object} [opts.io] {claudectlPath, run}, for tests
 * @returns {Promise<{status: 'missing'} | {status: 'gone'}
 *   | {status: 'done', ok: boolean, stdout: string, stderr: string}>}
 */
export async function runClaudectl(argvFor, {
    notify, isDestroyed = () => false, installHint = null, failText = '', failTitle = _('Claude usage'),
    onBusy = null, io = {},
}) {
    const cli = (io.claudectlPath ?? claudectlPath)();
    if (!cli) {
        if (installHint)
            notify(_('Claude usage'), installHint);
        return {status: 'missing'};
    }
    onBusy?.(true);
    const result = await (io.run ?? run)(argvFor(cli));
    if (isDestroyed())
        return {status: 'gone'};
    onBusy?.(false);
    if (!result.ok)
        notify(failTitle, lastOutputLine(result.stdout, result.stderr) || failText);
    return {status: 'done', ...result};
}
