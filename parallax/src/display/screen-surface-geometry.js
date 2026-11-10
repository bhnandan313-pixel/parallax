export const SCREEN_SURFACE_CALIBRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MIN_SCREEN_SURFACE_CONFIDENCE = 0.5;
export const SCREEN_SURFACE_OBSERVATION_MAX_AGE_MS = 2000;

const CORNER_NAMES = Object.freeze(['topLeft', 'topRight', 'bottomRight', 'bottomLeft']);
const MIN_EDGE_LENGTH = 0.005;
const MIN_QUAD_AREA = 0.0001;
const MAX_CENTER_OFFSET_MARKER_WIDTHS = 0.75;

function normalizeAngle(angle) {
    const fullRotation = Math.PI * 2;
    return ((angle + Math.PI) % fullRotation + fullRotation) % fullRotation - Math.PI;
}

function round(value) {
    return Number(value.toFixed(6));
}

function pointDistance(first, second) {
    return Math.hypot(second.x - first.x, second.y - first.y);
}

function cross(first, second, third) {
    return (second.x - first.x) * (third.y - second.y)
        - (second.y - first.y) * (third.x - second.x);
}

function signedArea(corners) {
    return corners.reduce((sum, point, index) => {
        const next = corners[(index + 1) % corners.length];
        return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2;
}

function readCorners(corners) {
    if (!Array.isArray(corners) || corners.length !== 4) {
        return null;
    }
    const points = corners.map((corner) => ({
        x: Number(corner?.x),
        y: Number(corner?.y)
    }));
    return points.every(({ x, y }) =>
        Number.isFinite(x) && x >= 0 && x <= 1
        && Number.isFinite(y) && y >= 0 && y <= 1)
        ? points : null;
}

function validateCornerGeometry(corners) {
    const points = readCorners(corners);
    if (!points) {
        return { valid: false, reason: 'four-normalized-corners-required' };
    }
    const edges = points.map((point, index) => pointDistance(
        point,
        points[(index + 1) % points.length]
    ));
    if (edges.some((length) => !Number.isFinite(length) || length < MIN_EDGE_LENGTH)) {
        return { valid: false, reason: 'screen-corner-edge-too-small' };
    }
    const turns = points.map((point, index) => cross(
        point,
        points[(index + 1) % points.length],
        points[(index + 2) % points.length]
    ));
    if (turns.some((turn) => Math.abs(turn) < MIN_QUAD_AREA)
        || !(turns.every((turn) => turn > 0) || turns.every((turn) => turn < 0))) {
        return { valid: false, reason: 'corners-must-form-a-convex-ordered-quad' };
    }
    const area = Math.abs(signedArea(points));
    if (area < MIN_QUAD_AREA) {
        return { valid: false, reason: 'screen-corner-area-too-small' };
    }
    return { valid: true, corners: points, edges, area };
}

function deriveSurface(corners) {
    const [topLeft, topRight, bottomRight, bottomLeft] = corners;
    const width = (pointDistance(topLeft, topRight) + pointDistance(bottomLeft, bottomRight)) / 2;
    const height = (pointDistance(topLeft, bottomLeft) + pointDistance(topRight, bottomRight)) / 2;
    const center = corners.reduce((result, point) => ({
        x: result.x + point.x / 4,
        y: result.y + point.y / 4
    }), { x: 0, y: 0 });
    const topAngle = Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x);
    const bottomAngle = Math.atan2(bottomRight.y - bottomLeft.y, bottomRight.x - bottomLeft.x);
    const rotation = normalizeAngle(topAngle + normalizeAngle(bottomAngle - topAngle) / 2);
    return {
        width: round(width),
        height: round(height),
        center: { x: round(center.x), y: round(center.y) },
        position: { x: round(center.x), y: round(center.y) },
        rotation: round(rotation)
    };
}

export function createScreenSurfaceCalibration({
    deviceId,
    corners,
    confidence = 0.75,
    timestamp = Date.now(),
    orientationAngle = null
} = {}) {
    if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
        return null;
    }
    const geometry = validateCornerGeometry(corners);
    const certainty = Number(confidence);
    const calibratedAt = Number(timestamp);
    if (!geometry.valid || !Number.isFinite(certainty)
        || certainty < MIN_SCREEN_SURFACE_CONFIDENCE || certainty > 1
        || !Number.isFinite(calibratedAt) || calibratedAt <= 0
        || (orientationAngle !== null && ![0, 90, 180, 270].includes(orientationAngle))) {
        return null;
    }
    const surface = deriveSurface(geometry.corners);
    return {
        deviceId,
        coordinateSpace: 'normalized-camera-image-manually-confirmed',
        corners: geometry.corners.map((point, index) => ({
            name: CORNER_NAMES[index],
            x: round(point.x),
            y: round(point.y)
        })),
        ...surface,
        confidence: round(certainty),
        timestamp: calibratedAt,
        orientationAngle,
        method: 'manual-four-corner-confirmation',
        physicalGeometryCalibrated: false
    };
}

