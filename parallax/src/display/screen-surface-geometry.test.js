import assert from 'node:assert/strict';
import test from 'node:test';
import {
    calculateScreenSurfaceViewports,
    createScreenSurfaceCalibration,
    validateScreenSurfaceObservations
} from './screen-surface-geometry.js';

function calibration(deviceId, corners, options = {}) {
    return createScreenSurfaceCalibration({
        deviceId,
        corners,
        confidence: options.confidence ?? 0.9,
        timestamp: options.timestamp ?? 1000,
        orientationAngle: options.orientationAngle ?? null
    });
}

function rectangle(left, top, right, bottom) {
    return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom }
    ];
}

function rotate(points, angle, center = { x: 0.5, y: 0.5 }) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return points.map(({ x, y }) => {
        const dx = x - center.x;
        const dy = y - center.y;
        return {
            x: center.x + dx * cosine - dy * sine,
            y: center.y + dx * sine + dy * cosine
        };
    });
}

function transform(matrix, u, v) {
    const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
    return {
        x: (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator,
        y: (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator
    };
}

test('derives four-corner dimensions, center, and rotation', () => {
    const result = calibration('phone-a', rectangle(0.1, 0.2, 0.4, 0.8));
    assert.ok(result);
    assert.equal(result.width, 0.3);
    assert.equal(result.height, 0.6);
    assert.deepEqual(result.center, { x: 0.25, y: 0.5 });
    assert.equal(result.position.x, result.center.x);
    assert.equal(result.rotation, 0);
    assert.equal(result.coordinateSpace, 'normalized-camera-image-manually-confirmed');
    assert.equal(result.physicalGeometryCalibrated, false);
});

test('calculates side-by-side viewports with different aspect ratios', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.2, 0.35, 0.8));
    const second = calibration('phone-b', rectangle(0.35, 0.2, 0.8, 0.8));
    const mapping = calculateScreenSurfaceViewports([first, second], { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'SIDE_BY_SIDE');
    assert.equal(mapping.viewports[0].aspectRatio, 0.416667);
    assert.equal(mapping.viewports[1].aspectRatio, 0.75);
    assert.deepEqual(mapping.viewports[0].corners[1], mapping.viewports[1].corners[0]);
    assert.equal(mapping.viewports[0].localToSharedFrame.matrix3x3.length, 9);
    for (const [index, [u, v]] of [[0, 0], [1, 0], [1, 1], [0, 1]].entries()) {
        const mapped = transform(mapping.viewports[0].localToSharedFrame.matrix3x3, u, v);
        assert.ok(Math.abs(mapped.x - mapping.viewports[0].corners[index].x) < 0.00001);
        assert.ok(Math.abs(mapped.y - mapping.viewports[0].corners[index].y) < 0.00001);
    }
});

test('is independent of reversed calibration order and reports reversed physical ordering', () => {
    const left = calibration('phone-a', rectangle(0.55, 0.2, 0.9, 0.8));
    const right = calibration('phone-b', rectangle(0.1, 0.2, 0.55, 0.8));
    const forward = calculateScreenSurfaceViewports([left, right], { timestamp: 1100 });
    const reversed = calculateScreenSurfaceViewports([right, left], { timestamp: 1100 });
    assert.deepEqual(reversed, forward);
    assert.equal(forward.arrangement, 'SIDE_BY_SIDE');
    assert.equal(forward.reversedFromDeviceIdOrder, true);
});

