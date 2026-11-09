export const SCREEN_SURFACE_CALIBRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MIN_SCREEN_SURFACE_CONFIDENCE = 0.5;

const CORNER_NAMES = Object.freeze(['topLeft', 'topRight', 'bottomRight', 'bottomLeft']);
const MIN_EDGE_LENGTH = 0.005;
const MIN_QUAD_AREA = 0.0001;

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
    timestamp = Date.now()
} = {}) {
    if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
        return null;
    }
    const geometry = validateCornerGeometry(corners);
    const certainty = Number(confidence);
    const calibratedAt = Number(timestamp);
    if (!geometry.valid || !Number.isFinite(certainty)
        || certainty < MIN_SCREEN_SURFACE_CONFIDENCE || certainty > 1
        || !Number.isFinite(calibratedAt) || calibratedAt <= 0) {
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
        || Number(calibration.timestamp) <= 0) {
        return false;
    }
    return validateCornerGeometry(corners).valid;
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

export function calculateScreenSurfaceViewports(calibrations, {
    timestamp = Date.now(),
    maxAgeMs = SCREEN_SURFACE_CALIBRATION_MAX_AGE_MS,
    minConfidence = MIN_SCREEN_SURFACE_CONFIDENCE
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
            timestamp: calibration?.timestamp
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
    const arrangement = classifyArrangement(ordered[0], ordered[1]);
    if (arrangement === 'UNKNOWN') {
        return invalidViewports('ambiguous-device-arrangement', now);
    }
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
    const viewports = ordered.map((calibration) => {
        const normalizedCorners = calibration.corners.map(({ x, y }) => ({
            x: round((x - minX) / frameWidth),
            y: round((y - minY) / frameHeight)
        }));
        const homography = solveUnitSquareHomography(normalizedCorners);
        if (!homography) {
            return null;
        }
        return {
            deviceId: calibration.deviceId,
            corners: normalizedCorners,
            center: {
                x: round((calibration.center.x - minX) / frameWidth),
                y: round((calibration.center.y - minY) / frameHeight)
            },
            width: round(calibration.width / frameWidth),
            height: round(calibration.height / frameHeight),
            rotation: calibration.rotation,
            aspectRatio: round(calibration.width / calibration.height),
            confidence: calibration.confidence,
            timestamp: calibration.timestamp,
            localToSharedFrame: {
                matrix3x3: homography,
                convention: '[u\',v\',w\'] = matrix * [u,v,1]; shared=(u\'/w\',v\'/w\')'
            }
        };
    });
    if (viewports.some((viewport) => !viewport)) {
        return invalidViewports('degenerate-viewport-transform', now);
    }
    return {
        valid: true,
        reason: null,
        timestamp: now,
        confidence: round(Math.min(...ordered.map(({ confidence }) => confidence))),
        arrangement,
        reversedFromDeviceIdOrder: ordered[1].center.x < ordered[0].center.x,
        coordinateSpace: 'normalized-camera-image-reference',
        physicalGeometryCalibrated: false,
        sharedFrame: {
            x: round(minX),
            y: round(minY),
            width: round(frameWidth),
            height: round(frameHeight),
            units: 'normalized-camera-image'
        },
        viewports
    };
}
