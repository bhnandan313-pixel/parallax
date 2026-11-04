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
    const alignmentByScreen = {
        1: { horizontal: 0, vertical: 0, scale: 1 },
        2: { horizontal: 0, vertical: 0, scale: 1 }
    };

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
    }

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
    const socket = createParallaxSocket();
    let renderer = null;
let calibrationEnabled = false;

    socket.on('connect', () => {
        showStatus('Connected');
        showStatus('Registering device');
        socket.emit('device:register', deviceId);
    });

    socket.on('device:assigned', (assignment) => {
        const screen = assignment?.screen;
        if (screen !== 1 && screen !== 2) {
            showStatus('Connection error: Server returned an invalid screen assignment', 'error');
            console.error('Invalid device assignment:', assignment);
            return;
        }

        assignedScreen = screen;
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
                onStatus: showStatus
            });
            renderer.setCalibration(calibrationEnabled);
            renderer.setAlignment(alignmentByScreen[screen]);
        } else {
            renderer.setScreen(screen);
            renderer.setAlignment(alignmentByScreen[screen]);
        }
    });

    socket.on('content:update', (content) => {
        if (!renderer) {
            console.error('Received content before device assignment:', content);
            return;
        }
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
});

    socket.on('alignment:update', (state) => {
        const screens = state?.screens;
        if (!screens || typeof screens !== 'object') {
            return;
        }

        for (const screen of [1, 2]) {
            const settings = screens[screen];
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

        if (renderer && (assignedScreen === 1 || assignedScreen === 2)) {
            renderer.setAlignment(alignmentByScreen[assignedScreen]);
        }
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
    });

    socket.io.on('reconnect_attempt', () => {
        showStatus('Connecting to server - retrying');
    });

    socket.io.on('reconnect_error', (error) => {
        showStatus(`Connection error: ${error.message}`, 'error');
        console.error('Socket.IO reconnection error:', error);
    });
}
