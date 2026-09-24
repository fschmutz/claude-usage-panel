// Shared fakes for the transcript token tests (transcript-tokens.test.js and
// the status line's tokensSegment tests). Not a test file: nothing runs here.
import {Buffer} from 'node:buffer';
import os from 'node:os';
import path from 'node:path';

// A cache path unique per call so token tests don't share the on-disk cache.
const rnd = () => Math.random().toString(36).slice(2);
export const noCache = () => path.join(os.tmpdir(), `cus-test-${rnd()}${rnd()}.json`);

// Injected transcript I/O: stat reports the real byte size, readFrom serves the
// requested byte range and counts how many bytes each call read.
export function fakeFiles(files) {
    const reads = [];
    return {
        reads,
        statFile: (p) => {
            if (!(p in files)) throw new Error('ENOENT');
            const f = files[p];
            return {mtimeMs: f.mtimeMs ?? 1, size: Buffer.byteLength(f.text), ino: f.ino ?? 7};
        },
        readFrom: (p, start, end) => {
            reads.push({p, start, end});
            return Buffer.from(files[p].text).subarray(start, end);
        },
    };
}
