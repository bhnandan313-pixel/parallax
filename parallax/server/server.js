import express from 'express';
import http from 'http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { Server } from 'socket.io';
import {
    createDefaultLayout,
    validateDisplayLayout
} from '../src/display/geometry.js';
import {
    createPlaybackTimeline,
    getPlaybackPosition,
    PLAYBACK_START_DELAY_MS,
    TRANSITIONS
} from '../src/media/playback.js';
import {
    createAudioSettings,
    validateAudioSettings
} from '../src/media/audio.js';
import {
    createDefaultMediaManifest,
    loadMediaManifest,
    validateMediaItem,
    validatePlaylist,
    validateSchedule,
    writeMediaManifest
} from './media-manifest.js';
import {
    associateMarkersWithDevices,
    createVisionTrackerState,
    createPersistentMarkerAssignments,
    updateVisionTracker
} from '../src/vision/marker-detection.js';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_PRESET_NAME_LENGTH = 32;
const MIN_SCREEN_COUNT = 2;
const MAX_SCREEN_COUNT = 12;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PRESET_NAME = 'Default';
const DISPLAY_STATES = new Set(['waiting', 'loading', 'ready', 'error']);
const IMAGE_FORMATS = new Map([
    ['image/jpeg', { extension: 'jpg', sharpFormat: 'jpeg' }],
    ['image/png', { extension: 'png', sharpFormat: 'png' }],
    ['image/webp', { extension: 'webp', sharpFormat: 'webp' }]
]);
const VIDEO_FORMATS = new Map([
    ['video/mp4', { extension: 'mp4' }]
]);

function isPrivateIPv4(address) {
    return /^10\./.test(address)
        || /^192\.168\./.test(address)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function isLoopbackHostname(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

function isLocalHostname(hostname) {
    return isLoopbackHostname(hostname)
        || Object.values(networkInterfaces()).some((addresses) =>
            (addresses ?? []).some((entry) => entry.address === hostname));
}

function getForwardedHostname(request) {
    const forwardedHost = request.get('x-forwarded-host');
    if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
        return forwardedHost.split(',')[0].trim().split(':')[0];
    }
    return request.hostname;
}

function getForwardedProtocol(request) {
    const forwardedProto = request.get('x-forwarded-proto');
    if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
        const protocol = forwardedProto.split(',')[0].trim().toLowerCase();
        if (['http', 'https'].includes(protocol)) {
            return protocol;
        }
    }
    return request.protocol;
}

function isAllowedBrowserOrigin(origin, requestHostname) {
    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch {
        return false;
    }
    if (!['http:', 'https:'].includes(originUrl.protocol)) {
        return false;
    }

    const isTryCloudflareHostname = (hostname) =>
        typeof hostname === 'string' && /(^|\.)trycloudflare\.com$/i.test(hostname);

    if (isTryCloudflareHostname(originUrl.hostname)) {
        return true;
    }

    const port = Number(originUrl.port);
    const isVitePort = originUrl.port === '' || (port >= 5173 && port <= 5199);
    return isVitePort && (originUrl.hostname === requestHostname
        || (originUrl.port !== ''
            && isLocalHostname(originUrl.hostname)
            && isLocalHostname(requestHostname)));
}

function getPrivateLanAddress() {
    const interfaces = Object.entries(networkInterfaces());
    const isVirtualInterface = (name) =>
        /virtual|vmware|virtualbox|docker|wsl|hyper-v|vethernet|loopback|bluetooth/i.test(name);
    const candidates = interfaces
        .filter(([name]) => !isVirtualInterface(name))
        .sort(([left], [right]) => {
            const isWifi = (name) => /wi-?fi|wireless|wlan/i.test(name);
            return Number(isWifi(right)) - Number(isWifi(left));
        });

    for (const [, addresses] of candidates) {
        const address = addresses?.find((entry) =>
            entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address));
        if (address) {
            return address.address;
        }
    }

    return null;
}

