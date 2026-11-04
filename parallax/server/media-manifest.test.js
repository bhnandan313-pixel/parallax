import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    createDefaultMediaManifest,
    loadMediaManifest,
    validatePlaylist,
    validateSchedule,
    writeMediaManifest
} from './media-manifest.js';

test('media manifest persists library, playlists, schedules and playback atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parallax-media-manifest-'));
    const filePath = join(directory, 'media.json');
    try {
        const manifest = createDefaultMediaManifest();
        const now = new Date().toISOString();
        manifest.playlists.push({
            id: 'playlist-1',
            name: 'Images',
            mediaType: 'image',
            items: [{ mediaId: 'media-1', durationSeconds: 8 }],
            loop: true,
            shuffle: false,
            transition: 'fade',
            createdAt: now,
            updatedAt: now
        });
        manifest.schedules.push({
            id: 'schedule-1',
            targetType: 'playlist',
            targetId: 'playlist-1',
            startAt: '2026-11-04T10:00:00.000Z',
            endAt: '2026-11-04T11:00:00.000Z',
            timeZone: 'Asia/Kolkata',
            enabled: true,
            createdAt: now
        });
        assert.equal(validatePlaylist(manifest.playlists[0]), true);
        assert.equal(validateSchedule(manifest.schedules[0]), true);
        await writeMediaManifest(filePath, manifest);
        assert.deepEqual(await loadMediaManifest(filePath), manifest);
        assert.match(await readFile(filePath, 'utf8'), /"version": 1/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('schedule rejects invalid time zones and nonpositive intervals', () => {
    const schedule = {
        id: 'schedule-1',
        targetType: 'media',
        targetId: 'media-1',
        startAt: '2026-11-04T10:00:00.000Z',
        endAt: '2026-11-04T11:00:00.000Z',
        timeZone: 'Asia/Kolkata',
        enabled: true,
        createdAt: '2026-11-04T09:00:00.000Z'
    };
    assert.equal(validateSchedule(schedule), true);
    assert.equal(validateSchedule({ ...schedule, timeZone: 'Invalid/Zone' }), false);
    assert.equal(validateSchedule({ ...schedule, endAt: schedule.startAt }), false);
});

test('migrates existing media manifests to retain upload history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parallax-media-history-'));
    const filePath = join(directory, 'media.json');
    const manifest = createDefaultMediaManifest();
    delete manifest.uploadHistory;
    manifest.media.push({
        id: 'media-1',
        filename: 'existing.mp4',
        mediaType: 'video',
        mimeType: 'video/mp4',
        url: 'http://localhost/uploads/existing.mp4',
        size: 128,
        uploadedAt: '2026-11-04T10:00:00.000Z',
        durationSeconds: 30
    });
    try {
        await writeFile(filePath, JSON.stringify(manifest), 'utf8');
        const migrated = await loadMediaManifest(filePath);
        assert.deepEqual(migrated.uploadHistory, [{
            id: 'media-1',
            filename: 'existing.mp4',
            mediaType: 'video',
            size: 128,
            uploadedAt: '2026-11-04T10:00:00.000Z',
            uploadStatus: 'uploaded'
        }]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
