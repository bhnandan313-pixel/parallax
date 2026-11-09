import assert from 'node:assert/strict';
import jsAruco from 'js-aruco';
import sharp from 'sharp';
import test from 'node:test';
import {
    associateMarkerWithDevice,
    associateMarkersWithDevices,
    calculateRelativeArrangement,
    computeMarkerIdForDevice,
    createPersistentMarkerAssignments,
    createSpatialRelationshipState,
    createVisionTrackerState,
    createArucoMarkerPattern,
    createDefaultVisionCalibration,
    detectMarkersFromImageData,
    normalizeMarkerObservation,
    saveVisionCalibration,
    updateSpatialRelationship,
    updateVisionTracker,
    validateMarkerObservation,
    validateVisionCalibration
} from './marker-detection.js';
import { renderArucoMarker } from './marker-renderer.js';

const { AR } = jsAruco;

function trackedObservation(deviceId, markerId, centerX, centerY, orientationAngle, width = 0.1, height = 0.1) {
    return {
        deviceId,
        id: markerId,
        markerId,
        centerX,
        centerY,
        normalizedCenter: { x: centerX, y: centerY },
        corners: [],
        width,
        height,
        orientationAngle,
        rotation: orientationAngle,
        confidence: 0.9,
        isVisible: true
    };
}

function relationshipPair({
    firstId = 'device-a',
    secondId = 'device-b',
    first = { x: 0.2, y: 0.5, angle: 0, confidence: 0.9, width: 0.12, height: 0.12 },
    second = { x: 0.7, y: 0.5, angle: 0, confidence: 0.9, width: 0.18, height: 0.18 },
    timestamp = 1000
} = {}) {
    return [
        {
            deviceId: firstId,
            markerId: 21,
            centerX: first.x,
            centerY: first.y,
            width: first.width,
            height: first.height,
            orientationAngle: first.angle,
            confidence: first.confidence,
            isVisible: true,
            timestamp
        },
        {
            deviceId: secondId,
            markerId: 463,
            centerX: second.x,
            centerY: second.y,
            width: second.width,
            height: second.height,
            orientationAngle: second.angle,
            confidence: second.confidence,
            isVisible: true,
            timestamp
        }
    ];
}

function stableRelationship(pair, deviceIds = ['device-a', 'device-b'], options = {}) {
    const state = createSpatialRelationshipState();
    updateSpatialRelationship(state, pair, deviceIds, 1000, options);
    const result = updateSpatialRelationship(state, pair, deviceIds, 1600, options);
    return { state, result };
}

function createSyntheticMarkerImage(markerDefinitions, width = 640, height = 480, moduleSize = 20) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
        data[index * 4] = 255;
        data[index * 4 + 1] = 255;
        data[index * 4 + 2] = 255;
        data[index * 4 + 3] = 255;
    }

    for (const marker of markerDefinitions) {
        const pattern = createArucoMarkerPattern(marker.id);
        const left = Math.max(0, Math.round(marker.left));
        const top = Math.max(0, Math.round(marker.top));
        const markerModuleSize = marker.moduleSize ?? moduleSize;
        for (let row = 0; row < pattern.length; row += 1) {
            for (let column = 0; column < pattern[row].length; column += 1) {
                const isBlack = pattern[row][column] === 0;
                if (!isBlack) {
                    continue;
                }
                for (let y = row * markerModuleSize; y < (row + 1) * markerModuleSize; y += 1) {
                    for (let x = column * markerModuleSize; x < (column + 1) * markerModuleSize; x += 1) {
                        const offset = ((top + y) * width + left + x) * 4;
                        data[offset] = 0;
                        data[offset + 1] = 0;
                        data[offset + 2] = 0;
                    }
                }
            }
        }
    }

    return { width, height, data };
}

function detectSyntheticMarkers(markerDefinitions) {
    const detector = new AR.Detector();
    return detector.detect(createSyntheticMarkerImage(markerDefinitions));
}

