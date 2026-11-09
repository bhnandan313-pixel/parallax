# PARALLAX

PARALLAX publishes panoramic images and MP4 videos across 2–12 connected display devices and provides a browser-based controller for managing content, playback, screen assignments, and alignment.

## Requirements

- Node.js 20 or newer
- npm (included with Node.js)

## Setup

From the repository root, install the project dependencies:

```powershell
cd parallax
npm ci
```

## Run locally

Start the backend and frontend in separate terminals. Run both commands from the `parallax` project directory.

Terminal 1 — backend:

```powershell
npm run server
```

The backend listens on port `3001`. To check that it is running, open <http://localhost:3001/>.

If `npm run server` reports `EADDRINUSE` for port `3001`, another process is already using that port. If <http://localhost:3001/> shows `PARALLAX SERVER ONLINE`, the backend is already running; keep using it instead of starting another instance.

To stop the backend, press `Ctrl+C` in the terminal where it is running. Then start it again with `npm run server`.

If that terminal is closed, find the process ID (PID) listening on port `3001` in PowerShell:

```powershell
netstat -ano -p tcp | findstr :3001
```

In the `LISTENING` row, the last column is the PID. Stop that specific process, then start the backend again from the project directory:

```powershell
Stop-Process -Id <PID>
npm run server
```

Terminal 2 — frontend:

```powershell
npm run dev
```

