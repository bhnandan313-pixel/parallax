import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createSpatialCoordinateMapping,
    hasMeaningfulSpatialMappingChange
} from './spatial-mapping.js';

function poses({
    first = {},
    second = {},
    timestamp = 1000
} = {}) {
    return [
        {
            deviceId: 'device-a',
            centerX: 0.25,
            centerY: 0.5,
            width: 0.12,
            height: 0.12,
            orientationAngle: 0,
            confidence: 0.9,
            isVisible: true,
            timestamp,
            ...first
        },
        {
            deviceId: 'device-b',
            centerX: 0.7,
            centerY: 0.5,
            width: 0.16,
            height: 0.16,
            orientationAngle: 0,
            confidence: 0.85,
            isVisible: true,
            timestamp,
            ...second
        }
    ];
}

test('creates a normalized side-by-side marker-proxy mapping', () => {
    const mapping = createSpatialCoordinateMapping(poses(), { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'SIDE_BY_SIDE');
    assert.equal(mapping.devices.length, 2);
    assert.equal(mapping.devices[0].deviceId, 'device-a');
    assert.equal(mapping.devices[1].deviceId, 'device-b');
    assert.equal(mapping.devices[0].deviceLocalViewport.width, 1);
    assert.equal(mapping.sharedWall.coordinateSpace, 'normalized-camera-image-marker-proxy');
    assert.equal(mapping.calibration.physicalScreenGeometryAvailable, false);
    assert.equal(mapping.devices[0].estimatedDisplaySurface.calibrated, false);
    const transform = mapping.devices[0].localToSharedWall;
    const centerX = transform.a * 0.5 + transform.b * 0.5 + transform.e;
    const centerY = transform.c * 0.5 + transform.d * 0.5 + transform.f;
    assert.ok(Math.abs(centerX - mapping.devices[0].sharedWallPose.x) < 0.00001);
    assert.ok(Math.abs(centerY - mapping.devices[0].sharedWallPose.y) < 0.00001);
});

test('handles stacked devices and preserves mapping when input order is reversed', () => {
    const pair = poses({
        first: { centerX: 0.5, centerY: 0.25 },
        second: { centerX: 0.5, centerY: 0.75 }
    });
    const original = createSpatialCoordinateMapping(pair, { timestamp: 1100 });
    const reversed = createSpatialCoordinateMapping([...pair].reverse(), { timestamp: 1100 });
    assert.equal(original.arrangement, 'STACKED');
    assert.deepEqual(reversed, original);
});

test('reports relative rotation and supports explicit different display aspect ratios', () => {
    const mapping = createSpatialCoordinateMapping(poses({
        first: { displayAspectRatio: 9 / 16 },
        second: { displayAspectRatio: 16 / 9, orientationAngle: Math.PI / 4 }
    }), { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.devices[0].estimatedDisplaySurface.geometrySource,
        'marker-scale-with-explicit-display-aspect-ratio');
    assert.ok(mapping.devices[0].estimatedDisplaySurface.height
        > mapping.devices[0].estimatedDisplaySurface.width);
    assert.ok(mapping.devices[1].estimatedDisplaySurface.width
        > mapping.devices[1].estimatedDisplaySurface.height);
    assert.ok(Math.abs(mapping.relativeRotation - Math.PI / 4) < 0.00001);
    assert.equal(mapping.orientation, 'ANGLED');
    assert.ok(Math.abs(mapping.devices[1].sharedWallPose.rotation - Math.PI / 4) < 0.00001);
});

test('marks reversed camera ordering without changing device identity', () => {
    const mapping = createSpatialCoordinateMapping(poses({
        first: { centerX: 0.8 },
        second: { centerX: 0.2 }
    }), { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.reversedFromDeviceIdOrder, true);
    assert.deepEqual(mapping.devices.map(({ deviceId }) => deviceId), ['device-a', 'device-b']);
});

test('classifies widely separated observations without implying physical distance', () => {
    const mapping = createSpatialCoordinateMapping(poses({
        first: { centerX: 0.1 },
        second: { centerX: 0.9 }
    }), { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'SEPARATED');
    assert.match(mapping.sharedWall.coordinateSpace, /normalized-camera-image/);
});

test('rejects missing, stale, low-confidence, and degenerate observations', () => {
    assert.equal(createSpatialCoordinateMapping(poses().slice(0, 1), { timestamp: 1100 }).reason,
        'exactly-two-device-poses-required');
    assert.equal(createSpatialCoordinateMapping(poses({ timestamp: 1000 }), {
        timestamp: 4000,
        maxAgeMs: 2000
    }).reason, 'missing-or-stale-observation');
    assert.equal(createSpatialCoordinateMapping(poses({
        second: { confidence: 0.2 }
    }), { timestamp: 1100 }).reason, 'low-confidence-or-invalid-orientation');
    assert.equal(createSpatialCoordinateMapping(poses({
        second: { width: 0, height: 0 }
    }), { timestamp: 1100 }).reason, 'degenerate-marker-proxy-dimensions');
    assert.equal(createSpatialCoordinateMapping(poses({
        second: { centerX: 0.25, centerY: 0.5 }
    }), { timestamp: 1100 }).reason, 'overlapping-or-ambiguous-device-centers');
});

test('rejects duplicate IDs, invisible devices, and invalid coordinates', () => {
    const pair = poses();
    assert.equal(createSpatialCoordinateMapping([pair[0], { ...pair[1], deviceId: pair[0].deviceId }],
        { timestamp: 1100 }).reason, 'missing-or-duplicate-device-id');
    assert.equal(createSpatialCoordinateMapping(poses({
        second: { isVisible: false }
    }), { timestamp: 1100 }).reason, 'device-not-visible');
    assert.equal(createSpatialCoordinateMapping(poses({
        second: { centerX: 1.2 }
    }), { timestamp: 1100 }).reason, 'invalid-camera-image-position');
    assert.equal(createSpatialCoordinateMapping(poses({
        second: { corners: [{ x: Number.NaN, y: 0 }] }
    }), { timestamp: 1100 }).reason, 'invalid-marker-corners');
});

test('requires a reliable existing spatial relationship when supplied', () => {
    const pair = poses();
    assert.equal(createSpatialCoordinateMapping(pair, {
        timestamp: 1100,
        relationship: { isReliable: false }
    }).reason, 'spatial-relationship-not-reliable');
    const relationship = {
        isReliable: true,
        arrangement: 'STACKED',
        orientation: 'ANGLED'
    };
    const mapping = createSpatialCoordinateMapping(pair, { timestamp: 1100, relationship });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'STACKED');
    assert.equal(mapping.orientation, 'ANGLED');
});

test('suppresses insignificant updates but reports meaningful geometry changes', () => {
    const original = createSpatialCoordinateMapping(poses(), { timestamp: 1100 });
    const noisy = createSpatialCoordinateMapping(poses({
        first: { centerX: 0.251 },
        second: { centerX: 0.701 }
    }), { timestamp: 1200 });
    const rearranged = createSpatialCoordinateMapping(poses({
        first: { centerX: 0.5, centerY: 0.2 },
        second: { centerX: 0.5, centerY: 0.8 }
    }), { timestamp: 1200 });
    const moved = createSpatialCoordinateMapping(poses({
        first: { centerX: 0.3 }
    }), { timestamp: 1200 });
    assert.equal(hasMeaningfulSpatialMappingChange(original, noisy), false);
    assert.equal(hasMeaningfulSpatialMappingChange(original, moved), true);
    assert.equal(hasMeaningfulSpatialMappingChange(original, rearranged), true);
    assert.equal(hasMeaningfulSpatialMappingChange(null, original), true);
    assert.equal(hasMeaningfulSpatialMappingChange(original, {
        valid: false,
        devices: []
    }), false);
});
