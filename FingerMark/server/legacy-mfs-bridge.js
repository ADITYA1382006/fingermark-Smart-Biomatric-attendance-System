// Simple local bridge: read serial port lines and broadcast them over WebSocket
// Usage: npm run mfs-bridge

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const WebSocket = require('ws');

const WS_PORT = process.env.WS_PORT || 4123;

const VENDOR_ID = process.env.VID ? parseInt(process.env.VID, 16) : 0x2C0F;
const PRODUCT_ID = process.env.PID ? parseInt(process.env.PID, 16) : 0x1204;

async function findPort() {
    const ports = await SerialPort.list();
    // try to find by manufacturer hints for fingerprint devices, otherwise fallback to first COM-like port
    let p = ports.find(p => /mantra|mfs|finger|fprint|validity|zkteco/i.test((p.manufacturer || '') + (p.vendorId || '') + (p.productId || '') + (p.path || '')));
    if (!p && ports.length) p = ports[0];
    return p ? p.path : null;
}

async function start() {
    const portPath = process.env.SERIAL_PORT || await findPort();
    if (!portPath) {
        console.error('No serial port auto-detected. Attempting HID bridge fallback...');
        // first, show available serial ports to help user
        const ports = await SerialPort.list();
        if (ports && ports.length) {
            console.error('Available serial ports:');
            ports.forEach(p => console.error(`  ${p.path} - ${p.manufacturer || p.productId || 'unknown'}`));
        } else {
            console.error('No serial ports listed.');
        }

        // Try node-hid if available
        try {
            const HID = require('node-hid');
            const devices = HID.devices();
            console.log('HID devices:', devices);

            let found = devices.find(d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
            if (!found) {
                // Fallback: many MFS110 scanners share the same VID but have varying PIDs
                found = devices.find(d => d.vendorId === VENDOR_ID);
                if (found) {
                    console.log(`Found HID device by VID: ${found.product} (vid=0x${found.vendorId.toString(16)}, pid=0x${found.productId ? found.productId.toString(16) : 'unknown'})`);
                }
            }

            if (found) {
                startHIDBridge(found.path || found.product || `${found.vendorId}:${found.productId}`);
                return;
            } else {
                console.error('No matching HID device found. Enumerated devices logged above.');
            }
        } catch (hidErr) {
            console.error('node-hid not available or failed to load. Install with `npm install` to enable HID bridge.');
        }

        console.error('\nIf you know the COM port, set SERIAL_PORT environment variable, e.g.:');
        console.error('  SERIAL_PORT=COM3 npm run mfs-bridge');
        process.exit(1);
    }

    console.log('Opening serial port:', portPath);
    const port = new SerialPort({ path: portPath, baudRate: 9600, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    port.open((err) => {
        if (err) {
            console.error('Failed to open port:', err.message);
            process.exit(1);
        }
        console.log('Serial port opened. Waiting for data...');
    });

    const wss = new WebSocket.Server({ port: WS_PORT });

    wss.on('listening', () => console.log(`WebSocket bridge listening on ws://localhost:${WS_PORT}`));

    parser.on('data', (line) => {
        const token = ('' + line).trim();
        if (!token) return;
        console.log('Serial ->', token);
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(token);
            }
        });
    });

    wss.on('connection', (ws) => {
        console.log('Client connected to bridge.');
        ws.on('close', () => console.log('Client disconnected.'));
    });
}

function startHIDBridge(identifier) {
    // identifier may be a path or string; open via node-hid by vid/pid
    const HID = require('node-hid');
    console.log('Starting node-hid bridge for VID/PID', `0x${VENDOR_ID.toString(16)}`, `0x${PRODUCT_ID.toString(16)}`);
    let device;
    try {
        device = new HID.HID(VENDOR_ID, PRODUCT_ID);
    } catch (err) {
        console.error('Failed to open HID device:', err && err.message ? err.message : err);
        process.exit(1);
    }

    const wss = new WebSocket.Server({ port: WS_PORT });
    wss.on('listening', () => console.log(`WebSocket bridge listening on ws://localhost:${WS_PORT}`));
    wss.on('connection', (ws) => {
        console.log('Client connected to HID bridge.');
        ws.on('close', () => console.log('Client disconnected.'));
    });

    device.on('data', (data) => {
        const token = data && data.length ? data.toString('utf8').trim() : null;
        if (!token) return;
        console.log('HID ->', token);
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) client.send(token);
        });
    });

    device.on('error', (err) => {
        console.error('HID device error:', err);
        process.exit(1);
    });
}

function startCLIBridge(cmd, args = []) {
    const spawn = require('child_process').spawn;
    console.log('Starting CLI bridge:', cmd, args.join(' '));

    const wss = new WebSocket.Server({ port: WS_PORT });
    wss.on('listening', () => console.log(`WebSocket bridge listening on ws://localhost:${WS_PORT}`));
    wss.on('connection', (ws) => {
        console.log('Client connected to CLI bridge.');
        ws.on('close', () => console.log('Client disconnected.'));
    });

    let child = null;

    function spawnChild() {
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            console.error('Failed to spawn CLI:', err && err.message ? err.message : err);
            process.exit(1);
        }

        child.stdout.setEncoding('utf8');
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const token = line.trim();
                if (!token) continue;
                console.log('CLI ->', token);
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) client.send(token);
                });
            }
        });

        child.stderr.on('data', (d) => console.error('CLI stderr:', d.toString().trim()));

        child.on('exit', (code, sig) => {
            console.log(`CLI process exited (code=${code}, sig=${sig}). Respawning in 2s...`);
            setTimeout(spawnChild, 2000);
        });
    }

    spawnChild();
}

start().catch((err) => {
    console.error('Bridge error:', err);
    process.exit(1);
});