test('maps rotated surfaces and supports stacked arrangements', () => {
    const first = calibration('phone-a', rotate(rectangle(0.2, 0.1, 0.6, 0.4), Math.PI / 6));
    const second = calibration('phone-b', rectangle(0.2, 0.4, 0.6, 0.9));
    const mapping = calculateScreenSurfaceViewports([first, second], { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'STACKED');
    assert.ok(Math.abs(mapping.viewports[0].rotation - Math.PI / 6) < 0.00001);
    assert.ok(mapping.viewports[0].localToSharedFrame.matrix3x3.some((value, index) =>
        index === 1 && Math.abs(value) > 0.01));
});

test('rejects invalid corner order, degenerate corners, and invalid confidence', () => {
    assert.equal(calibration('phone-a', [
        { x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 },
        { x: 0.8, y: 0.1 }, { x: 0.1, y: 0.8 }
    ]), null);
    assert.equal(calibration('phone-a', rectangle(0.1, 0.1, 0.102, 0.8)), null);
    assert.equal(calibration('phone-a', rectangle(0.1, 0.1, 0.8, 0.8), {
        confidence: 0.2
    }), null);
    assert.equal(calibration('phone-a', [
        { x: -0.1, y: 0 }, { x: 0.5, y: 0 },
        { x: 0.5, y: 0.5 }, { x: -0.1, y: 0.5 }
    ]), null);
});

test('rejects missing, stale, and low-confidence calibrations', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.1, 0.4, 0.8));
    const second = calibration('phone-b', rectangle(0.4, 0.1, 0.8, 0.8));
    assert.equal(calculateScreenSurfaceViewports([first], { timestamp: 1100 }).reason,
        'exactly-two-screen-calibrations-required');
    assert.equal(calculateScreenSurfaceViewports([first, second], {
        timestamp: 1000 + 24 * 60 * 60 * 1000 + 1
    }).reason, 'missing-or-stale-calibration');
    assert.equal(calculateScreenSurfaceViewports([first, { ...second, confidence: 0.4 }], {
        timestamp: 1100
    }).reason, 'invalid-or-duplicate-calibration');
    assert.equal(calculateScreenSurfaceViewports([first, second], {
        timestamp: 1100,
        minConfidence: 0.95
    }).reason, 'low-calibration-confidence');
});

test('reports confidence from the least certain surface and preserves edge continuity', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.1, 0.45, 0.8), {
        confidence: 0.75
    });
    const second = calibration('phone-b', rectangle(0.45, 0.1, 0.9, 0.8), {
        confidence: 0.9
    });
    const mapping = calculateScreenSurfaceViewports([first, second], { timestamp: 1100 });
    assert.equal(mapping.confidence, 0.75);
    assert.equal(mapping.viewports[0].corners[1].x, mapping.viewports[1].corners[0].x);
    assert.equal(mapping.viewports[0].corners[2].x, mapping.viewports[1].corners[3].x);
    assert.equal(mapping.physicalGeometryCalibrated, false);
});

test('recalculates the same shared frame for landscape-to-portrait and portrait-to-landscape changes', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.2, 0.5, 0.8), {
        orientationAngle: 0
    });
    const second = calibration('phone-b', rectangle(0.5, 0.2, 0.9, 0.8), {
        orientationAngle: 0
    });
    const original = calculateScreenSurfaceViewports([first, second], { timestamp: 1100 });
    const portrait = calculateScreenSurfaceViewports([first, second], {
        timestamp: 1200,
        orientationAngles: new Map([['phone-a', 90], ['phone-b', 90]]),
        sharedOrientation: 'portrait'
    });
    const landscape = calculateScreenSurfaceViewports([first, second], {
        timestamp: 1300,
        orientationAngles: new Map([['phone-a', 0], ['phone-b', 0]]),
        sharedOrientation: 'landscape'
    });

    assert.equal(original.arrangement, 'SIDE_BY_SIDE');
    assert.equal(portrait.valid, true);
    assert.equal(portrait.arrangement, 'STACKED');
    assert.ok(portrait.sharedFrame.height > portrait.sharedFrame.width);
    assert.equal(landscape.valid, true);
    assert.equal(landscape.arrangement, 'SIDE_BY_SIDE');
    assert.ok(landscape.sharedFrame.width > landscape.sharedFrame.height);
    assert.notDeepEqual(
        portrait.viewports.map(({ localToSharedFrame }) => localToSharedFrame),
        original.viewports.map(({ localToSharedFrame }) => localToSharedFrame)
    );
});

test('orientation-adjusted viewports retain identity and the exact shared boundary', () => {
    const left = calibration('phone-left', rectangle(0.1, 0.2, 0.5, 0.8), {
        orientationAngle: 0
    });
    const right = calibration('phone-right', rectangle(0.5, 0.2, 0.9, 0.8), {
        orientationAngle: 0
    });
    const mapping = calculateScreenSurfaceViewports([right, left], {
        timestamp: 1100,
        orientationAngles: {
            'phone-left': 90,
            'phone-right': 90
        },
        sharedOrientation: 'portrait'
    });

    assert.equal(mapping.valid, true);
    assert.deepEqual(mapping.viewports.map(({ deviceId }) => deviceId), [
        'phone-left',
        'phone-right'
    ]);
    const leftEdge = mapping.viewports[0].corners
        .filter(({ y }) => Math.abs(y - 0.5) < 1e-6);
    const rightEdge = mapping.viewports[1].corners
        .filter(({ y }) => Math.abs(y - 0.5) < 1e-6);
    assert.equal(leftEdge.length, 2);
    const sortByX = (points) => points.sort((first, second) => first.x - second.x);
    assert.deepEqual(sortByX(leftEdge), sortByX(rightEdge));
});

