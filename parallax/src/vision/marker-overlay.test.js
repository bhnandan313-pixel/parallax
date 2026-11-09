import assert from 'node:assert/strict';
import test from 'node:test';
import {
    computeMarkerIdForDevice,
    createArucoMarkerPattern,
    createPersistentMarkerAssignments
} from './marker-detection.js';
import {
    DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION,
    getArucoMarkerDisplaySize,
    renderArucoMarker
} from './marker-renderer.js';
import {
    createDisplayMarkerOverlay,
    resizeDisplayMarkerOverlay
} from './marker-overlay.js';

class FakeElement {
    style = {};
    dataset = {};
    children = [];
    attributes = {};
    textContent = '';

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    append(child) {
        this.children.push(child);
    }

    remove() {
        this.removed = true;
    }
}

class FakeCanvas extends FakeElement {
    fillCalls = [];
    context = {
        fillStyle: '#000',
        fillRect: (...args) => this.fillCalls.push({
            color: this.context.fillStyle,
            rect: args
        })
    };

    getContext() {
        return this.context;
    }
}

const fakeDocument = {
    createElement(tagName) {
        return tagName === 'canvas' ? new FakeCanvas() : new FakeElement();
    }
};

test('increases marker size over the previous rule and keeps sizing orientation-independent', () => {
    assert.equal(DEFAULT_ARUCO_MARKER_MIN_SIZE_FRACTION, 0.2);
    assert.equal(getArucoMarkerDisplaySize(360, 800), 269);
    assert.equal(getArucoMarkerDisplaySize(800, 360), 269);
    assert.equal(getArucoMarkerDisplaySize(800, 360, 0.18), 269);
    assert.equal(getArucoMarkerDisplaySize(800, 360, 0.22), 269);
    assert.ok(getArucoMarkerDisplaySize(360, 800) > Math.min(360 * 0.32, 224));
    assert.equal(getArucoMarkerDisplaySize(0, 360), null);
    assert.equal(getArucoMarkerDisplaySize(360, 800, 0.25), null);
});

test('renders the existing assigned marker encoding with a white one-module quiet zone', () => {
    const markerId = computeMarkerIdForDevice('stable-phone');
    const canvas = new FakeCanvas();
    assert.equal(renderArucoMarker(canvas, markerId, {
        moduleSize: 56,
        quietZoneModules: 1
    }), true);
    assert.equal(canvas.width, 504);
    assert.equal(canvas.height, 504);
    assert.equal(canvas.fillCalls[0].color, '#fff');
    assert.deepEqual(createArucoMarkerPattern(markerId).map((row) => row.length),
        [7, 7, 7, 7, 7, 7, 7]);
    assert.equal(canvas.fillCalls.length, 50);
    assert.ok(canvas.fillCalls.slice(1).some(({ color }) => color === '#000'));
    assert.ok(canvas.fillCalls.slice(1).some(({ color }) => color === '#fff'));
});

test('centres each unique assigned marker and keeps the overlay independent above video', () => {
    const deviceIds = ['stable-phone-a', 'stable-phone-b'];
    const assignments = createPersistentMarkerAssignments(deviceIds);
    const first = createDisplayMarkerOverlay({
        document: fakeDocument,
        deviceId: deviceIds[0],
        markerId: assignments[deviceIds[0]]
    });
    const second = createDisplayMarkerOverlay({
        document: fakeDocument,
        deviceId: deviceIds[1],
        markerId: assignments[deviceIds[1]]
    });

    assert.notEqual(first.dataset.markerId, second.dataset.markerId);
    assert.equal(first.dataset.markerId, String(assignments[deviceIds[0]]));
    assert.equal(second.dataset.markerId, String(assignments[deviceIds[1]]));
    assert.equal(first.attributes['aria-label'], `Device marker ${assignments[deviceIds[0]]}`);
    assert.equal(first.style.position, 'absolute');
    assert.equal(first.style.top, '50%');
    assert.equal(first.style.left, '50%');
    assert.equal(first.style.transform, 'translate(-50%, -50%)');
    assert.equal(first.style.zIndex, '25');
    assert.equal(first.style.pointerEvents, 'none');
    assert.equal(first.children[0].className, 'parallax-vision-marker-grid');
    assert.equal(first.children[0].style.imageRendering, 'pixelated');
    assert.equal(first.children[1].textContent, `ID ${assignments[deviceIds[0]]}`);

    assert.equal(resizeDisplayMarkerOverlay(first, 360, 800), true);
    assert.equal(first.style.width, '269px');
    assert.equal(first.style.height, '269px');
    assert.equal(resizeDisplayMarkerOverlay(first, 800, 360), true);
    assert.equal(first.style.width, '269px');
    assert.equal(first.style.height, '269px');
    assert.equal(resizeDisplayMarkerOverlay(first, 360, 800, 0.18), true);
    assert.equal(first.style.width, '269px');
    assert.equal(resizeDisplayMarkerOverlay(first, 0, 800), false);

    const reconnected = createDisplayMarkerOverlay({
        document: fakeDocument,
        deviceId: deviceIds[0]
    });
    assert.equal(reconnected.dataset.markerId, String(computeMarkerIdForDevice(deviceIds[0])));
});

test('keeps assigned IDs and overlay content valid when the viewport is resized', () => {
    const assignments = createPersistentMarkerAssignments(['phone-one', 'phone-two']);
    const overlay = createDisplayMarkerOverlay({
        document: fakeDocument,
        deviceId: 'phone-one',
        markerId: assignments['phone-one']
    });
    const markerId = overlay.dataset.markerId;
    for (const [width, height] of [[360, 800], [800, 360], [600, 600]]) {
        assert.equal(resizeDisplayMarkerOverlay(overlay, width, height), true);
        assert.equal(overlay.dataset.markerId, markerId);
        assert.equal(overlay.children[0].width, 504);
        assert.equal(overlay.children[0].height, 504);
    }
});
