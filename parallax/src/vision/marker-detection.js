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

function normalizeAngle(angle) {
    const fullRotation = Math.PI * 2;
    return ((angle + Math.PI) % fullRotation + fullRotation) % fullRotation - Math.PI;
}

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

export const MIN_PARALLAX_MARKER_ID = 1;
export const MAX_PARALLAX_MARKER_ID = ARUCO_MARKER_ID_MAX;

export function allocateMarkerId(deviceId, usedMarkerIds) {
    if (typeof deviceId !== 'string' || !deviceId.trim()) {
        return null;
    }
    const used = usedMarkerIds instanceof Set
        ? usedMarkerIds
        : new Set(Array.isArray(usedMarkerIds) ? usedMarkerIds : []);
    const initialMarkerId = computeMarkerIdForDevice(deviceId);
    if (!used.has(initialMarkerId)) {
        return initialMarkerId;
    }
    for (let offset = 1; offset < MAX_PARALLAX_MARKER_ID; offset += 1) {
        const markerId = ((initialMarkerId - 1 + offset) % MAX_PARALLAX_MARKER_ID) + MIN_PARALLAX_MARKER_ID;
        if (!used.has(markerId)) {
            return markerId;
        }
    }
    return null;
}

export function createPersistentMarkerAssignments(deviceIds, existingAssignments = {}) {
    const normalizedDeviceIds = [...new Set((Array.isArray(deviceIds) ? deviceIds : [])
        .filter((deviceId) => typeof deviceId === 'string' && deviceId.trim()))];
    const assignments = {};
    const usedMarkerIds = new Map();

    for (const deviceId of normalizedDeviceIds) {
        const existingMarkerId = Number(existingAssignments?.[deviceId]);
        if (!Number.isInteger(existingMarkerId)
            || existingMarkerId < MIN_PARALLAX_MARKER_ID
            || existingMarkerId > MAX_PARALLAX_MARKER_ID
            || usedMarkerIds.has(existingMarkerId)) {
            continue;
        }
        assignments[deviceId] = existingMarkerId;
        usedMarkerIds.set(existingMarkerId, deviceId);
    }

    for (const deviceId of normalizedDeviceIds) {
        if (Object.prototype.hasOwnProperty.call(assignments, deviceId)) {
            continue;
        }
        const initialMarkerId = computeMarkerIdForDevice(deviceId);
        const initialOwner = usedMarkerIds.get(initialMarkerId);
        if (!initialOwner) {
            assignments[deviceId] = initialMarkerId;
            usedMarkerIds.set(initialMarkerId, deviceId);
            continue;
        }
        const replacementMarkerId = allocateMarkerId(
            deviceId,
            new Set([...usedMarkerIds.keys()])
        );
        if (replacementMarkerId === null) {
            throw new Error('MARKER_ID_CAPACITY_EXHAUSTED');
        }
        assignments[deviceId] = replacementMarkerId;
        usedMarkerIds.set(replacementMarkerId, deviceId);
    }
    return assignments;
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
    const minX = Math.min(...corners.map((corner) => corner.x));
    const maxX = Math.max(...corners.map((corner) => corner.x));
    const minY = Math.min(...corners.map((corner) => corner.y));
    const maxY = Math.max(...corners.map((corner) => corner.y));
    const normalizedCenter = {
        x: (center.x / 4) / width,
        y: (center.y / 4) / height
    };
    const rotation = estimateMarkerRotation(corners);
    const confidence = Math.min(1, Math.max(0.2, area / Math.max(1, width * height * 0.2)));

    return {
        id: Number(marker.id),
        corners,
        center: {
            x: center.x / 4,
            y: center.y / 4
        },
        normalizedCenter,
        centerX: normalizedCenter.x,
        centerY: normalizedCenter.y,
        normalizedCorners: corners.map((corner) => ({
            x: corner.x / width,
            y: corner.y / height
        })),
        width: (maxX - minX) / width,
        height: (maxY - minY) / height,
        rotation,
        orientationAngle: rotation,
        confidence: Number(confidence.toFixed(4)),
        area: Number(area.toFixed(2)),
        visible: true,
        isVisible: true
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
        const candidateMarkerId = Number.isInteger(Number(device?.markerId))
            ? Number(device.markerId)
            : computeMarkerIdForDevice(device?.id);
        return Number.isInteger(candidateMarkerId) && candidateMarkerId === markerId;
    });
    if (!matchedDevice) {
        return null;
    }
    return {
        ...marker,
        markerId,
        deviceId: matchedDevice.id,
        deviceName: typeof matchedDevice.name === 'string' && matchedDevice.name.trim()
            ? matchedDevice.name.trim()
            : matchedDevice.id
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
    const assignments = Object.entries(
        createPersistentMarkerAssignments(deviceIds)
    ).map(([deviceId, markerId]) => ({ deviceId, markerId }));
    const duplicateDeviceIds = [];
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
    return { devices: new Map(), timeoutMs: 1500, staleMs: 10000 };
}

