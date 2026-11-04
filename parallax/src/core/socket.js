import { io } from 'socket.io-client';

export function getParallaxServerBaseUrl({
    protocol = globalThis.location.protocol,
    hostname = globalThis.location.hostname
} = {}) {
    return `${protocol}//${hostname}:3001`;
}

export function createParallaxSocket(options = {}) {
    const {
        socketFactory = io,
        ...locationOptions
    } = options;
    return socketFactory(getParallaxServerBaseUrl(locationOptions), {
        reconnection: true,
        timeout: 15000
    });
}
