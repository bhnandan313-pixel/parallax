import { createParallaxSocket, getParallaxServerBaseUrl } from '../core/socket.js';
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

    <p class="card-description">
        Display a reference grid across both phones to check alignment.
    </p>

    <button
        id="calibration-toggle"
        class="publish-button"
        type="button"
    >
        Enable Calibration
    </button>
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
    const socket = createParallaxSocket();

    let selectedFile = null;
    let previewUrl = null;
    let uploadRequest = null;
    let calibrationEnabled = false;

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

        socket.emit(
            'calibration:set',
            { enabled: !calibrationEnabled },
            (response) => {
                calibrationButton.disabled = false;

                if (!response?.ok) {
                    console.error(
                        'Calibration update failed:',
                        response?.message
                    );
                    return;
                }

                calibrationEnabled = response.enabled;
                updateCalibrationUI();
            }
        );
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
        const activeScreens = new Set(
            (Array.isArray(devices) ? devices : [])
                .filter((device) => device.socketId)
                .map((device) => device.screen)
        );
        const count = activeScreens.size;
        root.querySelector('[data-device-count]').innerHTML = `${count} <small>of 2</small>`;
        root.querySelector('[data-network-note]').textContent = count === 2
            ? 'Both displays are connected and ready.'
            : count === 1
                ? 'One display is connected. Waiting for the other screen.'
                : 'Waiting for phones to connect.';

        for (const screen of [1, 2]) {
            const row = root.querySelector(`[data-screen="${screen}"]`);
            const connected = activeScreens.has(screen);
            row.classList.toggle('is-connected', connected);
            row.querySelector('.screen-state span').textContent = connected ? 'Connected' : 'Waiting';
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
        socket.emit('controller:register');
    });
    socket.on('disconnect', () => {
        root.querySelector('[data-controller-connection]').classList.remove('is-online');
        root.querySelector('[data-controller-connection-label]').textContent = 'Reconnecting to display system';
    });
    socket.on('connect_error', (error) => {
        root.querySelector('[data-controller-connection-label]').textContent =
            `Connection error: ${error.message}`;
    });
    socket.on('devices:update', setDevices);
    socket.on('calibration:current', (state) => {
        if (typeof state?.enabled !== 'boolean') {
            return;
        }

        calibrationEnabled = state.enabled;
        updateCalibrationUI();
    });
    socket.on('content:current', (content) => {
        if (content?.contentType === 'image' && content.imageUrl) {
            setCurrentContent(content.imageUrl, 'Current panorama', 0, 0);
            root.querySelector('[data-current-meta]').textContent = 'Currently displayed';
        }
    });

    window.addEventListener('beforeunload', () => {
        socket.disconnect();
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
    }, { once: true });
}