export function createSpatialRelationshipState() {
    return {
        deviceIds: null,
        metrics: null,
        previousDistance: null,
        arrangement: 'UNKNOWN',
        arrangementCandidate: null,
        arrangementCandidateSince: null,
        orientation: 'UNKNOWN',
        orientationCandidate: null,
        orientationCandidateSince: null,
        reversed: false,
        reversedCandidate: null,
        reversedCandidateSince: null,
        movement: 'STATIONARY'
    };
}

function updateStableCandidate(state, key, candidate, timestamp, durationMs) {
    const stableKey = key;
    const candidateKey = `${key}Candidate`;
    const sinceKey = `${key}CandidateSince`;
    if (state[stableKey] === candidate) {
        state[candidateKey] = null;
        state[sinceKey] = null;
        return state[stableKey];
    }
    if (state[candidateKey] !== candidate) {
        state[candidateKey] = candidate;
        state[sinceKey] = timestamp;
        return state[stableKey];
    }
    if (timestamp - state[sinceKey] >= durationMs) {
        state[stableKey] = candidate;
        state[candidateKey] = null;
        state[sinceKey] = null;
    }
    return state[stableKey];
}

function createUnknownSpatialRelationship(deviceIds = [], reason = 'insufficient-observations') {
    return {
        classification: 'UNKNOWN',
        arrangement: 'UNKNOWN',
        orientation: 'UNKNOWN',
        reversed: false,
        deviceIds,
        relativeHorizontal: null,
        relativeVertical: null,
        relativeDistance: null,
        relativeAngle: null,
        relativeOrientationAngle: null,
        markerScaleRatio: null,
        movement: 'UNKNOWN',
        confidence: 0,
        trackingState: 'unknown',
        reason,
        timestamp: Date.now(),
        coordinateSpace: 'normalized-camera-image'
    };
}

