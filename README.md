# PARALLAX

PARALLAX publishes one panoramic image across 2–12 connected display devices and provides a browser-based controller for uploading content, managing screen assignments, and adjusting alignment.

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

Open the display page on each phone. In the controller's **Connected displays** section, choose a screen count from 2 to 12 and either automatic or manual assignment. Automatic mode assigns free screens as devices register. Manual mode leaves new phones unassigned until you select a screen in **Registered devices**. Each configured screen can be aligned independently. Supported uploads are JPG, PNG, and WebP files up to 15 MB.

To onboard a phone, open **Add Device** in the controller, choose the laptop network interface if prompted, and scan the QR code. The laptop and phone must be on the same LAN. Start Vite with `npm run dev -- --host 0.0.0.0` so phones can reach the displayed URL. The QR pairing code expires after five minutes and is single-use; use **Refresh QR** to create a replacement. A successful scan opens the display page and follows the selected automatic or manual screen-assignment mode.

Calibration state, screen count, assignment mode, device-to-screen assignments, alignments, and named calibration presets are stored in `server/data/calibration.json` and restored when the backend starts. Existing two-screen settings are migrated without changing their values. Alignment values for screens outside the active count are retained when the count is reduced. A reduction is rejected if it would invalidate an existing device assignment; reassign or unassign those devices first. The backend creates the file when missing, repairs invalid or corrupted data, and serializes atomic temporary-file writes.

The controller's calibration section includes the built-in **Default** preset, save/load/delete controls for custom presets (names are limited to 32 characters and must be unique), individual screen resets, a reset-all action, and a fine-adjustment toggle. Fine mode changes slider increments to 0.1 px and 0.001× without snapping current values. Preset deletion asks for confirmation and does not change current alignment.

The **Diagnostics** section displays backend/socket connectivity, each screen's connection and reported display state, last device activity, current content status, and whether each connected phone has acknowledged the latest alignment revision. Status timestamps represent observed server/device activity, not a measured heartbeat.

The backend also uses Socket.IO events `screen-config:set`, `screen-config:current`, `screen-config:update`, `device:assign-screen`, `device:assignment-update`, and `device:unassigned` for screen configuration and assignment. QR onboarding uses `pairing:create`, `pairing:created`, `pairing:join`, `pairing:result`, `pairing:expired`, and `pairing:device-joined`. Pairing sessions use cryptographically random, expiring, single-use tokens and do not grant display devices controller registration. Preset, pairing-session creation, and screen-configuration modifications are restricted to registered controllers; phones report display state and alignment receipt without polling.

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
