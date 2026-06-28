const http = require("http");
const { WebSocketServer } = require("ws");
let HID = null;
try {
    HID = require("node-hid");
} catch (_error) {
    HID = null;
}

const WS_PORT = Number(process.env.MFS_BRIDGE_WS_PORT || 4123);
const HTTP_PORT = Number(process.env.MFS_BRIDGE_HTTP_PORT || 4124);
const RD_HOST = process.env.RD_HOST || "127.0.0.1";
const RD_PORT = Number(process.env.RD_PORT || 11100);
const RD_CAPTURE_PATH = process.env.RD_CAPTURE_PATH || "/rd/capture";
const RD_CAPTURE_XML = '<Capture pidVer="2.0" timeout="10000" env="P" fCount="1" fType="0" format="0" pidType="0"/>';

const clients = new Set();
let activeHid = null;
let activeDevicePath = "";

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function extractXmlAttribute(xml, attributeName) {
    const match = String(xml || "").match(new RegExp(`${attributeName}="([^"]*)"`, "i"));
    return match ? match[1] : "";
}

function extractXmlTag(xml, tagName) {
    const match = String(xml || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
    return match ? match[1].trim() : "";
}

function parsePidData(xml) {
    return {
        errCode: extractXmlAttribute(xml, "errCode"),
        errInfo: extractXmlAttribute(xml, "errInfo"),
        qScore: extractXmlAttribute(xml, "qScore"),
        dataType: extractXmlAttribute(xml, "type"),
        pidBlock: extractXmlTag(xml, "Data"),
        hmac: extractXmlTag(xml, "Hmac"),
        deviceInfo: {
            dpId: extractXmlAttribute(xml, "dpId"),
            rdsId: extractXmlAttribute(xml, "rdsId"),
            rdsVer: extractXmlAttribute(xml, "rdsVer"),
            dc: extractXmlAttribute(xml, "dc"),
            mi: extractXmlAttribute(xml, "mi"),
            mc: extractXmlAttribute(xml, "mc")
        }
    };
}

function captureFromRdService() {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: RD_HOST,
            port: RD_PORT,
            path: RD_CAPTURE_PATH,
            method: "POST",
            headers: {
                "Content-Type": "text/xml",
                "Content-Length": Buffer.byteLength(RD_CAPTURE_XML, "utf8")
            },
            timeout: 20000
        }, (rdRes) => {
            let body = "";
            rdRes.setEncoding("utf8");
            rdRes.on("data", (chunk) => {
                body += chunk;
            });
            rdRes.on("end", () => {
                if (rdRes.statusCode < 200 || rdRes.statusCode >= 300) {
                    reject(new Error(`RD capture failed with status ${rdRes.statusCode}`));
                    return;
                }

                const pidXml = String(body || "").trim();
                const pidData = parsePidData(pidXml);
                if (pidData.errCode && pidData.errCode !== "0") {
                    reject(new Error(pidData.errInfo || `RD error ${pidData.errCode}`));
                    return;
                }

                resolve({
                    fingerprintId: pidData.pidBlock || pidXml,
                    templateData: pidXml,
                    pidXml,
                    pidData,
                    deviceId: pidData.deviceInfo.mi || pidData.deviceInfo.mc || "MANTRA-RD",
                    source: "rd-service",
                    capturedAt: new Date().toISOString()
                });
            });
        });

        request.on("error", reject);
        request.on("timeout", () => {
            request.destroy(new Error("RD capture timeout"));
        });
        request.write(RD_CAPTURE_XML);
        request.end();
    });
}

function broadcastToken(token) {
    const normalized = typeof token === "string" ? token.trim() : JSON.stringify(token || {});
    if (!normalized) {
        return false;
    }

    let sent = 0;
    for (const client of clients) {
        if (client.readyState === 1) {
            client.send(normalized);
            sent += 1;
        }
    }

    console.log(`[mfs-bridge] broadcast token to ${sent} client(s)`);
    return sent > 0;
}