function createRasterCanvas() {
    const canvas = { width: 0, height: 0 };
    const context = {
        fillStyle: '#000',
        fillRect(left, top, width, height) {
            if (!canvas.data) {
                canvas.data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
            }
            const value = this.fillStyle === '#fff' ? 255 : 0;
            for (let y = top; y < top + height; y += 1) {
                for (let x = left; x < left + width; x += 1) {
                    const offset = (y * canvas.width + x) * 4;
                    canvas.data[offset] = value;
                    canvas.data[offset + 1] = value;
                    canvas.data[offset + 2] = value;
                    canvas.data[offset + 3] = 255;
                }
            }
        }
    };
    canvas.getContext = () => context;
    return canvas;
}

test('creates a default calibration profile and validates practical marker sizes', () => {
    const calibration = createDefaultVisionCalibration();
    assert.equal(calibration.markerSizeMm, 60);
    assert.equal(calibration.perspective, 1);
    assert.equal(validateVisionCalibration(calibration), true);
    assert.equal(validateVisionCalibration({ markerSizeMm: 5, perspective: 0.1 }), false);
});

test('computes deterministic IDs for persistent device identities', () => {
    assert.equal(computeMarkerIdForDevice('device-a'), computeMarkerIdForDevice('device-a'));
    assert.notEqual(computeMarkerIdForDevice('device-a'), computeMarkerIdForDevice('device-b'));
    assert.equal(computeMarkerIdForDevice(''), null);
});

test('resolves hash collisions without changing existing assignments', () => {
    const collisionDevices = ['x0', 'x672'];
    const hash = computeMarkerIdForDevice(collisionDevices[0]);
    const originalHash = hash;
    const assignments = createPersistentMarkerAssignments(
        collisionDevices,
        { [collisionDevices[0]]: hash }
    );
    assert.equal(assignments[collisionDevices[0]], originalHash);
    assert.notEqual(assignments[collisionDevices[1]], originalHash);
});

test('persists replacements across reconnects and backend restarts', () => {
    const devices = ['phone-a', 'phone-b', 'phone-c'];
    const first = createPersistentMarkerAssignments(devices, {});
    const reconnected = createPersistentMarkerAssignments(devices, first);
    const restarted = createPersistentMarkerAssignments(devices, reconnected);
    assert.deepEqual(reconnected, first);
    assert.deepEqual(restarted, first);
    assert.equal(new Set(Object.values(restarted)).size, devices.length);
});

test('does not reuse a replacement marker when the replacement registry is edited invalidly', () => {
    const devices = ['phone-a', 'phone-b'];
    const assignments = createPersistentMarkerAssignments(devices, {
        'phone-a': 1,
        'phone-b': 1
    });
    assert.notEqual(assignments['phone-a'], assignments['phone-b']);
    assert.equal(assignments['phone-a'], 1);
});

test('removing a device does not change replacement IDs for remaining devices', () => {
    const devices = ['x0', 'x672', 'phone-c'];
    const assignments = createPersistentMarkerAssignments(devices, {});
    const remaining = createPersistentMarkerAssignments(devices.slice(1), assignments);
    assert.equal(remaining['x672'], assignments['x672']);
    assert.equal(remaining['phone-c'], assignments['phone-c']);
});

test('reports marker ID exhaustion', () => {
    const existingAssignments = Object.fromEntries(
        Array.from({ length: 1023 }, (_, index) => [`device-${index}`, index + 1])
    );
    assert.throws(
        () => createPersistentMarkerAssignments([...Object.keys(existingAssignments), 'new-device'], existingAssignments),
        /MARKER_ID_CAPACITY_EXHAUSTED/
    );
});

