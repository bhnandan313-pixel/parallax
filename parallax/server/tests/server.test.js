import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as createSocket } from 'socket.io-client';
import sharp from 'sharp';
import { createParallaxServer } from '../server.js';

function defaultScreens(count = 12) {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [
        index + 1,
        { horizontal: 0, vertical: 0, scale: 1 }
    ]));
}

function storedSettings({ calibrationEnabled = false, screens = {}, assignments = {},
    totalScreens = 2, assignmentMode = 'automatic', presets = [] } = {}) {
    return {
        calibrationEnabled,
        totalScreens,
        assignmentMode,
        assignments,
        screens: { ...defaultScreens(), ...screens },
        presets
    };
}

async function startServer(options) {
    const {
        testDirectory: providedTestDirectory,
        calibrationFile: providedCalibrationFile,
        uploadDirectory: providedUploadDirectory,
        ...serverOptions
    } = options ?? {};
    const testDirectory = providedTestDirectory
        ?? await mkdtemp(join(tmpdir(), 'parallax-test-'));
    const uploadDirectory = providedUploadDirectory ?? join(testDirectory, 'uploads');
    const calibrationFile = providedCalibrationFile
        ?? join(testDirectory, 'data', 'calibration.json');
    const instance = createParallaxServer({
        publicBaseUrl: 'http://parallax-test.invalid:3001',
        ...serverOptions,
        calibrationFile,
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
        socket.timeout(10_000).emit(eventName, payload, (error, response) => {
            if (error) {
                resolve({ ok: false, message: `Timed out waiting for ${eventName}` });
                return;
            }
            resolve(response);
        });
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
