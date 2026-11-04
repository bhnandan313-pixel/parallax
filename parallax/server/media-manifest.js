import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createDefaultMediaManifest() {
    return {
        version: 1,
        media: [],
        uploadHistory: [],
        playlists: [],
        schedules: [],
        activeScheduleId: null,
        currentContent: {
            contentType: 'image',
            imageUrl: '/panorama.jpg',
            updateId: 'default-panorama'
        },
        playback: {
            status: 'stopped',
            mediaId: null,
            positionSeconds: 0,
            startedAt: null,
            timelineId: null,
            playlistId: null,
            playlistIndex: 0,
            nextPlaylistIndex: null,
            transition: 'none'
        }
    };
}

export function validateMediaItem(item) {
    return Boolean(item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128
        && typeof item.filename === 'string' && isSafeFilename(item.filename)
        && ['image', 'video'].includes(item.mediaType)
        && typeof item.mimeType === 'string'
        && typeof item.url === 'string' && item.url.length <= 2048
        && Number.isInteger(item.size) && item.size > 0
        && typeof item.uploadedAt === 'string' && Number.isFinite(Date.parse(item.uploadedAt))
        && (item.durationSeconds === null
            || (Number.isFinite(item.durationSeconds)
                && item.durationSeconds > 0 && item.durationSeconds <= 86_400)));
}

export function validatePlaylist(playlist) {
    return Boolean(playlist && typeof playlist === 'object' && !Array.isArray(playlist)
        && typeof playlist.id === 'string' && playlist.id.length > 0 && playlist.id.length <= 128
        && typeof playlist.name === 'string' && playlist.name.trim().length > 0
        && playlist.name.length <= 64
        && ['image', 'video'].includes(playlist.mediaType)
        && Array.isArray(playlist.items) && playlist.items.length <= 1000
        && playlist.items.every((item) => item && typeof item.mediaId === 'string'
            && item.mediaId.length <= 128
            && (item.durationSeconds === null || (Number.isFinite(item.durationSeconds)
                && item.durationSeconds >= 1 && item.durationSeconds <= 86_400)))
        && typeof playlist.loop === 'boolean'
        && typeof playlist.shuffle === 'boolean'
        && ['none', 'fade', 'slide-left', 'slide-right'].includes(playlist.transition)
        && typeof playlist.createdAt === 'string' && Number.isFinite(Date.parse(playlist.createdAt))
        && typeof playlist.updatedAt === 'string' && Number.isFinite(Date.parse(playlist.updatedAt)));
}

export function validateSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)
        || typeof schedule.id !== 'string' || schedule.id.length > 128
        || !['media', 'playlist'].includes(schedule.targetType)
        || typeof schedule.targetId !== 'string' || schedule.targetId.length > 128
        || typeof schedule.startAt !== 'string' || !Number.isFinite(Date.parse(schedule.startAt))
        || typeof schedule.endAt !== 'string' || !Number.isFinite(Date.parse(schedule.endAt))
        || Date.parse(schedule.endAt) <= Date.parse(schedule.startAt)
        || typeof schedule.timeZone !== 'string' || schedule.timeZone.length > 64
        || typeof schedule.enabled !== 'boolean'
        || typeof schedule.createdAt !== 'string' || !Number.isFinite(Date.parse(schedule.createdAt))) {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone });
        return true;
    } catch {
        return false;
    }
}

