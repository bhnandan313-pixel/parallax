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
import {
    computeMarkerIdForDevice,
    detectMarkersFromImageData
} from './vision/marker-detection.js';
import { renderArucoMarker } from './vision/marker-renderer.js';
import './styles/main.css';

if (location.pathname === '/controller' || location.pathname === '/controller/') {
    mountController();
} else if (location.pathname === '/vision' || location.pathname === '/vision/') {
    startVisionCamera();
} else {
    startDisplay();
}

function createMarkerOverlay(deviceId, allocatedMarkerId = null) {
    const markerId = Number.isInteger(allocatedMarkerId)
        ? allocatedMarkerId
        : computeMarkerIdForDevice(deviceId);
    const overlay = document.createElement('div');
    overlay.className = 'parallax-vision-marker';
    overlay.setAttribute('aria-label', `Device marker ${markerId}`);
    const canvas = document.createElement('canvas');
    canvas.className = 'parallax-vision-marker-grid';
    const moduleSize = 56;
    const quietZoneModules = 1;
    renderArucoMarker(canvas, markerId, { moduleSize, quietZoneModules });
    const label = document.createElement('span');
    label.className = 'parallax-vision-marker-label';
    label.textContent = `ID ${markerId}`;
    overlay.append(canvas, label);
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
        tracking: null,
        markerStatus: 'Waiting for markers',
        processedFrames: 0,
        detectionCanvas: null,
        lastError: '',
        lastSuccessfulDetectionAt: null,
        registeredMarkers: [],
        lastDiagnosticsLogAt: 0
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
                    <canvas class="vision-camera-marker-overlay" data-vision-marker-overlay></canvas>
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
                    <p>Camera stream: <strong data-vision-camera-status>Not started</strong></p>
                    <p>Frame dimensions: <strong data-vision-frame-dimensions>—</strong></p>
                    <p>Detection loop: <strong data-vision-loop-status>Stopped</strong></p>
                    <p>Frames processed: <strong data-vision-frame-count>0</strong></p>
                    <p>Detected IDs: <strong data-vision-marker-id>None</strong></p>
                    <p>Registered IDs: <strong data-vision-registered-ids>Waiting for report</strong></p>
                    <p>Matched IDs: <strong data-vision-matched-ids>None</strong></p>
                    <p>Unmatched IDs: <strong data-vision-unmatched-ids>None</strong></p>
                    <p>Last successful detection: <strong data-vision-last-detection>Never</strong></p>
                    <p>Detection error: <strong data-vision-error>None</strong></p>
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
    const cameraStatusNode = app.querySelector('[data-vision-camera-status]');
    const loopStatusNode = app.querySelector('[data-vision-loop-status]');
    const frameCountNode = app.querySelector('[data-vision-frame-count]');
    const frameDimensionsNode = app.querySelector('[data-vision-frame-dimensions]');
    const markerIdNode = app.querySelector('[data-vision-marker-id]');
    const registeredMarkerIdsNode = app.querySelector('[data-vision-registered-ids]');
    const matchedMarkerIdsNode = app.querySelector('[data-vision-matched-ids]');
    const unmatchedMarkerIdsNode = app.querySelector('[data-vision-unmatched-ids]');
    const lastDetectionNode = app.querySelector('[data-vision-last-detection]');
    const detectionErrorNode = app.querySelector('[data-vision-error]');
    const markerCanvas = app.querySelector('[data-vision-marker-overlay]');
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
        if (cameraState.frames) {
            window.clearInterval(cameraState.frames);
            cameraState.frames = null;
        }
        loopStatusNode.textContent = 'Stopped';
        cameraStatusNode.textContent = 'Disconnected';
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
            cameraStatusNode.textContent = 'Live';
            updateCameraSelection();
            activateDetectionLoop();
        } catch (error) {
            console.error('Unable to access the camera:', error);
            cameraStatusNode.textContent = 'Unavailable';
            setStatus('Camera permission was denied or no camera is available.', 'Unavailable');
        }
    }

    function detectMarkersFromFrame() {
        if (!video || video.readyState < 2 || !cameraState.mediaStream) {
            return;
        }
        const width = 320;
        const height = Math.max(160, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width));
        const canvas = cameraState.detectionCanvas ?? document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        cameraState.detectionCanvas = canvas;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, width, height);
        let markers = [];
        try {
            const imageData = context.getImageData(0, 0, width, height);
            cameraState.processedFrames += 1;
            frameCountNode.textContent = String(cameraState.processedFrames);
            frameDimensionsNode.textContent = `${video.videoWidth}x${video.videoHeight} -> ${width}x${height}`;
            markers = detectMarkersFromImageData(imageData, {
                minConfidence: 0.2,
                onError: (error) => {
                    cameraState.lastError = error.message;
                    detectionErrorNode.textContent = error.message;
                }
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            cameraState.lastError = message;
            detectionErrorNode.textContent = message;
        }
        markerCanvas.width = markerCanvas.clientWidth;
        markerCanvas.height = markerCanvas.clientHeight;
        const overlayContext = markerCanvas.getContext('2d');
        overlayContext.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
        overlayContext.strokeStyle = '#22c55e';
        overlayContext.lineWidth = 3;
        const scaleX = markerCanvas.width / width;
        const scaleY = markerCanvas.height / height;
        for (const marker of markers) {
            overlayContext.beginPath();
            marker.corners.forEach((corner, index) => {
                const x = corner.x * scaleX;
                const y = corner.y * scaleY;
                if (index === 0) {
                    overlayContext.moveTo(x, y);
                } else {
                    overlayContext.lineTo(x, y);
                }
            });
            overlayContext.closePath();
            overlayContext.stroke();
        }
        detectedNode.textContent = String(markers.length);
        markerIdNode.textContent = markers.length
            ? markers.map((marker) => String(marker.id)).join(', ')
            : 'None';
        if (markers.length > 0) {
            cameraState.lastSuccessfulDetectionAt = Date.now();
            lastDetectionNode.textContent = new Date(cameraState.lastSuccessfulDetectionAt).toLocaleTimeString();
        }
        const payload = {
            frame: {
                width,
                height,
                sourceWidth: video.videoWidth || width,
                sourceHeight: video.videoHeight || height
            },
            markers: markers.map((marker) => ({
                id: marker.id,
                x: marker.normalizedCenter.x,
                y: marker.normalizedCenter.y,
                normalizedCenter: marker.normalizedCenter,
                corners: marker.corners.map((corner) => ({
                    x: corner.x / width,
                    y: corner.y / height
                })),
                rotation: marker.rotation,
                confidence: marker.confidence,
                visible: true,
                timestamp: Date.now(),
                deviceId: null
            }))
        };
        if (cameraState.socket && cameraState.socket.connected && Date.now() - cameraState.lastMarkerReportAt > 250) {
            cameraState.lastMarkerReportAt = Date.now();
            cameraState.socket.timeout(3000).emit('vision:camera:report', payload, (error, response) => {
                if (error || !response?.ok) {
                    cameraState.lastError = response?.message || error?.message || 'Observation transmission timed out';
                    detectionErrorNode.textContent = cameraState.lastError;
                    return;
                }
                cameraState.registeredMarkers = response.registeredMarkers ?? [];
                registeredMarkerIdsNode.textContent = cameraState.registeredMarkers.length
                    ? cameraState.registeredMarkers.map(({ markerId, deviceId }) => `${markerId} -> ${deviceId}`).join(', ')
                    : 'None';
                matchedMarkerIdsNode.textContent = response.matchedMarkerIds?.length
                    ? response.matchedMarkerIds.map(({ markerId, deviceId }) => `${markerId} -> ${deviceId}`).join(', ')
                    : 'None';
                unmatchedMarkerIdsNode.textContent = response.unmatchedMarkerIds?.length
                    ? response.unmatchedMarkerIds.join(', ')
                    : 'None';
                cameraState.lastError = '';
                detectionErrorNode.textContent = 'None';
                updatedNode.textContent = new Date().toLocaleTimeString();
            });
        }
        if (Date.now() - cameraState.lastDiagnosticsLogAt >= 1000) {
            cameraState.lastDiagnosticsLogAt = Date.now();
            console.info('[Parallax Vision] Camera diagnostics', {
                streamStatus: cameraStatusNode.textContent,
                sourceFrame: `${video.videoWidth}x${video.videoHeight}`,
                processedFrame: `${width}x${height}`,
                framesProcessed: cameraState.processedFrames,
                detectedMarkerCount: markers.length,
                detectedMarkerIds: markers.map((marker) => marker.id),
                registeredMarkerIds: cameraState.registeredMarkers,
                matchedMarkerIds: matchedMarkerIdsNode.textContent,
                unmatchedMarkerIds: unmatchedMarkerIdsNode.textContent,
                lastSuccessfulDetectionAt: cameraState.lastSuccessfulDetectionAt
                    ? new Date(cameraState.lastSuccessfulDetectionAt).toISOString()
                    : null
            });
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
        loopStatusNode.textContent = 'Running';
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
    let allocatedMarkerId = null;
    let totalScreens = 2;
    let displayStatus = 'waiting';
    let displayError = null;
    let alignmentRevision = null;
    let displayedUpdateId = null;
    let socket = null;
    let identifyOverlay = null;
    let identifyTimer = null;
    let playbackDriftTimer = null;
    let markerOverlay = null;
    let visionMarkerMode = false;
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
        allocatedMarkerId = Number.isInteger(assignment.markerId)
            ? assignment.markerId
            : allocatedMarkerId;
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
            syncVisionMarkerOverlay();
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

    function syncVisionMarkerOverlay() {
        markerOverlay?.remove();
        markerOverlay = null;
        if (!visionMarkerMode || !display) {
            return;
        }
        markerOverlay = createMarkerOverlay(deviceId, allocatedMarkerId);
        display.prepend(markerOverlay);
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
    socket.on('vision:marker-mode', (request) => {
        visionMarkerMode = request?.enabled === true;
        syncVisionMarkerOverlay();
    });
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
