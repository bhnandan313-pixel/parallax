import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultLayout } from './geometry.js';
import { createContentRenderer } from './renderer.js';

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
    currentTime = 0;
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
        return Promise.resolve();
    }

    pause() {
        this.pauseCalls += 1;
    }

    removeAttribute(name) {
        if (name === 'src') {
            this.src = '';
        }
    }
}

class FakeCanvas {
    width = 0;
    height = 0;
    hidden = false;
    parentNode = null;
    id = '';
    attributes = {};
    calls = [];
    animations = [];

    setAttribute(name, value) {
        this.attributes[name] = value;
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
            drawImage: (...args) => this.calls.push(['drawImage', ...args])
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
        scheduleTimeout: options.scheduleTimeout,
        cancelTimeout: options.cancelTimeout
    });
    return { canvas, container, images, videos, render, statuses };
}

function drawCalls(canvas) {
    return canvas.calls.filter(([name]) => name === 'drawImage');
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

test('crops adjacent horizontal screens from the shared panorama without distortion', () => {
    for (const screen of [1, 2]) {
        const { canvas, container, images, render } = setupRenderer(screen);
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
    horizontal.render.setScreenCount(4);
    horizontal.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'horizontal' });
    horizontal.images[0].load();
    assert.deepEqual(drawCalls(horizontal.canvas)[0].slice(2, 6), [900, 0, 300, 600]);

    const vertical = setupRenderer(3);
    vertical.render.setScreenCount(4);
    vertical.render.setLayout(createDefaultLayout(4, 'vertical'));
    vertical.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'vertical' });
    vertical.images[0].load();
    assert.deepEqual(drawCalls(vertical.canvas)[0].slice(2, 6), [0, 300, 1200, 150]);

    const grid = setupRenderer(4);
    grid.render.setScreenCount(4);
    grid.render.setLayout(createDefaultLayout(4, 'grid', 2, 2));
    grid.render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'grid' });
    grid.images[0].load();
    assert.deepEqual(drawCalls(grid.canvas)[0].slice(2, 6), [600, 300, 600, 300]);
});

test('custom gaps, rotation, and portrait/landscape overrides affect source and canvas geometry', () => {
    const custom = setupRenderer(2, { width: 800, height: 400, orientation: 'landscape' });
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
    render({ contentType: 'image', imageUrl: '/panorama.jpg', updateId: 'first' });
    images[0].load();
    const firstDraws = drawCalls(canvas).length;
    assert.equal(render.setAlignment({ horizontal: 18, vertical: -12, scale: 1.04 }), true);
    assert.equal(drawCalls(canvas).length, firstDraws + 1);
    assert.ok(canvas.calls.some(([name, x, y]) =>
        name === 'translate' && x === 318 && y === 288));
    assert.equal(render.setAlignment({ horizontal: 51, vertical: 0, scale: 1 }), false);

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

test('renders a video panorama crop and synchronizes its scheduled playback timeline', () => {
    let clock = 1000;
    const { canvas, videos, render } = setupRenderer(2, undefined, { now: () => clock });
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

    assert.equal(render.setPlayback({
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 3,
        startedAt: 1000,
        serverNow: 1000,
        timelineId: 'timeline-1'
    }), true);
    assert.equal(videos[0].currentTime, 3);
    assert.equal(videos[0].playCalls, 1);

    clock = 1400;
    render.setPlayback({
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 3,
        startedAt: 1000,
        serverNow: 1400,
        timelineId: 'timeline-1'
    });
    assert.equal(videos[0].currentTime, 3.4);
    assert.deepEqual(render.getPlaybackReport(), {
        mediaId: 'video-1',
        positionSeconds: 3.4
    });

    render({ ...content, updateId: 'video-update-2' });
    assert.equal(videos.length, 1);
});
