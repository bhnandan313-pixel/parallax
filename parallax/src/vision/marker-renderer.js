import { createArucoMarkerPattern } from './marker-detection.js';

export const DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION = 0.2;
export const MIN_ARUCO_MARKER_MIN_SIZE_FRACTION = 0.18;
export const MAX_ARUCO_MARKER_MIN_SIZE_FRACTION = 0.22;

const PREVIOUS_MARKER_SIZE_FRACTION = 0.32;
const PREVIOUS_MARKER_MAX_SIZE = 224;
const MARKER_SIZE_INCREASE_FACTOR = 1.2;
const MAX_MARKER_SHORT_SIDE_FRACTION = 0.9;

export function getArucoMarkerDisplaySize(
    viewportWidth,
    viewportHeight,
    minimumSizeFraction = DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION
) {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0
        || !Number.isFinite(viewportHeight) || viewportHeight <= 0
        || !Number.isFinite(minimumSizeFraction)
        || minimumSizeFraction < MIN_ARUCO_MARKER_MIN_SIZE_FRACTION
        || minimumSizeFraction > MAX_ARUCO_MARKER_MIN_SIZE_FRACTION) {
        return null;
    }
    const shorterSide = Math.min(viewportWidth, viewportHeight);
    const previousMaximumSize = Math.min(
        Math.max(viewportWidth, viewportHeight) * PREVIOUS_MARKER_SIZE_FRACTION,
        PREVIOUS_MARKER_MAX_SIZE
    );
    const increasedSize = Math.max(
        shorterSide * minimumSizeFraction,
        previousMaximumSize * MARKER_SIZE_INCREASE_FACTOR
    );
    return Math.max(1, Math.round(Math.min(
        shorterSide * MAX_MARKER_SHORT_SIDE_FRACTION,
        increasedSize
    )));
}

export function renderArucoMarker(canvas, markerId, options = {}) {
    const pattern = createArucoMarkerPattern(markerId);
    const moduleSize = Number(options.moduleSize ?? 56);
    const quietZoneModules = Number(options.quietZoneModules ?? 1);
    if (!canvas || !pattern || !Number.isInteger(moduleSize) || moduleSize < 1
        || !Number.isInteger(quietZoneModules) || quietZoneModules < 1) {
        return false;
    }

    const size = (pattern.length + quietZoneModules * 2) * moduleSize;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
        return false;
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size, size);
    for (let row = 0; row < pattern.length; row += 1) {
        for (let column = 0; column < pattern[row].length; column += 1) {
            context.fillStyle = pattern[row][column] ? '#fff' : '#000';
            context.fillRect(
                (column + quietZoneModules) * moduleSize,
                (row + quietZoneModules) * moduleSize,
                moduleSize,
                moduleSize
            );
        }
    }
    return true;
}