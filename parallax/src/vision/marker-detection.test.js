import assert from 'node:assert/strict';
import jsAruco from 'js-aruco';
import test from 'node:test';
import {
    associateMarkerWithDevice,
    associateMarkersWithDevices,
    calculateRelativeArrangement,
    computeMarkerIdForDevice,
    createPersistentMarkerAssignments,
    createArucoMarkerPattern,
    createDefaultVisionCalibration,
    detectMarkersFromImageData,
    normalizeMarkerObservation,
    saveVisionCalibration,
    validateMarkerObservation,
    validateVisionCalibration
} from './marker-detection.js';

const { AR } = jsAruco;

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
        for (let row = 0; row < pattern.length; row += 1) {
            for (let column = 0; column < pattern[row].length; column += 1) {
                const isBlack = pattern[row][column] === 0;
                if (!isBlack) {
                    continue;
                }
                for (let y = row * moduleSize; y < (row + 1) * moduleSize; y += 1) {
                    for (let x = column * moduleSize; x < (column + 1) * moduleSize; x += 1) {
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
        Array.from({ length: 999 }, (_, index) => [`device-${index}`, index + 1])
    );
    assert.throws(
        () => createPersistentMarkerAssignments([...Object.keys(existingAssignments), 'new-device'], existingAssignments),
        /MARKER_ID_CAPACITY_EXHAUSTED/
    );
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