Open the Vite URL printed in the terminal (normally <http://localhost:5173/>).

- Display page: <http://localhost:5173/>
- Controller: <http://localhost:5173/controller>

Open the display page on each phone. In the controller's **Connected displays** section, choose a screen count from 2 to 12 and either automatic or manual assignment. Automatic mode assigns free screens as devices register. Manual mode leaves new phones unassigned until you select a screen in **Registered devices**. Each configured screen can be aligned independently. The **Media management** section accepts JPG, PNG, and WebP images up to 15 MB and MP4 videos up to 100 MB. Uploaded media is previewed before publishing; the library also supports filtering, playlists, playback controls, a synchronized master volume slider, **Master Audio Mode** (one selected phone), **All Devices Audio Mode** (independent phone volume), and scheduled playback. Phone audio begins muted; use its on-screen audio control to enable it after playback begins.

Video is stored once in `server/uploads`; the backend sends the same media URL and authoritative playback timeline to every assigned display. Screen Fill calculates one fit for the combined wall, then renders each display from that shared transform; **Cover** is the default, with **Contain**, explicitly distorted **Stretch**, and the existing calibrated **Manual** mode also available. Disabling Screen Fill restores the existing per-screen crop and alignment behavior. Settings are persisted in `server/data/calibration.json`. The Vision Camera currently reports marker angle in its own 2D image plane; it does not provide reliable 3D display orientation, so automatic wall rotation is unavailable and is not inferred from that angle. Per-screen orientation and rotation controls remain available for manual configuration. The next playlist item's metadata is preloaded by connected displays before the transition, while full video buffering is deferred until activation. The player reports browser-observed readiness, network state, buffering, playback position, and audio state. Drift under 100 ms is ignored, moderate drift is corrected with a small playback-rate adjustment, and larger drift uses cooldown-limited seeking. Recovery preserves the shared timeline and does not reload the media. Playback synchronization is best-effort, not frame-accurate: browser decoding, media buffering, device clock estimation, and network latency can cause visible differences. Transitions use a shared scheduled start but animation timing can also vary by browser/device. Validate playback and transitions on the actual Android devices and network before relying on them operationally.

The upload path validates that a file is an MP4 container; it does not inspect or transcode its video/audio codecs. Android Chrome support depends on the device and browser build. For broad compatibility, encode MP4 with H.264/AVC video (8-bit 4:2:0, commonly `yuv420p`) and AAC-LC audio, and place the MP4 `moov` metadata at the beginning (`faststart`). HEVC/H.265, AV1, unusual H.264 profiles/levels, and unsupported audio codecs may not play on a given phone even when the file has an `.mp4` extension. Verify a file on every target device before publishing it.

Media metadata, playlists, playback state, upload history, and schedules are atomically persisted in `server/data/media.json`; calibration and display-layout settings remain in `server/data/calibration.json`. Schedules use ISO timestamps as the authoritative time and retain the selected time zone for display. The backend evaluates schedules and playlist advancement while running and restores active content/timelines after restart. A scheduled item that began and ended entirely while the backend was offline is not replayed after restart.

Media and playback use Socket.IO events `media:publish`, `media:current`, `media:preload`, `media:delete`, `playback:play`, `playback:pause`, `playback:resume`, `playback:stop`, `playback:seek`, `playback:volume`, `playback:sync`, `playback:current`, `playback:drift`, `audio:settings`, `playlist:create`, `playlist:update`, `playlist:delete`, `playlist:load`, `schedule:create`, `schedule:update`, and `schedule:delete`. Only registered controllers may change global playback or audio-mode settings. A display can report only its own playback diagnostics. Uploads and modifying Socket.IO requests require a registered controller session; the upload token is ephemeral and revoked when that controller disconnects.

To onboard a phone, open **Add Device** in the controller, choose the laptop network interface if prompted, and scan the QR code. The laptop and phone must be on the same LAN. Start Vite with `npm run dev -- --host 0.0.0.0` so phones can reach the displayed URL. The QR pairing code expires after five minutes and is single-use; use **Refresh QR** to create a replacement. A successful scan opens the display page and follows the selected automatic or manual screen-assignment mode.

Calibration state, screen count, assignment mode, device-to-screen assignments, alignments, and named calibration presets are stored in `server/data/calibration.json` and restored when the backend starts. Existing two-screen settings are migrated without changing their values. Alignment values for screens outside the active count are retained when the count is reduced. A reduction is rejected if it would invalidate an existing device assignment; reassign or unassign those devices first. The backend creates the file when missing, repairs invalid or corrupted data, and serializes atomic temporary-file writes.

The controller's calibration section includes the built-in **Default** preset, save/load/delete controls for custom presets (names are limited to 32 characters and must be unique), individual screen resets, a reset-all action, and a fine-adjustment toggle. Fine mode changes slider increments to 0.1 px and 0.001× without snapping current values. Preset deletion asks for confirmation and does not change current alignment.

The **Diagnostics** section displays backend/socket connectivity, each screen's connection and reported display state, last device activity, current content status, and whether each connected phone has acknowledged the latest alignment revision. Status timestamps represent observed server/device activity, not a measured heartbeat.

The controller's **Visual panorama dashboard** shows screens in panoramic order, a segmented preview of the published image, alignment values, connection and delivery status, and device assignments. Drag a device card onto a screen or use the assignment menus on touch devices. Moving a device onto an occupied screen requires confirmation and performs a safe swap; assigning an unassigned device to an occupied screen is rejected rather than removing the current assignment. Use **Identify** to show the selected phone's screen number briefly. Device names are shown only when the system has name data; currently devices do not report a separate name. Calibration grid status reflects the server's current setting, while alignment receipt is shown only when reported by a phone.

The **Display layout** controls configure horizontal, vertical, grid, or custom screen arrangements. Grid rows and columns determine a shared wall coordinate system; each screen occupies one cell and takes its image crop from the corresponding normalized region of the panorama. In custom layouts, empty cells are gaps: their panorama regions are not shown on any device. Screen rotation (0°, 90°, 180°, or 270°) is applied to the cropped canvas image, not with CSS transforms. Orientation can follow the device/browser or be overridden as portrait or landscape. Disabled screens retain their device assignment and calibration, but are reported as disabled rather than online. Layout presets store the screen count and geometry separately from calibration presets.

The backend stores the active layout and layout presets in `server/data/calibration.json`, alongside the existing calibration and assignment data. Older configuration files without layout fields are migrated to a default horizontal layout; device assignments and calibration settings are preserved.

The backend uses Socket.IO events `screen-config:set`, `screen-config:current`, `screen-config:update`, `devices:update`, `device:assign-screen`, `device:assignment-update`, and `device:unassigned` for screen configuration and live assignment snapshots. Display layouts use `layout:set`, `layout:reset`, and `layout:update`; reset uses the server's current screen count and preserves calibration, assignments, and saved presets. Individual position changes use `screen:configure`, `screen:enable`, and `screen:disable`; layout presets use `layout-presets:save`, `layout-presets:load`, and `layout-presets:delete`. A safe swap includes the current screen owner's ID in `device:assign-screen`; `device:identify` is restricted to registered controllers and targets only the selected connected display. QR onboarding uses `pairing:create`, `pairing:created`, `pairing:join`, `pairing:result`, `pairing:expired`, and `pairing:device-joined`. Pairing sessions use cryptographically random, expiring, single-use tokens and do not grant display devices controller registration. Configuration modifications, assignment, and identify requests are restricted to registered controllers; phones report display state and alignment receipt without polling.

## Use devices on the same network

To access the frontend from phones or other devices on your local network, start Vite with a network host in Terminal 2:

```powershell
npm run dev -- --host 0.0.0.0
```

Find the computer's local network IP address, then open `http://<computer-ip>:5173/` on each display and `http://<computer-ip>:5173/controller` on the controller device. Keep the backend running on port `3001`; devices use the hostname in the page URL to connect to it. Allow network access to ports `5173` and `3001` in the computer's firewall if prompted.

## Tests and production build

Run the test suite:

```powershell
npm test
```

Create a production frontend build:

```powershell
npm run build
```

To serve the generated frontend build locally, start the backend separately and run:

```powershell
npm run preview
```
