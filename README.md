Smart Attendance — Scanner setup

What this provides

- A small Node WebSocket bridge (`mfs-bridge.js`) that reads newline-delimited tokens from a serial port (typical MFS110 behavior when drivers expose a virtual COM port) and broadcasts them to connected browsers on `ws://localhost:4123`.
- Browser-side `scanner-bridge.js` that can connect to WebSerial (when available), keyboard-wedge, or to the local WebSocket bridge.
- Admin UI helpers in `admin.html`/`admin.js` that let you capture and save biometric tokens to the server database.

Quick start (Windows)

1. Install dependencies

```bash
cd "d:/6A22/minor project/minor project"
npm install
```

2. Plug in the MFS110 and install vendor drivers

- If the scanner shipped with a driver or SDK, install it now.
- Open Windows Device Manager and check for a COM port under "Ports (COM & LPT)" or an entry under "Biometric devices".
- If a COM port appears (e.g. COM3), note it.

WebHID support

- If your scanner appears as a USB device but not a COM port (e.g. Device Manager shows `Mantra_MFS110`), the bridge can try to communicate directly from the browser using WebHID. Modern Chrome/Edge support WebHID but will prompt for permission.
- When using the admin UI, the Connect button will now try these in order: local WebSocket bridge → WebHID (vendor filter) → WebSerial → keyboard-capture.
- If WebHID is used, the browser will show a device picker. Allow the device and place a finger to capture tokens.

3. Run the local bridge

- If a COM port was auto-detected, just run:

```bash
npm run mfs-bridge
```

- If the bridge can't auto-detect, list of available ports will be printed. Start the bridge specifying the port:

```bash
SERIAL_PORT=COM3 npm run mfs-bridge
```
(Use the appropriate syntax for your shell; on Windows CMD use `set SERIAL_PORT=COM3 && npm run mfs-bridge`.)

4. Open the web UI

- Start the app server if not already running:

```bash
npm start
```

- Open the admin UI: http://localhost:3000/classic/admin.html
- Click "Connect Scanner" — the page will try `ws://localhost:4123` first (local bridge) and fall back to WebSerial.
- Click "Capture Fingerprint" and then place a finger on the scanner. The token will populate the form.
- Optionally enable "Auto-save after capture" and provide the student roll number; the capture will be sent to `/api/biometrics` automatically.

Troubleshooting

- Browser shows "No compatible devices found" for WebSerial: this means the device isn't exposed as a serial port. Install the vendor drivers.
- Bridge lists no ports: the scanner driver isn't present or the device is in a different mode. Check Device Manager and vendor docs.
- Device doesn't emit tokens: some scanners require switching to "keyboard-wedge" mode or using vendor SDK. If SDK-only, provide SDK and I can add SDK-based bridge code.

Next steps

- If your scanner doesn't show as COM and you have the Mantra SDK/DLL, I can add a Node bridge using the SDK to capture templates and fingerprint IDs.
- If you prefer browser-only access and the device supports WebHID/WebUSB, I can add a WebHID fallback (requires VID/PID).

If you want, tell me which device entry you see in Device Manager (copy the exact name or COM port) and I'll tailor the bridge command for you.
