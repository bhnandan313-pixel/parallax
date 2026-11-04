import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAlignmentValue, getAlignmentStep } from './alignment-controls.js';

test('uses the specified normal and fine calibration increments', () => {
    assert.deepEqual(
        ['horizontal', 'vertical', 'scale'].map((axis) => getAlignmentStep(axis, false)),
        ['1', '1', '0.01']
    );
    assert.deepEqual(
        ['horizontal', 'vertical', 'scale'].map((axis) => getAlignmentStep(axis, true)),
        ['0.1', '0.1', '0.001']
    );
});

test('formats fine alignment values without mutating their source values', () => {
    const settings = { horizontal: 0.4, vertical: -2.3, scale: 1.007 };
    const original = { ...settings };

    assert.equal(formatAlignmentValue('horizontal', settings.horizontal, true), '0.4 px');
    assert.equal(formatAlignmentValue('vertical', settings.vertical, true), '-2.3 px');
    assert.equal(formatAlignmentValue('scale', settings.scale, true), '1.007×');
    assert.deepEqual(settings, original);
    assert.throws(() => getAlignmentStep('depth', true), RangeError);
});