export function updateSpatialRelationship(
    state,
    observations,
    registeredDeviceIds,
    timestamp = Date.now(),
    options = {}
) {
    if (!state || !Array.isArray(registeredDeviceIds)) {
        return createUnknownSpatialRelationship([], 'invalid-tracking-state');
    }
    const deviceIds = [...new Set(registeredDeviceIds.filter((id) =>
        typeof id === 'string' && id.trim()))].slice(0, 2);
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
    const minConfidence = Number.isFinite(Number(options.minConfidence))
        ? Number(options.minConfidence)
        : 0.5;
    const maxObservationAgeMs = Number.isFinite(Number(options.maxObservationAgeMs))
        ? Number(options.maxObservationAgeMs)
        : 2000;
    const minObservationDurationMs = Number.isFinite(Number(options.minObservationDurationMs))
        ? Number(options.minObservationDurationMs)
        : 500;
    const alpha = Number.isFinite(Number(options.alpha))
        ? Math.min(0.95, Math.max(0.05, Number(options.alpha)))
        : 0.3;

    if (deviceIds.length !== 2) {
        return createUnknownSpatialRelationship(deviceIds, 'two-devices-required');
    }
    if (!Array.isArray(observations)) {
        return createUnknownSpatialRelationship(deviceIds);
    }
    if (!Array.isArray(state.deviceIds) || state.deviceIds.join('\0') !== deviceIds.join('\0')) {
        Object.assign(state, createSpatialRelationshipState(), { deviceIds });
    }

    const observationByDevice = new Map(observations
        .filter((observation) => observation?.deviceId)
        .map((observation) => [observation.deviceId, observation]));
    const [first, second] = deviceIds.map((deviceId) => observationByDevice.get(deviceId));
    const pair = [first, second];
    const usable = pair.every((observation) => {
        const x = Number(observation?.centerX ?? observation?.normalizedCenter?.x ?? observation?.x);
        const y = Number(observation?.centerY ?? observation?.normalizedCenter?.y ?? observation?.y);
        const confidence = Number(observation?.confidence);
        const observedAt = Number(observation?.lastDetectedAt ?? observation?.timestamp);
        return observation
            && observation.isVisible !== false
            && observation.visible !== false
            && observation.status !== 'lost'
            && observation.trackingState !== 'lost'
            && Number.isFinite(x) && x >= 0 && x <= 1
            && Number.isFinite(y) && y >= 0 && y <= 1
            && Number.isFinite(confidence) && confidence >= minConfidence
            && Number.isFinite(observedAt)
            && now - observedAt >= 0
            && now - observedAt <= maxObservationAgeMs;
    });
    if (!usable) {
        Object.assign(state, createSpatialRelationshipState(), { deviceIds });
        return createUnknownSpatialRelationship(deviceIds, 'missing-or-low-confidence-observation');
    }

    const [firstObservation, secondObservation] = pair;
    const firstX = Number(firstObservation.centerX ?? firstObservation.normalizedCenter?.x ?? firstObservation.x);
    const firstY = Number(firstObservation.centerY ?? firstObservation.normalizedCenter?.y ?? firstObservation.y);
    const secondX = Number(secondObservation.centerX ?? secondObservation.normalizedCenter?.x ?? secondObservation.x);
    const secondY = Number(secondObservation.centerY ?? secondObservation.normalizedCenter?.y ?? secondObservation.y);
    const deltaX = secondX - firstX;
    const deltaY = secondY - firstY;
    const distance = Math.hypot(deltaX, deltaY);
    const firstAngle = Number(firstObservation.orientationAngle ?? firstObservation.rotation);
    const secondAngle = Number(secondObservation.orientationAngle ?? secondObservation.rotation);
    if (!Number.isFinite(firstAngle) || !Number.isFinite(secondAngle)) {
        return createUnknownSpatialRelationship(deviceIds, 'invalid-orientation-observation');
    }
    const orientationDelta = normalizeAngle(secondAngle - firstAngle);
    const firstWidth = Number(firstObservation.width);
    const firstHeight = Number(firstObservation.height);
    const secondWidth = Number(secondObservation.width);
    const secondHeight = Number(secondObservation.height);
    const firstScale = firstWidth > 0 && firstHeight > 0 ? Math.sqrt(firstWidth * firstHeight) : null;
    const secondScale = secondWidth > 0 && secondHeight > 0 ? Math.sqrt(secondWidth * secondHeight) : null;
    const rawMetrics = {
        deltaX,
        deltaY,
        distance,
        bearing: Math.atan2(deltaY, deltaX),
        orientationDelta,
        scaleRatio: firstScale && secondScale ? secondScale / firstScale : null
    };
    const previousMetrics = state.metrics;
    const metrics = previousMetrics
        ? {
            deltaX: previousMetrics.deltaX + alpha * (rawMetrics.deltaX - previousMetrics.deltaX),
            deltaY: previousMetrics.deltaY + alpha * (rawMetrics.deltaY - previousMetrics.deltaY),
            distance: previousMetrics.distance + alpha * (rawMetrics.distance - previousMetrics.distance),
            bearing: normalizeAngle(previousMetrics.bearing
                + alpha * normalizeAngle(rawMetrics.bearing - previousMetrics.bearing)),
            orientationDelta: normalizeAngle(previousMetrics.orientationDelta
                + alpha * normalizeAngle(rawMetrics.orientationDelta - previousMetrics.orientationDelta)),
            scaleRatio: rawMetrics.scaleRatio === null
                ? null
                : previousMetrics.scaleRatio === null
                    ? rawMetrics.scaleRatio
                    : previousMetrics.scaleRatio + alpha * (rawMetrics.scaleRatio - previousMetrics.scaleRatio)
        }
        : rawMetrics;
    state.metrics = metrics;

    const horizontal = Math.abs(metrics.deltaX);
    const vertical = Math.abs(metrics.deltaY);
    const dominantRatio = Math.max(horizontal, vertical) / Math.max(0.0001, Math.min(horizontal, vertical));
    const currentArrangement = state.arrangement;
    let arrangementCandidate = 'UNKNOWN';
    const separationThreshold = currentArrangement === 'SEPARATED' ? 0.6 : 0.65;
    if (metrics.distance >= separationThreshold) {
        arrangementCandidate = 'SEPARATED';
    } else if (horizontal >= Math.max(0.06, vertical * (currentArrangement === 'SIDE_BY_SIDE' ? 1.15 : 1.4))) {
        arrangementCandidate = 'SIDE_BY_SIDE';
    } else if (vertical >= Math.max(0.06, horizontal * (currentArrangement === 'STACKED' ? 1.15 : 1.4))) {
        arrangementCandidate = 'STACKED';
    }
    const arrangement = updateStableCandidate(
        state,
        'arrangement',
        arrangementCandidate,
        now,
        minObservationDurationMs
    );

    const angleDifference = Math.abs(metrics.orientationDelta);
    const orientationCandidate = angleDifference >= (state.orientation === 'ANGLED' ? 0.26 : 0.35)
        ? 'ANGLED'
        : 'PARALLEL';
    const orientation = updateStableCandidate(
        state,
        'orientation',
        orientationCandidate,
        now,
        minObservationDurationMs
    );
    const reversedCandidate = arrangementCandidate === 'SIDE_BY_SIDE'
        && metrics.deltaX < (state.reversed ? 0.02 : -0.04);
    const reversed = updateStableCandidate(
        state,
        'reversed',
        reversedCandidate,
        now,
        minObservationDurationMs
    );

    const minimumMarkerConfidence = Math.min(
        Number(firstObservation.confidence),
        Number(secondObservation.confidence)
    );
    const axisClarity = dominantRatio >= 1.4 ? 1 : Math.max(0, (dominantRatio - 1) / 0.4);
    const confidence = Number((minimumMarkerConfidence * (0.65 + 0.35 * axisClarity)).toFixed(4));
    const confidentPair = confidence >= minConfidence;
    const previousDistance = state.previousDistance;
    const movementThreshold = Number(options.movementThreshold ?? 0.003);
    if (previousDistance !== null && Math.abs(metrics.distance - previousDistance) > movementThreshold) {
        state.movement = metrics.distance < previousDistance ? 'CLOSER' : 'FARTHER';
    } else if (previousDistance === null || Math.abs(metrics.distance - previousDistance) <= movementThreshold) {
        state.movement = 'STATIONARY';
    }
    state.previousDistance = metrics.distance;

    const classification = !confidentPair
        ? 'UNKNOWN'
        : arrangement === 'SEPARATED'
            ? 'SEPARATED'
                : arrangement === 'SIDE_BY_SIDE' && reversed
                ? 'REVERSED'
                : orientation === 'ANGLED'
                    ? 'ANGLED'
                    : arrangement;
    return {
        classification,
        arrangement: confidentPair ? arrangement : 'UNKNOWN',
        orientation: confidentPair ? orientation : 'UNKNOWN',
        reversed: confidentPair && arrangement === 'SIDE_BY_SIDE' && reversed,
        isReliable: confidentPair && (arrangement !== 'UNKNOWN' || orientation === 'ANGLED'),
        deviceIds,
        relativeHorizontal: Number(metrics.deltaX.toFixed(4)),
        relativeVertical: Number(metrics.deltaY.toFixed(4)),
        relativeDistance: Number(metrics.distance.toFixed(4)),
        relativeAngle: Number(metrics.bearing.toFixed(4)),
        relativeOrientationAngle: Number(metrics.orientationDelta.toFixed(4)),
        markerScaleRatio: metrics.scaleRatio === null
            ? null
            : Number(metrics.scaleRatio.toFixed(4)),
        movement: confidentPair ? state.movement : 'UNKNOWN',
        confidence,
        trackingState: 'tracked',
        reason: !confidentPair ? 'low-confidence' : arrangement === 'UNKNOWN' ? 'ambiguous-geometry' : null,
        timestamp: now,
        coordinateSpace: 'normalized-camera-image'
    };
}

