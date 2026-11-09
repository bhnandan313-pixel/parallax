import { computeMarkerIdForDevice, isSupportedArucoMarkerId } from './marker-detection.js';
import {
    DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION,
    getArucoMarkerDisplaySize,
    renderArucoMarker
} from './marker-renderer.js';

const MARKER_MODULE_SIZE = 56;
const MARKER_QUIET_ZONE_MODULES = 1;

export function createDisplayMarkerOverlay({
    document = globalThis.document,
    deviceId,
    markerId = Number.NaN,
    minimumSizeFraction = DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION
} = {}) {
    if (!document || typeof deviceId !== 'string' || !deviceId.trim()
        || !Number.isFinite(minimumSizeFraction)
        || minimumSizeFraction < 0.18 || minimumSizeFraction > 0.22) {
        return null;
    }
    const assignedMarkerId = isSupportedArucoMarkerId(markerId)
        ? Number(markerId)
        : computeMarkerIdForDevice(deviceId);
    if (!isSupportedArucoMarkerId(assignedMarkerId)) {
        return null;
    }

    const overlay = document.createElement('div');
    overlay.className = 'parallax-vision-marker';
    overlay.dataset.markerId = String(assignedMarkerId);
    overlay.setAttribute('aria-label', `Device marker ${assignedMarkerId}`);
    Object.assign(overlay.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        zIndex: '25',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none'
    });

    const canvas = document.createElement('canvas');
    canvas.className = 'parallax-vision-marker-grid';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';
    if (!renderArucoMarker(canvas, assignedMarkerId, {
        moduleSize: MARKER_MODULE_SIZE,
        quietZoneModules: MARKER_QUIET_ZONE_MODULES
    })) {
        return null;
    }
    overlay.append(canvas);

    const label = document.createElement('span');
    label.className = 'parallax-vision-marker-label';
    label.textContent = `ID ${assignedMarkerId}`;
    overlay.append(label);
    overlay.dataset.minimumSizeFraction = String(minimumSizeFraction);
    return overlay;
}

export function resizeDisplayMarkerOverlay(
    overlay,
    viewportWidth,
    viewportHeight,
    minimumSizeFraction = DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION
) {
    const size = getArucoMarkerDisplaySize(viewportWidth, viewportHeight, minimumSizeFraction);
    if (!overlay || size === null) {
        return false;
    }
    overlay.style.width = `${size}px`;
    overlay.style.height = `${size}px`;
    overlay.dataset.minimumSizeFraction = String(minimumSizeFraction);
    return true;
}
