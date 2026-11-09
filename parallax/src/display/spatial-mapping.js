const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_MAX_AGE_MS = 2000;
const MIN_CENTER_SEPARATION = 0.02;
const MIN_DIMENSION = 0.0001;

function normalizeAngle(angle) {
    const fullRotation = Math.PI * 2;
    return ((angle + Math.PI) % fullRotation + fullRotation) % fullRotation - Math.PI;
}

function invalidMapping(reason, timestamp) {
    return {
        valid: false,
        reason,
        confidence: 0,
        timestamp,
        coordinateFrames: {
            cameraImage: 'normalized-camera-image',
            estimatedDisplaySurface: 'unavailable-without-screen-calibration',
            sharedWall: 'unavailable',
            deviceLocalViewport: 'unit-square'
        },
        devices: []
    };
}

function getPoseCenter(pose) {
    return {
        x: Number(pose.centerX ?? pose.normalizedCenter?.x ?? pose.x),
        y: Number(pose.centerY ?? pose.normalizedCenter?.y ?? pose.y)
    };
}

function getProxyDimensions(pose) {
    let markerWidth = Number(pose.width);
    let markerHeight = Number(pose.height);
    if (Array.isArray(pose.corners) && pose.corners.length === 4
        && pose.corners.every((corner) => Number.isFinite(Number(corner?.x))
            && Number.isFinite(Number(corner?.y)))) {
        const points = pose.corners.map(({ x, y }) => ({ x: Number(x), y: Number(y) }));
        const edgeLength = (first, second) =>
            Math.hypot(second.x - first.x, second.y - first.y);
        markerWidth = (edgeLength(points[0], points[1]) + edgeLength(points[2], points[3])) / 2;
        markerHeight = (edgeLength(points[1], points[2]) + edgeLength(points[3], points[0])) / 2;
    }
    if (!Number.isFinite(markerWidth) || !Number.isFinite(markerHeight)
        || markerWidth <= 0 || markerHeight <= 0) {
        return null;
    }

    const hasAspectRatio = pose.displayAspectRatio !== undefined && pose.displayAspectRatio !== null;
    const aspectRatio = Number(pose.displayAspectRatio);
    if (hasAspectRatio && (!Number.isFinite(aspectRatio) || aspectRatio <= 0)) {
        return null;
    }
    if (hasAspectRatio) {
        const proxyScale = Math.sqrt(markerWidth * markerHeight);
        return {
            width: proxyScale * Math.sqrt(aspectRatio),
            height: proxyScale / Math.sqrt(aspectRatio),
            source: 'marker-scale-with-explicit-display-aspect-ratio'
        };
    }
    return {
        width: markerWidth,
        height: markerHeight,
        source: 'observed-marker-bounds-proxy'
    };
}

function getOrientedCorners(center, width, height, rotation) {
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    return [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5]
    ].map(([localX, localY]) => ({
        x: center.x + localX * width * cosine - localY * height * sine,
        y: center.y + localX * width * sine + localY * height * cosine
    }));
}

function round(value) {
    return Number(value.toFixed(6));
}