function listHidDevices() {
    if (!HID) {
        return [];
    }
    return HID.devices().map((device) => ({
        path: device.path,
        vendorId: device.vendorId,
        productId: device.productId,
        product: device.product || "",
        manufacturer: device.manufacturer || "",
        serialNumber: device.serialNumber || "",
        usagePage: device.usagePage,
        usage: device.usage,
        interface: device.interface
    }));
}

function closeActiveHid() {
    if (!activeHid) {
        return;
    }
    try {
        activeHid.close();
    } catch (_error) {
    }
    activeHid = null;
    activeDevicePath = "";
}

function openHidDevice(devicePath) {
    if (!HID) {
        throw new Error("node-hid is not available.");
    }
    closeActiveHid();

    const hid = new HID.HID(devicePath);
    activeHid = hid;
    activeDevicePath = devicePath;

    hid.on("data", (data) => {
        const bytes = Buffer.from(data);
        const hexToken = bytes.toString("hex");
        const base64Token = bytes.toString("base64");
        // Prefer hex because it's easier to persist and compare exactly.
        broadcastToken(hexToken);
        console.log(`[mfs-bridge] hid data ${base64Token}`);
    });

    hid.on("error", (error) => {
        console.error(`[mfs-bridge] hid error: ${error.message}`);
        closeActiveHid();
    });
}

const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (socket, request) => {
    clients.add(socket);
    console.log(`[mfs-bridge] ws client connected from ${request.socket.remoteAddress}`);
    socket.send("BRIDGE_READY");

    socket.on("close", () => {
        clients.delete(socket);
        console.log("[mfs-bridge] ws client disconnected");
    });
});

const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, {
            ok: true,
            wsPort: WS_PORT,
            httpPort: HTTP_PORT,
            clients: clients.size,
            hidAvailable: Boolean(HID),
            activeDevicePath,
            rdHost: RD_HOST,
            rdPort: RD_PORT,
            message: "Bridge is running. POST /rd/capture for Mantra RD scans or POST /emit with {\"token\":\"...\"} to broadcast a token."
        });
    }

    if (req.method === "GET" && req.url === "/devices") {
        return sendJson(res, 200, {
            ok: true,
            hidAvailable: Boolean(HID),
            devices: listHidDevices()
        });
    }

    if (req.method === "POST" && req.url === "/connect-hid") {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            try {
                const payload = JSON.parse(body || "{}");
                if (!payload.path) {
                    return sendJson(res, 400, { ok: false, error: "path is required" });
                }
                openHidDevice(payload.path);
                return sendJson(res, 200, {
                    ok: true,
                    activeDevicePath
                });
            } catch (error) {
                return sendJson(res, 400, { ok: false, error: error.message });
            }
        });
        return;
    }

    if (req.method === "POST" && req.url === "/disconnect-hid") {
        closeActiveHid();
        return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/emit") {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            try {
                const payload = JSON.parse(body || "{}");
                const token = payload.token || payload.fingerprintId || payload.template || "";
                if (!String(token).trim()) {
                    return sendJson(res, 400, { ok: false, error: "token is required" });
                }

                const delivered = broadcastToken(token);
                return sendJson(res, 200, {
                    ok: true,
                    delivered,
                    clients: clients.size
                });
            } catch (error) {
                return sendJson(res, 400, { ok: false, error: error.message });
            }
        });
        return;
    }

    if (req.method === "POST" && req.url === "/rd/capture") {
        captureFromRdService()
            .then((capture) => {
                broadcastToken(capture);
                sendJson(res, 200, { ok: true, capture });
            })
            .catch((error) => {
                sendJson(res, 502, { ok: false, error: error.message });
            });
        return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(HTTP_PORT, () => {
    console.log(`[mfs-bridge] websocket listening on ws://localhost:${WS_PORT}`);
    console.log(`[mfs-bridge] http control listening on http://localhost:${HTTP_PORT}`);
    console.log("[mfs-bridge] you can also type stable scan tokens directly here and press Enter");
    console.log("[mfs-bridge] GET /devices to list HID devices, POST /connect-hid to attach one");
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    const lines = String(chunk || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
        broadcastToken(line);
    }
});

process.on("SIGINT", () => {
    closeActiveHid();
    process.exit(0);
});