export async function loadMediaManifest(filePath) {
    await mkdir(dirname(filePath), { recursive: true });
    let raw;
    try {
        raw = await readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        const defaults = createDefaultMediaManifest();
        await writeMediaManifest(filePath, defaults);
        return defaults;
    }

    let manifest;
    try {
        manifest = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Media manifest is not valid JSON: ${error.message}`, { cause: error });
    }
    if (!isValidMediaManifest(manifest)) {
        throw new Error('Media manifest has an unsupported or invalid structure');
    }
    if (!Array.isArray(manifest.uploadHistory)) {
        manifest.uploadHistory = manifest.media.map((item) => ({
            id: item.id,
            filename: item.filename,
            mediaType: item.mediaType,
            size: item.size,
            uploadedAt: item.uploadedAt,
            uploadStatus: 'uploaded'
        }));
    }
    if (!manifest.uploadHistory.every(validateUploadHistoryEntry)) {
        throw new Error('Media manifest has an unsupported or invalid upload history');
    }
    return manifest;
}

export async function writeMediaManifest(filePath, manifest) {
    if (!isValidMediaManifest(manifest)) {
        throw new TypeError('Refusing to persist an invalid media manifest');
    }
    const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        for (let attempt = 0; ; attempt += 1) {
            try {
                await rename(temporaryFile, filePath);
                break;
            } catch (error) {
                if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
            }
        }
    } catch (error) {
        await unlink(temporaryFile).catch((cleanupError) => {
            if (cleanupError.code !== 'ENOENT') {
                console.error('Unable to clean up temporary media manifest:', cleanupError);
            }
        });
        throw error;
    }
}

function isValidMediaManifest(manifest) {
    return Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        && manifest.version === 1
        && Array.isArray(manifest.media) && manifest.media.every(validateMediaItem)
        && (manifest.uploadHistory === undefined
            || (Array.isArray(manifest.uploadHistory)
                && manifest.uploadHistory.every(validateUploadHistoryEntry)))
        && Array.isArray(manifest.playlists) && manifest.playlists.every(validatePlaylist)
        && Array.isArray(manifest.schedules) && manifest.schedules.every(validateSchedule)
        && (manifest.activeScheduleId === null
            || typeof manifest.activeScheduleId === 'string')
        && manifest.currentContent && typeof manifest.currentContent === 'object'
        && !Array.isArray(manifest.currentContent)
        && ['image', 'video'].includes(manifest.currentContent.contentType)
        && typeof manifest.currentContent.updateId === 'string'
        && manifest.playback && typeof manifest.playback === 'object'
        && ['playing', 'paused', 'stopped'].includes(manifest.playback.status)
        && Number.isFinite(manifest.playback.positionSeconds)
        && manifest.playback.positionSeconds >= 0
        && (manifest.playback.startedAt === null
            || Number.isFinite(manifest.playback.startedAt))
        && (manifest.playback.mediaId === null
            || typeof manifest.playback.mediaId === 'string')
        && (manifest.playback.playlistId === null
            || typeof manifest.playback.playlistId === 'string')
        && (manifest.playback.itemDurationSeconds === undefined
            || (Number.isFinite(manifest.playback.itemDurationSeconds)
                && manifest.playback.itemDurationSeconds >= 1
                && manifest.playback.itemDurationSeconds <= 86_400))
        && Number.isInteger(manifest.playback.playlistIndex)
        && (manifest.playback.nextPlaylistIndex === undefined
            || manifest.playback.nextPlaylistIndex === null
            || (Number.isInteger(manifest.playback.nextPlaylistIndex)
                && manifest.playback.nextPlaylistIndex >= 0
                && manifest.playback.nextPlaylistIndex < 1000))
        && ['none', 'fade', 'slide-left', 'slide-right'].includes(manifest.playback.transition));
}

function validateUploadHistoryEntry(entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
        && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 128
        && typeof entry.filename === 'string' && isSafeFilename(entry.filename)
        && ['image', 'video'].includes(entry.mediaType)
        && Number.isInteger(entry.size) && entry.size > 0
        && typeof entry.uploadedAt === 'string' && Number.isFinite(Date.parse(entry.uploadedAt))
        && entry.uploadStatus === 'uploaded');
}

function isSafeFilename(filename) {
    return filename.length <= 255
        && !filename.includes('/')
        && !filename.includes('\\')
        && !filename.includes('\0')
        && filename !== '.'
        && filename !== '..';
}
