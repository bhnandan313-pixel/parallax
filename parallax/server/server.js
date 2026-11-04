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
    const positions = [1, 2];
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
    let calibrationEnabled = false;
    const alignmentSettings = createDefaultAlignmentSettings();
    let settingsUpdateQueue = Promise.resolve();

    function getSettingsSnapshot() {
        return {
            calibrationEnabled,
            screens: getAlignmentSnapshot()
        };
    }

    async function writeSettings(settings) {
        const temporaryFile = `${calibrationFile}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
            await rename(temporaryFile, calibrationFile);
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

            const defaults = {
                calibrationEnabled: false,
                screens: createDefaultAlignmentSettings()
            };
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
            settings = {
                calibrationEnabled: false,
                screens: createDefaultAlignmentSettings()
            };
            shouldRepair = true;
        }

        if (!isValidStoredSettings(settings)) {
            console.warn(`Calibration settings are invalid; restoring defaults from ${calibrationFile}`);
            settings = {
                calibrationEnabled: false,
                screens: createDefaultAlignmentSettings()
            };
            shouldRepair = true;
        }

        if (shouldRepair) {
            await writeSettings(settings);
        }

        return settings;
    }

    const ready = loadSettings().then((settings) => {
        calibrationEnabled = settings.calibrationEnabled;
        alignmentSettings[1] = { ...settings.screens[1] };
        alignmentSettings[2] = { ...settings.screens[2] };
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
                    alignmentSettings[2] = previous.screens[2];
                    throw error;
                }
            }

            return updated;
        });
        settingsUpdateQueue = operation.catch(() => {});
        return operation;
    }

    function getAlignmentSnapshot() {
        return {
            1: { ...alignmentSettings[1] },
            2: { ...alignmentSettings[2] }
        };
    }

    function validateAlignment(state) {
        const settings = state?.settings;
        if (!state || typeof state !== 'object' || Array.isArray(state)
            || !Number.isInteger(state.screen)
            || ![1, 2].includes(state.screen)
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
            socketId
        }));
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
            console.log(`Image uploaded and published: ${filename} | ${metadata.width}x${metadata.height}`);
            io.to(deviceRoom).emit('content:update', content);

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

        socket.on('device:register', (deviceId) => {
            if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
                console.warn(`Device registration rejected for socket ${socket.id}: invalid device ID`);
                socket.emit('device:rejected', { message: 'Invalid device ID' });
                return;
            }

            let device = devices.get(deviceId);
            if (!device) {
                const usedScreens = [...devices.values()].map(({ screen }) => screen);
                const screen = positions.find((position) => !usedScreens.includes(position));

                if (!screen) {
                    console.warn(`Device registration rejected: screen capacity reached (${deviceId})`);
                    socket.emit('device:rejected', {
                        message: 'Both screens are assigned. Disconnect another device and try again.'
                    });
                    return;
                }

                device = { id: deviceId, screen, socketId: null, disconnectTimer: null };
                devices.set(deviceId, device);
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

            socket.emit('device:assigned', {
                deviceId: device.id,
                screen: device.screen
            });
            socket.emit('content:update', currentContent);
            socket.emit('calibration:update', {
                enabled: calibrationEnabled
            });
            socket.emit('alignment:update', {
                screens: getAlignmentSnapshot()
            });
            console.log(`Device assigned: ${device.id} | Screen ${device.screen} | Socket ${socket.id}`);
            broadcastDeviceSnapshot();
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
            console.log(`Content updated: ${currentContent.updateId} | ${currentContent.imageUrl}`);
            io.to(deviceRoom).emit('content:update', currentContent);
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
            broadcastDeviceSnapshot(socket);
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

            try {
                await updateSettings(() => {
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
                enabled: calibrationEnabled
            });

            respond({
                ok: true,
                enabled: calibrationEnabled
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
                    alignmentSettings[state.screen] = {
                        horizontal: state.settings.horizontal,
                        vertical: state.settings.vertical,
                        scale: state.settings.scale
                    };
                });
            } catch (error) {
                console.error('Unable to persist alignment settings:', error);
                respond({
                    ok: false,
                    message: 'Unable to save alignment settings'
                });
                return;
            }
            const screens = getAlignmentSnapshot();

            io.to(deviceRoom).emit('alignment:update', { screens });
            respond({
                ok: true,
                screen: state.screen,
                settings: screens[state.screen]
            });
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

                    devices.delete(deviceId);
                    console.log(`Device reservation expired: ${deviceId} | Screen ${device.screen}`);
                    broadcastDeviceSnapshot();
                }, reservationMs);
                device.disconnectTimer.unref?.();
                console.log(`Device reservation retained for ${reservationMs}ms: ${deviceId} | Screen ${device.screen}`);
            }
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

function createDefaultAlignmentSettings() {
    return {
        1: { horizontal: 0, vertical: 0, scale: 1 },
        2: { horizontal: 0, vertical: 0, scale: 1 }
    };
}

function isValidStoredSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || typeof settings.calibrationEnabled !== 'boolean'
        || !settings.screens || typeof settings.screens !== 'object'
        || Array.isArray(settings.screens)) {
        return false;
    }

    return [1, 2].every((screen) => validateStoredAlignment(settings.screens[screen]));
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