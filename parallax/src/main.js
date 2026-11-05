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
} else if (location.pathname === '/vision' || location.pathname === '/vision/') {
    startVisionCamera();
} else {
    startDisplay();
}

function buildMarkerPattern(markerId, size = 5) {
    const pattern = Array.from({ length: size }, () => Array(size).fill(0));
    for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
            if (row === 0 || row === size - 1 || column === 0 || column === size - 1) {
                pattern[row][column] = 1;
            }
        }
    }
    const value = Math.abs(Number(markerId) || 1) % (size * size - (size * 2 - 2) * 2);
    let bit = 0;
    for (let row = 1; row < size - 1; row += 1) {
        for (let column = 1; column < size - 1; column += 1) {
            const cellIndex = (row - 1) * (size - 2) + (column - 1);
            if (cellIndex < value) {
                pattern[row][column] = 1;
            }
            bit += 1;
        }
    }
    return pattern;
}

function createMarkerOverlay(deviceId) {
    const markerId = Math.abs([...deviceId].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 1000;
    const pattern = buildMarkerPattern(markerId);
    const overlay = document.createElement('div');
    overlay.className = 'parallax-vision-marker';
    overlay.setAttribute('aria-label', `Device marker ${markerId}`);
    const grid = document.createElement('div');
    grid.className = 'parallax-vision-marker-grid';
    for (const row of pattern) {
        for (const cell of row) {
            const cellNode = document.createElement('span');
            cellNode.className = `parallax-vision-marker-cell ${cell ? 'is-filled' : 'is-empty'}`;
            grid.appendChild(cellNode);
        }
    }
    const label = document.createElement('span');
    label.className = 'parallax-vision-marker-label';
    label.textContent = `ID ${markerId}`;
    overlay.append(grid, label);
    return overlay;
}

function startVisionCamera() {
    const app = document.querySelector('#app');
    if (!app) {
        throw new Error('PARALLAX vision camera root was not found');
    }

    const token = new URLSearchParams(location.search).get('vision');
    const cameraState = {
        socket: null,
        stream: null,
        currentDeviceId: null,
        mediaStream: null,
        frames: 0,
        lastMarkerReportAt: 0,
        markerStatus: 'Waiting for markers'
    };

    app.innerHTML = `
        <main class="vision-camera-shell">
            <section class="vision-camera-panel">
                <div class="vision-camera-header">
                    <p class="eyebrow">MOBILE VISION</p>
                    <h1>Camera for spatial tracking</h1>
                </div>
                <div class="vision-camera-preview-wrap">
                    <video class="vision-camera-preview" autoplay playsinline muted></video>
                    <div class="vision-camera-overlay" data-vision-status>Waiting for camera access</div>
                </div>
                <div class="vision-camera-controls">
                    <select class="vision-camera-source" data-camera-source hidden></select>
                    <button class="alignment-action" type="button" data-camera-connect>Connect camera</button>
                    <button class="alignment-action" type="button" data-camera-disconnect>Disconnect</button>
                </div>
                <div class="vision-camera-metadata">
                    <p>Session: <strong data-vision-session>Not connected</strong></p>
                    <p>Status: <strong data-vision-status-label>Waiting on permission</strong></p>
                    <p>Detected markers: <strong data-vision-detected>0</strong></p>
                    <p>Last update: <strong data-vision-updated>—</strong></p>
                </div>
            </section>
        </main>
    `;

    const video = app.querySelector('.vision-camera-preview');
    const statusNode = app.querySelector('[data-vision-status]');
    const statusLabel = app.querySelector('[data-vision-status-label]');
    const sessionNode = app.querySelector('[data-vision-session]');
    const detectedNode = app.querySelector('[data-vision-detected]');
    const updatedNode = app.querySelector('[data-vision-updated]');
    const cameraSelect = app.querySelector('[data-camera-source]');
    const connectButton = app.querySelector('[data-camera-connect]');
    const disconnectButton = app.querySelector('[data-camera-disconnect]');

    function setStatus(message, label) {
        statusNode.textContent = message;
        statusLabel.textContent = label;
        cameraState.markerStatus = label;
    }

    function loadCameraDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) {
            return Promise.resolve([]);
        }
        return navigator.mediaDevices.enumerateDevices()
            .then((devices) => devices.filter((device) => device.kind === 'videoinput'))
            .catch(() => []);
    }

    function updateCameraOptions(devices) {
        cameraSelect.innerHTML = devices.length
            ? devices.map((device, index) => `<option value="${index}">${device.label || `Camera ${index + 1}`}</option>`).join('')
            : '<option value="">No cameras found</option>';
        cameraSelect.hidden = devices.length === 0;
    }

    function updateCameraSelection() {
        loadCameraDevices().then((devices) => {
            updateCameraOptions(devices);
            if (devices.length > 0) {
                cameraSelect.value = '0';
            }
        });
    }

    function stopCameraStream() {
        if (cameraState.mediaStream) {
            for (const track of cameraState.mediaStream.getTracks()) {
                track.stop();
            }
            cameraState.mediaStream = null;
        }
        if (video) {
            video.srcObject = null;
        }
    }

    async function connectCamera() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setStatus('This browser does not support camera access.', 'Unsupported');
            return;
        }
        try {
            setStatus('Requesting camera access…', 'Connecting');
            stopCameraStream();
            const devices = await loadCameraDevices();
            const facingMode = devices.length > 1 ? { ideal: 'environment' } : 'environment';
            cameraState.mediaStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode,
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
            video.srcObject = cameraState.mediaStream;
            video.play().catch(() => {});
            setStatus('Live camera preview active.', 'Detecting');
            updateCameraSelection();
        } catch (error) {
            console.error('Unable to access the camera:', error);
            setStatus('Camera permission was denied or no camera is available.', 'Unavailable');
        }
    }

    function decodeMarkerGrid(grid) {
        const cells = [];
        for (let row = 1; row < grid.length - 1; row += 1) {
            for (let column = 1; column < grid[row].length - 1; column += 1) {
                cells.push(grid[row][column] < 128 ? 1 : 0);
            }
        }
        let value = 0;
        for (let index = 0; index < cells.length; index += 1) {
            value = (value << 1) | cells[index];
        }
        return value % 1000;
    }

    function detectMarkersFromFrame() {
        if (!video || video.readyState < 2 || !cameraState.mediaStream) {
            return;
        }
        const width = 220;
        const height = Math.max(160, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, width, height);
        const { data } = context.getImageData(0, 0, width, height);
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        let darkPixels = 0;
        for (let index = 0; index < data.length; index += 4) {
            const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
            if (brightness < 110) {
                const x = (index / 4) % width;
                const y = Math.floor((index / 4) / width);
                darkPixels += 1;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        if (darkPixels < 400) {
            return;
        }
        const regionWidth = maxX - minX + 1;
        const regionHeight = maxY - minY + 1;
        if (regionWidth < 30 || regionHeight < 30 || Math.abs(regionWidth - regionHeight) > regionWidth * 0.5) {
            return;
        }
        const left = Math.max(0, minX - 4);
        const top = Math.max(0, minY - 4);
        const right = Math.min(width, maxX + 5);
        const bottom = Math.min(height, maxY + 5);
        const grid = Array.from({ length: 5 }, (_, rowIndex) => {
            const row = [];
            for (let columnIndex = 0; columnIndex < 5; columnIndex += 1) {
                const cellX0 = left + ((right - left) * columnIndex) / 5;
                const cellY0 = top + ((bottom - top) * rowIndex) / 5;
                const cellX1 = left + ((right - left) * (columnIndex + 1)) / 5;
                const cellY1 = top + ((bottom - top) * (rowIndex + 1)) / 5;
                let brightness = 255;
                let samples = 0;
                for (let pixelY = Math.floor(cellY0); pixelY < cellY1; pixelY += 1) {
                    for (let pixelX = Math.floor(cellX0); pixelX < cellX1; pixelX += 1) {
                        const dataIndex = ((pixelY * width) + pixelX) * 4;
                        if (dataIndex + 2 >= data.length) {
                            continue;
                        }
                        brightness += ((data[dataIndex] + data[dataIndex + 1] + data[dataIndex + 2]) / 3);
                        samples += 1;
                    }
                }
                brightness = samples ? brightness / (samples + 1) : 255;
                row.push(brightness);
            }
            return row;
        });
        const markerId = decodeMarkerGrid(grid);
        if (!Number.isFinite(markerId) || markerId === 0) {
            return;
        }

        const centerX = ((minX + maxX) / 2) / width;
        const centerY = ((minY + maxY) / 2) / height;
        const rotation = Math.atan2(maxY - minY, maxX - minX);
        const payload = {
            markers: [{
                id: markerId,
                x: Number(centerX.toFixed(4)),
                y: Number(centerY.toFixed(4)),
                rotation: Number(rotation.toFixed(4)),
                confidence: 0.9,
                visible: true,
                timestamp: Date.now(),
                deviceId: `marker-${markerId}`
            }]
        };
        if (cameraState.socket && cameraState.socket.connected && Date.now() - cameraState.lastMarkerReportAt > 250) {
            cameraState.lastMarkerReportAt = Date.now();
            cameraState.socket.emit('vision:camera:report', payload);
            detectedNode.textContent = String(markerId);
            updatedNode.textContent = new Date().toLocaleTimeString();
        }
    }

    function activateDetectionLoop() {
        if (!cameraState.mediaStream) {
            return;
        }
        if (cameraState.frames > 0) {
            window.clearInterval(cameraState.frames);
        }
        cameraState.frames = window.setInterval(() => {
            detectMarkersFromFrame();
        }, 250);
    }

    if (token) {
        sessionNode.textContent = token.slice(0, 12);
    }
    connectButton.addEventListener('click', () => {
        if (!cameraState.socket?.connected) {
            setStatus('The camera session is still connecting. Please wait a moment.', 'Connecting');
            return;
        }
        connectCamera();
    });
    disconnectButton.addEventListener('click', () => {
        if (cameraState.socket?.connected) {
            cameraState.socket.emit('vision:camera:disconnect');
        }
        stopCameraStream();
        setStatus('Camera disconnected.', 'Disconnected');
        sessionNode.textContent = 'Not connected';
    });
    updateCameraSelection();
    cameraSelect.addEventListener('change', () => {
        if (cameraState.mediaStream) {
            connectCamera();
        }
    });

    cameraState.socket = createParallaxSocket();
    cameraState.socket.on('connect', () => {
        const sessionToken = new URLSearchParams(location.search).get('vision');
        if (!sessionToken) {
            setStatus('A vision camera session token is required.', 'Invalid');
            return;
        }
        sessionNode.textContent = sessionToken.slice(0, 12);
        cameraState.socket.emit('vision:camera:join', { token: sessionToken }, (result) => {
            if (result?.ok) {
                setStatus('Vision session connected. Tap “Connect camera” to allow access.', 'Connected');
                sessionNode.textContent = sessionToken.slice(0, 12);
            } else {
                setStatus(result?.message || 'Unable to join the vision camera session.', 'Rejected');
            }
        });
    });

    cameraState.socket.on('disconnect', () => {
        setStatus('Camera socket disconnected.', 'Disconnected');
        sessionNode.textContent = 'Not connected';
    });

    if (token) {
        cameraState.socket.connect();
    }
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
