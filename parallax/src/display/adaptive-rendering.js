import { FIT_MODES } from './geometry.js';

const DEFAULT_MESH_SEGMENTS = 8;

function normalizeAngle(angle) {
    const fullRotation = Math.PI * 2;
    return ((angle + Math.PI) % fullRotation + fullRotation) % fullRotation - Math.PI;
}

function isValidViewport(viewport) {
    const matrix = viewport?.localToSharedFrame?.matrix3x3;
    if (typeof viewport?.deviceId !== 'string'
        || !Array.isArray(matrix) || matrix.length !== 9
        || !matrix.every(Number.isFinite)) {
        return false;
    }
    const determinant = matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
        - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
        + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) {
        return false;
    }
    const denominators = [
        matrix[8],
        matrix[6] + matrix[8],
        matrix[6] + matrix[7] + matrix[8],
        matrix[7] + matrix[8]
    ];
    return denominators.every(Number.isFinite)
        && denominators.every((value) => Math.abs(value) > 1e-8)
        && denominators.every((value) => Math.sign(value) === Math.sign(denominators[0]));
}

export function createAdaptiveRenderingConfiguration({
    viewports,
    devices,
    enabled = false,
    screenFillEnabled = true,
    fitMode = 'cover',
    layout = null,
    version = 1
} = {}) {
    const connectedDevices = Array.isArray(devices) ? devices : [];
    const validViewportSet = viewports?.valid === true
        && Array.isArray(viewports.viewports)
        && viewports.viewports.length === 2
        && viewports.viewports.every(isValidViewport);
    const devicesByScreen = new Map(connectedDevices.map((device) => [device.screen, device]));
    const hasBothDevices = [1, 2].every((screen) => {
        const device = devicesByScreen.get(screen);
        return device?.connected === true
            && typeof device.deviceId === 'string'
            && device.deviceId.length > 0;
    }) && new Set([devicesByScreen.get(1)?.deviceId, devicesByScreen.get(2)?.deviceId]).size === 2;
    const viewportsMatchDevices = validViewportSet && hasBothDevices
        && [1, 2].every((screen) => viewports.viewports.some((viewport) =>
            viewport.deviceId === devicesByScreen.get(screen).deviceId));

    let reason = null;
    if (enabled !== true) {
        reason = 'disabled-by-controller';
    } else if (!hasBothDevices) {
        reason = 'both-display-devices-must-be-connected';
    } else if (!viewportsMatchDevices) {
        reason = viewports?.reason || 'missing-or-invalid-screen-calibration';
    } else if (!FIT_MODES.includes(fitMode)) {
        reason = 'invalid-fit-mode';
    } else if (!screenFillEnabled || fitMode === 'manual') {
        reason = 'manual-mode-preserves-per-device-adjustments';
    } else if ([1, 2].some((screen) =>
        layout?.screens?.[screen]?.rotation !== undefined
        && layout.screens[screen].rotation !== 0)) {
        reason = 'manual-screen-rotation-uses-existing-renderer';
    }

    const active = reason === null;
    const relativeRotation = validViewportSet
        ? normalizeAngle(viewports.viewports[1].rotation - viewports.viewports[0].rotation)
        : null;
    return {
        active,
        enabled: enabled === true,
        reason,
        version: Number.isInteger(version) && version > 0 ? version : 1,
        arrangement: validViewportSet ? viewports.arrangement : 'UNKNOWN',
        orientation: relativeRotation === null
            ? 'UNKNOWN'
            : Math.abs(relativeRotation) >= 0.35 ? 'ANGLED' : 'PARALLEL',
        relativeRotation,
        reversedFromDeviceIdOrder: validViewportSet
            ? viewports.reversedFromDeviceIdOrder
            : false,
        confidence: validViewportSet ? viewports.confidence : 0,
        coordinateSpace: validViewportSet
            ? viewports.coordinateSpace
            : 'unavailable',
        physicalGeometryCalibrated: false,
        fitMode: FIT_MODES.includes(fitMode) ? fitMode : 'cover',
        screenFillEnabled: screenFillEnabled === true,
        sharedFrame: validViewportSet ? {
            ...viewports.sharedFrame,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            aspectRatio: viewports.sharedFrame.width / viewports.sharedFrame.height,
            units: 'shared-video-frame-normalized'
        } : null,
        devices: validViewportSet
            ? viewports.viewports.map((viewport) => ({
                ...viewport,
                screen: connectedDevices.find((device) =>
                    device.deviceId === viewport.deviceId)?.screen ?? null
            }))
            : []
    };
}