export function createParallaxServer({
    reservationMs = 30_000,
    pairingTtlMs = PAIRING_TTL_MS,
    pairingInterfaces = null,
    publicBaseUrl = process.env.PARALLAX_PUBLIC_URL,
    uploadDirectory = fileURLToPath(new URL('./uploads/', import.meta.url)),
    calibrationFile = fileURLToPath(new URL('./data/calibration.json', import.meta.url)),
    mediaManifestFile = fileURLToPath(new URL('./data/media.json', import.meta.url))
} = {}) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        }
    });
    const devices = new Map();
    const controllers = new Set();
    const controllerUploadTokens = new Map();
    const pairingSessions = new Map();
    const pairingTimers = new Map();
    const visionSessions = new Map();
    const deviceRoom = 'parallax:devices';
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: MAX_UPLOAD_BYTES,
            files: 1,
            fields: 0,
            parts: 1
        }
    });
    const mediaUpload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: MAX_VIDEO_UPLOAD_BYTES,
            files: 1,
            fields: 1,
            parts: 2
        }
    });
    let currentContent = {
        contentType: 'image',
        imageUrl: '/panorama.jpg',
        updateId: 'default-panorama'
    };
    let mediaManifest = createDefaultMediaManifest();
    let playbackState = { ...mediaManifest.playback };
    let audioSettings = createAudioSettings(mediaManifest.audioSettings);
    let mediaUpdateQueue = Promise.resolve();
    let scheduleTimer = null;
    let contentUpdatedAt = null;
    let alignmentUpdatedAt = null;
    let calibrationEnabled = false;
    let totalScreens = 2;
    let assignmentMode = 'automatic';
    const alignmentSettings = createDefaultAlignmentSettings(MAX_SCREEN_COUNT);
    let calibrationPresets = [];
    let displayLayout = createDefaultLayout(MIN_SCREEN_COUNT);
    let layoutPresets = [];
    let persistedAssignments = {};
    let persistedMarkerAssignments = {};
    let deviceNames = {};
    const deviceActivity = new Map();
    let alignmentRevision = 0;
    let settingsUpdateQueue = Promise.resolve();

    function getSettingsSnapshot() {
        const snapshot = {
            calibrationEnabled,
            totalScreens,
            assignmentMode,
            assignments: { ...persistedAssignments },
            markerAssignments: { ...persistedMarkerAssignments },
            screens: getStoredAlignmentSnapshot(),
            layout: cloneDisplayLayout(displayLayout),
            layoutPresets: layoutPresets.map((preset) => ({
                name: preset.name,
                totalScreens: preset.totalScreens,
                layout: cloneDisplayLayout(preset.layout)
            })),
            presets: calibrationPresets.map(({ name, screens, screenCount }) => ({
                name,
                screenCount,
                screens: cloneAlignmentSettings(screens)
            }))
        };
        if (Object.keys(deviceNames).length > 0) {
            snapshot.deviceNames = { ...deviceNames };
        }
        return snapshot;
    }

    async function writeSettings(settings) {
        const temporaryFile = `${calibrationFile}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
            for (let attempt = 0; ; attempt += 1) {
                try {
                    await rename(temporaryFile, calibrationFile);
                    break;
                } catch (error) {
                    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) {
                        throw error;
                    }
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1)));
                }
            }
        } catch (error) {
            await unlink(temporaryFile).catch((cleanupError) => {
                if (cleanupError.code !== 'ENOENT') {
                    console.error('Unable to clean up temporary calibration settings:', cleanupError);
                }
            });
            throw error;
        }
    }

    async function loadSettings() {
        await mkdir(dirname(calibrationFile), { recursive: true });

        let contents;
        try {
            contents = await readFile(calibrationFile, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }

            const defaults = createDefaultSettings();
            await writeSettings(defaults);
            return defaults;
        }

        let settings;
        let shouldRepair = false;
        try {
            settings = JSON.parse(contents);
        } catch (error) {
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
            console.warn(`Calibration settings are corrupted; restoring defaults from ${calibrationFile}`);
            settings = createDefaultSettings();
            shouldRepair = true;
        }

        if (!isValidStoredSettings(settings)) {
            console.warn(`Calibration settings are invalid; restoring defaults from ${calibrationFile}`);
            settings = createDefaultSettings();
            shouldRepair = true;
        } else {
            totalScreens = MIN_SCREEN_COUNT;
            const configuredScreenCount = settings.totalScreens ?? MIN_SCREEN_COUNT;
            if (isScreenCount(configuredScreenCount)) {
                totalScreens = configuredScreenCount;
            } else if (settings.totalScreens !== undefined) {
                shouldRepair = true;
            }
            assignmentMode = ['automatic', 'manual'].includes(settings.assignmentMode)
                ? settings.assignmentMode
                : 'automatic';
            if (settings.assignmentMode !== undefined
                && !['automatic', 'manual'].includes(settings.assignmentMode)) {
                shouldRepair = true;
            }

            const storedScreens = {};
            for (let screen = 1; screen <= MAX_SCREEN_COUNT; screen += 1) {
                const value = settings.screens[screen];
                if (value !== undefined && validateStoredAlignment(value)) {
                    storedScreens[screen] = { ...value };
                } else {
                    storedScreens[screen] = createDefaultAlignment();
                    if (value !== undefined) {
                        shouldRepair = true;
                    }
                }
            }

            const assignments = settings.assignments && typeof settings.assignments === 'object'
                && !Array.isArray(settings.assignments)
                ? settings.assignments
                : {};
            persistedAssignments = {};
            const assignedScreens = new Set();
            for (const [deviceId, screen] of Object.entries(assignments)) {
                if (typeof deviceId === 'string' && deviceId.length > 0 && deviceId.length <= 128
                    && (screen === null || (isScreenNumber(screen) && screen <= totalScreens))
                    && (screen === null || !assignedScreens.has(screen))) {
                    persistedAssignments[deviceId] = screen;
                    if (screen !== null) {
                        assignedScreens.add(screen);
                    }
                } else {
                    shouldRepair = true;
                }
            }
            if (settings.assignments !== undefined
                && (typeof settings.assignments !== 'object' || Array.isArray(settings.assignments))) {
                shouldRepair = true;
            }

            const storedMarkerAssignments = settings.markerAssignments && typeof settings.markerAssignments === 'object'
                && !Array.isArray(settings.markerAssignments)
                ? settings.markerAssignments
                : {};
            try {
                persistedMarkerAssignments = createPersistentMarkerAssignments(
                    Object.keys(persistedAssignments),
                    storedMarkerAssignments
                );
            } catch (error) {
                console.error(`Unable to restore marker assignments: ${error.message}`);
                throw error;
            }

            const storedDeviceNames = settings.deviceNames && typeof settings.deviceNames === 'object'
                && !Array.isArray(settings.deviceNames)
                ? settings.deviceNames
                : {};
            deviceNames = {};
            for (const [deviceId, name] of Object.entries(storedDeviceNames)) {
                if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
                    shouldRepair = true;
                    continue;
                }
                const normalized = normalizeDeviceName(name);
                if (!normalized) {
                    shouldRepair = true;
                    continue;
                }
                deviceNames[deviceId] = normalized;
            }
            if (settings.deviceNames !== undefined
                && (typeof settings.deviceNames !== 'object' || Array.isArray(settings.deviceNames))) {
                shouldRepair = true;
            }

            const presets = Array.isArray(settings.presets) ? settings.presets : [];
            const validPresets = [];
            const names = new Set();
            for (const preset of presets) {
                if (!isValidStoredPreset(preset)
                    || preset.name.toLowerCase() === DEFAULT_PRESET_NAME.toLowerCase()
                    || names.has(preset.name.toLowerCase())) {
                    shouldRepair = true;
                    continue;
                }
                names.add(preset.name.toLowerCase());
                validPresets.push(normalizeStoredPreset(preset));
            }
            if (settings.presets !== undefined && !Array.isArray(settings.presets)) {
                shouldRepair = true;
            }
            displayLayout = validateDisplayLayout(settings.layout, totalScreens)
                ? cloneDisplayLayout(settings.layout)
                : createDefaultLayout(totalScreens);
            if (settings.layout !== undefined
                && !validateDisplayLayout(settings.layout, totalScreens)) {
                shouldRepair = true;
            }
            if (settings.layout === undefined || settings.layoutPresets === undefined) {
                shouldRepair = true;
            }
            const storedLayoutPresets = Array.isArray(settings.layoutPresets)
                ? settings.layoutPresets
                : [];
            const validLayoutPresets = [];
            const layoutNames = new Set();
            for (const preset of storedLayoutPresets) {
                if (!preset || typeof preset !== 'object'
                    || validatePresetName(preset.name) !== preset.name
                    || !isScreenCount(preset.totalScreens)
                    || !validateDisplayLayout(preset.layout, preset.totalScreens)
                    || layoutNames.has(preset.name.toLowerCase())) {
                    shouldRepair = true;
                    continue;
                }
                layoutNames.add(preset.name.toLowerCase());
                validLayoutPresets.push({
                    name: preset.name,
                    totalScreens: preset.totalScreens,
                    layout: cloneDisplayLayout(preset.layout)
                });
            }
            if (settings.layoutPresets !== undefined && !Array.isArray(settings.layoutPresets)) {
                shouldRepair = true;
            }
            layoutPresets = validLayoutPresets;
            settings = {
                calibrationEnabled: settings.calibrationEnabled,
                totalScreens,
                assignmentMode,
                assignments: { ...persistedAssignments },
                markerAssignments: { ...persistedMarkerAssignments },
                screens: storedScreens,
                presets: validPresets,
                layout: cloneDisplayLayout(displayLayout),
                layoutPresets: layoutPresets.map((preset) => ({
                    name: preset.name,
                    totalScreens: preset.totalScreens,
                    layout: cloneDisplayLayout(preset.layout)
                }))
            };
            if (Object.keys(deviceNames).length > 0) {
                settings.deviceNames = { ...deviceNames };
            }
        }

        if (shouldRepair) {
            await writeSettings(settings);
        }

        return settings;
    }

    const ready = Promise.all([
        loadSettings(),
        loadMediaManifest(mediaManifestFile)
    ]).then(([settings, loadedMediaManifest]) => {
        calibrationEnabled = settings.calibrationEnabled;
        alignmentSettings[1] = { ...settings.screens[1] };
        for (let screen = 2; screen <= MAX_SCREEN_COUNT; screen += 1) {
            alignmentSettings[screen] = { ...settings.screens[screen] };
        }
        calibrationPresets = settings.presets ?? [];
        displayLayout = cloneDisplayLayout(settings.layout ?? createDefaultLayout(totalScreens));
        layoutPresets = settings.layoutPresets ?? [];
        totalScreens = settings.totalScreens ?? MIN_SCREEN_COUNT;
        assignmentMode = settings.assignmentMode ?? 'automatic';
        persistedAssignments = { ...(settings.assignments ?? {}) };
        persistedMarkerAssignments = { ...(settings.markerAssignments ?? {}) };
        deviceNames = { ...(settings.deviceNames ?? {}) };
        mediaManifest = loadedMediaManifest;
        currentContent = { ...mediaManifest.currentContent };
        playbackState = { ...mediaManifest.playback };
        audioSettings = createAudioSettings(mediaManifest.audioSettings);
        for (const [id, screen] of Object.entries(persistedAssignments)) {
            devices.set(id, createDeviceRecord(id, screen));
        }
        scheduleTimer = setInterval(() => {
            runMediaScheduler();
        }, 500);
        scheduleTimer.unref?.();
        return runMediaScheduler();
    });

    function updateMediaManifest(update) {
        const operation = mediaUpdateQueue.then(async () => {
            const next = structuredClone(mediaManifest);
            update(next);
            await writeMediaManifest(mediaManifestFile, next);
            mediaManifest = next;
            currentContent = { ...next.currentContent };
            playbackState = { ...next.playback };
            audioSettings = createAudioSettings(next.audioSettings);
            return structuredClone(next);
        });
        mediaUpdateQueue = operation.catch(() => {});
        return operation;
    }

    function getMediaSnapshot() {
        const currentMediaId = playbackState.mediaId ?? null;
        const availableMediaIds = new Set(mediaManifest.media.map((item) => item.id));
        return {
            media: mediaManifest.media.map((item) => ({
                ...item,
                publishingStatus: currentMediaId === item.id ? 'published' : 'saved'
            })),
            uploadHistory: mediaManifest.uploadHistory.map((entry) => ({
                ...entry,
                publishingStatus: currentMediaId === entry.id
                    ? 'published'
                    : availableMediaIds.has(entry.id) ? 'saved' : 'deleted'
            })),
            playlists: structuredClone(mediaManifest.playlists),
            schedules: structuredClone(mediaManifest.schedules),
            currentContent: { ...currentContent },
            playback: createPlaybackTimeline(playbackState),
            audioSettings: { ...audioSettings },
            uploadLimitBytes: MAX_VIDEO_UPLOAD_BYTES
        };
    }

    function broadcastMediaSnapshot() {
        const snapshot = getMediaSnapshot();
        for (const controllerId of controllers) {
            io.sockets.sockets.get(controllerId)?.emit('media:current', snapshot);
        }
    }

    function broadcastPlayback(eventName = 'playback:sync') {
        const timeline = createPlaybackTimeline(playbackState);
        io.to(deviceRoom).emit(eventName, timeline);
        for (const controllerId of controllers) {
            io.sockets.sockets.get(controllerId)?.emit('playback:current', timeline);
        }
        return timeline;
    }

    function broadcastAudioSettings() {
        const settings = { ...audioSettings };
        io.to(deviceRoom).emit('audio:settings', settings);
        for (const controllerId of controllers) {
            io.sockets.sockets.get(controllerId)?.emit('audio:settings', settings);
        }
    }

    function findMedia(mediaId) {
        return mediaManifest.media.find((item) => item.id === mediaId) ?? null;
    }

    function getPlaylistItemDuration(playlist, index) {
        const entry = playlist?.items[index];
        if (!entry) {
            return null;
        }
        return entry.durationSeconds ?? findMedia(entry.mediaId)?.durationSeconds ?? null;
    }

    function getCurrentPlaybackDuration() {
        if (playbackState.playlistId) {
            const playlist = mediaManifest.playlists.find(
                (entry) => entry.id === playbackState.playlistId
            );
            return getPlaylistItemDuration(playlist, playbackState.playlistIndex);
        }
        return findMedia(playbackState.mediaId)?.durationSeconds ?? null;
    }

    async function publishMediaItem(item, {
        transition = 'none',
        playlistId = null,
        playlistIndex = 0,
        shouldPlay = item.mediaType === 'video'
    } = {}) {
        const transitionType = TRANSITIONS.includes(transition) ? transition : 'none';
        const updateId = randomUUID();
        const content = {
            contentType: item.mediaType,
            ...(item.mediaType === 'image' ? { imageUrl: item.url } : { videoUrl: item.url }),
            updateId,
            mediaId: item.id,
            durationSeconds: item.durationSeconds,
            transition: transitionType,
            transitionAt: Date.now() + PLAYBACK_START_DELAY_MS
        };
        const now = Date.now();
        const playlist = playlistId
            ? mediaManifest.playlists.find((entry) => entry.id === playlistId)
            : null;
        const nextPlayback = shouldPlay
            ? {
                status: 'playing',
                mediaId: item.id,
                positionSeconds: 0,
                volume: playbackState.volume ?? 0,
                startedAt: now + PLAYBACK_START_DELAY_MS,
                timelineId: randomUUID(),
                volume: playbackState.volume ?? 0,
                playlistId,
                playlistIndex,
                nextPlaylistIndex: playlist
                    ? getPlaylistIndex(playlist, playlistIndex, 1)
                    : null,
                transition: transitionType
            }
            : createStoppedPlayback(item.id, transitionType, playbackState.volume ?? 0);
        nextPlayback.playlistId = playlistId;
        nextPlayback.playlistIndex = playlistIndex;
        await updateMediaManifest((manifest) => {
            manifest.currentContent = content;
            manifest.playback = nextPlayback;
            manifest.activeScheduleId = manifest.activeScheduleId ?? null;
        });
        contentUpdatedAt = new Date().toISOString();
        io.to(deviceRoom).emit('content:update', content);
        const upcomingIndex = playbackState.nextPlaylistIndex;
        const upcomingEntry = playlist?.items[upcomingIndex];
        const upcomingMedia = upcomingEntry ? findMedia(upcomingEntry.mediaId) : null;
        if (upcomingMedia) {
            io.to(deviceRoom).emit('media:preload', {
                mediaId: upcomingMedia.id,
                mediaType: upcomingMedia.mediaType,
                mediaUrl: upcomingMedia.url
            });
        }
        broadcastPlayback();
        broadcastMediaSnapshot();
        broadcastDiagnostics();
        return content;
    }

    function validatePlaylistItems(mediaType, items) {
        return Array.isArray(items) && items.length <= 1000
            && items.every((entry) => {
                if (!entry || typeof entry !== 'object'
                    || typeof entry.mediaId !== 'string') {
                    return false;
                }
                const item = findMedia(entry.mediaId);
                return item?.mediaType === mediaType
                    && (entry.durationSeconds === undefined || entry.durationSeconds === null
                        || (Number.isFinite(entry.durationSeconds)
                            && entry.durationSeconds >= 1
                            && entry.durationSeconds <= 86_400));
            });
    }

    function getPlaylistIndex(playlist, requestedIndex, direction = 1) {
        if (!playlist?.items.length) {
            return null;
        }
        if (playlist.shuffle && playlist.items.length > 1) {
            let candidate = Math.floor(Math.random() * playlist.items.length);
            while (candidate === requestedIndex) {
                candidate = Math.floor(Math.random() * playlist.items.length);
            }
            return candidate;
        }
        const next = requestedIndex + direction;
        if (playlist.loop) {
            return (next + playlist.items.length) % playlist.items.length;
        }
        if (next < 0 || next >= playlist.items.length) {
            return null;
        }
        return next;
    }

    async function playPlaylistIndex(playlist, index) {
        const entry = playlist.items[index];
        const item = findMedia(entry.mediaId);
        if (!item) {
            throw new Error('Playlist media is no longer available');
        }
        const content = await publishMediaItem(item, {
            transition: playlist.transition,
            playlistId: playlist.id,
            playlistIndex: index,
            shouldPlay: true
        });
        if (entry.durationSeconds !== null) {
            await updateMediaManifest((manifest) => {
                manifest.playback.itemDurationSeconds = entry.durationSeconds;
            });
            playbackState = { ...mediaManifest.playback };
        }
        return content;
    }

    async function setPlaybackState(socket, request, acknowledge, action) {
        const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
        if (!controllers.has(socket.id)) {
            respond({ ok: false, message: 'Unauthorized playback request' });
            return;
        }
        if (request !== undefined
            && (!request || typeof request !== 'object' || Array.isArray(request))) {
            respond({ ok: false, message: 'Invalid playback request' });
            return;
        }
        const media = findMedia(playbackState.mediaId);
        const isPlaylist = Boolean(playbackState.playlistId);
        if (!media || (media.mediaType !== 'video' && !isPlaylist)) {
            respond({ ok: false, message: 'No playable video or playlist is published' });
            return;
        }
        const now = Date.now();
        const next = { ...playbackState, timelineId: randomUUID() };
        if (action === 'pause') {
            if (playbackState.status === 'playing') {
                next.positionSeconds = getPlaybackPosition(playbackState, now);
            }
            next.status = 'paused';
            next.startedAt = null;
        } else if (action === 'stop') {
            next.status = 'stopped';
            next.positionSeconds = 0;
            next.startedAt = null;
            next.playlistId = null;
            next.playlistIndex = 0;
            next.nextPlaylistIndex = null;
            next.itemDurationSeconds = undefined;
        } else if (action === 'seek') {
            const duration = getCurrentPlaybackDuration();
            if (!Number.isFinite(request?.positionSeconds)
                || request.positionSeconds < 0
                || (duration !== null && request.positionSeconds > duration)) {
                respond({ ok: false, message: 'Invalid playback position' });
                return;
            }
            next.positionSeconds = request.positionSeconds;
            next.startedAt = playbackState.status === 'playing'
                ? now + PLAYBACK_START_DELAY_MS
                : null;
        } else if (action === 'play' || action === 'resume') {
            if (action === 'play' && playbackState.status === 'stopped') {
                next.positionSeconds = 0;
            } else if (playbackState.status === 'playing') {
                respond({ ok: true, playback: createPlaybackTimeline(playbackState) });
                return;
            }
            next.status = 'playing';
            next.startedAt = now + PLAYBACK_START_DELAY_MS;
        }

        try {
            await updateMediaManifest((manifest) => {
                manifest.playback = next;
                manifest.activeScheduleId = action === 'stop' ? null : manifest.activeScheduleId;
            });
        } catch (error) {
            console.error(`Unable to persist playback ${action}:`, error);
            respond({ ok: false, message: 'Unable to save playback state' });
            return;
        }
        const timeline = broadcastPlayback();
        broadcastMediaSnapshot();
        respond({ ok: true, playback: timeline });
    }

    async function navigatePlaylist(socket, request, acknowledge, direction) {
        const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
        if (!controllers.has(socket.id)) {
            respond({ ok: false, message: 'Unauthorized playback request' });
            return;
        }
        const playlistId = request?.playlistId ?? playbackState.playlistId;
        const playlist = mediaManifest.playlists.find((entry) => entry.id === playlistId);
        if (!playlist) {
            respond({ ok: false, message: 'No playlist is currently playing' });
            return;
        }
        const index = direction > 0 && playbackState.playlistId === playlist.id
            ? playbackState.nextPlaylistIndex
                ?? getPlaylistIndex(playlist, playbackState.playlistIndex, direction)
            : getPlaylistIndex(playlist, playbackState.playlistIndex, direction);
        if (index === null) {
            respond({ ok: false, message: 'Playlist has reached its end' });
            return;
        }
        try {
            await playPlaylistIndex(playlist, index);
            respond({
                ok: true,
                playlistId: playlist.id,
                playlistIndex: index,
                playback: createPlaybackTimeline(playbackState)
            });
        } catch (error) {
            console.error('Unable to advance playlist:', error);
            respond({ ok: false, message: 'Unable to advance playlist' });
        }
    }

    async function saveSchedule(socket, request, acknowledge, isUpdate) {
        const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
        if (!controllers.has(socket.id)) {
            respond({ ok: false, message: 'Unauthorized schedule request' });
            return;
        }
        const existing = isUpdate
            ? mediaManifest.schedules.find((entry) => entry.id === request?.id)
            : null;
        const candidate = {
            id: isUpdate ? existing?.id : randomUUID(),
            targetType: request?.targetType,
            targetId: request?.targetId,
            startAt: request?.startAt,
            endAt: request?.endAt,
            timeZone: request?.timeZone,
            enabled: request?.enabled ?? true,
            createdAt: existing?.createdAt ?? new Date().toISOString()
        };
        const targetExists = candidate.targetType === 'media'
            ? Boolean(findMedia(candidate.targetId))
            : candidate.targetType === 'playlist'
                && mediaManifest.playlists.some((entry) =>
                    entry.id === candidate.targetId && entry.items.length > 0);
        if (!validateSchedule(candidate) || !targetExists
            || (isUpdate && !existing)
            || mediaManifest.schedules.some((entry) => entry.id !== existing?.id
                && entry.enabled && candidate.enabled
                && Date.parse(entry.startAt) < Date.parse(candidate.endAt)
                && Date.parse(candidate.startAt) < Date.parse(entry.endAt))) {
            respond({ ok: false, message: 'Invalid or overlapping schedule' });
            return;
        }
        try {
            await updateMediaManifest((manifest) => {
                manifest.schedules = isUpdate
                    ? manifest.schedules.map((entry) => entry.id === candidate.id ? candidate : entry)
                    : [...manifest.schedules, candidate];
            });
        } catch (error) {
            console.error('Unable to persist schedule:', error);
            respond({ ok: false, message: 'Unable to save schedule' });
            return;
        }
        await runMediaScheduler();
        broadcastMediaSnapshot();
        respond({
            ok: true,
            schedule: candidate,
            schedules: getMediaSnapshot().schedules
        });
    }

    let schedulerBusy = false;
    async function runMediaScheduler() {
        if (schedulerBusy) {
            return;
        }
        schedulerBusy = true;
        try {
            const now = Date.now();
            const schedule = mediaManifest.schedules
                .filter((entry) => entry.enabled
                    && Date.parse(entry.startAt) <= now
                    && now < Date.parse(entry.endAt))
                .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))[0];
            const activeScheduleId = mediaManifest.activeScheduleId ?? null;
            if (schedule?.id !== activeScheduleId) {
                if (schedule) {
                    await updateMediaManifest((manifest) => {
                        manifest.activeScheduleId = schedule.id;
                    });
                    try {
                        if (schedule.targetType === 'media') {
                            const item = findMedia(schedule.targetId);
                            if (item) {
                                await publishMediaItem(item, {
                                    shouldPlay: item.mediaType === 'video'
                                });
                            }
                        } else {
                            const playlist = mediaManifest.playlists.find(
                                (entry) => entry.id === schedule.targetId
                            );
                            if (playlist?.items.length) {
                                await playPlaylistIndex(playlist, 0);
                            }
                        }
                    } catch (error) {
                        await updateMediaManifest((manifest) => {
                            manifest.activeScheduleId = activeScheduleId;
                        });
                        throw error;
                    }
                    broadcastMediaSnapshot();
                } else if (activeScheduleId) {
                    await updateMediaManifest((manifest) => {
                        manifest.activeScheduleId = null;
                        manifest.playback = createStoppedPlayback(
                            playbackState.mediaId,
                            'none',
                            playbackState.volume ?? 0
                        );
                    });
                    broadcastPlayback();
                }
            }

            if (playbackState.status === 'playing' && playbackState.playlistId) {
                const playlist = mediaManifest.playlists.find(
                    (entry) => entry.id === playbackState.playlistId
                );
                const duration = playbackState.itemDurationSeconds
                    ?? getPlaylistItemDuration(playlist, playbackState.playlistIndex);
                if (playlist && duration !== null
                    && getPlaybackPosition(playbackState, now) >= duration) {
                    const nextIndex = playbackState.nextPlaylistIndex
                        ?? getPlaylistIndex(playlist, playbackState.playlistIndex, 1);
                    if (nextIndex === null) {
                        await updateMediaManifest((manifest) => {
                            manifest.playback = {
                                ...playbackState,
                                status: 'paused',
                                positionSeconds: duration,
                                startedAt: null
                            };
                        });
                        broadcastPlayback();
                    } else {
                        await playPlaylistIndex(playlist, nextIndex);
                    }
                }
            }
        } catch (error) {
            console.error('Media scheduler update failed:', error);
        } finally {
            schedulerBusy = false;
        }
    }

    function updateSettings(update) {
        const operation = settingsUpdateQueue.then(async () => {
            const previous = getSettingsSnapshot();
            update();
            const updated = getSettingsSnapshot();

            if (JSON.stringify(previous) !== JSON.stringify(updated)) {
                try {
                    await writeSettings(updated);
                } catch (error) {
                    calibrationEnabled = previous.calibrationEnabled;
                    alignmentSettings[1] = previous.screens[1];
                    for (let screen = 2; screen <= MAX_SCREEN_COUNT; screen += 1) {
                        alignmentSettings[screen] = previous.screens[screen];
                    }
                    calibrationPresets = previous.presets;
                    displayLayout = previous.layout;
                    layoutPresets = previous.layoutPresets;
                    totalScreens = previous.totalScreens;
                    assignmentMode = previous.assignmentMode;
                    persistedAssignments = previous.assignments;
                    persistedMarkerAssignments = previous.markerAssignments;
                    for (const [id, device] of devices) {
                        if (id in persistedAssignments) {
                            device.screen = persistedAssignments[id];
                        }
                    }
                    throw error;
                }
            }

            return updated;
        });
        settingsUpdateQueue = operation.catch(() => {});
        return operation;
    }

    function getAlignmentSnapshot() {
        return createAlignmentSnapshot(totalScreens, alignmentSettings);
    }

    function getStoredAlignmentSnapshot() {
        return cloneAlignmentSettings(alignmentSettings);
    }

    function validateAlignment(state) {
        const settings = state?.settings;
        if (!state || typeof state !== 'object' || Array.isArray(state)
            || !Number.isInteger(state.screen)
            || !isScreenNumber(state.screen)
            || state.screen > totalScreens
            || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return false;
        }

        return Number.isFinite(settings.horizontal)
            && settings.horizontal >= -50
            && settings.horizontal <= 50
            && Number.isFinite(settings.vertical)
            && settings.vertical >= -50
            && settings.vertical <= 50
            && Number.isFinite(settings.scale)
            && settings.scale >= 0.95
            && settings.scale <= 1.05;
    }

    function validateContent(content) {
        if (!content || typeof content !== 'object' || Array.isArray(content)
            || content.contentType !== 'image'
            || typeof content.imageUrl !== 'string'
            || content.imageUrl.length === 0
            || content.imageUrl.length > 2048
            || typeof content.updateId !== 'string'
            || !content.updateId.trim()
            || content.updateId.length > 128) {
            return false;
        }

        try {
            if (content.imageUrl.startsWith('/') && !content.imageUrl.startsWith('//')) {
                new URL(content.imageUrl, 'http://parallax.local');
                return true;
            }

            const url = new URL(content.imageUrl);
            return (url.protocol === 'http:' || url.protocol === 'https:')
                && !url.username
                && !url.password;
        } catch {
            return false;
        }
    }

    function getDeviceSnapshot() {
        return [...devices.values()].map(({ id, screen, socketId }) => ({
            id,
            name: deviceNames[id] || null,
            markerId: persistedMarkerAssignments[id] ?? null,
            screen,
            connected: socketId !== null,
            enabled: screen === null ? false : displayLayout.screens[screen]?.enabled !== false,
            socketId
        }));
    }

    function getPresetsSnapshot() {
        return [
            {
                name: DEFAULT_PRESET_NAME,
                isDefault: true,
                screens: createAlignmentSnapshot(totalScreens, {})
            },
            ...calibrationPresets.map(({ name, screens: presetScreens }) => ({
                name,
                isDefault: false,
                screens: createAlignmentSnapshot(totalScreens, presetScreens)
            }))
        ];
    }

    function getLayoutPresetsSnapshot() {
        return [
            {
                name: 'Default',
                isDefault: true,
                totalScreens,
                layout: createDefaultLayout(totalScreens)
            },
            ...layoutPresets.map((preset) => ({
                name: preset.name,
                isDefault: false,
                totalScreens: preset.totalScreens,
                layout: cloneDisplayLayout(preset.layout)
            }))
        ];
    }

    function getScreenConfigSnapshot() {
        return {
            totalScreens,
            assignmentMode,
            screens: getAlignmentSnapshot(),
            layout: cloneDisplayLayout(displayLayout)
        };
    }

    function getDeviceConfiguration(device) {
        return {
            deviceId: device.id,
            screen: device.screen,
            markerId: persistedMarkerAssignments[device.id] ?? null,
            totalScreens,
            layout: cloneDisplayLayout(displayLayout),
            enabled: device.screen === null ? false : displayLayout.screens[device.screen]?.enabled !== false,
            calibrationEnabled,
            alignment: device.screen ? { ...alignmentSettings[device.screen] } : null,
            currentContent
        };
    }

    function setVisionMarkerMode() {
        const enabled = visionSessions.size > 0;
        for (const device of devices.values()) {
            if (!device.socketId) {
                continue;
            }
            io.sockets.sockets.get(device.socketId)?.emit('vision:marker-mode', { enabled });
        }
    }

    function emitDeviceConfiguration(device, eventName = 'device:assignment-update') {
        if (!device.socketId) {
            return;
        }
        const target = io.sockets.sockets.get(device.socketId);
        if (!target) {
            return;
        }
        target.emit('vision:marker-mode', { enabled: visionSessions.size > 0 });
        if (device.screen === null) {
            target.emit('device:unassigned', getDeviceConfiguration(device));
            return;
        }
        target.emit(eventName, getDeviceConfiguration(device));
        target.emit('layout:update', {
            totalScreens,
            layout: cloneDisplayLayout(displayLayout),
            screens: getAlignmentSnapshot()
        });
        target.emit('content:update', currentContent);
        target.emit('calibration:update', { enabled: calibrationEnabled });
        target.emit('alignment:update', {
            screens: getAlignmentSnapshot(),
            revision: alignmentRevision
        });
        target.emit('playback:sync', createPlaybackTimeline(playbackState));
    }

    function broadcastScreenConfiguration() {
        const payload = getScreenConfigSnapshot();
        io.emit('screen-config:update', payload);
        io.emit('layout:update', {
            totalScreens,
            layout: cloneDisplayLayout(displayLayout),
            screens: getAlignmentSnapshot()
        });
        broadcastDeviceSnapshot();
        broadcastDiagnostics();
    }

    function getDiagnosticsSnapshot() {
        const activeDevices = [...devices.values()];
        return {
            backendConnected: true,
            activeDeviceCount: activeDevices.filter(({ socketId, screen }) =>
                socketId !== null && screen !== null
                && displayLayout.screens[screen]?.enabled !== false).length,
            currentContent: { ...currentContent },
            contentUpdatedAt,
            calibrationEnabled,
            screens: getAlignmentSnapshot(),
            alignmentRevision,
            alignmentUpdatedAt,
            devices: Array.from({ length: totalScreens }, (_, index) => index + 1).map((screen) => {
                const device = activeDevices.find((entry) => entry.screen === screen);
                const enabled = displayLayout.screens[screen]?.enabled !== false;
                return {
                    screen,
                    deviceId: device?.id ?? null,
                    enabled,
                    geometry: { ...displayLayout.screens[screen] },
                    status: !enabled ? 'disabled'
                        : !device ? 'waiting' : device.socketId ? 'connected' : 'disconnected',
                    displayStatus: device?.displayStatus ?? 'unknown',
                    displayError: device?.displayError ?? null,
                    lastActivity: device?.lastActivity ?? null,
                    loadedUpdateId: device?.loadedUpdateId ?? null,
                    alignmentSynced: enabled && device?.socketId
                        ? device.reportedAlignmentRevision === alignmentRevision
                        : null,
                    playback: device?.socketId ? device.playbackDiagnostics : null
                };
            })
        };
    }

    function broadcastDiagnostics() {
        const snapshot = getDiagnosticsSnapshot();
        for (const controllerId of controllers) {
            io.sockets.sockets.get(controllerId)?.emit('diagnostics:update', snapshot);
        }
    }

    function broadcastPresets() {
        const payload = { presets: getPresetsSnapshot() };
        for (const controllerId of controllers) {
            io.sockets.sockets.get(controllerId)?.emit('presets:current', payload);
        }
    }

    function broadcastLayoutPresets() {
        const payload = { presets: getLayoutPresetsSnapshot() };
        for (const controllerId of controllers) {
            io.sockets.sockets.get(controllerId)?.emit('layout-presets:current', payload);
        }
    }

    function broadcastAlignment(screens = getAlignmentSnapshot(), sourceControllerId = null) {
        alignmentRevision += 1;
        alignmentUpdatedAt = new Date().toISOString();
        const payload = { screens, revision: alignmentRevision };
        for (const device of devices.values()) {
            if (device.socketId && device.screen !== null) {
                io.sockets.sockets.get(device.socketId)?.emit('alignment:update', payload);
            }
        }
        for (const controllerId of controllers) {
            if (controllerId !== sourceControllerId) {
                io.sockets.sockets.get(controllerId)?.emit('alignment:current', payload);
            }
        }
        broadcastDiagnostics();
    }

    function broadcastDeviceSnapshot(target = io) {
        target.emit('devices:update', getDeviceSnapshot());
    }

    function getLanInterfaces() {
        if (Array.isArray(pairingInterfaces)) {
            return pairingInterfaces.filter((entry) =>
                entry && typeof entry.name === 'string'
                && typeof entry.address === 'string'
                && isPrivateIPv4(entry.address));
        }
        const interfaces = Object.entries(networkInterfaces());
        const isVirtualInterface = (name) =>
            /virtual|vmware|virtualbox|docker|wsl|hyper-v|vethernet|loopback|bluetooth/i.test(name);

        return interfaces
            .filter(([name]) => !isVirtualInterface(name))
            .flatMap(([name, addresses]) => (addresses ?? [])
                .filter((entry) => entry.family === 'IPv4'
                    && !entry.internal
                    && isPrivateIPv4(entry.address))
                .map((entry) => ({ name, address: entry.address })))
            .filter((entry, index, list) =>
                list.findIndex((candidate) => candidate.address === entry.address) === index);
    }

    function clearPairingSession(token) {
        const timer = pairingTimers.get(token);
        if (timer) {
            clearTimeout(timer);
            pairingTimers.delete(token);
        }
        pairingSessions.delete(token);
    }

    function getUploadBaseUrl(req) {
        let baseUrl;
        if (publicBaseUrl) {
            baseUrl = new URL(publicBaseUrl);
        } else {
            const forwardedHost = req.get('x-forwarded-host');
            const publicHost = typeof forwardedHost === 'string' && forwardedHost.trim()
                ? forwardedHost.split(',')[0].trim()
                : req.get('host');
            baseUrl = new URL(`${getForwardedProtocol(req)}://${publicHost}`);
            if (['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)) {
                const lanAddress = getPrivateLanAddress();
                if (!lanAddress) {
                    throw new Error(
                        'Cannot create a phone-accessible media URL; configure PARALLAX_PUBLIC_URL'
                    );
                }
                baseUrl.hostname = lanAddress;
            }
        }
        if (!['http:', 'https:'].includes(baseUrl.protocol)) {
            throw new Error('PARALLAX_PUBLIC_URL must use HTTP or HTTPS');
        }
        return baseUrl;
    }

    app.use('/uploads', (req, res, next) => {
        const origin = req.get('origin');
        if (origin && !isAllowedBrowserOrigin(origin, getForwardedHostname(req))) {
            res.status(403).json({ error: 'Media origin is not allowed' });
            return;
        }
        if (origin) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Vary', 'Origin');
        }
        res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    }, express.static(uploadDirectory, {
        acceptRanges: true,
        dotfiles: 'deny',
        index: false,
        fallthrough: false
    }));

    app.use(['/api/upload', '/api/media/upload'], (req, res, next) => {
        const origin = req.get('origin');
        if (origin) {
            if (!isAllowedBrowserOrigin(origin, getForwardedHostname(req))) {
                res.status(403).json({ error: 'Upload origin is not allowed' });
                return;
            }
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Vary', 'Origin');
        }
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, X-Parallax-Controller');

        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });

    function authorizeControllerUpload(req, res, next) {
        const suppliedToken = req.get('x-parallax-controller');
        const suppliedBytes = typeof suppliedToken === 'string'
            ? Buffer.from(suppliedToken)
            : Buffer.alloc(0);
        const authorized = [...controllerUploadTokens.values()].some((expectedToken) => {
            const expectedBytes = Buffer.from(expectedToken);
            return suppliedBytes.length === expectedBytes.length
                && timingSafeEqual(suppliedBytes, expectedBytes);
        });
        if (!authorized) {
            res.status(401).json({ error: 'A registered controller session is required' });
            return;
        }
        next();
    }

    app.post('/api/upload', authorizeControllerUpload, (req, res, next) => {
        upload.single('image')(req, res, (error) => {
            if (!error) {
                next();
                return;
            }

            if (error instanceof multer.MulterError) {
                const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                res.status(status).json({
                    error: error.code === 'LIMIT_FILE_SIZE'
                        ? 'Image exceeds the 15 MB upload limit'
                        : `Invalid upload: ${error.message}`
                });
                return;
            }
            next(error);
        });
    }, async (req, res, next) => {
        try {
            if (!req.file) {
                res.status(400).json({ error: 'Select an image to upload' });
                return;
            }

            const detectedType = await fileTypeFromBuffer(req.file.buffer);
            const format = detectedType && IMAGE_FORMATS.get(detectedType.mime);
            if (!format) {
                res.status(415).json({
                    error: 'Unsupported image. Upload a valid JPG, PNG, or WebP file.'
                });
                return;
            }

            let image;
            let metadata;
            try {
                image = sharp(req.file.buffer, {
                    limitInputPixels: MAX_IMAGE_PIXELS,
                    failOn: 'error'
                });
                metadata = await image.metadata();
                if (metadata.format !== format.sharpFormat
                    || !metadata.width
                    || !metadata.height
                    || metadata.width > MAX_IMAGE_DIMENSION
                    || metadata.height > MAX_IMAGE_DIMENSION
                    || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
                    res.status(400).json({
                        error: 'Image dimensions are invalid or exceed the 50-megapixel limit'
                    });
                    return;
                }

                await image
                    .rotate()
                    .resize({ width: 1, height: 1, fit: 'inside' })
                    .toBuffer();
            } catch {
                res.status(400).json({
                    error: 'The uploaded file is not a valid image'
                });
                return;
            }

            await mkdir(uploadDirectory, { recursive: true });
            const filename = `${randomUUID()}.${format.extension}`;
            const filePath = resolve(uploadDirectory, filename);
            await writeFile(filePath, req.file.buffer, { flag: 'wx' });

            const baseUrl = getUploadBaseUrl(req);
            const imageUrl = new URL(`/uploads/${filename}`, baseUrl).toString();
            const content = {
                contentType: 'image',
                imageUrl,
                updateId: randomUUID()
            };
            const mediaId = randomUUID();
            const mediaItem = {
                id: mediaId,
                filename,
                mediaType: 'image',
                mimeType: detectedType.mime,
                url: imageUrl,
                size: req.file.size,
                uploadedAt: new Date().toISOString(),
                durationSeconds: null
            };
            const persistedContent = {
                contentType: 'image',
                imageUrl,
                updateId: content.updateId
            };
            await updateMediaManifest((manifest) => {
                manifest.media.push(mediaItem);
                manifest.uploadHistory.push({
                    id: mediaId,
                    filename,
                    mediaType: 'image',
                    size: req.file.size,
                    uploadedAt: mediaItem.uploadedAt,
                    uploadStatus: 'uploaded'
                });
                manifest.currentContent = persistedContent;
                manifest.playback = createStoppedPlayback(mediaId, 'none', playbackState.volume ?? 0);
            });
            currentContent = persistedContent;
            playbackState = { ...mediaManifest.playback };
            contentUpdatedAt = new Date().toISOString();
            console.log(`Image uploaded and published: ${filename} | ${metadata.width}x${metadata.height}`);
            io.to(deviceRoom).emit('content:update', content);
            broadcastPlayback();
            broadcastMediaSnapshot();
            broadcastDiagnostics();

            res.status(201).json({
                ...content,
                filename,
                mimeType: detectedType.mime,
                width: metadata.width,
                height: metadata.height,
                size: req.file.size,
                mediaId,
                connectedDevices: [...devices.values()]
                    .filter(({ socketId }) => socketId !== null).length
            });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/media/upload', authorizeControllerUpload, (req, res, next) => {
        mediaUpload.single('media')(req, res, (error) => {
            if (!error) {
                next();
                return;
            }
            if (error instanceof multer.MulterError) {
                const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                res.status(status).json({
                    error: error.code === 'LIMIT_FILE_SIZE'
                        ? 'Media exceeds the 100 MB upload limit'
                        : `Invalid upload: ${error.message}`
                });
                return;
            }
            next(error);
        });
    }, async (req, res, next) => {
        let savedPath = null;
        try {
            if (!req.file) {
                res.status(400).json({ error: 'Select an image or MP4 video to upload' });
                return;
            }
            const detectedType = await fileTypeFromBuffer(req.file.buffer);
            const imageFormat = detectedType && IMAGE_FORMATS.get(detectedType.mime);
            const videoFormat = detectedType && VIDEO_FORMATS.get(detectedType.mime);
            if (!imageFormat && !videoFormat) {
                res.status(415).json({
                    error: 'Unsupported media. Upload a valid JPG, PNG, WebP, or MP4 file.'
                });
                return;
            }
            if (imageFormat && req.file.size > MAX_UPLOAD_BYTES) {
                res.status(413).json({ error: 'Image exceeds the 15 MB upload limit' });
                return;
            }
            if (videoFormat && (req.file.buffer.length < 12
                || req.file.buffer.toString('ascii', 4, 8) !== 'ftyp')) {
                res.status(400).json({ error: 'The uploaded file is not a valid MP4 video' });
                return;
            }

            let imageMetadata = null;
            if (imageFormat) {
                try {
                    const image = sharp(req.file.buffer, {
                        limitInputPixels: MAX_IMAGE_PIXELS,
                        failOn: 'error'
                    });
                    imageMetadata = await image.metadata();
                    if (imageMetadata.format !== imageFormat.sharpFormat
                        || !imageMetadata.width || !imageMetadata.height
                        || imageMetadata.width > MAX_IMAGE_DIMENSION
                        || imageMetadata.height > MAX_IMAGE_DIMENSION
                        || imageMetadata.width * imageMetadata.height > MAX_IMAGE_PIXELS) {
                        res.status(400).json({
                            error: 'Image dimensions are invalid or exceed the 50-megapixel limit'
                        });
                        return;
                    }
                    await image.rotate().resize({ width: 1, height: 1, fit: 'inside' }).toBuffer();
                } catch {
                    res.status(400).json({ error: 'The uploaded file is not a valid image' });
                    return;
                }
            }

            const mediaType = videoFormat ? 'video' : 'image';
            const filename = `${randomUUID()}.${videoFormat?.extension ?? imageFormat.extension}`;
            savedPath = resolve(uploadDirectory, filename);
            await mkdir(uploadDirectory, { recursive: true });
            await writeFile(savedPath, req.file.buffer, { flag: 'wx' });
            const url = new URL(`/uploads/${filename}`, getUploadBaseUrl(req)).toString();
            const requestedDuration = req.body?.durationSeconds;
            const durationSeconds = videoFormat && typeof requestedDuration === 'string'
                && requestedDuration !== '' ? Number(requestedDuration) : null;
            if (durationSeconds !== null
                && (!Number.isFinite(durationSeconds) || durationSeconds <= 0
                    || durationSeconds > 86_400)) {
                await unlink(savedPath);
                savedPath = null;
                res.status(400).json({ error: 'Invalid video duration metadata' });
                return;
            }
            const item = {
                id: randomUUID(),
                filename,
                mediaType,
                mimeType: detectedType.mime,
                url,
                size: req.file.size,
                uploadedAt: new Date().toISOString(),
                durationSeconds
            };
            if (!validateMediaItem(item)) {
                throw new Error('Media metadata validation failed');
            }
            await updateMediaManifest((manifest) => {
                manifest.media.push(item);
                manifest.uploadHistory.push({
                    id: item.id,
                    filename: item.filename,
                    mediaType: item.mediaType,
                    size: item.size,
                    uploadedAt: item.uploadedAt,
                    uploadStatus: 'uploaded'
                });
            });
            savedPath = null;
            broadcastMediaSnapshot();
            res.status(201).json({
                ...item,
                width: imageMetadata?.width ?? null,
                height: imageMetadata?.height ?? null,
                published: false
            });
        } catch (error) {
            if (savedPath) {
                await unlink(savedPath).catch((cleanupError) => {
                    if (cleanupError.code !== 'ENOENT') {
                        console.error('Unable to remove incomplete media upload:', cleanupError);
                    }
                });
            }
            next(error);
        }
    });

    app.use((error, req, res, next) => {
        if (res.headersSent) {
            next(error);
            return;
        }
        console.error(`Request failed: ${error.message}`);
        res.status(500).json({ error: 'Upload failed due to a server error' });
    });

    io.on('connection', (socket) => {
        console.log(`Socket connected: ${socket.id} (${socket.conn.transport.name})`);
        broadcastDeviceSnapshot(socket);

        socket.on('pairing:create', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function'
                ? acknowledge
                : typeof request === 'function' ? request : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Only a registered controller can create a pairing session.' });
                return;
            }

            const interfaces = getLanInterfaces();
            if (interfaces.length === 0) {
                respond({
                    ok: false,
                    message: 'No private IPv4 LAN address was found. Connect this laptop to the phone network and retry.'
                });
                return;
            }

            for (const [existingToken, session] of pairingSessions) {
                if (session.expiresAt <= Date.now() || session.controllerId === socket.id) {
                    clearPairingSession(existingToken);
                }
            }
            const token = randomBytes(32).toString('base64url');
            const expiresAt = Date.now() + pairingTtlMs;
            pairingSessions.set(token, {
                expiresAt,
                used: false,
                controllerId: socket.id
            });
            const timer = setTimeout(() => {
                const activeSession = pairingSessions.get(token);
                if (!activeSession) {
                    return;
                }
                activeSession.expired = true;
                pairingTimers.delete(token);
                io.sockets.sockets.get(socket.id)?.emit('pairing:expired', { expiresAt });
                const cleanupTimer = setTimeout(() => clearPairingSession(token), pairingTtlMs);
                cleanupTimer.unref?.();
                pairingTimers.set(token, cleanupTimer);
            }, pairingTtlMs);
            timer.unref?.();
            pairingTimers.set(token, timer);
            const result = {
                ok: true,
                token,
                expiresAt,
                interfaces,
                connectedDevices: [...devices.values()]
                    .filter(({ socketId }) => socketId !== null).length
            };
            socket.emit('pairing:created', result);
            respond(result);
        });

        socket.on('pairing:join', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            const token = request?.token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
                const result = { ok: false, message: 'Invalid pairing link. Request a new QR code.' };
                socket.emit('pairing:result', result);
                respond(result);
                return;
            }

            const session = pairingSessions.get(token);
            if (!session) {
                const result = { ok: false, message: 'This pairing link is invalid or has expired.' };
                socket.emit('pairing:result', result);
                respond(result);
                return;
            }
            if (session.expiresAt <= Date.now()) {
                clearPairingSession(token);
                const result = { ok: false, expired: true, message: 'This pairing code expired. Ask the controller for a new one.' };
                socket.emit('pairing:expired', result);
                socket.emit('pairing:result', result);
                respond(result);
                return;
            }
            if (session.used) {
                const result = { ok: false, message: 'This pairing code has already been used. Ask the controller for a new one.' };
                socket.emit('pairing:result', result);
                respond(result);
                return;
            }

            session.used = true;
            socket.data.parallaxPairingAuthorized = true;
            socket.emit('pairing:result', { ok: true });
            io.sockets.sockets.get(session.controllerId)?.emit('pairing:device-joined', {
                connectedDevices: [...devices.values()]
                    .filter(({ socketId }) => socketId !== null).length
            });
            respond({ ok: true });
        });

        socket.on('vision:camera:create', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized vision camera request' });
                return;
            }

            const interfaces = getLanInterfaces();
            if (interfaces.length === 0) {
                respond({
                    ok: false,
                    message: 'No private IPv4 LAN address was found. Connect this laptop to the phone network and retry.'
                });
                return;
            }

            const token = randomBytes(32).toString('hex');
            const expiresAt = Date.now() + (5 * 60 * 1000);
            const visionPath = `/vision?vision=${encodeURIComponent(token)}`;
            visionSessions.set(token, {
                controllerId: socket.id,
                cameraSocketId: null,
                token,
                expiresAt,
                createdAt: Date.now(),
                status: 'waiting',
                tracker: createVisionTrackerState()
            });
            setVisionMarkerMode();
            respond({
                ok: true,
                token,
                expiresAt,
                url: visionPath,
                interfaces,
                status: 'waiting'
            });
        });

        socket.on('vision:camera:join', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            const token = request?.token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9]{32,128}$/.test(token)) {
                respond({ ok: false, message: 'Invalid vision camera session.' });
                return;
            }
            const session = visionSessions.get(token);
            if (!session) {
                respond({ ok: false, message: 'This vision camera session is invalid or expired.' });
                return;
            }
            if (session.expiresAt <= Date.now()) {
                visionSessions.delete(token);
                respond({ ok: false, expired: true, message: 'This vision camera session expired.' });
                return;
            }
            if (session.cameraSocketId && session.cameraSocketId !== socket.id) {
                respond({ ok: false, message: 'This vision camera session is already in use.' });
                return;
            }
            session.cameraSocketId = socket.id;
            session.status = 'connected';
            socket.data.visionCameraToken = token;
            io.sockets.sockets.get(session.controllerId)?.emit('vision:camera:status', {
                connected: true,
                token,
                status: 'connected'
            });
            respond({ ok: true, token, status: 'connected' });
        });

        socket.on('vision:camera:report', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            const token = socket.data.visionCameraToken;
            if (!token) {
                respond({ ok: false, message: 'Vision camera is not authorized.' });
                return;
            }
            const session = visionSessions.get(token);
            if (!session || session.cameraSocketId !== socket.id) {
                respond({ ok: false, message: 'Vision camera session is invalid.' });
                return;
            }
            const markers = Array.isArray(request?.markers) ? request.markers : [];
            const validMarkers = markers
                .filter((marker) => marker && typeof marker === 'object')
                .map((marker) => {
                    const normalized = marker.normalizedCenter && typeof marker.normalizedCenter === 'object'
                        ? marker.normalizedCenter
                        : null;
                    const x = normalized ? Number(normalized.x) : Number(marker.x);
                    const y = normalized ? Number(normalized.y) : Number(marker.y);
                    return {
                        id: Number(marker.id),
                        x,
                        y,
                        normalizedCenter: { x, y },
                        corners: Array.isArray(marker.corners)
                            ? marker.corners.map((corner) => ({
                                x: Number(corner?.x),
                                y: Number(corner?.y)
                            }))
                            : [],
                        rotation: Number(marker.rotation),
                        confidence: Number(marker.confidence),
                        visible: Boolean(marker.visible),
                        timestamp: Number(marker.timestamp) || Date.now(),
                        deviceId: typeof marker.deviceId === 'string' ? marker.deviceId : null
                    };
                })
                .filter((marker) => Number.isFinite(marker.id)
                    && marker.id >= 0
                    && Number.isFinite(marker.x)
                    && marker.x >= 0
                    && marker.x <= 1
                    && Number.isFinite(marker.y)
                    && marker.y >= 0
                    && marker.y <= 1
                    && Number.isFinite(marker.rotation)
                    && Number.isFinite(marker.confidence)
                    && marker.confidence >= 0
                    && marker.confidence <= 1);
            const registeredDevices = [...devices.values()].map((device) => ({
                id: device.id,
                name: deviceNames[device.id] || device.id,
                markerId: persistedMarkerAssignments[device.id] ?? null
            }));
            const associationDevices = registeredDevices.filter((device) =>
                Number.isInteger(device.markerId));
            const associated = associateMarkersWithDevices(validMarkers, associationDevices);
            const tracked = updateVisionTracker(session.tracker, associated.map((marker) => ({
                ...marker,
                normalizedCenter: {
                    x: Number(marker.normalizedCenter?.x ?? marker.x),
                    y: Number(marker.normalizedCenter?.y ?? marker.y)
                }
            })));
            const observations = tracked.map((marker) => ({
                ...marker,
                relativeX: marker.x,
                relativeY: marker.y,
                status: 'tracked',
                trackingState: 'tracked',
                calibrated: false
            }));
            for (const marker of session.tracker.devices.values()) {
                if (marker.status === 'lost'
                    && !observations.some((observation) => observation.deviceId === marker.deviceId)) {
                    observations.push({
                        ...marker,
                        relativeX: marker.x,
                        relativeY: marker.y,
                        trackingState: 'lost'
                    });
                }
            }
            const payload = {
                token,
                connected: true,
                status: observations.length > 0 ? 'tracking' : 'waiting',
                markers: observations,
                timestamp: Date.now()
            };
            const recipientSocket = io.sockets.sockets.get(session.controllerId);
            recipientSocket?.emit('vision:camera:update', payload);
            const matchedMarkerIds = associated.map((marker) => ({
                markerId: marker.id,
                deviceId: marker.deviceId
            }));
            const matchedIds = new Set(matchedMarkerIds.map(({ markerId }) => markerId));
            respond({
                ok: true,
                status: payload.status,
                markers: validMarkers.length,
                registeredMarkers: associationDevices.map(({ id, markerId }) => ({
                    deviceId: id,
                    markerId
                })),
                matchedMarkerIds,
                unmatchedMarkerIds: validMarkers
                    .filter((marker) => !matchedIds.has(marker.id))
                    .map((marker) => marker.id)
            });
        });

        socket.on('vision:camera:disconnect', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            const token = socket.data.visionCameraToken ?? request?.token;
            if (!token) {
                respond({ ok: true });
                return;
            }
            const session = visionSessions.get(token);
            if (session && session.cameraSocketId === socket.id) {
                session.cameraSocketId = null;
                session.status = 'waiting';
                io.sockets.sockets.get(session.controllerId)?.emit('vision:camera:status', {
                    connected: false,
                    token,
                    status: 'waiting'
                });
            }
            if (visionSessions.has(token) && !visionSessions.get(token).cameraSocketId) {
                visionSessions.delete(token);
                setVisionMarkerMode(false);
            }
            delete socket.data.visionCameraToken;
            respond({ ok: true, status: 'disconnected' });
        });

        socket.on('device:register', async (deviceId) => {
            if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
                console.warn(`Device registration rejected for socket ${socket.id}: invalid device ID`);
                socket.emit('device:rejected', { message: 'Invalid device ID' });
                return;
            }

            let device = devices.get(deviceId);
            if (!device) {
                const screen = Object.prototype.hasOwnProperty.call(persistedAssignments, deviceId)
                    ? persistedAssignments[deviceId]
                    : null;
                device = createDeviceRecord(deviceId, screen);
                devices.set(deviceId, device);
            }

            if (!Object.prototype.hasOwnProperty.call(persistedAssignments, deviceId)
                || (assignmentMode === 'automatic' && device.screen === null)) {
                try {
                    await updateSettings(() => {
                        let screen = null;
                        if (assignmentMode === 'automatic') {
                            const usedScreens = new Set(
                                Object.entries(persistedAssignments)
                                    .filter(([id, assignedScreen]) =>
                                        id !== deviceId && assignedScreen !== null)
                                    .map(([, assignedScreen]) => assignedScreen)
                            );
                            screen = Array.from(
                                { length: totalScreens },
                                (_, index) => index + 1
                            ).find((position) =>
                                displayLayout.screens[position]?.enabled !== false
                                && !usedScreens.has(position));
                            if (!screen) {
                                throw new Error('SCREEN_CAPACITY');
                            }
                        }
                        const markerAssignments = createPersistentMarkerAssignments(
                            [...new Set([...Object.keys(persistedAssignments), deviceId])],
                            persistedMarkerAssignments
                        );
                        device.screen = screen;
                        persistedAssignments[deviceId] = screen;
                        persistedMarkerAssignments = markerAssignments;
                    });
                } catch (error) {
                    devices.delete(deviceId);
                    if (error.message === 'SCREEN_CAPACITY') {
                        console.warn(`Device registration rejected: screen capacity reached (${deviceId})`);
                        socket.emit('device:rejected', {
                            message: `All ${totalScreens} screens are assigned. Reassign or unassign a device first.`
                        });
                        return;
                    }
                    if (error.message === 'MARKER_ID_CAPACITY_EXHAUSTED') {
                        console.warn(`Device registration rejected: marker ID capacity exhausted (${deviceId})`);
                        socket.emit('device:rejected', {
                            message: 'No js-aruco marker IDs are available. Remove a registered device before adding another.'
                        });
                        return;
                    }
                    console.error('Unable to persist device assignment:', error);
                    socket.emit('device:rejected', {
                        message: 'Unable to save device assignment. Please try again.'
                    });
                    return;
                }
            }

            if (device.disconnectTimer) {
                clearTimeout(device.disconnectTimer);
                device.disconnectTimer = null;
            }

            const previousSocketId = device.socketId;
            device.socketId = socket.id;
            device.playbackDiagnostics = null;
            socket.join(deviceRoom);
            socket.emit('vision:marker-mode', { enabled: visionSessions.size > 0 });

            if (previousSocketId && previousSocketId !== socket.id) {
                io.sockets.sockets.get(previousSocketId)?.disconnect(true);
            }

            if (device.screen === null) {
                socket.emit('device:unassigned', getDeviceConfiguration(device));
                console.log(`Device registered without a screen: ${device.id} | Socket ${socket.id}`);
            } else {
                socket.emit('device:assigned', {
                    ...getDeviceConfiguration(device),
                    screen: device.screen
                });
                socket.emit('content:update', currentContent);
                socket.emit('playback:sync', createPlaybackTimeline(playbackState));
                socket.emit('audio:settings', { ...audioSettings });
                socket.emit('calibration:update', { enabled: calibrationEnabled });
                socket.emit('alignment:update', {
                    screens: getAlignmentSnapshot(),
                    revision: alignmentRevision
                });
                console.log(`Device assigned: ${device.id} | Screen ${device.screen} | Socket ${socket.id}`);
            }
            broadcastDeviceSnapshot();
            broadcastDiagnostics();
        });

        socket.on('content:update', async (content, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized content update' });
                return;
            }
            if (!validateContent(content)) {
                console.warn(`Content update rejected for socket ${socket.id}`);
                const message = 'Invalid content update';
                socket.emit('content:rejected', {
                    updateId: typeof content?.updateId === 'string' ? content.updateId : null,
                    message
                });
                respond({ ok: false, message });
                return;
            }

            const nextContent = {
                contentType: content.contentType,
                imageUrl: content.imageUrl,
                updateId: content.updateId
            };
            try {
                await updateMediaManifest((manifest) => {
                    manifest.currentContent = nextContent;
                    manifest.playback = createStoppedPlayback(
                        null,
                        'none',
                        playbackState.volume ?? 0
                    );
                });
            } catch (error) {
                console.error('Unable to persist content update:', error);
                respond({ ok: false, message: 'Unable to save content update' });
                return;
            }
            currentContent = nextContent;
            contentUpdatedAt = new Date().toISOString();
            console.log(`Content updated: ${currentContent.updateId} | ${currentContent.imageUrl}`);
            io.to(deviceRoom).emit('content:update', currentContent);
            broadcastPlayback();
            broadcastMediaSnapshot();
            broadcastDiagnostics();
            respond({ ok: true, updateId: currentContent.updateId });
        });

        socket.on('controller:register', (acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (socket.data.parallaxPairingAuthorized
                || [...devices.values()].some((device) => device.socketId === socket.id)) {
                socket.emit('controller:rejected', {
                    message: 'Display devices cannot register as controllers.'
                });
                respond({ ok: false, message: 'Display devices cannot register as controllers.' });
                return;
            }
            controllers.add(socket.id);
            const uploadToken = randomBytes(32).toString('base64url');
            controllerUploadTokens.set(socket.id, uploadToken);
            respond({
                ok: true,
                uploadToken,
                capabilities: { audioSettings: true }
            });
            socket.emit('content:current', currentContent);
            socket.emit('media:current', getMediaSnapshot());
            socket.emit('playback:current', createPlaybackTimeline(playbackState));
            socket.emit('audio:settings', { ...audioSettings });
            socket.emit('calibration:current', {
                enabled: calibrationEnabled
            });
            socket.emit('alignment:current', {
                screens: getAlignmentSnapshot()
            });
            socket.emit('screen-config:current', getScreenConfigSnapshot());
            socket.emit('presets:current', { presets: getPresetsSnapshot() });
            socket.emit('layout-presets:current', { presets: getLayoutPresetsSnapshot() });
            socket.emit('diagnostics:update', getDiagnosticsSnapshot());
            broadcastDeviceSnapshot(socket);
        });

        socket.on('media:publish', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized media publish request' });
                return;
            }
            const item = typeof request?.mediaId === 'string'
                ? findMedia(request.mediaId)
                : null;
            if (!item || (request.transition !== undefined
                && !TRANSITIONS.includes(request.transition))) {
                respond({ ok: false, message: 'Invalid media item or transition' });
                return;
            }
            try {
                const content = await publishMediaItem(item, {
                    transition: request.transition ?? 'none',
                    shouldPlay: false
                });
                respond({ ok: true, content, media: getMediaSnapshot() });
            } catch (error) {
                console.error('Unable to publish media:', error);
                respond({ ok: false, message: 'Unable to publish media' });
            }
        });

        socket.on('media:delete', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized media deletion request' });
                return;
            }
            const item = mediaManifest.media.find((entry) => entry.id === request?.mediaId);
            if (!item) {
                respond({ ok: false, message: 'Media item not found' });
                return;
            }
            const isCurrent = playbackState.mediaId === item.id;
            if (isCurrent && request.confirmPublished !== true) {
                respond({ ok: false, message: 'Confirm deletion of currently published media' });
                return;
            }
            if (mediaManifest.playlists.some((playlist) =>
                playlist.items.some((entry) => entry.mediaId === item.id))
                || mediaManifest.schedules.some((entry) =>
                    entry.targetType === 'media' && entry.targetId === item.id)) {
                respond({ ok: false, message: 'Remove this media from playlists and schedules first' });
                return;
            }
            const filePath = resolve(uploadDirectory, item.filename);
            if (dirname(filePath) !== resolve(uploadDirectory)) {
                respond({ ok: false, message: 'Invalid media storage path' });
                return;
            }
            const stagedPath = `${filePath}.${randomUUID()}.deleting`;
            let staged = false;
            try {
                await rename(filePath, stagedPath);
                staged = true;
                await updateMediaManifest((manifest) => {
                    manifest.media = manifest.media.filter((entry) => entry.id !== item.id);
                    if (isCurrent) {
                        manifest.currentContent = {
                            contentType: 'image',
                            imageUrl: '/panorama.jpg',
                            updateId: randomUUID()
                        };
                        manifest.playback = createStoppedPlayback(
                            null,
                            'none',
                            playbackState.volume ?? 0
                        );
                    }
                });
            } catch (error) {
                if (staged) {
                    try {
                        await rename(stagedPath, filePath);
                    } catch (restoreError) {
                        console.error('Unable to restore media after failed deletion:', restoreError);
                    }
                }
                if (error.code === 'ENOENT') {
                    respond({ ok: false, message: 'Media file was not found on disk' });
                    return;
                }
                console.error('Unable to delete media library entry:', error);
                respond({ ok: false, message: 'Unable to delete media' });
                return;
            }
            let cleanupWarning = null;
            try {
                await unlink(stagedPath);
            } catch (error) {
                cleanupWarning = 'The media entry was removed, but its stored file needs cleanup.';
                console.error(cleanupWarning, error);
            }
            if (isCurrent) {
                io.to(deviceRoom).emit('content:update', currentContent);
                broadcastPlayback();
            }
            broadcastMediaSnapshot();
            broadcastDiagnostics();
            respond({ ok: true, media: getMediaSnapshot(), cleanupWarning });
        });

        socket.on('playback:play', (request, acknowledge) =>
            setPlaybackState(socket, request, acknowledge, 'play'));
        socket.on('playback:resume', (request, acknowledge) =>
            setPlaybackState(socket, request, acknowledge, 'resume'));
        socket.on('playback:pause', (request, acknowledge) =>
            setPlaybackState(socket, request, acknowledge, 'pause'));
        socket.on('playback:stop', (request, acknowledge) =>
            setPlaybackState(socket, request, acknowledge, 'stop'));
        socket.on('playback:seek', (request, acknowledge) =>
            setPlaybackState(socket, request, acknowledge, 'seek'));
        socket.on('playback:volume', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized playback request' });
                return;
            }
            if (!Number.isFinite(request?.volume)
                || request.volume < 0
                || request.volume > 1) {
                respond({ ok: false, message: 'Playback volume must be between 0 and 1' });
                return;
            }
            try {
                await updateMediaManifest((manifest) => {
                    manifest.playback.volume = request.volume;
                });
            } catch (error) {
                console.error('Unable to persist playback volume:', error);
                respond({ ok: false, message: 'Unable to save playback volume' });
                return;
            }
            const timeline = broadcastPlayback();
            broadcastMediaSnapshot();
            respond({ ok: true, playback: timeline });
        });
        socket.on('audio:settings', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized audio settings request' });
                return;
            }
            if (!validateAudioSettings(request)
                || (request.masterDeviceId !== null && !devices.has(request.masterDeviceId))
                || (request.mode === 'all' && request.masterDeviceId !== null)) {
                respond({ ok: false, message: 'Invalid audio mode or master device' });
                return;
            }
            try {
                await updateMediaManifest((manifest) => {
                    manifest.audioSettings = createAudioSettings(request);
                });
            } catch (error) {
                console.error('Unable to persist audio settings:', error);
                respond({ ok: false, message: 'Unable to save audio settings' });
                return;
            }
            broadcastAudioSettings();
            broadcastMediaSnapshot();
            respond({ ok: true, audioSettings: { ...audioSettings } });
        });
        socket.on('playback:next', (request, acknowledge) =>
            navigatePlaylist(socket, request, acknowledge, 1));
        socket.on('playback:previous', (request, acknowledge) =>
            navigatePlaylist(socket, request, acknowledge, -1));

        socket.on('playlist:create', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized playlist request' });
                return;
            }
            const name = validateMediaName(request?.name);
            const mediaType = request?.mediaType;
            const items = request?.items ?? [];
            if (!name || !['image', 'video'].includes(mediaType)
                || !validatePlaylistItems(mediaType, items)
                || (request.loop !== undefined && typeof request.loop !== 'boolean')
                || (request.shuffle !== undefined && typeof request.shuffle !== 'boolean')
                || (request.transition !== undefined
                    && !TRANSITIONS.includes(request.transition))) {
                respond({ ok: false, message: 'Invalid playlist name, type, or media items' });
                return;
            }
            if (mediaManifest.playlists.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
                respond({ ok: false, message: 'A playlist with this name already exists' });
                return;
            }
            const now = new Date().toISOString();
            const playlist = {
                id: randomUUID(),
                name,
                mediaType,
                items: items.map((item) => ({
                    mediaId: item.mediaId,
                    durationSeconds: item.durationSeconds ?? null
                })),
                loop: request.loop !== false,
                shuffle: request.shuffle === true,
                transition: TRANSITIONS.includes(request.transition) ? request.transition : 'none',
                createdAt: now,
                updatedAt: now
            };
            if (!validatePlaylist(playlist)) {
                respond({ ok: false, message: 'Invalid playlist configuration' });
                return;
            }
            try {
                await updateMediaManifest((manifest) => manifest.playlists.push(playlist));
            } catch (error) {
                console.error('Unable to persist playlist:', error);
                respond({ ok: false, message: 'Unable to save playlist' });
                return;
            }
            broadcastMediaSnapshot();
            respond({ ok: true, playlist, playlists: getMediaSnapshot().playlists });
        });

        socket.on('playlist:update', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized playlist request' });
                return;
            }
            const existing = mediaManifest.playlists.find((entry) => entry.id === request?.id);
            const name = validateMediaName(request?.name);
            const mediaType = request?.mediaType;
            if (!existing || playbackState.playlistId === existing.id
                || !name || !['image', 'video'].includes(mediaType)
                || !validatePlaylistItems(mediaType, request?.items)
                || (mediaType !== existing.mediaType && request.items.length > 0)
                || mediaManifest.playlists.some((entry) =>
                    entry.id !== existing.id && entry.name.toLowerCase() === name.toLowerCase())
                || (request.loop !== undefined && typeof request.loop !== 'boolean')
                || (request.shuffle !== undefined && typeof request.shuffle !== 'boolean')
                || (request.transition !== undefined
                    && !TRANSITIONS.includes(request.transition))) {
                respond({ ok: false, message: 'Invalid playlist update' });
                return;
            }
            const updated = {
                ...existing,
                name,
                mediaType,
                items: request.items.map((item) => ({
                    mediaId: item.mediaId,
                    durationSeconds: item.durationSeconds ?? null
                })),
                loop: request.loop ?? existing.loop,
                shuffle: request.shuffle ?? existing.shuffle,
                transition: request.transition ?? existing.transition,
                updatedAt: new Date().toISOString()
            };
            try {
                await updateMediaManifest((manifest) => {
                    manifest.playlists = manifest.playlists.map((entry) =>
                        entry.id === existing.id ? updated : entry);
                });
            } catch (error) {
                console.error('Unable to persist playlist update:', error);
                respond({ ok: false, message: 'Unable to update playlist' });
                return;
            }
            broadcastMediaSnapshot();
            respond({ ok: true, playlist: updated, playlists: getMediaSnapshot().playlists });
        });

        socket.on('playlist:delete', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized playlist request' });
                return;
            }
            const playlist = mediaManifest.playlists.find((entry) => entry.id === request?.id);
            if (!playlist) {
                respond({ ok: false, message: 'Playlist not found' });
                return;
            }
            if (playbackState.playlistId === playlist.id
                || mediaManifest.schedules.some((entry) =>
                    entry.targetType === 'playlist' && entry.targetId === playlist.id)) {
                respond({ ok: false, message: 'Stop or remove schedules using this playlist first' });
                return;
            }
            try {
                await updateMediaManifest((manifest) => {
                    manifest.playlists = manifest.playlists.filter((entry) => entry.id !== playlist.id);
                });
            } catch (error) {
                console.error('Unable to persist playlist deletion:', error);
                respond({ ok: false, message: 'Unable to delete playlist' });
                return;
            }
            broadcastMediaSnapshot();
            respond({ ok: true, playlists: getMediaSnapshot().playlists });
        });

        socket.on('playlist:load', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized playlist request' });
                return;
            }
            const playlist = mediaManifest.playlists.find((entry) => entry.id === request?.id);
            if (!playlist?.items.length) {
                respond({ ok: false, message: 'Playlist was not found or contains no media' });
                return;
            }
            try {
                await playPlaylistIndex(playlist, 0);
                respond({ ok: true, playlistId: playlist.id, playback: createPlaybackTimeline(playbackState) });
            } catch (error) {
                console.error('Unable to load playlist:', error);
                respond({ ok: false, message: 'Unable to load playlist' });
            }
        });

        socket.on('schedule:create', async (request, acknowledge) =>
            saveSchedule(socket, request, acknowledge, false));
        socket.on('schedule:update', async (request, acknowledge) =>
            saveSchedule(socket, request, acknowledge, true));
        socket.on('schedule:delete', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized schedule request' });
                return;
            }
            if (!mediaManifest.schedules.some((entry) => entry.id === request?.id)) {
                respond({ ok: false, message: 'Schedule not found' });
                return;
            }
            try {
                await updateMediaManifest((manifest) => {
                    manifest.schedules = manifest.schedules.filter((entry) => entry.id !== request.id);
                    if (manifest.activeScheduleId === request.id) {
                        manifest.activeScheduleId = null;
                        manifest.playback = createStoppedPlayback(
                            playbackState.mediaId,
                            'none',
                            playbackState.volume ?? 0
                        );
                    }
                });
            } catch (error) {
                console.error('Unable to persist schedule deletion:', error);
                respond({ ok: false, message: 'Unable to delete schedule' });
                return;
            }
            await runMediaScheduler();
            broadcastMediaSnapshot();
            respond({ ok: true, schedules: getMediaSnapshot().schedules });
        });

        socket.on('screen-config:set', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized screen configuration request' });
                return;
            }
            if (!request || !isScreenCount(request.totalScreens)
                || !['automatic', 'manual'].includes(request.assignmentMode)) {
                respond({
                    ok: false,
                    message: 'Screen count must be between 2 and 12 and assignment mode must be automatic or manual.'
                });
                return;
            }

            const affectedDevices = Object.entries(persistedAssignments)
                .filter(([, screen]) => screen !== null && screen > request.totalScreens)
                .map(([deviceId]) => deviceId);
            if (affectedDevices.length > 0) {
                respond({
                    ok: false,
                    message: `Reassign or unassign these devices before reducing the screen count: ${affectedDevices.join(', ')}.`,
                    affectedDevices
                });
                return;
            }

            try {
                await updateSettings(() => {
                    const newlyAffected = Object.entries(persistedAssignments)
                        .filter(([, screen]) => screen !== null && screen > request.totalScreens)
                        .map(([deviceId]) => deviceId);
                    if (newlyAffected.length > 0) {
                        throw new Error(`SCREEN_ASSIGNMENT_CONFLICT:${newlyAffected.join(', ')}`);
                    }
                    if (totalScreens !== request.totalScreens) {
                        displayLayout = resizeDisplayLayout(displayLayout, request.totalScreens);
                    }
                    totalScreens = request.totalScreens;
                    assignmentMode = request.assignmentMode;
                });
            } catch (error) {
                if (error.message.startsWith('SCREEN_ASSIGNMENT_CONFLICT:')) {
                    const affected = error.message.slice('SCREEN_ASSIGNMENT_CONFLICT:'.length);
                    respond({
                        ok: false,
                        message: `Reassign or unassign these devices before reducing the screen count: ${affected}.`,
                        affectedDevices: affected.split(', ')
                    });
                    return;
                }
                console.error('Unable to persist screen configuration:', error);
                respond({ ok: false, message: 'Unable to save screen configuration' });
                return;
            }

            await broadcastScreenConfiguration();
            respond({ ok: true, ...getScreenConfigSnapshot() });
        });

        socket.on('layout:set', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized layout request' });
                return;
            }
            if (!validateDisplayLayout(request?.layout, totalScreens)) {
                respond({ ok: false, message: 'Invalid display layout geometry or overlapping screens.' });
                return;
            }
            try {
                await updateSettings(() => {
                    if (!validateDisplayLayout(request.layout, totalScreens)) {
                        throw new Error('INVALID_LAYOUT');
                    }
                    displayLayout = cloneDisplayLayout(request.layout);
                });
            } catch (error) {
                if (error.message === 'INVALID_LAYOUT') {
                    respond({ ok: false, message: 'Invalid display layout geometry or overlapping screens.' });
                    return;
                }
                console.error('Unable to persist display layout:', error);
                respond({ ok: false, message: 'Unable to save display layout' });
                return;
            }
            await broadcastScreenConfiguration();
            respond({ ok: true, ...getScreenConfigSnapshot() });
        });

        socket.on('layout:reset', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized layout reset request' });
                return;
            }
            if (!request || typeof request !== 'object' || Array.isArray(request)
                || Object.keys(request).length !== 0) {
                respond({ ok: false, message: 'Invalid layout reset request' });
                return;
            }
            try {
                await updateSettings(() => {
                    displayLayout = createDefaultLayout(totalScreens);
                });
            } catch (error) {
                console.error('Unable to persist default display layout:', error);
                respond({ ok: false, message: 'Unable to reset display layout' });
                return;
            }
            await broadcastScreenConfiguration();
            respond({ ok: true, ...getScreenConfigSnapshot() });
        });

        socket.on('screen:configure', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized screen configuration request' });
                return;
            }
            const screen = request?.screen;
            const position = request?.position;
            if (!isScreenNumber(screen) || screen > totalScreens
                || !position || typeof position !== 'object' || Array.isArray(position)
                || !Number.isInteger(position.row) || !Number.isInteger(position.column)
                || ![0, 90, 180, 270].includes(position.rotation)
                || !['auto', 'portrait', 'landscape'].includes(position.orientation)) {
                respond({ ok: false, message: 'Invalid screen position, rotation, or orientation.' });
                return;
            }
            let nextLayout;
            try {
                nextLayout = cloneDisplayLayout(displayLayout);
                nextLayout.type = 'custom';
                nextLayout.rows = Math.max(nextLayout.rows, position.row + 1);
                nextLayout.columns = Math.max(nextLayout.columns, position.column + 1);
                nextLayout.screens[screen] = {
                    ...nextLayout.screens[screen],
                    row: position.row,
                    column: position.column,
                    rotation: position.rotation,
                    orientation: position.orientation
                };
                if (!validateDisplayLayout(nextLayout, totalScreens)) {
                    throw new Error('INVALID_LAYOUT');
                }
                await updateSettings(() => {
                    displayLayout = nextLayout;
                });
            } catch (error) {
                if (error.message === 'INVALID_LAYOUT') {
                    respond({ ok: false, message: 'Screen position overlaps another screen or is outside valid geometry.' });
                    return;
                }
                console.error('Unable to persist screen geometry:', error);
                respond({ ok: false, message: 'Unable to save screen geometry' });
                return;
            }
            await broadcastScreenConfiguration();
            respond({ ok: true, ...getScreenConfigSnapshot() });
        });

        const setScreenEnabled = async (request, acknowledge, enabled) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized screen state request' });
                return;
            }
            const screen = request?.screen;
            if (!isScreenNumber(screen) || screen > totalScreens) {
                respond({ ok: false, message: 'Invalid screen number' });
                return;
            }
            try {
                await updateSettings(() => {
                    displayLayout.screens[screen].enabled = enabled;
                });
            } catch (error) {
                console.error('Unable to persist screen enabled state:', error);
                respond({ ok: false, message: 'Unable to save screen enabled state' });
                return;
            }
            await broadcastScreenConfiguration();
            respond({ ok: true, screen, enabled });
        };
        socket.on('screen:enable', (request, acknowledge) =>
            setScreenEnabled(request, acknowledge, true));
        socket.on('screen:disable', (request, acknowledge) =>
            setScreenEnabled(request, acknowledge, false));

        socket.on('layout-presets:save', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized layout preset request' });
                return;
            }
            const name = validatePresetName(request?.name);
            if (!name || name.toLowerCase() === 'default') {
                respond({ ok: false, message: 'Enter a valid custom layout name (1-32 characters).' });
                return;
            }
            if (layoutPresets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
                respond({ ok: false, message: 'A layout preset with this name already exists.' });
                return;
            }
            try {
                await updateSettings(() => {
                    if (layoutPresets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
                        throw new Error('DUPLICATE_LAYOUT_PRESET');
                    }
                    layoutPresets.push({
                        name,
                        totalScreens,
                        layout: cloneDisplayLayout(displayLayout)
                    });
                });
            } catch (error) {
                if (error.message === 'DUPLICATE_LAYOUT_PRESET') {
                    respond({ ok: false, message: 'A layout preset with this name already exists.' });
                    return;
                }
                console.error('Unable to persist layout preset:', error);
                respond({ ok: false, message: 'Unable to save layout preset' });
                return;
            }
            broadcastLayoutPresets();
            respond({ ok: true, presets: getLayoutPresetsSnapshot() });
        });

        socket.on('layout-presets:load', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized layout preset request' });
                return;
            }
            const name = typeof request?.name === 'string' ? request.name.trim() : '';
            const preset = name.toLowerCase() === 'default'
                ? { name: 'Default', totalScreens, layout: createDefaultLayout(totalScreens) }
                : layoutPresets.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
            if (!preset) {
                respond({ ok: false, message: 'Layout preset not found.' });
                return;
            }
            if (Object.entries(persistedAssignments).some(([deviceId, assignedScreen]) =>
                assignedScreen !== null && assignedScreen > preset.totalScreens
                && devices.has(deviceId))) {
                respond({
                    ok: false,
                    message: 'Reassign devices above the preset screen count before loading this layout.'
                });
                return;
            }
            try {
                await updateSettings(() => {
                    totalScreens = preset.totalScreens;
                    displayLayout = cloneDisplayLayout(preset.layout);
                });
            } catch (error) {
                console.error('Unable to persist loaded layout preset:', error);
                respond({ ok: false, message: 'Unable to load layout preset' });
                return;
            }
            await broadcastScreenConfiguration();
            respond({ ok: true, name: preset.name, ...getScreenConfigSnapshot() });
        });

        socket.on('layout-presets:delete', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized layout preset request' });
                return;
            }
            const name = typeof request?.name === 'string' ? request.name.trim() : '';
            if (!name || name.toLowerCase() === 'default') {
                respond({ ok: false, message: 'The Default layout cannot be deleted.' });
                return;
            }
            const preset = layoutPresets.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
            if (!preset) {
                respond({ ok: false, message: 'Layout preset not found.' });
                return;
            }
            try {
                await updateSettings(() => {
                    layoutPresets = layoutPresets.filter((entry) => entry !== preset);
                });
            } catch (error) {
                console.error('Unable to persist layout preset deletion:', error);
                respond({ ok: false, message: 'Unable to delete layout preset' });
                return;
            }
            broadcastLayoutPresets();
            respond({ ok: true, presets: getLayoutPresetsSnapshot() });
        });

        socket.on('device:assign-screen', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized device assignment request' });
                return;
            }
            const deviceId = request?.deviceId;
            const screen = request?.screen;
            if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128
                || !(screen === null || (isScreenNumber(screen) && screen <= totalScreens))) {
                respond({ ok: false, message: 'Invalid device or screen assignment' });
                return;
            }
            const device = devices.get(deviceId);
            if (!device) {
                respond({ ok: false, message: 'Device is not registered' });
                return;
            }
            if (screen !== null && displayLayout.screens[screen]?.enabled !== true) {
                respond({ ok: false, message: `Screen ${screen} is disabled.` });
                return;
            }
            const conflictingDevice = screen === null
                ? null
                : [...devices.values()].find((entry) =>
                    entry.id !== deviceId && entry.screen === screen);
            const swapDeviceId = request?.swapDeviceId;
            if (swapDeviceId !== undefined
                && (typeof swapDeviceId !== 'string'
                    || !swapDeviceId.trim()
                    || swapDeviceId.length > 128
                    || !conflictingDevice
                    || conflictingDevice.id !== swapDeviceId
                    || device.screen === null)) {
                respond({
                    ok: false,
                    message: 'A safe swap requires the selected device and screen owner to both have assignments.'
                });
                return;
            }
            if (conflictingDevice && swapDeviceId !== conflictingDevice.id) {
                respond({
                    ok: false,
                    message: `Screen ${screen} is already assigned to ${conflictingDevice.id}.`
                });
                return;
            }

            try {
                await updateSettings(() => {
                    if (screen !== null && screen > totalScreens) {
                        throw new Error('SCREEN_COUNT_CHANGED');
                    }
                    const currentConflict = screen === null
                        ? null
                        : [...devices.values()].find((entry) =>
                            entry.id !== deviceId && entry.screen === screen);
                    if (currentConflict
                        && (swapDeviceId !== currentConflict.id || device.screen === null)) {
                        throw new Error(`SCREEN_ALREADY_ASSIGNED:${currentConflict.id}`);
                    }
                    if (currentConflict) {
                        persistedAssignments[currentConflict.id] = device.screen;
                        currentConflict.screen = device.screen;
                        currentConflict.displayStatus = 'waiting';
                        currentConflict.displayError = null;
                        currentConflict.loadedUpdateId = null;
                        currentConflict.reportedAlignmentRevision = null;
                    }
                    persistedAssignments[deviceId] = screen;
                    device.screen = screen;
                    device.displayStatus = 'waiting';
                    device.displayError = null;
                    device.loadedUpdateId = null;
                    device.reportedAlignmentRevision = null;
                });
            } catch (error) {
                if (error.message === 'SCREEN_COUNT_CHANGED') {
                    respond({ ok: false, message: 'Screen count changed. Refresh the assignment and try again.' });
                    return;
                }
                if (error.message.startsWith('SCREEN_ALREADY_ASSIGNED:')) {
                    const owner = error.message.slice('SCREEN_ALREADY_ASSIGNED:'.length);
                    respond({ ok: false, message: `Screen ${screen} is already assigned to ${owner}.` });
                    return;
                }
                console.error('Unable to persist device screen assignment:', error);
                respond({ ok: false, message: 'Unable to save device assignment' });
                return;
            }

            if (conflictingDevice) {
                emitDeviceConfiguration(conflictingDevice);
            }
            emitDeviceConfiguration(device);
            await broadcastScreenConfiguration();
            respond({
                ok: true,
                deviceId,
                screen,
                ...(conflictingDevice ? { swappedDeviceId: conflictingDevice.id } : {})
            });
        });

        socket.on('device:identify', (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized device identify request' });
                return;
            }
            const deviceId = request?.deviceId;
            if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
                respond({ ok: false, message: 'Invalid device ID' });
                return;
            }
            const device = devices.get(deviceId);
            if (!device || !device.socketId || device.screen === null) {
                respond({ ok: false, message: 'Device is not connected and assigned to a screen' });
                return;
            }
            io.sockets.sockets.get(device.socketId)?.emit('device:identify', {
                screen: device.screen,
                durationMs: 2500
            });
            respond({ ok: true, deviceId, screen: device.screen });
        });

        socket.on('device:report', (report) => {
            if (!report || typeof report !== 'object' || Array.isArray(report)
                || !Number.isInteger(report.screen)
                || !DISPLAY_STATES.has(report.displayStatus)
                || (report.alignmentRevision !== null
                    && (!Number.isInteger(report.alignmentRevision)
                        || report.alignmentRevision < 0
                        || report.alignmentRevision > alignmentRevision))
                || (report.loadedUpdateId !== null
                    && (typeof report.loadedUpdateId !== 'string'
                        || report.loadedUpdateId.length > 128))
                || (report.displayError !== null
                    && report.displayError !== undefined
                    && (typeof report.displayError !== 'string'
                        || report.displayError.length > 200))) {
                return;
            }

            const device = [...devices.values()].find(({ socketId }) => socketId === socket.id);
            if (!device || device.screen !== report.screen) {
                return;
            }

            device.displayStatus = report.displayStatus;
            device.displayError = report.displayStatus === 'error'
                ? (report.displayError ?? null)
                : null;
            if (report.displayStatus === 'ready' && report.loadedUpdateId) {
                device.loadedUpdateId = report.loadedUpdateId;
            }
            if (report.alignmentRevision !== null) {
                device.reportedAlignmentRevision = report.alignmentRevision;
            }
            device.lastActivity = new Date().toISOString();
            broadcastDiagnostics();
        });

        socket.on('playback:drift', (report) => {
            const hasDiagnostics = Boolean(report && typeof report === 'object'
                && report.status !== undefined);
            if (!report || typeof report !== 'object' || Array.isArray(report)
                || typeof report.mediaId !== 'string'
                || !Number.isFinite(report.positionSeconds)
                || report.positionSeconds < 0) {
                return;
            }
            if (hasDiagnostics && (
                (report.expectedPositionSeconds !== null
                    && !Number.isFinite(report.expectedPositionSeconds))
                || (report.driftSeconds !== null && !Number.isFinite(report.driftSeconds))
                || !['Playing', 'Paused', 'Stopped', 'Buffering', 'Stalled',
                    'Recovering', 'Error'].includes(report.status)
                || !Number.isInteger(report.readyState)
                || report.readyState < 0 || report.readyState > 4
                || !Number.isInteger(report.networkState)
                || report.networkState < 0 || report.networkState > 3
                || !['idle', 'buffering', 'error'].includes(report.bufferingState)
                || !Number.isFinite(report.playbackRate)
                || report.playbackRate < 0.25 || report.playbackRate > 4
                || typeof report.muted !== 'boolean'
                || !Number.isFinite(report.volume)
                || report.volume < 0 || report.volume > 1
                || (report.lastSuccessfulSynchronization !== null
                    && !Number.isFinite(report.lastSuccessfulSynchronization)))) {
                return;
            }
            const device = [...devices.values()].find(({ socketId }) => socketId === socket.id);
            if (!device || !device.socketId || playbackState.mediaId !== report.mediaId) {
                return;
            }
            const expected = getPlaybackPosition(playbackState);
            if (hasDiagnostics) {
                device.playbackDiagnostics = {
                    positionSeconds: report.positionSeconds,
                    expectedPositionSeconds: expected,
                    driftSeconds: expected - report.positionSeconds,
                    status: report.status,
                    readyState: report.readyState,
                    networkState: report.networkState,
                    bufferingState: report.bufferingState,
                    playbackRate: report.playbackRate,
                    muted: report.muted,
                    volume: report.volume,
                    lastSuccessfulSynchronization: report.lastSuccessfulSynchronization
                };
            }
            device.lastActivity = new Date().toISOString();
            if (hasDiagnostics) {
                broadcastDiagnostics();
            }
            if (playbackState.status !== 'playing'
                || Date.now() - (device.lastPlaybackCorrectionAt ?? 0) < 1500) {
                return;
            }
            if (Math.abs(expected - report.positionSeconds) > 0.3) {
                device.lastPlaybackCorrectionAt = Date.now();
                socket.emit('playback:sync', createPlaybackTimeline(playbackState));
            }
        });

        socket.on('calibration:set', async (state, acknowledge) => {
            const respond = typeof acknowledge === 'function'
                ? acknowledge
                : () => {};

            if (!controllers.has(socket.id)) {
                respond({
                    ok: false,
                    message: 'Unauthorized calibration request'
                });
                return;
            }

            if (typeof state?.enabled !== 'boolean') {
                respond({
                    ok: false,
                    message: 'Invalid calibration state'
                });
                return;
            }

            let settings;
            try {
                settings = await updateSettings(() => {
                    calibrationEnabled = state.enabled;
                });
            } catch (error) {
                console.error('Unable to persist calibration settings:', error);
                respond({
                    ok: false,
                    message: 'Unable to save calibration settings'
                });
                return;
            }

            io.to(deviceRoom).emit('calibration:update', {
                enabled: settings.calibrationEnabled
            });
            for (const controllerId of controllers) {
                io.sockets.sockets.get(controllerId)?.emit('calibration:current', {
                    enabled: settings.calibrationEnabled
                });
            }
            broadcastDiagnostics();

            respond({
                ok: true,
                enabled: settings.calibrationEnabled
            });
        });

        socket.on('alignment:set', async (state, acknowledge) => {
            const respond = typeof acknowledge === 'function'
                ? acknowledge
                : () => {};

            if (!controllers.has(socket.id)) {
                respond({
                    ok: false,
                    message: 'Unauthorized alignment request'
                });
                return;
            }

            if (!validateAlignment(state)) {
                respond({
                    ok: false,
                    message: 'Invalid alignment settings'
                });
                return;
            }

            try {
                await updateSettings(() => {
                    if (state.screen > totalScreens) {
                        throw new Error('ALIGNMENT_SCREEN_CHANGED');
                    }
                    alignmentSettings[state.screen] = {
                        horizontal: state.settings.horizontal,
                        vertical: state.settings.vertical,
                        scale: state.settings.scale
                    };
                });
            } catch (error) {
                if (error.message === 'ALIGNMENT_SCREEN_CHANGED') {
                    respond({ ok: false, message: 'Screen configuration changed. Refresh alignment settings and try again.' });
                    return;
                }
                console.error('Unable to persist alignment settings:', error);
                respond({
                    ok: false,
                    message: 'Unable to save alignment settings'
                });
                return;
            }
            const screens = getAlignmentSnapshot();

            broadcastAlignment(screens, socket.id);
            respond({
                ok: true,
                screen: state.screen,
                settings: screens[state.screen]
            });
        });

        socket.on('preset:save', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized preset request' });
                return;
            }

            const name = validatePresetName(request?.name);
            if (!name || name.toLowerCase() === DEFAULT_PRESET_NAME.toLowerCase()) {
                respond({
                    ok: false,
                    message: `Preset names must be 1-${MAX_PRESET_NAME_LENGTH} characters and cannot use the reserved name "Default".`
                });
                return;
            }

            try {
                await updateSettings(() => {
                    if (calibrationPresets.some((preset) =>
                        preset.name.toLowerCase() === name.toLowerCase())) {
                        throw new Error(`A preset named "${name}" already exists.`);
                    }
                    calibrationPresets = [
                        ...calibrationPresets,
                        {
                            name,
                            screenCount: totalScreens,
                            screens: getAlignmentSnapshot()
                        }
                    ];
                });
            } catch (error) {
                if (error.message.includes('already exists')) {
                    respond({ ok: false, message: error.message });
                    return;
                }
                console.error('Unable to persist calibration preset:', error);
                respond({ ok: false, message: 'Unable to save preset settings' });
                return;
            }

            broadcastPresets();
            respond({ ok: true, presets: getPresetsSnapshot() });
        });

        socket.on('preset:load', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized preset request' });
                return;
            }

            if (typeof request?.name !== 'string') {
                respond({ ok: false, message: 'Invalid preset name' });
                return;
            }

            const name = request.name.trim();
            const preset = name.toLowerCase() === DEFAULT_PRESET_NAME.toLowerCase()
                ? { name: DEFAULT_PRESET_NAME, screens: {} }
                : calibrationPresets.find((entry) =>
                    entry.name.toLowerCase() === name.toLowerCase());
            if (!preset) {
                respond({ ok: false, message: 'Preset not found' });
                return;
            }

            try {
                await updateSettings(() => {
                    for (let screen = 1; screen <= totalScreens; screen += 1) {
                        alignmentSettings[screen] = preset.screens[screen]
                            ? { ...preset.screens[screen] }
                            : createDefaultAlignment();
                    }
                });
            } catch (error) {
                console.error('Unable to persist loaded calibration preset:', error);
                respond({ ok: false, message: 'Unable to load preset settings' });
                return;
            }

            broadcastAlignment(getAlignmentSnapshot(), socket.id);
            respond({ ok: true, name: preset.name, screens: getAlignmentSnapshot() });
        });

        socket.on('preset:delete', async (request, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
            if (!controllers.has(socket.id)) {
                respond({ ok: false, message: 'Unauthorized preset request' });
                return;
            }

            if (typeof request?.name !== 'string'
                || request.name.trim().toLowerCase() === DEFAULT_PRESET_NAME.toLowerCase()) {
                respond({ ok: false, message: 'The Default preset cannot be deleted' });
                return;
            }

            const name = request.name.trim();
            let deleted = false;
            try {
                await updateSettings(() => {
                    const matchingPreset = calibrationPresets.find((preset) =>
                        preset.name.toLowerCase() === name.toLowerCase());
                    if (!matchingPreset) {
                        throw new Error('Preset not found');
                    }
                    calibrationPresets = calibrationPresets.filter((preset) =>
                        preset !== matchingPreset);
                    deleted = true;
                });
            } catch (error) {
                if (error.message === 'Preset not found') {
                    respond({ ok: false, message: error.message });
                    return;
                }
                console.error('Unable to persist preset deletion:', error);
                respond({ ok: false, message: 'Unable to delete preset' });
                return;
            }

            if (deleted) {
                broadcastPresets();
            }
            respond({ ok: true, presets: getPresetsSnapshot() });
        });

        socket.on('disconnect', (reason) => {
            console.log(`Socket disconnected: ${socket.id} (${reason})`);
            controllers.delete(socket.id);
            controllerUploadTokens.delete(socket.id);

            for (const [token, session] of visionSessions.entries()) {
                if (session.controllerId === socket.id || session.cameraSocketId === socket.id) {
                    if (session.controllerId === socket.id) {
                        visionSessions.delete(token);
                    } else {
                        session.cameraSocketId = null;
                        session.status = 'waiting';
                        io.sockets.sockets.get(session.controllerId)?.emit('vision:camera:status', {
                            connected: false,
                            token,
                            status: 'waiting'
                        });
                    }
                }
            }
            if ([...visionSessions.values()].every((session) => !session.cameraSocketId)) {
                setVisionMarkerMode(false);
            }

            for (const [deviceId, device] of devices) {
                if (device.socketId !== socket.id) {
                    continue;
                }

                device.socketId = null;
                device.disconnectTimer = setTimeout(() => {
                    if (devices.get(deviceId) !== device || device.socketId !== null) {
                        return;
                    }

                    device.disconnectTimer = null;
                    console.log(`Device remains available for reassignment: ${deviceId} | Screen ${device.screen}`);
                    broadcastDeviceSnapshot();
                    broadcastDiagnostics();
                }, reservationMs);
                device.disconnectTimer.unref?.();
                console.log(`Device reservation retained for ${reservationMs}ms: ${deviceId} | Screen ${device.screen}`);
            }
            broadcastDeviceSnapshot();
            broadcastDiagnostics();
        });
    });

    app.get('/', (req, res) => {
        res.send('PARALLAX SERVER ONLINE');
    });

    async function close() {
        if (scheduleTimer) {
            clearInterval(scheduleTimer);
            scheduleTimer = null;
        }
        for (const device of devices.values()) {
            if (device.disconnectTimer) {
                clearTimeout(device.disconnectTimer);
            }
        }
        for (const timer of pairingTimers.values()) {
            clearTimeout(timer);
        }
        pairingTimers.clear();
        pairingSessions.clear();
        visionSessions.clear();

        await mediaUpdateQueue;
        await new Promise((resolveClose) => io.close(resolveClose));
    }

    return { app, server, io, close, ready };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { server, ready } = createParallaxServer();
    const port = Number(process.env.PORT || 3001);
    ready.then(() => {
        server.listen(port, '0.0.0.0', () => {
            console.log(`PARALLAX SERVER ONLINE: ${port}`);
        });
    }).catch((error) => {
        console.error('Unable to load calibration settings:', error);
        process.exitCode = 1;
    });
}

