// Dropdown geometry: the width the popup takes on a given screen, and the fill
// a percentage earns on a track of a given width.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    popupWidth, barPx, MIN_POPUP_WIDTH, MAX_POPUP_WIDTH,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

test('a HiDPI laptop gets a share of its logical width, not its device width', () => {
    // 3456 device px at scale 2 = 1728 CSS px -> 22% of it.
    assert.equal(popupWidth(3456, 2), 380);
});

test('a 1080p screen at scale 1 is already capped', () => {
    // 22% of 1920 is 422, past the cap.
    assert.equal(popupWidth(1920, 1), MAX_POPUP_WIDTH);
});

test('a 4K screen stops growing at the cap', () => {
    assert.equal(popupWidth(3840, 1), MAX_POPUP_WIDTH);
});

test('a small screen still gets a readable floor', () => {
    assert.equal(popupWidth(1280, 1), MIN_POPUP_WIDTH);
});

test('a screen narrower than the floor gives way rather than overflowing', () => {
    assert.equal(popupWidth(320, 1), 288);
});

test('a missing or nonsense scale factor is treated as 1', () => {
    assert.equal(popupWidth(1920, 0), popupWidth(1920, 1));
    assert.equal(popupWidth(1920, NaN), popupWidth(1920, 1));
    assert.equal(popupWidth(1920), popupWidth(1920, 1));
});

test('fill is the percentage of whatever track width it was given', () => {
    assert.equal(barPx(50, 300), 150);
    assert.equal(barPx(50, 380), 190);
    assert.equal(barPx(0, 380), 0);
    assert.equal(barPx(100, 380), 380);
});

test('fill never escapes its track', () => {
    assert.equal(barPx(140, 380), 380);
    assert.equal(barPx(-10, 380), 0);
});

test('an unallocated track paints nothing', () => {
    assert.equal(barPx(50, 0), 0);
    assert.equal(barPx(50, NaN), 0);
});
