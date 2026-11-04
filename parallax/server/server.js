import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { Server } from 'socket.io';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_PRESET_NAME_LENGTH = 32;
const MIN_SCREEN_COUNT = 2;
const MAX_SCREEN_COUNT = 12;
const DEFAULT_PRESET_NAME = 'Default';
const DISPLAY_STATES = new Set(['waiting', 'loading', 'ready', 'error']);
const IMAGE_FORMATS = new Map([
    ['image/jpeg', { extension: 'jpg', sharpFormat: 'jpeg' }],
    ['image/png', { extension: 'png', sharpFormat: 'png' }],
    ['image/webp', { extension: 'webp', sharpFormat: 'webp' }]
]);

function getPrivateLanAddress() {
    const interfaces = Object.entries(networkInterfaces());
    const isVirtualInterface = (name) =>
        /virtual|vmware|virtualbox|docker|wsl|hyper-v|vethernet|loopback|bluetooth/i.test(name);
    const isPrivateIPv4 = (address) =>
        /^10\./.test(address)
        || /^192\.168\./.test(address)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
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
    publicBaseUrl = process.env.PARALLAX_PUBLIC_URL,
    uploadDirectory = fileURLToPath(new URL('./uploads/', import.meta.url)),
    calibrationFile = fileURLToPath(new URL('./data/calibration.json', import.meta.url))
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
    let currentContent = {
        contentType: 'image',
        imageUrl: '/panorama.jpg',
        updateId: 'default-panorama'
    };
    let contentUpdatedAt = null;
    let alignmentUpdatedAt = null;
    let calibrationEnabled = false;
    let totalScreens = 2;
    let assignmentMode = 'automatic';
    const alignmentSettings = createDefaultAlignmentSettings(MAX_SCREEN_COUNT);
    let calibrationPresets = [];
    let persistedAssignments = {};
    let alignmentRevision = 0;
    let settingsUpdateQueue = Promise.resolve();

    function getSettingsSnapshot() {
        return {
            calibrationEnabled,
            totalScreens,
            assignmentMode,
            assignments: { ...persistedAssignments },
            screens: getStoredAlignmentSnapshot(),
            presets: calibrationPresets.map(({ name, screens, screenCount }) => ({
                name,
                screenCount,
                screens: cloneAlignmentSettings(screens)
            }))
        };
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
            settings = {
                calibrationEnabled: settings.calibrationEnabled,
                totalScreens,
                assignmentMode,
                assignments: { ...persistedAssignments },
                screens: storedScreens,
                presets: validPresets
            };
        }

        if (shouldRepair) {
            await writeSettings(settings);
        }

        return settings;
    }

    const ready = loadSettings().then((settings) => {
        calibrationEnabled = settings.calibrationEnabled;
        alignmentSettings[1] = { ...settings.screens[1] };
        for (let screen = 2; screen <= MAX_SCREEN_COUNT; screen += 1) {
            alignmentSettings[screen] = { ...settings.screens[screen] };
        }
        calibrationPresets = settings.presets ?? [];
        totalScreens = settings.totalScreens ?? MIN_SCREEN_COUNT;
        assignmentMode = settings.assignmentMode ?? 'automatic';
        persistedAssignments = { ...(settings.assignments ?? {}) };
        for (const [id, screen] of Object.entries(persistedAssignments)) {
            devices.set(id, createDeviceRecord(id, screen));
        }
    });

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
                    totalScreens = previous.totalScreens;
                    assignmentMode = previous.assignmentMode;
                    persistedAssignments = previous.assignments;
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
            screen,
            connected: socketId !== null,
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

    function getScreenConfigSnapshot() {
        return {
            totalScreens,
            assignmentMode,
            screens: getAlignmentSnapshot()
        };
    }

    function getDeviceConfiguration(device) {
        return {
            deviceId: device.id,
            screen: device.screen,
            totalScreens,
            calibrationEnabled,
            alignment: device.screen ? { ...alignmentSettings[device.screen] } : null,
            currentContent
        };
    }

    function emitDeviceConfiguration(device, eventName = 'device:assignment-update') {
        if (!device.socketId) {
            return;
        }
        const target = io.sockets.sockets.get(device.socketId);
        if (!target) {
            return;
        }
        if (device.screen === null) {
            target.emit('device:unassigned', getDeviceConfiguration(device));
            return;
        }
        target.emit(eventName, getDeviceConfiguration(device));
        target.emit('content:update', currentContent);
        target.emit('calibration:update', { enabled: calibrationEnabled });
        target.emit('alignment:update', {
            screens: getAlignmentSnapshot(),
            revision: alignmentRevision
        });
    }

    function broadcastScreenConfiguration() {
        const payload = getScreenConfigSnapshot();
        io.emit('screen-config:update', payload);
        broadcastDeviceSnapshot();
        broadcastDiagnostics();
    }

    function getDiagnosticsSnapshot() {
        const activeDevices = [...devices.values()];
        return {
            backendConnected: true,
            activeDeviceCount: activeDevices.filter(({ socketId }) => socketId !== null).length,
            currentContent: { ...currentContent },
            contentUpdatedAt,
            calibrationEnabled,
            screens: getAlignmentSnapshot(),
            alignmentRevision,
            alignmentUpdatedAt,
            devices: Array.from({ length: totalScreens }, (_, index) => index + 1).map((screen) => {
                const device = activeDevices.find((entry) => entry.screen === screen);
                return {
                    screen,
                    deviceId: device?.id ?? null,
                    status: !device ? 'waiting' : device.socketId ? 'connected' : 'disconnected',
                    displayStatus: device?.displayStatus ?? 'unknown',
                    displayError: device?.displayError ?? null,
                    lastActivity: device?.lastActivity ?? null,
                    loadedUpdateId: device?.loadedUpdateId ?? null,
                    alignmentSynced: device?.socketId
                        ? device.reportedAlignmentRevision === alignmentRevision
                        : null
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

    app.use('/uploads', express.static(uploadDirectory, {
        dotfiles: 'deny',
        index: false,
        fallthrough: false
    }));

    app.use('/api/upload', (req, res, next) => {
        const origin = req.get('origin');
        if (origin) {
            let originUrl;
            try {
                originUrl = new URL(origin);
            } catch {
                res.status(403).json({ error: 'Upload origin is not allowed' });
                return;
            }

            const sameHost = originUrl.hostname === req.hostname;
            const loopbackOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname)
                && ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);
            const vitePort = Number(originUrl.port);
            const isVitePort = originUrl.port === '' || (vitePort >= 5173 && vitePort <= 5199);
            if ((!sameHost && !loopbackOrigin) || !isVitePort) {
                res.status(403).json({ error: 'Upload origin is not allowed' });
                return;
            }
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Vary', 'Origin');
        }
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });

    app.post('/api/upload', (req, res, next) => {
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

            const host = req.get('host');
            let baseUrl;
            if (publicBaseUrl) {
                baseUrl = new URL(publicBaseUrl);
            } else {
                baseUrl = new URL(`${req.protocol}://${host}`);
                if (['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)) {
                    const lanAddress = getPrivateLanAddress();
                    if (!lanAddress) {
                        throw new Error(
                            'Cannot create a phone-accessible image URL; configure PARALLAX_PUBLIC_URL'
                        );
                    }
                    baseUrl.hostname = lanAddress;
                }
            }
            if (!['http:', 'https:'].includes(baseUrl.protocol)) {
                throw new Error('PARALLAX_PUBLIC_URL must use HTTP or HTTPS');
            }
            const imageUrl = new URL(`/uploads/${filename}`, baseUrl).toString();
            const content = {
                contentType: 'image',
                imageUrl,
                updateId: randomUUID()
            };

            currentContent = content;
            contentUpdatedAt = new Date().toISOString();
            console.log(`Image uploaded and published: ${filename} | ${metadata.width}x${metadata.height}`);
            io.to(deviceRoom).emit('content:update', content);
            broadcastDiagnostics();

            res.status(201).json({
                ...content,
                filename,
                mimeType: detectedType.mime,
                width: metadata.width,
                height: metadata.height,
                size: req.file.size,
                connectedDevices: [...devices.values()]
                    .filter(({ socketId }) => socketId !== null).length
            });
        } catch (error) {
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
                            ).find((position) => !usedScreens.has(position));
                            if (!screen) {
                                throw new Error('SCREEN_CAPACITY');
                            }
                        }
                        device.screen = screen;
                        persistedAssignments[deviceId] = screen;
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
            socket.join(deviceRoom);

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

        socket.on('content:update', (content, acknowledge) => {
            const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
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

            currentContent = {
                contentType: content.contentType,
                imageUrl: content.imageUrl,
                updateId: content.updateId
            };
            contentUpdatedAt = new Date().toISOString();
            console.log(`Content updated: ${currentContent.updateId} | ${currentContent.imageUrl}`);
            io.to(deviceRoom).emit('content:update', currentContent);
            broadcastDiagnostics();
            respond({ ok: true, updateId: currentContent.updateId });
        });

        socket.on('controller:register', () => {
            controllers.add(socket.id);
            socket.emit('content:current', currentContent);
            socket.emit('calibration:current', {
                enabled: calibrationEnabled
            });
            socket.emit('alignment:current', {
                screens: getAlignmentSnapshot()
            });
            socket.emit('screen-config:current', getScreenConfigSnapshot());
            socket.emit('presets:current', { presets: getPresetsSnapshot() });
            socket.emit('diagnostics:update', getDiagnosticsSnapshot());
            broadcastDeviceSnapshot(socket);
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
            const conflictingDevice = Object.entries(persistedAssignments)
                .find(([id, assignedScreen]) => id !== deviceId && screen !== null
                    && assignedScreen === screen);
            if (conflictingDevice) {
                respond({
                    ok: false,
                    message: `Screen ${screen} is already assigned to ${conflictingDevice[0]}.`
                });
                return;
            }

            try {
                await updateSettings(() => {
                    if (screen !== null && screen > totalScreens) {
                        throw new Error('SCREEN_COUNT_CHANGED');
                    }
                    const currentConflict = Object.entries(persistedAssignments)
                        .find(([id, assignedScreen]) => id !== deviceId && screen !== null
                            && assignedScreen === screen);
                    if (currentConflict) {
                        throw new Error(`SCREEN_ALREADY_ASSIGNED:${currentConflict[0]}`);
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

            emitDeviceConfiguration(device);
            await broadcastScreenConfiguration();
            respond({ ok: true, deviceId, screen });
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
        for (const device of devices.values()) {
            if (device.disconnectTimer) {
                clearTimeout(device.disconnectTimer);
            }
        }

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
        reportedAlignmentRevision: null
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
        screens: createDefaultAlignmentSettings(MAX_SCREEN_COUNT),
        presets: []
    };
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