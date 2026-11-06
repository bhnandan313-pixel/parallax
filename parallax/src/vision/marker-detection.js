import jsAruco from 'js-aruco';

const { AR } = jsAruco;
const detector = AR?.Detector ? new AR.Detector() : null;

export const ARUCO_DICTIONARY = 'ARUCO_ORIGINAL_5X5';
export const ARUCO_MARKER_ID_MIN = 0;
export const ARUCO_MARKER_ID_MAX = 1023;

const ARUCO_ROWS_BY_BITS = new Map([
    ['00', [1, 0, 0, 0, 0]],
    ['01', [1, 0, 1, 1, 1]],
    ['10', [0, 1, 0, 0, 1]],
    ['11', [0, 1, 1, 1, 0]]
]);

export function isSupportedArucoMarkerId(markerId) {
    const id = Number(markerId);
    return Number.isInteger(id)
        && id >= ARUCO_MARKER_ID_MIN
        && id <= ARUCO_MARKER_ID_MAX;
}

export function createArucoMarkerPattern(markerId) {
    if (!isSupportedArucoMarkerId(markerId)) {
        return null;
    }

    const inner = Array.from({ length: 5 }, () => Array(5).fill(0));
    for (let row = 0; row < 5; row += 1) {
        const pairIndex = 9 - row * 2;
        const key = `${(markerId >> pairIndex) & 1}${(markerId >> (pairIndex - 1)) & 1}`;
        inner[row] = [...ARUCO_ROWS_BY_BITS.get(key)];
    }

    return [
        [0, 0, 0, 0, 0, 0, 0],
        [0, ...inner[0], 0],
        [0, ...inner[1], 0],
        [0, ...inner[2], 0],
        [0, ...inner[3], 0],
        [0, ...inner[4], 0],
        [0, 0, 0, 0, 0, 0, 0]
    ];
}

export function createDefaultVisionCalibration() {
    return {
        markerSizeMm: 60,
        perspective: 1,
        calibratedAt: null,
        calibrationStatus: 'uncalibrated'
    };
}

export function validateVisionCalibration(calibration) {
    if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) {
        return false;
    }
    const markerSizeMm = Number(calibration.markerSizeMm);
    return Number.isFinite(markerSizeMm)
        && markerSizeMm >= 10
        && markerSizeMm <= 500
        && Number.isFinite(Number(calibration.perspective))
        && Number(calibration.perspective) >= 0.25
        && Number(calibration.perspective) <= 2;
}

export function loadVisionCalibration(storage = globalThis.localStorage) {
    if (!storage) {
        return createDefaultVisionCalibration();
    }
    try {
        const raw = storage.getItem('parallax-vision-calibration');
        if (!raw) {
            return createDefaultVisionCalibration();
        }
        const parsed = JSON.parse(raw);
        const next = { ...createDefaultVisionCalibration(), ...parsed };
        return validateVisionCalibration(next)
            ? next
            : createDefaultVisionCalibration();
    } catch {
        return createDefaultVisionCalibration();
    }
}

export function saveVisionCalibration(storage, calibration) {
    const next = validateVisionCalibration(calibration)
        ? { ...createDefaultVisionCalibration(), ...calibration }
        : createDefaultVisionCalibration();
    if (!storage) {
        return next;
    }
    try {
        storage.setItem('parallax-vision-calibration', JSON.stringify(next));
    } catch {
        // Ignore storage errors and fall back to in-memory values.
    }
    return next;
}

export function computeMarkerIdForDevice(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId.trim()) {
        return null;
    }
    let hash = 2166136261;
    for (let index = 0; index < deviceId.length; index += 1) {
        hash ^= deviceId.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 999) + 1;
}

export function estimateMarkerRotation(corners) {
    if (!Array.isArray(corners) || corners.length < 2) {
        return 0;
    }
    const [first, second] = corners;
    if (!first || !second) {
        return 0;
    }
    return Math.atan2(second.y - first.y, second.x - first.x);
}

export function validateMarkerObservation(marker) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        return false;
    }
    if (!Number.isFinite(Number(marker.id)) || Number(marker.id) <= 0) {
        return false;
    }
    if (!Array.isArray(marker.corners) || marker.corners.length !== 4) {
        return false;
    }
    return marker.corners.every((corner) =>
        corner
        && Number.isFinite(Number(corner.x))
        && Number.isFinite(Number(corner.y))
    );
}

