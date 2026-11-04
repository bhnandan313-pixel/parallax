import assert from 'node:assert/strict';
import test from 'node:test';
import { getOrCreateDeviceId } from './device.js';
import { createParallaxSocket, getParallaxServerBaseUrl } from './socket.js';

test('reuses and persists a generated device ID', () => {
    const values = new Map();
    let generated = 0;
    const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    };
    const cryptoProvider = {
        randomUUID: () => `device-${++generated}`
    };

    assert.equal(getOrCreateDeviceId(storage, cryptoProvider), 'device-1');
    assert.equal(getOrCreateDeviceId(storage, cryptoProvider), 'device-1');
    assert.equal(generated, 1);
});

test('falls back to secure random bytes when randomUUID is unavailable', () => {
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    };
    const cryptoProvider = {
        getRandomValues: (bytes) => {
            bytes.fill(1);
            return bytes;
        }
    };

    const deviceId = getOrCreateDeviceId(storage, cryptoProvider);
    assert.match(deviceId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    assert.equal(storage.getItem('parallax_device_id'), deviceId);
});

test('uses the current browser host for Socket.IO and uploads', () => {
    const baseUrl = getParallaxServerBaseUrl({
        protocol: 'http:',
        hostname: '10.240.248.206'
    });
    let socketArguments;
    const socket = createParallaxSocket({
        protocol: 'http:',
        hostname: '10.240.248.206',
        socketFactory: (...args) => {
            socketArguments = args;
            return { connected: false };
        }
    });

    assert.equal(baseUrl, 'http://10.240.248.206:3001');
    assert.deepEqual(socketArguments, [
        baseUrl,
        { reconnection: true, timeout: 15000 }
    ]);
    assert.equal(socket.connected, false);
});
