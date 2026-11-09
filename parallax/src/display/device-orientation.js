const VALID_ANGLES = new Set([0, 90, 180, 270]);

function normalizeOrientationAngle(angle) {
    if (angle === null || angle === undefined || angle === ''
        || !Number.isFinite(Number(angle))) {
        return null;
    }
    const normalized = ((Math.round(Number(angle) / 90) * 90) % 360 + 360) % 360;
    return VALID_ANGLES.has(normalized) ? normalized : null;
}

function orientationFromType(type) {
    if (typeof type !== 'string') {
        return null;
    }
    if (type.startsWith('portrait')) {
        return 'portrait';
    }
    if (type.startsWith('landscape')) {
        return 'landscape';
    }
    return null;
}

export function orientationFromDeviceAngles(beta, gamma) {
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) {
        return null;
    }
    const betaAxis = Math.abs(((beta + 180) % 360 + 360) % 360 - 180);
    const gammaAxis = Math.abs(gamma);
    if (Math.abs(betaAxis - gammaAxis) < 15) {
        return null;
    }
    return betaAxis > gammaAxis ? 'portrait' : 'landscape';
}

export function detectDeviceOrientation({
    screen = globalThis.screen,
    window = globalThis.window,
    deviceOrientation = null
} = {}) {
    const sensorOrientation = orientationFromDeviceAngles(
        deviceOrientation?.beta,
        deviceOrientation?.gamma
    );
    if (sensorOrientation) {
        return {
            orientation: sensorOrientation,
            angle: null,
            source: 'device-orientation-sensor',
            confidence: 0.8
        };
    }

    const screenOrientation = screen?.orientation;
    const apiOrientation = orientationFromType(screenOrientation?.type);
    if (apiOrientation) {
        return {
            orientation: apiOrientation,
            angle: normalizeOrientationAngle(screenOrientation.angle),
            source: 'screen-orientation-api',
            confidence: 1
        };
    }

    const viewportWidth = Number(window?.innerWidth);
    const viewportHeight = Number(window?.innerHeight);
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
        || viewportWidth <= 0 || viewportHeight <= 0 || viewportWidth === viewportHeight) {
        return null;
    }

    const legacyAngle = normalizeOrientationAngle(window?.orientation);
    return {
        orientation: viewportWidth > viewportHeight ? 'landscape' : 'portrait',
        angle: legacyAngle,
        source: legacyAngle === null ? 'viewport' : 'window-orientation',
        confidence: legacyAngle === null ? 0.6 : 0.8
    };
}

export function createDeviceOrientationReporter({
    deviceId,
    emit,
    screen = globalThis.screen,
    window = globalThis.window,
    now = () => Date.now(),
    setIntervalFn = globalThis.setInterval,
    clearIntervalFn = globalThis.clearInterval,
    heartbeatMs = 15_000,
    logger = console
} = {}) {
    if (typeof deviceId !== 'string' || !deviceId.trim()
        || typeof emit !== 'function') {
        throw new TypeError('A device ID and orientation report callback are required');
    }

    let lastSignature = null;
    let disposed = false;
    let latestDeviceOrientation = null;
    let latestDeviceOrientationAt = 0;
    logger.info?.('[Orientation] Reporter initialized', {
        deviceId,
        screenOrientationApiAvailable: Boolean(screen?.orientation),
        orientationChangeEventAvailable: typeof screen?.orientation?.addEventListener === 'function',
        windowOrientationChangeEventAvailable: typeof window?.addEventListener === 'function'
    });
    const report = (force = false) => {
        if (disposed) {
            logger.warn?.('[Orientation] Report skipped: reporter is disposed', { deviceId });
            return null;
        }
        const sensorFresh = latestDeviceOrientation
            && now() - latestDeviceOrientationAt <= 2000;
        const detected = detectDeviceOrientation({
            screen,
            window,
            deviceOrientation: sensorFresh ? latestDeviceOrientation : null
        });
        if (!detected) {
            logger.warn?.('[Orientation] Report skipped: orientation is unavailable', { deviceId });
            return null;
        }
        const signature = JSON.stringify(detected);
        if (!force && signature === lastSignature) {
            return null;
        }
        const payload = {
            deviceId,
            ...detected,
            timestamp: now()
        };
        lastSignature = signature;
        logger.info?.('[Orientation] Detected device orientation', payload);
        emit(payload);
        return payload;
    };
    const onChange = (event) => {
        logger.info?.('[Orientation] Orientation event received', {
            deviceId,
            eventType: event?.type ?? 'unknown'
        });
        report();
    };
    const onDeviceOrientation = (event) => {
        logger.info?.('[Orientation] Device sensor event received', {
            deviceId,
            beta: event?.beta ?? null,
            gamma: event?.gamma ?? null,
            absolute: event?.absolute ?? null
        });
        const orientation = orientationFromDeviceAngles(event?.beta, event?.gamma);
        if (!orientation) {
            logger.warn?.('[Orientation] Device sensor pose is ambiguous; using screen orientation fallback', {
                deviceId
            });
            latestDeviceOrientation = null;
            latestDeviceOrientationAt = 0;
            report();
            return;
        }
        latestDeviceOrientation = { beta: event.beta, gamma: event.gamma };
        latestDeviceOrientationAt = now();
        report();
    };
    const orientationApi = screen?.orientation;
    orientationApi?.addEventListener?.('change', onChange);
    window?.addEventListener?.('orientationchange', onChange, { passive: true });
    window?.addEventListener?.('resize', onChange, { passive: true });
    window?.addEventListener?.('deviceorientation', onDeviceOrientation, { passive: true });
    logger.info?.('[Orientation] Change listeners registered', { deviceId });
    const heartbeatTimer = typeof setIntervalFn === 'function' && heartbeatMs > 0
        ? setIntervalFn(() => {
            if (!disposed && lastSignature !== null) {
                emit({ deviceId, heartbeat: true });
            }
        }, heartbeatMs)
        : null;

    return {
        report,
        dispose() {
            disposed = true;
            orientationApi?.removeEventListener?.('change', onChange);
            window?.removeEventListener?.('orientationchange', onChange);
            window?.removeEventListener?.('resize', onChange);
            window?.removeEventListener?.('deviceorientation', onDeviceOrientation);
            if (heartbeatTimer !== null) {
                clearIntervalFn?.(heartbeatTimer);
            }
        }
    };
}
