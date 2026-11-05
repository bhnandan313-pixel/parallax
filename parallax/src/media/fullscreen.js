function getFullscreenMethod(element) {
    return element?.requestFullscreen ?? element?.webkitRequestFullscreen ?? null;
}

function getExitMethod(documentObject) {
    return documentObject?.exitFullscreen ?? documentObject?.webkitExitFullscreen ?? null;
}

export function isFullscreenSupported(element, documentObject = globalThis.document) {
    return Boolean(getFullscreenMethod(element) && getExitMethod(documentObject));
}

export function isFullscreen(element, documentObject = globalThis.document) {
    return documentObject?.fullscreenElement === element
        || documentObject?.webkitFullscreenElement === element;
}

export async function toggleFullscreen(element, documentObject = globalThis.document) {
    if (!isFullscreenSupported(element, documentObject)) {
        return false;
    }
    if (isFullscreen(element, documentObject)) {
        await getExitMethod(documentObject).call(documentObject);
    } else {
        await getFullscreenMethod(element).call(element);
    }
    return true;
}
