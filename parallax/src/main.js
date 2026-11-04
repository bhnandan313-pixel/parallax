import { getOrCreateDeviceId } from './core/device.js';
import { createParallaxSocket } from './core/socket.js';
import { createContentRenderer } from './display/renderer.js';
import { mountController } from './controller/controller.js';
import './styles/main.css';

if (location.pathname === '/controller' || location.pathname === '/controller/') {
    mountController();
} else {
    startDisplay();
}

function startDisplay() {
    const app = document.querySelector('#app');
    if (!app) {
        throw new Error('PARALLAX application root was not found');
    }

    const statusPanel = document.createElement('div');
    statusPanel.className = 'status-panel';
    statusPanel.setAttribute('role', 'status');
    statusPanel.setAttribute('aria-live', 'polite');
    app.replaceChildren(statusPanel);
    const statusHistory = [];
    let display = null;
    let assignedScreen = null;
    let totalScreens = 2;
    let displayStatus = 'waiting';
    let displayError = null;
    let alignmentRevision = null;
    let displayedUpdateId = null;
    let socket = null;
    const alignmentByScreen = {
        1: { horizontal: 0, vertical: 0, scale: 1 },
        2: { horizontal: 0, vertical: 0, scale: 1 }
    };

    function reportDeviceStatus() {
        if (!socket?.connected || !assignedScreen) {
            return;
        }
        socket.emit('device:report', {
            screen: assignedScreen,
            displayStatus,
            displayError,
            loadedUpdateId: displayedUpdateId,
            alignmentRevision
        });
    }

    function showStatus(message, state = 'info') {
        statusHistory.push(message);
        if (statusHistory.length > 6) {
            statusHistory.shift();
        }
        const displayState = display
            ? `status-overlay${state === 'info' ? '' : ` status-${state}`}`
            : `status-${state}`;
        statusPanel.className = `status-panel ${displayState}`;
        statusPanel.textContent = statusHistory.join('\n');
        if (!statusPanel.isConnected) {
            app.replaceChildren(statusPanel);
        }
        if (state === 'ready') {
            displayStatus = 'ready';
            displayError = null;
            const match = /^Display ready - Screen \d+$/.test(message);
            if (match) {
                displayedUpdateId = latestUpdateId;
            }
            reportDeviceStatus();
        } else if (state === 'error') {
            displayStatus = 'error';
            displayError = message.slice(0, 200);
            reportDeviceStatus();
        } else if (message === 'Loading panorama') {
            displayStatus = 'loading';
            displayError = null;
            reportDeviceStatus();
        }
    }

    let latestUpdateId = null;
    let deviceId;
    try {
        deviceId = getOrCreateDeviceId();
    } catch (error) {
        console.error('Unable to initialize the PARALLAX device ID:', error);
        showStatus(`Connection error: ${error.message}`, 'error');
    }

    if (!deviceId) {
        return;
    }

    showStatus('Connecting to server');
    socket = createParallaxSocket();
    let renderer = null;
    let calibrationEnabled = false;

    function handleAssignment(assignment) {
        const screen = assignment?.screen;
        const configuredCount = assignment?.totalScreens ?? totalScreens;
        if (!Number.isInteger(configuredCount) || configuredCount < 2 || configuredCount > 12
            || !Number.isInteger(screen) || screen < 1 || screen > configuredCount) {
            showStatus('Connection error: Server returned an invalid screen assignment', 'error');
            console.error('Invalid device assignment:', assignment);
            return;
        }

        totalScreens = configuredCount;
        if (assignment.alignment) {
            alignmentByScreen[screen] = { ...assignment.alignment };
        }
        assignedScreen = screen;
        displayStatus = 'waiting';
        displayError = null;
        showStatus(`Device assigned - Screen ${screen}`);
        if (!display) {
            display = document.createElement('main');
            display.className = 'panorama-container';
            display.append(statusPanel);
            app.replaceChildren(display);
            renderer = createContentRenderer({
                container: display,
                statusPanel,
                screen,
                onStatus: (message, state) => showStatus(message, state)
            });
            renderer.setScreenCount(totalScreens);
            renderer.setCalibration(calibrationEnabled);
            renderer.setAlignment(alignmentByScreen[screen] ?? { horizontal: 0, vertical: 0, scale: 1 });
        } else {
            renderer.setScreenCount(totalScreens);
            renderer.setScreen(screen);
            renderer.setAlignment(alignmentByScreen[screen] ?? { horizontal: 0, vertical: 0, scale: 1 });
        }
        reportDeviceStatus();
    }

    function handleUnassignment() {
        assignedScreen = null;
        display = null;
        renderer = null;
        alignmentRevision = null;
        displayStatus = 'waiting';
        showStatus('Waiting for a screen assignment');
        app.replaceChildren(statusPanel);
    }

    socket.on('connect', () => {
        showStatus('Connected');
        showStatus('Registering device');
        socket.emit('device:register', deviceId);
    });

    socket.on('device:assigned', handleAssignment);
    socket.on('device:assignment-update', handleAssignment);
    socket.on('device:unassigned', handleUnassignment);

    socket.on('screen-config:update', (configuration) => {
        const count = configuration?.totalScreens;
        if (!Number.isInteger(count) || count < 2 || count > 12) {
            return;
        }
        totalScreens = count;
        const screens = configuration.screens;
        if (screens && typeof screens === 'object') {
            for (const [screenKey, settings] of Object.entries(screens)) {
                const screen = Number(screenKey);
                if (Number.isInteger(screen) && screen >= 1 && screen <= totalScreens
                    && Number.isFinite(settings?.horizontal)
                    && Number.isFinite(settings?.vertical)
                    && Number.isFinite(settings?.scale)) {
                    alignmentByScreen[screen] = { ...settings };
                }
            }
        }
        if (renderer && assignedScreen) {
            try {
                renderer.setScreenCount(totalScreens);
                renderer.setAlignment(alignmentByScreen[assignedScreen]);
            } catch (error) {
                showStatus(`Connection error: ${error.message}`, 'error');
            }
        }
    });

    socket.on('content:update', (content) => {
        if (!renderer) {
            console.error('Received content before device assignment:', content);
            return;
        }
        latestUpdateId = content?.updateId ?? null;
        renderer(content);
    });
    socket.on('calibration:update', (state) => {
    if (typeof state?.enabled !== 'boolean') {
        return;
    }

    calibrationEnabled = state.enabled;

    if (renderer) {
        renderer.setCalibration(calibrationEnabled);
    }
    reportDeviceStatus();
});

    socket.on('alignment:update', (state) => {
        const screens = state?.screens;
        if (!screens || typeof screens !== 'object') {
            return;
        }

        for (const [screenKey, settings] of Object.entries(screens)) {
            const screen = Number(screenKey);
            if (!Number.isInteger(screen) || screen < 1 || screen > 12) {
                continue;
            }
            if (settings
                && Number.isFinite(settings.horizontal)
                && settings.horizontal >= -50
                && settings.horizontal <= 50
                && Number.isFinite(settings.vertical)
                && settings.vertical >= -50
                && settings.vertical <= 50
                && Number.isFinite(settings.scale)
                && settings.scale >= 0.95
                && settings.scale <= 1.05) {
                alignmentByScreen[screen] = {
                    horizontal: settings.horizontal,
                    vertical: settings.vertical,
                    scale: settings.scale
                };
            }
        }

        if (renderer && assignedScreen !== null) {
            if (!renderer.setAlignment(alignmentByScreen[assignedScreen])) {
                displayStatus = 'error';
                reportDeviceStatus();
                return;
            }
        }
        if (Number.isInteger(state.revision) && state.revision >= 0) {
            alignmentRevision = state.revision;
        }
        reportDeviceStatus();
    });

    socket.on('content:rejected', (result) => {
        const message = typeof result?.message === 'string'
            ? result.message
            : 'Content update was rejected';
        showStatus(`Connection error: ${message}`, 'error');
    });

    socket.on('device:rejected', (result) => {
        const message = typeof result?.message === 'string'
            ? result.message
            : 'Device registration was rejected';
        showStatus(`Connection error: ${message}`, 'error');
    });

    socket.on('connect_error', (error) => {
        showStatus(`Connection error: ${error.message}`, 'error');
        console.error('Socket.IO connection error:', error);
    });

    socket.on('disconnect', (reason) => {
        showStatus(`Connecting to server - disconnected: ${reason}`);
        displayStatus = 'waiting';
        alignmentRevision = null;
    });

    socket.io.on('reconnect_attempt', () => {
        showStatus('Connecting to server - retrying');
    });

    socket.io.on('reconnect_error', (error) => {
        showStatus(`Connection error: ${error.message}`, 'error');
        console.error('Socket.IO reconnection error:', error);
    });

    window.addEventListener('pagehide', () => socket.disconnect(), { once: true });
}
