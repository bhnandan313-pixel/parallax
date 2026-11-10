import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdaptiveRenderingConfiguration } from './adaptive-rendering.js';
import { createDefaultLayout } from './geometry.js';
import { createContentRenderer } from './renderer.js';
import {
    calculateScreenSurfaceViewports,
    createScreenSurfaceCalibration
} from './screen-surface-geometry.js';
import { createDisplayMarkerOverlay } from '../vision/marker-overlay.js';

class FakeImage {
    style = {};
    parentNode = null;
    onload = null;
    onerror = null;
    src = '';
    id = '';
    alt = '';
    naturalWidth = 1200;
    naturalHeight = 600;

    load() {
        this.onload();
    }

    fail() {
        this.onerror();
    }
}

class FakeVideo extends FakeImage {
    videoWidth = 1200;
    videoHeight = 600;
    readyState = 2;
    networkState = 2;
    duration = 60;
    currentTime = 0;
    paused = true;
    seeking = false;
    muted = false;
    playsInline = false;
    playCalls = 0;
    pauseCalls = 0;
    playbackRate = 1;

    load() {
        this.onload?.();
        this.onloadeddata?.();
    }

    play() {
        this.playCalls += 1;
        this.paused = false;
        return Promise.resolve();
    }

    pause() {
        this.pauseCalls += 1;
        this.paused = true;
    }

    removeAttribute(name) {
        if (name === 'src') {
            this.src = '';
        }
    }
}

class FakeCanvas {
    _width = 0;
    _height = 0;
    dimensionWrites = 0;
    hidden = false;
    parentNode = null;
    id = '';
    attributes = {};
    calls = [];
    animations = [];
    listeners = new Map();

    get width() {
        return this._width;
    }

    set width(value) {
        this._width = value;
        this.dimensionWrites += 1;
    }

    get height() {
        return this._height;
    }

    set height(value) {
        this._height = value;
        this.dimensionWrites += 1;
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    addEventListener(name, callback) {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(callback);
        this.listeners.set(name, listeners);
    }

    removeEventListener(name, callback) {
        this.listeners.get(name)?.delete(callback);
    }

    dispatchPointer(name, pointerId, clientX, clientY) {
        const event = { pointerId, clientX, clientY, preventDefault() {} };
        for (const listener of this.listeners.get(name) ?? []) {
            listener(event);
        }
    }

    animate(keyframes, options) {
        this.animations.push({ keyframes, options });
    }

    getContext() {
        return {
            clearRect: (...args) => this.calls.push(['clearRect', ...args]),
            save: () => this.calls.push(['save']),
            restore: () => this.calls.push(['restore']),
            translate: (...args) => this.calls.push(['translate', ...args]),
            rotate: (...args) => this.calls.push(['rotate', ...args]),
            scale: (...args) => this.calls.push(['scale', ...args]),
            drawImage: (...args) => this.calls.push(['drawImage', ...args]),
            fillRect: (...args) => this.calls.push(['fillRect', ...args]),
            setTransform: (...args) => this.calls.push(['setTransform', ...args]),
            beginPath: () => this.calls.push(['beginPath']),
            moveTo: (...args) => this.calls.push(['moveTo', ...args]),
            lineTo: (...args) => this.calls.push(['lineTo', ...args]),
            closePath: () => this.calls.push(['closePath']),
            clip: () => this.calls.push(['clip'])
        };
    }
}

class FakeContainer {
    children = [];
    clientWidth = 600;
    clientHeight = 600;

    querySelector(selector) {
        return this.children.find((child) => child.id === selector.slice(1)) ?? null;
    }

    insertBefore(child, reference) {
        const index = this.children.indexOf(reference);
        this.children.splice(index === -1 ? this.children.length : index, 0, child);
        child.parentNode = this;
    }

    append(child) {
        this.children.push(child);
        child.parentNode = this;
    }

    prepend(child) {
        this.children.unshift(child);
        child.parentNode = this;
    }

