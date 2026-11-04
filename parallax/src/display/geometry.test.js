import assert from 'node:assert/strict';
import test from 'node:test';
import {
    calculateSourceRegion,
    createDefaultLayout,
    getScreenGeometry,
    validateDisplayLayout
} from './geometry.js';

test('horizontal geometry partitions one shared panorama into side-by-side regions', () => {
    const layout = createDefaultLayout(2);
    assert.equal(validateDisplayLayout(layout, 2), true);
    assert.deepEqual(calculateSourceRegion(layout, 1, 2000, 1000).normalized, {
        x: 0, y: 0, width: 0.5, height: 1
    });
    assert.deepEqual(calculateSourceRegion(layout, 2, 2000, 1000).normalized, {
        x: 0.5, y: 0, width: 0.5, height: 1
    });

    const fourScreen = createDefaultLayout(4);
    assert.deepEqual(calculateSourceRegion(fourScreen, 4, 4000, 1200), {
        x: 3000,
        y: 0,
        width: 1000,
        height: 1200,
        normalized: { x: 0.75, y: 0, width: 0.25, height: 1 },
        rotation: 0,
        orientation: 'auto',
        enabled: true
    });
});

test('vertical and grid layouts map cells to source regions by row and column', () => {
    const vertical = createDefaultLayout(4, 'vertical');
    assert.deepEqual(calculateSourceRegion(vertical, 3, 1000, 2000).normalized, {
        x: 0, y: 0.5, width: 1, height: 0.25
    });

    const grid = createDefaultLayout(4, 'grid', 2, 2);
    assert.deepEqual(getScreenGeometry(grid, 4), {
        screenNumber: 4,
        row: 1,
        column: 1,
        rotation: 0,
        orientation: 'auto',
        enabled: true,
        left: 0.5,
        top: 0.5,
        width: 0.5,
        height: 0.5
    });
});

test('custom geometry preserves gaps in the shared normalized panorama', () => {
    const layout = {
        type: 'custom',
        rows: 2,
        columns: 3,
        screens: {
            1: { row: 0, column: 0, rotation: 0, orientation: 'auto', enabled: true },
            2: { row: 1, column: 2, rotation: 0, orientation: 'auto', enabled: true }
        }
    };
    assert.equal(validateDisplayLayout(layout, 2), true);
    assert.deepEqual(calculateSourceRegion(layout, 2, 3000, 2000).normalized, {
        x: 2 / 3, y: 0.5, width: 1 / 3, height: 0.5
    });
    assert.equal(
        layout.screens[2].row > layout.screens[1].row
            && layout.screens[2].column > layout.screens[1].column,
        true
    );
});

test('rotation and manual orientation are carried by screen geometry', () => {
    const layout = createDefaultLayout(2);
    layout.screens[2] = {
        ...layout.screens[2],
        rotation: 90,
        orientation: 'portrait'
    };
    const region = calculateSourceRegion(layout, 2, 1000, 500);
    assert.equal(region.rotation, 90);
    assert.equal(region.orientation, 'portrait');
});

test('rejects overlapping positions, invalid rotations, and out-of-range dimensions', () => {
    const overlap = createDefaultLayout(2);
    overlap.screens[2] = { ...overlap.screens[1] };
    assert.equal(validateDisplayLayout(overlap, 2), false);

    const invalidRotation = createDefaultLayout(2);
    invalidRotation.screens[1].rotation = 45;
    assert.equal(validateDisplayLayout(invalidRotation, 2), false);

    const invalidGrid = createDefaultLayout(4, 'grid', 1, 3);
    assert.equal(validateDisplayLayout(invalidGrid, 4), false);
    assert.throws(() => calculateSourceRegion(createDefaultLayout(2), 1, 0, 100), /positive finite/);
});