function createDefaultAlignment() {
    return { horizontal: 0, vertical: 0, scale: 1 };
}

function createDefaultAlignmentSettings(count = MAX_SCREEN_COUNT) {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [index + 1, createDefaultAlignment()])
    );
}

function createAlignmentSnapshot(count, settings) {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
            const screen = index + 1;
            return [screen, { ...(settings[screen] ?? createDefaultAlignment()) }];
        })
    );
}

function cloneAlignmentSettings(settings) {
    return Object.fromEntries(
        Object.entries(settings).map(([screen, value]) => [screen, { ...value }])
    );
}

function createDeviceRecord(id, screen) {
    return {
        id,
        screen,
        socketId: null,
        disconnectTimer: null,
        displayStatus: 'waiting',
        displayError: null,
        lastActivity: null,
        loadedUpdateId: null,
        reportedAlignmentRevision: null,
        playbackDiagnostics: null
    };
}

function isScreenCount(value) {
    return Number.isInteger(value) && value >= MIN_SCREEN_COUNT && value <= MAX_SCREEN_COUNT;
}

function isScreenNumber(value) {
    return Number.isInteger(value) && value >= 1 && value <= MAX_SCREEN_COUNT;
}

function createDefaultSettings() {
    return {
        calibrationEnabled: false,
        totalScreens: MIN_SCREEN_COUNT,
        assignmentMode: 'automatic',
        assignments: {},
        markerAssignments: {},
        screens: createDefaultAlignmentSettings(MAX_SCREEN_COUNT),
        presets: [],
        layout: createDefaultLayout(MIN_SCREEN_COUNT),
        layoutPresets: []
    };
}

