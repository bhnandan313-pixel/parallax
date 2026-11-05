import assert from 'node:assert/strict';
import test from 'node:test';
import { isFullscreen, isFullscreenSupported, toggleFullscreen } from './fullscreen.js';

test('detects Fullscreen API support and toggles only on explicit calls', async () => {
    const element = {
        requestFullscreenCalls: 0,
        requestFullscreen() {
            this.requestFullscreenCalls += 1;
            documentObject.fullscreenElement = this;
        }
    };
    const documentObject = {
        fullscreenElement: null,
        exitFullscreenCalls: 0,
        exitFullscreen() {
            this.exitFullscreenCalls += 1;
            this.fullscreenElement = null;
        }
    };
    assert.equal(isFullscreenSupported(element, documentObject), true);
    assert.equal(await toggleFullscreen(element, documentObject), true);
    assert.equal(isFullscreen(element, documentObject), true);
    assert.equal(await toggleFullscreen(element, documentObject), true);
    assert.equal(documentObject.exitFullscreenCalls, 1);
    assert.equal(isFullscreenSupported({}, documentObject), false);
});

test('reports unsupported fullscreen without attempting a request', async () => {
    assert.equal(await toggleFullscreen({}, {}), false);
});
