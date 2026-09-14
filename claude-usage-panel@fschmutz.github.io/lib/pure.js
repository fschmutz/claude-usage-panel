// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// One file per concern under lib/pure/; this barrel is the one import path
// every consumer uses (extension, prefs, the section controllers, the tests,
// scripts/screenshots/render.mjs).
export * from './pure/usage.js';
export * from './pure/pace.js';
export * from './pure/cursor.js';
export * from './pure/warehouse.js';
export * from './pure/events.js';
export * from './pure/poll.js';
export * from './pure/pings.js';
export * from './pure/sessions.js';
export * from './pure/accounts.js';
