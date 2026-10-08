// lib/bar.js: the progress bar and clock caret size themselves from their
// real allocation, loaded under plain node through the GJS stubs.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {stub} from './gjs-stub.js';

globalThis.global ??= {stage: {}};

function sized(widget, {allocated, preferred}) {
    // get_width() is what Clutter answers for an actor waiting for relayout
    // (the menu is closed): its preferred width, not where it was laid out.
    widget.get_allocation_box = () => ({get_width: () => allocated});
    widget.get_width = () => preferred;
    return widget;
}

async function bars(t) {
    stub.overrides['gi://St'] = {ThemeContext: {get_for_stage: () => ({scale_factor: 1})}};
    t.after(() => { stub.overrides = {}; });
    return import('../claude-usage-panel@fschmutz.github.io/lib/bar.js');
}

test('a poll with the menu closed fills the bar against its allocation, not its preferred width', async t => {
    const {ProgressBar} = await bars(t);
    // Closed menu: the track's preferred width is the old fill (60 px of 300).
    const bar = sized(new ProgressBar(), {allocated: 300, preferred: 60});
    bar.setFill(50, 'cu-normal');
    assert.equal(bar._fill.style, 'width: 150px;');
    bar.setFill(80, 'cu-warning');
    assert.equal(bar._fill.style, 'width: 240px;');
    assert.equal(bar._fill.style_class, 'cu-fill cu-warning');
});

test('the clock caret is placed against the allocation too', async t => {
    const {ClockRow} = await bars(t);
    const row = sized(new ClockRow(), {allocated: 200, preferred: 12});
    row.setMark(50, true);
    assert.equal(row._spacer.style, 'width: 96px;');
    assert.equal(row._mark.style_class, 'cu-clock-mark cu-warning');
});

test('never allocated yet: nothing painted until the first allocation', async t => {
    const {ProgressBar} = await bars(t);
    const bar = sized(new ProgressBar(), {allocated: 0, preferred: 0});
    bar.setFill(50, 'cu-normal');
    assert.equal(bar._paintedAt, -1);
    bar.get_allocation_box = () => ({get_width: () => 100});
    bar._paint();
    assert.equal(bar._fill.style, 'width: 50px;');
});
