# PARALLAX

PARALLAX publishes an image to two connected display devices and provides a browser-based controller for uploading content and adjusting screen alignment.

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

Open the display page on up to two devices. Once they connect, use the controller to upload and publish an image, enable calibration, or adjust each screen's alignment. Supported uploads are JPG, PNG, and WebP files up to 15 MB.

Calibration enabled state and each screen's alignment are stored in `server/data/calibration.json` and restored when the backend starts. The backend creates this file with default settings when it is missing; invalid or corrupted settings are logged and replaced with safe defaults.

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
