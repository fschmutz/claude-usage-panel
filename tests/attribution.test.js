// Token attribution: which work the tokens went to. Pure functions driven by
// synthetic session lines - no network, no real logs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    attributeSession,
    classifyTurn,
    projectSlug,
    turnTokens,
    BUCKETS,
} from '../scripts/token-attribution.mjs';

const SCRIPT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'token-attribution.mjs',
);

const empty = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));
const asst = (content, tokens = 100) =>
    JSON.stringify({type: 'assistant', message: {content, usage: {output_tokens: tokens}}});
const user = (content = 'go') => JSON.stringify({type: 'user', message: {content}});
const tool = (name, input = {}) => ({type: 'tool_use', name, input});
// The real log shape: one line per content block, every block of one message
// carrying the same message.id and the same full usage.
const block = (id, content, usage) =>
    JSON.stringify({type: 'assistant', message: {id, content: [content], usage}});

test('cache reads are excluded, cache writes are not', () => {
    // Cache reads are billed at a fraction; counting them at face value makes
    // every long session look identical and meaningless.
    assert.equal(
        turnTokens({
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 100000,
        }),
        35,
    );
    assert.equal(turnTokens(null), 0);
});

test('tools decide the bucket', () => {
    const s = {editedFiles: new Set(), lastTurnErrored: false};
    assert.equal(classifyTurn([tool('Read')], s), 'exploration');
    assert.equal(classifyTurn([tool('Bash')], s), 'verification');
    assert.equal(classifyTurn([tool('Edit', {file_path: '/a'})], s), 'implementation');
    assert.equal(classifyTurn([], s), 'conversation');
});

test('editing a file twice in a session is rework', () => {
    const s = {editedFiles: new Set(['/a.ts']), lastTurnErrored: false};
    assert.equal(classifyTurn([tool('Edit', {file_path: '/a.ts'})], s), 'rework');
    assert.equal(classifyTurn([tool('Edit', {file_path: '/b.ts'})], s), 'implementation');
});

test('the turn after a failed tool call is correction', () => {
    const s = {editedFiles: new Set(), lastTurnErrored: true};
    assert.equal(classifyTurn([tool('Edit', {file_path: '/a'})], s), 'correction');
});

// The bug this tool shipped with and had to be fixed: Claude Code writes each
// assistant block as its OWN entry (thinking, then text, then tool_use). Scoring
// line-by-line filed every thinking and text block under `conversation` and
// reported 58% conversation / 0% exploration on real sessions.
test('a logical turn spans consecutive assistant entries', () => {
    const lines = [
        user(),
        asst([{type: 'thinking', thinking: '...'}], 50),
        asst([{type: 'text', text: 'Looking.'}], 30),
        asst([tool('Grep', {pattern: 'x'})], 20),
    ];
    const t = attributeSession(lines, empty());
    assert.equal(t.exploration, 100, 'thinking + text + tool_use is ONE exploration turn');
    assert.equal(t.conversation, 0);
});

test('an errored tool result attributes the next turn to correction', () => {
    const lines = [
        user(),
        asst([tool('Bash', {command: 'x'})], 10),
        JSON.stringify({
            type: 'user',
            message: {content: [{type: 'tool_result', is_error: true, content: 'boom'}]},
        }),
        asst([tool('Edit', {file_path: '/a'})], 40),
    ];
    const t = attributeSession(lines, empty());
    assert.equal(t.verification, 10);
    assert.equal(t.correction, 40);
    assert.equal(t.implementation, 0);
});

test('a truncated final line does not sink the report', () => {
    const lines = [user(), asst([tool('Read')], 10), '{"type":"assist'];
    const t = attributeSession(lines, empty());
    assert.equal(t.exploration, 10);
});

// Real logs repeat message.id + the full usage on every content-block line.
// Summing per line counted a 3-block message three times (1.6x on a real log).
test('a message split over several block lines is counted once', () => {
    const usage = {input_tokens: 7, output_tokens: 93};
    const lines = [
        user(),
        block('msg_1', {type: 'thinking', thinking: '...'}, usage),
        block('msg_1', {type: 'text', text: 'Looking.'}, usage),
        block('msg_1', tool('Grep', {pattern: 'x'}), usage),
        user([{type: 'tool_result', content: 'ok'}]),
        block('msg_2', {type: 'text', text: 'Done.'}, {output_tokens: 5}),
        block('msg_2', {type: 'text', text: 'Really.'}, {output_tokens: 5}),
    ];
    const t = attributeSession(lines, empty());
    assert.equal(t.exploration, 100, 'msg_1 counted once, classified by its tool_use block');
    assert.equal(t.conversation, 5);
});

test('project slug turns every non-alphanumeric into a dash, as Claude Code does', () => {
    assert.equal(
        projectSlug('/home/me/.local/state/claude-usage-panel/ping-cwd'),
        '-home-me--local-state-claude-usage-panel-ping-cwd',
    );
    assert.equal(projectSlug('/home/me/Git/INIT+LAUNCHER/a_b'), '-home-me-Git-INIT-LAUNCHER-a-b');
});

// End to end: a dotted project path under a CLAUDE_CONFIG_DIR that is not
// ~/.claude. Both used to report "No session activity".
test('the CLI finds a dotted project under CLAUDE_CONFIG_DIR', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-attr-'));
    try {
        const project = '/work/.hidden/repo.v2';
        const dir = path.join(tmp, 'cfg', 'projects', '-work--hidden-repo-v2');
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(
            path.join(dir, 's.jsonl'),
            [user(), block('m1', tool('Read', {file_path: '/x'}), {output_tokens: 42})].join('\n'),
        );
        const out = execFileSync(
            process.execPath,
            [SCRIPT, '--json', '--project', project],
            {
                encoding: 'utf8',
                env: {...process.env, HOME: path.join(tmp, 'home'), CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg')},
            },
        );
        const o = JSON.parse(out);
        assert.equal(o.sessions, 1);
        assert.equal(o.total, 42);
        assert.equal(o.buckets.exploration, 42);
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});
