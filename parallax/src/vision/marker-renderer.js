import { createArucoMarkerPattern } from './marker-detection.js';

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