export function updateVisionTracker(state, observations, timestamp = Date.now(), options = {}) {
    if (!state?.devices) {
        return [];
    }
    const requestedAlpha = Number(options.alpha ?? 0.35);
    const requestedTimeout = Number(options.timeoutMs ?? state.timeoutMs ?? 1500);
    const requestedStaleTime = Number(options.staleMs ?? state.staleMs ?? 10000);
    const requestedMaxJump = Number(options.maxJump ?? 0.18);
    const alpha = Number.isFinite(requestedAlpha)
        ? Math.min(0.95, Math.max(0.05, requestedAlpha))
        : 0.35;
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(250, requestedTimeout) : 1500;
    const staleMs = Number.isFinite(requestedStaleTime)
        ? Math.max(timeoutMs, requestedStaleTime)
        : Math.max(timeoutMs, 10000);
    const maxJump = Number.isFinite(requestedMaxJump) ? Math.max(0.01, requestedMaxJump) : 0.18;
    const updatedAt = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
    const seen = new Set();

    for (const [deviceId, previous] of state.devices) {
        const age = updatedAt - previous.lastDetectedAt;
        if (age >= staleMs) {
            state.devices.delete(deviceId);
        } else if (age >= timeoutMs && previous.status !== 'lost') {
            state.devices.set(deviceId, {
                ...previous,
                isVisible: false,
                visible: false,
                status: 'lost',
                trackingState: 'lost'
            });
        }
    }

    for (const observation of Array.isArray(observations) ? observations : []) {
        const deviceId = observation?.deviceId;
        if (typeof deviceId !== 'string' || !deviceId.trim() || seen.has(deviceId)) {
            continue;
        }
        const x = Number(observation.centerX ?? observation.normalizedCenter?.x ?? observation.x);
        const y = Number(observation.centerY ?? observation.normalizedCenter?.y ?? observation.y);
        const rotation = normalizeAngle(Number(observation.orientationAngle ?? observation.rotation ?? 0));
        const confidence = Number(observation.confidence ?? 0.5);
        if (!Number.isFinite(x) || x < 0 || x > 1
            || !Number.isFinite(y) || y < 0 || y > 1
            || !Number.isFinite(rotation) || !Number.isFinite(confidence)) {
            continue;
        }
        const previous = state.devices.get(deviceId);
        const jump = previous ? Math.hypot(x - previous.x, y - previous.y) : 0;
        if (previous?.isVisible && jump > maxJump && confidence < 0.75) {
            continue;
        }

        const canSmooth = previous && previous.status !== 'lost';
        const smoothedX = canSmooth ? previous.x + alpha * (x - previous.x) : x;
        const smoothedY = canSmooth ? previous.y + alpha * (y - previous.y) : y;
        const angleDelta = normalizeAngle(rotation - (canSmooth ? previous.orientationAngle : rotation));
        const smoothedRotation = canSmooth
            ? previous.orientationAngle + alpha * angleDelta
            : rotation;
        const centerX = Number(smoothedX.toFixed(4));
        const centerY = Number(smoothedY.toFixed(4));
        const orientationAngle = Number(smoothedRotation.toFixed(4));
        const markerId = Number(observation.markerId ?? observation.id);
        const corners = Array.isArray(observation.corners)
            ? observation.corners.map((corner) => ({ x: Number(corner.x), y: Number(corner.y) }))
            : [];
        const markerWidth = Number(observation.width);
        const markerHeight = Number(observation.height);
        const item = {
            ...observation,
            id: Number.isFinite(markerId) ? markerId : observation.id,
            markerId: Number.isFinite(markerId) ? markerId : null,
            deviceId,
            centerX,
            centerY,
            x: centerX,
            y: centerY,
            relativeX: centerX,
            relativeY: centerY,
            center: { x: centerX, y: centerY },
            normalizedCenter: { x: centerX, y: centerY },
            corners,
            width: Number.isFinite(markerWidth) ? Math.min(1, Math.max(0, markerWidth)) : 0,
            height: Number.isFinite(markerHeight) ? Math.min(1, Math.max(0, markerHeight)) : 0,
            orientationAngle,
            rotation: orientationAngle,
            confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(4)),
            timestamp: updatedAt,
            lastDetectedAt: updatedAt,
            isVisible: true,
            visible: true,
            status: 'tracked',
            trackingState: 'tracked'
        };
        state.devices.set(deviceId, item);
        seen.add(deviceId);
    }

    for (const [deviceId, previous] of state.devices) {
        if (seen.has(deviceId)) {
            continue;
        }
        const age = updatedAt - previous.lastDetectedAt;
        if (age >= staleMs) {
            state.devices.delete(deviceId);
            continue;
        }
        const status = age >= timeoutMs ? 'lost' : 'occluded';
        state.devices.set(deviceId, {
            ...previous,
            isVisible: false,
            visible: false,
            status,
            trackingState: status
        });
    }
    return [...state.devices.values()];
}

export function resetVisionTrackerDevice(state, deviceId) {
    if (state?.devices instanceof Map && deviceId) {
        state.devices.delete(deviceId);
    }
}