    replaceChild(child, previous) {
        const index = this.children.indexOf(previous);
        this.children[index] = child;
        previous.parentNode = null;
        child.parentNode = this;
    }
}

function setupRenderer(
    screen,
    viewport = { width: 600, height: 600, orientation: null },
    options = {}
) {
    const container = new FakeContainer();
    const statusPanel = { id: 'status', parentNode: container };
    container.children.push(statusPanel);
    const images = [];
    const videos = [];
    const canvas = new FakeCanvas();
    const statuses = [];
    const render = createContentRenderer({
        container,
        statusPanel,
        screen,
        onStatus: (...status) => statuses.push(status),
        createImage: () => {
            const image = new FakeImage();
            images.push(image);
            return image;
        },
        createVideo: () => {
            const video = new FakeVideo();
            videos.push(video);
            return video;
        },
        createCanvas: () => canvas,
        getViewport: () => viewport,
        requestFrame: () => 1,
        cancelFrame: () => {},
        now: options.now ?? (() => 1000),
        onAlignmentChange: options.onAlignmentChange,
        scheduleTimeout: options.scheduleTimeout,
        cancelTimeout: options.cancelTimeout
    });
    return { canvas, container, images, videos, render, statuses };
}

function drawCalls(canvas) {
    return canvas.calls.filter(([name]) => name === 'drawImage');
}

function transformsForLastDraw(canvas) {
    const drawIndexes = canvas.calls.flatMap(([name], index) =>
        name === 'drawImage' ? [index] : []);
    const start = drawIndexes.at(-2) ?? -1;
    const end = drawIndexes.at(-1) ?? canvas.calls.length;
    return canvas.calls.slice(start + 1, end)
        .filter(([name]) => ['translate', 'rotate', 'scale'].includes(name));
}

test('coordinates fade and slide transitions against the server timeline', () => {
    const cases = [
        ['fade', [{ opacity: 0 }, { opacity: 1 }]],
        ['slide-left', [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }]],
        ['slide-right', [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }]]
    ];
    for (const [transition, keyframes] of cases) {
        let clock = 1000;
        const scheduled = [];
        const { canvas, images, render } = setupRenderer(1, undefined, {
            now: () => clock,
            scheduleTimeout: (callback, delay) => {
                const timer = { callback, delay };
                scheduled.push(timer);
                return timer;
            },
            cancelTimeout: (timer) => {
                timer.cancelled = true;
            }
        });
        render({
            contentType: 'image',
            imageUrl: '/transition.jpg',
            updateId: transition,
            transition,
            transitionAt: 2000
        });
        images[0].load();
        assert.equal(scheduled[0].delay, 1000);
        clock = 1500;
        render.setPlayback({
            status: 'playing',
            mediaId: 'image-playlist',
            positionSeconds: 0,
            startedAt: 2500,
            serverNow: 1500,
            timelineId: 'transition-timeline'
        });
        assert.equal(scheduled[0].cancelled, true);
        assert.equal(scheduled[1].delay, 500);
        scheduled[1].callback();
        assert.deepEqual(canvas.animations[0].keyframes, keyframes);
        assert.equal(canvas.animations[0].options.duration, 450);
    }
});

test('uses one wall-wide cover transform for both screens without reloading media', () => {
    const renderers = [1, 2].map((screen) => setupRenderer(screen, {
        width: 1920,
        height: 1080,
        orientation: 'landscape'
    }));
    for (const { canvas, images, render } of renderers) {
        render({ contentType: 'image', imageUrl: '/wall.jpg', updateId: 'wall' });
        images[0].naturalWidth = 3840;
        images[0].naturalHeight = 1080;
        images[0].load();
        const draw = drawCalls(canvas)[0];
        assert.deepEqual(draw.slice(2), [0, 0]);
    }

    const [left, right] = renderers;
    const leftTransforms = left.canvas.calls.filter(([name]) =>
        name === 'translate' || name === 'scale');
    const rightTransforms = right.canvas.calls.filter(([name]) =>
        name === 'translate' || name === 'scale');
    assert.deepEqual(leftTransforms, [
        ['translate', 0, 0],
        ['scale', 1, 1]
    ]);
    assert.deepEqual(rightTransforms, [
        ['translate', -1920, 0],
        ['scale', 1, 1]
    ]);
});

