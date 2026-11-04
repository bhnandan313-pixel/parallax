import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as createSocket } from 'socket.io-client';
import sharp from 'sharp';
import { createParallaxServer } from '../server.js';

async function startServer(options) {
    const uploadDirectory = await mkdtemp(join(tmpdir(), 'parallax-test-'));
    const instance = createParallaxServer({
        publicBaseUrl: 'http://parallax-test.invalid:3001',
        ...options,
        uploadDirectory
    });
    await new Promise((resolve, reject) => {
        instance.server.once('error', reject);
        instance.server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = instance.server.address();
    return {
        ...instance,
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            await instance.close();
            await rm(uploadDirectory, { recursive: true, force: true });
        }
    };
}

function registerDevice(url, deviceId) {
    return new Promise((resolve, reject) => {
        const socket = createSocket(url, {
            reconnection: false,
            timeout: 3000
        });
        const initialContent = new Promise((resolve) => {
            socket.once('content:update', resolve);
        });
        const initialCalibration = new Promise((resolve) => {
            socket.once('calibration:update', resolve);
        });
        const timer = setTimeout(() => {
            socket.disconnect();
            reject(new Error(`Timed out registering ${deviceId}`));
        }, 5000);

        socket.once('connect_error', (error) => {
            clearTimeout(timer);
            socket.disconnect();
            reject(error);
        });
        socket.once('device:assigned', (assignment) => {
            clearTimeout(timer);
            resolve({ socket, assignment, initialContent, initialCalibration });
        });
        socket.once('device:rejected', (result) => {
            clearTimeout(timer);
            resolve({ socket, rejection: result, initialContent, initialCalibration });
        });
        socket.on('connect', () => {
            socket.emit('device:register', deviceId);
        });
    });
}

test('authorizes calibration controllers and synchronizes current state to displays', async () => {
    const server = await startServer({ reservationMs: 80 });
    const clients = [];

    try {
        const first = await registerDevice(server.url, 'calibration-phone-one');
        clients.push(first.socket);
        assert.deepEqual(await first.initialCalibration, { enabled: false });

        const second = await registerDevice(server.url, 'calibration-phone-two');
        clients.push(second.socket);
        assert.deepEqual(await second.initialCalibration, { enabled: false });

        const controller = await connectClient(server.url);
        clients.push(controller);
        const currentCalibration = nextEvent(controller, 'calibration:current');
        controller.emit('controller:register');
        assert.deepEqual(await currentCalibration, { enabled: false });

        const enableFirst = nextEvent(first.socket, 'calibration:update');
        const enableSecond = nextEvent(second.socket, 'calibration:update');
        const enableResult = new Promise((resolve) => {
            controller.emit('calibration:set', { enabled: true }, resolve);
        });
        assert.deepEqual(await enableFirst, { enabled: true });
        assert.deepEqual(await enableSecond, { enabled: true });
        assert.deepEqual(await enableResult, { ok: true, enabled: true });

        const disableFirst = nextEvent(first.socket, 'calibration:update');
        const disableSecond = nextEvent(second.socket, 'calibration:update');
        const disableResult = new Promise((resolve) => {
            controller.emit('calibration:set', { enabled: false }, resolve);
        });
        assert.deepEqual(await disableFirst, { enabled: false });
        assert.deepEqual(await disableSecond, { enabled: false });
        assert.deepEqual(await disableResult, { ok: true, enabled: false });

        const enableAgainFirst = nextEvent(first.socket, 'calibration:update');
        const enableAgainSecond = nextEvent(second.socket, 'calibration:update');
        const enableAgainResult = new Promise((resolve) => {
            controller.emit('calibration:set', { enabled: true }, resolve);
        });
        assert.deepEqual(await enableAgainFirst, { enabled: true });
        assert.deepEqual(await enableAgainSecond, { enabled: true });
        assert.deepEqual(await enableAgainResult, { ok: true, enabled: true });

        await waitForDisconnect(first.socket);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const replacement = await registerDevice(server.url, 'calibration-phone-three');
        clients.push(replacement.socket);
        assert.equal(replacement.assignment.screen, 1);
        assert.deepEqual(await replacement.initialCalibration, { enabled: true });

        const unregistered = await connectClient(server.url);
        clients.push(unregistered);
        const unauthorizedResult = new Promise((resolve) => {
            unregistered.emit('calibration:set', { enabled: false }, resolve);
        });
        assert.deepEqual(await unauthorizedResult, {
            ok: false,
            message: 'Unauthorized calibration request'
        });

        const invalidResult = new Promise((resolve) => {
            controller.emit('calibration:set', { enabled: 'false' }, resolve);
        });
        assert.deepEqual(await invalidResult, {
            ok: false,
            message: 'Invalid calibration state'
        });

        const currentAfterRejections = nextEvent(controller, 'calibration:current');
        controller.emit('controller:register');
        assert.deepEqual(await currentAfterRejections, { enabled: true });
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }
});

function connectClient(url) {
    return new Promise((resolve, reject) => {
        const socket = createSocket(url, {
            reconnection: false,
            timeout: 3000
        });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

function nextEvent(socket, eventName) {
    return new Promise((resolve) => socket.once(eventName, resolve));
}

function waitForDisconnect(socket) {
    return new Promise((resolve) => {
        socket.once('disconnect', resolve);
        socket.disconnect();
    });
}

test('allocates stable screens, rejects overflow, expires stale devices, and recovers after restart', async () => {
    let server = await startServer({ reservationMs: 120 });
    let clients = [];

    try {
        const first = await registerDevice(server.url, 'phone-one');
        clients.push(first.socket);
        assert.equal(first.assignment.screen, 1);
        assert.deepEqual(await first.initialContent, {
            contentType: 'image',
            imageUrl: '/panorama.jpg',
            updateId: 'default-panorama'
        });

        const second = await registerDevice(server.url, 'phone-two');
        clients.push(second.socket);
        assert.equal(second.assignment.screen, 2);

        const control = await connectClient(server.url);
        clients.push(control);
        const update = {
            contentType: 'image',
            imageUrl: '/panorama-next.jpg',
            updateId: 'milestone-two-update'
        };
        const firstUpdate = nextEvent(first.socket, 'content:update');
        const secondUpdate = nextEvent(second.socket, 'content:update');
        const publishResult = new Promise((resolve) => {
            control.emit('content:update', update, resolve);
        });
        assert.deepEqual(await firstUpdate, update);
        assert.deepEqual(await secondUpdate, update);
        assert.deepEqual(await publishResult, {
            ok: true,
            updateId: 'milestone-two-update'
        });

        const rejection = nextEvent(control, 'content:rejected');
        const rejectResult = new Promise((resolve) => {
            control.emit('content:update', {
                ...update,
                imageUrl: 'javascript:alert(1)',
                updateId: 'invalid-update'
            }, resolve);
        });
        assert.match((await rejection).message, /Invalid content update/);
        assert.equal((await rejectResult).ok, false);
        const relativeUrlRejection = nextEvent(control, 'content:rejected');
        const rejectRelativeResult = new Promise((resolve) => {
            control.emit('content:update', {
                ...update,
                imageUrl: '//other-host.example/image.jpg',
                updateId: 'invalid-relative-update'
            }, resolve);
        });
        assert.match((await relativeUrlRejection).message, /Invalid content update/);
        assert.equal((await rejectRelativeResult).ok, false);

        const third = await registerDevice(server.url, 'phone-three');
        clients.push(third.socket);
        assert.match(third.rejection.message, /Both screens are assigned/);

        const uploadedPng = await sharp({
            create: {
                width: 8,
                height: 4,
                channels: 3,
                background: { r: 120, g: 40, b: 200 }
            }
        }).png().toBuffer();
        const formData = new FormData();
        formData.append('image', new Blob([uploadedPng], { type: 'text/plain' }), 'renamed.txt');
        const firstUploadUpdate = nextEvent(first.socket, 'content:update');
        const secondUploadUpdate = nextEvent(second.socket, 'content:update');
        const uploadResponse = await fetch(`${server.url}/api/upload`, {
            method: 'POST',
            headers: { Origin: 'http://127.0.0.1:5173' },
            body: formData
        });
        assert.equal(uploadResponse.status, 201);
        assert.equal(
            uploadResponse.headers.get('access-control-allow-origin'),
            'http://127.0.0.1:5173'
        );
        const uploadedImage = await uploadResponse.json();
        assert.equal(
            new URL(uploadedImage.imageUrl).hostname,
            'parallax-test.invalid',
            'published upload URL must be reachable by phones, not localhost'
        );
        let latestUploadedImage = uploadedImage;
        assert.equal(uploadedImage.contentType, 'image');
        assert.equal(uploadedImage.mimeType, 'image/png');
        assert.equal(uploadedImage.width, 8);
        assert.equal(uploadedImage.height, 4);
        assert.equal(uploadedImage.size, uploadedPng.length);
        assert.equal(uploadedImage.connectedDevices, 2);
        assert.match(uploadedImage.filename, /^[\da-f-]+\.png$/);
        assert.deepEqual(await firstUploadUpdate, {
            contentType: 'image',
            imageUrl: uploadedImage.imageUrl,
            updateId: uploadedImage.updateId
        });
        assert.deepEqual(await secondUploadUpdate, {
            contentType: 'image',
            imageUrl: uploadedImage.imageUrl,
            updateId: uploadedImage.updateId
        });

        const servedImageResponse = await fetch(
            `${server.url}${new URL(uploadedImage.imageUrl).pathname}`
        );
        assert.equal(servedImageResponse.status, 200);
        assert.deepEqual(Buffer.from(await servedImageResponse.arrayBuffer()), uploadedPng);

        const preflightResponse = await fetch(`${server.url}/api/upload`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://127.0.0.1:5173',
                'Access-Control-Request-Method': 'POST'
            }
        });

        assert.equal(preflightResponse.status, 204);

        const hostileOriginResponse = await fetch(`${server.url}/api/upload`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://attacker.example:5173',
                'Access-Control-Request-Method': 'POST'
            }
        });
        assert.equal(hostileOriginResponse.status, 403);

        for (const [mimeType, extension, toBuffer] of [
            ['image/jpeg', 'jpg', (image) => image.jpeg().toBuffer()],
            ['image/webp', 'webp', (image) => image.webp().toBuffer()]
        ]) {
            const imageBuffer = await toBuffer(sharp({
                create: {
                    width: 3,
                    height: 2,
                    channels: 3,
                    background: { r: 20, g: 130, b: 80 }
                }
            }));
            const imageForm = new FormData();
            imageForm.append('image', new Blob([imageBuffer], { type: mimeType }), `test.${extension}`);
            const imageResponse = await fetch(`${server.url}/api/upload`, {
                method: 'POST',
                body: imageForm
            });
            assert.equal(imageResponse.status, 201);
            const imageResult = await imageResponse.json();
            latestUploadedImage = imageResult;
            assert.equal(imageResult.mimeType, mimeType);
            assert.equal(imageResult.filename.split('.').at(-1), extension);
            assert.equal(imageResult.width, 3);
            assert.equal(imageResult.height, 2);
        }

        const invalidImageForm = new FormData();
        invalidImageForm.append('image', new Blob(['not an image']), 'fake.png');
        const invalidImageResponse = await fetch(`${server.url}/api/upload`, {
            method: 'POST',
            body: invalidImageForm
        });
        assert.equal(invalidImageResponse.status, 415);

        const oversizedForm = new FormData();
        oversizedForm.append(
            'image',
            new Blob([Buffer.alloc(15 * 1024 * 1024 + 1)], { type: 'image/png' }),
            'too-large.png'
        );
        const oversizedResponse = await fetch(`${server.url}/api/upload`, {
            method: 'POST',
            body: oversizedForm
        });
        assert.equal(oversizedResponse.status, 413);

        await waitForDisconnect(first.socket);
        const refreshedFirst = await registerDevice(server.url, 'phone-one');
        clients.push(refreshedFirst.socket);
        assert.equal(refreshedFirst.assignment.screen, 1);
        assert.deepEqual(await refreshedFirst.initialContent, {
            contentType: 'image',
            imageUrl: latestUploadedImage.imageUrl,
            updateId: latestUploadedImage.updateId
        });

        await waitForDisconnect(refreshedFirst.socket);
        const reconnectedFirst = await registerDevice(server.url, 'phone-one');
        clients.push(reconnectedFirst.socket);
        assert.equal(reconnectedFirst.assignment.screen, 1);

        await waitForDisconnect(reconnectedFirst.socket);
        await waitForDisconnect(second.socket);
        await new Promise((resolve) => setTimeout(resolve, 160));

        const replacement = await registerDevice(server.url, 'phone-three');
        clients.push(replacement.socket);
        assert.equal(replacement.assignment.screen, 1);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }

    server = await startServer({ reservationMs: 120 });
    clients = [];
    try {
        const firstAfterRestart = await registerDevice(server.url, 'phone-one');
        clients.push(firstAfterRestart.socket);
        assert.equal(firstAfterRestart.assignment.screen, 1);

        const secondAfterRestart = await registerDevice(server.url, 'phone-two');
        clients.push(secondAfterRestart.socket);
        assert.equal(secondAfterRestart.assignment.screen, 2);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }
});

test('uses a LAN-reachable image URL when uploads arrive through localhost', async () => {
    const server = await startServer({ publicBaseUrl: null });
    try {
        const imageBuffer = await sharp({
            create: {
                width: 2,
                height: 2,
                channels: 3,
                background: { r: 10, g: 90, b: 180 }
            }
        }).png().toBuffer();
        const formData = new FormData();
        formData.append('image', new Blob([imageBuffer]), 'localhost-upload.png');

        const response = await fetch(`${server.url}/api/upload`, {
            method: 'POST',
            headers: { Origin: 'http://localhost:5173' },
            body: formData
        });
        assert.equal(response.status, 201);

        const upload = await response.json();
        assert.notEqual(new URL(upload.imageUrl).hostname, 'localhost');
        assert.notEqual(new URL(upload.imageUrl).hostname, '127.0.0.1');
        const reachableImage = await fetch(
            `${server.url}${new URL(upload.imageUrl).pathname}`
        );
        assert.equal(reachableImage.status, 200);
    } finally {
        await server.close();
    }
});
