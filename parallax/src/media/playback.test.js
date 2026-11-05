import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createPlaybackTimeline,
    correctPlaybackDrift,
    expectedPlaybackPosition,
    getDriftCorrection,
    getPlaybackDrift,
    getPlaylistItem,
    getPlaybackPosition,
    shouldCorrectPlaybackDrift
} from './playback.js';

test('playback timeline derives one authoritative position for all devices', () => {
    const playback = {
        status: 'playing',
        mediaId: 'video-1',
        positionSeconds: 4,
        startedAt: 10_000,
        timelineId: 'timeline-1'
    };
    const timeline = createPlaybackTimeline(playback, 12_500);
    assert.equal(timeline.positionSeconds, 4);
    assert.equal(timeline.volume, 0);
    assert.equal(expectedPlaybackPosition(timeline, 13_000), 7);
    assert.equal(getPlaybackPosition({ ...playback, status: 'paused' }, 99_000), 4);
});

test('playback timeline clamps volume and defaults legacy states to muted', () => {
    assert.equal(createPlaybackTimeline({ status: 'stopped', volume: 0.6 }).volume, 0.6);
    assert.equal(createPlaybackTimeline({ status: 'stopped', volume: 2 }).volume, 1);
    assert.equal(createPlaybackTimeline({ status: 'stopped', volume: -1 }).volume, 0);
    assert.equal(createPlaybackTimeline({ status: 'stopped' }).volume, 0);
});

test('playback drift correction ignores buffering-scale drift and corrects significant drift', () => {
    const timeline = {
        status: 'playing',
        positionSeconds: 0,
        startedAt: 10_000
    };
    assert.ok(Math.abs(getPlaybackDrift(2.8, timeline, 13_000) - 0.2) < 0.000001);
    assert.equal(shouldCorrectPlaybackDrift(2.8, timeline, 13_000), false);
    assert.equal(shouldCorrectPlaybackDrift(2.5, timeline, 13_000), true);
});

test('playback correction uses configurable drift bands and avoids repeated seeking', () => {
    assert.equal(getDriftCorrection(0.099), 'none');
    assert.equal(getDriftCorrection(0.1), 'rate');
    assert.equal(getDriftCorrection(-0.3), 'rate');
    assert.equal(getDriftCorrection(0.301), 'seek');
    assert.equal(getDriftCorrection(0.25, {
        rateThresholdSeconds: 0.2,
        seekThresholdSeconds: 0.5
    }), 'rate');

    const video = { currentTime: 1, readyState: 4, playbackRate: 1, seeking: false };
    const rate = correctPlaybackDrift(video, 1.2, { now: 10_000 });
    assert.equal(rate.action, 'rate');
    assert.equal(video.playbackRate, 1.05);

    const seek = correctPlaybackDrift(video, 2, { now: 10_000 });
    assert.equal(seek.action, 'seek');
    assert.equal(video.currentTime, 2);
    assert.equal(video.playbackRate, 1);
    assert.equal(correctPlaybackDrift(video, 0, {
        now: 10_500,
        lastSeekAt: seek.lastSeekAt
    }).action, 'none');
    assert.equal(video.currentTime, 2);
});

test('playlist indexing supports bounded playback and looping', () => {
    const playlist = { loop: true, items: ['a', 'b', 'c'] };
    assert.deepEqual(getPlaylistItem(playlist, 4), { item: 'b', index: 1 });
    assert.deepEqual(getPlaylistItem({ ...playlist, loop: false }, 4), {
        item: 'c',
        index: 2
    });
    assert.equal(getPlaylistItem({ items: [] }, 0), null);
});
