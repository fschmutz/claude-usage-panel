// Pure logic - no GJS/gi imports and no node imports, so the GNOME extension,
// the Node clients and the tests all load it as is.
//
// Strict JSON-type reads, the way the Swift twin's `as?` casts read a payload:
// a field of the wrong JSON type counts as absent. Number("42"), Number(null)
// and Number(false) would otherwise turn a string, a null or a boolean into a
// figure no other port shows. One copy: every pure module imports these.

/** A finite JSON number, else null. */
export const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A JSON object (not null, not an array). */
export const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
