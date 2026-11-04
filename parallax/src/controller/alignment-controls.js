const ALIGNMENT_AXES = new Set(['horizontal', 'vertical', 'scale']);

export function getAlignmentStep(axis, fineAdjustment) {
    if (!ALIGNMENT_AXES.has(axis)) {
        throw new RangeError(`Unsupported alignment axis: ${axis}`);
    }

    if (axis === 'scale') {
        return fineAdjustment ? '0.001' : '0.01';
    }
    return fineAdjustment ? '0.1' : '1';
}

export function formatAlignmentValue(axis, value, fineAdjustment) {
    if (!ALIGNMENT_AXES.has(axis) || !Number.isFinite(value)) {
        throw new TypeError('Alignment value must use a supported axis and finite number');
    }

    const digits = fineAdjustment ? (axis === 'scale' ? 3 : 1) : (axis === 'scale' ? 2 : 0);
    return axis === 'scale'
        ? `${value.toFixed(digits)}×`
        : `${value.toFixed(digits)} px`;
}
