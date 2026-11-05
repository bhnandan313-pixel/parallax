import assert from 'node:assert/strict';
import test from 'node:test';
import {
    associateMarkerWithDevice,
    associateMarkersWithDevices,
    calculateRelativeArrangement,
    computeMarkerIdForDevice,
    createDefaultVisionCalibration,
    detectMarkersFromImageData,
    normalizeMarkerObservation,
    saveVisionCalibration,
    validateMarkerObservation,
    validateVisionCalibration
} from './marker-detection.js';

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