test('production-rendered markers decode after rotation, scaling, and JPEG compression', async () => {
    for (const [id, markerPixels, rotation] of [
        [1, 32, 0],
        [463, 40, 90],
        [1023, 56, 180],
        [21, 64, 270]
    ]) {
        const canvas = createRasterCanvas();
        assert.equal(renderArucoMarker(canvas, id, { moduleSize: 56, quietZoneModules: 1 }), true);
        const compressedMarker = await sharp(canvas.data, {
            raw: { width: canvas.width, height: canvas.height, channels: 4 }
        })
            .resize(markerPixels, markerPixels, { kernel: 'lanczos3' })
            .rotate(rotation)
            .jpeg({ quality: 72 })
            .toBuffer();
        const left = Math.floor((320 - markerPixels) / 2);
        const top = Math.floor((240 - markerPixels) / 2);
        const scene = await sharp({
            create: { width: 320, height: 240, channels: 3, background: '#fff' }
        })
            .composite([{ input: compressedMarker, left, top }])
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const detected = detectMarkersFromImageData({
            width: scene.info.width,
            height: scene.info.height,
            data: scene.data
        });
        assert.deepEqual(detected.map((marker) => marker.id), [id], `marker ${id}`);
        assert.equal(detected[0].corners.length, 4);
        assert.ok(detected[0].normalizedCenter.x > 0.4 && detected[0].normalizedCenter.x < 0.6);
        assert.ok(detected[0].normalizedCenter.y > 0.4 && detected[0].normalizedCenter.y < 0.6);
    }
});

test('round-trips valid js-aruco IDs and decodes multiple synthetic markers', () => {
    for (const id of [1, 21, 511, 1023]) {
        const detected = detectSyntheticMarkers([{ id, left: 220, top: 165 }]);
        assert.equal(detected.length, 1, `marker ${id} should be detected`);
        assert.equal(detected[0].id, id);
        assert.equal(detected[0].corners.length, 4);
    }

    const multiple = detectSyntheticMarkers([
        { id: 1, left: 30, top: 150 },
        { id: 21, left: 330, top: 150 }
    ]);
    assert.equal(multiple.length, 2);
    assert.deepEqual(multiple.map((marker) => marker.id).sort((left, right) => left - right), [1, 21]);
});

test('rotation-normalizes decoded js-aruco marker IDs', () => {
    const rotatedPattern = createArucoMarkerPattern(21);
    const turned = Array.from({ length: rotatedPattern.length }, (_, row) =>
        Array.from({ length: rotatedPattern.length }, (_, column) =>
            rotatedPattern[rotatedPattern.length - 1 - column][row]));
    const width = 640;
    const height = 480;
    const moduleSize = 20;
    const image = createSyntheticMarkerImage([{ id: 21, left: 220, top: 165 }], width, height, moduleSize);
    const markerData = image.data;
    const left = 220;
    const top = 165;
    for (let row = 0; row < turned.length; row += 1) {
        for (let column = 0; column < turned[row].length; column += 1) {
            if (turned[row][column] !== 0) {
                continue;
            }
            for (let y = row * moduleSize; y < (row + 1) * moduleSize; y += 1) {
                for (let x = column * moduleSize; x < (column + 1) * moduleSize; x += 1) {
                    const offset = ((top + y) * width + left + x) * 4;
                    markerData[offset] = 255;
                    markerData[offset + 1] = 255;
                    markerData[offset + 2] = 255;
                }
            }
        }
    }
    const unrotated = createArucoMarkerPattern(21);
    for (let row = 0; row < unrotated.length; row += 1) {
        for (let column = 0; column < unrotated[row].length; column += 1) {
            if (unrotated[row][column] !== 0) {
                continue;
            }
            for (let y = row * moduleSize; y < (row + 1) * moduleSize; y += 1) {
                for (let x = column * moduleSize; x < (column + 1) * moduleSize; x += 1) {
                    const offset = ((top + y) * width + left + x) * 4;
                    markerData[offset] = 255;
                    markerData[offset + 1] = 255;
                    markerData[offset + 2] = 255;
                }
            }
        }
    }
    for (let row = 0; row < turned.length; row += 1) {
        for (let column = 0; column < turned[row].length; column += 1) {
            if (turned[row][column] !== 0) {
                continue;
            }
            for (let y = row * moduleSize; y < (row + 1) * moduleSize; y += 1) {
                for (let x = column * moduleSize; x < (column + 1) * moduleSize; x += 1) {
                    const offset = ((top + y) * width + left + x) * 4;
                    markerData[offset] = 0;
                    markerData[offset + 1] = 0;
                    markerData[offset + 2] = 0;
                }
            }
        }
    }

    const detected = new AR.Detector().detect(image);
    assert.equal(detected.length, 1);
    assert.equal(detected[0].id, 21);
});