test('fit mode changes redraw the existing source and manual mode retains per-screen calibration', () => {
    const { canvas, images, render } = setupRenderer(2, {
        width: 600,
        height: 400,
        orientation: 'landscape'
    });
    render({ contentType: 'image', imageUrl: '/wall.jpg', updateId: 'wall' });
    images[0].load();
    assert.equal(render.setAlignment({ horizontal: 35, vertical: -20, scale: 1.8 }), true);
    assert.deepEqual(transformsForLastDraw(canvas).filter(([name]) => name === 'scale'), [
        ['scale', 1, 1]
    ]);

    assert.equal(render.setScreenFill({ enabled: true, fitMode: 'contain' }), true);
    assert.deepEqual(drawCalls(canvas).at(-1).slice(2), [0, 0]);
    assert.deepEqual(transformsForLastDraw(canvas).filter(([name]) => name === 'scale'), [
        ['scale', 2 / 3, 2 / 3]
    ]);
    assert.deepEqual(transformsForLastDraw(canvas).filter(([name]) => name === 'translate'), [
        ['translate', -400, 0]
    ]);
    assert.equal(images.length, 1);

    assert.equal(render.setScreenFill({ enabled: true, fitMode: 'stretch' }), true);
    assert.deepEqual(drawCalls(canvas).at(-1).slice(2), [0, 0]);
    assert.deepEqual(transformsForLastDraw(canvas).filter(([name]) => name === 'scale'), [
        ['scale', 1, 2 / 3]
    ]);
    assert.deepEqual(transformsForLastDraw(canvas).filter(([name]) => name === 'translate'), [
        ['translate', -600, 0]
    ]);
    assert.equal(render.setScreenFill({ enabled: true, fitMode: 'manual' }), true);
    assert.deepEqual(drawCalls(canvas).at(-1).slice(2, 6), [600, 0, 600, 600]);
    assert.ok(transformsForLastDraw(canvas).some(([name, x, y]) =>
        name === 'translate' && x === 335 && y === 180));
    assert.ok(transformsForLastDraw(canvas).some(([name, x, y]) =>
        name === 'scale' && x === 1.8 && y === 1.8));
    for (const fitMode of ['cover', 'contain', 'stretch']) {
        assert.equal(render.setScreenFill({ enabled: true, fitMode }), true);
        assert.deepEqual(
            transformsForLastDraw(canvas).filter(([name]) => name === 'scale'),
            fitMode === 'cover'
                ? [['scale', 1, 1]]
                : fitMode === 'contain'
                    ? [['scale', 2 / 3, 2 / 3]]
                    : [['scale', 1, 2 / 3]]
        );
        assert.deepEqual(
            transformsForLastDraw(canvas).filter(([name]) => name === 'translate'),
            fitMode === 'cover'
                ? [['translate', -600, -100]]
                : fitMode === 'contain'
                    ? [['translate', -400, 0]]
                    : [['translate', -600, 0]]
        );
    }
    assert.equal(render.setScreenFill({ enabled: false, fitMode: 'stretch' }), true);
    assert.ok(transformsForLastDraw(canvas).some(([name, x, y]) =>
        name === 'scale' && x === 1.8 && y === 1.8));
    assert.equal(render.setScreenFill({ enabled: true, fitMode: 'unknown' }), false);
    assert.equal(images.length, 1);
});

test('manual pinch and drag gestures update and persist calibration only in manual mode', () => {
    const saved = [];
    const { canvas, images, render } = setupRenderer(2, undefined, {
        onAlignmentChange: (alignment) => saved.push(alignment)
    });
    render({ contentType: 'image', imageUrl: '/manual.jpg', updateId: 'manual' });
    images[0].load();

    canvas.dispatchPointer('pointerdown', 1, 100, 100);
    canvas.dispatchPointer('pointerdown', 2, 200, 100);
    canvas.dispatchPointer('pointermove', 2, 300, 100);
    canvas.dispatchPointer('pointerup', 1, 100, 100);
    canvas.dispatchPointer('pointerup', 2, 300, 100);
    assert.equal(saved.length, 0);

    render.setScreenFill({ enabled: true, fitMode: 'manual' });
    canvas.dispatchPointer('pointerdown', 1, 100, 100);
    canvas.dispatchPointer('pointerdown', 2, 200, 100);
    canvas.dispatchPointer('pointermove', 2, 300, 100);
    canvas.dispatchPointer('pointerup', 1, 100, 100);
    canvas.dispatchPointer('pointerup', 2, 300, 100);
    assert.deepEqual(saved.at(-1), { horizontal: 50, vertical: 0, scale: 2 });

    canvas.dispatchPointer('pointerdown', 3, 100, 100);
    canvas.dispatchPointer('pointermove', 3, 120, 130);
    canvas.dispatchPointer('pointerup', 3, 120, 130);
    assert.deepEqual(saved.at(-1), { horizontal: 70, vertical: 30, scale: 2 });

    const drawsBeforeAutomatic = drawCalls(canvas).length;
    render.setScreenFill({ enabled: true, fitMode: 'cover' });
    assert.equal(drawCalls(canvas).length, drawsBeforeAutomatic + 1);
    canvas.dispatchPointer('pointerdown', 4, 100, 100);
    canvas.dispatchPointer('pointermove', 4, 120, 130);
    canvas.dispatchPointer('pointerup', 4, 120, 130);
    assert.equal(saved.length, 2);

    render.setScreenFill({ enabled: true, fitMode: 'manual' });
    assert.ok(transformsForLastDraw(canvas).some(([name, x, y]) =>
        name === 'scale' && x === 2 && y === 2));
    render.dispose();
    assert.equal(canvas.listeners.get('pointerdown').size, 0);
});

