import assert from 'node:assert/strict';
import test from 'node:test';
import { synchronizePreviewVideo } from './preview-sync.js';

function createVideo({
    currentTime = 0,
    readyState = 4,
    paused = true
} = {}) {
    return {
        currentTime,
        readyState,
        paused,
        playCalls: 0,
        pauseCalls: 0,
        play() {
            this.playCalls += 1;
            this.paused = false;
            return Promise.resolve();
        },
        pause() {
            this.pauseCalls += 1;
            this.paused = true;
        }
    };
}

test('aligns the current and full preview videos to one scheduled playback timeline', async () => {
    const currentDisplay = createVideo();
    const fullPreview = createVideo();
    const timeline = {
        status: 'playing',
        positionSeconds: 4,
        startedAt: 10_000
    };

    const currentResult = synchronizePreviewVideo(currentDisplay, timeline, 12_000);
    const fullResult = synchronizePreviewVideo(fullPreview, timeline, 12_000);
    await Promise.all([currentResult, fullResult]);

    assert.equal(currentDisplay.currentTime, 6);
    assert.equal(fullPreview.currentTime, 6);
    assert.equal(currentDisplay.playCalls, 1);
    assert.equal(fullPreview.playCalls, 1);
});

test('keeps preview videos paused before a scheduled start and while paused or stopped', () => {
    const video = createVideo({ currentTime: 8, paused: false });
    const scheduled = synchronizePreviewVideo(video, {
        status: 'playing',
        positionSeconds: 3,
        startedAt: 20_000
    }, 19_000);
    assert.equal(scheduled, true);
    assert.equal(video.currentTime, 3);
    assert.equal(video.pauseCalls, 1);

    synchronizePreviewVideo(video, {
        status: 'paused',
        positionSeconds: 7,
        startedAt: null
    }, 20_000);
    assert.equal(video.currentTime, 7);
    assert.equal(video.paused, true);

    synchronizePreviewVideo(video, {
        status: 'stopped',
        positionSeconds: 0,
        startedAt: null
    }, 20_000);
    assert.equal(video.currentTime, 0);
    assert.equal(video.paused, true);
});

test('waits for media metadata and current data before seeking or starting playback', () => {
    const noMetadata = createVideo({ readyState: 0, currentTime: 5 });
    assert.equal(synchronizePreviewVideo(noMetadata, {
        status: 'playing',
        positionSeconds: 2,
        startedAt: 1_000
    }, 2_000), false);
    assert.equal(noMetadata.currentTime, 5);

    const buffering = createVideo({ readyState: 1, currentTime: 0 });
    assert.equal(synchronizePreviewVideo(buffering, {
        status: 'playing',
        positionSeconds: 2,
        startedAt: 1_000
    }, 2_000), false);
    assert.equal(buffering.currentTime, 3);
    assert.equal(buffering.playCalls, 0);
    assert.equal(buffering.paused, true);
});

test('does not continually seek when preview drift is within the correction threshold', () => {
    const video = createVideo({ currentTime: 6.1, paused: false });
    synchronizePreviewVideo(video, {
        status: 'playing',
        positionSeconds: 4,
        startedAt: 10_000
    }, 12_000);
    assert.equal(video.currentTime, 6.1);
    assert.equal(video.playCalls, 0);
    assert.equal(video.pauseCalls, 0);
});