test('normalizes and validates marker observations without inventing missing values', () => {
    const marker = normalizeMarkerObservation({
        id: 21,
        corners: [
            { x: 10, y: 20 },
            { x: 110, y: 18 },
            { x: 120, y: 100 },
            { x: 12, y: 105 }
        ]
    }, 200, 200);

    assert.ok(marker);
    assert.equal(marker.id, 21);
    assert.equal(marker.visible, true);
    assert.equal(Number.isFinite(marker.rotation), true);
    assert.equal(marker.centerX, marker.normalizedCenter.x);
    assert.equal(marker.centerY, marker.normalizedCenter.y);
    assert.ok(marker.width > 0 && marker.width <= 1);
    assert.ok(marker.height > 0 && marker.height <= 1);
    assert.equal(marker.orientationAngle, marker.rotation);
    assert.equal(validateMarkerObservation({
        id: 14,
        corners: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 }
        ]
    }), true);
    assert.equal(validateMarkerObservation({ id: 'bad', corners: [] }), false);
});

test('calculates relative side-by-side arrangement and ordering from observed marker centers', () => {
    const arrangement = calculateRelativeArrangement([
        { id: 7, center: { x: 100, y: 90 }, rotation: 0.1, confidence: 0.9 },
        { id: 13, center: { x: 320, y: 110 }, rotation: 0.2, confidence: 0.8 }
    ]);

    assert.equal(arrangement.arrangement, 'side-by-side');
    assert.deepEqual(arrangement.leftToRight, [7, 13]);
    assert.equal(arrangement.detectedCount, 2);
    assert.equal(arrangement.horizontalOffset, 220);
    assert.equal(Number.isFinite(arrangement.confidence), true);
});

test('preserves resolved device identity when camera sends a null placeholder', () => {
    const markerId = computeMarkerIdForDevice('phone-one');
    const associated = associateMarkerWithDevice(
        { id: markerId, deviceId: null, x: 0.25, y: 0.5 },
        [{ id: 'phone-one', name: 'Left Phone', markerId }]
    );
    assert.equal(associated.deviceId, 'phone-one');
    assert.equal(associated.deviceName, 'Left Phone');
});

test('associates valid marker IDs to registered devices and rejects duplicates', () => {
    const registeredDevices = [
        { id: 'phone-one', name: 'Left Phone' },
        { id: 'phone-two', name: 'Right Phone' }
    ];
    const associated = associateMarkersWithDevices([
        { id: computeMarkerIdForDevice('phone-one'), corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
        { id: computeMarkerIdForDevice('phone-two'), corners: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }] },
        { id: computeMarkerIdForDevice('phone-one'), corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }
    ], registeredDevices);

    assert.equal(associated.length, 2);
    assert.equal(associated[0].deviceName, 'Left Phone');
    assert.equal(associateMarkerWithDevice({ id: 9999 }, registeredDevices), null);
});