test('changing wall fit redraws video frames without restarting synchronized playback', () => {
    const { canvas, videos, render } = setupRenderer(2);
    render({
        contentType: 'video',
        videoUrl: '/wall.mp4',
        mediaId: 'wall-video',
        updateId: 'wall-video-update'
    });
    const video = videos[0];
    render.setPlayback({
        status: 'playing',
        mediaId: 'wall-video',
        positionSeconds: 2,
        startedAt: 1000,
        serverNow: 1000,
        timelineId: 'wall-video-timeline'
    });
    const playCalls = video.playCalls;
    const pauseCalls = video.pauseCalls;

    for (const fitMode of ['contain', 'stretch', 'manual', 'cover']) {
        assert.equal(render.setScreenFill({ enabled: true, fitMode }), true);
        assert.equal(videos.length, 1);
        assert.equal(video.currentTime, 2);
        assert.equal(video.playCalls, playCalls);
        assert.equal(video.pauseCalls, pauseCalls);
    }
    assert.ok(drawCalls(canvas).length >= 5);
});

test('adaptive viewport updates redraw the same synchronized video without restarting playback', () => {
    const savedAlignments = [];
    const { canvas, videos, render } = setupRenderer(1, undefined, {
        onAlignmentChange: (alignment) => savedAlignments.push(alignment)
    });
    render({
        contentType: 'video',
        videoUrl: '/adaptive.mp4',
        mediaId: 'adaptive-video',
        updateId: 'adaptive-video-update'
    });
    const video = videos[0];
    render.setAudioSettings({ mode: 'master', masterDeviceId: 'phone-right' }, 'phone-right', {
        volume: 1,
        enabled: true
    });
    render.setPlayback({
        status: 'playing',
        mediaId: 'adaptive-video',
        positionSeconds: 4,
        startedAt: 1000,
        serverNow: 1000,
        timelineId: 'adaptive-timeline'
    });

    const first = createScreenSurfaceCalibration({
        deviceId: 'phone-right',
        corners: [
            { x: 0.5, y: 0.2 }, { x: 0.9, y: 0.2 },
            { x: 0.9, y: 0.8 }, { x: 0.5, y: 0.8 }
        ],
        confidence: 0.9,
        timestamp: 1000,
        orientationAngle: 0
    });
    const second = createScreenSurfaceCalibration({
        deviceId: 'phone-left',
        corners: [
            { x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 },
            { x: 0.5, y: 0.8 }, { x: 0.1, y: 0.8 }
        ],
        confidence: 0.9,
        timestamp: 1000,
        orientationAngle: 0
    });
    const mapping = calculateScreenSurfaceViewports([first, second], {
        timestamp: 1100,
        orientationAngles: { 'phone-right': 0, 'phone-left': 0 },
        sharedOrientation: 'landscape'
    });
    const configuration = createAdaptiveRenderingConfiguration({
        viewports: mapping,
        devices: [
            { deviceId: 'phone-right', screen: 1, connected: true },
            { deviceId: 'phone-left', screen: 2, connected: true }
        ],
        enabled: true,
        fitMode: 'cover',
        sharedOrientation: 'landscape',
        version: 3
    });
    const playCalls = video.playCalls;
    const pauseCalls = video.pauseCalls;
    const currentTime = video.currentTime;
    const drawCount = drawCalls(canvas).length;

    assert.equal(render.setAdaptiveRendering(configuration), true);
    assert.ok(drawCalls(canvas).length > drawCount);
    assert.ok(canvas.calls.some(([name]) => name === 'clip'));
    assert.ok(canvas.calls.some(([name]) => name === 'setTransform'));
    const landscapeTransform = canvas.calls.filter(([name]) => name === 'setTransform').at(-1);
    const portraitMapping = calculateScreenSurfaceViewports([first, second], {
        timestamp: 1200,
        orientationAngles: { 'phone-right': 90, 'phone-left': 90 },
        sharedOrientation: 'portrait'
    });
    const portraitConfiguration = createAdaptiveRenderingConfiguration({
        viewports: portraitMapping,
        devices: [
            { deviceId: 'phone-right', screen: 1, connected: true },
            { deviceId: 'phone-left', screen: 2, connected: true }
        ],
        enabled: true,
        fitMode: 'cover',
        sharedOrientation: 'portrait',
        version: 4
    });
    assert.equal(render.setAdaptiveRendering(portraitConfiguration), true);
    const portraitTransform = canvas.calls.filter(([name]) => name === 'setTransform').at(-1);
    assert.notDeepEqual(portraitTransform, landscapeTransform);
    assert.equal(videos.length, 1);
    assert.equal(video.currentTime, currentTime);
    assert.equal(video.playCalls, playCalls);
    assert.equal(video.pauseCalls, pauseCalls);

    assert.equal(render.setScreenFill({ enabled: true, fitMode: 'manual' }), true);
    canvas.dispatchPointer('pointerdown', 1, 100, 100);
    canvas.dispatchPointer('pointerdown', 2, 200, 100);
    canvas.dispatchPointer('pointermove', 2, 300, 100);
    canvas.dispatchPointer('pointerup', 1, 100, 100);
    canvas.dispatchPointer('pointerup', 2, 300, 100);
    assert.deepEqual(savedAlignments.at(-1), { horizontal: 50, vertical: 0, scale: 2 });
    assert.ok(canvas.calls.some(([name, ...args]) =>
        name === 'drawImage' && args.length === 9));
    assert.equal(video.currentTime, currentTime);
    assert.equal(video.playCalls, playCalls);
    assert.equal(video.pauseCalls, pauseCalls);
});

