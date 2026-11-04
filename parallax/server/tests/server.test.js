import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as createSocket } from 'socket.io-client';
import sharp from 'sharp';
import { createParallaxServer } from '../server.js';
import { createDefaultLayout } from '../../src/display/geometry.js';

function defaultScreens(count = 12) {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [
        index + 1,
        { horizontal: 0, vertical: 0, scale: 1 }
    ]));
}

function storedSettings({ calibrationEnabled = false, screens = {}, assignments = {},
    totalScreens = 2, assignmentMode = 'automatic', presets = [],
    layout = defaultLayout(totalScreens), layoutPresets = [] } = {}) {
    return {
        calibrationEnabled,
        totalScreens,
        assignmentMode,
        assignments,
        screens: { ...defaultScreens(), ...screens },
        presets,
        layout,
        layoutPresets
    };
}

function defaultLayout(totalScreens) {
    return {
        type: 'horizontal',
        rows: 1,
        columns: totalScreens,
        screens: Object.fromEntries(Array.from({ length: totalScreens }, (_, index) => [
            index + 1,
            {
                row: 0,
                column: index,
                rotation: 0,
                orientation: 'auto',
                enabled: true
            }
        ]))
    };
}

async function startServer(options) {
    const {
        testDirectory: providedTestDirectory,
        calibrationFile: providedCalibrationFile,
        uploadDirectory: providedUploadDirectory,
        mediaManifestFile: providedMediaManifestFile,
        ...serverOptions
    } = options ?? {};
    const testDirectory = providedTestDirectory
        ?? await mkdtemp(join(tmpdir(), 'parallax-test-'));
    const uploadDirectory = providedUploadDirectory ?? join(testDirectory, 'uploads');
    const calibrationFile = providedCalibrationFile
        ?? join(testDirectory, 'data', 'calibration.json');
    const mediaManifestFile = providedMediaManifestFile
        ?? join(testDirectory, 'data', 'media.json');
    const instance = createParallaxServer({
        publicBaseUrl: 'http://parallax-test.invalid:3001',
        ...serverOptions,
        calibrationFile,
        mediaManifestFile,
        uploadDirectory
    });
    await instance.ready;
    await new Promise((resolve, reject) => {
        instance.server.once('error', reject);
        instance.server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = instance.server.address();
    return {
        ...instance,
        url: `http://127.0.0.1:${port}`,
        calibrationFile,
        mediaManifestFile,
        close: async () => {
            await instance.close();
            if (!providedTestDirectory) {
                await rm(testDirectory, { recursive: true, force: true });
            }
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
        const initialAlignment = new Promise((resolve) => {
            socket.once('alignment:update', resolve);
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
            resolve({
                socket,
                assignment,
                initialContent,
                initialCalibration,
                initialAlignment
            });
        });
        socket.once('device:rejected', (result) => {
            clearTimeout(timer);
            resolve({
                socket,
                rejection: result,
                initialContent,
                initialCalibration,
                initialAlignment
            });
        });
        socket.on('connect', () => {
            socket.emit('device:register', deviceId);
        });
    });
}

test('authorizes and synchronizes independent screen alignment settings', async () => {
    const server = await startServer({ reservationMs: 80 });
    const clients = [];

    try {
        const first = await registerDevice(server.url, 'alignment-phone-one');
        clients.push(first.socket);
        const second = await registerDevice(server.url, 'alignment-phone-two');
        clients.push(second.socket);

        const defaults = {
            1: { horizontal: 0, vertical: 0, scale: 1 },
            2: { horizontal: 0, vertical: 0, scale: 1 }
        };
        assert.deepEqual((await first.initialAlignment).screens, defaults);
        assert.deepEqual((await second.initialAlignment).screens, defaults);

        const controller = await connectClient(server.url);
        clients.push(controller);
        const currentAlignment = nextEvent(controller, 'alignment:current');
        controller.emit('controller:register');
        assert.deepEqual((await currentAlignment).screens, defaults);

        const screenOneSettings = { horizontal: 12, vertical: -8, scale: 1.03 };
        const firstUpdate = nextEvent(first.socket, 'alignment:update');
        const secondUpdate = nextEvent(second.socket, 'alignment:update');
        const screenOneResult = new Promise((resolve) => {
            controller.emit('alignment:set', {
                screen: 1,
                settings: screenOneSettings
            }, resolve);
        });
        const screenOnePayload = { screens: { ...defaults, 1: screenOneSettings }, revision: 1 };
        assert.deepEqual(await firstUpdate, screenOnePayload);
        assert.deepEqual(await secondUpdate, screenOnePayload);
        assert.deepEqual(await screenOneResult, {
            ok: true,
            screen: 1,
            settings: screenOneSettings
        });

        const screenTwoSettings = { horizontal: -20, vertical: 25, scale: 0.97 };
        const firstScreenTwoUpdate = nextEvent(first.socket, 'alignment:update');
        const secondScreenTwoUpdate = nextEvent(second.socket, 'alignment:update');
        const screenTwoResult = new Promise((resolve) => {
            controller.emit('alignment:set', {
                screen: 2,
                settings: screenTwoSettings
            }, resolve);
        });
        const bothScreens = {
            screens: { ...screenOnePayload.screens, 2: screenTwoSettings },
            revision: 2
        };
        assert.deepEqual(await firstScreenTwoUpdate, bothScreens);
        assert.deepEqual(await secondScreenTwoUpdate, bothScreens);
        assert.deepEqual(await screenTwoResult, {
            ok: true,
            screen: 2,
            settings: screenTwoSettings
        });

        const currentAlignmentAfterUpdate = nextEvent(controller, 'alignment:current');
        controller.emit('controller:register');
        assert.deepEqual((await currentAlignmentAfterUpdate).screens, bothScreens.screens);

        const invalidSettings = [
            { ...screenOneSettings, horizontal: '12' },
            { ...screenOneSettings, horizontal: Number.NaN },
            { ...screenOneSettings, vertical: null },
            { ...screenOneSettings, vertical: Number.POSITIVE_INFINITY },
            { ...screenOneSettings, scale: 1.06 },
            { ...screenOneSettings, horizontal: -51 },
            { ...screenOneSettings, vertical: 51 },
            { ...screenOneSettings, scale: 0.94 }
        ];
        for (const settings of invalidSettings) {
            const result = await new Promise((resolve) => {
                controller.emit('alignment:set', { screen: 1, settings }, resolve);
            });
            assert.deepEqual(result, {
                ok: false,
                message: 'Invalid alignment settings'
            });
        }

        for (const screen of [0, 3, '1']) {
            const result = await new Promise((resolve) => {
                controller.emit('alignment:set', {
                    screen,
                    settings: screenOneSettings
                }, resolve);
            });
            assert.equal(result.ok, false);
        }

        const unauthorized = await connectClient(server.url);
        clients.push(unauthorized);
        const unauthorizedResult = await new Promise((resolve) => {
            unauthorized.emit('alignment:set', {
                screen: 1,
                settings: { horizontal: 0, vertical: 0, scale: 1 }
            }, resolve);
        });
        assert.deepEqual(unauthorizedResult, {
            ok: false,
            message: 'Unauthorized alignment request'
        });

        await waitForDisconnect(first.socket);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const replacement = await registerDevice(server.url, 'alignment-phone-one');
        clients.push(replacement.socket);
        assert.equal(replacement.assignment.screen, 1);
        assert.deepEqual((await replacement.initialAlignment).screens, bothScreens.screens);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }
});

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
        const replacement = await registerDevice(server.url, 'calibration-phone-one');
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

test('creates default settings and restores calibration and independent alignment settings after restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-persistence-test-'));
    const defaultSettings = storedSettings();
    const screenOne = { horizontal: 20, vertical: 0, scale: 1 };
    const screenTwo = { horizontal: 0, vertical: -15, scale: 1 };
    let server = await startServer({ testDirectory });
    let clients = [];

    try {
        assert.deepEqual(JSON.parse(await readFile(server.calibrationFile, 'utf8')), defaultSettings);

        const controller = await connectClient(server.url);
        clients.push(controller);
        controller.emit('controller:register');
        const enableResult = await new Promise((resolve) => {
            controller.emit('calibration:set', { enabled: true }, resolve);
        });
        assert.deepEqual(enableResult, { ok: true, enabled: true });

        const screenOneResult = await new Promise((resolve) => {
            controller.emit('alignment:set', { screen: 1, settings: screenOne }, resolve);
        });
        assert.deepEqual(screenOneResult, { ok: true, screen: 1, settings: screenOne });

        const screenTwoResult = await new Promise((resolve) => {
            controller.emit('alignment:set', { screen: 2, settings: screenTwo }, resolve);
        });
        assert.deepEqual(screenTwoResult, { ok: true, screen: 2, settings: screenTwo });

        const savedSettings = storedSettings({
            calibrationEnabled: true,
            screens: { 1: screenOne, 2: screenTwo }
        });
        assert.deepEqual(JSON.parse(await readFile(server.calibrationFile, 'utf8')), savedSettings);

        for (const socket of clients) {
            socket.disconnect();
        }
        clients = [];
        await server.close();

        server = await startServer({ testDirectory });
        const firstPhone = await registerDevice(server.url, 'persisted-phone-one');
        clients.push(firstPhone.socket);
        const secondPhone = await registerDevice(server.url, 'persisted-phone-two');
        clients.push(secondPhone.socket);
        assert.equal(firstPhone.assignment.screen, 1);
        assert.equal(secondPhone.assignment.screen, 2);
        assert.deepEqual(await firstPhone.initialCalibration, { enabled: true });
        assert.deepEqual(await secondPhone.initialCalibration, { enabled: true });
        const activeSavedScreens = { 1: screenOne, 2: screenTwo };
        assert.deepEqual((await firstPhone.initialAlignment).screens, activeSavedScreens);
        assert.deepEqual((await secondPhone.initialAlignment).screens, activeSavedScreens);

        const restartedController = await connectClient(server.url);
        clients.push(restartedController);
        const currentCalibration = nextEvent(restartedController, 'calibration:current');
        const currentAlignment = nextEvent(restartedController, 'alignment:current');
        restartedController.emit('controller:register');
        assert.deepEqual(await currentCalibration, { enabled: true });
        assert.deepEqual((await currentAlignment).screens, activeSavedScreens);

        const resetSettings = { horizontal: 0, vertical: 0, scale: 1 };
        const resetResult = await new Promise((resolve) => {
            restartedController.emit('alignment:set', { screen: 1, settings: resetSettings }, resolve);
        });
        assert.deepEqual(resetResult, { ok: true, screen: 1, settings: resetSettings });
        assert.deepEqual(JSON.parse(await readFile(server.calibrationFile, 'utf8')),
            storedSettings({
                calibrationEnabled: true,
                assignments: {
                    'persisted-phone-one': 1,
                    'persisted-phone-two': 2
                },
                screens: { 1: resetSettings, 2: screenTwo }
            }));
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('configures four screens, persists assignments and presets, and restores them after restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-multi-screen-test-'));
    let server = await startServer({ testDirectory });
    let clients = [];

    try {
        const controller = await connectClient(server.url);
        clients.push(controller);
        controller.emit('controller:register');
        const configResult = await emitAck(controller, 'screen-config:set', {
            totalScreens: 12,
            assignmentMode: 'automatic'
        });
        assert.equal(configResult.ok, true);
        assert.equal(configResult.totalScreens, 12);
        assert.equal((await emitAck(controller, 'screen-config:set', {
            totalScreens: 4,
            assignmentMode: 'automatic'
        })).ok, true);

        const phones = [];
        for (let screen = 1; screen <= 4; screen += 1) {
            const phone = await registerDevice(server.url, `multi-phone-${screen}`);
            phones.push(phone);
            clients.push(phone.socket);
            assert.equal(phone.assignment.screen, screen);
            assert.equal(phone.assignment.totalScreens, 4);
            assert.deepEqual(Object.keys((await phone.initialAlignment).screens), ['1', '2', '3', '4']);
        }

        const screenFourSettings = { horizontal: 25, vertical: -15, scale: 1.02 };
        assert.deepEqual(await emitAck(controller, 'alignment:set', {
            screen: 4,
            settings: screenFourSettings
        }), { ok: true, screen: 4, settings: screenFourSettings });
        assert.equal((await emitAck(controller, 'preset:save', { name: 'Four screens' })).ok, true);
        assert.equal((await emitAck(controller, 'screen-config:set', {
            totalScreens: 3,
            assignmentMode: 'automatic'
        })).ok, false);

        const unauthorized = await connectClient(server.url);
        clients.push(unauthorized);
        assert.equal((await emitAck(unauthorized, 'screen-config:set', {
            totalScreens: 2,
            assignmentMode: 'manual'
        })).ok, false);
        assert.equal((await emitAck(unauthorized, 'device:assign-screen', {
            deviceId: 'multi-phone-4',
            screen: 3
        })).ok, false);
        assert.equal((await emitAck(controller, 'screen-config:set', {
            totalScreens: 13,
            assignmentMode: 'automatic'
        })).ok, false);

        for (const socket of clients) {
            socket.disconnect();
        }
        clients = [];
        await server.close();

        server = await startServer({ testDirectory });
        const restoredController = await connectClient(server.url);
        clients.push(restoredController);
        const currentConfig = nextEvent(restoredController, 'screen-config:current');
        const currentPresets = nextEvent(restoredController, 'presets:current');
        restoredController.emit('controller:register');
        assert.equal((await currentConfig).totalScreens, 4);
        assert.ok((await currentPresets).presets.some((preset) => preset.name === 'Four screens'));

        const restoredPhone = await registerDevice(server.url, 'multi-phone-4');
        clients.push(restoredPhone.socket);
        assert.equal(restoredPhone.assignment.screen, 4);
        assert.equal(restoredPhone.assignment.totalScreens, 4);
        assert.deepEqual((await restoredPhone.initialAlignment).screens[4], screenFourSettings);

        assert.equal((await emitAck(restoredController, 'screen-config:set', {
            totalScreens: 4,
            assignmentMode: 'manual'
        })).ok, true);
        const manualPhone = await connectClient(server.url);
        clients.push(manualPhone);
        const unassigned = nextEvent(manualPhone, 'device:unassigned');
        manualPhone.emit('device:register', 'manual-phone');
        assert.equal((await unassigned).screen, null);
        assert.equal((await emitAck(restoredController, 'device:assign-screen', {
            deviceId: 'manual-phone',
            screen: '4'
        })).ok, false);
        assert.equal((await emitAck(restoredController, 'device:assign-screen', {
            deviceId: 'manual-phone',
            screen: 4
        })).ok, false);
        assert.equal((await emitAck(restoredController, 'device:assign-screen', {
            deviceId: 'multi-phone-4',
            screen: null
        })).ok, true);

        const assignmentUpdate = nextEvent(manualPhone, 'device:assignment-update');
        assert.equal((await emitAck(restoredController, 'device:assign-screen', {
            deviceId: 'manual-phone',
            screen: 4
        })).ok, true);
        assert.equal((await assignmentUpdate).screen, 4);
        assert.equal(JSON.parse(await readFile(server.calibrationFile, 'utf8')).assignments['manual-phone'], 4);

        for (const socket of clients) {
            socket.disconnect();
        }
        clients = [];
        await server.close();

        server = await startServer({ testDirectory });
        const restoredManualPhone = await registerDevice(server.url, 'manual-phone');
        clients.push(restoredManualPhone.socket);
        assert.equal(restoredManualPhone.assignment.screen, 4);
        assert.equal(restoredManualPhone.assignment.totalScreens, 4);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('pairs display devices with secure, expiring, single-use controller sessions', async () => {
    const server = await startServer({
        pairingTtlMs: 500,
        pairingInterfaces: [
            { name: 'Wi-Fi', address: '192.168.10.20' },
            { name: 'Ethernet', address: '10.0.0.8' }
        ]
    });
    const clients = [];

    try {
        const unauthorizedController = await connectClient(server.url);
        clients.push(unauthorizedController);
        const unauthorizedCreate = await emitAck(unauthorizedController, 'pairing:create');
        assert.equal(unauthorizedCreate.ok, false);

        const controller = await connectClient(server.url);
        clients.push(controller);
        controller.emit('controller:register');
        const createdEvent = nextEvent(controller, 'pairing:created');
        const created = await emitAck(controller, 'pairing:create');
        assert.equal(created.ok, true);
        assert.match(created.token, /^[A-Za-z0-9_-]{40,64}$/);
        assert.equal(created.expiresAt > Date.now(), true);
        assert.deepEqual(created.interfaces, [
            { name: 'Wi-Fi', address: '192.168.10.20' },
            { name: 'Ethernet', address: '10.0.0.8' }
        ]);
        assert.equal((await createdEvent).token, created.token);

        const phone = await connectClient(server.url);
        clients.push(phone);
        const joinedEvent = nextEvent(controller, 'pairing:device-joined');
        const pairingResult = nextEvent(phone, 'pairing:result');
        assert.deepEqual(await emitAck(phone, 'pairing:join', { token: created.token }), { ok: true });
        assert.deepEqual(await pairingResult, { ok: true });
        await joinedEvent;

        const assignment = nextEvent(phone, 'device:assigned');
        phone.emit('device:register', 'paired-automatic-phone');
        assert.equal((await assignment).screen, 1);
        const controllerRejected = nextEvent(phone, 'controller:rejected');
        phone.emit('controller:register');
        assert.match((await controllerRejected).message, /cannot register as controllers/);
        assert.deepEqual(await emitAck(phone, 'calibration:set', { enabled: true }), {
            ok: false,
            message: 'Unauthorized calibration request'
        });

        const reusedPhone = await connectClient(server.url);
        clients.push(reusedPhone);
        const reused = await emitAck(reusedPhone, 'pairing:join', { token: created.token });
        assert.equal(reused.ok, false);
        assert.match(reused.message, /already been used/);

        const invalid = await emitAck(reusedPhone, 'pairing:join', { token: 'not-a-token' });
        assert.deepEqual(invalid, {
            ok: false,
            message: 'Invalid pairing link. Request a new QR code.'
        });

        const manualConfig = await emitAck(controller, 'screen-config:set', {
            totalScreens: 2,
            assignmentMode: 'manual'
        });
        assert.equal(manualConfig.ok, true);
        const manualPairing = await emitAck(controller, 'pairing:create');
        const manualPhone = await connectClient(server.url);
        clients.push(manualPhone);
        assert.deepEqual(await emitAck(manualPhone, 'pairing:join', {
            token: manualPairing.token
        }), { ok: true });
        const unassigned = nextEvent(manualPhone, 'device:unassigned');
        manualPhone.emit('device:register', 'paired-manual-phone');
        assert.equal((await unassigned).screen, null);
        assert.deepEqual(await emitAck(controller, 'device:assign-screen', {
            deviceId: 'paired-manual-phone',
            screen: 2
        }), { ok: true, deviceId: 'paired-manual-phone', screen: 2 });

        const expiringPairing = await emitAck(controller, 'pairing:create');
        await new Promise((resolve) => setTimeout(resolve, 550));
        const expiredPhone = await connectClient(server.url);
        clients.push(expiredPhone);
        const expiredEvent = nextEvent(expiredPhone, 'pairing:expired');
        const expired = await emitAck(expiredPhone, 'pairing:join', {
            token: expiringPairing.token
        });
        assert.equal(expired.ok, false);
        assert.equal(expired.expired, true);
        assert.match(expired.message, /expired/);
        assert.deepEqual(await expiredEvent, expired);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }
});

test('repairs corrupted calibration settings with safe defaults', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-corrupt-settings-test-'));
    const calibrationFile = join(testDirectory, 'data', 'calibration.json');
    let server;

    try {
        await mkdir(join(testDirectory, 'data'), { recursive: true });
        await writeFile(calibrationFile, '{"calibrationEnabled":', 'utf8');
        server = await startServer({ testDirectory });

        assert.deepEqual(JSON.parse(await readFile(calibrationFile, 'utf8')), storedSettings());

        const phone = await registerDevice(server.url, 'corrupt-settings-phone');
        try {
            assert.deepEqual(await phone.initialCalibration, { enabled: false });
            assert.deepEqual((await phone.initialAlignment).screens, {
                1: { horizontal: 0, vertical: 0, scale: 1 },
                2: { horizontal: 0, vertical: 0, scale: 1 }
            });
        } finally {
            phone.socket.disconnect();
        }
    } finally {
        if (server) {
            await server.close();
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('manages default and custom presets and restores saved presets and alignment after restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-preset-test-'));
    let server = await startServer({ testDirectory });
    let clients = [];

    try {
        const firstPhone = await registerDevice(server.url, 'preset-phone-one');
        clients.push(firstPhone.socket);
        const secondPhone = await registerDevice(server.url, 'preset-phone-two');
        clients.push(secondPhone.socket);

        const controller = await connectClient(server.url);
        clients.push(controller);
        const initialPresets = nextEvent(controller, 'presets:current');
        controller.emit('controller:register');
        const defaultPreset = (await initialPresets).presets[0];
        assert.deepEqual(defaultPreset, {
            name: 'Default',
            isDefault: true,
            screens: {
                1: { horizontal: 0, vertical: 0, scale: 1 },
                2: { horizontal: 0, vertical: 0, scale: 1 }
            }
        });

        const savedScreens = {
            1: { horizontal: 20.5, vertical: -10, scale: 1.025 },
            2: { horizontal: -12, vertical: 15.5, scale: 0.975 }
        };
        for (const screen of [1, 2]) {
            assert.equal((await emitAck(controller, 'alignment:set', {
                screen,
                settings: savedScreens[screen]
            })).ok, true);
        }

        const saveResult = await emitAck(controller, 'preset:save', { name: 'Center seam' });
        assert.equal(saveResult.ok, true);
        assert.ok(saveResult.presets.some((preset) =>
            preset.name === 'Center seam' && !preset.isDefault));
        assert.deepEqual(JSON.parse(await readFile(server.calibrationFile, 'utf8')).presets, [
            { name: 'Center seam', screenCount: 2, screens: savedScreens }
        ]);
        assert.match((await emitAck(controller, 'preset:save', { name: 'center SEAM' })).message, /already exists/);

        for (const name of ['', '   ', 'Default', `x${'a'.repeat(32)}`, 'bad\nname']) {
            assert.equal((await emitAck(controller, 'preset:save', { name })).ok, false);
        }
        assert.equal((await emitAck(controller, 'preset:delete', { name: 'Default' })).ok, false);

        const unauthorized = await connectClient(server.url);
        clients.push(unauthorized);
        for (const eventName of ['preset:save', 'preset:load', 'preset:delete']) {
            const result = await emitAck(unauthorized, eventName, { name: 'Center seam' });
            assert.equal(result.ok, false);
            assert.match(result.message, /Unauthorized/);
        }

        for (const screen of [1, 2]) {
            assert.equal((await emitAck(controller, 'alignment:set', {
                screen,
                settings: { horizontal: 0, vertical: 0, scale: 1 }
            })).ok, true);
        }

        const firstLoad = nextEvent(firstPhone.socket, 'alignment:update');
        const secondLoad = nextEvent(secondPhone.socket, 'alignment:update');
        const loadResult = await emitAck(controller, 'preset:load', { name: 'Center seam' });
        assert.deepEqual(loadResult.screens, savedScreens);
        assert.deepEqual((await firstLoad).screens, savedScreens);
        assert.deepEqual((await secondLoad).screens, savedScreens);

        const deleteResult = await emitAck(controller, 'preset:delete', { name: 'Center seam' });
        assert.equal(deleteResult.ok, true);
        const persistedAfterDelete = JSON.parse(await readFile(server.calibrationFile, 'utf8')).screens;
        assert.deepEqual({ 1: persistedAfterDelete[1], 2: persistedAfterDelete[2] }, savedScreens);
        assert.deepEqual(await emitAck(controller, 'preset:load', { name: 'Center seam' }), {
            ok: false,
            message: 'Preset not found'
        });

        assert.equal((await emitAck(controller, 'preset:save', { name: 'Persisted fine' })).ok, true);
        for (const socket of clients) {
            socket.disconnect();
        }
        clients = [];
        await server.close();

        server = await startServer({ testDirectory });
        const restartedPhoneOne = await registerDevice(server.url, 'preset-phone-one');
        clients.push(restartedPhoneOne.socket);
        const restartedPhoneTwo = await registerDevice(server.url, 'preset-phone-two');
        clients.push(restartedPhoneTwo.socket);
        assert.deepEqual((await restartedPhoneOne.initialAlignment).screens, savedScreens);
        assert.deepEqual((await restartedPhoneTwo.initialAlignment).screens, savedScreens);

        const restartedController = await connectClient(server.url);
        clients.push(restartedController);
        const restoredPresets = nextEvent(restartedController, 'presets:current');
        restartedController.emit('controller:register');
        assert.ok((await restoredPresets).presets.some((preset) => preset.name === 'Persisted fine'));

        const firstReset = nextEvent(restartedPhoneOne.socket, 'alignment:update');
        const secondReset = nextEvent(restartedPhoneTwo.socket, 'alignment:update');
        const reset = await emitAck(restartedController, 'preset:load', { name: 'Default' });
        assert.deepEqual(reset.screens, defaultPreset.screens);
        assert.deepEqual((await firstReset).screens, defaultPreset.screens);
        assert.deepEqual((await secondReset).screens, defaultPreset.screens);
        const resetScreens = JSON.parse(await readFile(server.calibrationFile, 'utf8')).screens;
        assert.deepEqual({ 1: resetScreens[1], 2: resetScreens[2] }, defaultPreset.screens);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('serializes concurrent settings changes and preserves valid settings while repairing invalid presets', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-concurrent-settings-test-'));
    const calibrationFile = join(testDirectory, 'data', 'calibration.json');
    let server;
    let controller;

    try {
        await mkdir(join(testDirectory, 'data'), { recursive: true });
        await writeFile(calibrationFile, JSON.stringify({
            calibrationEnabled: false,
            screens: {
                1: { horizontal: 18, vertical: 2, scale: 1 },
                2: { horizontal: -4, vertical: 7, scale: 0.99 }
            },
            presets: [
                { name: 'Valid', screens: {
                    1: { horizontal: 1, vertical: 1, scale: 1 },
                    2: { horizontal: 2, vertical: 2, scale: 1 }
                } },
                { name: 'Invalid', screens: { 1: {}, 2: {} } }
            ]
        }), 'utf8');

        server = await startServer({ testDirectory });
        const repaired = JSON.parse(await readFile(calibrationFile, 'utf8'));
        assert.deepEqual({ 1: repaired.screens[1], 2: repaired.screens[2] }, {
            1: { horizontal: 18, vertical: 2, scale: 1 },
            2: { horizontal: -4, vertical: 7, scale: 0.99 }
        });
        assert.deepEqual(
            Object.fromEntries(Object.entries(repaired.screens).filter(([screen]) => Number(screen) > 2)),
            Object.fromEntries(Object.entries(defaultScreens()).filter(([screen]) => Number(screen) > 2))
        );
        assert.deepEqual(repaired.presets.map(({ name }) => name), ['Valid']);

        controller = await connectClient(server.url);
        controller.emit('controller:register');
        const updates = [];
        for (let index = 0; index < 24; index += 1) {
            const screen = index % 2 + 1;
            const settings = {
                horizontal: index - 12,
                vertical: 12 - index,
                scale: 0.95 + (index % 11) / 100
            };
            updates.push(emitAck(controller, 'alignment:set', { screen, settings }));
        }
        for (let index = 0; index < 8; index += 1) {
            updates.push(emitAck(controller, 'calibration:set', { enabled: index % 2 === 0 }));
            updates.push(emitAck(controller, 'preset:save', { name: `Rapid ${index}` }));
        }
        const results = await Promise.all(updates);
        assert.ok(results.every((result) => result.ok));

        const persisted = JSON.parse(await readFile(calibrationFile, 'utf8'));
        assert.equal(persisted.presets.length, 9);
        assert.ok([1, 2].every((screen) =>
            Number.isFinite(persisted.screens[screen].horizontal)
            && Number.isFinite(persisted.screens[screen].vertical)
            && Number.isFinite(persisted.screens[screen].scale)));
        assert.equal(persisted.calibrationEnabled, false);
    } finally {
        controller?.disconnect();
        if (server) {
            await server.close();
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('publishes live device diagnostics and confirms alignment receipt per phone', async () => {
    const server = await startServer();
    const clients = [];

    try {
        const first = await registerDevice(server.url, 'diagnostics-phone-one');
        clients.push(first.socket);
        const second = await registerDevice(server.url, 'diagnostics-phone-two');
        clients.push(second.socket);
        const controller = await connectClient(server.url);
        clients.push(controller);
        const initialDiagnostics = nextEvent(controller, 'diagnostics:update');
        controller.emit('controller:register');
        const initial = await initialDiagnostics;
        assert.equal(initial.activeDeviceCount, 2);
        assert.ok(initial.devices.every((device) =>
            device.status === 'connected' && device.displayStatus === 'waiting'));

        const reports = [first, second];
        for (const phone of reports) {
            const report = nextEvent(controller, 'diagnostics:update');
            const alignment = await phone.initialAlignment;
            phone.socket.emit('device:report', {
                screen: phone.assignment.screen,
                displayStatus: 'ready',
                displayError: null,
                loadedUpdateId: 'default-panorama',
                alignmentRevision: alignment.revision
            });
            const update = await report;
            const device = update.devices.find((entry) => entry.screen === phone.assignment.screen);
            assert.equal(device.displayStatus, 'ready');
            assert.equal(device.alignmentSynced, true);
            assert.equal(device.loadedUpdateId, 'default-panorama');
            assert.ok(device.lastActivity);
        }

        const firstAlignmentUpdate = nextEvent(first.socket, 'alignment:update');
        const secondAlignmentUpdate = nextEvent(second.socket, 'alignment:update');
        assert.equal((await emitAck(controller, 'alignment:set', {
            screen: 1,
            settings: { horizontal: 3, vertical: 0, scale: 1 }
        })).ok, true);
        const firstAlignmentState = await firstAlignmentUpdate;
        const secondAlignmentState = await secondAlignmentUpdate;
        assert.equal(firstAlignmentState.revision, secondAlignmentState.revision);

        const firstReceipt = nextEvent(controller, 'diagnostics:update');
        first.socket.emit('device:report', {
            screen: 1,
            displayStatus: 'ready',
            displayError: null,
            loadedUpdateId: 'default-panorama',
            alignmentRevision: firstAlignmentState.revision
        });
        const firstReceiptState = await firstReceipt;
        assert.equal(firstReceiptState.devices.find((device) => device.screen === 1).alignmentSynced, true);
        assert.equal(firstReceiptState.devices.find((device) => device.screen === 2).alignmentSynced, false);

        const secondReceipt = nextEvent(controller, 'diagnostics:update');
        second.socket.emit('device:report', {
            screen: 2,
            displayStatus: 'ready',
            displayError: null,
            loadedUpdateId: 'default-panorama',
            alignmentRevision: secondAlignmentState.revision
        });
        const secondReceiptState = await secondReceipt;
        assert.ok(secondReceiptState.devices.every((device) => device.alignmentSynced));

        const displayErrorUpdate = nextEvent(controller, 'diagnostics:update');
        first.socket.emit('device:report', {
            screen: 1,
            displayStatus: 'error',
            displayError: 'Panorama failed to load',
            loadedUpdateId: 'default-panorama',
            alignmentRevision: firstAlignmentState.revision
        });
        const displayErrorState = await displayErrorUpdate;
        const firstDiagnostic = displayErrorState.devices.find((device) => device.screen === 1);
        assert.equal(firstDiagnostic.displayStatus, 'error');
        assert.equal(firstDiagnostic.displayError, 'Panorama failed to load');
        assert.equal(firstDiagnostic.loadedUpdateId, 'default-panorama');

        const disconnectedDiagnostics = nextEvent(controller, 'diagnostics:update');
        await waitForDisconnect(first.socket);
        const afterDisconnect = await disconnectedDiagnostics;
        assert.equal(
            afterDisconnect.devices.find((device) => device.screen === first.assignment.screen).status,
            'disconnected'
        );

        const replacement = await registerDevice(server.url, 'diagnostics-phone-one');
        clients.push(replacement.socket);
        assert.equal(replacement.assignment.screen, first.assignment.screen);
        assert.deepEqual((await replacement.initialAlignment).screens, {
            ...initial.screens,
            1: { horizontal: 3, vertical: 0, scale: 1 }
        });
        assert.deepEqual(await replacement.initialCalibration, { enabled: false });
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }
});

test('streams a four-screen dashboard snapshot and safely assigns and identifies devices', async () => {
    const server = await startServer({ reservationMs: 100 });
    const clients = [];

    try {
        const controller = await connectClient(server.url);
        clients.push(controller);
        controller.emit('controller:register');
        const screenCountUpdate = nextEvent(controller, 'screen-config:update');
        const configuration = await emitAck(controller, 'screen-config:set', {
            totalScreens: 4,
            assignmentMode: 'automatic'
        });
        assert.equal(configuration.ok, true);
        assert.equal(configuration.totalScreens, 4);
        assert.equal((await screenCountUpdate).totalScreens, 4);

        const phones = [];
        for (let screen = 1; screen <= 4; screen += 1) {
            const phone = await registerDevice(server.url, `dashboard-phone-${screen}`);
            phones.push(phone);
            clients.push(phone.socket);
            assert.equal(phone.assignment.screen, screen);
        }
        const dashboardSnapshot = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 300);
            const onSnapshot = (devices) => {
                if (devices.length !== 4) {
                    return;
                }
                clearTimeout(timer);
                controller.off('devices:update', onSnapshot);
                resolve(devices);
            };
            controller.on('devices:update', onSnapshot);
            controller.emit('controller:register');
        });
        assert.deepEqual(dashboardSnapshot.map(({ id, screen, connected }) =>
            ({ id, screen, connected })), [
            { id: 'dashboard-phone-1', screen: 1, connected: true },
            { id: 'dashboard-phone-2', screen: 2, connected: true },
            { id: 'dashboard-phone-3', screen: 3, connected: true },
            { id: 'dashboard-phone-4', screen: 4, connected: true }
        ]);

        const duplicate = await emitAck(controller, 'device:assign-screen', {
            deviceId: 'dashboard-phone-1',
            screen: 2
        });
        assert.equal(duplicate.ok, false);
        assert.match(duplicate.message, /already assigned/);

        const firstUpdate = nextEvent(phones[0].socket, 'device:assignment-update');
        const secondUpdate = nextEvent(phones[1].socket, 'device:assignment-update');
        const swapped = await emitAck(controller, 'device:assign-screen', {
            deviceId: 'dashboard-phone-1',
            screen: 2,
            swapDeviceId: 'dashboard-phone-2'
        });
        assert.deepEqual(swapped, {
            ok: true,
            deviceId: 'dashboard-phone-1',
            screen: 2,
            swappedDeviceId: 'dashboard-phone-2'
        });
        assert.equal((await firstUpdate).screen, 2);
        assert.equal((await secondUpdate).screen, 1);

        const identifyTargets = phones.map(() => 0);
        phones.forEach((phone, index) => {
            phone.socket.on('device:identify', () => {
                identifyTargets[index] += 1;
            });
        });
        const identified = nextEvent(phones[2].socket, 'device:identify');
        assert.deepEqual(await emitAck(controller, 'device:identify', {
            deviceId: 'dashboard-phone-3'
        }), {
            ok: true,
            deviceId: 'dashboard-phone-3',
            screen: 3
        });
        assert.deepEqual(await identified, { screen: 3, durationMs: 2500 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(identifyTargets, [0, 0, 1, 0]);

        const observer = await connectClient(server.url);
        clients.push(observer);
        const currentAlignment = nextEvent(observer, 'alignment:current');
        observer.emit('controller:register');
        await currentAlignment;
        const alignmentUpdate = nextEvent(observer, 'alignment:current');
        const screenTwoSettings = { horizontal: 8, vertical: -4, scale: 1.02 };
        assert.equal((await emitAck(controller, 'alignment:set', {
            screen: 2,
            settings: screenTwoSettings
        })).ok, true);
        assert.deepEqual((await alignmentUpdate).screens[2], screenTwoSettings);

        const controllerSnapshot = nextEvent(controller, 'devices:update');
        const diagnosticSnapshot = nextEvent(controller, 'diagnostics:update');
        phones[3].socket.disconnect();
        const disconnectedDevices = await controllerSnapshot;
        const offline = disconnectedDevices.find(({ id }) => id === 'dashboard-phone-4');
        assert.equal(offline.connected, false);
        const disconnectedDiagnostics = await diagnosticSnapshot;
        assert.equal(
            disconnectedDiagnostics.devices.find(({ screen }) => screen === 4).status,
            'disconnected'
        );

        const unauthorized = await connectClient(server.url);
        clients.push(unauthorized);
        assert.deepEqual(await emitAck(unauthorized, 'device:identify', {
            deviceId: 'dashboard-phone-3'
        }), {
            ok: false,
            message: 'Unauthorized device identify request'
        });
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
    }
});

test('validates, persists, and synchronizes display geometry and layout presets', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-layout-test-'));
    let server = await startServer({ testDirectory });
    const clients = [];

    try {
        const controller = await connectClient(server.url);
        clients.push(controller);
        controller.emit('controller:register');
        assert.equal((await emitAck(controller, 'screen-config:set', {
            totalScreens: 4,
            assignmentMode: 'automatic'
        })).ok, true);
        const phones = [];
        for (let screen = 1; screen <= 4; screen += 1) {
            const phone = await registerDevice(server.url, `geometry-phone-${screen}`);
            phones.push(phone);
            clients.push(phone.socket);
            assert.equal(phone.assignment.screen, screen);
        }

        const horizontal = createDefaultLayout(4);
        const horizontalResult = await emitAck(controller, 'layout:set', { layout: horizontal });
        assert.equal(horizontalResult.ok, true);
        assert.equal(horizontalResult.layout.type, 'horizontal');

        const vertical = createDefaultLayout(4, 'vertical');
        assert.equal((await emitAck(controller, 'layout:set', { layout: vertical })).ok, true);
        assert.deepEqual((await emitAck(controller, 'layout:set', {
            layout: createDefaultLayout(4, 'grid', 2, 2)
        })).layout.screens[4], {
            row: 1, column: 1, rotation: 0, orientation: 'auto', enabled: true
        });

        const custom = {
            type: 'custom',
            rows: 3,
            columns: 2,
            screens: {
                1: { row: 0, column: 0, rotation: 0, orientation: 'auto', enabled: true },
                2: { row: 0, column: 1, rotation: 90, orientation: 'portrait', enabled: true },
                3: { row: 2, column: 0, rotation: 180, orientation: 'landscape', enabled: true },
                4: { row: 2, column: 1, rotation: 270, orientation: 'auto', enabled: true }
            }
        };
        const phoneGeometryUpdate = nextMatchingEvent(
            phones[1].socket,
            'layout:update',
            (state) => JSON.stringify(state.layout) === JSON.stringify(custom)
        );
        const customResult = await emitAck(controller, 'layout:set', { layout: custom });
        assert.equal(customResult.ok, true);
        assert.deepEqual(customResult.layout, custom);
        assert.deepEqual((await phoneGeometryUpdate).layout, custom);

        const overlap = structuredClone(custom);
        overlap.screens[4].row = 2;
        overlap.screens[4].column = 0;
        assert.equal((await emitAck(controller, 'layout:set', { layout: overlap })).ok, false);
        assert.equal((await emitAck(controller, 'screen:configure', {
            screen: 4,
            position: { row: 2, column: 0, rotation: 0, orientation: 'auto' }
        })).ok, false);

        const assignedDisabled = nextMatchingEvent(
            phones[2].socket,
            'layout:update',
            (state) => state.layout.screens[3].enabled === false
        );
        const disabledDiagnostics = nextMatchingEvent(
            controller,
            'diagnostics:update',
            (state) => state.devices.find(({ screen }) => screen === 3)?.status === 'disabled'
        );
        const disabled = await emitAck(controller, 'screen:disable', { screen: 3 });
        assert.deepEqual(disabled, { ok: true, screen: 3, enabled: false });
        assert.equal((await assignedDisabled).layout.screens[3].enabled, false);
        assert.equal(
            (await disabledDiagnostics).devices.find(({ screen }) => screen === 3).status,
            'disabled'
        );

        const restoredAssignment = nextMatchingEvent(
            phones[2].socket,
            'layout:update',
            (state) => state.layout.screens[3].enabled === true
        );
        assert.deepEqual(await emitAck(controller, 'screen:enable', { screen: 3 }), {
            ok: true, screen: 3, enabled: true
        });
        assert.equal((await restoredAssignment).layout.screens[3].enabled, true);

        assert.equal((await emitAck(controller, 'layout-presets:save', {
            name: 'Gap and rotation'
        })).ok, true);
        assert.equal((await emitAck(controller, 'layout-presets:save', {
            name: 'Gap and rotation'
        })).ok, false);
        assert.equal((await emitAck(controller, 'layout-presets:load', {
            name: 'Default'
        })).layout.type, 'horizontal');
        const savedPreset = await emitAck(controller, 'layout-presets:load', {
            name: 'Gap and rotation'
        });
        assert.deepEqual(savedPreset.layout, custom);
        assert.equal((await emitAck(controller, 'layout-presets:delete', {
            name: 'Default'
        })).ok, false);

        const settingsBeforeRestart = JSON.parse(await readFile(server.calibrationFile, 'utf8'));
        assert.deepEqual(settingsBeforeRestart.layout, custom);
        assert.equal(settingsBeforeRestart.assignments['geometry-phone-3'], 3);
        assert.deepEqual(settingsBeforeRestart.layoutPresets[0].layout, custom);
        assert.deepEqual(settingsBeforeRestart.screens[1], { horizontal: 0, vertical: 0, scale: 1 });

        for (const socket of clients) {
            socket.disconnect();
        }
        clients.length = 0;
        await server.close();
        server = await startServer({ testDirectory });
        const restoredController = await connectClient(server.url);
        clients.push(restoredController);
        const currentConfiguration = nextEvent(restoredController, 'screen-config:current');
        const currentLayoutPresets = nextEvent(restoredController, 'layout-presets:current');
        restoredController.emit('controller:register');
        assert.deepEqual((await currentConfiguration).layout, custom);
        assert.ok((await currentLayoutPresets).presets.some((preset) =>
            preset.name === 'Gap and rotation' && preset.layout.type === 'custom'));
        const restoredPhone = await registerDevice(server.url, 'geometry-phone-3');
        clients.push(restoredPhone.socket);
        assert.equal(restoredPhone.assignment.screen, 3);
        assert.deepEqual(restoredPhone.assignment.layout, custom);
        const unauthorized = await connectClient(server.url);
        clients.push(unauthorized);
        assert.equal((await emitAck(unauthorized, 'layout:set', { layout: custom })).ok, false);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('resets only display layout to default while preserving devices and calibration across restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-layout-reset-test-'));
    let server = await startServer({ testDirectory });
    const clients = [];

    try {
        const controller = await connectClient(server.url);
        clients.push(controller);
        controller.emit('controller:register');
        assert.equal((await emitAck(controller, 'screen-config:set', {
            totalScreens: 4,
            assignmentMode: 'automatic'
        })).ok, true);

        const phones = [];
        for (let screen = 1; screen <= 4; screen += 1) {
            const phone = await registerDevice(server.url, `layout-reset-phone-${screen}`);
            phones.push(phone);
            clients.push(phone.socket);
            assert.equal(phone.assignment.screen, screen);
        }

        const calibration = { horizontal: 12.5, vertical: -7, scale: 1.03 };
        assert.deepEqual(await emitAck(controller, 'calibration:set', { enabled: true }), {
            ok: true, enabled: true
        });
        assert.deepEqual(await emitAck(controller, 'alignment:set', {
            screen: 2,
            settings: calibration
        }), { ok: true, screen: 2, settings: calibration });
        assert.equal((await emitAck(controller, 'preset:save', {
            name: 'Keep calibration'
        })).ok, true);

        const customLayout = createDefaultLayout(4, 'grid', 2, 2);
        customLayout.screens[1] = {
            ...customLayout.screens[1],
            rotation: 90,
            orientation: 'portrait',
            enabled: false
        };
        assert.equal((await emitAck(controller, 'layout:set', {
            layout: customLayout
        })).ok, true);
        assert.equal((await emitAck(controller, 'layout-presets:save', {
            name: 'Keep layout preset'
        })).ok, true);

        const unauthorized = await connectClient(server.url);
        clients.push(unauthorized);
        assert.match((await emitAck(unauthorized, 'layout:reset', {})).message, /Unauthorized/);
        assert.equal((await emitAck(controller, 'layout:reset', { layout: customLayout })).ok, false);

        const settingsBeforeReset = JSON.parse(await readFile(server.calibrationFile, 'utf8'));
        const defaultLayout = createDefaultLayout(4);
        const phoneLayoutUpdates = phones.map(({ socket }) => nextMatchingEvent(
            socket,
            'layout:update',
            (state) => JSON.stringify(state.layout) === JSON.stringify(defaultLayout)
        ));
        const reset = await emitAck(controller, 'layout:reset', {});
        assert.equal(reset.ok, true);
        assert.equal(reset.totalScreens, 4);
        assert.deepEqual(reset.layout, defaultLayout);
        for (const update of await Promise.all(phoneLayoutUpdates)) {
            assert.equal(update.totalScreens, 4);
            assert.deepEqual(update.layout, defaultLayout);
        }

        const settingsAfterReset = JSON.parse(await readFile(server.calibrationFile, 'utf8'));
        assert.deepEqual(settingsAfterReset, {
            ...settingsBeforeReset,
            layout: defaultLayout
        });
        assert.equal(settingsAfterReset.calibrationEnabled, true);
        assert.deepEqual(settingsAfterReset.screens[2], calibration);
        assert.ok(settingsAfterReset.presets.some(({ name }) => name === 'Keep calibration'));
        assert.deepEqual(settingsAfterReset.assignments, {
            'layout-reset-phone-1': 1,
            'layout-reset-phone-2': 2,
            'layout-reset-phone-3': 3,
            'layout-reset-phone-4': 4
        });
        assert.ok(settingsAfterReset.layoutPresets.some(({ name }) =>
            name === 'Keep layout preset'));

        for (const socket of clients) {
            socket.disconnect();
        }
        clients.length = 0;
        await server.close();
        server = await startServer({ testDirectory });

        const restoredController = await connectClient(server.url);
        clients.push(restoredController);
        const restoredConfig = nextEvent(restoredController, 'screen-config:current');
        const restoredCalibration = nextEvent(restoredController, 'calibration:current');
        const restoredPresets = nextEvent(restoredController, 'presets:current');
        restoredController.emit('controller:register');
        assert.equal((await restoredConfig).totalScreens, 4);
        assert.deepEqual((await restoredConfig).layout, defaultLayout);
        assert.deepEqual(await restoredCalibration, { enabled: true });
        assert.ok((await restoredPresets).presets.some(({ name }) => name === 'Keep calibration'));

        for (let screen = 1; screen <= 4; screen += 1) {
            const phone = await registerDevice(server.url, `layout-reset-phone-${screen}`);
            clients.push(phone.socket);
            assert.equal(phone.assignment.screen, screen);
            assert.deepEqual(phone.assignment.layout, defaultLayout);
        }
        assert.deepEqual(JSON.parse(await readFile(server.calibrationFile, 'utf8')), settingsAfterReset);
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
        await rm(testDirectory, { recursive: true, force: true });
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

function emitAck(socket, eventName, payload) {
    return new Promise((resolve) => {
        const acknowledge = (error, response) => {
            if (error) {
                resolve({ ok: false, message: `Timed out waiting for ${eventName}` });
                return;
            }
            resolve(response);
        };
        if (payload === undefined) {
            socket.timeout(10_000).emit(eventName, acknowledge);
        } else {
            socket.timeout(10_000).emit(eventName, payload, acknowledge);
        }
    });
}

function nextEvent(socket, eventName) {
    return new Promise((resolve) => socket.once(eventName, resolve));
}

function nextMatchingEvent(socket, eventName, predicate) {
    return new Promise((resolve) => {
        const onEvent = (payload) => {
            if (!predicate(payload)) {
                return;
            }
            socket.off(eventName, onEvent);
            resolve(payload);
        };
        socket.on(eventName, onEvent);
    });
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
        const controllerSession = await emitAck(control, 'controller:register');
        assert.equal(controllerSession.ok, true);
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
        assert.match(third.rejection.message, /All 2 screens are assigned/);

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
            headers: {
                Origin: 'http://127.0.0.1:5173',
                'X-Parallax-Controller': controllerSession.uploadToken
            },
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

        const viteFallbackResponse = await fetch(`${server.url}/api/upload`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:5174',
                'Access-Control-Request-Method': 'POST'
            }
        });
        assert.equal(viteFallbackResponse.status, 204);

        const nonVitePortResponse = await fetch(`${server.url}/api/upload`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:8080',
                'Access-Control-Request-Method': 'POST'
            }
        });
        assert.equal(nonVitePortResponse.status, 403);

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
                headers: { 'X-Parallax-Controller': controllerSession.uploadToken },
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
            headers: { 'X-Parallax-Controller': controllerSession.uploadToken },
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
            headers: { 'X-Parallax-Controller': controllerSession.uploadToken },
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

        const replacement = await registerDevice(server.url, 'phone-one');
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

test('uploads MP4 once, synchronizes playback, manages playlists, and resumes schedules after restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'parallax-media-integration-'));
    let server = await startServer({ testDirectory });
    const clients = [];

    try {
        const controller = await connectClient(server.url);
        clients.push(controller);
        const controllerSession = await emitAck(controller, 'controller:register');
        assert.equal(controllerSession.ok, true);
        const unregisteredClient = await connectClient(server.url);
        clients.push(unregisteredClient);
        assert.equal((await emitAck(unregisteredClient, 'media:publish', {
            mediaId: 'untrusted-media'
        })).ok, false);
        assert.equal((await emitAck(unregisteredClient, 'schedule:delete', {
            id: 'untrusted-schedule'
        })).ok, false);

        const unauthorizedUpload = await fetch(`${server.url}/api/media/upload`, {
            method: 'POST',
            body: new FormData()
        });
        assert.equal(unauthorizedUpload.status, 401);

        const invalidMediaForm = new FormData();
        invalidMediaForm.append('media', new Blob(['not an MP4'], { type: 'video/mp4' }), 'bad.mp4');
        const invalidMediaResponse = await fetch(`${server.url}/api/media/upload`, {
            method: 'POST',
            headers: { 'X-Parallax-Controller': controllerSession.uploadToken },
            body: invalidMediaForm
        });
        assert.equal(invalidMediaResponse.status, 415);

        const makeMp4 = () => {
            const buffer = Buffer.alloc(64);
            buffer.writeUInt32BE(24, 0);
            buffer.write('ftyp', 4);
            buffer.write('isom', 8);
            buffer.writeUInt32BE(0x200, 12);
            buffer.write('isomiso2avc1mp41', 16);
            return buffer;
        };
        async function uploadVideo(name) {
            const form = new FormData();
            form.append('media', new Blob([makeMp4()], { type: 'video/mp4' }), name);
            form.append('durationSeconds', '30');
            const response = await fetch(`${server.url}/api/media/upload`, {
                method: 'POST',
                headers: { 'X-Parallax-Controller': controllerSession.uploadToken },
                body: form
            });
            assert.equal(response.status, 201);
            return response.json();
        }
        async function uploadImage(name) {
            const buffer = await sharp({
                create: {
                    width: 8,
                    height: 8,
                    channels: 3,
                    background: { r: 60, g: 90, b: 140 }
                }
            }).png().toBuffer();
            const form = new FormData();
            form.append('media', new Blob([buffer], { type: 'image/png' }), name);
            const response = await fetch(`${server.url}/api/media/upload`, {
                method: 'POST',
                headers: { 'X-Parallax-Controller': controllerSession.uploadToken },
                body: form
            });
            assert.equal(response.status, 201);
            return response.json();
        }

        const firstVideo = await uploadVideo('first-panorama.mp4');
        const secondVideo = await uploadVideo('second-panorama.mp4');
        assert.equal(firstVideo.mediaType, 'video');
        assert.equal(firstVideo.mimeType, 'video/mp4');
        assert.equal(firstVideo.durationSeconds, 30);
        assert.equal(firstVideo.published, false);
        const videoPath = `${server.url}${new URL(firstVideo.url).pathname}`;
        const localAddress = Object.values(networkInterfaces())
            .flat()
            .find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
        const videoOrigin = localAddress
            ? 'http://127.0.0.1:5173'
            : 'http://localhost:5173';
        const videoHeaders = {
            Origin: videoOrigin,
            ...(localAddress ? { Host: localAddress } : {})
        };
        const corsVideoResponse = await fetch(videoPath, {
            method: 'HEAD',
            headers: videoHeaders
        });
        assert.equal(corsVideoResponse.status, 200);
        assert.equal(corsVideoResponse.headers.get('content-type'), 'video/mp4');
        assert.equal(corsVideoResponse.headers.get('access-control-allow-origin'), videoOrigin);
        const hostileVideoResponse = await fetch(videoPath, {
            method: 'HEAD',
            headers: { Origin: 'https://attacker.example' }
        });
        assert.equal(hostileVideoResponse.status, 403);
        const first = await registerDevice(server.url, 'media-phone-one');
        clients.push(first.socket);
        const second = await registerDevice(server.url, 'media-phone-two');
        clients.push(second.socket);

        const firstContent = nextMatchingEvent(
            first.socket,
            'content:update',
            (content) => content.mediaId === firstVideo.id
        );
        const secondContent = nextMatchingEvent(
            second.socket,
            'content:update',
            (content) => content.mediaId === firstVideo.id
        );
        const published = await emitAck(controller, 'media:publish', {
            mediaId: firstVideo.id,
            transition: 'fade'
        });
        assert.equal(published.ok, true);
        assert.equal((await firstContent).videoUrl, firstVideo.url);
        assert.equal((await secondContent).videoUrl, firstVideo.url);
        assert.equal(published.content.transition, 'fade');

        const volumeSync = nextEvent(first.socket, 'playback:sync');
        const volumeUpdate = await emitAck(controller, 'playback:volume', { volume: 0.35 });
        assert.equal(volumeUpdate.ok, true);
        assert.equal(volumeUpdate.playback.volume, 0.35);
        assert.equal((await volumeSync).volume, 0.35);
        assert.equal(JSON.parse(await readFile(server.mediaManifestFile, 'utf8'))
            .playback.volume, 0.35);
        assert.equal((await emitAck(controller, 'playback:volume', { volume: 1.1 })).ok, false);

        const firstPlayTimeline = nextEvent(first.socket, 'playback:sync');
        const secondPlayTimeline = nextEvent(second.socket, 'playback:sync');
        const playing = await emitAck(controller, 'playback:play', {});
        assert.equal(playing.ok, true);
        const [firstTimeline, secondTimeline] = await Promise.all([
            firstPlayTimeline,
            secondPlayTimeline
        ]);
        assert.equal(firstTimeline.timelineId, secondTimeline.timelineId);
        assert.equal(firstTimeline.startedAt, secondTimeline.startedAt);
        assert.equal(firstTimeline.volume, 0.35);
        assert.equal(secondTimeline.volume, 0.35);
        assert.ok(firstTimeline.startedAt >= firstTimeline.serverNow);

        const paused = await emitAck(controller, 'playback:pause', {});
        assert.equal(paused.ok, true);
        assert.equal(paused.playback.status, 'paused');
        const resumed = await emitAck(controller, 'playback:resume', {});
        assert.equal(resumed.ok, true);
        assert.equal(resumed.playback.status, 'playing');
        const seek = await emitAck(controller, 'playback:seek', { positionSeconds: 12 });
        assert.equal(seek.ok, true);
        assert.equal(seek.playback.positionSeconds, 12);

        const driftCorrection = nextEvent(first.socket, 'playback:sync');
        first.socket.emit('playback:drift', {
            mediaId: firstVideo.id,
            positionSeconds: 500
        });
        assert.equal((await driftCorrection).mediaId, firstVideo.id);

        const createdPlaylist = await emitAck(controller, 'playlist:create', {
            name: 'Video wall',
            mediaType: 'video',
            items: [
                { mediaId: firstVideo.id, durationSeconds: 30 },
                { mediaId: secondVideo.id, durationSeconds: 30 }
            ],
            loop: true,
            shuffle: false,
            transition: 'slide-left'
        });
        assert.equal(createdPlaylist.ok, true);
        const playlist = createdPlaylist.playlist;
        const reordered = await emitAck(controller, 'playlist:update', {
            id: playlist.id,
            name: playlist.name,
            mediaType: playlist.mediaType,
            items: [...playlist.items].reverse(),
            loop: true,
            shuffle: false,
            transition: 'slide-right'
        });
        assert.equal(reordered.ok, true);
        assert.deepEqual(reordered.playlist.items.map((item) => item.mediaId), [
            secondVideo.id,
            firstVideo.id
        ]);
        assert.equal(reordered.playlist.transition, 'slide-right');
        const upcomingMedia = nextEvent(first.socket, 'media:preload');
        const loaded = await emitAck(controller, 'playlist:load', { id: playlist.id });
        assert.equal(loaded.ok, true);
        assert.equal(loaded.playlistId, playlist.id);
        assert.equal((await upcomingMedia).mediaId, firstVideo.id);
        assert.equal((await emitAck(controller, 'playback:next', {})).ok, true);
        assert.equal((await emitAck(controller, 'playback:stop', {})).ok, true);
        assert.equal((await emitAck(controller, 'playlist:delete', { id: playlist.id })).ok, true);

        const firstImage = await uploadImage('first-slide.png');
        const secondImage = await uploadImage('second-slide.png');
        const imagePlaylistResult = await emitAck(controller, 'playlist:create', {
            name: 'Timed images',
            mediaType: 'image',
            items: [
                { mediaId: firstImage.id, durationSeconds: 1 },
                { mediaId: secondImage.id, durationSeconds: 1 }
            ],
            loop: false,
            shuffle: false,
            transition: 'fade'
        });
        assert.equal(imagePlaylistResult.ok, true);
        const firstSlide = nextMatchingEvent(
            first.socket,
            'content:update',
            (content) => content.mediaId === firstImage.id
        );
        const secondSlide = nextMatchingEvent(
            first.socket,
            'content:update',
            (content) => content.mediaId === secondImage.id
        );
        assert.equal((await emitAck(controller, 'playlist:load', {
            id: imagePlaylistResult.playlist.id
        })).ok, true);
        assert.equal((await firstSlide).mediaId, firstImage.id);
        assert.equal((await secondSlide).mediaId, secondImage.id);
        assert.equal((await emitAck(controller, 'playback:stop', {})).ok, true);
        assert.equal((await emitAck(controller, 'playlist:delete', {
            id: imagePlaylistResult.playlist.id
        })).ok, true);

        const startAt = new Date(Date.now() + 3000).toISOString();
        const scheduleEnd = new Date(Date.now() + 30_000).toISOString();
        const scheduleResult = await emitAck(controller, 'schedule:create', {
            targetType: 'media',
            targetId: secondVideo.id,
            startAt,
            endAt: scheduleEnd,
            timeZone: 'Asia/Kolkata',
            enabled: true
        });
        assert.equal(scheduleResult.ok, true);
        assert.equal(scheduleResult.schedules.length, 1);
        assert.equal(JSON.parse(await readFile(server.mediaManifestFile, 'utf8'))
            .schedules[0].targetId, secondVideo.id);

        for (const socket of clients) {
            socket.disconnect();
        }
        clients.length = 0;
        await server.close();
        server = await startServer({ testDirectory });
        const restoredController = await connectClient(server.url);
        clients.push(restoredController);
        const restoredSnapshot = nextEvent(restoredController, 'media:current');
        const restoredRegistration = await emitAck(restoredController, 'controller:register');
        assert.equal(restoredRegistration.ok, true);
        const snapshot = await restoredSnapshot;
        assert.equal(snapshot.media.length, 4);
        assert.equal(snapshot.schedules.length, 1);

        const restoredPhone = await registerDevice(server.url, 'media-phone-one');
        clients.push(restoredPhone.socket);
        const scheduledContent = nextMatchingEvent(
            restoredPhone.socket,
            'content:update',
            (content) => content.mediaId === secondVideo.id
        );
        await scheduledContent;
        const persistedManifest = JSON.parse(await readFile(server.mediaManifestFile, 'utf8'));
        assert.equal(persistedManifest.activeScheduleId, scheduleResult.schedule.id);
        assert.equal(persistedManifest.currentContent.mediaId, secondVideo.id);
        assert.equal((await emitAck(restoredController, 'schedule:delete', {
            id: scheduleResult.schedule.id
        })).ok, true);
        const deletedMedia = await emitAck(restoredController, 'media:delete', {
            mediaId: firstVideo.id,
            confirmPublished: true
        });
        assert.equal(deletedMedia.ok, true);
        assert.equal(deletedMedia.media.media.length, 3);
        assert.equal(deletedMedia.media.uploadHistory.find(
            (entry) => entry.id === firstVideo.id
        ).publishingStatus, 'deleted');
    } finally {
        for (const socket of clients) {
            socket.disconnect();
        }
        await server.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('uses a LAN-reachable image URL when uploads arrive through localhost', async () => {
    const server = await startServer({ publicBaseUrl: null });
    const controller = await connectClient(server.url);
    try {
        const controllerSession = await emitAck(controller, 'controller:register');
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
            headers: {
                Origin: 'http://localhost:5173',
                'X-Parallax-Controller': controllerSession.uploadToken
            },
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
        controller.disconnect();
        await server.close();
    }
});
