// Flat ESLint config: the Node code (status line, MCP server, scripts, tests)
// and the GNOME Shell (GJS) code share one rule set and differ only in globals.
// GJS is ESM with a few global helpers; module resolution (gi://, resource://)
// is provided by the Shell at runtime, so we don't resolve imports here.

const rules = {
    'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
    'no-undef': 'error',
    'prefer-const': 'error',
    'no-var': 'error',
    eqeqeq: ['error', 'smart'],
    semi: ['error', 'always'],
};

// The Shell's main loop runs extension.js and lib/: a synchronous file walk,
// read, write or subprocess there stalls every frame of the desktop (CLAUDE.md:
// nothing on the Shell main thread may block). Each call has an async variant
// (lib/fs.js, lib/proc.js). An exception is one `eslint-disable-next-line`
// naming this rule and its reason, on the one line it excuses.
const SHELL_SYNC_BANS = [
    ['enumerate_children', 'enumerate_children_async (fs.js listChildrenAsync)'],
    ['next_file', 'next_files_async (fs.js listChildrenAsync)'],
    ['file_get_contents', 'fs.js readTextAsync / readJSONAsync'],
    ['file_set_contents', 'fs.js writeTextAsync'],
    ['file_set_contents_full', 'fs.js writeTextAsync'],
    ['load_contents', 'load_contents_async'],
    ['replace_contents', 'replace_contents_bytes_async (fs.js writeTextAsync)'],
    ['spawn_command_line_sync', 'proc.js run'],
    ['spawn_sync', 'proc.js run'],
].map(([property, use]) => ({property, message: `blocks the Shell main thread: use ${use}`}));

const NODE_FILES = ['claude-code/**/*.js', 'mcp/**/*.js', 'tests/**/*.js', '**/*.mjs'];

export default [
    {
        files: NODE_FILES,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                process: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                AbortController: 'readonly',
                AbortSignal: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                // Web-standard in Node since 11; the pure contracts use it so
                // the GJS copies can be byte-identical (GJS has it too).
                TextDecoder: 'readonly',
            },
        },
        rules,
    },
    {
        files: ['**/*.js'],
        ignores: ['eslint.config.js', ...NODE_FILES],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                console: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                globalThis: 'readonly',
                // GNOME Shell's own global (stage, display); extensions only.
                global: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                Promise: 'readonly',
                Set: 'readonly',
                Map: 'readonly',
            },
        },
        rules,
    },
    {
        files: ['claude-usage-panel@fschmutz.github.io/extension.js', 'claude-usage-panel@fschmutz.github.io/lib/**/*.js'],
        ignores: ['claude-usage-panel@fschmutz.github.io/lib/pure/**', 'claude-usage-panel@fschmutz.github.io/lib/pure.js'],
        rules: {
            'no-restricted-properties': ['error', ...SHELL_SYNC_BANS],
            // fs.js's sync wrappers are the same calls one level up
            'no-restricted-imports': ['error', {paths: [{
                name: './fs.js', importNames: ['readText', 'readJSON', 'writeText'],
                message: 'blocks the Shell main thread: use readTextAsync / readJSONAsync / writeTextAsync',
            }, {
                name: './lib/fs.js', importNames: ['readText', 'readJSON', 'writeText'],
                message: 'blocks the Shell main thread: use readTextAsync / readJSONAsync / writeTextAsync',
            }]}],
        },
    },
];