test('marker overlay remains separate and visible through fit changes without restarting video', () => {
    const { canvas, container, videos, render } = setupRenderer(1);
    render({
        contentType: 'video',
        videoUrl: '/marker-overlay.mp4',
        mediaId: 'marker-overlay-video',
        updateId: 'marker-overlay-video-update'
    });
    const video = videos[0];
    render.setPlayback({
        status: 'playing',
        mediaId: 'marker-overlay-video',
        positionSeconds: 2,
        startedAt: 1000,
        serverNow: 1000,
        timelineId: 'marker-overlay-timeline'
    });
    const playCalls = video.playCalls;
    const pauseCalls = video.pauseCalls;
    const currentTime = video.currentTime;
    const markerDocument = {
        createElement(tagName) {
            if (tagName === 'canvas') {
                return {
                    style: {},
                    width: 0,
                    height: 0,
                    getContext: () => ({
                        fillStyle: '#000',
                        fillRect() {}
                    })
                };
            }
            return {
                style: {},
                dataset: {},
                children: [],
                setAttribute() {},
                append(child) {
                    this.children.push(child);
                }
            };
        }
    };
    const marker = createDisplayMarkerOverlay({
        document: markerDocument,
        deviceId: 'marker-phone',
        markerId: 321
    });
    container.prepend(marker);
    const initialDraws = drawCalls(canvas).length;
    for (const fitMode of ['cover', 'contain', 'stretch', 'manual']) {
        assert.equal(render.setScreenFill({ enabled: true, fitMode }), true);
        assert.equal(container.children[0], marker);
        assert.equal(marker.dataset.markerId, '321');
        assert.equal(marker.style.zIndex, '25');
    }
    assert.ok(drawCalls(canvas).length >= initialDraws + 4);
    assert.equal(videos.length, 1);
    assert.equal(video.currentTime, currentTime);
    assert.equal(video.playCalls, playCalls);
    assert.equal(video.pauseCalls, pauseCalls);
});

test('crops adjacent horizontal screens from the shared panorama without distortion', () => {
    for (const screen of [1, 2]) {
        const { canvas, container, images, render } = setupRenderer(screen);
        render.setScreenFill({ enabled: false, fitMode: 'manual' });
        render({ contentType: 'image', imageUrl: '/first.jpg', updateId: 'first' });
        assert.equal(container.querySelector('#panorama'), null);
        images[0].load();
        assert.equal(container.querySelector('#panorama'), canvas);
        assert.deepEqual(drawCalls(canvas)[0].slice(2, 6), [
            (screen - 1) * 600, 0, 600, 600
        ]);
        assert.equal(canvas.attributes['aria-label'], `Panorama screen ${screen}`);
        const crop = drawCalls(canvas)[0];
        assert.equal(crop[6], -300);
        assert.equal(crop[7], -300);
        assert.equal(crop[8], 600);
        assert.equal(crop[9], 600);
    }
});