export function validateScreenSurfaceCalibration(calibration) {
    if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) {
        return false;
    }
    const corners = readCorners(calibration.corners);
    if (!corners || typeof calibration.deviceId !== 'string'
        || !calibration.deviceId.trim() || calibration.deviceId.length > 128
        || !Number.isFinite(Number(calibration.confidence))
        || Number(calibration.confidence) < MIN_SCREEN_SURFACE_CONFIDENCE
        || Number(calibration.confidence) > 1
        || !Number.isFinite(Number(calibration.timestamp))
        || Number(calibration.timestamp) <= 0
        || (calibration.orientationAngle !== undefined
            && calibration.orientationAngle !== null
            && ![0, 90, 180, 270].includes(calibration.orientationAngle))) {
        return false;
    }
    return validateCornerGeometry(corners).valid;
}

export function validateScreenSurfaceObservations(calibrations, observations, {
    timestamp = Date.now(),
    maxAgeMs = SCREEN_SURFACE_OBSERVATION_MAX_AGE_MS,
    maxCenterOffsetMarkerWidths = MAX_CENTER_OFFSET_MARKER_WIDTHS
} = {}) {
    const now = Number(timestamp);
    if (!Number.isFinite(now) || !Array.isArray(calibrations) || calibrations.length !== 2) {
        return { valid: false, reason: 'exactly-two-screen-calibrations-required' };
    }
    if (!Array.isArray(observations)
        || !Number.isFinite(Number(maxAgeMs)) || Number(maxAgeMs) < 0
        || !Number.isFinite(Number(maxCenterOffsetMarkerWidths))
        || Number(maxCenterOffsetMarkerWidths) <= 0) {
        return { valid: false, reason: 'invalid-screen-observation-validation-options' };
    }
    const observationsByDevice = new Map(observations
        .filter((observation) => typeof observation?.deviceId === 'string')
        .map((observation) => [observation.deviceId, observation]));
    for (const calibration of calibrations) {
        const observed = observationsByDevice.get(calibration?.deviceId);
        const receivedAt = Number(observed?.receivedAt);
        if (!observed || observed.isVisible === false
            || !Number.isFinite(receivedAt) || now - receivedAt < 0
            || now - receivedAt > Number(maxAgeMs)) {
            return { valid: false, reason: 'missing-or-stale-live-marker-observation' };
        }
        const centerX = Number(observed.centerX ?? observed.normalizedCenter?.x);
        const centerY = Number(observed.centerY ?? observed.normalizedCenter?.y);
        const markerWidth = Number(observed.width);
        const markerHeight = Number(observed.height);
        if (![centerX, centerY, markerWidth, markerHeight, Number(observed.confidence)]
            .every(Number.isFinite)
            || markerWidth <= 0 || markerHeight <= 0 || Number(observed.confidence) <= 0) {
            return { valid: false, reason: 'invalid-live-marker-observation' };
        }
        const offsetInMarkerWidths = Math.hypot(
            (centerX - calibration.center.x) / markerWidth,
            (centerY - calibration.center.y) / markerHeight
        );
        if (offsetInMarkerWidths > Number(maxCenterOffsetMarkerWidths)) {
            return { valid: false, reason: 'screen-position-changed-recalibrate' };
        }
    }
    return { valid: true, reason: null };
}

function invalidViewports(reason, timestamp) {
    return {
        valid: false,
        reason,
        timestamp,
        confidence: 0,
        coordinateSpace: 'normalized-camera-image-reference',
        physicalGeometryCalibrated: false,
        viewports: []
    };
}

function solveUnitSquareHomography(corners) {
    const [p0, p1, p2, p3] = corners;
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const dy3 = p0.y - p1.y + p2.y - p3.y;
    let g = 0;
    let h = 0;
    if (Math.abs(dx3) + Math.abs(dy3) > 1e-10) {
        const denominator = dx1 * dy2 - dx2 * dy1;
        if (Math.abs(denominator) < 1e-10) {
            return null;
        }
        g = (dx3 * dy2 - dx2 * dy3) / denominator;
        h = (dx1 * dy3 - dx3 * dy1) / denominator;
    }
    const matrix = [
        p1.x - p0.x + g * p1.x,
        p3.x - p0.x + h * p3.x,
        p0.x,
        p1.y - p0.y + g * p1.y,
        p3.y - p0.y + h * p3.y,
        p0.y,
        g,
        h,
        1
    ];
    return matrix.every(Number.isFinite) ? matrix.map(round) : null;
}