test('tracks two detected markers independently when detection and registration order differ', () => {
    const detected = detectSyntheticMarkers([
        { id: 21, left: 40, top: 70, moduleSize: 8 },
        { id: 463, left: 350, top: 250, moduleSize: 18 }
    ]);
    assert.equal(detected.length, 2);
    const detectedWidths = new Map(detected.map(({ id, corners }) => [
        id,
        Math.max(...corners.map(({ x }) => x)) - Math.min(...corners.map(({ x }) => x))
    ]));
    assert.ok(detectedWidths.get(21) < detectedWidths.get(463));

    const registeredDevices = [
        { id: 'phone-two', markerId: 463 },
        { id: 'phone-one', markerId: 21 }
    ];
    const associated = associateMarkersWithDevices(detected, registeredDevices);
    assert.deepEqual(
        associated.map(({ deviceId }) => deviceId).sort(),
        ['phone-one', 'phone-two']
    );
    assert.equal(associated.find(({ id }) => id === 21).deviceId, 'phone-one');
    assert.equal(associated.find(({ id }) => id === 463).deviceId, 'phone-two');

    const tracker = createVisionTrackerState();
    const observations = updateVisionTracker(tracker, [
        trackedObservation('phone-two', 463, 0.72, 0.68, 0.8, 0.18, 0.2),
        trackedObservation('phone-one', 21, 0.18, 0.25, -0.3, 0.08, 0.1)
    ], 1000);
    assert.equal(observations.length, 2);
    assert.equal(tracker.devices.get('phone-one').markerId, 21);
    assert.equal(tracker.devices.get('phone-two').markerId, 463);
    assert.deepEqual(
        [tracker.devices.get('phone-one').centerX, tracker.devices.get('phone-one').centerY],
        [0.18, 0.25]
    );
    assert.deepEqual(
        [tracker.devices.get('phone-two').centerX, tracker.devices.get('phone-two').centerY],
        [0.72, 0.68]
    );
    assert.notEqual(
        tracker.devices.get('phone-one').orientationAngle,
        tracker.devices.get('phone-two').orientationAngle
    );
    assert.notEqual(tracker.devices.get('phone-one').width, tracker.devices.get('phone-two').width);
});

test('keeps one device visible and the other at its last position during temporary occlusion', () => {
    const tracker = createVisionTrackerState();
    updateVisionTracker(tracker, [
        trackedObservation('phone-one', 21, 0.2, 0.3, 0.1),
        trackedObservation('phone-two', 463, 0.8, 0.7, -0.2)
    ], 1000);

    const observations = updateVisionTracker(tracker, [
        trackedObservation('phone-one', 21, 0.3, 0.4, 0.2)
    ], 1250);
    const phoneOne = observations.find(({ deviceId }) => deviceId === 'phone-one');
    const phoneTwo = observations.find(({ deviceId }) => deviceId === 'phone-two');

    assert.equal(phoneOne.isVisible, true);
    assert.equal(phoneOne.trackingState, 'tracked');
    assert.equal(phoneTwo.isVisible, false);
    assert.equal(phoneTwo.trackingState, 'occluded');
    assert.deepEqual([phoneTwo.centerX, phoneTwo.centerY], [0.8, 0.7]);
    assert.equal(phoneTwo.timestamp, 1000);
});

test('marks both missing markers lost and expires stale observations', () => {
    const tracker = createVisionTrackerState();
    updateVisionTracker(tracker, [
        trackedObservation('phone-one', 21, 0.2, 0.3, 0),
        trackedObservation('phone-two', 463, 0.8, 0.7, 0)
    ], 1000);

    const lost = updateVisionTracker(tracker, [], 2600);
    assert.equal(lost.length, 2);
    assert.ok(lost.every(({ isVisible, trackingState }) =>
        isVisible === false && trackingState === 'lost'));

    const expired = updateVisionTracker(tracker, [], 11000);
    assert.deepEqual(expired, []);
    assert.equal(tracker.devices.size, 0);
});

