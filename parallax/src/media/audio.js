export const AUDIO_MODES = Object.freeze(['master', 'all']);
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
    mode: 'master',
    masterDeviceId: null
});

export function validateAudioSettings(settings) {
    return Boolean(settings && typeof settings === 'object' && !Array.isArray(settings)
        && AUDIO_MODES.includes(settings.mode)
        && (settings.masterDeviceId === null
            || (typeof settings.masterDeviceId === 'string'
                && settings.masterDeviceId.length > 0
                && settings.masterDeviceId.length <= 128)));
}

export function createAudioSettings(settings = DEFAULT_AUDIO_SETTINGS) {
    if (!validateAudioSettings(settings)) {
        return { ...DEFAULT_AUDIO_SETTINGS };
    }
    return {
        mode: settings.mode,
        masterDeviceId: settings.masterDeviceId
    };
}

export function clampVolume(volume) {
    return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
}

export function loadDeviceAudioPreferences(storage, deviceId) {
    const raw = storage.getItem(`parallax-audio-${deviceId}`);
    if (!raw) {
        return { volume: 1, enabled: false };
    }
    let stored;
    try {
        stored = JSON.parse(raw);
    } catch {
        return { volume: 1, enabled: false };
    }
    return stored && Number.isFinite(stored.volume)
        && stored.volume >= 0 && stored.volume <= 1
        ? { volume: stored.volume, enabled: false }
        : { volume: 1, enabled: false };
}

export function saveDeviceAudioPreferences(storage, deviceId, volume) {
    const safeVolume = clampVolume(volume);
    storage.setItem(`parallax-audio-${deviceId}`, JSON.stringify({ volume: safeVolume }));
    return safeVolume;
}

export function getDeviceAudioState({
    settings = DEFAULT_AUDIO_SETTINGS,
    deviceId,
    globalVolume = 0,
    deviceVolume = 1,
    enabled = false
} = {}) {
    const audioSettings = createAudioSettings(settings);
    const isMaster = audioSettings.mode === 'master'
        && audioSettings.masterDeviceId === deviceId;
    const selected = audioSettings.mode === 'all' || isMaster;
    const volume = clampVolume(globalVolume) * clampVolume(deviceVolume);
    return {
        volume,
        muted: !selected || !enabled || volume === 0
    };
}
