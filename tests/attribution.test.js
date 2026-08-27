// Token attribution: which work the tokens went to. Pure functions driven by
// synthetic session lines - no network, no real logs.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    attributeSession,
    classifyTurn,
    turnTokens,
    BUCKETS,
} from '../scripts/token-attribution.mjs';

const empty = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));
const asst = (content, tokens = 100) =>
    JSON.stringify({type: 'assistant', message: {content, usage: {output_tokens: tokens}}});
const user = (content = 'go') => JSON.stringify({type: 'user', message: {content}});
const tool = (name, input = {}) => ({type: 'tool_use', name, input});

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
