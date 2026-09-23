// Read the `claudectl session` snapshot store for the preferences window: the
// files under <state dir>/tabs, parsed, handed to summarizeSnapshots().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readJSON} from './fs.js';
import {stateDir} from './paths.js';
import {summarizeSnapshots} from './pure.js';

export function snapshotsDir() {
    return GLib.build_filenamev([stateDir(), 'tabs']);
}

/** @returns {ReturnType<typeof summarizeSnapshots>} */
export function readSnapshots() {
    const files = [];
    try {
        const en = Gio.File.new_for_path(snapshotsDir())
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.endsWith('.json'))
                files.push({label: name.slice(0, -5), data: readJSON(GLib.build_filenamev([snapshotsDir(), name]))});
        }
        en.close(null);
    } catch {
        // no store yet: an empty summary
    }
    return summarizeSnapshots(files);
}

/** The claudectl shim ./install.sh cli writes, or the one on PATH. */
export function claudectlPath() {
    const shim = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claudectl']);
    return GLib.file_test(shim, GLib.FileTest.IS_EXECUTABLE) ? shim : GLib.find_program_in_path('claudectl');
}
