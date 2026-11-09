export const SHARED_ORIENTATION_MODES = Object.freeze([
    'AUTO',
    'LANDSCAPE',
    'PORTRAIT',
    'MANUAL'
]);
export const SHARED_ORIENTATIONS = Object.freeze(['landscape', 'portrait']);

const DEFAULT_MIN_STABLE_DURATION_MS = 1000;
const DEFAULT_MAX_REPORT_AGE_MS = 30_000;
const DEFAULT_MAX_SPATIAL_AGE_MS = 2000;

export function createSharedOrientationState() {
    return {
        mode: 'MANUAL',
        orientation: null,
        candidate: null,
        candidateSince: null,
        confidence: 0,
        reason: 'manual-mode-retains-existing-screen-settings'
    };
}

function getOrientationReport(deviceId, reports, now, maxAgeMs) {
    const report = reports instanceof Map ? reports.get(deviceId) : reports?.[deviceId];
    if (!report || !SHARED_ORIENTATIONS.includes(report.orientation)) {
        return null;
    }
    const timestamp = Number(report.timestamp);
    const confidence = Number(report.confidence);
    if (!Number.isFinite(timestamp) || now - timestamp < 0 || now - timestamp > maxAgeMs
        || !Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
        return null;
    }
    return { ...report, timestamp, confidence };
}

function resolveAutomaticOrientation(devices, reports, relationship, now, maxReportAgeMs,
    maxSpatialAgeMs) {
    if (!Array.isArray(devices) || devices.length !== 2
        || devices.some((device) => device?.connected !== true
            || typeof device.deviceId !== 'string' || !device.deviceId.trim())
        || new Set(devices.map((device) => device.deviceId)).size !== 2) {
        return { orientation: null, reason: 'both-display-devices-must-be-connected' };
    }
    const pair = devices.map((device) =>
        getOrientationReport(device.deviceId, reports, now, maxReportAgeMs));
    if (pair.some((report) => report === null)) {
        return { orientation: null, reason: 'missing-or-stale-device-orientation' };
    }
    const relationshipTimestamp = Number(relationship?.timestamp);
    if (relationship?.isReliable !== true
        || !Number.isFinite(relationshipTimestamp)
        || now - relationshipTimestamp < 0
        || now - relationshipTimestamp > maxSpatialAgeMs
        || !Number.isFinite(Number(relationship.confidence))
        || Number(relationship.confidence) < 0.5
        || !Array.isArray(relationship.deviceIds)
        || new Set(relationship.deviceIds).size !== 2
        || devices.some((device) => !relationship.deviceIds.includes(device.deviceId))) {
        return { orientation: null, reason: 'spatial-arrangement-unknown-or-stale' };
    }

    const confidence = Math.min(pair[0].confidence, pair[1].confidence,
        Number(relationship.confidence));
    if (!['SIDE_BY_SIDE', 'STACKED'].includes(relationship.arrangement)) {
        return { orientation: null, reason: 'spatial-arrangement-unknown-or-separated' };
    }
    if (pair[0].orientation === pair[1].orientation) {
        return { orientation: pair[0].orientation, confidence, reason: null };
    }

    const arrangement = relationship.arrangement;
    if (arrangement === 'SIDE_BY_SIDE') {
        return { orientation: 'landscape', confidence, reason: null };
    }
    if (arrangement === 'STACKED') {
        return { orientation: 'portrait', confidence, reason: null };
    }
    return { orientation: null, confidence: 0, reason: 'mixed-orientations-with-ambiguous-arrangement' };
}

export function updateSharedOrientation(state, {
    mode = state?.mode ?? 'MANUAL',
    devices = [],
    reports = new Map(),
    relationship = null,
    timestamp = Date.now(),
    minStableDurationMs = DEFAULT_MIN_STABLE_DURATION_MS,
    maxReportAgeMs = DEFAULT_MAX_REPORT_AGE_MS,
    maxSpatialAgeMs = DEFAULT_MAX_SPATIAL_AGE_MS
} = {}) {
    if (!state || !SHARED_ORIENTATION_MODES.includes(mode)) {
        throw new TypeError('A valid shared orientation state and mode are required');
    }
    const now = Number(timestamp);
    if (!Number.isFinite(now)) {
        throw new TypeError('Shared orientation timestamp must be finite');
    }
    if (state.mode !== mode) {
        state.mode = mode;
        state.candidate = null;
        state.candidateSince = null;
    }

    if (mode === 'MANUAL') {
        state.orientation = null;
        state.confidence = 0;
        state.reason = 'manual-mode-retains-existing-screen-settings';
        state.candidate = null;
        state.candidateSince = null;
        return getSnapshot(state, mode, null, false);
    }
    if (mode === 'LANDSCAPE' || mode === 'PORTRAIT') {
        state.orientation = mode.toLowerCase();
        state.confidence = 1;
        state.reason = null;
        state.candidate = null;
        state.candidateSince = null;
        return getSnapshot(state, mode, null, true);
    }

    const decision = resolveAutomaticOrientation(devices, reports, relationship, now,
        maxReportAgeMs, maxSpatialAgeMs);
    state.reason = decision.reason;
    if (!decision.orientation) {
        state.confidence = 0;
        state.candidate = null;
        state.candidateSince = null;
        return getSnapshot(state, mode, null, false);
    }

    state.confidence = decision.confidence;
    if (state.orientation === decision.orientation) {
        state.candidate = null;
        state.candidateSince = null;
        state.reason = null;
        return getSnapshot(state, mode, null, true);
    }
    if (state.candidate !== decision.orientation) {
        state.candidate = decision.orientation;
        state.candidateSince = now;
    }
    const stableDuration = Math.max(0, Number(minStableDurationMs) || 0);
    const stableSince = Number(state.candidateSince);
    if (now - stableSince >= stableDuration) {
        state.orientation = decision.orientation;
        state.candidate = null;
        state.candidateSince = null;
        state.reason = null;
        return getSnapshot(state, mode, null, true);
    }
    state.reason = 'waiting-for-stable-orientation-evidence';
    return getSnapshot(state, mode, state.candidate, false);
}

function getSnapshot(state, mode, pendingOrientation, evidenceSufficient) {
    return {
        mode,
        orientation: state.orientation,
        pendingOrientation,
        confidence: state.confidence,
        evidenceSufficient,
        reason: state.reason
    };
}
