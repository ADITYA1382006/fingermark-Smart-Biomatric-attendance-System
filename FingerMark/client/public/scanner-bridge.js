class FingerprintScannerBridge {
    constructor(onStatus) {
        this.onStatus = onStatus || (() => {});
        this.port = null;
        this.reader = null;
        this.connected = false;
        this.ws = null;
        this._msgQueue = [];
        this._msgResolvers = [];
        this.hidDevice = null;
        this._hidQueue = [];
        this._hidResolvers = [];
        this.pendingResolve = null;
        this.pendingReject = null;
        this.keyboardActive = false;
        this.keyboardBuffer = "";
        this.source = "manual";
        this.lastCaptureMeta = null;

        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    static get WS_BRIDGE_URL() {
        return "ws://localhost:4123";
    }

    static get HTTP_BRIDGE_URL() {
        return "http://localhost:4124";
    }

    extractXmlAttribute(xml, attributeName) {
        const pattern = new RegExp(`${attributeName}="([^"]*)"`, "i");
        const match = String(xml || "").match(pattern);
        return match ? match[1] : "";
    }

    extractXmlTag(xml, tagName) {
        const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
        const match = String(xml || "").match(pattern);
        return match ? match[1].trim() : "";
    }

    normalizeCaptureValue(value) {
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                try {
                    return this.normalizeCaptureValue(JSON.parse(trimmed));
                } catch (_error) {
                }
            }
        }

        if (value && typeof value === "object" && !Array.isArray(value)) {
            const templateData = String(
                value.templateData
                || value.pidXml
                || value.rawData
                || value.fingerprintId
                || value.token
                || ""
            ).trim();
            return {
                fingerprintId: String(value.fingerprintToken || value.fingerprintId || value.token || templateData).trim(),
                fingerprintToken: String(value.fingerprintToken || value.fingerprintId || value.token || templateData).trim(),
                templateData,
                rawData: String(value.rawData || value.pidXml || templateData).trim(),
                source: value.source || this.source || "manual",
                deviceId: String(value.deviceId || this.getDeviceId()).trim(),
                capturedAt: value.capturedAt || new Date().toISOString(),
                pidData: value.pidData || null
            };
        }

        const rawText = String(value || "").trim();
        const isXml = rawText.startsWith("<");
        return {
            fingerprintId: rawText,
            fingerprintToken: rawText,
            templateData: rawText,
            rawData: rawText,
            source: this.source || "manual",
            deviceId: this.getDeviceId(),
            capturedAt: new Date().toISOString(),
            pidData: isXml ? {
                errCode: this.extractXmlAttribute(rawText, "errCode"),
                errInfo: this.extractXmlAttribute(rawText, "errInfo"),
                qScore: this.extractXmlAttribute(rawText, "qScore"),
                dataType: this.extractXmlAttribute(rawText, "type"),
                pidBlock: this.extractXmlTag(rawText, "Data"),
                hmac: this.extractXmlTag(rawText, "Hmac"),
                deviceInfo: {
                    dpId: this.extractXmlAttribute(rawText, "dpId"),
                    rdsId: this.extractXmlAttribute(rawText, "rdsId"),
                    rdsVer: this.extractXmlAttribute(rawText, "rdsVer"),
                    mi: this.extractXmlAttribute(rawText, "mi"),
                    mc: this.extractXmlAttribute(rawText, "mc"),
                    dc: this.extractXmlAttribute(rawText, "dc")
                }
            } : null
        };
    }

    async connectWebSocketBridge() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.connected = true;
            this.source = "bridge-ws";
            this.onStatus(`Connected to local bridge (${FingerprintScannerBridge.WS_BRIDGE_URL}).`);
            return;
        }

        if (!window.WebSocket) {
            throw new Error("WebSocket not supported in this browser.");
        }

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(FingerprintScannerBridge.WS_BRIDGE_URL);

                this.ws.addEventListener("open", () => {
                    this.connected = true;
                    this.source = "bridge-ws";
                    this.onStatus(`Connected to local bridge (${FingerprintScannerBridge.WS_BRIDGE_URL}). Place finger to capture.`);
                    // create a simple reader that draws from internal queue
                    this.reader = {
                        read: () => {
                            if (this._msgQueue.length) {
                                const v = this._msgQueue.shift();
                                return Promise.resolve({ value: v, done: false });
                            }
                            return new Promise((res) => this._msgResolvers.push(res)).then((v) => ({ value: v, done: false }));
                        }
                    };
                    resolve();
                });

                this.ws.addEventListener("message", (ev) => {
                    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
                    const token = data.trim();
                    if (!token || token === "BRIDGE_READY") return;
                    if (this._msgResolvers.length) {
                        const r = this._msgResolvers.shift();
                        r(token);
                    } else {
                        this._msgQueue.push(token);
                    }
                });

                this.ws.addEventListener("error", (e) => {
                    reject(new Error("Failed to connect to local bridge."));
                });

                this.ws.addEventListener("close", () => {
                    this.connected = false;
                    this.onStatus("Local bridge disconnected.");
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async connectHttpBridge() {
        if (!fetch) {
            throw new Error("Fetch API not available in this context.");
        }

        let response;
        try {
            response = await fetch(`${FingerprintScannerBridge.HTTP_BRIDGE_URL}/health`, {
                method: "GET",
                cache: "no-store"
            });
        } catch (_error) {
            throw new Error("Failed to connect to local HTTP bridge.");
        }

        let payload = null;
        try {
            payload = await response.json();
        } catch (_error) {
        }

        if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error || "Local HTTP bridge is not ready.");
        }

        this.connected = true;
        this.source = "bridge-http";
        this.onStatus(`Connected to local HTTP bridge (${FingerprintScannerBridge.HTTP_BRIDGE_URL}). Place finger to capture.`);

        this.reader = {
            read: async () => {
                const captureResponse = await fetch(`${FingerprintScannerBridge.HTTP_BRIDGE_URL}/rd/capture`, {
                    method: "POST",
                    cache: "no-store"
                });

                let capturePayload = null;
                try {
                    capturePayload = await captureResponse.json();
                } catch (_error) {
                }

                if (!captureResponse.ok || !capturePayload?.ok || !capturePayload.capture) {
                    this.connected = false;
                    throw new Error(capturePayload?.error || "HTTP bridge capture failed.");
                }

                const capture = this.normalizeCaptureValue({
                    fingerprintToken: capturePayload.capture.fingerprintToken,
                    fingerprintId: capturePayload.capture.fingerprintId,
                    templateData: capturePayload.capture.templateData || capturePayload.capture.pidXml || "",
                    rawData: capturePayload.capture.pidXml || capturePayload.capture.templateData || "",
                    source: capturePayload.capture.source || "bridge-http",
                    deviceId: capturePayload.capture.deviceId,
                    capturedAt: capturePayload.capture.capturedAt,
                    pidData: capturePayload.capture.pidData || null
                });

                if (!capture.templateData) {
                    this.connected = false;
                    throw new Error("HTTP bridge returned empty data.");
                }

                this.lastCaptureMeta = capture;
                return { value: capture, done: false };
            }
        };
    }

    async connectRDService() {
        // Use the backend RD proxy so the browser never talks to the RD service directly.
        if (!fetch) throw new Error('Fetch API not available in this context.');

        const token = localStorage.getItem('authToken');
        const statusHeaders = {};
        if (token) statusHeaders.Authorization = `Bearer ${token}`;
        let statusPayload = null;
        let lastStatusError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const statusResp = await fetch('/api/rd/status', { method: 'GET', headers: statusHeaders, cache: 'no-store' });
                statusPayload = null;
                try {
                    statusPayload = await statusResp.json();
                } catch (_error) {
                }
                if (statusResp.ok && statusPayload?.running) {
                    break;
                }
                lastStatusError = new Error(statusPayload?.error || "Mantra RD Service not running. Please start RD service.");
            } catch (error) {
                lastStatusError = error;
            }
            await new Promise((resolve) => setTimeout(resolve, 450));
        }
        if (!statusPayload?.running) {
            throw lastStatusError || new Error("Mantra RD Service not running. Please start RD service.");
        }

        this.source = 'rd-service';
        this.connected = true;
        this.onStatus('Connected to Mantra RD Service via backend proxy. Place finger to capture.');

        this.reader = {
            read: async () => {
                const headers = { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;
                let lastCaptureError = null;

                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        const resp = await fetch('/api/rd/capture', { method: 'POST', headers, cache: 'no-store' });
                        if (!resp.ok) {
                            let message = "Mantra RD Service not running. Please start RD service.";
                            try {
                                const data = await resp.json();
                                message = data.xmlError || data.error || data.message || message;
                            } catch (_error) {
                            }
                            throw new Error(message);
                        }
                        const data = await resp.json();
                        const capture = this.normalizeCaptureValue({
                            fingerprintToken: data.fingerprintToken,
                            fingerprintId: data.fingerprintId,
                            templateData: data.templateData || data.pidXml || data.raw,
                            rawData: data.pidXml || data.raw || data.templateData,
                            source: data.source || 'rd-service',
                            deviceId: data.deviceId,
                            capturedAt: data.capturedAt,
                            pidData: data.pidData || null
                        });
                        if (!capture.templateData) {
                            throw new Error('RD service returned no data.');
                        }
                        this.lastCaptureMeta = capture;
                        return { value: capture, done: false };
                    } catch (error) {
                        lastCaptureError = error;
                        this.connected = false;
                        if (attempt === 0) {
                            this.onStatus('RD capture failed. Retrying connection to RD service...');
                            await this.connectRDService();
                        }
                    }
                }

                throw lastCaptureError || new Error('RD capture failed.');
            }
        };
    }

    async connectHID(vendorId = 0x2C0F, productId = 0x1204, options = {}) {
        if (!('hid' in navigator)) {
            throw new Error('WebHID is not supported in this browser.');
        }

        const allowPrompt = options.allowPrompt !== false;

        // try to get already-paired devices first
        const devices = await navigator.hid.getDevices();
        let device = devices.find(d => d.vendorId === vendorId && d.productId === productId);

        if (!device) {
            if (!allowPrompt) {
                throw new Error('No paired HID scanner found.');
            }
            const picked = await navigator.hid.requestDevice({ filters: [{ vendorId, productId }] });
            if (!picked || !picked.length) {
                throw new Error('No HID device selected.');
            }
            device = picked[0];
        }

        await device.open();
        this.hidDevice = device;
        this.connected = true;
        this.source = 'hid';
        this.onStatus('HID scanner connected. Place finger to capture.');

        const handle = (ev) => {
            try {
                // Attempt to decode incoming data as UTF-8 text
                const data = ev.data;
                let text = '';
                try {
                    text = new TextDecoder().decode(data);
                } catch (_e) {
                    // fallback: convert bytes to hex-separated string
                    text = Array.from(new Uint8Array(data)).map(b => b.toString(16).padStart(2, '0')).join('');
                }
                const token = ('' + text).trim();
                if (!token) return;
                if (this._hidResolvers.length) {
                    const r = this._hidResolvers.shift();
                    r(token);
                } else {
                    this._hidQueue.push(token);
                }
            } catch (err) {
                console.warn('HID input error', err);
            }
        };

        this.hidDevice.addEventListener('inputreport', handle);

        // create a reader-like interface so capture() can use same flow
        this.reader = {
            read: () => {
                if (this._hidQueue.length) {
                    const v = this._hidQueue.shift();
                    return Promise.resolve({ value: v, done: false });
                }
                return new Promise((res) => this._hidResolvers.push(res)).then((v) => ({ value: v, done: false }));
            }
        };
    }

    async connectSerial(options = {}) {
        if (!navigator.serial) {
            throw new Error("WebSerial is not supported in this browser.");
        }

        const allowPrompt = options.allowPrompt !== false;
        const ports = typeof navigator.serial.getPorts === "function"
            ? await navigator.serial.getPorts()
            : [];

        this.port = ports[0] || null;
        if (!this.port) {
            if (!allowPrompt) {
                throw new Error("No paired serial scanner found.");
            }
            this.port = await navigator.serial.requestPort();
        }
        await this.port.open({ baudRate: 9600 });

        const textDecoder = new TextDecoderStream();
        this.port.readable.pipeTo(textDecoder.writable);
        this.reader = textDecoder.readable.getReader();
        this.connected = true;
        this.source = "serial";

        this.onStatus("Scanner connected. Place finger to capture.");
    }

    async captureFromSerial(timeoutMs = 15000) {
        if (!this.connected || !this.reader) {
            throw new Error("Scanner is not connected.");
        }

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Scanner timeout. Try again.")), timeoutMs);
        });

        const readPromise = new Promise(async (resolve, reject) => {
            try {
                let buffer = "";
                while (true) {
                    const { value, done } = await this.reader.read();
                    if (done) {
                        reject(new Error("Scanner disconnected."));
                        return;
                    }
                    buffer += value;
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || "";
                    const token = lines.map((line) => line.trim()).find(Boolean);
                    if (token) {
                        const capture = this.normalizeCaptureValue(token);
                        this.lastCaptureMeta = capture;
                        resolve(capture);
                        return;
                    }
                }
            } catch (error) {
                reject(error);
            }
        });

        return Promise.race([readPromise, timeoutPromise]);
    }

    async captureFromReader(timeoutMs = 15000) {
        if (!this.connected || !this.reader) {
            throw new Error("Scanner is not connected.");
        }

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Scanner timeout. Try again.")), timeoutMs);
        });

        const readPromise = new Promise(async (resolve, reject) => {
            try {
                const { value, done } = await this.reader.read();
                if (done) {
                    reject(new Error("Scanner disconnected."));
                    return;
                }
                const capture = this.normalizeCaptureValue(value);
                if (!capture.templateData) {
                    reject(new Error("Scanner returned empty data."));
                    return;
                }
                this.lastCaptureMeta = capture;
                resolve(capture);
            } catch (error) {
                reject(error);
            }
        });

        return Promise.race([readPromise, timeoutPromise]);
    }

    captureFromKeyboard(timeoutMs = 15000) {
        this.source = "keyboard-wedge";
        this.keyboardBuffer = "";
        this.keyboardActive = true;
        document.addEventListener("keydown", this.handleKeyDown);

        this.onStatus("Scanner keyboard mode active. Scan now and press Enter.");

        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
            setTimeout(() => {
                if (this.keyboardActive && this.pendingReject) {
                    this.resetKeyboardCapture();
                    reject(new Error("Scanner timeout. No keyboard scan received."));
                }
            }, timeoutMs);
        });
    }

    handleKeyDown(event) {
        if (!this.keyboardActive) {
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
                const value = this.keyboardBuffer.trim();
                if (value) {
                    const resolve = this.pendingResolve;
                    this.resetKeyboardCapture();
                    const capture = this.normalizeCaptureValue(value);
                    this.lastCaptureMeta = capture;
                    resolve(capture);
                }
            return;
        }

        if (event.key === "Backspace") {
            this.keyboardBuffer = this.keyboardBuffer.slice(0, -1);
            return;
        }

        if (event.key.length === 1) {
            this.keyboardBuffer += event.key;
        }
    }

    resetKeyboardCapture() {
        this.keyboardActive = false;
        this.keyboardBuffer = "";
        this.pendingResolve = null;
        this.pendingReject = null;
        document.removeEventListener("keydown", this.handleKeyDown);
    }

    async capture(timeoutMs = 15000) {
        if (this.connected) {
            if (this.source === "rd-service" || this.source === "bridge-ws" || this.source === "bridge-http" || this.source === "hid") {
                return this.captureFromReader(timeoutMs);
            }
            return this.captureFromSerial(timeoutMs);
        }
        return this.captureFromKeyboard(timeoutMs);
    }

    getDeviceId() {
        if (this.lastCaptureMeta?.deviceId) {
            return this.lastCaptureMeta.deviceId;
        }
        if (this.port && this.port.getInfo) {
            const info = this.port.getInfo();
            return `VID:${info.usbVendorId || "NA"}-PID:${info.usbProductId || "NA"}`;
        }
        return "KEYBOARD-SCANNER";
    }
}

window.FingerprintScannerBridge = FingerprintScannerBridge;