test('renders four-screen horizontal, vertical, and grid source regions', () => {
    const horizontal = setupRenderer(4);
    horizontal.render.setScreenFill({ enabled: false, fitMode: 'manual' });
    horizontal.render.setScreenCount(4);
    horizontal.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'horizontal' });
    horizontal.images[0].load();
    assert.deepEqual(drawCalls(horizontal.canvas)[0].slice(2, 6), [900, 0, 300, 600]);

    const vertical = setupRenderer(3);
    vertical.render.setScreenFill({ enabled: false, fitMode: 'manual' });
    vertical.render.setScreenCount(4);
    vertical.render.setLayout(createDefaultLayout(4, 'vertical'));
    vertical.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'vertical' });
    vertical.images[0].load();
    assert.deepEqual(drawCalls(vertical.canvas)[0].slice(2, 6), [0, 300, 1200, 150]);

    const grid = setupRenderer(4);
    grid.render.setScreenFill({ enabled: false, fitMode: 'manual' });
    grid.render.setScreenCount(4);
    grid.render.setLayout(createDefaultLayout(4, 'grid', 2, 2));
    grid.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'grid' });
    grid.images[0].load();
    assert.deepEqual(drawCalls(grid.canvas)[0].slice(2, 6), [600, 300, 600, 300]);
});

test('custom gaps, rotation, and portrait/landscape overrides affect source and canvas geometry', () => {
    const custom = setupRenderer(2, { width: 800, height: 400, orientation: 'landscape' });
    custom.render.setScreenFill({ enabled: false, fitMode: 'manual' });
    custom.render.setScreenCount(2);
    custom.render.setLayout({
        type: 'custom',
        rows: 2,
        columns: 3,
        screens: {
            1: { row: 0, column: 0, rotation: 0, orientation: 'auto', enabled: true },
            2: { row: 1, column: 2, rotation: 90, orientation: 'portrait', enabled: true }
        }
    });
    custom.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'custom' });
    custom.images[0].load();
    const crop = drawCalls(custom.canvas)[0];
    assert.deepEqual(crop.slice(2, 6), [800, 300, 400, 300]);
    assert.equal(custom.canvas.width, 400);
    assert.equal(custom.canvas.height, 800);
    assert.ok(custom.canvas.calls.some(([name, value]) => name === 'rotate'
        && value === Math.PI / 2));

    const rotatedPortrait = setupRenderer(1, {
        width: 400,
        height: 800,
        orientation: 'portrait'
    });
    rotatedPortrait.render.setLayout({
        type: 'horizontal',
        rows: 1,
        columns: 2,
        screens: {
            1: { row: 0, column: 0, rotation: 0, orientation: 'landscape', enabled: true },
            2: { row: 0, column: 1, rotation: 0, orientation: 'auto', enabled: true }
        }
    });
    rotatedPortrait.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'landscape' });
    rotatedPortrait.images[0].load();
    assert.equal(rotatedPortrait.canvas.width, 800);
    assert.equal(rotatedPortrait.canvas.height, 400);
});

test('keeps the previous frame on image failure and ignores stale loads', () => {
    const { canvas, container, images, render } = setupRenderer(1);
    render({ contentType: 'image', imageUrl: '/first.jpg', updateId: 'first' });
    images[0].load();
    const firstCallCount = drawCalls(canvas).length;
    render({ contentType: 'image', imageUrl: '/failed.jpg', updateId: 'failed' });
    images[1].fail();
    assert.equal(container.querySelector('#panorama'), canvas);
    assert.equal(drawCalls(canvas).length, firstCallCount);

    render({ contentType: 'image', imageUrl: '/slow.jpg', updateId: 'slow' });
    render({ contentType: 'image', imageUrl: '/fast.jpg', updateId: 'fast' });
    images[3].load();
    const fastCallCount = drawCalls(canvas).length;
    images[2].load();
    assert.equal(drawCalls(canvas).length, fastCallCount);
});

test('alignment redraws the canvas and disabled screens restore without losing assignments', () => {
    const { canvas, images, render, statuses } = setupRenderer(1);
    render.setScreenFill({ enabled: true, fitMode: 'manual' });
    render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'first' });
    images[0].load();
    const initialDimensionWrites = canvas.dimensionWrites;
    const firstDraws = drawCalls(canvas).length;
    assert.equal(render.setAlignment({ horizontal: 18, vertical: -12, scale: 1.04 }), true);
    assert.equal(drawCalls(canvas).length, firstDraws + 1);
    assert.equal(canvas.dimensionWrites, initialDimensionWrites);
    assert.ok(canvas.calls.some(([name, x, y]) =>
        name === 'translate' && x === 318 && y === 288));
    assert.equal(render.setAlignment({ horizontal: 2001, vertical: 0, scale: 1 }), false);

    render.setScreenEnabled(false);
    assert.equal(canvas.hidden, true);
    assert.ok(statuses.some(([message]) => message === 'Screen disabled - Screen 1'));
    const disabledDraws = drawCalls(canvas).length;
    render.setScreenEnabled(true);
    assert.equal(canvas.hidden, false);
    assert.equal(drawCalls(canvas).length, disabledDraws + 1);
});