test('reacquires a lost marker at its new position without carrying stale smoothing forward', () => {
    const tracker = createVisionTrackerState();
    updateVisionTracker(tracker, [
        trackedObservation('phone-one', 21, 0.2, 0.3, 0.1),
        trackedObservation('phone-two', 463, 0.8, 0.7, -0.2)
    ], 1000);

    const reacquired = updateVisionTracker(tracker, [
        trackedObservation('phone-two', 463, 0.35, 0.45, 0.6)
    ], 2800);
    const phoneOne = reacquired.find(({ deviceId }) => deviceId === 'phone-one');
    const phoneTwo = reacquired.find(({ deviceId }) => deviceId === 'phone-two');
    assert.equal(phoneOne.trackingState, 'lost');
    assert.equal(phoneTwo.trackingState, 'tracked');
    assert.equal(phoneTwo.isVisible, true);
    assert.deepEqual([phoneTwo.centerX, phoneTwo.centerY], [0.35, 0.45]);
    assert.equal(phoneTwo.orientationAngle, 0.6);
});

test('unknown and incorrect marker IDs do not create or overwrite device tracks', () => {
    const knownMarkerId = computeMarkerIdForDevice('phone-one');
    const associated = associateMarkersWithDevices([
        { id: 999, centerX: 0.7, centerY: 0.5 },
        { id: knownMarkerId, centerX: 0.2, centerY: 0.5 }
    ], [{ id: 'phone-one', markerId: knownMarkerId }]);
    assert.deepEqual(associated.map(({ deviceId }) => deviceId), ['phone-one']);

    const tracker = createVisionTrackerState();
    const tracked = updateVisionTracker(tracker, [
        trackedObservation('phone-one', knownMarkerId, 0.2, 0.5, 0)
    ], 1000);
    assert.equal(tracked.length, 1);
    assert.equal(tracker.devices.has('phone-two'), false);
    assert.equal(tracker.devices.get('phone-one').centerX, 0.2);
});

test('classifies side-by-side devices with camera-relative displacement and marker scale ratio', () => {
    const pair = relationshipPair({
        first: { x: 0.15, y: 0.45, angle: 0, confidence: 0.9, width: 0.1, height: 0.1 },
        second: { x: 0.62, y: 0.48, angle: 0.05, confidence: 0.85, width: 0.2, height: 0.2 }
    });
    const { result } = stableRelationship(pair);
    assert.equal(result.classification, 'SIDE_BY_SIDE');
    assert.equal(result.arrangement, 'SIDE_BY_SIDE');
    assert.equal(result.orientation, 'PARALLEL');
    assert.equal(result.relativeHorizontal, 0.47);
    assert.equal(result.relativeVertical, 0.03);
    assert.equal(result.markerScaleRatio, 2);
    assert.equal(result.coordinateSpace, 'normalized-camera-image');
});

test('classifies stacked devices independent of which device was registered first', () => {
    const pair = relationshipPair({
        firstId: 'upper-device',
        secondId: 'lower-device',
        first: { x: 0.5, y: 0.18, angle: 0, confidence: 0.9 },
        second: { x: 0.52, y: 0.7, angle: 0, confidence: 0.9 }
    });
    const { result } = stableRelationship(pair, ['upper-device', 'lower-device']);
    assert.equal(result.classification, 'STACKED');
    assert.equal(result.arrangement, 'STACKED');
    assert.deepEqual(result.deviceIds, ['upper-device', 'lower-device']);
});

test('flags reversed left-to-right order without changing device identity', () => {
    const pair = relationshipPair({
        firstId: 'registered-first',
        secondId: 'registered-second',
        first: { x: 0.78, y: 0.5, angle: 0, confidence: 0.9 },
        second: { x: 0.28, y: 0.51, angle: 0, confidence: 0.9 }
    });
    const { result } = stableRelationship(pair, ['registered-first', 'registered-second']);
    assert.equal(result.classification, 'REVERSED');
    assert.equal(result.arrangement, 'SIDE_BY_SIDE');
    assert.equal(result.reversed, true);
    assert.deepEqual(result.deviceIds, ['registered-first', 'registered-second']);
    assert.equal(result.relativeHorizontal, -0.5);
});

