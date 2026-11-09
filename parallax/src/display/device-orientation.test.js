import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDeviceOrientationReporter,
    detectDeviceOrientation,
    orientationFromDeviceAngles
} from './device-orientation.js';

class EventTargetMock {
    listeners = new Map();

    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) ?? new Set();
        callbacks.add(callback);
        this.listeners.set(name, callbacks);
    }

    removeEventListener(name, callback) {
        this.listeners.get(name)?.delete(callback);
    }

    dispatch(name, event = { type: name }) {
        for (const callback of this.listeners.get(name) ?? []) {
            callback(event);
        }
    }
}

test('detects portrait, landscape, and supported quarter-turn angles from Screen Orientation API', () => {
    assert.deepEqual(detectDeviceOrientation({
        screen: { orientation: { type: 'portrait-primary', angle: 0 } },
        window: { innerWidth: 360, innerHeight: 800 }
    }), {
        orientation: 'portrait',
        angle: 0,
        source: 'screen-orientation-api',
        confidence: 1
    });
    assert.equal(detectDeviceOrientation({
        screen: { orientation: { type: 'landscape-secondary', angle: 270 } }
    }).angle, 270);
    assert.equal(detectDeviceOrientation({
        screen: { orientation: { type: 'portrait-secondary', angle: 180 } }
    }).angle, 180);
    assert.equal(detectDeviceOrientation({
        screen: { orientation: { type: 'landscape-primary', angle: 90 } }
    }).orientation, 'landscape');
});

test('falls back to legacy angle or viewport dimensions and handles unavailable data', () => {
    assert.deepEqual(detectDeviceOrientation({
        screen: {},
        window: { orientation: -90, innerWidth: 800, innerHeight: 360 }
    }), {
        orientation: 'landscape',
        angle: 270,
        source: 'window-orientation',
        confidence: 0.8
    });
    assert.equal(detectDeviceOrientation({
        screen: {},
        window: { innerWidth: 360, innerHeight: 800 }
    }).orientation, 'portrait');
    assert.equal(detectDeviceOrientation({
        screen: {},
        window: { innerWidth: 500, innerHeight: 500 }
    }), null);
});

test('uses physical device sensor changes when the screen orientation API remains locked', () => {
    assert.equal(orientationFromDeviceAngles(90, 0), 'portrait');
    assert.equal(orientationFromDeviceAngles(0, 90), 'landscape');
    assert.equal(orientationFromDeviceAngles(45, 45), null);
    assert.deepEqual(detectDeviceOrientation({
        screen: { orientation: { type: 'portrait-primary', angle: 0 } },
        deviceOrientation: { beta: 0, gamma: 90 }
    }), {
        orientation: 'landscape',
        angle: null,
        source: 'device-orientation-sensor',
        confidence: 0.8
    });

    const window = new EventTargetMock();
    const orientationApi = { type: 'portrait-primary', angle: 0 };
    const reports = [];
    const reporter = createDeviceOrientationReporter({
        deviceId: 'sensor-phone',
        emit: (payload) => reports.push(payload),
        screen: { orientation: orientationApi },
        window,
        now: () => 1000,
        logger: { info() {}, warn() {} },
        setIntervalFn: () => null,
        clearIntervalFn() {}
    });

    reporter.report();
    window.dispatch('deviceorientation', {
        beta: 0,
        gamma: 90,
        absolute: true
    });
    assert.equal(reports.length, 2);
    assert.equal(reports[0].orientation, 'portrait');
    assert.equal(reports[1].orientation, 'landscape');
    assert.equal(reports[1].source, 'device-orientation-sensor');

    reporter.dispose();
});

test('reports changes once, supports forced reconnect reports, and cleans up listeners', () => {
    const window = new EventTargetMock();
    window.innerWidth = 360;
    window.innerHeight = 800;
    const orientationApi = new EventTargetMock();
    orientationApi.type = 'portrait-primary';
    orientationApi.angle = 0;
    const screen = { orientation: orientationApi };
    const reports = [];
    let heartbeat;
    let clearedHeartbeat = false;
    const reporter = createDeviceOrientationReporter({
        deviceId: 'phone-persistent-id',
        emit: (payload) => reports.push(payload),
        screen,
        window,
        now: () => 1234,
        setIntervalFn: (callback) => {
            heartbeat = callback;
            return 7;
        },
        clearIntervalFn: (timer) => {
            assert.equal(timer, 7);
            clearedHeartbeat = true;
        },
        logger: { info() {}, warn() {} }
    });

    reporter.report();
    window.dispatch('resize');
    assert.equal(reports.length, 1);
    orientationApi.type = 'landscape-primary';
    orientationApi.angle = 90;
    orientationApi.dispatch('change');
    assert.equal(reports.length, 2);
    assert.equal(reports[1].deviceId, 'phone-persistent-id');
    assert.equal(reports[1].orientation, 'landscape');
    reporter.report(true);
    assert.equal(reports.length, 3);
    heartbeat();
    assert.deepEqual(reports[3], { deviceId: 'phone-persistent-id', heartbeat: true });

    reporter.dispose();
    window.dispatch('orientationchange');
    assert.equal(reports.length, 4);
    assert.equal(clearedHeartbeat, true);
    assert.equal(window.listeners.get('resize').size, 0);
});
