import { createParallaxSocket, getParallaxServerBaseUrl } from '../core/socket.js';
import { formatAlignmentValue, getAlignmentStep } from './alignment-controls.js';
import { confirmLayoutReset } from './layout-reset.js';
import { createDefaultLayout, validateDisplayLayout } from '../display/geometry.js';
import { expectedPlaybackPosition } from '../media/playback.js';
import { synchronizePreviewVideo } from '../media/preview-sync.js';
import { createAudioSettings, DEFAULT_AUDIO_SETTINGS } from '../media/audio.js';
import { resolveParallaxMediaUrl } from '../core/media-url.js';
import { isFullscreen, toggleFullscreen } from '../media/fullscreen.js';
import QRCode from 'qrcode';
import './controller.css';

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|mp4)$/i;
const MAX_VIDEO_FILE_SIZE = 100 * 1024 * 1024;

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
                <a class="settings-link" href="#settings" data-settings-link>Settings</a>
            </header>

            <section class="controller-intro">
                <p class="eyebrow">LIVE DISPLAY SYSTEM</p>
                <h1>Control your panorama</h1>
                <p>Manage and publish synchronized panoramic media across your connected screens.</p>
            </section>

            <section class="controller-grid">
                <div class="controller-card upload-card">
                    <div class="card-heading">
                        <div>
                            <p class="eyebrow">CONTENT</p>
                            <h2>Upload media</h2>
                        </div>
                        <span class="step-badge">01</span>
                    </div>

                    <label class="drop-zone" data-drop-zone>
                        <input data-file-input type="file"
                            accept=".jpg,.jpeg,.png,.webp,.mp4,image/jpeg,image/png,image/webp,video/mp4" hidden>
                        <span class="upload-icon" aria-hidden="true">↑</span>
                        <strong data-drop-label>Drop an image or MP4 video here</strong>
                        <span class="drop-hint">JPG, PNG, WebP · 15 MB max | MP4 · 100 MB max</span>
                        <span class="browse-button">Browse files</span>
                    </label>

                    <div class="image-preview" data-image-preview>
                        <div class="preview-placeholder">
                            <span class="preview-placeholder-icon" aria-hidden="true">▧</span>
                            <span>Your selected media preview will appear here</span>
                        </div>
                    </div>

                    <div class="file-details" data-file-details hidden>
                        <span class="file-name" data-file-name></span>
                        <span class="file-dimensions" data-file-dimensions></span>
                    </div>

                    <div class="upload-progress" data-upload-progress hidden>
                        <div class="progress-label">
                            <span data-progress-label>Uploading media</span>
                            <span data-progress-value>0%</span>
                        </div>
                        <div class="progress-track"><span data-progress-bar></span></div>
                    </div>

                    <button class="publish-button" data-publish-button type="button" disabled>
                        <span>Upload and publish</span><span aria-hidden="true">→</span>
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
                        <button class="alignment-action" type="button" data-vision-connect disabled>
                            Connect Vision Camera
                        </button>
                        <p class="network-note" data-vision-status>Vision camera not connected.</p>
                        <div class="vision-spatial-panel">
                            <div class="vision-spatial-heading">
                                <h3>Spatial preview</h3>
                                <span>Live tracking</span>
                            </div>
                            <div class="vision-spatial-preview" data-vision-spatial-preview>
                                <p class="dashboard-empty-state">No tracked markers.</p>
                            </div>
                            <details class="management-disclosure">
                                <summary>Observation details</summary>
                                <div class="vision-observation-list" data-vision-observations></div>
                            </details>
                        </div>
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
                        <details class="management-disclosure">
                            <summary>Device management</summary>
                            <div class="screen-list" data-screen-list></div>
                            <h3 class="device-list-heading">Registered devices</h3>
                            <div class="device-assignment-list" data-device-assignment-list></div>
                            <p class="alignment-status" data-assignment-status role="status" aria-live="polite"></p>
                        </details>
                        <p class="network-note" data-network-note>Waiting for phones to connect.</p>
                    </section>

                    <details class="management-disclosure current-preview-disclosure">
                        <summary>Current screen preview</summary>
                        <section class="controller-card current-card">
                            <div class="card-heading">
                                <div>
                                    <p class="eyebrow">NOW SHOWING</p>
                                    <h2>Current display</h2>
                                </div>
                                <span class="live-badge"><i></i> LIVE</span>
                            </div>
                            <div class="current-image" data-current-image>
                                <div class="current-placeholder">No media published yet</div>
                            </div>
                            <button class="alignment-action" type="button" data-controller-fullscreen>
                                Fullscreen preview
                            </button>
                            <p class="current-content-name" data-current-name>Waiting for content</p>
                            <p class="current-content-meta" data-current-meta>Connect a display to get started</p>
                        </section>
                    </details>
                </aside>
            </section>

            <section class="controller-card media-management" aria-labelledby="media-management-title">
                <div class="card-heading">
                    <div>
                        <p class="eyebrow">CONTENT LIBRARY</p>
                        <h2 id="media-management-title">Media management</h2>
                    </div>
                    <span class="status-badge" data-playback-status>Stopped</span>
                </div>
                <div class="media-library-toolbar">
                    <label>Search library
                        <input type="search" data-media-search placeholder="Filename">
                    </label>
                    <label>Media type
                        <select data-media-filter>
                            <option value="all">All media</option>
                            <option value="image">Images</option>
                            <option value="video">Videos</option>
                        </select>
                    </label>
                    <label>Transition
                        <select data-media-transition>
                            <option value="none">No transition</option>
                            <option value="fade">Fade</option>
                            <option value="slide-left">Slide left</option>
                            <option value="slide-right">Slide right</option>
                        </select>
                    </label>
                </div>
                <div class="media-library" data-content-library>
                    <p class="dashboard-empty-state">Uploaded media will appear here.</p>
                </div>
                <div class="media-playlists">
                    <details class="management-disclosure">
                        <summary>Playlists and upload history</summary>
                        <h3>Upload history</h3>
                        <div data-upload-history><p class="dashboard-empty-state">No uploads yet.</p></div>
                        <h3>Image and video playlists</h3>
                        <div class="playlist-editor">
                        <label>Playlist name
                            <input type="text" maxlength="64" data-playlist-name placeholder="Playlist name">
                        </label>
                        <label>Playlist type
                            <select data-playlist-type>
                                <option value="image">Images</option>
                                <option value="video">Videos</option>
                            </select>
                        </label>
                        <label>Image duration (seconds)
                            <input type="number" min="1" max="86400" value="8" data-playlist-duration>
                        </label>
                        <label class="playlist-option"><input type="checkbox" data-playlist-loop checked> Loop playlist</label>
                        <label class="playlist-option"><input type="checkbox" data-playlist-shuffle> Shuffle</label>
                        <label>Saved playlists
                            <select data-playlist-select></select>
                        </label>
                        <button class="alignment-action" type="button" data-playlist-new>New playlist</button>
                        <button class="alignment-action" type="button" data-playlist-save>Create playlist</button>
                        <button class="alignment-action" type="button" data-playlist-load>Load playlist</button>
                        <button class="alignment-action is-danger" type="button" data-playlist-delete>Delete playlist</button>
                        <button class="alignment-action" type="button" data-playlist-preview>Preview playlist</button>
                        </div>
                        <div class="playlist-draft" data-playlist-draft>
                            <p class="dashboard-empty-state">Add media from the library to build a playlist.</p>
                        </div>
                    </details>
                </div>
                <div class="playback-controls">
                    <h3>Playback</h3>
                    <div class="playback-buttons">
                        <button class="alignment-action" type="button" data-playback-previous>Previous</button>
                        <button class="alignment-action" type="button" data-playback-play>Play</button>
                        <button class="alignment-action" type="button" data-playback-pause>Pause</button>
                        <button class="alignment-action" type="button" data-playback-stop>Stop</button>
                        <button class="alignment-action" type="button" data-playback-next>Next</button>
                        <details class="management-disclosure playback-more">
                            <summary>More</summary>
                            <button class="alignment-action" type="button" data-playback-resume>Resume</button>
                        </details>
                    </div>
                    <label class="playback-seek">Position
                        <input type="range" min="0" max="0" step="0.1" value="0" data-playback-seek disabled>
                        <span data-playback-position>0:00</span>
                    </label>
                    <label class="playback-volume">Volume
                        <input type="range" min="0" max="100" step="1" value="0"
                            data-playback-volume aria-label="Master playback volume" disabled>
                        <output data-playback-volume-value>0%</output>
                    </label>
                    <button class="alignment-action" type="button" data-playback-mute disabled>
                        Unmute
                    </button>
                    <details class="management-disclosure">
                        <summary>Audio configuration</summary>
                        <div class="audio-mode-controls">
                        <label>Audio mode
                            <select data-audio-mode>
                                <option value="master">Master audio (one phone)</option>
                                <option value="all">All devices (independent phone volume)</option>
                            </select>
                        </label>
                        <label>Master phone
                            <select data-audio-master></select>
                        </label>
                        <p data-audio-mode-status role="status">
                            Master Audio Mode is active. Select a phone to enable its output.
                        </p>
                        </div>
                    </details>
                </div>
                <details class="management-disclosure schedule-disclosure">
                    <summary>Playback scheduling</summary>
                    <div class="schedule-controls">
                    <h3>Scheduled playback</h3>
                    <label>Media or playlist
                        <select data-schedule-target></select>
                    </label>
                    <label>Start
                        <input type="datetime-local" data-schedule-start>
                    </label>
                    <label>End
                        <input type="datetime-local" data-schedule-end>
                    </label>
                    <label>Time zone
                        <input type="text" data-schedule-timezone readonly>
                    </label>
                    <button class="alignment-action" type="button" data-schedule-create>Create schedule</button>
                    <div class="schedule-list" data-schedule-list></div>
                    </div>
                </details>
                <p class="alignment-status" data-media-status role="status" aria-live="polite"></p>
            </section>

            <section class="controller-card panorama-dashboard" aria-labelledby="dashboard-title">
                <div class="card-heading">
                    <div>
                        <p class="eyebrow">LIVE DISPLAY WALL</p>
                        <h2 id="dashboard-title">Visual panorama dashboard</h2>
                    </div>
                    <div class="dashboard-metrics">
                        <span><strong data-dashboard-screen-count>2</strong> screens</span>
                        <span class="visually-hidden"><strong data-dashboard-device-count>0</strong> connected</span>
                    </div>
                </div>
                <p class="card-description">Drag a connected device onto a screen to assign it. You can also use each screen's assignment menu.</p>
                <p class="layout-warning" data-layout-warning hidden></p>
                <div class="panorama-wall" data-panorama-wall aria-label="Panorama screen assignments"></div>
                <div class="panorama-preview-wrap">
                    <div class="panorama-preview-heading">
                        <h3>Full panorama preview</h3>
                        <span data-dashboard-content-status>Waiting for content</span>
                    </div>
                    <div class="panorama-preview" data-panorama-preview>
                        <p class="dashboard-empty-state">Publish media to preview the complete panorama.</p>
                    </div>
                </div>
                <div class="dashboard-devices-wrap">
                    <div class="panorama-preview-heading">
                        <h3>Device information</h3>
                        <span>Drag a device card to a screen</span>
                    </div>
                    <details class="management-disclosure">
                        <summary>Registered devices</summary>
                        <div class="dashboard-devices" data-dashboard-devices>
                            <p class="dashboard-empty-state">No devices have registered yet.</p>
                        </div>
                    </details>
                </div>
                <p class="dashboard-status" data-dashboard-status role="status" aria-live="polite"></p>
            </section>

            <details class="advanced-settings" id="settings">
                <summary>Advanced settings · layout, calibration, alignment and diagnostics</summary>
            <section class="controller-card layout-config-card" aria-labelledby="layout-config-title">
                <div class="card-heading">
                    <div>
                        <p class="eyebrow">DISPLAY GEOMETRY</p>
                        <h2 id="layout-config-title">Display layout</h2>
                    </div>
                </div>
                <p class="card-description">
                    Screen cells map to equal normalized regions of the panorama. Empty cells in a custom layout represent image regions with no assigned display.
                </p>
                <div class="layout-config-controls">
                    <label>Layout type
                        <select data-layout-type disabled>
                            <option value="horizontal">Horizontal</option>
                            <option value="vertical">Vertical</option>
                            <option value="grid">Grid</option>
                            <option value="custom">Custom</option>
                        </select>
                    </label>
                    <label>Rows
                        <input type="number" min="1" max="12" value="1" data-layout-rows disabled>
                    </label>
                    <label>Columns
                        <input type="number" min="1" max="12" value="2" data-layout-columns disabled>
                    </label>
                    <button class="alignment-action" type="button" data-layout-apply disabled>Apply Layout</button>
                    <button class="alignment-action is-warning" type="button" data-layout-reset disabled>
                        ↺ Reset to Default
                    </button>
                </div>
                <div class="layout-preset-controls">
                    <label>Save layout preset
                        <input type="text" maxlength="32" data-layout-preset-name placeholder="Layout name">
                    </label>
                    <button class="alignment-action" type="button" data-layout-preset-save disabled>Save layout</button>
                    <label>Load layout
                        <select data-layout-preset-select disabled></select>
                    </label>
                    <button class="alignment-action" type="button" data-layout-preset-load disabled>Load layout</button>
                    <button class="alignment-action is-danger" type="button" data-layout-preset-delete disabled>Delete layout</button>
                </div>
                <p class="alignment-status" data-layout-status role="status" aria-live="polite">Waiting for display layout.</p>
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
            </details>

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

            <dialog class="vision-dialog" data-vision-dialog aria-labelledby="vision-title">
                <div class="vision-dialog-heading">
                    <div>
                        <p class="eyebrow">MOBILE VISION</p>
                        <h2 id="vision-title">Connect vision camera</h2>
                    </div>
                    <button class="vision-close" type="button" data-vision-close aria-label="Close dialog">×</button>
                </div>

                <div class="vision-qr-wrap">
                    <img data-vision-qr alt="QR code for the mobile vision camera session" hidden>
                    <p data-vision-placeholder>Requesting a QR code for the phone camera session...</p>
                </div>

                <label class="vision-url-label">
                    Vision URL
                    <input type="text" data-vision-url readonly>
                </label>

                <div class="vision-actions">
                    <button class="alignment-action" type="button" data-vision-copy disabled>Copy URL</button>
                </div>

                <div class="vision-status" role="status" aria-live="polite">
                    <p data-vision-session-status>Waiting for a vision session.</p>
                </div>

                <p class="vision-instructions">
                    Scan with your smartphone, then open the camera link on the same Wi‑Fi network.
                </p>
            </dialog>

            <footer class="controller-footer">
                <span>PARALLAX · Synchronized panoramic display</span>
                <span>Images up to 15 MB · MP4 videos up to 100 MB</span>
            </footer>
        </main>
    `;

    root.querySelector('[data-settings-link]').addEventListener('click', () => {
        root.querySelector('#settings').open = true;
    });

    const fileInput = root.querySelector('[data-file-input]');
    const dropZone = root.querySelector('[data-drop-zone]');
    const dropLabel = root.querySelector('[data-drop-label]');
    const preview = root.querySelector('[data-image-preview]');
    const fileDetails = root.querySelector('[data-file-details]');
    const contentLibrary = root.querySelector('[data-content-library]');
    const uploadHistory = root.querySelector('[data-upload-history]');
    const mediaSearch = root.querySelector('[data-media-search]');
    const mediaFilter = root.querySelector('[data-media-filter]');
    const mediaTransition = root.querySelector('[data-media-transition]');
    const playlistNameInput = root.querySelector('[data-playlist-name]');
    const playlistTypeSelect = root.querySelector('[data-playlist-type]');
    const playlistDurationInput = root.querySelector('[data-playlist-duration]');
    const playlistLoopInput = root.querySelector('[data-playlist-loop]');
    const playlistShuffleInput = root.querySelector('[data-playlist-shuffle]');
    const playlistSelect = root.querySelector('[data-playlist-select]');
    const playlistNewButton = root.querySelector('[data-playlist-new]');
    const playlistSaveButton = root.querySelector('[data-playlist-save]');
    const playlistLoadButton = root.querySelector('[data-playlist-load]');
    const playlistDeleteButton = root.querySelector('[data-playlist-delete]');
    const playlistPreviewButton = root.querySelector('[data-playlist-preview]');
    const playlistDraftElement = root.querySelector('[data-playlist-draft]');
    const playbackStatus = root.querySelector('[data-playback-status]');
    const playbackSeek = root.querySelector('[data-playback-seek]');
    const playbackPosition = root.querySelector('[data-playback-position]');
    const playbackVolume = root.querySelector('[data-playback-volume]');
    const playbackVolumeValue = root.querySelector('[data-playback-volume-value]');
    const playbackMuteButton = root.querySelector('[data-playback-mute]');
    const audioModeSelect = root.querySelector('[data-audio-mode]');
    const audioMasterSelect = root.querySelector('[data-audio-master]');
    const audioModeStatus = root.querySelector('[data-audio-mode-status]');
    const controllerPreview = root.querySelector('[data-current-image]');
    const controllerFullscreenButton = root.querySelector('[data-controller-fullscreen]');
    const scheduleTarget = root.querySelector('[data-schedule-target]');
    const scheduleStart = root.querySelector('[data-schedule-start]');
    const scheduleEnd = root.querySelector('[data-schedule-end]');
    const scheduleTimezone = root.querySelector('[data-schedule-timezone]');
    const scheduleList = root.querySelector('[data-schedule-list]');
    const mediaStatus = root.querySelector('[data-media-status]');
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
    const visionConnectButton = root.querySelector('[data-vision-connect]');
    const visionStatusNode = root.querySelector('[data-vision-status]');
    const visionObservations = root.querySelector('[data-vision-observations]');
    const visionSpatialPreview = root.querySelector('[data-vision-spatial-preview]');
    const alignmentGrid = root.querySelector('[data-alignment-grid]');
    const screenList = root.querySelector('[data-screen-list]');
    const deviceAssignmentList = root.querySelector('[data-device-assignment-list]');
    const assignmentStatus = root.querySelector('[data-assignment-status]');
    const dashboardWall = root.querySelector('[data-panorama-wall]');
    const dashboardPreview = root.querySelector('[data-panorama-preview]');
    const dashboardDevices = root.querySelector('[data-dashboard-devices]');
    const dashboardStatus = root.querySelector('[data-dashboard-status]');
    const layoutWarning = root.querySelector('[data-layout-warning]');
    const layoutTypeSelect = root.querySelector('[data-layout-type]');
    const layoutRowsInput = root.querySelector('[data-layout-rows]');
    const layoutColumnsInput = root.querySelector('[data-layout-columns]');
    const layoutApplyButton = root.querySelector('[data-layout-apply]');
    const layoutPresetNameInput = root.querySelector('[data-layout-preset-name]');
    const layoutPresetSelect = root.querySelector('[data-layout-preset-select]');
    const layoutPresetSaveButton = root.querySelector('[data-layout-preset-save]');
    const layoutPresetLoadButton = root.querySelector('[data-layout-preset-load]');
    const layoutPresetDeleteButton = root.querySelector('[data-layout-preset-delete]');
    const layoutResetButton = root.querySelector('[data-layout-reset]');
    const layoutStatus = root.querySelector('[data-layout-status]');
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
    const visionDialog = root.querySelector('[data-vision-dialog]');
    const visionCloseButton = root.querySelector('[data-vision-close]');
    const visionQr = root.querySelector('[data-vision-qr]');
    const visionPlaceholder = root.querySelector('[data-vision-placeholder]');
    const visionUrlInput = root.querySelector('[data-vision-url]');
    const visionSessionStatus = root.querySelector('[data-vision-session-status]');
    const visionCopyButton = root.querySelector('[data-vision-copy]');
    const socket = createParallaxSocket();

    let selectedFile = null;
    let selectedMediaDuration = null;
    let controllerUploadToken = null;
    let controllerSessionReady = false;
    let previewUrl = null;
    let uploadRequest = null;
    let calibrationEnabled = false;
    let totalScreens = 2;
    let assignmentMode = 'automatic';
    let registeredDevices = [];
    let visionObservationCache = [];
    let panoramaImageUrl = null;
    let panoramaMediaType = 'image';
    let displayLayout = createDefaultLayout(2);
    let layoutPresets = [];
    let mediaLibrary = [];
    let mediaUploadHistory = [];
    const mediaThumbnails = new Map();
    let mediaPlaylists = [];
    let mediaSchedules = [];
    let currentMediaId = null;
    let currentPlayback = null;
    let lastNonzeroPlaybackVolume = 0.5;
    let audioSettings = { ...DEFAULT_AUDIO_SETTINGS };
    let previewServerTimeOffset = 0;
    let previewSyncTimer = null;
    let playbackVolumeTimer = null;
    let lastPreviewPlaybackError = null;
    let playlistDraft = [];
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
        const connectedCount = registeredDevices.filter((device) =>
            device.connected && device.enabled !== false).length;
        root.querySelector('[data-dashboard-device-count]').textContent = String(connectedCount);
        dashboardWall.style.gridTemplateColumns =
            `repeat(${displayLayout.columns}, minmax(0, 1fr))`;
        dashboardWall.style.gridTemplateRows =
            `repeat(${displayLayout.rows}, minmax(0, auto))`;
        dashboardWall.innerHTML = Array.from({ length: totalScreens }, (_, index) => {
            const screen = index + 1;
            const device = registeredDevices.find((entry) => entry.screen === screen);
            const geometry = displayLayout.screens[screen];
            const enabled = geometry.enabled;
            const connected = Boolean(device?.connected && enabled);
            const status = !enabled ? 'Disabled' : !device ? 'Unassigned' : connected ? 'Online' : 'Offline';
            const settings = alignmentByScreen[screen];
            const displayStatus = diagnostics?.devices?.find((entry) => entry.screen === screen);
            const assignmentOptions = [
                `<option value="" ${device ? '' : 'selected'}>Unassigned</option>`,
                ...registeredDevices.map((entry) => `
                    <option value="${escapeHtml(entry.id)}" ${device?.id === entry.id ? 'selected' : ''}
                        ${registeredDevices.some((candidate) => candidate.id !== entry.id && candidate.screen === screen) ? 'disabled' : ''}>
                        ${escapeHtml(entry.id)}${entry.connected ? '' : ' · offline'}
                    </option>
                `)
            ].join('');
            return `
                <article class="dashboard-screen-card ${connected ? 'is-online' : !enabled ? 'is-disabled' : device ? 'is-offline' : 'is-unassigned'}"
                    data-dashboard-screen="${screen}" data-screen-number="${screen}"
                    style="grid-row:${geometry.row + 1};grid-column:${geometry.column + 1}" draggable="true">
                    <div class="dashboard-screen-heading">
                        <span class="dashboard-screen-number">SCREEN ${screen}</span>
                        <span class="dashboard-status-pill"><i></i>${status}</span>
                    </div>
                    <p class="dashboard-screen-device">${device ? escapeHtml(device.id) : 'No device assigned'}</p>
                    <p class="dashboard-device-name">${device ? 'Name not reported' : 'Waiting for a device'}</p>
                    <label class="dashboard-assignment-control">Assign device
                        <select data-screen-assignment="${screen}"
                            ${!socket.connected || !enabled ? 'disabled' : ''}>
                            ${assignmentOptions}
                        </select>
                    </label>
                    <div class="dashboard-screen-actions">
                        <button type="button" data-screen-identify="${screen}" ${!connected ? 'disabled' : ''}>
                            Identify
                        </button>
                    </div>
                    <details class="management-disclosure screen-options">
                        <summary>Advanced screen settings</summary>
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
                            <button type="button" data-screen-alignment="${screen}">View alignment</button>
                            <button type="button" data-screen-reset="${screen}" ${!alignmentReady ? 'disabled' : ''}>
                                Reset alignment
                            </button>
                        </div>
                        <div class="screen-geometry-controls">
                            <label>Row<input type="number" min="0" max="11" value="${geometry.row}"
                                data-screen-position="${screen}" data-position-axis="row" ${!socket.connected ? 'disabled' : ''}></label>
                            <label>Column<input type="number" min="0" max="11" value="${geometry.column}"
                                data-screen-position="${screen}" data-position-axis="column" ${!socket.connected ? 'disabled' : ''}></label>
                            <label>Rotation<select data-screen-rotation="${screen}" ${!socket.connected ? 'disabled' : ''}>
                                ${[0, 90, 180, 270].map((degrees) =>
                                    `<option value="${degrees}" ${geometry.rotation === degrees ? 'selected' : ''}>${degrees}°</option>`).join('')}
                            </select></label>
                            <label>Orientation<select data-screen-orientation="${screen}" ${!socket.connected ? 'disabled' : ''}>
                                ${[['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']]
                                    .map(([value, name]) =>
                                        `<option value="${value}" ${geometry.orientation === value ? 'selected' : ''}>${name}</option>`).join('')}
                            </select></label>
                            <label class="screen-enabled-control"><input type="checkbox" data-screen-enabled="${screen}"
                                ${enabled ? 'checked' : ''} ${!socket.connected ? 'disabled' : ''}> Enabled</label>
                        </div>
                    </details>
                </article>
            `;
        }).join('');
        layoutTypeSelect.value = displayLayout.type;
        layoutRowsInput.value = String(displayLayout.rows);
        layoutColumnsInput.value = String(displayLayout.columns);
        layoutRowsInput.disabled = !socket.connected || displayLayout.type === 'horizontal';
        layoutColumnsInput.disabled = !socket.connected || displayLayout.type === 'vertical';
        layoutTypeSelect.disabled = !socket.connected;
        layoutApplyButton.disabled = !socket.connected;
        layoutResetButton.disabled = !socket.connected;
        layoutWarning.hidden = validateDisplayLayout(displayLayout, totalScreens);
        layoutWarning.textContent = layoutWarning.hidden ? '' :
            'Invalid screen geometry: correct out-of-bounds or overlapping screen positions before applying.';
    }

    function renderDashboardDevices() {
        dashboardDevices.innerHTML = registeredDevices.length
            ? registeredDevices.map((device) => {
                const report = diagnostics?.devices?.find((entry) => entry.deviceId === device.id);
                const status = device.enabled === false ? 'Disabled' : device.connected ? 'Online' : 'Offline';
                const occupantByScreen = new Map(
                    registeredDevices
                        .filter((entry) => Number.isInteger(entry.screen))
                        .map((entry) => [entry.screen, entry.id])
                );
                return `
                    <article class="dashboard-device-card ${device.enabled === false ? 'is-disabled' : device.connected ? 'is-online' : 'is-offline'}"
                        data-device-card="${escapeHtml(device.id)}" draggable="true">
                        <div class="dashboard-device-card-heading">
                            <strong>${escapeHtml(device.name || device.id)}</strong>
                            <span class="dashboard-status-pill"><i></i>${status}</span>
                        </div>
                        <p>Device ID: ${escapeHtml(device.id)}</p>
                        <p>Assigned screen: ${Number.isInteger(device.screen) ? `Screen ${device.screen}${device.enabled === false ? ' · disabled' : ''}` : 'Unassigned'}</p>
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
                                    const occupant = occupantByScreen.get(screen);
                                    const occupied = occupant && occupant !== device.id;
                                    return `<option value="${screen}" ${device.screen === screen ? 'selected' : ''} ${occupied ? 'disabled' : ''}>Screen ${screen}${occupied ? ' · assigned' : ''}</option>`;
                                }).join('')}
                            </select>
                        </label>
                        <button type="button" class="dashboard-identify-button" data-device-identify="${escapeHtml(device.id)}"
                            ${!device.connected || device.enabled === false || !Number.isInteger(device.screen) ? 'disabled' : ''}>
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
                '<p class="dashboard-empty-state">Publish media to preview the complete panorama.</p>';
            return;
        }
        previewStatus.textContent = panoramaMediaType === 'video'
            ? 'Latest published video'
            : 'Latest published image';
        dashboardPreview.style.gridTemplateColumns =
            `repeat(${displayLayout.columns}, minmax(0, 1fr))`;
        dashboardPreview.style.gridTemplateRows =
            `repeat(${displayLayout.rows}, minmax(70px, 1fr))`;
        dashboardPreview.style.aspectRatio = `${displayLayout.columns} / ${displayLayout.rows}`;
        const mediaTag = panoramaMediaType === 'video' ? 'video' : 'img';
        let panorama = dashboardPreview.querySelector('.panorama-preview-image');
        if (!panorama || panorama.tagName.toLowerCase() !== mediaTag
            || panorama.src !== new URL(panoramaImageUrl, window.location.href).href) {
            panorama = document.createElement(mediaTag);
            panorama.className = 'panorama-preview-image';
            if (panoramaMediaType === 'video') {
                panorama.muted = true;
                panorama.controls = false;
                panorama.preload = 'auto';
                panorama.playsInline = true;
                panorama.addEventListener('loadedmetadata', synchronizePublishedPreviewVideos);
                panorama.addEventListener('loadeddata', synchronizePublishedPreviewVideos);
            } else {
                panorama.alt = 'Complete published panorama';
            }
            panorama.src = panoramaImageUrl;
            dashboardPreview.replaceChildren(panorama);
        }
        for (const segment of dashboardPreview.querySelectorAll('.panorama-preview-segment')) {
            segment.remove();
        }
        for (let index = 0; index < totalScreens; index += 1) {
            const screen = index + 1;
            const geometry = displayLayout.screens[screen];
            const device = registeredDevices.find((entry) => entry.screen === screen);
            const segment = document.createElement('div');
            segment.className = 'panorama-preview-segment';
            segment.setAttribute('aria-label', `Screen ${screen} preview`);
            segment.style.gridRow = String(geometry.row + 1);
            segment.style.gridColumn = String(geometry.column + 1);
            segment.classList.toggle('is-disabled', !geometry.enabled);
            const label = document.createElement('span');
            label.className = 'panorama-preview-label';
            label.textContent = `SCREEN ${screen} · ${device?.id ?? 'Unassigned'} · ${geometry.rotation}°`;
            segment.append(label);
            if (!geometry.enabled) {
                const disabled = document.createElement('span');
                disabled.className = 'panorama-preview-disabled';
                disabled.textContent = 'DISABLED';
                segment.append(disabled);
            }
            dashboardPreview.append(segment);
        }
        synchronizePublishedPreviewVideos();
    }

    function renderDashboard() {
        renderDashboardScreens();
        renderDashboardDevices();
    }

    function setDisplayLayout(nextLayout, { render = true } = {}) {
        if (!validateDisplayLayout(nextLayout, totalScreens)) {
            layoutWarning.hidden = false;
            layoutWarning.textContent =
                'Invalid screen geometry: correct out-of-bounds or overlapping screen positions before applying.';
            return false;
        }
        displayLayout = {
            type: nextLayout.type,
            rows: nextLayout.rows,
            columns: nextLayout.columns,
            screens: Object.fromEntries(Object.entries(nextLayout.screens)
                .map(([screen, geometry]) => [screen, { ...geometry }]))
        };
        layoutWarning.hidden = true;
        if (render) {
            renderDashboardScreens();
            renderPanoramaPreview();
        }
        return true;
    }

    function setLayoutPresets(nextPresets) {
        if (!Array.isArray(nextPresets)
            || nextPresets.some((preset) => typeof preset?.name !== 'string'
                || !Number.isInteger(preset.totalScreens)
                || !validateDisplayLayout(preset.layout, preset.totalScreens))) {
            return;
        }
        layoutPresets = nextPresets;
        const selected = layoutPresetSelect.value;
        layoutPresetSelect.replaceChildren();
        for (const preset of layoutPresets) {
            const option = document.createElement('option');
            option.value = preset.name;
            option.textContent = `${preset.name} · ${preset.totalScreens} screens`;
            layoutPresetSelect.append(option);
        }
        layoutPresetSelect.value = layoutPresets.some((preset) => preset.name === selected)
            ? selected
            : layoutPresets[0]?.name ?? '';
        const selectedPreset = layoutPresets.find((preset) => preset.name === layoutPresetSelect.value);
        layoutPresetSelect.disabled = !socket.connected || !selectedPreset;
        layoutPresetLoadButton.disabled = !socket.connected || !selectedPreset;
        layoutPresetDeleteButton.disabled = !socket.connected
            || !selectedPreset || selectedPreset.isDefault;
        layoutPresetSaveButton.disabled = !socket.connected;
    }

    function sendLayout(nextLayout, successMessage = 'Display layout saved.') {
        if (!validateDisplayLayout(nextLayout, totalScreens)) {
            layoutStatus.textContent =
                'Invalid layout: screen positions must be unique and within the configured rows and columns.';
            layoutStatus.classList.add('is-error');
            layoutWarning.hidden = false;
            layoutWarning.textContent = layoutStatus.textContent;
            return;
        }
        layoutWarning.hidden = true;
        layoutStatus.textContent = 'Saving display layout...';
        layoutStatus.classList.remove('is-error');
        socket.timeout(5000).emit('layout:set', { layout: nextLayout }, (error, response) => {
            if (error || !response?.ok) {
                layoutStatus.textContent = error
                    ? 'The server did not acknowledge the layout update.'
                    : response?.message || 'Unable to save display layout.';
                layoutStatus.classList.add('is-error');
                return;
            }
            totalScreens = response.totalScreens;
            setDisplayLayout(response.layout);
            layoutStatus.textContent = successMessage;
            layoutStatus.classList.remove('is-error');
        });
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
                <p>Playback status: <strong data-diagnostic-playback-status>Unknown</strong></p>
                <p>Position / expected: <strong data-diagnostic-playback-position>Unknown</strong></p>
                <p>Drift: <strong data-diagnostic-playback-drift>Unknown</strong></p>
                <p>Ready / network state: <strong data-diagnostic-ready-state>Unknown</strong></p>
                <p>Buffer / rate: <strong data-diagnostic-buffering>Unknown</strong></p>
                <p>Audio: <strong data-diagnostic-audio>Unknown</strong></p>
                <p>Last sync: <strong data-diagnostic-last-sync>Unknown</strong></p>
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
        if (window.location.protocol !== 'https:' && !selectedAddress) {
            setPairingStatus('No usable LAN address is available. Connect to Wi-Fi and refresh.', true);
            return;
        }

        const url = new URL('/', window.location.origin);
        if (window.location.protocol !== 'https:' && selectedAddress) {
            url.hostname = selectedAddress;
            url.port = '5173';
        }
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
        const nextLayout = configuration.layout ?? createDefaultLayout(totalScreens);
        if (!setDisplayLayout(nextLayout, { render: false })) {
            layoutWarning.hidden = false;
            layoutWarning.textContent = 'The server returned invalid display geometry. The existing layout was kept.';
            return;
        }
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
        layoutStatus.textContent = `Layout synchronized (${displayLayout.type}, ${displayLayout.rows} × ${displayLayout.columns}).`;
        layoutStatus.classList.remove('is-error');
        setLayoutPresets(layoutPresets);
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

    layoutTypeSelect.addEventListener('change', () => {
        const type = layoutTypeSelect.value;
        if (type === 'horizontal') {
            layoutRowsInput.value = '1';
            layoutColumnsInput.value = String(totalScreens);
        } else if (type === 'vertical') {
            layoutRowsInput.value = String(totalScreens);
            layoutColumnsInput.value = '1';
        } else if (type === 'grid') {
            const columns = Math.ceil(Math.sqrt(totalScreens));
            layoutColumnsInput.value = String(columns);
            layoutRowsInput.value = String(Math.ceil(totalScreens / columns));
        } else {
            layoutRowsInput.value = String(displayLayout.rows);
            layoutColumnsInput.value = String(displayLayout.columns);
        }
        layoutRowsInput.disabled = type === 'horizontal';
        layoutColumnsInput.disabled = type === 'vertical';
    });

    layoutApplyButton.addEventListener('click', () => {
        const type = layoutTypeSelect.value;
        const rows = Number(layoutRowsInput.value);
        const columns = Number(layoutColumnsInput.value);
        let nextLayout;
        if (type === 'custom') {
            nextLayout = {
                ...displayLayout,
                type,
                rows,
                columns,
                screens: Object.fromEntries(Object.entries(displayLayout.screens)
                    .map(([screen, geometry]) => [screen, { ...geometry }]))
            };
        } else {
            try {
                nextLayout = createDefaultLayout(totalScreens, type, rows, columns);
                for (let screen = 1; screen <= totalScreens; screen += 1) {
                    nextLayout.screens[screen] = {
                        ...nextLayout.screens[screen],
                        rotation: displayLayout.screens[screen].rotation,
                        orientation: displayLayout.screens[screen].orientation,
                        enabled: displayLayout.screens[screen].enabled
                    };
                }
            } catch (error) {
                layoutStatus.textContent = error.message;
                layoutStatus.classList.add('is-error');
                return;
            }
        }
        sendLayout(nextLayout);
    });

    layoutResetButton.addEventListener('click', () => {
        confirmLayoutReset(
            (message) => window.confirm(message),
            () => {
                layoutStatus.textContent = 'Resetting display layout...';
                layoutStatus.classList.remove('is-error');
                socket.timeout(5000).emit('layout:reset', {}, (error, response) => {
                    if (error || !response?.ok) {
                        layoutStatus.textContent = error
                            ? 'The server did not acknowledge the layout reset.'
                            : response?.message || 'Unable to reset display layout.';
                        layoutStatus.classList.add('is-error');
                        return;
                    }
                    totalScreens = response.totalScreens;
                    setDisplayLayout(response.layout);
                    layoutRowsInput.value = String(response.layout.rows);
                    layoutColumnsInput.value = String(response.layout.columns);
                    layoutStatus.textContent = 'Display layout reset to the default horizontal arrangement.';
                    layoutStatus.classList.remove('is-error');
                });
            }
        );
    });

    layoutPresetSaveButton.addEventListener('click', () => {
        socket.timeout(5000).emit('layout-presets:save', {
            name: layoutPresetNameInput.value
        }, (error, response) => {
            if (error || !response?.ok) {
                layoutStatus.textContent = error
                    ? 'The server did not acknowledge the layout preset.'
                    : response?.message || 'Unable to save layout preset.';
                layoutStatus.classList.add('is-error');
                return;
            }
            setLayoutPresets(response.presets);
            layoutStatus.textContent = `Layout "${layoutPresetNameInput.value.trim()}" saved.`;
            layoutStatus.classList.remove('is-error');
            layoutPresetNameInput.value = '';
        });
    });
    layoutPresetLoadButton.addEventListener('click', () => {
        socket.timeout(5000).emit('layout-presets:load', {
            name: layoutPresetSelect.value
        }, (error, response) => {
            if (error || !response?.ok) {
                layoutStatus.textContent = error
                    ? 'The server did not acknowledge the layout preset.'
                    : response?.message || 'Unable to load layout preset.';
                layoutStatus.classList.add('is-error');
                return;
            }
            totalScreens = response.totalScreens;
            screenCountSelect.value = String(totalScreens);
            layoutRowsInput.value = String(response.layout.rows);
            layoutColumnsInput.value = String(response.layout.columns);
            setDisplayLayout(response.layout);
            layoutStatus.textContent = `Layout "${response.name}" loaded.`;
            layoutStatus.classList.remove('is-error');
        });
    });
    layoutPresetDeleteButton.addEventListener('click', () => {
        const name = layoutPresetSelect.value;
        const selected = layoutPresets.find((preset) => preset.name === name);
        if (!selected || selected.isDefault) {
            return;
        }
        if (!window.confirm(`Delete the "${name}" layout preset? Current layout will not change.`)) {
            return;
        }
        socket.timeout(5000).emit('layout-presets:delete', { name }, (error, response) => {
            if (error || !response?.ok) {
                layoutStatus.textContent = error
                    ? 'The server did not acknowledge layout preset deletion.'
                    : response?.message || 'Unable to delete layout preset.';
                layoutStatus.classList.add('is-error');
                return;
            }
            setLayoutPresets(response.presets);
            layoutStatus.textContent = `Layout "${name}" deleted. Current layout was not changed.`;
            layoutStatus.classList.remove('is-error');
        });
    });
    layoutPresetSelect.addEventListener('change', () => {
        const selected = layoutPresets.find((preset) => preset.name === layoutPresetSelect.value);
        layoutPresetLoadButton.disabled = !socket.connected || !selected;
        layoutPresetDeleteButton.disabled = !socket.connected || !selected || selected.isDefault;
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
        if (!card || !event.dataTransfer) {
            return;
        }
        event.preventDefault();
        card.classList.remove('is-drop-target');
        const draggedScreen = Number(event.dataTransfer.getData('application/x-parallax-screen'));
        const targetScreen = Number(card.dataset.dashboardScreen);
        if (Number.isInteger(draggedScreen) && draggedScreen !== targetScreen) {
            const nextLayout = {
                ...displayLayout,
                screens: Object.fromEntries(Object.entries(displayLayout.screens)
                    .map(([screen, geometry]) => [screen, { ...geometry }]))
            };
            const first = nextLayout.screens[draggedScreen];
            const second = nextLayout.screens[targetScreen];
            [first.row, second.row] = [second.row, first.row];
            [first.column, second.column] = [second.column, first.column];
            nextLayout.type = 'custom';
            sendLayout(nextLayout, `Screen ${draggedScreen} moved to Screen ${targetScreen}'s position.`);
            return;
        }
        const deviceId = event.dataTransfer.getData('text/plain');
        if (deviceId) {
            requestDeviceAssignment(deviceId, targetScreen);
        }
    });

    dashboardWall.addEventListener('dragstart', (event) => {
        const card = event.target.closest('[data-screen-number]');
        if (!card || !event.dataTransfer || event.target.closest('input, select, button')) {
            event.preventDefault();
            return;
        }
        event.dataTransfer.setData('application/x-parallax-screen', card.dataset.screenNumber);
        event.dataTransfer.effectAllowed = 'move';
    });

    dashboardWall.addEventListener('change', (event) => {
        const rotation = event.target.closest('[data-screen-rotation]');
        const orientation = event.target.closest('[data-screen-orientation]');
        const position = event.target.closest('[data-screen-position]');
        const enabled = event.target.closest('[data-screen-enabled]');
        if (rotation || orientation || position) {
            const screen = Number((rotation || orientation || position).dataset.screenRotation
                ?? (rotation || orientation || position).dataset.screenOrientation
                ?? (rotation || orientation || position).dataset.screenPosition);
            const oldPosition = displayLayout.screens[screen];
            const nextPosition = {
                ...oldPosition,
                row: position?.dataset.positionAxis === 'row'
                    ? Number(position.value) : oldPosition.row,
                column: position?.dataset.positionAxis === 'column'
                    ? Number(position.value) : oldPosition.column,
                rotation: rotation ? Number(rotation.value) : oldPosition.rotation,
                orientation: orientation ? orientation.value : oldPosition.orientation
            };
            socket.timeout(5000).emit('screen:configure', {
                screen,
                position: nextPosition
            }, (error, response) => {
                if (error || !response?.ok) {
                    layoutStatus.textContent = error
                        ? 'The server did not acknowledge the screen geometry.'
                        : response?.message || 'Unable to update screen geometry.';
                    layoutStatus.classList.add('is-error');
                    renderDashboardScreens();
                    return;
                }
                totalScreens = response.totalScreens;
                setDisplayLayout(response.layout);
                layoutStatus.textContent = `Screen ${screen} geometry updated.`;
                layoutStatus.classList.remove('is-error');
            });
            return;
        }
        if (enabled) {
            const screen = Number(enabled.dataset.screenEnabled);
            const state = enabled.checked ? 'screen:enable' : 'screen:disable';
            socket.timeout(5000).emit(state, { screen }, (error, response) => {
                if (error || !response?.ok) {
                    layoutStatus.textContent = error
                        ? 'The server did not acknowledge the screen state.'
                        : response?.message || 'Unable to update screen enabled state.';
                    layoutStatus.classList.add('is-error');
                    renderDashboardScreens();
                    return;
                }
                displayLayout.screens[screen].enabled = response.enabled;
                renderDashboardScreens();
                renderPanoramaPreview();
                layoutStatus.textContent =
                    `Screen ${screen} ${response.enabled ? 'enabled' : 'disabled'}. Device assignment and calibration were preserved.`;
                layoutStatus.classList.remove('is-error');
            });
        }
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
        panoramaImageUrl = resolveParallaxMediaUrl(imageUrl);
        panoramaMediaType = 'image';
        currentImage.replaceChildren();
        const image = document.createElement('img');
        image.dataset.currentMedia = 'true';
        image.dataset.sourceUrl = new URL(panoramaImageUrl, window.location.href).href;
        image.src = panoramaImageUrl;
        image.alt = `Currently published panorama: ${filename}`;
        currentImage.append(image);
        root.querySelector('[data-current-name]').textContent = filename;
        root.querySelector('[data-current-meta]').textContent = width && height
            ? `${width} × ${height} · Published to displays`
            : 'Currently displayed';
        renderPanoramaPreview();
    }

    function setMediaStatus(message, isError = false) {
        mediaStatus.textContent = message;
        mediaStatus.classList.toggle('is-error', isError);
    }

    function showMediaPreview(item) {
        if (!item) {
            return;
        }
        preview.replaceChildren();
        const element = item.mediaType === 'video'
            ? document.createElement('video')
            : document.createElement('img');
        element.src = resolveParallaxMediaUrl(item.url);
        if (item.mediaType === 'video') {
            element.controls = true;
            element.muted = true;
            element.playsInline = true;
            element.preload = 'metadata';
        } else {
            element.alt = `Preview ${item.filename}`;
        }
        preview.append(element);
        root.querySelector('[data-file-name]').textContent = item.filename;
        root.querySelector('[data-file-dimensions]').textContent =
            item.durationSeconds ? `${formatDuration(item.durationSeconds)} · ${formatBytes(item.size)}`
                : `${formatBytes(item.size)} · ${item.mediaType}`;
        fileDetails.hidden = false;
        selectedFile = null;
        publishButton.disabled = !selectedFile;
        setPublishStatus(`Previewing ${item.filename}.`);
    }

    function renderMediaLibrary() {
        const query = mediaSearch.value.trim().toLowerCase();
        const filter = mediaFilter.value;
        const items = [...mediaLibrary]
            .filter((item) => filter === 'all' || item.mediaType === filter)
            .filter((item) => item.filename.toLowerCase().includes(query))
            .sort((left, right) => Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt));
        contentLibrary.replaceChildren();
        if (items.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'dashboard-empty-state';
            empty.textContent = mediaLibrary.length
                ? 'No media matches this search and filter.'
                : 'Uploaded media will appear here.';
            contentLibrary.append(empty);
        }
        for (const item of items) {
            const row = document.createElement('article');
            row.className = 'media-library-item';
            row.dataset.mediaId = item.id;
            const thumbnailTag = item.mediaType === 'image' ? 'img' : 'video';
            let thumbnail = mediaThumbnails.get(item.id);
            if (!thumbnail || thumbnail.tagName.toLowerCase() !== thumbnailTag) {
                thumbnail = document.createElement(thumbnailTag);
                thumbnail.className = 'media-library-thumbnail';
                mediaThumbnails.set(item.id, thumbnail);
            }
            if (item.mediaType === 'image') {
                const mediaUrl = resolveParallaxMediaUrl(item.url);
                if (thumbnail.dataset.sourceUrl !== mediaUrl) {
                    thumbnail.src = mediaUrl;
                    thumbnail.dataset.sourceUrl = mediaUrl;
                }
                thumbnail.alt = '';
            } else {
                thumbnail.classList.add('is-video');
                const mediaUrl = resolveParallaxMediaUrl(item.url);
                if (thumbnail.dataset.sourceUrl !== mediaUrl) {
                    thumbnail.src = mediaUrl;
                    thumbnail.dataset.sourceUrl = mediaUrl;
                }
                thumbnail.muted = true;
                thumbnail.playsInline = true;
                thumbnail.preload = 'metadata';
            }
            const details = document.createElement('div');
            details.className = 'media-library-details';
            const filename = document.createElement('strong');
            filename.textContent = item.filename;
            const metadata = document.createElement('span');
            metadata.textContent = `${item.mediaType.toUpperCase()} · ${formatBytes(item.size)} · ${
                item.durationSeconds ? formatDuration(item.durationSeconds) : 'Duration unavailable'
            } · ${formatTimestamp(item.uploadedAt)}`;
            const status = document.createElement('span');
            status.className = 'media-item-status';
            status.textContent = item.id === currentMediaId ? 'Currently published' : 'Saved';
            details.append(filename, metadata, status);
            const actions = document.createElement('div');
            actions.className = 'media-library-actions';
            actions.append(
                createMediaAction('Preview', 'preview'),
                createMediaAction('Publish', 'publish'),
                createMediaAction('Add to playlist', 'add'),
                createMediaAction('Delete', 'delete')
            );
            row.append(thumbnail, details, actions);
            contentLibrary.append(row);
        }
        renderUploadHistory(mediaUploadHistory);
        renderScheduleTargets();
    }

    function createMediaAction(label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'alignment-action';
        button.dataset.mediaAction = action;
        button.textContent = label;
        if (action === 'delete') {
            button.classList.add('is-danger');
        }
        return button;
    }

    function renderUploadHistory(items = mediaLibrary) {
        uploadHistory.replaceChildren();
        const sorted = [...items].sort((left, right) =>
            Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt));
        if (sorted.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'dashboard-empty-state';
            empty.textContent = 'No uploads yet.';
            uploadHistory.append(empty);
            return;
        }
        for (const item of sorted) {
            const entry = document.createElement('p');
            entry.className = 'upload-history-entry';
            entry.textContent = `${item.filename} · ${item.mediaType} · ${formatBytes(item.size)} · ${
                formatTimestamp(item.uploadedAt)
            } · Upload: ${item.uploadStatus} · Publishing: ${item.publishingStatus}`;
            uploadHistory.append(entry);
        }
    }

    function renderPlaylists() {
        const selectedId = playlistSelect.value;
        playlistSelect.replaceChildren();
        for (const playlist of mediaPlaylists) {
            const option = document.createElement('option');
            option.value = playlist.id;
            option.textContent = `${playlist.name} · ${playlist.mediaType} · ${playlist.items.length} items`;
            playlistSelect.append(option);
        }
        playlistSelect.value = mediaPlaylists.some((entry) => entry.id === selectedId)
            ? selectedId
            : mediaPlaylists[0]?.id ?? '';
        const current = mediaPlaylists.find((entry) => entry.id === playlistSelect.value);
        playlistLoadButton.disabled = !socket.connected || !current?.items.length;
        playlistDeleteButton.disabled = !socket.connected || !current;
        playlistPreviewButton.disabled = !current?.items.length;
        playlistSaveButton.disabled = !socket.connected;
        if (!current && playlistDraft.length === 0) {
            playlistDraftElement.innerHTML =
                '<p class="dashboard-empty-state">Add media from the library to build a playlist.</p>';
            return;
        }
        playlistDraftElement.replaceChildren();
        const draft = current && playlistDraft.length === 0
            ? current.items
            : playlistDraft;
        for (const [index, entry] of draft.entries()) {
            const item = mediaLibrary.find((media) => media.id === entry.mediaId);
            const row = document.createElement('div');
            row.className = 'playlist-draft-item';
            const title = document.createElement('span');
            title.textContent = `${index + 1}. ${item?.filename ?? 'Missing media'} · ${
                entry.durationSeconds ?? item?.durationSeconds ?? 'default'
            }${item?.mediaType === 'image' ? ' sec' : ''}`;
            const controls = document.createElement('div');
            for (const [action, label] of [['up', '↑'], ['down', '↓'], ['remove', 'Remove']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'alignment-action';
                button.dataset.draftAction = action;
                button.dataset.draftIndex = String(index);
                button.textContent = label;
                controls.append(button);
            }
            row.append(title, controls);
            playlistDraftElement.append(row);
        }
        if (playlistNameInput.value === '' && current) {
            playlistNameInput.value = current.name;
            playlistTypeSelect.value = current.mediaType;
        }
    }

    function renderScheduleTargets() {
        const selected = scheduleTarget.value;
        scheduleTarget.replaceChildren();
        for (const item of mediaLibrary) {
            const option = document.createElement('option');
            option.value = `media:${item.id}`;
            option.textContent = `${item.filename} · ${item.mediaType}`;
            scheduleTarget.append(option);
        }
        for (const playlist of mediaPlaylists) {
            const option = document.createElement('option');
            option.value = `playlist:${playlist.id}`;
            option.textContent = `${playlist.name} · playlist`;
            scheduleTarget.append(option);
        }
        scheduleTarget.value = Array.from(scheduleTarget.options)
            .some((option) => option.value === selected)
            ? selected
            : scheduleTarget.options[0]?.value ?? '';
        scheduleList.replaceChildren();
        if (mediaSchedules.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'dashboard-empty-state';
            empty.textContent = 'No scheduled playback.';
            scheduleList.append(empty);
            return;
        }
        for (const schedule of mediaSchedules) {
            const row = document.createElement('div');
            row.className = 'schedule-list-item';
            const label = document.createElement('span');
            label.textContent = `${schedule.targetType} · ${
                new Date(schedule.startAt).toLocaleString()
            } to ${new Date(schedule.endAt).toLocaleString()} (${schedule.timeZone})`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'alignment-action is-danger';
            remove.dataset.scheduleDelete = schedule.id;
            remove.textContent = 'Delete';
            row.append(label, remove);
            scheduleList.append(row);
        }
    }

    function setPlaybackSnapshot(timeline) {
        if (!timeline || !['playing', 'paused', 'stopped'].includes(timeline.status)) {
            return;
        }
        currentPlayback = timeline;
        previewServerTimeOffset = Number.isFinite(timeline.serverNow)
            ? timeline.serverNow - Date.now()
            : 0;
        playbackStatus.textContent = timeline.status;
        const volumePercent = Math.round((Number.isFinite(timeline.volume)
            ? Math.min(1, Math.max(0, timeline.volume))
            : 0) * 100);
        if (volumePercent > 0) {
            lastNonzeroPlaybackVolume = volumePercent / 100;
        }
        playbackMuteButton.textContent = volumePercent > 0 ? 'Mute' : 'Unmute';
        playbackMuteButton.disabled = !socket.connected;
        if (document.activeElement !== playbackVolume) {
            playbackVolume.value = String(volumePercent);
            playbackVolumeValue.value = `${volumePercent}%`;
            playbackVolumeValue.textContent = `${volumePercent}%`;
        }
        playbackVolume.disabled = !socket.connected;
        const item = mediaLibrary.find((entry) => entry.id === timeline.mediaId);
        const playlist = mediaPlaylists.find((entry) => entry.id === timeline.playlistId);
        const playlistItem = playlist?.items[timeline.playlistIndex];
        const duration = playlistItem?.durationSeconds ?? item?.durationSeconds ?? 0;
        playbackSeek.max = String(duration);
        playbackSeek.disabled = !duration || !socket.connected;
        const position = expectedPlaybackPosition(timeline, Date.now());
        playbackSeek.value = String(Math.min(duration || position, position));
        playbackPosition.textContent = `${formatDuration(position)}${duration
            ? ` / ${formatDuration(duration)}` : ''}`;
        synchronizePublishedPreviewVideos();
        if (timeline.status === 'playing') {
            if (previewSyncTimer === null) {
                previewSyncTimer = setInterval(synchronizePublishedPreviewVideos, 200);
            }
        } else if (previewSyncTimer !== null) {
            clearInterval(previewSyncTimer);
            previewSyncTimer = null;
        }
    }

    function updateFullscreenButton() {
        controllerFullscreenButton.textContent = isFullscreen(controllerPreview)
            ? 'Exit fullscreen preview'
            : 'Fullscreen preview';
    }

    controllerFullscreenButton.addEventListener('click', async () => {
        try {
            if (!await toggleFullscreen(controllerPreview)) {
                setMediaStatus('Fullscreen is not supported by this browser.', true);
                return;
            }
            updateFullscreenButton();
        } catch (error) {
            console.error('Unable to toggle controller preview fullscreen:', error);
            setMediaStatus('Unable to open fullscreen preview on this browser.', true);
        }
    });
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

    function handleMediaSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.media)
            || !Array.isArray(snapshot.playlists) || !Array.isArray(snapshot.schedules)) {
            return;
        }
        mediaLibrary = snapshot.media;
        const currentMediaIds = new Set(mediaLibrary.map((item) => item.id));
        for (const [mediaId, thumbnail] of mediaThumbnails) {
            if (currentMediaIds.has(mediaId)) {
                continue;
            }
            if (thumbnail.tagName.toLowerCase() === 'video') {
                thumbnail.pause();
                thumbnail.removeAttribute('src');
                thumbnail.load();
            }
            mediaThumbnails.delete(mediaId);
        }
        mediaUploadHistory = Array.isArray(snapshot.uploadHistory)
            ? snapshot.uploadHistory
            : snapshot.media.map((item) => ({
                ...item,
                uploadStatus: 'uploaded',
                publishingStatus: item.id === snapshot.playback?.mediaId ? 'published' : 'saved'
            }));
        mediaPlaylists = snapshot.playlists;
        mediaSchedules = snapshot.schedules;
        if (snapshot.audioSettings) {
            audioSettings = createAudioSettings(snapshot.audioSettings);
            renderAudioControls();
        }
        currentMediaId = snapshot.playback?.mediaId ?? null;
        renderMediaLibrary();
        renderPlaylists();
        setPlaybackSnapshot(snapshot.playback);
        const content = snapshot.currentContent;
        const item = mediaLibrary.find((entry) => entry.id === currentMediaId);
        if (item && content) {
            setCurrentMedia(content, item);
        }
    }

    function setCurrentMedia(content, item) {
        const sourceUrl = item.mediaType === 'video' ? content.videoUrl : content.imageUrl;
        const currentImage = root.querySelector('[data-current-image]');
        if (typeof sourceUrl !== 'string') {
            return;
        }
        const mediaUrl = resolveParallaxMediaUrl(sourceUrl);
        currentMediaId = item.id;
        panoramaImageUrl = mediaUrl;
        panoramaMediaType = item.mediaType;
        let element = currentImage.querySelector('[data-current-media]');
        const tagName = item.mediaType === 'video' ? 'video' : 'img';
        const absoluteUrl = new URL(mediaUrl, window.location.href).href;
        if (!element || element.tagName.toLowerCase() !== tagName
            || element.dataset.sourceUrl !== absoluteUrl) {
            element = document.createElement(tagName);
            element.dataset.currentMedia = 'true';
            element.dataset.sourceUrl = absoluteUrl;
            currentImage.replaceChildren(element);
        }
        if (item.mediaType === 'video') {
            element.controls = false;
            element.muted = true;
            element.preload = 'auto';
            element.playsInline = true;
            element.addEventListener('loadedmetadata', synchronizePublishedPreviewVideos);
            element.addEventListener('loadeddata', synchronizePublishedPreviewVideos);
        } else {
            element.alt = `Currently published panorama: ${item.filename}`;
        }
        if (element.dataset.sourceUrl !== absoluteUrl) {
            element.dataset.sourceUrl = absoluteUrl;
            element.src = mediaUrl;
        } else if (!element.src) {
            element.src = mediaUrl;
        }
        if (!element.parentNode) {
            currentImage.append(element);
        }
        root.querySelector('[data-current-name]').textContent = item.filename;
        root.querySelector('[data-current-meta]').textContent =
            `${item.mediaType} · ${formatBytes(item.size)} · Published to displays`;
        renderPanoramaPreview();
        synchronizePublishedPreviewVideos();
    }

    function synchronizePublishedPreviewVideos() {
        if (panoramaMediaType !== 'video'
            || !currentPlayback
            || currentPlayback.mediaId !== currentMediaId) {
            return;
        }
        const serverNow = Date.now() + previewServerTimeOffset;
        const videos = [
            root.querySelector('[data-current-image] video[data-current-media]'),
            dashboardPreview.querySelector('video.panorama-preview-image')
        ];
        for (const video of videos) {
            if (!video) {
                continue;
            }
            const result = synchronizePreviewVideo(video, currentPlayback, serverNow);
            if (result && typeof result.then === 'function') {
                result.catch((error) => {
                    if (lastPreviewPlaybackError === currentPlayback.timelineId) {
                        return;
                    }
                    lastPreviewPlaybackError = currentPlayback.timelineId;
                    console.error('Unable to synchronize controller video preview:', error);
                    setMediaStatus('Video preview playback could not be synchronized.', true);
                });
            }
        }
        if (currentPlayback.status !== 'playing') {
            lastPreviewPlaybackError = null;
        }
    }

    function setDevices(devices) {
        markServerCommunication();
        registeredDevices = Array.isArray(devices) ? devices : [];
        if (visionSpatialPreview) {
            renderVisionObservations(visionObservationCache);
        }
        renderAudioControls();
        const connectedDevices = registeredDevices.filter((device) =>
            device.connected && device.enabled !== false);
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
            const enabled = displayLayout.screens[screen]?.enabled !== false;
            const connected = Boolean(device?.connected && enabled);
            const state = !enabled ? 'Disabled' : connected ? 'Connected' : device ? 'Disconnected' : 'Waiting';
            row.classList.toggle('is-connected', connected);
            row.querySelector('.screen-state span').textContent = state;
            row.classList.toggle('is-disconnected', enabled && Boolean(device) && !connected);
        }

        deviceAssignmentList.innerHTML = registeredDevices.length
            ? registeredDevices.map((device) => `
                <label class="device-assignment-row">
                    <span><strong>${escapeHtml(device.name || device.id)}</strong><small>${device.connected ? 'Connected' : 'Disconnected'}</small><small>${escapeHtml(device.id)}</small></span>
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

    function renderAudioControls() {
        audioModeSelect.value = audioSettings.mode;
        const selectedMaster = audioSettings.masterDeviceId ?? '';
        const options = [new Option('No master selected', '')];
        for (const device of registeredDevices) {
            options.push(new Option(
                `Screen ${device.screen ?? 'unassigned'} · ${device.id}${device.connected ? '' : ' · disconnected'}`,
                device.id
            ));
        }
        audioMasterSelect.replaceChildren(...options);
        audioMasterSelect.value = selectedMaster;
        audioMasterSelect.disabled = !controllerSessionReady || audioSettings.mode !== 'master';
        audioModeSelect.disabled = !controllerSessionReady;
        audioModeStatus.textContent = audioSettings.mode === 'master'
            ? audioSettings.masterDeviceId
                ? `Master Audio Mode: ${audioSettings.masterDeviceId} is the only phone allowed to output audio.`
                : 'Master Audio Mode is active. Select a phone to enable its output.'
            : 'All Devices Audio Mode is active. Each phone controls its own volume and mute state.';
        if (audioSettings.mode === 'all') {
            audioModeStatus.textContent += ' Audio on multiple phones can echo; lower device volumes or use headphones.';
        }
        if (socket.connected && !controllerSessionReady) {
            audioModeStatus.textContent =
                'Waiting for controller authorization from the Parallax server.';
        }
    }

    function saveAudioSettings() {
        if (!controllerSessionReady) {
            renderAudioControls();
            audioModeStatus.textContent =
                'Audio settings require the updated Parallax server. Restart the server and reconnect.';
            return;
        }
        const settings = createAudioSettings({
            mode: audioModeSelect.value,
            masterDeviceId: audioModeSelect.value === 'master'
                ? audioMasterSelect.value || null
                : null
        });
        socket.timeout(5000).emit('audio:settings', settings, (error, response) => {
            if (error || !response?.ok) {
                setMediaStatus(error
                    ? 'Audio settings were not acknowledged. Restart the Parallax server and reconnect.'
                    : response?.message || 'Unable to update audio settings.', true);
                renderAudioControls();
                return;
            }
            audioSettings = createAudioSettings(response.audioSettings);
            renderAudioControls();
            setMediaStatus(audioSettings.mode === 'master'
                ? 'Master Audio Mode updated.'
                : 'All Devices Audio Mode updated.');
        });
    }

    function renderVisionObservations(observations) {
        if (!visionObservations || !visionSpatialPreview) {
            return;
        }
        visionObservations.replaceChildren();
        visionSpatialPreview.replaceChildren();
        const observedByDevice = new Map((Array.isArray(observations) ? observations : [])
            .filter((observation) => observation?.deviceId)
            .map((observation) => [observation.deviceId, observation]));
        const renderedObservations = [...(Array.isArray(observations) ? observations : [])];
        for (const device of registeredDevices) {
            if (!observedByDevice.has(device.id)) {
                renderedObservations.push({
                    id: device.markerId ?? 0,
                    deviceId: device.id,
                    deviceName: device.name || device.id,
                    relativeX: 0.5,
                    relativeY: 0.5,
                    rotation: 0,
                    confidence: 0,
                    trackingState: 'missing'
                });
            }
        }
        for (const observation of renderedObservations) {
            const registered = registeredDevices.find((device) => device.id === observation.deviceId);
            const name = registered?.name || observation.deviceName || observation.deviceId || 'Unknown device';
            const row = document.createElement('div');
            row.className = 'vision-observation';
            row.innerHTML = `
                <strong>${escapeHtml(name)}</strong>
                <span>${escapeHtml(observation.deviceId || 'Unknown ID')}</span>
                <span>Marker ${escapeHtml(String(observation.id))}</span>
                <span>Relative ${Number(observation.relativeX ?? observation.x ?? 0).toFixed(3)}, ${Number(observation.relativeY ?? observation.y ?? 0).toFixed(3)}</span>
                <span>Rotation ${(Number(observation.rotation ?? 0) * 180 / Math.PI).toFixed(1)}°</span>
                <span>${escapeHtml(observation.trackingState || observation.status || 'tracked')} · ${Math.round(Number(observation.confidence ?? 0) * 100)}%</span>
                <span>Last detection: ${escapeHtml(observation.trackingState === 'missing'
                    ? 'Not observed'
                    : Number.isFinite(Number(observation.timestamp))
                        ? new Date(Number(observation.timestamp)).toLocaleTimeString()
                        : 'Unknown')}</span>
            `;
            visionObservations.append(row);

            const dot = document.createElement('span');
            const trackingState = observation.trackingState === 'lost' || observation.trackingState === 'missing'
                ? observation.trackingState
                : 'tracked';
            dot.className = `vision-spatial-point is-${trackingState}`;
            dot.style.left = `${Math.max(2, Math.min(98, Number(observation.relativeX ?? observation.x ?? 0) * 100))}%`;
            dot.style.top = `${Math.max(2, Math.min(98, Number(observation.relativeY ?? observation.y ?? 0) * 100))}%`;
            dot.title = `${name} · marker ${observation.id}`;
            dot.setAttribute('aria-label',
                `${registered?.screen ? `Screen ${registered.screen}` : name}, marker ${observation.id}, ${trackingState}`);
            const label = document.createElement('span');
            label.className = 'vision-spatial-label';
            label.textContent = registered?.screen ? `Screen ${registered.screen}` : name;
            dot.append(label);
            visionSpatialPreview.append(dot);
        }
        if (observations.length === 0) {
            visionObservations.innerHTML = '<p class="dashboard-empty-state">No tracked markers.</p>';
        }
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

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) {
            return '0:00';
        }
        const total = Math.floor(seconds);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const remainder = total % 60;
        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
            : `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) {
            return 'Unknown size';
        }
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        const units = ['KB', 'MB', 'GB'];
        let value = bytes / 1024;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
        }
        return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
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
            const playback = connectionStatus === 'connected' ? device?.playback : null;
            panel.querySelector('[data-diagnostic-playback-status]').textContent =
                playback?.status ?? (connectionStatus === 'disconnected'
                    ? 'Disconnected' : 'Unknown');
            panel.querySelector('[data-diagnostic-playback-position]').textContent =
                playback && Number.isFinite(playback.positionSeconds)
                    && Number.isFinite(playback.expectedPositionSeconds)
                    ? `${formatDuration(playback.positionSeconds)} / ${formatDuration(playback.expectedPositionSeconds)}`
                    : 'Unknown';
            panel.querySelector('[data-diagnostic-playback-drift]').textContent =
                playback && Number.isFinite(playback.driftSeconds)
                    ? `${(playback.driftSeconds * 1000).toFixed(0)} ms`
                    : 'Unknown';
            panel.querySelector('[data-diagnostic-ready-state]').textContent =
                playback && Number.isInteger(playback.readyState)
                    && Number.isInteger(playback.networkState)
                    ? `${playback.readyState} / ${playback.networkState}`
                    : 'Unknown';
            panel.querySelector('[data-diagnostic-buffering]').textContent =
                playback && typeof playback.bufferingState === 'string'
                    && Number.isFinite(playback.playbackRate)
                    ? `${playback.bufferingState} / ${playback.playbackRate.toFixed(2)}×`
                    : 'Unknown';
            panel.querySelector('[data-diagnostic-audio]').textContent =
                playback && typeof playback.muted === 'boolean'
                    && Number.isFinite(playback.volume)
                    ? `${playback.muted ? 'Muted' : 'Audible'} · ${Math.round(playback.volume * 100)}%`
                    : 'Unknown';
            panel.querySelector('[data-diagnostic-last-sync]').textContent =
                Number.isFinite(playback?.lastSuccessfulSynchronization)
                    ? new Date(playback.lastSuccessfulSynchronization).toLocaleTimeString()
                    : 'Unknown';
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
        if (Number.isInteger(screen) && displayLayout.screens[screen]?.enabled !== true) {
            setDashboardStatus(`Screen ${screen} is disabled. Enable it before assigning a device.`, true);
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
        const isVideo = /\.mp4$/i.test(file.name);
        const media = isVideo ? document.createElement('video') : new Image();
        const onReady = () => {
            if (selectedFile !== file) {
                return;
            }
            preview.replaceChildren(media);
            root.querySelector('[data-file-name]').textContent = file.name;
            if (isVideo) {
                selectedMediaDuration = Number.isFinite(media.duration)
                    && media.duration > 0 && media.duration <= 86_400
                    ? media.duration
                    : null;
                root.querySelector('[data-file-dimensions]').textContent =
                    `${media.videoWidth} × ${media.videoHeight} · ${
                        selectedMediaDuration ? formatDuration(selectedMediaDuration) : 'Duration unavailable'
                    }`;
                media.controls = true;
                media.muted = true;
                media.playsInline = true;
            } else {
                root.querySelector('[data-file-dimensions]').textContent =
                    `${media.naturalWidth} × ${media.naturalHeight}`;
            }
            fileDetails.hidden = false;
            publishButton.disabled = false;
            dropLabel.textContent = `${isVideo ? 'Video' : 'Image'} selected - drop another to replace`;
        };
        media.onload = isVideo ? null : onReady;
        media.onloadedmetadata = isVideo ? onReady : null;
        media.onerror = () => {
            if (selectedFile === file) {
                selectedFile = null;
                publishButton.disabled = true;
                publishButton.disabled = true;
                setPublishStatus(
                    `This file could not be decoded as a ${isVideo ? 'video' : 'image'}.`,
                    'is-error'
                );
            }
        };
        if (isVideo) {
            media.preload = 'metadata';
            media.src = previewUrl;
        } else {
            media.src = previewUrl;
        }
    }

    function selectFile(file) {
        if (!file) {
            return;
        }
        if (!ACCEPTED_EXTENSIONS.test(file.name)) {
            setPublishStatus('Choose a JPG, JPEG, PNG, WebP image, or MP4 video.', 'is-error');
            return;
        }
        const isVideo = /\.mp4$/i.test(file.name);
        const maxFileSize = isVideo ? MAX_VIDEO_FILE_SIZE : MAX_FILE_SIZE;
        if (file.size > maxFileSize) {
            setPublishStatus(
                `The selected ${isVideo ? 'video' : 'image'} exceeds the ${
                    isVideo ? '100 MB' : '15 MB'
                } limit.`,
                'is-error'
            );
            return;
        }

        selectedFile = file;
        selectedMediaDuration = null;
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
        const isVideo = /\.mp4$/i.test(fileToUpload.name);
        setPublishStatus(`Uploading ${isVideo ? 'video' : 'image'}...`);
        setUploadProgress(0);

        const formData = new FormData();
        formData.append('media', fileToUpload, fileToUpload.name);
        if (isVideo && selectedMediaDuration) {
            formData.append('durationSeconds', String(selectedMediaDuration));
        }
        uploadRequest = new XMLHttpRequest();
        uploadRequest.open('POST', `${getParallaxServerBaseUrl()}/api/media/upload`);
        if (controllerUploadToken) {
            uploadRequest.setRequestHeader('X-Parallax-Controller', controllerUploadToken);
        }
        uploadRequest.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                setUploadProgress(Math.round((event.loaded / event.total) * 100));
            }
        });
        uploadRequest.addEventListener('load', (event) => {
            const request = event.currentTarget;
            uploadRequest = null;
            publishButton.disabled = true;
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

            setUploadProgress(100, isVideo ? 'Uploaded' : 'Publishing');
            selectedFile = null;
            selectedMediaDuration = null;
            if (isVideo) {
                setPublishStatus(
                    `${result.filename} uploaded. Preview or publish it from the content library.`,
                    'is-success'
                );
                return;
            }
            socket.timeout(5000).emit('media:publish', {
                mediaId: result.id,
                transition: mediaTransition.value
            }, (publishError, published) => {
                if (publishError || !published?.ok) {
                    setPublishStatus(publishError
                        ? 'Image uploaded, but the server did not acknowledge publishing.'
                        : published?.message || 'Image uploaded, but publishing failed.', 'is-error');
                    return;
                }
                setPublishStatus(`Published ${result.filename} to the display wall.`, 'is-success');
            });
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

    function sendMediaCommand(eventName, payload, onSuccess) {
        socket.timeout(5000).emit(eventName, payload, (error, response) => {
            if (error || !response?.ok) {
                setMediaStatus(error
                    ? `The server did not acknowledge ${eventName}.`
                    : response?.message || `${eventName} failed.`, true);
                return;
            }
            setMediaStatus(`${eventName.replace(':', ' ')} complete.`);
            onSuccess?.(response);
        });
    }

    function addToPlaylistDraft(item) {
        const selected = mediaPlaylists.find((entry) => entry.id === playlistSelect.value);
        if (playlistDraft.length === 0 && selected) {
            playlistDraft = selected.items.map((entry) => ({ ...entry }));
        }
        const expectedType = playlistDraft.length
            ? mediaLibrary.find((entry) => entry.id === playlistDraft[0].mediaId)?.mediaType
            : selected?.mediaType ?? playlistTypeSelect.value;
        if (expectedType && expectedType !== item.mediaType) {
            setMediaStatus('A playlist can contain only one media type.', true);
            return;
        }
        playlistTypeSelect.value = item.mediaType;
        const duration = item.mediaType === 'image'
            ? Number(playlistDurationInput.value)
            : null;
        playlistDraft.push({
            mediaId: item.id,
            durationSeconds: Number.isFinite(duration) && duration >= 1 ? duration : null
        });
        renderPlaylists();
        setMediaStatus(`${item.filename} added to the playlist draft.`);
    }

    contentLibrary.addEventListener('click', (event) => {
        const button = event.target.closest('[data-media-action]');
        const row = button?.closest('[data-media-id]');
        const item = mediaLibrary.find((entry) => entry.id === row?.dataset.mediaId);
        if (!button || !item) {
            return;
        }
        const action = button.dataset.mediaAction;
        if (action === 'preview') {
            showMediaPreview(item);
            return;
        }
        if (action === 'add') {
            addToPlaylistDraft(item);
            return;
        }
        if (action === 'publish') {
            sendMediaCommand('media:publish', {
                mediaId: item.id,
                transition: mediaTransition.value
            }, () => {
                setMediaStatus(`${item.filename} published to the display wall.`);
            });
            return;
        }
        if (action === 'delete') {
            const isCurrent = item.id === currentMediaId;
            if (!window.confirm(isCurrent
                ? `Delete "${item.filename}"? It is currently published and will be removed from all displays.`
                : `Delete "${item.filename}" from the content library?`)) {
                return;
            }
            sendMediaCommand('media:delete', {
                mediaId: item.id,
                ...(isCurrent ? { confirmPublished: true } : {})
            }, (response) => handleMediaSnapshot(response.media));
        }
    });

    mediaSearch.addEventListener('input', renderMediaLibrary);
    mediaFilter.addEventListener('change', renderMediaLibrary);

    playlistNewButton.addEventListener('click', () => {
        playlistSelect.value = '';
        playlistNameInput.value = '';
        playlistDraft = [];
        playlistLoopInput.checked = true;
        playlistShuffleInput.checked = false;
        renderPlaylists();
    });

    playlistSelect.addEventListener('change', () => {
        const playlist = mediaPlaylists.find((entry) => entry.id === playlistSelect.value);
        playlistDraft = playlist?.items.map((entry) => ({ ...entry })) ?? [];
        playlistNameInput.value = playlist?.name ?? '';
        playlistTypeSelect.value = playlist?.mediaType ?? 'image';
        playlistLoopInput.checked = playlist?.loop ?? true;
        playlistShuffleInput.checked = playlist?.shuffle ?? false;
        renderPlaylists();
    });

    playlistDraftElement.addEventListener('click', (event) => {
        const button = event.target.closest('[data-draft-action]');
        if (!button) {
            return;
        }
        const index = Number(button.dataset.draftIndex);
        const action = button.dataset.draftAction;
        if (!Number.isInteger(index) || index < 0 || index >= playlistDraft.length) {
            return;
        }
        if (action === 'remove') {
            playlistDraft.splice(index, 1);
        } else {
            const target = action === 'up' ? index - 1 : index + 1;
            if (target >= 0 && target < playlistDraft.length) {
                [playlistDraft[index], playlistDraft[target]] =
                    [playlistDraft[target], playlistDraft[index]];
            }
        }
        renderPlaylists();
    });

    playlistSaveButton.addEventListener('click', () => {
        const name = playlistNameInput.value.trim();
        const mediaType = playlistTypeSelect.value;
        if (!name || playlistDraft.some((entry) =>
            mediaLibrary.find((item) => item.id === entry.mediaId)?.mediaType !== mediaType)) {
            setMediaStatus('Enter a playlist name and use media of one type.', true);
            return;
        }
        const selected = mediaPlaylists.find((entry) => entry.id === playlistSelect.value);
        const settings = {
            name,
            mediaType,
            items: playlistDraft.map((entry) => ({ ...entry })),
            loop: playlistLoopInput.checked,
            shuffle: playlistShuffleInput.checked,
            transition: mediaTransition.value
        };
        const eventName = selected && selected.name === name ? 'playlist:update' : 'playlist:create';
        const payload = eventName === 'playlist:update'
            ? { ...settings, id: selected.id }
            : settings;
        sendMediaCommand(eventName, payload, (response) => {
            mediaPlaylists = response.playlists;
            if (response.playlist) {
                playlistSelect.value = response.playlist.id;
                playlistDraft = response.playlist.items.map((entry) => ({ ...entry }));
            }
            renderPlaylists();
            renderScheduleTargets();
        });
    });

    playlistLoadButton.addEventListener('click', () => {
        sendMediaCommand('playlist:load', { id: playlistSelect.value }, () => {
            setMediaStatus('Playlist loaded. Displays will advance together.');
        });
    });

    playlistPreviewButton.addEventListener('click', () => {
        const playlist = mediaPlaylists.find((entry) => entry.id === playlistSelect.value);
        const item = mediaLibrary.find((entry) => entry.id === playlist?.items[0]?.mediaId);
        if (item) {
            showMediaPreview(item);
        }
    });

    playlistDeleteButton.addEventListener('click', () => {
        const playlist = mediaPlaylists.find((entry) => entry.id === playlistSelect.value);
        if (!playlist || !window.confirm(`Delete playlist "${playlist.name}"?`)) {
            return;
        }
        sendMediaCommand('playlist:delete', { id: playlist.id }, (response) => {
            mediaPlaylists = response.playlists;
            playlistDraft = [];
            renderPlaylists();
            renderScheduleTargets();
        });
    });

    for (const [selector, eventName] of [
        ['[data-playback-play]', 'playback:play'],
        ['[data-playback-pause]', 'playback:pause'],
        ['[data-playback-resume]', 'playback:resume'],
        ['[data-playback-stop]', 'playback:stop'],
        ['[data-playback-next]', 'playback:next'],
        ['[data-playback-previous]', 'playback:previous']
    ]) {
        root.querySelector(selector).addEventListener('click', () => {
            sendMediaCommand(eventName, {}, (response) => setPlaybackSnapshot(response.playback));
        });
    }
    playbackSeek.addEventListener('change', () => {
        sendMediaCommand('playback:seek', {
            positionSeconds: Number(playbackSeek.value)
        }, (response) => setPlaybackSnapshot(response.playback));
    });
    playbackVolume.addEventListener('input', () => {
        playbackVolumeValue.value = `${playbackVolume.value}%`;
        playbackVolumeValue.textContent = `${playbackVolume.value}%`;
        clearTimeout(playbackVolumeTimer);
        playbackVolumeTimer = setTimeout(() => {
            playbackVolumeTimer = null;
            sendMediaCommand('playback:volume', {
                volume: Number(playbackVolume.value) / 100
            }, (response) => setPlaybackSnapshot(response.playback));
        }, 120);
    });
    playbackVolume.addEventListener('change', () => {
        clearTimeout(playbackVolumeTimer);
        playbackVolumeTimer = null;
        sendMediaCommand('playback:volume', {
            volume: Number(playbackVolume.value) / 100
        }, (response) => setPlaybackSnapshot(response.playback));
    });
    playbackMuteButton.addEventListener('click', () => {
        const currentVolume = Number(playbackVolume.value) / 100;
        const nextVolume = currentVolume > 0 ? 0 : lastNonzeroPlaybackVolume;
        playbackVolume.value = String(Math.round(nextVolume * 100));
        playbackVolumeValue.value = `${playbackVolume.value}%`;
        playbackVolumeValue.textContent = `${playbackVolume.value}%`;
        sendMediaCommand('playback:volume', { volume: nextVolume }, (response) => {
            setPlaybackSnapshot(response.playback);
        });
    });
    audioModeSelect.addEventListener('change', () => {
        audioMasterSelect.disabled = audioModeSelect.value !== 'master' || !socket.connected;
        saveAudioSettings();
    });
    audioMasterSelect.addEventListener('change', saveAudioSettings);

    scheduleTimezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    root.querySelector('[data-schedule-create]').addEventListener('click', () => {
        const [targetType, targetId] = scheduleTarget.value.split(':');
        const startDate = new Date(scheduleStart.value);
        const endDate = new Date(scheduleEnd.value);
        if (!targetId || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            setMediaStatus('Choose a target and valid start/end date and time.', true);
            return;
        }
        sendMediaCommand('schedule:create', {
            targetType,
            targetId,
            startAt: startDate.toISOString(),
            endAt: endDate.toISOString(),
            timeZone: scheduleTimezone.value,
            enabled: true
        }, (response) => {
            mediaSchedules = response.schedules;
            renderScheduleTargets();
        });
    });

    scheduleList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-schedule-delete]');
        if (!button || !window.confirm('Delete this playback schedule?')) {
            return;
        }
        sendMediaCommand('schedule:delete', {
            id: button.dataset.scheduleDelete
        }, (response) => {
            mediaSchedules = response.schedules;
            renderScheduleTargets();
        });
    });

    function setVisionStatus(message) {
        visionStatusNode.textContent = message;
        if (visionSessionStatus) {
            visionSessionStatus.textContent = message;
        }
    }

    function buildVisionCameraUrl(token, interfaces = []) {
        const browserOrigin = window.location?.origin;
        const isLoopbackHostname = (hostname) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);

        const fallbackOrigins = [];
        if (browserOrigin) {
            try {
                const browserUrl = new URL(browserOrigin);
                const isReachableOrigin = !isLoopbackHostname(browserUrl.hostname)
                    && (browserUrl.protocol === 'https:'
                        || !browserUrl.port
                        || /^517\d+$/.test(browserUrl.port)
                        || /^417\d+$/.test(browserUrl.port));
                if (isReachableOrigin) {
                    fallbackOrigins.push(browserOrigin);
                }
            } catch {
                // Ignore malformed origins.
            }
        }

        for (const entry of interfaces) {
            if (entry && typeof entry.address === 'string' && entry.address.trim()) {
                try {
                    const origin = new URL(browserOrigin || 'http://localhost:5173');
                    origin.hostname = entry.address;
                    origin.port = window.location.port || origin.port;
                    const candidate = origin.toString();
                    if (!fallbackOrigins.includes(candidate)) {
                        fallbackOrigins.push(candidate);
                    }
                } catch {
                    // Ignore invalid interface addresses.
                }
            }
        }

        const selectedOrigin = fallbackOrigins[0] ?? 'http://localhost:5173';
        const cameraUrl = new URL('/vision', selectedOrigin);
        cameraUrl.searchParams.set('vision', token);
        return cameraUrl;
    }

    async function showVisionSessionQr(token, interfaces = []) {
        const cameraUrl = buildVisionCameraUrl(token, interfaces);

        try {
            const qrDataUrl = await QRCode.toDataURL(cameraUrl.toString(), {
                width: 280,
                margin: 2,
                errorCorrectionLevel: 'H'
            });

            visionQr.src = qrDataUrl;
            visionQr.hidden = false;
            visionPlaceholder.hidden = true;
            visionUrlInput.value = cameraUrl.toString();
            visionCopyButton.disabled = false;
            visionSessionStatus.textContent = 'QR ready. Scan with your smartphone.';
            if (visionDialog) {
                visionDialog.showModal();
            }
        } catch (error) {
            console.error('Unable to generate the vision QR code:', error);
            visionPlaceholder.hidden = false;
            visionPlaceholder.textContent = 'Could not generate the camera QR code. Refresh and try again.';
            visionSessionStatus.textContent = 'QR generation failed.';
        }
    }

    visionConnectButton.addEventListener('click', () => {
        if (!socket.connected) {
            setVisionStatus('Controller is not connected to the server.');
            return;
        }
        socket.timeout(5000).emit('vision:camera:create', null, (error, response) => {
            if (error || !response?.ok) {
                setVisionStatus(error ? 'The server did not acknowledge the vision camera request.' : response?.message || 'Unable to create a vision camera session.');
                return;
            }
            setVisionStatus('Vision camera session ready. Scan the QR code below.');
            showVisionSessionQr(response.token, response.interfaces ?? []).catch((failure) => {
                console.error('Vision QR setup failed:', failure);
                setVisionStatus('Vision camera session was created but the QR code could not be rendered.');
            });
        });
    });

    visionCopyButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(visionUrlInput.value);
            visionSessionStatus.textContent = 'Vision URL copied to clipboard.';
        } catch (error) {
            console.error('Unable to copy the vision camera URL:', error);
            visionSessionStatus.textContent = 'Could not copy the URL. Copy it manually.';
        }
    });

    visionCloseButton.addEventListener('click', () => {
        visionDialog.close();
    });
    visionDialog.addEventListener('click', (event) => {
        if (event.target === visionDialog) {
            visionDialog.close();
        }
    });

    socket.on('connect', () => {
        root.querySelector('[data-controller-connection]').classList.add('is-online');
        root.querySelector('[data-controller-connection-label]').textContent = 'Display system connected';
        root.querySelector('[data-diagnostics-socket]').textContent = 'Connected';
        calibrationButton.disabled = !socket.connected;
        screenConfigSaveButton.disabled = false;
        assignmentModeSelect.disabled = false;
        screenCountSelect.disabled = false;
        addDeviceButton.disabled = false;
        visionConnectButton.disabled = false;
        playbackVolume.disabled = false;
        playbackMuteButton.disabled = false;
        renderAudioControls();
        scheduleTimezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        setDevices(registeredDevices);
        socket.timeout(5000).emit('controller:register', (error, result) => {
            controllerSessionReady = !error && result?.ok === true
                && result.capabilities?.audioSettings === true;
            controllerUploadToken = !error && result?.ok ? result.uploadToken : null;
            publishButton.disabled = !selectedFile || !controllerUploadToken;
            renderAudioControls();
            if (!error && result?.ok && !controllerSessionReady) {
                audioModeStatus.textContent =
                    'Audio settings are unsupported by the running server. Restart it to enable audio modes.';
            } else if (error) {
                audioModeStatus.textContent =
                    'Controller authorization was not acknowledged. Check the server and reconnect.';
            }
        });
    });
    socket.on('disconnect', () => {
        controllerSessionReady = false;
        controllerUploadToken = null;
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
        visionConnectButton.disabled = true;
        playbackVolume.disabled = true;
        playbackMuteButton.disabled = true;
        publishButton.disabled = true;
        playlistSaveButton.disabled = true;
        playlistLoadButton.disabled = true;
        playlistDeleteButton.disabled = true;
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
    socket.on('vision:camera:status', (event) => {
        if (!event?.connected) {
            setVisionStatus('Vision camera disconnected.');
            return;
        }
        setVisionStatus(`Vision camera connected (${event.status || 'tracking'}).`);
    });
    socket.on('vision:camera:update', (payload) => {
        const markers = Array.isArray(payload?.markers) ? payload.markers : [];
        visionObservationCache = markers;
        if (markers.length === 0) {
            renderVisionObservations([]);
            setVisionStatus('Vision camera is connected but waiting for markers.');
            return;
        }
        renderVisionObservations(markers);
        const deviceSummary = markers.map((marker) =>
            marker.deviceName || marker.deviceId || `marker ${marker.id}`).join(', ');
        setVisionStatus(`Markers detected: ${deviceSummary}`);
    });
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
    socket.on('layout-presets:current', (state) => {
        markServerCommunication();
        setLayoutPresets(state?.presets);
    });
    socket.on('media:current', (snapshot) => {
        markServerCommunication();
        handleMediaSnapshot(snapshot);
    });
    socket.on('playback:current', setPlaybackSnapshot);
    socket.on('audio:settings', (settings) => {
        audioSettings = createAudioSettings(settings);
        renderAudioControls();
    });
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
        clearTimeout(playbackVolumeTimer);
        if (previewSyncTimer !== null) {
            clearInterval(previewSyncTimer);
            previewSyncTimer = null;
        }
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
