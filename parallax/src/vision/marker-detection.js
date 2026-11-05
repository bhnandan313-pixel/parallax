import jsAruco from 'js-aruco';

const { AR } = jsAruco;
const detector = AR?.Detector ? new AR.Detector() : null;

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
    } catch {
        return [];
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
