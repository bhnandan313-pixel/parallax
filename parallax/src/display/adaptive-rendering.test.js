import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createAdaptiveRenderTriangles,
    createAdaptiveRenderingConfiguration
} from './adaptive-rendering.js';
import {
    calculateScreenSurfaceViewports,
    createScreenSurfaceCalibration
} from './screen-surface-geometry.js';

function calibration(deviceId, left, right, top = 0.2, bottom = 0.8) {
    return createScreenSurfaceCalibration({
        deviceId,
        corners: [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
        ],
        confidence: 0.9,
        timestamp: 1000
    });
}

function createConfiguration(options = {}) {
    const first = calibration('phone-right', 0.5, 0.9);
    const second = calibration('phone-left', 0.1, 0.5);
    const viewports = calculateScreenSurfaceViewports([first, second], { timestamp: 1100 });
    const devices = [
        { deviceId: 'phone-right', screen: 1, connected: true },
        { deviceId: 'phone-left', screen: 2, connected: true }
    ];
    return createAdaptiveRenderingConfiguration({
        viewports,
        devices,
        enabled: true,
        screenFillEnabled: true,
        fitMode: 'cover',
        version: 7,
        ...options
    });
}

test('creates one authoritative shared-frame configuration for reversed device ordering', () => {
    const configuration = createConfiguration();
    assert.equal(configuration.active, true);
    assert.equal(configuration.version, 7);
    assert.equal(configuration.coordinateSpace, 'normalized-camera-image-reference');
    assert.equal(configuration.physicalGeometryCalibrated, false);
    assert.deepEqual(configuration.devices.map(({ deviceId, screen }) =>
        ({ deviceId, screen })), [
        { deviceId: 'phone-left', screen: 2 },
        { deviceId: 'phone-right', screen: 1 }
    ]);
    assert.equal(configuration.sharedFrame.width, 1);
    assert.equal(configuration.sharedFrame.height, 1);
    assert.ok(Math.abs(configuration.sharedFrame.aspectRatio - 4 / 3) < 1e-10);
    assert.ok(configuration.devices.every(({ localToSharedFrame }) =>
        localToSharedFrame.convention.includes('shared=')));
});

test('falls back for disabled, missing, disconnected, and manual-mode configurations', () => {
    assert.equal(createConfiguration({ enabled: false }).reason, 'disabled-by-controller');
    assert.equal(createConfiguration({ fitMode: 'manual' }).reason,
        'manual-mode-preserves-per-device-adjustments');
    assert.equal(createConfiguration({ screenFillEnabled: false }).active, false);
    assert.equal(createConfiguration({
        layout: { screens: { 1: { rotation: 90 }, 2: { rotation: 0 } } }
    }).reason, 'manual-screen-rotation-uses-existing-renderer');
    assert.equal(createConfiguration({
        devices: [{ deviceId: 'phone-right', screen: 1, connected: true }]
    }).reason, 'both-display-devices-must-be-connected');
    const invalid = createAdaptiveRenderingConfiguration({
        viewports: { valid: false, reason: 'missing-or-stale-calibration' },
        devices: [
            { deviceId: 'phone-right', screen: 1, connected: true },
            { deviceId: 'phone-left', screen: 2, connected: true }
        ],
        enabled: true
    });
    assert.equal(invalid.active, false);
    assert.equal(invalid.reason, 'missing-or-stale-calibration');
});

test('maps adjacent devices to matching global video coordinates', () => {
    const configuration = createConfiguration();
    const leftViewport = configuration.devices.find(({ screen }) => screen === 2);
    const rightViewport = configuration.devices.find(({ screen }) => screen === 1);
    const leftTriangles = createAdaptiveRenderTriangles({
        viewport: leftViewport,
        canvasWidth: 800,
        canvasHeight: 600,
        imageWidth: 1200,
        imageHeight: 600,
        sharedFrame: configuration.sharedFrame,
        fitMode: 'stretch'
    });
    const rightTriangles = createAdaptiveRenderTriangles({
        viewport: rightViewport,
        canvasWidth: 800,
        canvasHeight: 600,
        imageWidth: 1200,
        imageHeight: 600,
        sharedFrame: configuration.sharedFrame,
        fitMode: 'stretch'
    });
    assert.equal(leftTriangles.length, 128);
    assert.equal(rightTriangles.length, 128);
    const leftEdge = leftTriangles
        .flatMap((triangle) => triangle)
        .filter(({ destination }) => Math.abs(destination.x - 800) < 1e-8)
        .map(({ source }) => source);
    const rightEdge = rightTriangles
        .flatMap((triangle) => triangle)
        .filter(({ destination }) => destination.x === 0)
        .map(({ source }) => source);
    for (const point of leftEdge) {
        assert.ok(rightEdge.some((rightPoint) =>
            Math.abs(point.x - rightPoint.x) < 1e-8
            && Math.abs(point.y - rightPoint.y) < 1e-8));
    }
});