export function normalizeMarkerObservation(marker, imageWidth = 1, imageHeight = 1) {
    if (!validateMarkerObservation(marker)) {
        return null;
    }
    const corners = marker.corners.map((corner) => ({
        x: Number(corner.x),
        y: Number(corner.y)
    }));

    const center = corners.reduce((sum, corner) => ({
        x: sum.x + corner.x,
        y: sum.y + corner.y
    }), { x: 0, y: 0 });

    const area = Math.abs(
        corners[0].x * corners[1].y
        + corners[1].x * corners[2].y
        + corners[2].x * corners[3].y
        + corners[3].x * corners[0].y
        - corners[0].y * corners[1].x
        - corners[1].y * corners[2].x
        - corners[2].y * corners[3].x
        - corners[3].y * corners[0].x
    ) / 2;

    const width = Math.max(1, Number(imageWidth) || 1);
    const height = Math.max(1, Number(imageHeight) || 1);
    const normalizedCenter = {
        x: (center.x / 4) / width,
        y: (center.y / 4) / height
    };
    const confidence = Math.min(1, Math.max(0.2, area / Math.max(1, width * height * 0.2)));

    return {
        id: Number(marker.id),
        corners,
        center: {
            x: center.x / 4,
            y: center.y / 4
        },
        normalizedCenter,
        rotation: estimateMarkerRotation(corners),
        confidence: Number(confidence.toFixed(4)),
        area: Number(area.toFixed(2)),
        visible: true
    };
}

export function detectMarkersFromImageData(imageData, options = {}) {
    if (!imageData || typeof imageData !== 'object' || !imageData.width || !imageData.height) {
        return [];
    }

    const detectorInstance = options.detector ?? detector;
    if (!detectorInstance || typeof detectorInstance.detect !== 'function') {
        return [];
    }

    try {
        const rawMarkers = detectorInstance.detect(imageData) ?? [];
        const minConfidence = Number(options.minConfidence ?? 0.2);
        return rawMarkers
            .filter((marker) => marker && Number.isFinite(Number(marker.id)))
            .map((marker) => normalizeMarkerObservation({
                id: marker.id,
                corners: marker.corners
            }, imageData.width, imageData.height))
            .filter((marker) => marker && marker.confidence >= minConfidence)
            .sort((left, right) => right.confidence - left.confidence);
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalizedError);
        throw normalizedError;
    }
}

export function calculateRelativeArrangement(markers, calibration = createDefaultVisionCalibration()) {
    const validMarkers = Array.isArray(markers)
        ? markers.filter((marker) => marker && Number.isFinite(marker.center?.x) && Number.isFinite(marker.center?.y))
        : [];

    if (validMarkers.length === 0) {
        return {
            arrangement: 'waiting',
            detectedCount: 0,
            leftToRight: [],
            topToBottom: [],
            horizontalOffset: 0,
            verticalOffset: 0,
            rotationEstimate: 0,
            confidence: 0,
            calibration
        };
    }

    const orderedByX = [...validMarkers].sort((left, right) => left.center.x - right.center.x);
    const orderedByY = [...validMarkers].sort((left, right) => left.center.y - right.center.y);
    const leftMarker = orderedByX[0];
    const rightMarker = orderedByX[orderedByX.length - 1];
    const topMarker = orderedByY[0];
    const bottomMarker = orderedByY[orderedByY.length - 1];
    const meanRotation = validMarkers.reduce((sum, marker) => sum + marker.rotation, 0) / validMarkers.length;

    return {
        arrangement: validMarkers.length >= 2 ? 'side-by-side' : 'single-marker',
        detectedCount: validMarkers.length,
        leftToRight: orderedByX.map((marker) => marker.id),
        topToBottom: orderedByY.map((marker) => marker.id),
        horizontalOffset: leftMarker && rightMarker
            ? Number((rightMarker.center.x - leftMarker.center.x).toFixed(4))
            : 0,
        verticalOffset: topMarker && bottomMarker
            ? Number((bottomMarker.center.y - topMarker.center.y).toFixed(4))
            : 0,
        rotationEstimate: Number((meanRotation / Math.PI).toFixed(4)),
        confidence: Number(
            (validMarkers.reduce((sum, marker) => sum + marker.confidence, 0) / validMarkers.length).toFixed(4)
        ),
        calibration
    };
}

export function associateMarkerWithDevice(marker, registeredDevices) {
    if (!marker || !Array.isArray(registeredDevices)) {
        return null;
    }
    const markerId = Number(marker.id);
    const matchedDevice = registeredDevices.find((device) => {
        const candidateMarkerId = computeMarkerIdForDevice(device?.id);
        return Number.isInteger(candidateMarkerId) && candidateMarkerId === markerId;
    });
    if (!matchedDevice) {
        return null;
    }
    return {
        markerId,
        deviceId: matchedDevice.id,
        deviceName: typeof matchedDevice.name === 'string' && matchedDevice.name.trim()
            ? matchedDevice.name.trim()
            : matchedDevice.id,
        ...marker
    };
}