test('requires a saved orientation baseline rather than guessing rotated geometry', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.2, 0.5, 0.8));
    const second = calibration('phone-b', rectangle(0.5, 0.2, 0.9, 0.8), {
        orientationAngle: 0
    });
    const mapping = calculateScreenSurfaceViewports([first, second], {
        timestamp: 1100,
        orientationAngles: { 'phone-a': 90, 'phone-b': 90 },
        sharedOrientation: 'portrait'
    });
    assert.equal(mapping.valid, false);
    assert.equal(mapping.reason, 'orientation-recalibration-required');
});

test('preserves projective angled surfaces while applying the shared orientation frame', () => {
    const angled = calibration('phone-a', [
        { x: 0.15, y: 0.05 },
        { x: 0.48, y: 0.25 },
        { x: 0.45, y: 0.85 },
        { x: 0.12, y: 0.65 }
    ], { orientationAngle: 0 });
    const lower = calibration('phone-b', rectangle(0.15, 0.55, 0.7, 0.95), {
        orientationAngle: 0
    });
    const mapping = calculateScreenSurfaceViewports([angled, lower], {
        timestamp: 1100,
        orientationAngles: { 'phone-a': 0, 'phone-b': 0 },
        sharedOrientation: 'portrait'
    });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'STACKED');
    assert.ok(mapping.viewports[0].localToSharedFrame.matrix3x3.some((value, index) =>
        index === 1 && Math.abs(value) > 0.01));
});

test('requires fresh independent marker observations that agree with calibrated screen centers', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.2, 0.4, 0.8));
    const second = calibration('phone-b', rectangle(0.4, 0.2, 0.8, 0.8));
    const observations = [
        {
            deviceId: 'phone-a', centerX: 0.25, centerY: 0.5,
            width: 0.04, height: 0.03, confidence: 0.9, receivedAt: 1100
        },
        {
            deviceId: 'phone-b', centerX: 0.6, centerY: 0.5,
            width: 0.04, height: 0.03, confidence: 0.9, receivedAt: 1100
        }
    ];

    assert.deepEqual(validateScreenSurfaceObservations([first, second], observations, {
        timestamp: 1200
    }), { valid: true, reason: null });
    assert.equal(validateScreenSurfaceObservations([first, second], observations.slice(0, 1), {
        timestamp: 1200
    }).reason, 'missing-or-stale-live-marker-observation');
    assert.equal(validateScreenSurfaceObservations([first, second], observations, {
        timestamp: 4000
    }).reason, 'missing-or-stale-live-marker-observation');
    assert.equal(validateScreenSurfaceObservations([first, {
        ...second,
        deviceId: 'phone-c'
    }], observations, { timestamp: 1200 }).reason,
    'missing-or-stale-live-marker-observation');
});

test('rejects moved markers independently without changing saved calibration', () => {
    const first = calibration('phone-a', rectangle(0.1, 0.2, 0.4, 0.8));
    const second = calibration('phone-b', rectangle(0.4, 0.2, 0.8, 0.8));
    const movedObservations = [
        {
            deviceId: 'phone-a', centerX: 0.25, centerY: 0.5,
            width: 0.04, height: 0.03, confidence: 0.9, receivedAt: 1100
        },
        {
            deviceId: 'phone-b', centerX: 0.7, centerY: 0.5,
            width: 0.04, height: 0.03, confidence: 0.9, receivedAt: 1100
        }
    ];

    assert.equal(validateScreenSurfaceObservations([first, second], movedObservations, {
        timestamp: 1200
    }).reason, 'screen-position-changed-recalibrate');
    assert.deepEqual(first.center, { x: 0.25, y: 0.5 });
    assert.deepEqual(second.center, { x: 0.6, y: 0.5 });
});
