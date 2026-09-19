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
];
