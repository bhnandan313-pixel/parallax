export const LAYOUT_RESET_CONFIRMATION =
    'Reset the display layout to its default configuration? Your custom layout will be replaced.';

export function confirmLayoutReset(confirm, reset) {
    if (typeof confirm !== 'function' || typeof reset !== 'function') {
        throw new TypeError('Layout reset requires confirmation and reset handlers');
    }
    if (!confirm(LAYOUT_RESET_CONFIRMATION)) {
        return false;
    }
    reset();
    return true;
}