export function associateMarkersWithDevices(markers, registeredDevices) {
    if (!Array.isArray(markers) || !Array.isArray(registeredDevices)) {
        return [];
    }
    const seen = new Set();
    return markers
        .map((marker) => associateMarkerWithDevice(marker, registeredDevices))
        .filter((entry) => {
            if (!entry || seen.has(entry.deviceId)) {
                return false;
            }
            seen.add(entry.deviceId);
            return true;
        });
}

export function createUniqueMarkerAssignments(deviceIds) {
    const assignments = [];
    const usedMarkerIds = new Map();
    const duplicateDeviceIds = [];
    for (const deviceId of Array.isArray(deviceIds) ? deviceIds : []) {
        if (typeof deviceId !== 'string' || !deviceId.trim()) {
            continue;
        }
        const markerId = computeMarkerIdForDevice(deviceId);
        const existing = usedMarkerIds.get(markerId);
        if (existing && existing !== deviceId) {
            duplicateDeviceIds.push({ markerId, deviceIds: [existing, deviceId] });
            continue;
        }
        usedMarkerIds.set(markerId, deviceId);
        assignments.push({ deviceId, markerId });
    }
    return { assignments, duplicateDeviceIds };
}

export function applyVisionPerspective(point, calibration = createDefaultVisionCalibration()) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    const scale = calibration?.perspective ?? 1;
    return {
        x: Number((x * scale).toFixed(6)),
        y: Number((y * scale).toFixed(6)),
        calibrated: Boolean(calibration?.calibratedAt)
    };
}

export function createVisionTrackerState() {
    return { devices: new Map(), timeoutMs: 1500 };
}

export function updateVisionTracker(state, observations, timestamp = Date.now(), options = {}) {
    if (!state?.devices) {
        return [];
    }
    const alpha = Math.min(0.95, Math.max(0.05, Number(options.alpha ?? 0.35)));
    const timeoutMs = Math.max(250, Number(options.timeoutMs ?? state.timeoutMs ?? 1500));
    const maxJump = Math.max(0.01, Number(options.maxJump ?? 0.18));
    const accepted = [];
    const seen = new Set();

    for (const observation of Array.isArray(observations) ? observations : []) {
        const deviceId = observation?.deviceId;
        if (!deviceId || seen.has(deviceId)) {
            continue;
        }
        const x = Number(observation.normalizedCenter?.x ?? observation.x);
        const y = Number(observation.normalizedCenter?.y ?? observation.y);
        const rotation = Number(observation.rotation ?? 0);
        const confidence = Number(observation.confidence ?? 0.5);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rotation)) {
            continue;
        }
        const previous = state.devices.get(deviceId);
        const jump = previous ? Math.hypot(x - previous.x, y - previous.y) : 0;
        if (previous?.status !== 'lost' && previous && jump > maxJump && confidence < 0.75) {
            continue;
        }

        const smoothedX = previous ? previous.x + alpha * (x - previous.x) : x;
        const smoothedY = previous ? previous.y + alpha * (y - previous.y) : y;
        let angleDelta = rotation - (previous?.rotation ?? rotation);
        while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
        while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
        const smoothedRotation = previous
            ? previous.rotation + alpha * angleDelta
            : rotation;
        const item = {
            ...observation,
            deviceId,
            x: Number(smoothedX.toFixed(4)),
            y: Number(smoothedY.toFixed(4)),
            normalizedCenter: { x: Number(smoothedX.toFixed(4)), y: Number(smoothedY.toFixed(4)) },
            rotation: Number(smoothedRotation.toFixed(4)),
            confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(4)),
            status: 'tracked',
            lastDetectedAt: timestamp
        };
        state.devices.set(deviceId, item);
        seen.add(deviceId);
        accepted.push(item);
    }

    for (const [deviceId, previous] of state.devices) {
        if (!seen.has(deviceId) && timestamp - previous.lastDetectedAt >= timeoutMs && previous.status !== 'lost') {
            state.devices.set(deviceId, {
                ...previous,
                status: 'lost'
            });
        }
    }
    return accepted;
}

export function resetVisionTrackerDevice(state, deviceId) {
    if (state?.devices instanceof Map && deviceId) {
        state.devices.delete(deviceId);
    }
}
