import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createPlaybackTimeline,
    expectedPlaybackPosition,
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
    assert.equal(expectedPlaybackPosition(timeline, 13_000), 7);
    assert.equal(getPlaybackPosition({ ...playback, status: 'paused' }, 99_000), 4);
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

test('playlist indexing supports bounded playback and looping', () => {
    const playlist = { loop: true, items: ['a', 'b', 'c'] };
    assert.deepEqual(getPlaylistItem(playlist, 4), { item: 'b', index: 1 });
    assert.deepEqual(getPlaylistItem({ ...playlist, loop: false }, 4), {
        item: 'c',
        index: 2
    });
    assert.equal(getPlaylistItem({ items: [] }, 0), null);
});
