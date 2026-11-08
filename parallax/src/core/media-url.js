const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isPrivateIPv4(hostname) {
    return /^10\./.test(hostname)
        || /^192\.168\./.test(hostname)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

export function resolveParallaxMediaUrl(mediaUrl, baseUrl = globalThis.location?.href) {
    if (typeof mediaUrl !== 'string' || typeof baseUrl !== 'string') {
        return mediaUrl;
    }

    const url = new URL(mediaUrl, baseUrl);
    const isLocalBackend = url.port === '3001'
        && (LOCAL_HOSTNAMES.has(url.hostname) || isPrivateIPv4(url.hostname));
    if (!isLocalBackend || !url.pathname.startsWith('/uploads/')) {
        return mediaUrl;
    }

    return `${url.pathname}${url.search}${url.hash}`;
}