test('preloads the next image and reuses its decoded source when published', () => {
    const { images, canvas, render } = setupRenderer(2);
    assert.equal(render.preload({
        mediaType: 'image',
        mediaUrl: '/uploads/next-slide.png'
    }), true);
    assert.equal(images.length, 1);
    images[0].load();
    render({
        contentType: 'image',
        imageUrl: '/uploads/next-slide.png',
        updateId: 'preloaded-slide'
    });
    assert.equal(images.length, 1);
    assert.equal(drawCalls(canvas).length, 1);
});

test('preloads only video metadata and reuses the warmed video when activated', () => {
    const { videos, render } = setupRenderer(1);
    assert.equal(render.preload({
        mediaType: 'video',
        mediaUrl: '/uploads/next.mp4'
    }), true);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].preload, 'metadata');

    render({
        contentType: 'video',
        videoUrl: '/uploads/next.mp4',
        mediaId: 'next-video',
        updateId: 'next-update'
    });
    assert.equal(videos.length, 1);
    assert.equal(videos[0].preload, 'auto');
});

test('renders a video panorama crop and synchronizes its scheduled playback timeline', () => {
    let clock = 1000;
    const { canvas, videos, render } = setupRenderer(2, undefined, { now: () => clock });
    render.setScreenFill({ enabled: false, fitMode: 'manual' });
    render.setScreenCount(4);
    render.setLayout(createDefaultLayout(4));
    const content = {
        contentType: 'video',
        videoUrl: '/uploads/panorama.mp4',
        mediaId: 'video-1',
        updateId: 'video-update-1'
    };
    render(content);

    assert.equal(videos.length, 1);
    assert.equal(videos[0].muted, true);
    assert.equal(videos[0].playsInline, true);
    assert.equal(videos[0].src, content.videoUrl);
    assert.deepEqual(drawCalls(canvas)[0].slice(2, 6), [300, 0, 300, 600]);
    render.setAudioSettings({ mode: 'master', masterDeviceId: 'phone-1' }, 'phone-1', {
        volume: 1,
        enabled: true
    });

    assert.equal(render.setPlayback({
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 3,
        startedAt: 1000,
        serverNow: 1000,
        timelineId: 'timeline-1',
        volume: 0.4
    }), true);
    assert.equal(videos[0].currentTime, 3);
    assert.equal(videos[0].volume, 0.4);
    assert.equal(videos[0].volume, 0.4);
    assert.equal(videos[0].muted, false);
    assert.equal(videos[0].playCalls, 1);

    clock = 1400;
    render.setPlayback({
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 3,
        startedAt: 1000,
        serverNow: 1400,
        timelineId: 'timeline-1',
        volume: 0.25
    });
    assert.equal(videos[0].currentTime, 3);
    assert.equal(videos[0].volume, 0.25);
    assert.equal(videos[0].muted, false);
    assert.equal(videos[0].playbackRate, 1);
    clock = 2600;
    render.setPlayback({
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 3,
        startedAt: 1000,
        serverNow: 2600,
        timelineId: 'timeline-1',
        volume: 0.25
    });
    assert.equal(videos[0].currentTime, 4.6);
    assert.deepEqual(render.getPlaybackReport(), {
        mediaId: 'video-1',
        positionSeconds: 4.6,
        expectedPositionSeconds: 4.6,
        driftSeconds: 0,
        status: 'Playing',
        readyState: 2,
        networkState: 2,
        bufferingState: 'idle',
        playbackRate: 1,
        muted: false,
        volume: 0.25,
        lastSuccessfulSynchronization: 2600
    });

    render({ ...content, updateId: 'video-update-2' });
    assert.equal(videos.length, 1);
});