test('applies one shared portrait or landscape frame rotation without breaking the device seam', () => {
    const configuration = createConfiguration();
    const viewports = [1, 2].map((screen) =>
        configuration.devices.find((entry) => entry.screen === screen));
    const mapFor = (viewport, sharedOrientation) => createAdaptiveRenderTriangles({
        viewport,
        canvasWidth: 800,
        canvasHeight: 600,
        imageWidth: 1200,
        imageHeight: 600,
        sharedFrame: configuration.sharedFrame,
        fitMode: 'stretch',
        sharedOrientation
    });
    const landscape = viewports.map((viewport) => mapFor(viewport, 'landscape'));
    const portrait = viewports.map((viewport) => mapFor(viewport, 'portrait'));
    assert.ok(landscape.flat(2).some(({ source }) => source.x !== 0 || source.y !== 0));
    assert.notDeepEqual(portrait[0][0][0].source, landscape[0][0][0].source);

    for (const mesh of [landscape, portrait]) {
        const leftScreen = mesh.find((_, index) => viewports[index].screen === 2);
        const rightScreen = mesh.find((_, index) => viewports[index].screen === 1);
        const leftEdge = leftScreen.flat(2)
            .filter(({ destination }) => Math.abs(destination.x - 800) < 1e-8)
            .map(({ source }) => source);
        const rightEdge = rightScreen.flat(2)
            .filter(({ destination }) => Math.abs(destination.x) < 1e-8)
            .map(({ source }) => source);
        for (const point of leftEdge) {
            assert.ok(rightEdge.some((rightPoint) =>
                Math.abs(point.x - rightPoint.x) < 1e-8
                && Math.abs(point.y - rightPoint.y) < 1e-8));
        }
    }
});

test('supports stacked and angled projective viewports and all existing automatic fit modes', () => {
    const angled = createScreenSurfaceCalibration({
        deviceId: 'phone-left',
        corners: [
            { x: 0.15, y: 0.05 },
            { x: 0.48, y: 0.25 },
            { x: 0.45, y: 0.85 },
            { x: 0.12, y: 0.65 }
        ],
        confidence: 0.9,
        timestamp: 1000
    });
    const lower = calibration('phone-right', 0.15, 0.55, 0.7, 0.95);
    const mapping = calculateScreenSurfaceViewports([angled, lower], { timestamp: 1100 });
    assert.equal(mapping.valid, true);
    assert.equal(mapping.arrangement, 'STACKED');
    const configuration = createAdaptiveRenderingConfiguration({
        viewports: mapping,
        devices: [
            { deviceId: 'phone-left', screen: 1, connected: true },
            { deviceId: 'phone-right', screen: 2, connected: true }
        ],
        enabled: true
    });
    assert.equal(configuration.orientation, 'ANGLED');
    for (const fitMode of ['cover', 'contain', 'stretch']) {
        const triangles = createAdaptiveRenderTriangles({
            viewport: configuration.devices.find(({ deviceId }) => deviceId === 'phone-left'),
            canvasWidth: 600,
            canvasHeight: 800,
            imageWidth: 1920,
            imageHeight: 1080,
            sharedFrame: configuration.sharedFrame,
            fitMode
        });
        assert.equal(triangles?.length, 128);
        assert.ok(triangles.flat().some(({ source }) =>
            Math.abs(source.x - Math.round(source.x)) > 1e-5
            || Math.abs(source.y - Math.round(source.y)) > 1e-5));
    }
});

test('rejects invalid projective matrices and mesh options', () => {
    const configuration = createConfiguration();
    const viewport = configuration.devices[0];
    assert.equal(createAdaptiveRenderTriangles({
        viewport: { ...viewport, localToSharedFrame: { matrix3x3: [0, 0, 0, 0, 0, 0, 0, 0, 1] } },
        canvasWidth: 100,
        canvasHeight: 100,
        imageWidth: 100,
        imageHeight: 100,
        sharedFrame: configuration.sharedFrame
    }), null);
    assert.equal(createAdaptiveRenderTriangles({
        viewport,
        canvasWidth: 100,
        canvasHeight: 100,
        imageWidth: 100,
        imageHeight: 100,
        sharedFrame: configuration.sharedFrame,
        segments: 33
    }), null);
});