function classifyArrangement(first, second) {
    const deltaX = Math.abs(second.center.x - first.center.x);
    const deltaY = Math.abs(second.center.y - first.center.y);
    if (deltaX < 0.01 && deltaY < 0.01) {
        return 'UNKNOWN';
    }
    if (deltaX >= Math.max(0.01, deltaY * 1.4)) {
        return 'SIDE_BY_SIDE';
    }
    if (deltaY >= Math.max(0.01, deltaX * 1.4)) {
        return 'STACKED';
    }
    return 'UNKNOWN';
}

function multiplyMatrices(left, right) {
    return Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 3 }, (_, column) =>
            left[row * 3] * right[column]
            + left[row * 3 + 1] * right[column + 3]
            + left[row * 3 + 2] * right[column + 6]
        ).map(round)
    ).flat();
}

function projectPoint(matrix, u, v) {
    const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) {
        return null;
    }
    return {
        x: round((matrix[0] * u + matrix[1] * v + matrix[2]) / denominator),
        y: round((matrix[3] * u + matrix[4] * v + matrix[5]) / denominator)
    };
}

function getLocalRotationMatrix(calibration, currentAngle) {
    if (![0, 90, 180, 270].includes(calibration.orientationAngle)
        || ![0, 90, 180, 270].includes(currentAngle)) {
        return null;
    }
    const turns = ((currentAngle - calibration.orientationAngle + 360) % 360) / 90;
    if (turns === 1) {
        return [0, 1, 0, -1, 0, 1, 0, 0, 1];
    }
    if (turns === 2) {
        return [-1, 0, 1, 0, -1, 1, 0, 0, 1];
    }
    if (turns === 3) {
        return [0, -1, 1, 1, 0, 0, 0, 0, 1];
    }
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function getSharedFrameRotation(sharedOrientation, aspectRatio) {
    if (sharedOrientation === null) {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    if (!['landscape', 'portrait'].includes(sharedOrientation)) {
        return null;
    }
    if (sharedOrientation === 'portrait' && aspectRatio > 1) {
        return [0, 1, 0, -1, 0, 1, 0, 0, 1];
    }
    if (sharedOrientation === 'landscape' && aspectRatio < 1) {
        return [0, -1, 1, 1, 0, 0, 0, 0, 1];
    }
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function calculateScreenSurfaceViewports(calibrations, {
    timestamp = Date.now(),
    maxAgeMs = SCREEN_SURFACE_CALIBRATION_MAX_AGE_MS,
    minConfidence = MIN_SCREEN_SURFACE_CONFIDENCE,
    orientationAngles = null,
    sharedOrientation = null
} = {}) {
    const now = Number(timestamp);
    if (!Number.isFinite(now) || !Array.isArray(calibrations) || calibrations.length !== 2) {
        return invalidViewports('exactly-two-screen-calibrations-required', Number.isFinite(now) ? now : Date.now());
    }
    const maxAge = Number(maxAgeMs);
    const confidenceThreshold = Number(minConfidence);
    if (!Number.isFinite(maxAge) || maxAge < 0
        || !Number.isFinite(confidenceThreshold)
        || confidenceThreshold < MIN_SCREEN_SURFACE_CONFIDENCE
        || confidenceThreshold > 1) {
        return invalidViewports('invalid-viewport-validation-options', now);
    }
    const byId = new Map();
    for (const calibration of calibrations) {
        const normalized = createScreenSurfaceCalibration({
            deviceId: calibration?.deviceId,
            corners: calibration?.corners,
            confidence: calibration?.confidence,
            timestamp: calibration?.timestamp,
            orientationAngle: calibration?.orientationAngle ?? null
        });
        if (!normalized || byId.has(normalized.deviceId)) {
            return invalidViewports('invalid-or-duplicate-calibration', now);
        }
        const age = now - normalized.timestamp;
        if (!Number.isFinite(age) || age < 0 || age > maxAge) {
            return invalidViewports('missing-or-stale-calibration', now);
        }
        if (normalized.confidence < confidenceThreshold) {
            return invalidViewports('low-calibration-confidence', now);
        }
        byId.set(normalized.deviceId, normalized);
    }
    const ordered = [...byId.values()].sort((left, right) =>
        left.deviceId.localeCompare(right.deviceId));
    const points = ordered.flatMap((calibration) => calibration.corners.map(({ x, y }) => ({ x, y })));
    const minX = Math.min(...points.map(({ x }) => x));
    const maxX = Math.max(...points.map(({ x }) => x));
    const minY = Math.min(...points.map(({ y }) => y));
    const maxY = Math.max(...points.map(({ y }) => y));
    const frameWidth = maxX - minX;
    const frameHeight = maxY - minY;
    if (frameWidth < MIN_EDGE_LENGTH || frameHeight < MIN_EDGE_LENGTH) {
        return invalidViewports('degenerate-shared-frame', now);
    }
    const baseAspectRatio = frameWidth / frameHeight;
    const sharedRotation = getSharedFrameRotation(sharedOrientation, baseAspectRatio);
    if (!sharedRotation) {
        return invalidViewports('invalid-shared-orientation', now);
    }
    const viewports = ordered.map((calibration) => {
        const normalizedCorners = calibration.corners.map(({ x, y }) => ({
            x: round((x - minX) / frameWidth),
            y: round((y - minY) / frameHeight)
        }));
        const baseHomography = solveUnitSquareHomography(normalizedCorners);
        const currentAngle = orientationAngles instanceof Map
            ? orientationAngles?.get(calibration.deviceId)
            : orientationAngles?.[calibration.deviceId];
        const localRotation = orientationAngles === null
            ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
            : getLocalRotationMatrix(calibration, currentAngle);
        if (!baseHomography || !localRotation) {
            return null;
        }
        const homography = multiplyMatrices(
            sharedRotation,
            multiplyMatrices(baseHomography, localRotation)
        );
        const transformedCorners = [[0, 0], [1, 0], [1, 1], [0, 1]]
            .map(([u, v]) => projectPoint(homography, u, v));
        const transformedCenter = projectPoint(homography, 0.5, 0.5);
        if (transformedCorners.some((point) => !point) || !transformedCenter) {
            return null;
        }
        const left = Math.min(...transformedCorners.map(({ x }) => x));
        const right = Math.max(...transformedCorners.map(({ x }) => x));
        const top = Math.min(...transformedCorners.map(({ y }) => y));
        const bottom = Math.max(...transformedCorners.map(({ y }) => y));
        const deltaAngle = orientationAngles === null
            ? 0
            : ((currentAngle - calibration.orientationAngle + 540) % 360) - 180;
        const quarterTurn = Math.abs(deltaAngle) === 90 || Math.abs(deltaAngle) === 270;
        return {
            deviceId: calibration.deviceId,
            corners: transformedCorners,
            center: transformedCenter,
            width: round(right - left),
            height: round(bottom - top),
            rotation: round(normalizeAngle(calibration.rotation + deltaAngle * Math.PI / 180)),
            aspectRatio: round(quarterTurn
                ? calibration.height / calibration.width
                : calibration.width / calibration.height),
            confidence: calibration.confidence,
            timestamp: calibration.timestamp,
            localToSharedFrame: {
                matrix3x3: homography,
                convention: '[u\',v\',w\'] = matrix * [u,v,1]; shared=(u\'/w\',v\'/w\')'
            }
        };
    });
    if (viewports.some((viewport) => !viewport)) {
        return invalidViewports(orientationAngles === null
            ? 'degenerate-viewport-transform'
            : 'orientation-recalibration-required', now);
    }
    const arrangement = classifyArrangement(viewports[0], viewports[1]);
    if (arrangement === 'UNKNOWN') {
        return invalidViewports('ambiguous-device-arrangement', now);
    }
    const swapFrameDimensions = sharedRotation[0] === 0;
    const sharedFrameWidth = swapFrameDimensions ? frameHeight : frameWidth;
    const sharedFrameHeight = swapFrameDimensions ? frameWidth : frameHeight;
    return {
        valid: true,
        reason: null,
        timestamp: now,
        confidence: round(Math.min(...ordered.map(({ confidence }) => confidence))),
        arrangement,
        reversedFromDeviceIdOrder: viewports[1].center.x < viewports[0].center.x,
        coordinateSpace: 'normalized-camera-image-reference',
        physicalGeometryCalibrated: false,
        sharedFrame: {
            x: round(minX),
            y: round(minY),
            width: round(sharedFrameWidth),
            height: round(sharedFrameHeight),
            units: 'normalized-camera-image'
        },
        viewports
    };
}