function createStoppedPlayback(mediaId = null, transition = 'none', volume = 0) {
    return {
        status: 'stopped',
        mediaId,
        positionSeconds: 0,
        volume,
        startedAt: null,
        timelineId: randomUUID(),
        playlistId: null,
        playlistIndex: 0,
        nextPlaylistIndex: null,
        transition: TRANSITIONS.includes(transition) ? transition : 'none'
    };
}

function cloneDisplayLayout(layout) {
    return {
        type: layout.type,
        rows: layout.rows,
        columns: layout.columns,
        screens: Object.fromEntries(
            Object.entries(layout.screens).map(([screen, position]) => [
                screen,
                { ...position }
            ])
        )
    };
}

function resizeDisplayLayout(layout, totalScreens) {
    if (layout.type !== 'custom') {
        const rows = layout.type === 'vertical' ? totalScreens : layout.rows;
        const columns = layout.type === 'vertical'
            ? 1
            : layout.type === 'horizontal'
                ? totalScreens
                : Math.max(layout.columns, Math.ceil(totalScreens / layout.rows));
        return createDefaultLayout(totalScreens, layout.type, rows, columns);
    }
    const next = cloneDisplayLayout(layout);
    next.screens = Object.fromEntries(
        Object.entries(next.screens).filter(([screen]) => Number(screen) <= totalScreens)
    );
    for (let screen = 1; screen <= totalScreens; screen += 1) {
        if (!next.screens[screen]) {
            let column = 0;
            while (Object.values(next.screens).some((position) =>
                position.row === 0 && position.column === column)) {
                column += 1;
            }
            next.screens[screen] = {
                row: 0,
                column,
                rotation: 0,
                orientation: 'auto',
                enabled: true
            };
            next.columns = Math.max(next.columns, column + 1);
        }
    }
    return next;
}

