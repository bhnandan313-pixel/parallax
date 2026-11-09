import assert from 'node:assert/strict';
import test from 'node:test';
import {
    calculateSourceRegion,
    calculateWallTransform,
    createDefaultLayout,
    getScreenGeometry,
    validateDisplayLayout
} from './geometry.js';

test('calculates one shared wall fit for cover, contain, stretch, and portrait media', () => {
    const layout = createDefaultLayout(2);
    const cover = calculateWallTransform(layout, 1, 1920, 1080, 600, 600, 'cover');
    assert.equal(cover.scaleX, cover.scaleY);
    assert.equal(cover.scaleX, 1200 / 1920);
    assert.equal(cover.offsetY, -37.5);

    const contain = calculateWallTransform(layout, 2, 1920, 1080, 600, 600, 'contain');
    assert.equal(contain.scaleX, contain.scaleY);
    assert.equal(contain.offsetX, (1200 - 1920 * (600 / 1080)) / 2);

    const stretch = calculateWallTransform(layout, 1, 1920, 1080, 600, 600, 'stretch');
    assert.equal(stretch.scaleX, 1200 / 1920);
    assert.equal(stretch.scaleY, 600 / 1080);

    const portrait = calculateWallTransform(layout, 1, 1080, 1920, 600, 600, 'cover');
    assert.equal(portrait.scaleX, portrait.scaleY);
    assert.equal(portrait.offsetX, 0);
    assert.ok(portrait.offsetY < 0);

    const sixteenByNineWall = calculateWallTransform(
        layout,
        1,
        1200,
        900,
        800,
        900,
        'cover'
    );
    assert.equal(sixteenByNineWall.wallWidth / sixteenByNineWall.wallHeight, 16 / 9);
    assert.equal(sixteenByNineWall.scaleX, sixteenByNineWall.scaleY);
    assert.equal(sixteenByNineWall.offsetY, -150);
});

test('keeps ultra-wide two-screen seams continuous and adapts to other wall layouts', () => {
    const twoScreens = createDefaultLayout(2);
    const first = calculateWallTransform(twoScreens, 1, 3840, 1080, 1920, 1080);
    const second = calculateWallTransform(twoScreens, 2, 3840, 1080, 1920, 1080);
    assert.equal(first.scaleX, 1);
    assert.equal(first.scaleY, 1);
    assert.equal(first.offsetX, 0);
    assert.equal(first.offsetY, 0);
    assert.equal(second.screenX - first.screenX, 1920);

    const fourScreens = createDefaultLayout(4, 'grid', 2, 2);
    const topLeft = calculateWallTransform(fourScreens, 1, 4000, 1200, 1000, 600);
    const bottomRight = calculateWallTransform(fourScreens, 4, 4000, 1200, 1000, 600);
    assert.equal(topLeft.wallWidth, 2000);
    assert.equal(topLeft.wallHeight, 1200);
    assert.equal(bottomRight.screenX, 1000);
    assert.equal(bottomRight.screenY, 600);
});

test('rejects invalid wall dimensions and unsupported automatic fit modes', () => {
    const layout = createDefaultLayout(2);
    assert.throws(() => calculateWallTransform(layout, 1, 100, 100, 0, 100), /positive finite/);
    assert.throws(() => calculateWallTransform(layout, 1, 100, 100, 100, 100, 'manual'), /fit mode/);
});

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