test('reports relative orientation separately from side-by-side arrangement', () => {
    const pair = relationshipPair({
        first: { x: 0.2, y: 0.5, angle: -0.05, confidence: 0.9 },
        second: { x: 0.65, y: 0.5, angle: 0.55, confidence: 0.9 }
    });
    const { result } = stableRelationship(pair);
    assert.equal(result.classification, 'ANGLED');
    assert.equal(result.arrangement, 'SIDE_BY_SIDE');
    assert.equal(result.orientation, 'ANGLED');
    assert.ok(result.relativeOrientationAngle > 0.5);
});

test('classifies devices beyond the normalized separation threshold as separated', () => {
    const pair = relationshipPair({
        first: { x: 0.08, y: 0.5, angle: 0, confidence: 0.9 },
        second: { x: 0.9, y: 0.5, angle: 0, confidence: 0.9 }
    });
    const { result } = stableRelationship(pair);
    assert.equal(result.classification, 'SEPARATED');
    assert.equal(result.arrangement, 'SEPARATED');
    assert.ok(result.relativeDistance >= 0.65);
});

test('returns UNKNOWN for missing, stale, or low-confidence pair observations', () => {
    const state = createSpatialRelationshipState();
    const pair = relationshipPair();
    const missing = updateSpatialRelationship(state, pair.slice(0, 1), ['device-a', 'device-b'], 1000);
    assert.equal(missing.classification, 'UNKNOWN');
    assert.equal(missing.relativeDistance, null);

    const lowConfidence = relationshipPair({
        first: { x: 0.2, y: 0.5, angle: 0, confidence: 0.9 },
        second: { x: 0.7, y: 0.5, angle: 0, confidence: 0.2 }
    });
    const low = updateSpatialRelationship(state, lowConfidence, ['device-a', 'device-b'], 1200);
    assert.equal(low.classification, 'UNKNOWN');
    assert.match(low.reason, /low-confidence|missing/);

    const stale = updateSpatialRelationship(state, pair, ['device-a', 'device-b'], 5000);
    assert.equal(stale.classification, 'UNKNOWN');
});

test('requires a new stable interval after a pair loses reliable tracking', () => {
    const state = createSpatialRelationshipState();
    const ids = ['device-a', 'device-b'];
    const pair = relationshipPair();
    updateSpatialRelationship(state, pair, ids, 1000);
    assert.equal(updateSpatialRelationship(state, pair, ids, 1600).classification, 'SIDE_BY_SIDE');

    const lost = updateSpatialRelationship(state, pair.slice(0, 1), ids, 1700);
    assert.equal(lost.classification, 'UNKNOWN');
    const reacquired = relationshipPair({ timestamp: 1800 });
    assert.equal(updateSpatialRelationship(state, reacquired, ids, 1800).classification, 'UNKNOWN');
    assert.equal(updateSpatialRelationship(state, reacquired, ids, 2300).classification, 'SIDE_BY_SIDE');
});

test('holds stable classification through noisy boundary measurements', () => {
    const state = createSpatialRelationshipState();
    const ids = ['device-a', 'device-b'];
    const sideBySide = relationshipPair({
        first: { x: 0.2, y: 0.4, angle: 0, confidence: 0.9 },
        second: { x: 0.65, y: 0.4, angle: 0, confidence: 0.9 }
    });
    updateSpatialRelationship(state, sideBySide, ids, 1000, { alpha: 0.9 });
    assert.equal(updateSpatialRelationship(state, sideBySide, ids, 1600, { alpha: 0.9 }).arrangement, 'SIDE_BY_SIDE');

    for (const [timestamp, dx, dy] of [
        [1700, 0.24, 0.22],
        [1900, 0.22, 0.24],
        [2100, 0.24, 0.22],
        [2300, 0.45, 0]
    ]) {
        const noisy = relationshipPair({
            first: { x: 0.2, y: 0.4, angle: 0, confidence: 0.9 },
            second: { x: 0.2 + dx, y: 0.4 + dy, angle: 0, confidence: 0.9 },
            timestamp
        });
        const result = updateSpatialRelationship(state, noisy, ids, timestamp, { alpha: 0.9 });
        assert.equal(result.arrangement, 'SIDE_BY_SIDE');
    }
});

