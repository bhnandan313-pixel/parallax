import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clampVolume,
    createAudioSettings,
    getDeviceAudioState,
    loadDeviceAudioPreferences,
    saveDeviceAudioPreferences,
    validateAudioSettings
} from './audio.js';

test('validates explicit master and all-device audio modes', () => {
    assert.equal(validateAudioSettings({ mode: 'master', masterDeviceId: 'phone-1' }), true);
    assert.equal(validateAudioSettings({ mode: 'all', masterDeviceId: null }), true);
    assert.equal(validateAudioSettings({ mode: 'other', masterDeviceId: null }), false);
    assert.equal(validateAudioSettings({ mode: 'master', masterDeviceId: 7 }), false);
    assert.deepEqual(createAudioSettings(null), { mode: 'master', masterDeviceId: null });
});

test('master mode selects one device and all-device mode respects independent volumes', () => {
    const master = { mode: 'master', masterDeviceId: 'phone-1' };
    assert.deepEqual(getDeviceAudioState({
        settings: master,
        deviceId: 'phone-1',
        globalVolume: 0.8,
        deviceVolume: 0.5,
        enabled: true
    }), { volume: 0.4, muted: false });
    assert.deepEqual(getDeviceAudioState({
        settings: master,
        deviceId: 'phone-2',
        globalVolume: 0.8,
        enabled: true
    }), { volume: 0.8, muted: true });

    const allDevices = { mode: 'all', masterDeviceId: null };
    assert.deepEqual(getDeviceAudioState({
        settings: allDevices,
        deviceId: 'phone-2',
        globalVolume: 0.8,
        deviceVolume: 0.25,
        enabled: true
    }), { volume: 0.2, muted: false });
    assert.deepEqual(getDeviceAudioState({
        settings: allDevices,
        deviceId: 'phone-2',
        globalVolume: 0.8,
        deviceVolume: 0.25
    }), { volume: 0.2, muted: true });
    assert.equal(clampVolume(2), 1);
    assert.equal(clampVolume(-1), 0);
});

test('device volume persists while audio remains muted until a user enables it', () => {
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    };
    assert.deepEqual(loadDeviceAudioPreferences(storage, 'phone-1'), {
        volume: 1,
        enabled: false
    });
    assert.equal(saveDeviceAudioPreferences(storage, 'phone-1', 0.42), 0.42);
    assert.deepEqual(loadDeviceAudioPreferences(storage, 'phone-1'), {
        volume: 0.42,
        enabled: false
    });
    assert.equal(getDeviceAudioState({
        settings: { mode: 'all', masterDeviceId: null },
        deviceId: 'phone-1',
        globalVolume: 1,
        deviceVolume: 0.42,
        enabled: false
    }).muted, true);
    assert.equal(getDeviceAudioState({
        settings: { mode: 'all', masterDeviceId: null },
        deviceId: 'phone-1',
        globalVolume: 1,
        deviceVolume: 0.42,
        enabled: true
    }).muted, false);
});
