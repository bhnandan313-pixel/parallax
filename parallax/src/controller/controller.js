import { createParallaxSocket, getParallaxServerBaseUrl } from '../core/socket.js';
import { formatAlignmentValue, getAlignmentStep } from './alignment-controls.js';
import './controller.css';

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

export function mountController() {
    const root = document.querySelector('#app');
    if (!root) {
        throw new Error('PARALLAX controller root was not found');
    }

    document.body.classList.add('controller-page');
    root.className = 'controller-root';
    root.innerHTML = `
        <main class="controller-shell">
            <header class="controller-header">
                <a class="brand" href="/" aria-label="Parallax display">
                    <span class="brand-mark" aria-hidden="true">P</span>
                    <span>PARALLAX<span class="brand-caption">DISPLAY CONTROL</span></span>
                </a>
                <div class="connection-summary" aria-live="polite">
                    <span class="connection-dot" data-controller-connection></span>
                    <span data-controller-connection-label>Connecting to display system</span>
                </div>
            </header>

            <section class="controller-intro">
                <p class="eyebrow">LIVE DISPLAY SYSTEM</p>
                <h1>Control your panorama</h1>
                <p>Upload an image and publish it across your connected screens.</p>
            </section>

            <section class="controller-grid">
                <div class="controller-card upload-card">
                    <div class="card-heading">
                        <div>
                            <p class="eyebrow">CONTENT</p>
                            <h2>Publish an image</h2>
                        </div>
                        <span class="step-badge">01</span>
                    </div>

                    <label class="drop-zone" data-drop-zone>
                        <input data-file-input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" hidden>
                        <span class="upload-icon" aria-hidden="true">↑</span>
                        <strong data-drop-label>Drop an image here</strong>
                        <span class="drop-hint">JPG, PNG or WebP · Up to 15 MB</span>
                        <span class="browse-button">Browse files</span>
                    </label>

                    <div class="image-preview" data-image-preview>
                        <div class="preview-placeholder">
                            <span class="preview-placeholder-icon" aria-hidden="true">▧</span>
                            <span>Your selected image preview will appear here</span>
                        </div>
                    </div>

                    <div class="file-details" data-file-details hidden>
                        <span class="file-name" data-file-name></span>
                        <span class="file-dimensions" data-file-dimensions></span>
                    </div>

                    <div class="upload-progress" data-upload-progress hidden>
                        <div class="progress-label">
                            <span data-progress-label>Uploading image</span>
                            <span data-progress-value>0%</span>
                        </div>
                        <div class="progress-track"><span data-progress-bar></span></div>
                    </div>

                    <button class="publish-button" data-publish-button type="button" disabled>
                        <span>Publish to displays</span><span aria-hidden="true">→</span>
                    </button>
                    <p class="publish-status" data-publish-status role="status" aria-live="polite"></p>
                </div>

                <aside class="controller-side">
                    <section class="controller-card screens-card">
                        <div class="card-heading">
                            <div>
                                <p class="eyebrow">NETWORK</p>
                                <h2>Connected displays</h2>
                            </div>
                            <span class="device-count" data-device-count>0 <small>of 2</small></span>
                        </div>
                        <div class="screen-list">
                            <div class="screen-row" data-screen="1">
                                <span class="screen-icon" aria-hidden="true">▣</span>
                                <span class="screen-label"><strong>Screen 1</strong><small>Left panorama</small></span>
                                <span class="screen-state"><i></i><span>Waiting</span></span>
                            </div>
                            <div class="screen-row" data-screen="2">
                                <span class="screen-icon" aria-hidden="true">▣</span>
                                <span class="screen-label"><strong>Screen 2</strong><small>Right panorama</small></span>
                                <span class="screen-state"><i></i><span>Waiting</span></span>
                            </div>
                        </div>
                        <p class="network-note" data-network-note>Waiting for phones to connect.</p>
                    </section>

                    <section class="controller-card current-card">
                        <div class="card-heading">
                            <div>
                                <p class="eyebrow">NOW SHOWING</p>
                                <h2>Current display</h2>
                            </div>
                            <span class="live-badge"><i></i> LIVE</span>
                        </div>
                        <div class="current-image" data-current-image>
                            <div class="current-placeholder">No image published yet</div>
                        </div>
                        <p class="current-content-name" data-current-name>Waiting for content</p>
                        <p class="current-content-meta" data-current-meta>Connect a display to get started</p>
                    </section>
                </aside>
            </section>
            <section class="controller-card calibration-card">
                <div class="card-heading">
                    <div>
                        <span class="eyebrow">DISPLAY ALIGNMENT</span>
                        <h2>Calibration</h2>
                    </div>
                    <span id="calibration-status" class="status-badge">OFF</span>
                </div>
                <p class="card-description">Display a reference grid across both phones to check alignment.</p>
                <button id="calibration-toggle" class="publish-button" type="button">Enable Calibration</button>
                <ol class="setup-steps" aria-label="Calibration setup steps">
                    <li>Connect both phones</li>
                    <li>Enable calibration grid</li>
                    <li>Align Screen 1</li>
                    <li>Align Screen 2</li>
                    <li>Check the center seam</li>
                    <li>Save a preset</li>
                    <li>Disable calibration grid</li>
                </ol>
            </section>

            <section class="controller-card alignment-card">
                <div class="card-heading">
                    <div>
                        <p class="eyebrow">PHYSICAL DISPLAY SETUP</p>
                        <h2>Screen alignment</h2>
                    </div>
                </div>
                <p class="card-description">
                    Adjust each phone independently. Changes apply live to its assigned screen.
                </p>
                <label class="fine-adjustment-toggle">
                    <input type="checkbox" data-fine-adjustment>
                    <span>Fine adjustment</span>
                    <small>0.1 px / 0.001×</small>
                </label>
                <div class="alignment-grid">
                    ${[1, 2].map((screen) => `
                        <section class="alignment-screen" data-alignment-screen="${screen}">
                            <div class="alignment-screen-heading">
                                <h3>Screen ${screen}</h3>
                                <button class="alignment-reset" type="button" data-alignment-reset="${screen}" disabled>
                                    Reset Screen ${screen}
                                </button>
                            </div>
                            <label class="alignment-control">
                                <span>Horizontal <output data-alignment-value="horizontal">0 px</output></span>
                                <input type="range" min="-50" max="50" step="1" value="0" data-alignment-axis="horizontal" disabled>
                            </label>
                            <label class="alignment-control">
                                <span>Vertical <output data-alignment-value="vertical">0 px</output></span>
                                <input type="range" min="-50" max="50" step="1" value="0" data-alignment-axis="vertical" disabled>
                            </label>
                            <label class="alignment-control">
                                <span>Scale <output data-alignment-value="scale">1.00×</output></span>
                                <input type="range" min="0.95" max="1.05" step="0.01" value="1" data-alignment-axis="scale" disabled>
                            </label>
                        </section>
                    `).join('')}
                </div>
                <div class="preset-controls">
                    <label class="preset-name-control">
                        <span>Save current alignment as preset</span>
                        <input type="text" maxlength="32" data-preset-name placeholder="Preset name">
                    </label>
                    <button class="alignment-action" type="button" data-preset-save disabled>Save preset</button>
                    <label class="preset-select-control">
                        <span>Load preset</span>
                        <select data-preset-select disabled></select>
                    </label>
                    <button class="alignment-action" type="button" data-preset-load disabled>Load preset</button>
                    <button class="alignment-action is-danger" type="button" data-preset-delete disabled>Delete preset</button>
                    <button class="alignment-action" type="button" data-reset-all disabled>Reset All</button>
                </div>
                <p class="alignment-status" data-alignment-status role="status" aria-live="polite">
                    Waiting for alignment settings from the server.
                </p>
            </section>

            <section class="controller-card diagnostics-card" aria-labelledby="diagnostics-title">
                <div class="card-heading">
                    <div>
                        <p class="eyebrow">SYSTEM STATUS</p>
                        <h2 id="diagnostics-title">Diagnostics</h2>
                    </div>
                    <span class="status-badge" data-diagnostics-updated>Unknown</span>
                </div>
                <div class="diagnostics-summary">
                    <p>Socket: <strong data-diagnostics-socket>Unknown</strong></p>
                    <p>Backend: <strong data-diagnostics-backend>Unknown</strong></p>
                    <p>Active displays: <strong data-diagnostics-count>Unknown</strong></p>
                    <p>Current content: <strong data-diagnostics-content>Unknown</strong></p>
                    <p>Calibration grid: <strong data-diagnostics-grid>Unknown</strong></p>
                    <p>Last alignment update: <strong data-diagnostics-alignment-time>Unknown</strong></p>
                    <p>Alignment delivery: <strong data-diagnostics-delivery>Unknown</strong></p>
                    <p>Last server communication: <strong data-diagnostics-communication>Unknown</strong></p>
                </div>
                <div class="diagnostics-grid">
                    ${[1, 2].map((screen) => `
                        <article class="diagnostics-screen" data-diagnostics-screen="${screen}">
                            <h3>Screen ${screen}</h3>
                            <p>Connection: <strong data-diagnostic-connection>Unknown</strong></p>
                            <p>Display: <strong data-diagnostic-display>Unknown</strong></p>
                            <p>Alignment: <strong data-diagnostic-alignment>Unknown</strong></p>
                            <p>Latest settings: <strong data-diagnostic-sync>Unknown</strong></p>
                            <p>Last activity: <strong data-diagnostic-activity>Unknown</strong></p>
                            <p>Image status: <strong data-diagnostic-image>Unknown</strong></p>
                        </article>
                    `).join('')}
                </div>
            </section>

            <footer class="controller-footer">
                <span>PARALLAX · Synchronized panoramic display</span>
                <span>Images are limited to 15 MB</span>
            </footer>
        </main>
    `;

    const fileInput = root.querySelector('[data-file-input]');
    const dropZone = root.querySelector('[data-drop-zone]');
    const dropLabel = root.querySelector('[data-drop-label]');
    const preview = root.querySelector('[data-image-preview]');
    const fileDetails = root.querySelector('[data-file-details]');
    const publishButton = root.querySelector('[data-publish-button]');
    const publishStatus = root.querySelector('[data-publish-status]');
    const progress = root.querySelector('[data-upload-progress]');
    const calibrationButton = root.querySelector('#calibration-toggle');
    const calibrationStatus = root.querySelector('#calibration-status');
    const alignmentStatus = root.querySelector('[data-alignment-status]');
    const fineAdjustmentInput = root.querySelector('[data-fine-adjustment]');
    const presetNameInput = root.querySelector('[data-preset-name]');
    const presetSelect = root.querySelector('[data-preset-select]');
    const presetSaveButton = root.querySelector('[data-preset-save]');
    const presetLoadButton = root.querySelector('[data-preset-load]');
    const presetDeleteButton = root.querySelector('[data-preset-delete]');
    const resetAllButton = root.querySelector('[data-reset-all]');
    const socket = createParallaxSocket();

    let selectedFile = null;
    let previewUrl = null;
    let uploadRequest = null;
    let calibrationEnabled = false;
    const alignmentByScreen = {
        1: { horizontal: 0, vertical: 0, scale: 1 },
        2: { horizontal: 0, vertical: 0, scale: 1 }
    };
    const alignmentRequestByScreen = { 1: 0, 2: 0 };
    const pendingAlignmentTimers = { 1: null, 2: null };
    let presets = [];
    let diagnostics = null;
    let lastServerCommunication = null;
    let alignmentReady = false;

    function renderAlignmentScreen(screen) {
        const panel = root.querySelector(`[data-alignment-screen="${screen}"]`);
        if (!panel) {
            return;
        }

        const settings = alignmentByScreen[screen];
        for (const axis of ['horizontal', 'vertical', 'scale']) {
            const input = panel.querySelector(`[data-alignment-axis="${axis}"]`);
            const output = panel.querySelector(`[data-alignment-value="${axis}"]`);
            input.value = String(settings[axis]);
            input.step = getAlignmentStep(axis, fineAdjustmentInput.checked);
            output.textContent = formatAlignmentValue(axis, settings[axis], fineAdjustmentInput.checked);
            input.disabled = !alignmentReady;
        }
        panel.querySelector('[data-alignment-reset]').disabled = !alignmentReady;
        const diagnosticsPanel = root.querySelector(`[data-diagnostics-screen="${screen}"]`);
        diagnosticsPanel.querySelector('[data-diagnostic-alignment]').textContent =
            `${settings.horizontal.toFixed(1)} px · ${settings.vertical.toFixed(1)} px · ${settings.scale.toFixed(3)}×`;
    }

    function renderAlignmentUI() {
        for (const screen of [1, 2]) {
            renderAlignmentScreen(screen);
        }
    }

    function updatePresetControls() {
        const selectedPreset = presets.find((preset) => preset.name === presetSelect.value);
        presetSelect.disabled = !alignmentReady || !presets.length;
        presetSaveButton.disabled = !alignmentReady;
        presetLoadButton.disabled = !alignmentReady || !selectedPreset;
        presetDeleteButton.disabled = !alignmentReady || !selectedPreset || selectedPreset.isDefault;
        resetAllButton.disabled = !alignmentReady;
    }

    function setPresets(nextPresets) {
        if (!Array.isArray(nextPresets)
            || nextPresets.some((preset) => typeof preset?.name !== 'string'
                || !preset.screens || typeof preset.screens !== 'object')) {
            return;
        }

        const selectedName = presetSelect.value;
        presets = nextPresets;
        presetSelect.replaceChildren();
        for (const preset of presets) {
            const option = document.createElement('option');
            option.value = preset.name;
            option.textContent = preset.name;
            presetSelect.append(option);
        }
        presetSelect.value = presets.some((preset) => preset.name === selectedName)
            ? selectedName
            : presets[0]?.name ?? '';
        updatePresetControls();
    }

    function emitControllerCommand(eventName, payload, onSuccess, onFailure) {
        if (!socket.connected) {
            alignmentStatus.textContent = 'Cannot update calibration: backend is disconnected.';
            alignmentStatus.classList.add('is-error');
            onFailure?.();
            return;
        }
        alignmentStatus.classList.remove('is-error');
        socket.timeout(5000).emit(eventName, payload, (error, response) => {
            if (error) {
                alignmentStatus.textContent = 'The server did not acknowledge the calibration request.';
                alignmentStatus.classList.add('is-error');
                onFailure?.();
                return;
            }
            if (!response?.ok) {
                alignmentStatus.textContent = response?.message || 'Calibration request failed.';
                alignmentStatus.classList.add('is-error');
                console.error(`${eventName} failed:`, response?.message);
                onFailure?.();
                return;
            }
            alignmentStatus.classList.remove('is-error');
            onSuccess?.(response);
        });
    }

    function sendAlignment(screen) {
        if (!alignmentReady) {
            return;
        }

        clearTimeout(pendingAlignmentTimers[screen]);
        pendingAlignmentTimers[screen] = null;
        const request = ++alignmentRequestByScreen[screen];
        const settings = { ...alignmentByScreen[screen] };
        alignmentStatus.textContent = `Updating Screen ${screen} alignment...`;
        socket.timeout(5000).emit('alignment:set', {
            screen,
            settings
        }, (error, response) => {
            if (request !== alignmentRequestByScreen[screen]) {
                return;
            }

            if (error) {
                alignmentStatus.textContent = 'The server did not acknowledge the alignment update.';
                alignmentStatus.classList.add('is-error');
                return;
            }
            if (!response?.ok) {
                alignmentStatus.textContent = response?.message || 'Alignment update failed.';
                alignmentStatus.classList.add('is-error');
                console.error('Alignment update failed:', response?.message);
                return;
            }

            alignmentStatus.classList.remove('is-error');
            alignmentStatus.textContent = `Screen ${screen} alignment updated.`;
        });
    }

    function queueAlignment(screen) {
        clearTimeout(pendingAlignmentTimers[screen]);
        pendingAlignmentTimers[screen] = setTimeout(() => sendAlignment(screen), 80);
    }

    function flushAlignment() {
        for (const screen of [1, 2]) {
            if (pendingAlignmentTimers[screen] !== null) {
                sendAlignment(screen);
            }
        }
    }

    function updateCalibrationUI() {
        if (calibrationButton) {
            calibrationButton.textContent = calibrationEnabled
                ? 'Disable Calibration'
                : 'Enable Calibration';
        }

        if (calibrationStatus) {
            calibrationStatus.textContent = calibrationEnabled ? 'ON' : 'OFF';
        }
    }

    updateCalibrationUI();

    calibrationButton?.addEventListener('click', () => {
        calibrationButton.disabled = true;
        emitControllerCommand('calibration:set', { enabled: !calibrationEnabled }, (response) => {
            calibrationButton.disabled = false;
            calibrationEnabled = response.enabled;
            updateCalibrationUI();
            alignmentStatus.textContent = `Calibration grid ${calibrationEnabled ? 'enabled' : 'disabled'}.`;
        }, () => {
            calibrationButton.disabled = false;
        });
    });

    fineAdjustmentInput.addEventListener('change', renderAlignmentUI);

    for (const screen of [1, 2]) {
        const panel = root.querySelector(`[data-alignment-screen="${screen}"]`);
        panel.querySelectorAll('[data-alignment-axis]').forEach((input) => {
            input.addEventListener('input', () => {
                const axis = input.dataset.alignmentAxis;
                alignmentByScreen[screen][axis] = Number(input.value);
                renderAlignmentScreen(screen);
                queueAlignment(screen);
            });
            input.addEventListener('change', () => sendAlignment(screen));
        });
        panel.querySelector('[data-alignment-reset]').addEventListener('click', () => {
            alignmentByScreen[screen] = {
                horizontal: 0,
                vertical: 0,
                scale: 1
            };
            renderAlignmentScreen(screen);
            sendAlignment(screen);
        });
    }

    presetSelect.addEventListener('change', updatePresetControls);
    presetSaveButton.addEventListener('click', () => {
        flushAlignment();
        emitControllerCommand('preset:save', { name: presetNameInput.value }, (response) => {
            setPresets(response.presets);
            alignmentStatus.textContent = `Preset "${presetNameInput.value.trim()}" saved.`;
            presetNameInput.value = '';
        });
    });
    presetLoadButton.addEventListener('click', () => {
        flushAlignment();
        emitControllerCommand('preset:load', { name: presetSelect.value }, (response) => {
            for (const screen of [1, 2]) {
                alignmentByScreen[screen] = { ...response.screens[screen] };
            }
            renderAlignmentUI();
            alignmentStatus.textContent = `Preset "${response.name}" loaded.`;
        });
    });
    presetDeleteButton.addEventListener('click', () => {
        const name = presetSelect.value;
        const preset = presets.find((entry) => entry.name === name);
        if (!preset || preset.isDefault) {
            return;
        }
        if (!window.confirm(`Delete the "${name}" preset? Current alignment will not change.`)) {
            return;
        }
        emitControllerCommand('preset:delete', { name }, (response) => {
            setPresets(response.presets);
            alignmentStatus.textContent = `Preset "${name}" deleted. Current alignment was not changed.`;
        });
    });
    resetAllButton.addEventListener('click', () => {
        flushAlignment();
        emitControllerCommand('preset:load', { name: 'Default' }, (response) => {
            for (const screen of [1, 2]) {
                alignmentByScreen[screen] = { ...response.screens[screen] };
            }
            renderAlignmentUI();
            alignmentStatus.textContent = 'Both screens reset to neutral alignment.';
        });
    });

    function setPublishStatus(message, state = '') {
        publishStatus.textContent = message;
        publishStatus.className = `publish-status${state ? ` ${state}` : ''}`;
    }

    function setUploadProgress(value, label = 'Uploading image') {
        progress.hidden = false;
        root.querySelector('[data-progress-label]').textContent = label;
        root.querySelector('[data-progress-value]').textContent = `${value}%`;
        root.querySelector('[data-progress-bar]').style.width = `${value}%`;
    }

    function setCurrentContent(imageUrl, filename, width, height) {
        const currentImage = root.querySelector('[data-current-image]');
        currentImage.replaceChildren();
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = `Currently published panorama: ${filename}`;
        currentImage.append(image);
        root.querySelector('[data-current-name]').textContent = filename;
        root.querySelector('[data-current-meta]').textContent = width && height
            ? `${width} × ${height} · Published to displays`
            : 'Currently displayed';
    }

    function setDevices(devices) {
        markServerCommunication();
        const devicesByScreen = new Map((Array.isArray(devices) ? devices : [])
            .map((device) => [device.screen, device]));
        const activeScreens = new Set([...devicesByScreen.values()]
            .filter((device) => device.socketId)
            .map((device) => device.screen));
        const count = activeScreens.size;
        root.querySelector('[data-device-count]').innerHTML = `${count} <small>of 2</small>`;
        root.querySelector('[data-network-note]').textContent = count === 2
            ? 'Both displays are connected and ready.'
            : count === 1
                ? 'One display is connected. Waiting for the other screen.'
                : 'Waiting for phones to connect.';

        for (const screen of [1, 2]) {
            const row = root.querySelector(`[data-screen="${screen}"]`);
            const device = devicesByScreen.get(screen);
            const connected = Boolean(device?.socketId);
            const state = connected ? 'Connected' : device ? 'Disconnected' : 'Waiting';
            row.classList.toggle('is-connected', connected);
            row.querySelector('.screen-state span').textContent = state;
            row.classList.toggle('is-disconnected', Boolean(device) && !connected);
        }
    }

    function markServerCommunication() {
        lastServerCommunication = new Date().toISOString();
        const communication = root.querySelector('[data-diagnostics-communication]');
        if (communication) {
            communication.textContent = formatTimestamp(lastServerCommunication);
        }
    }

    function formatTimestamp(value) {
        if (typeof value !== 'string') {
            return 'Unknown';
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleTimeString();
    }

    function setDiagnostics(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') {
            return;
        }
        diagnostics = snapshot;
        markServerCommunication();
        root.querySelector('[data-diagnostics-backend]').textContent =
            snapshot.backendConnected === true ? 'Connected' : 'Unknown';
        root.querySelector('[data-diagnostics-count]').textContent =
            Number.isInteger(snapshot.activeDeviceCount) ? `${snapshot.activeDeviceCount} of 2` : 'Unknown';
        const contentId = snapshot.currentContent?.updateId;
        root.querySelector('[data-diagnostics-content]').textContent = typeof contentId === 'string'
            ? `${contentId} · ${formatTimestamp(snapshot.contentUpdatedAt)}`
            : 'Unknown';
        root.querySelector('[data-diagnostics-grid]').textContent =
            typeof snapshot.calibrationEnabled === 'boolean'
                ? (snapshot.calibrationEnabled ? 'Enabled' : 'Disabled')
                : 'Unknown';
        root.querySelector('[data-diagnostics-alignment-time]').textContent =
            formatTimestamp(snapshot.alignmentUpdatedAt);
        const deviceStates = Array.isArray(snapshot.devices) ? snapshot.devices : [];
        const connectedDevices = deviceStates.filter((device) => device.status === 'connected');
        root.querySelector('[data-diagnostics-delivery]').textContent =
            connectedDevices.length === 2 && connectedDevices.every((device) => device.alignmentSynced === true)
                ? 'Both phones received the latest settings'
                : connectedDevices.some((device) => device.alignmentSynced === false)
                    ? 'Waiting for phone confirmation'
                    : 'Unknown';
        root.querySelector('[data-diagnostics-updated]').textContent =
            `Updated ${formatTimestamp(lastServerCommunication)}`;

        for (const screen of [1, 2]) {
            const device = Array.isArray(snapshot.devices)
                ? snapshot.devices.find((entry) => entry.screen === screen)
                : null;
            const panel = root.querySelector(`[data-diagnostics-screen="${screen}"]`);
            const connectionStatus = device?.status;
            const displayStatus = device?.displayStatus;
            const displayError = device?.displayError;
            panel.querySelector('[data-diagnostic-connection]').textContent = connectionStatus
                ? connectionStatus[0].toUpperCase() + connectionStatus.slice(1)
                : 'Unknown';
            panel.querySelector('[data-diagnostic-display]').textContent =
                connectionStatus === 'connected'
                    ? (displayStatus === 'error'
                        ? `Error${displayError ? `: ${displayError}` : ''}`
                        : displayStatus
                            ? displayStatus[0].toUpperCase() + displayStatus.slice(1)
                            : 'Unknown')
                    : 'Unknown';
            panel.querySelector('[data-diagnostic-sync]').textContent =
                device?.alignmentSynced === true
                    ? 'Received latest settings'
                    : device?.alignmentSynced === false
                        ? 'Waiting for display confirmation'
                        : 'Unknown';
            panel.querySelector('[data-diagnostic-activity]').textContent =
                formatTimestamp(device?.lastActivity);
            panel.querySelector('[data-diagnostic-image]').textContent =
                connectionStatus !== 'connected'
                    ? 'Unknown'
                    : displayStatus === 'error' && displayError
                        ? `Error: ${displayError}`
                        : contentId && device?.loadedUpdateId === contentId
                            ? 'Latest content displayed'
                            : device?.loadedUpdateId
                                ? 'Showing previous content'
                                : 'Waiting for image result';
        }
    }

    function showPreview(file) {
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
        previewUrl = URL.createObjectURL(file);
        publishButton.disabled = true;
        const image = new Image();
        image.onload = () => {
            if (selectedFile !== file) {
                return;
            }
            preview.replaceChildren(image);
            root.querySelector('[data-file-name]').textContent = file.name;
            root.querySelector('[data-file-dimensions]').textContent =
                `${image.naturalWidth} × ${image.naturalHeight}`;
            fileDetails.hidden = false;
            publishButton.disabled = false;
            dropLabel.textContent = 'Image selected - drop another to replace';
        };
        image.onerror = () => {
            if (selectedFile === file) {
                selectedFile = null;
                publishButton.disabled = true;
                setPublishStatus('This file could not be decoded as an image.', 'is-error');
            }
        };
        image.src = previewUrl;
    }

    function selectFile(file) {
        if (!file) {
            return;
        }
        if (!ACCEPTED_EXTENSIONS.test(file.name)) {
            setPublishStatus('Choose a JPG, JPEG, PNG, or WebP image.', 'is-error');
            return;
        }
        if (file.size > MAX_FILE_SIZE) {
            setPublishStatus('The selected image exceeds the 15 MB limit.', 'is-error');
            return;
        }

        selectedFile = file;
        progress.hidden = true;
        setPublishStatus('');
        showPreview(file);
    }

    function publishSelectedImage() {
        if (!selectedFile || uploadRequest) {
            return;
        }

        const fileToUpload = selectedFile;
        publishButton.disabled = true;
        setPublishStatus('Uploading and publishing image...');
        setUploadProgress(0);

        const formData = new FormData();
        formData.append('image', fileToUpload, fileToUpload.name);
        uploadRequest = new XMLHttpRequest();
        uploadRequest.open('POST', `${getParallaxServerBaseUrl()}/api/upload`);
        uploadRequest.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                setUploadProgress(Math.round((event.loaded / event.total) * 100));
            }
        });
        uploadRequest.addEventListener('load', (event) => {
            const request = event.currentTarget;
            uploadRequest = null;
            publishButton.disabled = !selectedFile;
            let result;
            try {
                result = JSON.parse(request.responseText);
            } catch {
                setPublishStatus('Upload failed: server returned an invalid response.', 'is-error');
                return;
            }

            if (request.status < 200 || request.status >= 300) {
                setPublishStatus(`Upload failed: ${result.error || 'Unknown server error'}`, 'is-error');
                return;
            }

            setUploadProgress(100, 'Published');
            const filename = result.filename || fileToUpload.name;
            setCurrentContent(result.imageUrl, filename, result.width, result.height);
            setPublishStatus(
                result.connectedDevices
                    ? `Published to ${result.connectedDevices} connected display${result.connectedDevices === 1 ? '' : 's'}.`
                    : 'Image saved. No displays are connected; it will load when a phone connects.',
                'is-success'
            );
        });
        uploadRequest.addEventListener('error', () => {
            uploadRequest = null;
            publishButton.disabled = !selectedFile;
            setPublishStatus('Upload failed: could not reach the Parallax server.', 'is-error');
        });
        uploadRequest.send(formData);
    }

    fileInput.addEventListener('change', () => selectFile(fileInput.files?.[0]));
    publishButton.addEventListener('click', publishSelectedImage);

    for (const eventName of ['dragenter', 'dragover']) {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropZone.classList.add('is-dragging');
        });
    }
    for (const eventName of ['dragleave', 'drop']) {
        dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropZone.classList.remove('is-dragging');
        });
    }
    dropZone.addEventListener('drop', (event) => selectFile(event.dataTransfer?.files?.[0]));

    socket.on('connect', () => {
        root.querySelector('[data-controller-connection]').classList.add('is-online');
        root.querySelector('[data-controller-connection-label]').textContent = 'Display system connected';
        root.querySelector('[data-diagnostics-socket]').textContent = 'Connected';
        calibrationButton.disabled = !socket.connected;
        socket.emit('controller:register');
    });
    socket.on('disconnect', () => {
        alignmentReady = false;
        for (const screen of [1, 2]) {
            clearTimeout(pendingAlignmentTimers[screen]);
            pendingAlignmentTimers[screen] = null;
        }
        renderAlignmentUI();
        updatePresetControls();
        calibrationButton.disabled = true;
        root.querySelector('[data-controller-connection]').classList.remove('is-online');
        root.querySelector('[data-controller-connection-label]').textContent = 'Reconnecting to display system';
        root.querySelector('[data-diagnostics-socket]').textContent = 'Disconnected';
        root.querySelector('[data-diagnostics-backend]').textContent = 'Disconnected';
    });
    socket.on('connect_error', (error) => {
        root.querySelector('[data-controller-connection-label]').textContent =
            `Connection error: ${error.message}`;
        root.querySelector('[data-diagnostics-socket]').textContent = `Error: ${error.message}`;
    });
    socket.io.on('reconnect_attempt', () => {
        root.querySelector('[data-controller-connection-label]').textContent =
            'Reconnecting to display system';
        root.querySelector('[data-diagnostics-socket]').textContent = 'Reconnecting';
    });
    socket.io.on('reconnect_error', (error) => {
        root.querySelector('[data-diagnostics-socket]').textContent =
            `Error: ${error.message}`;
    });
    socket.on('devices:update', setDevices);
    socket.on('diagnostics:update', setDiagnostics);
    socket.on('presets:current', (state) => {
        markServerCommunication();
        setPresets(state?.presets);
    });
    socket.on('calibration:current', (state) => {
        markServerCommunication();
        if (typeof state?.enabled !== 'boolean') {
            return;
        }

        calibrationEnabled = state.enabled;
        updateCalibrationUI();
        if (diagnostics) {
            setDiagnostics({ ...diagnostics, calibrationEnabled });
        }
    });
    socket.on('alignment:current', (state) => {
        markServerCommunication();
        const screens = state?.screens;
        if (!screens || typeof screens !== 'object') {
            return;
        }

        for (const screen of [1, 2]) {
            const settings = screens[screen];
            if (!settings
                || !Number.isFinite(settings.horizontal)
                || settings.horizontal < -50
                || settings.horizontal > 50
                || !Number.isFinite(settings.vertical)
                || settings.vertical < -50
                || settings.vertical > 50
                || !Number.isFinite(settings.scale)
                || settings.scale < 0.95
                || settings.scale > 1.05) {
                return;
            }

            alignmentByScreen[screen] = { ...settings };
        }

        alignmentReady = true;
        renderAlignmentUI();
        updatePresetControls();
        alignmentStatus.textContent = 'Alignment settings synchronized.';
        alignmentStatus.classList.remove('is-error');
    });
    socket.on('content:current', (content) => {
        markServerCommunication();
        if (content?.contentType === 'image' && content.imageUrl) {
            setCurrentContent(content.imageUrl, 'Current panorama', 0, 0);
            root.querySelector('[data-current-meta]').textContent = 'Currently displayed';
        }
    });

    window.addEventListener('beforeunload', () => {
        socket.disconnect();
        for (const screen of [1, 2]) {
            clearTimeout(pendingAlignmentTimers[screen]);
        }
        uploadRequest?.abort();
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
    }, { once: true });
}
