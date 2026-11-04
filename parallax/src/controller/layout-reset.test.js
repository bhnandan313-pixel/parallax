import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmLayoutReset, LAYOUT_RESET_CONFIRMATION } from './layout-reset.js';

test('cancelled layout reset confirmation does not request a reset', () => {
    let resetRequested = false;
    let confirmationMessage;

    const confirmed = confirmLayoutReset((message) => {
        confirmationMessage = message;
        return false;
    }, () => {
        resetRequested = true;
    });

    assert.equal(confirmationMessage, LAYOUT_RESET_CONFIRMATION);
    assert.equal(confirmed, false);
    assert.equal(resetRequested, false);
});

test('confirmed layout reset requests the reset once', () => {
    let resetCount = 0;
    assert.equal(confirmLayoutReset(() => true, () => {
        resetCount += 1;
    }), true);
    assert.equal(resetCount, 1);
});