export function createSpatialCoordinateMapping(poses, {
    timestamp = Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    minCenterSeparation = MIN_CENTER_SEPARATION,
    relationship = null
} = {}) {
    const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
    const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0
        ? Number(maxAgeMs) : DEFAULT_MAX_AGE_MS;
    const confidenceLimit = Number.isFinite(Number(minConfidence))
        ? Math.min(1, Math.max(0, Number(minConfidence)))
        : DEFAULT_MIN_CONFIDENCE;
    const centerSeparationLimit = Number.isFinite(Number(minCenterSeparation))
        && Number(minCenterSeparation) >= 0
        ? Number(minCenterSeparation) : MIN_CENTER_SEPARATION;
    if (relationship !== null && relationship?.isReliable !== true) {
        return invalidMapping('spatial-relationship-not-reliable', now);
    }
    if (!Array.isArray(poses) || poses.length !== 2) {
        return invalidMapping('exactly-two-device-poses-required', now);
    }

    const byId = new Map();
    for (const pose of poses) {
        if (typeof pose?.deviceId !== 'string' || !pose.deviceId.trim()
            || byId.has(pose.deviceId)) {
            return invalidMapping('missing-or-duplicate-device-id', now);
        }
        byId.set(pose.deviceId, pose);
    }
    const orderedPoses = [...byId.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, pose]) => pose);

    const devices = orderedPoses.map((pose) => {
        const center = getPoseCenter(pose);
        const rotation = Number(pose.orientationAngle ?? pose.rotation);
        const confidence = Number(pose.confidence);
        const observedAt = Number(pose.lastDetectedAt ?? pose.timestamp);
        const dimensions = getProxyDimensions(pose);
        if (pose.isVisible === false || pose.visible === false
            || pose.trackingState === 'lost' || pose.status === 'lost') {
            return { invalid: 'device-not-visible' };
        }
        if (!Number.isFinite(center.x) || center.x < 0 || center.x > 1
            || !Number.isFinite(center.y) || center.y < 0 || center.y > 1) {
            return { invalid: 'invalid-camera-image-position' };
        }
        if (!Number.isFinite(rotation) || !Number.isFinite(confidence)
            || confidence < confidenceLimit || confidence > 1) {
            return { invalid: 'low-confidence-or-invalid-orientation' };
        }
        if (!Number.isFinite(observedAt) || now - observedAt < 0 || now - observedAt > ageLimit) {
            return { invalid: 'missing-or-stale-observation' };
        }
        if (pose.corners !== undefined
            && (!Array.isArray(pose.corners)
                || (pose.corners.length !== 0 && pose.corners.length !== 4)
                || pose.corners.some((corner) =>
                    !Number.isFinite(Number(corner?.x)) || Number(corner.x) < 0 || Number(corner.x) > 1
                    || !Number.isFinite(Number(corner?.y)) || Number(corner.y) < 0 || Number(corner.y) > 1))) {
            return { invalid: 'invalid-marker-corners' };
        }
        if (!dimensions || dimensions.width < MIN_DIMENSION || dimensions.height < MIN_DIMENSION) {
            return { invalid: 'degenerate-marker-proxy-dimensions' };
        }
        const corners = getOrientedCorners(center, dimensions.width, dimensions.height, rotation);
        return {
            deviceId: pose.deviceId,
            markerId: Number.isInteger(Number(pose.markerId ?? pose.id))
                ? Number(pose.markerId ?? pose.id)
                : null,
            trackingState: pose.trackingState || pose.status || 'tracked',
            cameraImagePose: {
                markerId: Number.isInteger(Number(pose.markerId ?? pose.id))
                    ? Number(pose.markerId ?? pose.id)
                    : null,
                x: round(center.x),
                y: round(center.y),
                width: round(Number.isFinite(Number(pose.width)) ? Number(pose.width) : dimensions.width),
                height: round(Number.isFinite(Number(pose.height)) ? Number(pose.height) : dimensions.height),
                rotation: round(normalizeAngle(rotation)),
                confidence: round(confidence),
                visible: true,
                timestamp: observedAt,
                corners: Array.isArray(pose.corners) ? pose.corners.map((corner) => ({
                    x: round(Number(corner.x)),
                    y: round(Number(corner.y))
                })) : []
            },
            estimatedDisplaySurface: {
                x: round(center.x),
                y: round(center.y),
                width: round(dimensions.width),
                height: round(dimensions.height),
                scale: round(Math.sqrt(dimensions.width * dimensions.height)),
                rotation: round(normalizeAngle(rotation)),
                geometrySource: dimensions.source,
                calibrated: false
            },
            _corners: corners
        };
    });

    const invalidDevice = devices.find((device) => device.invalid);
    if (invalidDevice) {
        return invalidMapping(invalidDevice.invalid, now);
    }

    const [first, second] = devices;
    const centerDistance = Math.hypot(
        second.cameraImagePose.x - first.cameraImagePose.x,
        second.cameraImagePose.y - first.cameraImagePose.y
    );
    if (!Number.isFinite(centerDistance) || centerDistance < centerSeparationLimit) {
        return invalidMapping('overlapping-or-ambiguous-device-centers', now);
    }

    const allCorners = devices.flatMap((device) => device._corners);
    const minX = Math.min(...allCorners.map(({ x }) => x));
    const maxX = Math.max(...allCorners.map(({ x }) => x));
    const minY = Math.min(...allCorners.map(({ y }) => y));
    const maxY = Math.max(...allCorners.map(({ y }) => y));
    const wallWidth = maxX - minX;
    const wallHeight = maxY - minY;
    if (wallWidth < MIN_DIMENSION || wallHeight < MIN_DIMENSION) {
        return invalidMapping('degenerate-shared-frame', now);
    }

    const horizontal = Math.abs(second.cameraImagePose.x - first.cameraImagePose.x);
    const vertical = Math.abs(second.cameraImagePose.y - first.cameraImagePose.y);
    const derivedArrangement = centerDistance >= 0.65
        ? 'SEPARATED'
        : horizontal >= Math.max(0.06, vertical * 1.4)
            ? 'SIDE_BY_SIDE'
            : vertical >= Math.max(0.06, horizontal * 1.4)
                ? 'STACKED'
                : 'UNKNOWN';
    const arrangement = relationship?.arrangement ?? derivedArrangement;
    const relativeRotation = normalizeAngle(
        devices[1].estimatedDisplaySurface.rotation
            - devices[0].estimatedDisplaySurface.rotation
    );
    const orientation = relationship?.orientation
        ?? (Math.abs(relativeRotation) >= 0.35 ? 'ANGLED' : 'PARALLEL');

    const mappedDevices = devices.map((device) => {
        const pose = device.estimatedDisplaySurface;
        const sharedWidth = pose.width / wallWidth;
        const sharedHeight = pose.height / wallHeight;
        const sharedCenterX = (pose.x - minX) / wallWidth;
        const sharedCenterY = (pose.y - minY) / wallHeight;
        const cosine = Math.cos(pose.rotation);
        const sine = Math.sin(pose.rotation);
        const a = cosine * sharedWidth;
        const b = -sine * pose.height / wallWidth;
        const c = sine * pose.width / wallHeight;
        const d = cosine * sharedHeight;
        return {
            deviceId: device.deviceId,
            markerId: device.markerId,
            trackingState: device.trackingState,
            cameraImagePose: device.cameraImagePose,
            estimatedDisplaySurface: device.estimatedDisplaySurface,
            sharedWallPose: {
                x: round((pose.x - minX) / wallWidth),
                y: round((pose.y - minY) / wallHeight),
                width: round(sharedWidth),
                height: round(sharedHeight),
                rotation: pose.rotation
            },
            deviceLocalViewport: { x: 0, y: 0, width: 1, height: 1 },
            localToSharedWall: {
                a: round(a),
                b: round(b),
                c: round(c),
                d: round(d),
                e: round(sharedCenterX - (a + b) / 2),
                f: round(sharedCenterY - (c + d) / 2),
                convention: 'x=a*u+b*v+e; y=c*u+d*v+f'
            }
        };
    });

    return {
        valid: true,
        reason: null,
        confidence: round(Math.min(...mappedDevices.map((device) =>
            device.cameraImagePose.confidence))),
        timestamp: now,
        arrangement,
        orientation,
        relativeRotation: round(relativeRotation),
        reversedFromDeviceIdOrder: mappedDevices[1].cameraImagePose.x
            < mappedDevices[0].cameraImagePose.x,
        coordinateFrames: {
            cameraImage: 'normalized-camera-image',
            estimatedDisplaySurface: 'marker-footprint-proxy-not-physical-screen',
            sharedWall: 'normalized-marker-proxy-union',
            deviceLocalViewport: 'unit-square'
        },
        calibration: {
            status: 'uncalibrated',
            physicalScreenGeometryAvailable: false,
            assumptions: [
                'Detected marker bounds proxy display dimensions unless an explicit display aspect ratio is provided.',
                'Marker orientation proxies device orientation; no physical screen pose is inferred.',
                'Shared coordinates are normalized camera-image proxy coordinates, not physical distances.'
            ]
        },
        sharedWall: {
            x: round(minX),
            y: round(minY),
            width: round(wallWidth),
            height: round(wallHeight),
            coordinateSpace: 'normalized-camera-image-marker-proxy'
        },
        devices: mappedDevices
    };
}