function validatePresetName(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const name = value.trim();
    if (!name || name.length > MAX_PRESET_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
        return null;
    }
    return name;
}

function validateMediaName(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const name = value.trim();
    return name && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name)
        ? name
        : null;
}

function isValidStoredSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || typeof settings.calibrationEnabled !== 'boolean'
        || !settings.screens || typeof settings.screens !== 'object'
        || Array.isArray(settings.screens)) {
        return false;
    }

    return true;
}

function isValidStoredPreset(preset) {
    return preset && typeof preset === 'object' && !Array.isArray(preset)
        && validatePresetName(preset.name) === preset.name
        && preset.screens && typeof preset.screens === 'object' && !Array.isArray(preset.screens)
        && [1, 2].every((screen) => validateStoredAlignment(preset.screens[screen]))
        && (preset.screenCount === undefined || isScreenCount(preset.screenCount));
}

function normalizeStoredPreset(preset) {
    const screens = {};
    for (let screen = 1; screen <= MAX_SCREEN_COUNT; screen += 1) {
        screens[screen] = validateStoredAlignment(preset.screens[screen])
            ? { ...preset.screens[screen] }
            : createDefaultAlignment();
    }
    return {
        name: preset.name,
        screenCount: preset.screenCount ?? MIN_SCREEN_COUNT,
        screens
    };
}

function validateStoredAlignment(settings) {
    return settings && typeof settings === 'object' && !Array.isArray(settings)
        && Number.isFinite(settings.horizontal)
        && settings.horizontal >= -50
        && settings.horizontal <= 50
        && Number.isFinite(settings.vertical)
        && settings.vertical >= -50
        && settings.vertical <= 50
        && Number.isFinite(settings.scale)
        && settings.scale >= 0.95
        && settings.scale <= 1.05;
}