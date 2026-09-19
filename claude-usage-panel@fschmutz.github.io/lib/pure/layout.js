// Dropdown geometry. The panel has to fit the screen it is on - a 13" laptop
// at scale 2 has 1728 CSS pixels to give, a 4K desktop has 3840 - so the width
// is derived from the monitor rather than hardcoded, and every bar is filled
// from the width it actually got rather than from a constant.
//
// Pure (no gi imports) so it unit-tests under plain node. GNOME-only: the
// macOS popover sizes itself, so there is no Swift mirror of this file.

/** Smallest dropdown that still fits a card line without wrapping every word. */
export const MIN_POPUP_WIDTH = 300;
/** Widest it may get: past this, reset lines read as one long unbroken run. */
export const MAX_POPUP_WIDTH = 420;
/** Share of the screen the dropdown may take before it stops growing. */
export const POPUP_WIDTH_SHARE = 0.22;

/**
 * Dropdown width in CSS pixels for a monitor of `monitorWidth` device pixels.
 *
 * Monitor geometry is in device pixels while an inline `width:` style is
 * multiplied by the theme's scale factor, so the division is what puts both in
 * the same unit. On a screen too narrow for MIN_POPUP_WIDTH the floor gives
 * way - a popup wider than its monitor is worse than a cramped one.
 *
 * @param {number} monitorWidth device pixels across the monitor
 * @param {number} [scaleFactor] St theme context scale factor
 * @returns {number} CSS pixels
 */
export function popupWidth(monitorWidth, scaleFactor = 1) {
    const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    const logical = Math.round(monitorWidth / scale);
    if (!Number.isFinite(logical) || logical <= 0)
        return MIN_POPUP_WIDTH;
    const floor = Math.min(MIN_POPUP_WIDTH, Math.round(logical * 0.9));
    return Math.max(floor, Math.min(MAX_POPUP_WIDTH, Math.round(logical * POPUP_WIDTH_SHARE)));
}

/**
 * Fill width for a percentage on a track of `trackWidth` CSS pixels.
 *
 * @param {number} percent 0..100
 * @param {number} trackWidth CSS pixels of the track
 * @returns {number} CSS pixels of fill, never wider than the track
 */
export function barPx(percent, trackWidth) {
    if (!Number.isFinite(trackWidth) || trackWidth <= 0)
        return 0;
    const pct = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    return Math.round((pct / 100) * trackWidth);
}
