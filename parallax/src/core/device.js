function createDeviceId(cryptoProvider) {
    if (typeof cryptoProvider?.randomUUID === 'function') {
        return cryptoProvider.randomUUID();
    }

    if (typeof cryptoProvider?.getRandomValues === 'function') {
        const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    throw new Error('This browser does not support secure device ID generation');
}

export function getOrCreateDeviceId(
    storage = globalThis.localStorage,
    cryptoProvider = globalThis.crypto
) {
    let deviceId = storage.getItem('parallax_device_id');
    if (!deviceId) {
        deviceId = createDeviceId(cryptoProvider);
        storage.setItem('parallax_device_id', deviceId);
    }
    return deviceId;
}