test('accepts sustained arrangement changes after the hysteresis duration', () => {
    const state = createSpatialRelationshipState();
    const ids = ['device-a', 'device-b'];
    const sideBySide = relationshipPair({
        first: { x: 0.2, y: 0.2, angle: 0, confidence: 0.9 },
        second: { x: 0.65, y: 0.2, angle: 0, confidence: 0.9 }
    });
    updateSpatialRelationship(state, sideBySide, ids, 1000, { alpha: 0.9 });
    assert.equal(updateSpatialRelationship(state, sideBySide, ids, 1600, { alpha: 0.9 }).arrangement, 'SIDE_BY_SIDE');

    const stacked = relationshipPair({
        first: { x: 0.2, y: 0.2, angle: 0, confidence: 0.9 },
        second: { x: 0.22, y: 0.72, angle: 0, confidence: 0.9 }
    });
    const candidate = updateSpatialRelationship(state, stacked, ids, 1700, { alpha: 0.9 });
    assert.equal(candidate.arrangement, 'SIDE_BY_SIDE');
    const changed = updateSpatialRelationship(state, stacked, ids, 2300, { alpha: 0.9 });
    assert.equal(changed.arrangement, 'STACKED');
    assert.equal(changed.classification, 'STACKED');
});

test('reports one device moving closer while preserving the other device identity', () => {
    const state = createSpatialRelationshipState();
    const ids = ['stationary-device', 'moving-device'];
    const pair = relationshipPair({
        firstId: ids[0],
        secondId: ids[1],
        first: { x: 0.2, y: 0.5, angle: 0, confidence: 0.9 },
        second: { x: 0.7, y: 0.5, angle: 0, confidence: 0.9 }
    });
    updateSpatialRelationship(state, pair, ids, 1000);
    updateSpatialRelationship(state, pair, ids, 1600);
    const closer = relationshipPair({
        firstId: ids[0],
        secondId: ids[1],
        first: { x: 0.2, y: 0.5, angle: 0, confidence: 0.9 },
        second: { x: 0.58, y: 0.5, angle: 0, confidence: 0.9 },
        timestamp: 1700
    });
    const result = updateSpatialRelationship(state, closer, ids, 1700);
    assert.equal(result.movement, 'CLOSER');
    assert.deepEqual(result.deviceIds, ids);
    assert.ok(result.relativeHorizontal < 0.5);

    const farther = relationshipPair({
        firstId: ids[0],
        secondId: ids[1],
        first: { x: 0.2, y: 0.5, angle: 0, confidence: 0.9 },
        second: { x: 0.9, y: 0.5, angle: 0, confidence: 0.9 },
        timestamp: 1800
    });
    assert.equal(updateSpatialRelationship(state, farther, ids, 1800).movement, 'FARTHER');
});

test('stores calibration settings and rejects invalid data gracefully', () => {
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    };

    const valid = saveVisionCalibration(storage, { markerSizeMm: 65, perspective: 1.25, calibratedAt: Date.now(), calibrationStatus: 'calibrated' });
    assert.equal(valid.markerSizeMm, 65);
    assert.equal(validateVisionCalibration(JSON.parse(values.get('parallax-vision-calibration'))), true);
    assert.equal(saveVisionCalibration(storage, { markerSizeMm: 0, perspective: 0 }).markerSizeMm, 60);
    assert.deepEqual(detectMarkersFromImageData(null), []);
});
