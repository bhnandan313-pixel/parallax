import { io } from 'socket.io-client';

export function getParallaxServerBaseUrl({
    protocol = globalThis.location?.protocol ?? 'http:',
    hostname = globalThis.location?.hostname ?? 'localhost',
    origin = globalThis.location?.origin
} = {}) {
    const browserOrigin = typeof globalThis.location !== 'undefined'
        && globalThis.location.origin
        && globalThis.location.origin !== 'null'
        ? globalThis.location.origin
        : null;

    if (browserOrigin) {
        return browserOrigin;
    }

    if (typeof origin === 'string' && origin !== 'null') {
        return origin;
    }

    return `${protocol}//${hostname}`;
}

export function createParallaxSocket(options = {}) {
    const {
        socketFactory = io,
        ...locationOptions
    } = options;
    const socketUrl = getParallaxServerBaseUrl(locationOptions);
    console.log('[Parallax Socket] Selected URL:', socketUrl);
    const socket = socketFactory(socketUrl, {
        path: '/socket.io',
        reconnection: true,
        timeout: 15000
    });
    socket.on?.('connect', () => {
        console.log('[Parallax Socket] Connected:', socket.io.uri);
    });
    socket.on?.('disconnect', (reason) => {
        console.warn('[Parallax Socket] Disconnected:', reason);
    });
    socket.on?.('connect_error', (error) => {
        console.error('[Parallax Socket] Connection error:', error.message, 'URL:', socketUrl);
    });
    return socket;
}
