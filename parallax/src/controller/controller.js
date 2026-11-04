import { createParallaxSocket, getParallaxServerBaseUrl } from '../core/socket.js';
import { formatAlignmentValue, getAlignmentStep } from './alignment-controls.js';
import QRCode from 'qrcode';
import './controller.css';

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

export function mountController() {
    const root = document.querySelector('#app');
    if (!root) {
        throw new Error('PARALLAX controller root was not found');
    }

    document.documentElement.classList.add('controller-page');
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
                        <button class="alignment-action add-device-button" type="button" data-add-device disabled>
                            Add Device
                        </button>
                        <div class="screen-config-controls">
                            <label>Screen count
                                <select data-screen-count disabled>
                                    ${Array.from({ length: 11 }, (_, index) =>
                                        `<option value="${index + 2}">${index + 2}</option>`).join('')}
                                </select>
                            </label>
                            <label>Assignment mode
                                <select data-assignment-mode disabled>
                                    <option value="automatic">Automatic</option>
                                    <option value="manual">Manual</option>
                                </select>
                            </label>
                            <button class="alignment-action" type="button" data-screen-config-save disabled>
                                Apply configuration
                            </button>
                        </div>
                        <div class="screen-list" data-screen-list></div>
                        <h3 class="device-list-heading">Registered devices</h3>
                        <div class="device-assignment-list" data-device-assignment-list></div>
                        <p class="alignment-status" data-assignment-status role="status" aria-live="polite"></p>
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

            <section class="controller-card panorama-dashboard" aria-labelledby="dashboard-title">
                <div class="card-heading">
                    <div>
                        <p class="eyebrow">LIVE DISPLAY WALL</p>
                        <h2 id="dashboard-title">Visual panorama dashboard</h2>
                    </div>
                    <div class="dashboard-metrics">
                        <span><strong data-dashboard-screen-count>2</strong> screens</span>
                        <span><strong data-dashboard-device-count>0</strong> connected</span>
                    </div>
                </div>
                <p class="card-description">Drag a connected device onto a screen to assign it. You can also use each screen's assignment menu.</p>
                <div class="panorama-wall" data-panorama-wall aria-label="Panorama screen assignments"></div>
                <div class="panorama-preview-wrap">
                    <div class="panorama-preview-heading">
                        <h3>Full panorama preview</h3>
                        <span data-dashboard-content-status>Waiting for content</span>
                    </div>
                    <div class="panorama-preview" data-panorama-preview>
                        <p class="dashboard-empty-state">Publish an image to preview the complete panorama.</p>
                    </div>
                </div>
                <div class="dashboard-devices-wrap">
                    <div class="panorama-preview-heading">
                        <h3>Device information</h3>
                        <span>Drag a device card to a screen</span>
                    </div>
                    <div class="dashboard-devices" data-dashboard-devices>
                        <p class="dashboard-empty-state">No devices have registered yet.</p>
                    </div>
                </div>
                <p class="dashboard-status" data-dashboard-status role="status" aria-live="polite"></p>
            </section>

            <section class="controller-card calibration-card">
                <div class="card-heading">
                    <div>
                        <span class="eyebrow">DISPLAY ALIGNMENT</span>
                        <h2>Calibration</h2>
                    </div>
                    <span id="calibration-status" class="status-badge">OFF</span>
                </div>
                <p class="card-description">Display a reference grid across all configured phones to check alignment.</p>
                <button id="calibration-toggle" class="publish-button" type="button">Enable Calibration</button>
                <ol class="setup-steps" aria-label="Calibration setup steps">
                    <li>Connect the phones</li>
                    <li>Enable calibration grid</li>
                    <li>Align each screen</li>
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
                <div class="alignment-grid" data-alignment-grid></div>
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
                <div class="diagnostics-grid" data-diagnostics-screens></div>
            </section>

            <dialog class="pairing-dialog" data-pairing-dialog aria-labelledby="pairing-title">
                <div class="pairing-dialog-heading">
                    <div>
                        <p class="eyebrow">DEVICE ONBOARDING</p>
                        <h2 id="pairing-title">Add a display device</h2>
                    </div>
                    <button class="pairing-close" type="button" data-pairing-close aria-label="Close dialog">×</button>
                </div>
                <p class="card-description">Connect your phone to the same Wi-Fi network, then scan this QR code.</p>
                <label class="pairing-interface" data-pairing-interface-wrap hidden>
                    Network interface
                    <select data-pairing-interface></select>
                </label>
                <div class="pairing-qr-wrap">
                    <img data-pairing-qr alt="QR code for connecting a display device" hidden>
                    <p data-pairing-placeholder>Requesting a secure pairing code...</p>
                </div>
                <label class="pairing-url-label">
                    Display URL
                    <input type="text" data-pairing-url readonly>
                </label>
                <div class="pairing-actions">
                    <button class="alignment-action" type="button" data-pairing-copy disabled>Copy URL</button>
                    <button class="alignment-action" type="button" data-pairing-refresh>Refresh QR</button>
                </div>
                <div class="pairing-status" role="status" aria-live="polite">
                    <p data-pairing-status>Preparing pairing session...</p>
                    <p>Code expires in <strong data-pairing-countdown>--:--</strong></p>
                    <p>Connected devices: <strong data-pairing-device-count>0</strong></p>
                </div>
                <ol class="pairing-instructions">
                    <li>Scan with the phone camera.</li>
                    <li>Open the display link and wait for device registration.</li>
                    <li>Assign a screen here if manual assignment is enabled.</li>
                </ol>
            </dialog>

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
    const screenCountSelect = root.querySelector('[data-screen-count]');
    const assignmentModeSelect = root.querySelector('[data-assignment-mode]');
    const screenConfigSaveButton = root.querySelector('[data-screen-config-save]');
    const alignmentGrid = root.querySelector('[data-alignment-grid]');
    const screenList = root.querySelector('[data-screen-list]');
    const deviceAssignmentList = root.querySelector('[data-device-assignment-list]');
    const assignmentStatus = root.querySelector('[data-assignment-status]');
    const dashboardWall = root.querySelector('[data-panorama-wall]');
    const dashboardPreview = root.querySelector('[data-panorama-preview]');
    const dashboardDevices = root.querySelector('[data-dashboard-devices]');
    const dashboardStatus = root.querySelector('[data-dashboard-status]');
    const diagnosticsScreens = root.querySelector('[data-diagnostics-screens]');
    const addDeviceButton = root.querySelector('[data-add-device]');
    const pairingDialog = root.querySelector('[data-pairing-dialog]');
    const pairingCloseButton = root.querySelector('[data-pairing-close]');
    const pairingInterfaceWrap = root.querySelector('[data-pairing-interface-wrap]');
    const pairingInterfaceSelect = root.querySelector('[data-pairing-interface]');
    const pairingQr = root.querySelector('[data-pairing-qr]');
    const pairingPlaceholder = root.querySelector('[data-pairing-placeholder]');
    const pairingUrlInput = root.querySelector('[data-pairing-url]');
    const pairingStatus = root.querySelector('[data-pairing-status]');
    const pairingCountdown = root.querySelector('[data-pairing-countdown]');
    const pairingDeviceCount = root.querySelector('[data-pairing-device-count]');
    const pairingCopyButton = root.querySelector('[data-pairing-copy]');
    const pairingRefreshButton = root.querySelector('[data-pairing-refresh]');
    const socket = createParallaxSocket();

    let selectedFile = null;
    let previewUrl = null;
    let uploadRequest = null;
    let calibrationEnabled = false;
    let totalScreens = 2;
    let assignmentMode = 'automatic';
    let registeredDevices = [];
    let panoramaImageUrl = null;
    let pairingSession = null;
    let pairingCountdownTimer = null;
    let knownDeviceIds = null;
    const alignmentByScreen = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
            index + 1,
            { horizontal: 0, vertical: 0, scale: 1 }
        ])
    );
    const alignmentRequestByScreen = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [index + 1, 0])
    );
    const pendingAlignmentTimers = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [index + 1, null])
    );
    let presets = [];
    let diagnostics = null;
    let lastServerCommunication = null;
    let alignmentReady = false;

    function renderDashboardScreens() {
        root.querySelector('[data-dashboard-screen-count]').textContent = String(totalScreens);
        const connectedCount = registeredDevices.filter((device) => device.connected).length;
        root.querySelector('[data-dashboard-device-count]').textContent = String(connectedCount);
        dashboardWall.style.setProperty('--screen-count', String(totalScreens));
        dashboardWall.innerHTML = Array.from({ length: totalScreens }, (_, index) => {
            const screen = index + 1;
            const device = registeredDevices.find((entry) => entry.screen === screen);
            const connected = Boolean(device?.connected);
            const status = !device ? 'Unassigned' : connected ? 'Online' : 'Offline';
            const settings = alignmentByScreen[screen];
            const displayStatus = diagnostics?.devices?.find((entry) => entry.screen === screen);
            const assignmentOptions = [
                `<option value="" ${device ? '' : 'selected'}>Unassigned</option>`,
                ...registeredDevices.map((entry) => `
                    <option value="${escapeHtml(entry.id)}" ${device?.id === entry.id ? 'selected' : ''}>
                        ${escapeHtml(entry.id)}${entry.connected ? '' : ' · offline'}
                    </option>
                `)
            ].join('');
            return `
                <article class="dashboard-screen-card ${connected ? 'is-online' : device ? 'is-offline' : 'is-unassigned'}"
                    data-dashboard-screen="${screen}">
                    <div class="dashboard-screen-heading">
                        <span class="dashboard-screen-number">SCREEN ${screen}</span>
                        <span class="dashboard-status-pill"><i></i>${status}</span>
                    </div>
                    <p class="dashboard-screen-device">${device ? escapeHtml(device.id) : 'No device assigned'}</p>
                    <p class="dashboard-device-name">${device ? 'Name not reported' : 'Waiting for a device'}</p>
                    <label class="dashboard-assignment-control">Assign device
                        <select data-screen-assignment="${screen}" ${!socket.connected ? 'disabled' : ''}>
                            ${assignmentOptions}
                        </select>
                    </label>
                    <div class="dashboard-alignment">
                        <span>H <strong data-dashboard-alignment="${screen}-horizontal">${settings.horizontal.toFixed(1)} px</strong></span>
                        <span>V <strong data-dashboard-alignment="${screen}-vertical">${settings.vertical.toFixed(1)} px</strong></span>
                        <span>Scale <strong data-dashboard-alignment="${screen}-scale">${settings.scale.toFixed(3)}×</strong></span>
                    </div>
                    <p class="dashboard-screen-meta">Grid state (server): ${calibrationEnabled ? 'Enabled' : 'Disabled'} ·
                        ${device && connected
                            ? `${displayStatus?.displayStatus ?? 'Waiting'} · ${formatTimestamp(displayStatus?.lastActivity)}`
                            : device ? 'Last activity unavailable' : 'No activity yet'}
                    </p>
                    <p class="dashboard-screen-meta">Alignment delivery: ${
                        displayStatus?.alignmentSynced === true
                            ? 'Received latest settings'
                            : displayStatus?.alignmentSynced === false
                                ? 'Waiting for device confirmation'
                                : 'Unknown'
                    }</p>
                    <p class="dashboard-screen-meta">Alignment updated: ${formatTimestamp(diagnostics?.alignmentUpdatedAt)}</p>
                    <div class="dashboard-screen-actions">
                        <button type="button" data-screen-identify="${screen}" ${!connected ? 'disabled' : ''}>
                            Identify
                        </button>
                        <button type="button" data-screen-alignment="${screen}">View alignment</button>
                        <button type="button" data-screen-reset="${screen}" ${!alignmentReady ? 'disabled' : ''}>
                            Reset alignment
                        </button>
                    </div>
                </article>
            `;
        }).join('');
    }

    function renderDashboardDevices() {
        dashboardDevices.innerHTML = registeredDevices.length
            ? registeredDevices.map((device) => {
                const report = diagnostics?.devices?.find((entry) => entry.deviceId === device.id);
                const status = device.connected ? 'Online' : 'Offline';
                return `
                    <article class="dashboard-device-card ${device.connected ? 'is-online' : 'is-offline'}"
                        data-device-card="${escapeHtml(device.id)}" draggable="true">
                        <div class="dashboard-device-card-heading">
                            <strong>${escapeHtml(device.id)}</strong>
                            <span class="dashboard-status-pill"><i></i>${status}</span>
                        </div>
                        <p>Name: Not reported</p>
                        <p>Assigned screen: ${Number.isInteger(device.screen) ? `Screen ${device.screen}` : 'Unassigned'}</p>
                        <p>Last activity: ${formatTimestamp(report?.lastActivity)}</p>
                        <p>Grid state (server): ${calibrationEnabled ? 'Enabled' : 'Disabled'}</p>
                        <p>Alignment delivery: ${
                            report?.alignmentSynced === true
                                ? 'Received latest settings'
                                : report?.alignmentSynced === false
                                    ? 'Waiting for device confirmation'
                                    : 'Unknown'
                        }</p>
                        <label class="dashboard-assignment-control">Screen assignment
                            <select data-dashboard-device-assignment="${escapeHtml(device.id)}"
                                ${!socket.connected ? 'disabled' : ''}>
                                <option value="" ${device.screen === null ? 'selected' : ''}>Unassigned</option>
                                ${Array.from({ length: totalScreens }, (_, index) => {
                                    const screen = index + 1;
                                    return `<option value="${screen}" ${device.screen === screen ? 'selected' : ''}>Screen ${screen}</option>`;
                                }).join('')}
                            </select>
                        </label>
                        <button type="button" class="dashboard-identify-button" data-device-identify="${escapeHtml(device.id)}"
                            ${!device.connected || !Number.isInteger(device.screen) ? 'disabled' : ''}>
                            Identify device
                        </button>
                    </article>
                `;
            }).join('')
            : '<p class="dashboard-empty-state">No devices have registered yet.</p>';
    }

    function renderPanoramaPreview() {
        const previewStatus = root.querySelector('[data-dashboard-content-status]');
        if (!panoramaImageUrl) {
            previewStatus.textContent = 'Waiting for content';
            dashboardPreview.innerHTML =
                '<p class="dashboard-empty-state">Publish an image to preview the complete panorama.</p>';
            return;
        }
        previewStatus.textContent = 'Latest published image';
        dashboardPreview.style.setProperty('--screen-count', String(totalScreens));
        dashboardPreview.replaceChildren();
        for (let index = 0; index < totalScreens; index += 1) {
            const screen = index + 1;
            const image = document.createElement('img');
            image.src = panoramaImageUrl;
            image.alt = '';
            image.draggable = false;
            image.style.width = `${totalScreens * 100}%`;
            image.style.left = `-${(screen - 1) * 100}%`;
            const segment = document.createElement('div');
            segment.className = 'panorama-preview-segment';
            segment.setAttribute('aria-label', `Screen ${screen} preview`);
            segment.append(image);
            const label = document.createElement('span');
            label.className = 'panorama-preview-label';
            label.textContent = `SCREEN ${screen}`;
            segment.append(label);
            dashboardPreview.append(segment);
        }
    }

    function renderDashboard() {
        renderDashboardScreens();
        renderDashboardDevices();
    }

    function renderScreenPanels() {
        const screens = Array.from({ length: totalScreens }, (_, index) => index + 1);
        screenList.innerHTML = screens.map((screen) => `
            <div class="screen-row" data-screen="${screen}">
                <span class="screen-icon" aria-hidden="true">▣</span>
                <span class="screen-label"><strong>Screen ${screen}</strong><small>Panorama position ${screen} of ${totalScreens}</small></span>
                <span class="screen-state"><i></i><span>Waiting</span></span>
            </div>
        `).join('');
        alignmentGrid.innerHTML = screens.map((screen) => `
            <section class="alignment-screen" data-alignment-screen="${screen}">
                <div class="alignment-screen-heading">
                    <h3>Screen ${screen}</h3>
                    <button class="alignment-reset" type="button" data-alignment-reset="${screen}" disabled>
                        Reset Screen ${screen}
                    </button>
                </div>
                ${[
                    ['horizontal', 'Horizontal', '-50', '50'],
                    ['vertical', 'Vertical', '-50', '50'],
                    ['scale', 'Scale', '0.95', '1.05']
                ].map(([axis, label, min, max]) => `
                    <label class="alignment-control">
                        <span>${label} <output data-alignment-value="${axis}">0</output></span>
                        <input type="range" min="${min}" max="${max}" step="1" value="0"
                            data-screen="${screen}" data-alignment-axis="${axis}" disabled>
                    </label>
                `).join('')}
            </section>
        `).join('');
        diagnosticsScreens.innerHTML = screens.map((screen) => `
            <article class="diagnostics-screen" data-diagnostics-screen="${screen}">
                <h3>Screen ${screen}</h3>
                <p>Connection: <strong data-diagnostic-connection>Unknown</strong></p>
                <p>Display: <strong data-diagnostic-display>Unknown</strong></p>
                <p>Alignment: <strong data-diagnostic-alignment>Unknown</strong></p>
                <p>Latest settings: <strong data-diagnostic-sync>Unknown</strong></p>
                <p>Last activity: <strong data-diagnostic-activity>Unknown</strong></p>
                <p>Image status: <strong data-diagnostic-image>Unknown</strong></p>
            </article>
        `).join('');
        screenCountSelect.value = String(totalScreens);
        assignmentModeSelect.value = assignmentMode;
        renderAlignmentUI();
        setDevices(registeredDevices);
        if (diagnostics) {
            setDiagnostics(diagnostics);
        }
    }

    function renderAlignmentScreen(screen) {
        const panel = root.querySelector(`[data-alignment-screen="${screen}"]`);
        if (!panel) {
            return;
        }

        const settings = alignmentByScreen[screen] ?? { horizontal: 0, vertical: 0, scale: 1 };
        for (const axis of ['horizontal', 'vertical', 'scale']) {
            const input = panel.querySelector(`[data-alignment-axis="${axis}"]`);
            const output = panel.querySelector(`[data-alignment-value="${axis}"]`);
            if (!input || !output) {
                continue;
            }
            input.value = String(settings[axis]);
            input.step = getAlignmentStep(axis, fineAdjustmentInput.checked);
            output.textContent = formatAlignmentValue(axis, settings[axis], fineAdjustmentInput.checked);
            input.disabled = !alignmentReady;
        }
        const dashboardValues = {
            horizontal: `${settings.horizontal.toFixed(1)} px`,
            vertical: `${settings.vertical.toFixed(1)} px`,
            scale: `${settings.scale.toFixed(3)}×`
        };
        for (const [axis, value] of Object.entries(dashboardValues)) {
            const output = root.querySelector(`[data-dashboard-alignment="${screen}-${axis}"]`);
            if (output) {
                output.textContent = value;
            }
        }
        panel.querySelector('[data-alignment-reset]').disabled = !alignmentReady;
        const diagnosticsPanel = root.querySelector(`[data-diagnostics-screen="${screen}"]`);
        const diagnosticAlignment = diagnosticsPanel?.querySelector('[data-diagnostic-alignment]');
        if (diagnosticAlignment) {
            diagnosticAlignment.textContent =
                `${settings.horizontal.toFixed(1)} px · ${settings.vertical.toFixed(1)} px · ${settings.scale.toFixed(3)}×`;
        }
    }

    function renderAlignmentUI() {
        for (let screen = 1; screen <= totalScreens; screen += 1) {
            renderAlignmentScreen(screen);
        }
    }

    renderScreenPanels();

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
            renderDashboardScreens();
        });
    }

    function queueAlignment(screen) {
        clearTimeout(pendingAlignmentTimers[screen]);
        pendingAlignmentTimers[screen] = setTimeout(() => sendAlignment(screen), 80);
    }

    function flushAlignment() {
        for (let screen = 1; screen <= totalScreens; screen += 1) {
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

    function setPairingStatus(message, isError = false) {
        pairingStatus.textContent = message;
        pairingStatus.classList.toggle('is-error', isError);
    }

    function updatePairingCountdown() {
        if (!pairingSession) {
            pairingCountdown.textContent = '--:--';
            return;
        }
        const remaining = Math.max(0, pairingSession.expiresAt - Date.now());
        const minutes = Math.floor(remaining / 60_000);
        const seconds = Math.floor((remaining % 60_000) / 1000);
        pairingCountdown.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        if (remaining === 0) {
            pairingQr.hidden = true;
            pairingCopyButton.disabled = true;
            setPairingStatus('Pairing code expired. Refresh the QR code to try again.', true);
            clearInterval(pairingCountdownTimer);
            pairingCountdownTimer = null;
        }
    }

    function renderPairingQr() {
        if (!pairingSession?.token) {
            return;
        }
        const selectedAddress = pairingInterfaceSelect.value;
        if (!selectedAddress) {
            setPairingStatus('No usable LAN address is available. Connect to Wi-Fi and refresh.', true);
            return;
        }

        const url = new URL('/', window.location.origin);
        url.hostname = selectedAddress;
        url.searchParams.set('pair', pairingSession.token);
        pairingUrlInput.value = url.toString();
        pairingPlaceholder.textContent = 'Generating QR code...';
        pairingQr.hidden = true;
        QRCode.toDataURL(url.toString(), {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 280
        }).then((dataUrl) => {
            if (pairingSession?.token !== url.searchParams.get('pair')) {
                return;
            }
            pairingQr.src = dataUrl;
            pairingQr.hidden = false;
            pairingPlaceholder.hidden = true;
            pairingCopyButton.disabled = false;
            setPairingStatus(`Ready to scan. Use ${selectedAddress} on the phone's Wi-Fi network.`);
        }).catch((error) => {
            console.error('Unable to generate pairing QR code:', error);
            pairingPlaceholder.hidden = false;
            pairingPlaceholder.textContent = 'Could not generate the QR code. Copy the URL or refresh to retry.';
            setPairingStatus('QR generation failed. Please try again.', true);
        });
    }

    function createPairingSession() {
        pairingRefreshButton.disabled = true;
        pairingCopyButton.disabled = true;
        pairingQr.hidden = true;
        pairingPlaceholder.hidden = false;
        pairingPlaceholder.textContent = 'Requesting a secure pairing code...';
        pairingUrlInput.value = '';
        setPairingStatus('Preparing pairing session...');
        if (!socket.connected) {
            pairingRefreshButton.disabled = false;
            setPairingStatus('Backend is disconnected. Reconnect and try again.', true);
            return;
        }
        socket.timeout(5000).emit('pairing:create', (error, result) => {
            pairingRefreshButton.disabled = false;
            if (error || !result?.ok) {
                pairingPlaceholder.textContent = 'A pairing QR code is not available.';
                setPairingStatus(error
                    ? 'Could not reach the backend. Check the network and try again.'
                    : result?.message || 'Unable to create pairing code.', true);
                return;
            }
            pairingSession = result;
            pairingDeviceCount.textContent = String(result.connectedDevices ?? 0);
            pairingInterfaceSelect.replaceChildren();
            for (const networkInterface of result.interfaces) {
                const option = document.createElement('option');
                option.value = networkInterface.address;
                option.textContent = `${networkInterface.name} · ${networkInterface.address}`;
                pairingInterfaceSelect.append(option);
            }
            pairingInterfaceWrap.hidden = result.interfaces.length < 2;
            renderPairingQr();
            clearInterval(pairingCountdownTimer);
            pairingCountdownTimer = setInterval(updatePairingCountdown, 1000);
            updatePairingCountdown();
        });
    }

    addDeviceButton.addEventListener('click', () => {
        if (!pairingDialog.open) {
            pairingDialog.showModal();
        }
        createPairingSession();
    });
    pairingRefreshButton.addEventListener('click', createPairingSession);
    pairingInterfaceSelect.addEventListener('change', renderPairingQr);
    pairingCopyButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(pairingUrlInput.value);
            setPairingStatus('Display URL copied to clipboard.');
        } catch (error) {
            console.error('Unable to copy the display URL:', error);
            setPairingStatus('Could not access the clipboard. Select and copy the URL manually.', true);
        }
    });
    pairingCloseButton.addEventListener('click', () => pairingDialog.close());
    pairingDialog.addEventListener('click', (event) => {
        if (event.target === pairingDialog) {
            pairingDialog.close();
        }
    });

    calibrationButton?.addEventListener('click', () => {
        calibrationButton.disabled = true;
        emitControllerCommand('calibration:set', { enabled: !calibrationEnabled }, (response) => {
            calibrationButton.disabled = false;
            calibrationEnabled = response.enabled;
            updateCalibrationUI();
            renderDashboardScreens();
            alignmentStatus.textContent = `Calibration grid ${calibrationEnabled ? 'enabled' : 'disabled'}.`;
        }, () => {
            calibrationButton.disabled = false;
        });
    });

    fineAdjustmentInput.addEventListener('change', renderAlignmentUI);

    alignmentGrid.addEventListener('input', (event) => {
        const input = event.target.closest('[data-alignment-axis]');
        if (!input) {
            return;
        }
        const screen = Number(input.dataset.screen);
        const axis = input.dataset.alignmentAxis;
        alignmentByScreen[screen][axis] = Number(input.value);
        renderAlignmentScreen(screen);
        queueAlignment(screen);
    });
    alignmentGrid.addEventListener('change', (event) => {
        const input = event.target.closest('[data-alignment-axis]');
        if (input) {
            sendAlignment(Number(input.dataset.screen));
        }
    });
    alignmentGrid.addEventListener('click', (event) => {
        const button = event.target.closest('[data-alignment-reset]');
        if (!button) {
            return;
        }
        const screen = Number(button.dataset.alignmentReset);
        alignmentByScreen[screen] = { horizontal: 0, vertical: 0, scale: 1 };
        renderAlignmentScreen(screen);
        sendAlignment(screen);
    });

    function applyScreenConfiguration(configuration) {
        if (!Number.isInteger(configuration?.totalScreens)
            || configuration.totalScreens < 2 || configuration.totalScreens > 12
            || !['automatic', 'manual'].includes(configuration.assignmentMode)) {
            return;
        }
        totalScreens = configuration.totalScreens;
        assignmentMode = configuration.assignmentMode;
        if (configuration.screens && typeof configuration.screens === 'object') {
            for (const screen of Object.keys(alignmentByScreen)) {
                const settings = configuration.screens[screen];
                if (settings
                    && Number.isFinite(settings.horizontal)
                    && Number.isFinite(settings.vertical)
                    && Number.isFinite(settings.scale)) {
                    alignmentByScreen[screen] = { ...settings };
                }
            }
        }
        renderScreenPanels();
        renderPanoramaPreview();
        screenConfigSaveButton.disabled = !socket.connected;
        assignmentModeSelect.disabled = !socket.connected;
        screenCountSelect.disabled = !socket.connected;
    }

    screenConfigSaveButton.addEventListener('click', () => {
        flushAlignment();
        const requested = {
            totalScreens: Number(screenCountSelect.value),
            assignmentMode: assignmentModeSelect.value
        };
        screenConfigSaveButton.disabled = true;
        socket.timeout(5000).emit('screen-config:set', requested, (error, response) => {
            screenConfigSaveButton.disabled = !socket.connected;
            if (error || !response?.ok) {
                assignmentStatus.textContent = error
                    ? 'The server did not acknowledge the screen configuration.'
                    : response?.message || 'Unable to update screen configuration.';
                assignmentStatus.classList.add('is-error');
                screenCountSelect.value = String(totalScreens);
                assignmentModeSelect.value = assignmentMode;
                return;
            }
            assignmentStatus.classList.remove('is-error');
            assignmentStatus.textContent =
                `Configuration saved: ${response.totalScreens} screens, ${response.assignmentMode} assignment.`;
            applyScreenConfiguration(response);
        });
    });

    deviceAssignmentList.addEventListener('change', (event) => {
        const select = event.target.closest('[data-device-assignment]');
        if (!select) {
            return;
        }
        const screen = select.value === '' ? null : Number(select.value);
        requestDeviceAssignment(select.dataset.deviceAssignment, screen);
    });

    dashboardWall.addEventListener('change', (event) => {
        const select = event.target.closest('[data-screen-assignment]');
        if (!select) {
            return;
        }
        const screen = Number(select.dataset.screenAssignment);
        const selectedDeviceId = select.value;
        const currentDevice = registeredDevices.find((device) => device.screen === screen);
        if (!selectedDeviceId) {
            if (currentDevice) {
                requestDeviceAssignment(currentDevice.id, null);
            } else {
                renderDashboard();
            }
            return;
        }
        requestDeviceAssignment(selectedDeviceId, screen);
    });

    dashboardWall.addEventListener('click', (event) => {
        const identifyButton = event.target.closest('[data-screen-identify]');
        if (identifyButton) {
            const screen = Number(identifyButton.dataset.screenIdentify);
            const device = registeredDevices.find((entry) => entry.screen === screen && entry.connected);
            if (device) {
                identifyDevice(device.id);
            }
            return;
        }
        const alignmentButton = event.target.closest('[data-screen-alignment]');
        if (alignmentButton) {
            const panel = root.querySelector(`[data-alignment-screen="${alignmentButton.dataset.screenAlignment}"]`);
            panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            panel?.querySelector('input')?.focus({ preventScroll: true });
            return;
        }
        const resetButton = event.target.closest('[data-screen-reset]');
        if (resetButton && alignmentReady) {
            const screen = Number(resetButton.dataset.screenReset);
            alignmentByScreen[screen] = { horizontal: 0, vertical: 0, scale: 1 };
            renderAlignmentScreen(screen);
            renderDashboardScreens();
            sendAlignment(screen);
        }
    });

    dashboardDevices.addEventListener('change', (event) => {
        const select = event.target.closest('[data-dashboard-device-assignment]');
        if (!select) {
            return;
        }
        requestDeviceAssignment(
            select.dataset.dashboardDeviceAssignment,
            select.value === '' ? null : Number(select.value)
        );
    });
    dashboardDevices.addEventListener('click', (event) => {
        const button = event.target.closest('[data-device-identify]');
        if (button) {
            identifyDevice(button.dataset.deviceIdentify);
        }
    });
    dashboardDevices.addEventListener('dragstart', (event) => {
        const card = event.target.closest('[data-device-card]');
        if (!card || !event.dataTransfer) {
            return;
        }
        event.dataTransfer.setData('text/plain', card.dataset.deviceCard);
        event.dataTransfer.effectAllowed = 'move';
        card.classList.add('is-dragging');
    });
    dashboardDevices.addEventListener('dragend', (event) => {
        event.target.closest('[data-device-card]')?.classList.remove('is-dragging');
        dashboardWall.querySelectorAll('.is-drop-target').forEach((card) =>
            card.classList.remove('is-drop-target'));
    });
    dashboardWall.addEventListener('dragover', (event) => {
        const card = event.target.closest('[data-dashboard-screen]');
        if (card && socket.connected) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            card.classList.add('is-drop-target');
        }
    });
    dashboardWall.addEventListener('dragleave', (event) => {
        const card = event.target.closest('[data-dashboard-screen]');
        if (card && !card.contains(event.relatedTarget)) {
            card.classList.remove('is-drop-target');
        }
    });
    dashboardWall.addEventListener('drop', (event) => {
        const card = event.target.closest('[data-dashboard-screen]');
        const deviceId = event.dataTransfer?.getData('text/plain');
        if (!card || !deviceId) {
            return;
        }
        event.preventDefault();
        card.classList.remove('is-drop-target');
        requestDeviceAssignment(deviceId, Number(card.dataset.dashboardScreen));
    });

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
            for (let screen = 1; screen <= totalScreens; screen += 1) {
                alignmentByScreen[screen] = { ...response.screens[screen] };
            }
            renderAlignmentUI();
            renderDashboardScreens();
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
            for (let screen = 1; screen <= totalScreens; screen += 1) {
                alignmentByScreen[screen] = { ...response.screens[screen] };
            }
            renderAlignmentUI();
            renderDashboardScreens();
            alignmentStatus.textContent = `All ${totalScreens} screens reset to neutral alignment.`;
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
        panoramaImageUrl = imageUrl;
        currentImage.replaceChildren();
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = `Currently published panorama: ${filename}`;
        currentImage.append(image);
        root.querySelector('[data-current-name]').textContent = filename;
        root.querySelector('[data-current-meta]').textContent = width && height
            ? `${width} × ${height} · Published to displays`
            : 'Currently displayed';
        renderPanoramaPreview();
    }

    function setDevices(devices) {
        markServerCommunication();
        registeredDevices = Array.isArray(devices) ? devices : [];
        const connectedDevices = registeredDevices.filter((device) => device.connected);
        const connectedIds = new Set(connectedDevices.map((device) => device.id));
        if (knownDeviceIds !== null) {
            const newlyConnected = connectedDevices.find((device) => !knownDeviceIds.has(device.id));
            if (newlyConnected) {
                assignmentStatus.textContent = `New phone connected: ${newlyConnected.id}. Assign it a screen below.`;
                assignmentStatus.classList.remove('is-error');
                if (pairingDialog.open) {
                    setPairingStatus(`Phone connected: ${newlyConnected.id}. Assign its screen below.`);
                }
            }
        }
        knownDeviceIds = connectedIds;
        const devicesByScreen = new Map(registeredDevices
            .filter((device) => Number.isInteger(device.screen))
            .map((device) => [device.screen, device]));
        const count = connectedDevices.length;
        pairingDeviceCount.textContent = String(count);
        root.querySelector('[data-device-count]').innerHTML = `${count} <small>of ${totalScreens}</small>`;
        root.querySelector('[data-network-note]').textContent = count === totalScreens
            ? `All ${totalScreens} displays are connected and ready.`
            : count > 0
                ? `${count} of ${totalScreens} displays are connected.`
                : 'Waiting for phones to connect.';

        for (let screen = 1; screen <= totalScreens; screen += 1) {
            const row = root.querySelector(`[data-screen="${screen}"]`);
            if (!row) {
                continue;
            }
            const device = devicesByScreen.get(screen);
            const connected = Boolean(device?.connected);
            const state = connected ? 'Connected' : device ? 'Disconnected' : 'Waiting';
            row.classList.toggle('is-connected', connected);
            row.querySelector('.screen-state span').textContent = state;
            row.classList.toggle('is-disconnected', Boolean(device) && !connected);
        }

        deviceAssignmentList.innerHTML = registeredDevices.length
            ? registeredDevices.map((device) => `
                <label class="device-assignment-row">
                    <span><strong>${escapeHtml(device.id)}</strong><small>${device.connected ? 'Connected' : 'Disconnected'}</small></span>
                    <select data-device-assignment="${escapeHtml(device.id)}" ${!socket.connected ? 'disabled' : ''}>
                        <option value="" ${device.screen === null ? 'selected' : ''}>Unassigned</option>
                        ${Array.from({ length: totalScreens }, (_, index) => {
                            const screen = index + 1;
                            return `<option value="${screen}" ${device.screen === screen ? 'selected' : ''}>Screen ${screen}</option>`;
                        }).join('')}
                    </select>
                </label>
            `).join('')
            : '<p class="network-note">No registered devices.</p>';
        renderDashboard();
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
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
        const currentContent = snapshot.currentContent;
        if (currentContent?.contentType === 'image'
            && typeof currentContent.imageUrl === 'string'
            && currentContent.imageUrl !== panoramaImageUrl) {
            setCurrentContent(currentContent.imageUrl, 'Current panorama', 0, 0);
        }
        root.querySelector('[data-diagnostics-backend]').textContent =
            snapshot.backendConnected === true ? 'Connected' : 'Unknown';
        root.querySelector('[data-diagnostics-count]').textContent =
            Number.isInteger(snapshot.activeDeviceCount)
                ? `${snapshot.activeDeviceCount} of ${totalScreens}` : 'Unknown';
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
            connectedDevices.length === totalScreens
                && connectedDevices.every((device) => device.alignmentSynced === true)
                ? 'All connected phones received the latest settings'
                : connectedDevices.some((device) => device.alignmentSynced === false)
                    ? 'Waiting for phone confirmation'
                    : 'Unknown';
        root.querySelector('[data-diagnostics-updated]').textContent =
            `Updated ${formatTimestamp(lastServerCommunication)}`;

        for (let screen = 1; screen <= totalScreens; screen += 1) {
            const device = Array.isArray(snapshot.devices)
                ? snapshot.devices.find((entry) => entry.screen === screen)
                : null;
            const panel = root.querySelector(`[data-diagnostics-screen="${screen}"]`);
            if (!panel) {
                continue;
            }
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
        renderDashboardScreens();
        renderDashboardDevices();
    }

    function setDashboardStatus(message, isError = false) {
        dashboardStatus.textContent = message;
        dashboardStatus.classList.toggle('is-error', isError);
    }

    function requestDeviceAssignment(deviceId, screen) {
        const device = registeredDevices.find((entry) => entry.id === deviceId);
        if (!device) {
            setDashboardStatus('This device is no longer registered. Refresh the dashboard and try again.', true);
            return;
        }
        if (screen === device.screen) {
            renderDashboard();
            return;
        }
        const occupant = Number.isInteger(screen)
            ? registeredDevices.find((entry) => entry.screen === screen && entry.id !== deviceId)
            : null;
        let swapDeviceId;
        if (occupant) {
            if (!Number.isInteger(device.screen)) {
                setDashboardStatus(
                    `${occupant.id} already owns Screen ${screen}. Assign the unassigned device to an empty screen first.`,
                    true
                );
                renderDashboard();
                return;
            }
            if (!window.confirm(
                `Screen ${screen} is assigned to ${occupant.id}. Swap ${device.id} and ${occupant.id} between screens?`
            )) {
                renderDashboard();
                return;
            }
            swapDeviceId = occupant.id;
        }

        const request = { deviceId, screen };
        if (swapDeviceId) {
            request.swapDeviceId = swapDeviceId;
        }
        setDashboardStatus(`Updating ${deviceId} assignment...`);
        socket.timeout(5000).emit('device:assign-screen', request, (error, response) => {
            if (error || !response?.ok) {
                const message = error
                    ? 'The server did not acknowledge the device assignment.'
                    : response?.message || 'Unable to assign the device.';
                setDashboardStatus(message, true);
                assignmentStatus.textContent = message;
                assignmentStatus.classList.add('is-error');
                renderDashboard();
                return;
            }
            const message = response.swappedDeviceId
                ? `Swapped ${response.deviceId} and ${response.swappedDeviceId}.`
                : screen === null
                    ? `Device ${response.deviceId} is now unassigned.`
                    : `Device ${response.deviceId} assigned to Screen ${screen}.`;
            setDashboardStatus(message);
            assignmentStatus.textContent = message;
            assignmentStatus.classList.remove('is-error');
        });
    }

    function identifyDevice(deviceId) {
        socket.timeout(5000).emit('device:identify', { deviceId }, (error, response) => {
            if (error || !response?.ok) {
                setDashboardStatus(error
                    ? 'The server did not acknowledge the identify request.'
                    : response?.message || 'Unable to identify this device.', true);
                return;
            }
            setDashboardStatus(`Identify signal sent to ${response.deviceId} on Screen ${response.screen}.`);
        });
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
        screenConfigSaveButton.disabled = false;
        assignmentModeSelect.disabled = false;
        screenCountSelect.disabled = false;
        addDeviceButton.disabled = false;
        setDevices(registeredDevices);
        socket.emit('controller:register');
    });
    socket.on('disconnect', () => {
        alignmentReady = false;
        for (let screen = 1; screen <= 12; screen += 1) {
            clearTimeout(pendingAlignmentTimers[screen]);
            pendingAlignmentTimers[screen] = null;
        }
        renderAlignmentUI();
        updatePresetControls();
        calibrationButton.disabled = true;
        screenConfigSaveButton.disabled = true;
        assignmentModeSelect.disabled = true;
        screenCountSelect.disabled = true;
        addDeviceButton.disabled = true;
        if (pairingDialog.open) {
            setPairingStatus('Backend disconnected. The pairing session may have expired.', true);
        }
        setDevices(registeredDevices);
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
    socket.on('pairing:expired', (event) => {
        if (pairingSession?.expiresAt === event?.expiresAt) {
            pairingQr.hidden = true;
            pairingCopyButton.disabled = true;
            setPairingStatus('Pairing code expired. Refresh the QR code to try again.', true);
        }
    });
    socket.on('pairing:device-joined', () => {
        setPairingStatus('A phone scanned the code. Waiting for its device registration...');
    });
    socket.on('screen-config:current', applyScreenConfiguration);
    socket.on('screen-config:update', applyScreenConfiguration);
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
        renderDashboardScreens();
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

        for (const [screenKey, settings] of Object.entries(screens)) {
            const screen = Number(screenKey);
            if (!settings
                || !Number.isInteger(screen)
                || screen < 1 || screen > 12
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
        renderDashboardScreens();
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
        for (let screen = 1; screen <= 12; screen += 1) {
            clearTimeout(pendingAlignmentTimers[screen]);
        }
        uploadRequest?.abort();
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
        clearInterval(pairingCountdownTimer);
    }, { once: true });
}