export function hasMeaningfulSpatialMappingChange(previous, next, {
    positionTolerance = 0.01,
    dimensionTolerance = 0.015,
    rotationTolerance = 0.03,
    confidenceTolerance = 0.05
} = {}) {
    if (!previous?.valid || !next?.valid
        || previous.devices?.length !== 2 || next.devices?.length !== 2) {
        return Boolean(next?.valid);
    }
    if (previous.arrangement !== next.arrangement
        || previous.orientation !== next.orientation
        || previous.reversedFromDeviceIdOrder !== next.reversedFromDeviceIdOrder
        || previous.devices.some((device, index) =>
            device.deviceId !== next.devices[index].deviceId)) {
        return true;
    }
    if (Math.abs(previous.confidence - next.confidence) >= confidenceTolerance
        || Math.abs(normalizeAngle(previous.relativeRotation - next.relativeRotation))
            >= rotationTolerance) {
        return true;
    }
    return previous.devices.some((device, index) => {
        const nextDevice = next.devices[index];
        const oldPose = device.sharedWallPose;
        const newPose = nextDevice.sharedWallPose;
        return Math.abs(oldPose.x - newPose.x) >= positionTolerance
            || Math.abs(oldPose.y - newPose.y) >= positionTolerance
            || Math.abs(oldPose.width - newPose.width) >= dimensionTolerance
            || Math.abs(oldPose.height - newPose.height) >= dimensionTolerance
            || Math.abs(normalizeAngle(oldPose.rotation - newPose.rotation)) >= rotationTolerance;
    });
}
