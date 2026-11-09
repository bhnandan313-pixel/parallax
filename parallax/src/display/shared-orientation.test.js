import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createSharedOrientationState,
    updateSharedOrientation
} from './shared-orientation.js';

const now = 50_000;
const devices = [
    { deviceId: 'phone-a', screen: 1, connected: true },
    { deviceId: 'phone-b', screen: 2, connected: true }
];

function reports(first, second, timestamp = now) {
    return new Map([
        ['phone-a', { orientation: first, angle: first === 'portrait' ? 0 : 90,
            confidence: 1, timestamp }],
        ['phone-b', { orientation: second, angle: second === 'portrait' ? 0 : 90,
            confidence: 1, timestamp }]
    ]);
}

function relationship(arrangement, timestamp = now) {
    return {
        arrangement,
        classification: arrangement,
        isReliable: true,
        confidence: 0.9,
        deviceIds: ['phone-a', 'phone-b'],
        timestamp
    };
}

function decide(mode, orientationReports, spatial = relationship('SIDE_BY_SIDE'),
    state = createSharedOrientationState(), time = now, deviceList = devices) {
    return updateSharedOrientation(state, {
        mode,
        devices: deviceList,
        reports: orientationReports,
        relationship: spatial,
        timestamp: time,
        minStableDurationMs: 1000
    });
}

test('AUTO selects matching portrait and landscape phone orientations after a stable interval', () => {
    const state = createSharedOrientationState();
    assert.equal(decide('AUTO', reports('portrait', 'portrait'), relationship('STACKED'), state)
        .pendingOrientation, 'portrait');
    assert.equal(decide('AUTO', reports('portrait', 'portrait', now + 1000),
        relationship('STACKED', now + 1000), state, now + 1000).orientation, 'portrait');
    assert.equal(decide('AUTO', reports('landscape', 'landscape', now + 1100),
        relationship('SIDE_BY_SIDE', now + 1100), state, now + 1100).orientation, 'portrait');
    assert.equal(decide('AUTO', reports('landscape', 'landscape', now + 2100),
        relationship('SIDE_BY_SIDE', now + 2100), state, now + 2100).orientation, 'landscape');
});

test('mixed device orientations use spatial arrangement without changing device identity', () => {
    const sideBySide = decide('AUTO', reports('portrait', 'landscape'),
        relationship('SIDE_BY_SIDE'));
    assert.equal(sideBySide.pendingOrientation, 'landscape');
    const stacked = decide('AUTO', reports('landscape', 'portrait'),
        relationship('STACKED'));
    assert.equal(stacked.pendingOrientation, 'portrait');
    const reversed = relationship('SIDE_BY_SIDE');
    reversed.reversed = true;
    reversed.classification = 'REVERSED';
    assert.equal(decide('AUTO', reports('portrait', 'landscape'), reversed).pendingOrientation,
        'landscape');
});

test('retains the last stable orientation when sensors, spatial evidence, or a device are unreliable', () => {
    const state = createSharedOrientationState();
    decide('AUTO', reports('portrait', 'portrait'), relationship('STACKED'), state, now);
    decide('AUTO', reports('portrait', 'portrait', now + 1000),
        relationship('STACKED', now + 1000), state, now + 1000);
    const disconnected = decide('AUTO', reports('landscape', 'landscape'),
        relationship('SIDE_BY_SIDE'), state, now + 1200,
        devices.map((device, index) => ({ ...device, connected: index === 0 })));
    assert.equal(disconnected.orientation, 'portrait');
    assert.equal(disconnected.reason, 'both-display-devices-must-be-connected');

    const stale = decide('AUTO', reports('landscape', 'landscape', now - 31_000),
        relationship('SIDE_BY_SIDE'), state, now + 1200);
    assert.equal(stale.orientation, 'portrait');
    assert.equal(stale.reason, 'missing-or-stale-device-orientation');
    const unknownSpatial = decide('AUTO', reports('landscape', 'landscape'),
        { ...relationship('UNKNOWN'), isReliable: false }, state, now + 1200);
    assert.equal(unknownSpatial.orientation, 'portrait');
    const separated = decide('AUTO', reports('landscape', 'landscape'),
        relationship('SEPARATED', now + 1200), state, now + 1200);
    assert.equal(separated.orientation, 'portrait');
    assert.equal(separated.reason, 'spatial-arrangement-unknown-or-separated');
});

test('ambiguous mixed orientation waits, then accepts a stable supported arrangement', () => {
    const state = createSharedOrientationState();
    const ambiguous = { ...relationship('UNKNOWN'), isReliable: false };
    assert.equal(decide('AUTO', reports('portrait', 'landscape'), ambiguous, state).orientation,
        null);
    assert.equal(decide('AUTO', reports('portrait', 'landscape'), relationship('STACKED'),
        state, now + 10).pendingOrientation, 'portrait');
    assert.equal(decide('AUTO', reports('portrait', 'landscape'), relationship('STACKED'),
        state, now + 1010).orientation, 'portrait');
});

test('forced modes take precedence and MANUAL preserves legacy per-screen behavior', () => {
    assert.equal(decide('LANDSCAPE', new Map(), null).orientation, 'landscape');
    assert.equal(decide('PORTRAIT', new Map(), null).orientation, 'portrait');
    const manual = decide('MANUAL', reports('landscape', 'landscape'));
    assert.equal(manual.orientation, null);
    assert.equal(manual.reason, 'manual-mode-retains-existing-screen-settings');
});
