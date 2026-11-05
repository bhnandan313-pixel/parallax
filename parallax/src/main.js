import { getOrCreateDeviceId } from './core/device.js';
import { createParallaxSocket } from './core/socket.js';
import { createContentRenderer } from './display/renderer.js';
import { createDefaultLayout, validateDisplayLayout } from './display/geometry.js';
import { mountController } from './controller/controller.js';
import {
    createAudioSettings,
    DEFAULT_AUDIO_SETTINGS,
    getDeviceAudioState,
    loadDeviceAudioPreferences,
    saveDeviceAudioPreferences
} from './media/audio.js';
import { isFullscreen, toggleFullscreen } from './media/fullscreen.js';
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
    let identifyOverlay = null;
    let identifyTimer = null;
    let playbackDriftTimer = null;
    let phoneControls = null;
    let fullscreenButton = null;
    let muteButton = null;
    let phoneVolume = null;
    let phoneVolumeValue = null;
    let playbackStatusLabel = null;
    let controlsTimer = null;
    let audioSettings = { ...DEFAULT_AUDIO_SETTINGS };
    let playbackVolume = 0;
    let localAudioPreferences = { volume: 1, enabled: false };
    const alignmentByScreen = {
        1: { horizontal: 0, vertical: 0, scale: 1 },
        2: { horizontal: 0, vertical: 0, scale: 1 }
    };

    function loadAudioPreferences(id) {
        try {
            localAudioPreferences = loadDeviceAudioPreferences(localStorage, id);
        } catch (error) {
            console.warn('Unable to read saved device audio volume:', error);
        }
    }

    function saveAudioPreferences() {
        try {
            localAudioPreferences.volume = saveDeviceAudioPreferences(
                localStorage,
                deviceId,
                localAudioPreferences.volume
            );
        } catch (error) {
            console.warn('Unable to save device audio volume:', error);
        }
    }

    function syncDeviceAudio() {
        renderer?.setAudioSettings(audioSettings, deviceId, localAudioPreferences);
        if (muteButton) {
            const isMuted = getDeviceAudioState({
                settings: audioSettings,
                deviceId,
                globalVolume: playbackVolume,
                deviceVolume: localAudioPreferences.volume,
                enabled: localAudioPreferences.enabled
            }).muted;
            muteButton.textContent = isMuted ? 'Enable audio' : 'Mute';
            muteButton.setAttribute('aria-pressed', String(!isMuted));
            phoneVolume.value = String(Math.round(localAudioPreferences.volume * 100));
            phoneVolumeValue.textContent = `${phoneVolume.value}%`;
        }
    }

    function createPhoneControls() {
        const controls = document.createElement('div');
        controls.className = 'phone-controls';
        controls.setAttribute('aria-label', 'Video playback controls');
        playbackStatusLabel = document.createElement('span');
        playbackStatusLabel.className = 'phone-playback-status';
        playbackStatusLabel.textContent = 'Paused';
        fullscreenButton = document.createElement('button');
        fullscreenButton.type = 'button';
        fullscreenButton.textContent = 'Fullscreen';
        fullscreenButton.setAttribute('aria-label', 'Enter fullscreen');
        muteButton = document.createElement('button');
        muteButton.type = 'button';
        muteButton.setAttribute('aria-label', 'Enable video audio');
        phoneVolume = document.createElement('input');
        phoneVolume.type = 'range';
        phoneVolume.min = '0';
        phoneVolume.max = '100';
        phoneVolume.step = '1';
        phoneVolume.setAttribute('aria-label', 'Device volume');
        phoneVolumeValue = document.createElement('output');
        controls.append(
            playbackStatusLabel,
            fullscreenButton,
            muteButton,
            phoneVolume,
            phoneVolumeValue
        );
        fullscreenButton.addEventListener('click', async () => {
            try {
                if (!await toggleFullscreen(display)) {
                    showStatus('Fullscreen is not supported by this browser');
                    return;
                }
                updateFullscreenButton();
            } catch (error) {
                console.error('Unable to toggle phone fullscreen:', error);
                showStatus('Unable to open fullscreen on this browser');
            }
        });
        controls.addEventListener('focusin', showPhoneControls);
        muteButton.addEventListener('click', () => {
            localAudioPreferences.enabled = !localAudioPreferences.enabled;
            syncDeviceAudio();
        });
        phoneVolume.addEventListener('input', () => {
            localAudioPreferences.volume = Number(phoneVolume.value) / 100;
            if (localAudioPreferences.volume > 0) {
                localAudioPreferences.enabled = true;
            }
            saveAudioPreferences();
            syncDeviceAudio();
        });
        return controls;
    }

    function updateFullscreenButton() {
        const fullscreen = isFullscreen(display);
        fullscreenButton.textContent = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
        fullscreenButton.setAttribute('aria-label',
            fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
        renderer?.refresh();
    }

    function showPhoneControls() {
        phoneControls?.classList.remove('is-hidden');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            phoneControls?.classList.add('is-hidden');
        }, 4000);
    }

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
    const pairingToken = new URLSearchParams(location.search).get('pair');
    let pairingPending = Boolean(pairingToken);
    try {
        deviceId = getOrCreateDeviceId();
        loadAudioPreferences(deviceId);
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
            phoneControls = createPhoneControls();
            display.append(phoneControls);
            app.replaceChildren(display);
            renderer = createContentRenderer({
                container: display,
                statusPanel,
                screen,
                onStatus: (message, state) => showStatus(message, state),
                onPlaybackStatus: (status) => {
                    if (playbackStatusLabel) {
                        playbackStatusLabel.textContent = status;
                    }
                }
            });
            renderer.setScreenCount(totalScreens);
            renderer.setLayout(assignment.layout ?? createDefaultLayout(totalScreens));
            renderer.setScreenEnabled(assignment.enabled !== false);
            renderer.setCalibration(calibrationEnabled);
            renderer.setAlignment(alignmentByScreen[screen] ?? { horizontal: 0, vertical: 0, scale: 1 });
            showPhoneControls();
            display.addEventListener('pointerdown', showPhoneControls, { passive: true });
            display.addEventListener('touchstart', showPhoneControls, { passive: true });
        } else {
            renderer.setScreenCount(totalScreens);
            renderer.setScreen(screen);
            renderer.setLayout(assignment.layout ?? createDefaultLayout(totalScreens));
            renderer.setScreenEnabled(assignment.enabled !== false);
            renderer.setAlignment(alignmentByScreen[screen] ?? { horizontal: 0, vertical: 0, scale: 1 });
        }
        syncDeviceAudio();
        reportDeviceStatus();
        if (playbackDriftTimer === null) {
            playbackDriftTimer = setInterval(() => {
                const report = renderer?.getPlaybackReport();
                if (report && socket?.connected) {
                    socket.emit('playback:drift', report);
                }
            }, 5000);
        }
    }

    function handleUnassignment() {
        assignedScreen = null;
        clearTimeout(controlsTimer);
        renderer?.dispose();
        display = null;
        renderer = null;
        if (playbackDriftTimer !== null) {
            clearInterval(playbackDriftTimer);
            playbackDriftTimer = null;
        }
        alignmentRevision = null;
        displayStatus = 'waiting';
        showStatus('Waiting for a screen assignment');
        app.replaceChildren(statusPanel);
    }

    socket.on('connect', () => {
        showStatus('Connected');
        if (pairingPending && pairingToken) {
            showStatus('Validating pairing code');
            socket.timeout(5000).emit('pairing:join', { token: pairingToken }, (error, result) => {
                if (error || !result?.ok) {
                    const message = error
                        ? 'Could not reach the Parallax server. Check that both devices are on the same Wi-Fi network.'
                        : result?.message || 'Pairing failed. Ask the controller for a new QR code.';
                    showStatus(`Pairing error: ${message}`, 'error');
                    return;
                }
                pairingPending = false;
                const cleanUrl = new URL(location.href);
                cleanUrl.searchParams.delete('pair');
                history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
                showStatus('Pairing approved');
                registerDisplayDevice();
            });
            return;
        }
        registerDisplayDevice();
    });

    function registerDisplayDevice() {
        showStatus('Registering device');
        socket.emit('device:register', deviceId);
    }

    socket.on('device:assigned', handleAssignment);
    socket.on('device:assignment-update', handleAssignment);
    socket.on('device:unassigned', handleUnassignment);
    socket.on('device:identify', (request) => {
        if (!assignedScreen || request?.screen !== assignedScreen) {
            return;
        }
        const durationMs = Number.isInteger(request.durationMs)
            ? Math.min(5000, Math.max(1000, request.durationMs))
            : 2500;
        if (!identifyOverlay) {
            identifyOverlay = document.createElement('div');
            identifyOverlay.className = 'identify-overlay';
            identifyOverlay.setAttribute('role', 'status');
            identifyOverlay.setAttribute('aria-live', 'assertive');
            document.body.append(identifyOverlay);
        }
        identifyOverlay.textContent = `SCREEN ${assignedScreen}`;
        identifyOverlay.hidden = false;
        identifyOverlay.classList.remove('is-visible');
        requestAnimationFrame(() => identifyOverlay?.classList.add('is-visible'));
        clearTimeout(identifyTimer);
        identifyTimer = setTimeout(() => {
            identifyOverlay?.classList.remove('is-visible');
            identifyTimer = setTimeout(() => {
                if (identifyOverlay) {
                    identifyOverlay.hidden = true;
                }
            }, 220);
        }, durationMs);
    });

    function handleLayoutUpdate(configuration) {
        const count = configuration?.totalScreens;
        const nextLayout = configuration?.layout;
        if (!Number.isInteger(count) || count < 2 || count > 12
            || !validateDisplayLayout(nextLayout, count)) {
            return;
        }
        totalScreens = count;
        if (configuration.screens && typeof configuration.screens === 'object') {
            for (const [screenKey, settings] of Object.entries(configuration.screens)) {
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
                renderer.setLayout(nextLayout);
                const enabled = nextLayout.screens[assignedScreen]?.enabled === true;
                renderer.setScreenEnabled(enabled);
                if (!enabled) {
                    displayStatus = 'waiting';
                    displayError = null;
                }
                renderer.setAlignment(alignmentByScreen[assignedScreen]);
                reportDeviceStatus();
            } catch (error) {
                showStatus(`Connection error: ${error.message}`, 'error');
            }
        }
    }

    socket.on('layout:update', handleLayoutUpdate);

    socket.on('content:update', (content) => {
        if (!renderer) {
            console.error('Received content before device assignment:', content);
            return;
        }
        latestUpdateId = content?.updateId ?? null;
        renderer(content);
    });
    socket.on('media:preload', (media) => {
        renderer?.preload(media);
    });
    socket.on('playback:sync', (timeline) => {
        playbackVolume = Number.isFinite(timeline?.volume) ? timeline.volume : 0;
        renderer?.setPlayback(timeline);
        syncDeviceAudio();
    });
    socket.on('audio:settings', (settings) => {
        audioSettings = createAudioSettings(settings);
        syncDeviceAudio();
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

    window.addEventListener('pagehide', () => {
        socket.disconnect();
        renderer?.dispose();
        clearTimeout(identifyTimer);
        clearTimeout(controlsTimer);
        if (playbackDriftTimer !== null) {
            clearInterval(playbackDriftTimer);
        }
    }, { once: true });
    window.addEventListener('orientationchange', () => renderer?.refresh(), { passive: true });
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
}