function projectToSharedFrame(matrix, u, v) {
    const denominator = matrix[6] * u + matrix[7] * v + matrix[8];
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) {
        return null;
    }
    const x = (matrix[0] * u + matrix[1] * v + matrix[2]) / denominator;
    const y = (matrix[3] * u + matrix[4] * v + matrix[5]) / denominator;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function mapSharedPointToSource(point, imageWidth, imageHeight, fitMode, sharedAspect) {
    const imageAspect = imageWidth / imageHeight;
    if (fitMode === 'stretch') {
        return { x: point.x, y: point.y };
    }
    if (fitMode === 'cover') {
        if (imageAspect > sharedAspect) {
            const visibleWidth = sharedAspect / imageAspect;
            return {
                x: (1 - visibleWidth) / 2 + point.x * visibleWidth,
                y: point.y
            };
        }
        const visibleHeight = imageAspect / sharedAspect;
        return {
            x: point.x,
            y: (1 - visibleHeight) / 2 + point.y * visibleHeight
        };
    }
    if (imageAspect > sharedAspect) {
        const contentHeight = sharedAspect / imageAspect;
        return {
            x: point.x,
            y: (point.y - (1 - contentHeight) / 2) / contentHeight
        };
    }
    const contentWidth = imageAspect / sharedAspect;
    return {
        x: (point.x - (1 - contentWidth) / 2) / contentWidth,
        y: point.y
    };
}

export function createAdaptiveRenderTriangles({
    viewport,
    canvasWidth,
    canvasHeight,
    imageWidth,
    imageHeight,
    sharedFrame,
    fitMode = 'cover',
    sharedOrientation = null,
    segments = DEFAULT_MESH_SEGMENTS
} = {}) {
    if (!isValidViewport(viewport)
        || ![canvasWidth, canvasHeight, imageWidth, imageHeight].every((value) =>
            Number.isFinite(value) && value > 0)
        || !Number.isFinite(sharedFrame?.width) || sharedFrame.width <= 0
        || !Number.isFinite(sharedFrame?.height) || sharedFrame.height <= 0
        || !['cover', 'contain', 'stretch'].includes(fitMode)
        || (sharedOrientation !== null
            && !['landscape', 'portrait'].includes(sharedOrientation))
        || !Number.isInteger(segments) || segments < 1 || segments > 32) {
        return null;
    }

    const matrix = viewport.localToSharedFrame.matrix3x3;
    let sharedAspect = sharedFrame.aspectRatio ?? sharedFrame.width / sharedFrame.height;
    if (!Number.isFinite(sharedAspect) || sharedAspect <= 0) {
        return null;
    }
    const shouldRotateSharedFrame = sharedOrientation === 'portrait'
        ? sharedAspect > 1
        : sharedOrientation === 'landscape' && sharedAspect < 1;
    if (shouldRotateSharedFrame) {
        sharedAspect = 1 / sharedAspect;
    }
    const vertices = Array.from({ length: segments + 1 }, (_, row) =>
        Array.from({ length: segments + 1 }, (_, column) => {
            const u = column / segments;
            const v = row / segments;
            const projectedPoint = projectToSharedFrame(matrix, u, v);
            if (!projectedPoint) {
                return null;
            }
            const sharedPoint = shouldRotateSharedFrame
                ? sharedOrientation === 'portrait'
                    ? { x: projectedPoint.y, y: 1 - projectedPoint.x }
                    : { x: 1 - projectedPoint.y, y: projectedPoint.x }
                : projectedPoint;
            const sourcePoint = mapSharedPointToSource(
                sharedPoint,
                imageWidth,
                imageHeight,
                fitMode,
                sharedAspect
            );
            if (!Number.isFinite(sourcePoint.x) || !Number.isFinite(sourcePoint.y)) {
                return null;
            }
            return {
                destination: { x: u * canvasWidth, y: v * canvasHeight },
                source: { x: sourcePoint.x * imageWidth, y: sourcePoint.y * imageHeight }
            };
        })
    );
    if (vertices.some((row) => row.some((vertex) => !vertex))) {
        return null;
    }

    const triangles = [];
    for (let row = 0; row < segments; row += 1) {
        for (let column = 0; column < segments; column += 1) {
            const topLeft = vertices[row][column];
            const topRight = vertices[row][column + 1];
            const bottomRight = vertices[row + 1][column + 1];
            const bottomLeft = vertices[row + 1][column];
            triangles.push(
                [topLeft, topRight, bottomRight],
                [topLeft, bottomRight, bottomLeft]
            );
        }
    }
    return triangles;
}