test('detects waiting and stalled video, then recovers without reloading the source', () => {
    const scheduled = [];
    const { videos, render, statuses } = setupRenderer(1, undefined, {
        now: () => 10_000,
        scheduleTimeout: (callback) => {
            scheduled.push(callback);
            return scheduled.length;
        },
        cancelTimeout: () => {}
    });
    render({
        contentType: 'video',
        videoUrl: '/uploads/frozen.mp4',
        mediaId: 'frozen-video',
        updateId: 'frozen-update'
    });
    render.setPlayback({
        status: 'playing',
        mediaId: 'frozen-video',
        positionSeconds: 0,
        startedAt: 10_000,
        serverNow: 10_000,
        timelineId: 'frozen-timeline',
        volume: 0
    });
    const source = videos[0].src;
    videos[0].onwaiting();
    assert.equal(render.getPlaybackReport().status, 'Buffering');
    scheduled.shift()();
    assert.equal(render.getPlaybackReport().status, 'Recovering');
    assert.equal(videos[0].src, source);
    assert.equal(videos[0].playCalls, 2);
    scheduled.shift()();
    assert.equal(render.getPlaybackReport().status, 'Stalled');
    videos[0].oncanplay();
    assert.equal(render.getPlaybackReport().bufferingState, 'idle');
    assert.ok(statuses.some(([, state]) => state === 'error') === false);
});

test('reports browser-observed video errors without hiding the failure', () => {
    const { videos, render, statuses } = setupRenderer(1);
    render({
        contentType: 'video',
        videoUrl: '/uploads/bad.mp4',
        mediaId: 'bad-video',
        updateId: 'bad-update'
    });
    videos[0].onerror();
    assert.equal(render.getPlaybackReport().status, 'Error');
    assert.equal(render.getPlaybackReport().bufferingState, 'error');
    assert.ok(statuses.some(([message, state]) =>
        message.includes('Video failed to load') && state === 'error'));
});

test('applies local volume and mute changes directly to the video element', () => {
    const { videos, render } = setupRenderer(1, undefined, { now: () => 20_000 });
    render({
        contentType: 'video',
        videoUrl: '/uploads/audio.mp4',
        mediaId: 'audio-video',
        updateId: 'audio-update'
    });
    render.setPlayback({
        status: 'playing',
        mediaId: 'audio-video',
        positionSeconds: 0,
        startedAt: 20_000,
        serverNow: 20_000,
        timelineId: 'audio-timeline',
        volume: 0.8
    });
    render.setAudioSettings({ mode: 'all', masterDeviceId: null }, 'phone-audio', {
        volume: 0.35,
        enabled: false
    });
    assert.ok(Math.abs(videos[0].volume - 0.28) < 0.000001);
    assert.equal(videos[0].muted, true);

    render.setAudioSettings({ mode: 'all', masterDeviceId: null }, 'phone-audio', {
        volume: 0.35,
        enabled: true
    });
    assert.ok(Math.abs(videos[0].volume - 0.28) < 0.000001);
    assert.equal(videos[0].muted, false);

    render.setAudioSettings({ mode: 'master', masterDeviceId: 'phone-audio' }, 'phone-audio', {
        volume: 0.5,
        enabled: true
    });
    assert.equal(videos[0].volume, 0.4);
    assert.equal(videos[0].muted, false);
});

test('draws video frames on video-frame callbacks and cancels them when playback pauses', () => {
    const pendingFrames = new Map();
    const cancelledFrames = [];
    let nextFrameId = 0;
    const { canvas, videos, render } = setupRenderer(1);
    const content = {
        contentType: 'video',
        videoUrl: '/uploads/panorama.mp4',
        mediaId: 'video-1',
        updateId: 'video-update-1'
    };
    render(content);
    videos[0].requestVideoFrameCallback = (callback) => {
        const id = ++nextFrameId;
        pendingFrames.set(id, callback);
        return id;
    };
    videos[0].cancelVideoFrameCallback = (id) => {
        cancelledFrames.push(id);
        pendingFrames.delete(id);
    };
    videos[0].load();
    render.setPlayback({
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 0,
        startedAt: 1000,
        serverNow: 1000,
        timelineId: 'timeline-1'
    });

    const beforeFrameDraws = drawCalls(canvas).length;
    const firstFrame = pendingFrames.get(1);
    pendingFrames.delete(1);
    firstFrame();
    assert.equal(drawCalls(canvas).length, beforeFrameDraws + 1);
    assert.equal(pendingFrames.has(2), true);

    render.setPlayback({
        status: 'paused',
        mediaId: 'video-1',
        positionSeconds: 0,
        startedAt: null,
        serverNow: 1000,
        timelineId: 'timeline-2'
    });
    assert.deepEqual(cancelledFrames, [2]);
    assert.equal(pendingFrames.size, 0);
});
