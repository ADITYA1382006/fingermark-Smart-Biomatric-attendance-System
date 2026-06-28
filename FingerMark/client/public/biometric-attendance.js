const session = JSON.parse(localStorage.getItem("session") || "null");
const token = localStorage.getItem("authToken");
const BIO_STOP_SIGNAL_KEY = "teacher-bio-stop-signal";
const BIOMETRIC_SESSION_STORAGE_KEY = "active-biometric-session";
const MATCH_WINDOW_MS = 18000;
const MATCH_COOLDOWN_MS = 6000;

if (!session || session.role !== "teacher" || !token) {
    window.location.href = "login.html";
}

const scannerStatusBannerEl = document.getElementById("scanner-status-banner");
const scannerNoteEl = document.getElementById("scanner-note");
const cameraStatusBannerEl = document.getElementById("camera-status-banner");
const faceCameraEl = document.getElementById("face-camera");
const faceNoteEl = document.getElementById("face-note");
const sessionMetaEl = document.getElementById("session-meta");
const scanLogEl = document.getElementById("scan-log");

const fieldEls = {
    name: document.getElementById("student-name"),
    division: document.getElementById("student-division"),
    semester: document.getElementById("student-semester"),
    branch: document.getElementById("student-branch"),
    rollNo: document.getElementById("student-roll"),
    status: document.getElementById("attendance-status")
};

let scanner;
let scannerActive = true;
let currentSessionId = "";
let currentSession = null;
let faceCameraStream = null;
let lastFaceMatchAt = 0;
let announcingIdentity = false;
let confirmInFlight = false;
let lastConfirmedStudentId = null;
let lastConfirmedAt = 0;
let pendingVerification = {
    fingerprint: null,
    face: null
};

try {
    scanner = new window.FingerprintScannerBridge((message) => {
        setScannerStatus(message);
    });
} catch (_error) {
    scanner = {
        connected: false,
        source: "manual",
        async connectRDService() { throw new Error("Scanner not available"); },
        async connectWebSocketBridge() { throw new Error("Scanner not available"); },
        async connectHttpBridge() { throw new Error("Scanner not available"); },
        async connectHID() { throw new Error("Scanner not available"); },
        async connectSerial() { throw new Error("Scanner not available"); },
        async capture() { throw new Error("Scanner not available"); }
    };
}

function authHeaders(extra = {}) {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extra
    };
}

async function api(url, options = {}) {
    const res = await fetch(url, {
        headers: authHeaders(options.headers || {}),
        ...options
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || data.message || "Request failed.");
    }
    return data;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function setScannerStatus(message, tone = "ok") {
    scannerStatusBannerEl.textContent = message;
    scannerStatusBannerEl.className = "status-banner";
    if (tone === "error") {
        scannerStatusBannerEl.classList.add("error");
    } else if (tone === "warning") {
        scannerStatusBannerEl.classList.add("warning");
    }
}

function setCameraStatus(message, tone = "ok") {
    if (!cameraStatusBannerEl) {
        return;
    }
    cameraStatusBannerEl.textContent = message;
    cameraStatusBannerEl.className = "status-banner";
    if (tone === "error") {
        cameraStatusBannerEl.classList.add("error");
    } else if (tone === "warning") {
        cameraStatusBannerEl.classList.add("warning");
    }
}

function setLastScanResult(student = {}, status = "WAITING") {
    fieldEls.name.textContent = student.name || "-";
    fieldEls.division.textContent = student.division || "-";
    fieldEls.semester.textContent = student.semester || "-";
    fieldEls.branch.textContent = student.branch || "-";
    fieldEls.rollNo.textContent = student.rollNo || "-";
    fieldEls.status.textContent = status;
    fieldEls.status.className = "";
    if (status === "MATCHED") {
        fieldEls.status.classList.add("present");
    } else if (status === "NOT MATCHED") {
        fieldEls.status.classList.add("error");
    }
}

function appendLog(title, text) {
    const entry = document.createElement("div");
    entry.className = "log-item";
    entry.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span>`;
    scanLogEl.prepend(entry);
}

function stopFaceCamera() {
    faceCameraStream?.getTracks?.().forEach((track) => track.stop());
    faceCameraStream = null;
    if (faceCameraEl) {
        faceCameraEl.srcObject = null;
    }
}

async function ensureFaceCameraReady() {
    if (faceCameraStream || !faceCameraEl) {
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access is not supported in this browser.");
    }

    const attempts = [
        {
            audio: false,
            video: {
                facingMode: "user",
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        },
        {
            audio: false,
            video: {
                width: { ideal: 960 },
                height: { ideal: 540 }
            }
        },
        {
            audio: false,
            video: true
        }
    ];

    let lastError = null;
    for (const constraints of attempts) {
        try {
            faceCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
            faceCameraEl.srcObject = faceCameraStream;
            await new Promise((resolve) => {
                if (faceCameraEl.readyState >= 1) {
                    resolve();
                    return;
                }
                faceCameraEl.onloadedmetadata = () => resolve();
            });
            await faceCameraEl.play();
            setCameraStatus("Live face camera active.");
            if (faceNoteEl) {
                faceNoteEl.textContent = "Face detection starts automatically. Keep one student centered in front of the camera.";
            }
            return;
        } catch (error) {
            lastError = error;
            stopFaceCamera();
        }
    }

    if (lastError) {
        const message = lastError.message || "Unable to start camera.";
        if (/denied|permission/i.test(message)) {
            throw new Error("Camera permission denied. Allow camera access for this biometric window and restart the session.");
        }
        if (/NotReadable|TrackStart|device in use/i.test(message)) {
            throw new Error("Camera is busy in another app. Close the other app and restart biometric attendance.");
        }
        throw new Error(`Unable to start camera. ${message}`);
    }
}

function announceIdentity(student) {
    if (!("speechSynthesis" in window) || announcingIdentity || !student?.name) {
        return;
    }
    announcingIdentity = true;
    try {
        window.speechSynthesis.cancel();
        const speech = new SpeechSynthesisUtterance(
            `${student.name}. Roll number ${student.rollNo || "unknown"}. Both biometrics matched.`
        );
        speech.rate = 0.95;
        speech.pitch = 1;
        speech.onend = () => {
            announcingIdentity = false;
        };
        speech.onerror = () => {
            announcingIdentity = false;
        };
        window.speechSynthesis.speak(speech);
    } catch (_error) {
        announcingIdentity = false;
    }
}

function captureCameraFrame(videoEl, width = 480, height = 360) {
    if (!videoEl || videoEl.readyState < 2) {
        throw new Error("Camera is not ready yet.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(videoEl, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.88);
}

async function ensureScannerReady(options = {}) {
    if (scanner.connected) {
        return;
    }

    const errors = [];

    try {
        await scanner.connectRDService();
        return;
    } catch (error) {
        errors.push(error.message || "Mantra RD Service not running. Please start RD service.");
    }

    try {
        await scanner.connectWebSocketBridge();
        return;
    } catch (error) {
        errors.push(`Bridge WS: ${error.message}`);
    }
    try {
        await scanner.connectHttpBridge();
        return;
    } catch (error) {
        errors.push(`Bridge HTTP: ${error.message}`);
    }

    throw new Error(errors.join(" | ") || "Mantra RD Service not running. Please start RD service.");
}

function getSessionIdFromLocation() {
    const params = new URLSearchParams(window.location.search);
    return params.get("sessionId") || "";
}

async function loadSessionContext() {
    currentSessionId = getSessionIdFromLocation();
    if (!currentSessionId) {
        const stored = JSON.parse(localStorage.getItem(BIOMETRIC_SESSION_STORAGE_KEY) || "null");
        currentSessionId = stored?.sessionId || "";
    }
    if (!currentSessionId) {
        throw new Error("Biometric session id is missing.");
    }

    currentSession = await api(`/api/biometric/session/${encodeURIComponent(currentSessionId)}`);
    sessionMetaEl.textContent = `${currentSession.subject_name} | ${currentSession.course_name} | ${currentSession.semester_name} | ${currentSession.division_name}`;
}

function nowIso() {
    return new Date().toISOString();
}

function isMatchFresh(match) {
    if (!match?.scannedAt) {
        return false;
    }
    return (Date.now() - new Date(match.scannedAt).getTime()) <= MATCH_WINDOW_MS;
}

function prunePendingMatches() {
    if (!isMatchFresh(pendingVerification.fingerprint)) {
        pendingVerification.fingerprint = null;
    }
    if (!isMatchFresh(pendingVerification.face)) {
        pendingVerification.face = null;
    }
}

function setPendingMatch(type, payload) {
    prunePendingMatches();
    pendingVerification[type] = payload;
}

async function confirmCombinedMatch() {
    prunePendingMatches();
    const fingerprintMatch = pendingVerification.fingerprint;
    const faceMatch = pendingVerification.face;

    if (confirmInFlight || !fingerprintMatch || !faceMatch) {
        return;
    }
    if (lastConfirmedStudentId === fingerprintMatch.student.id && (Date.now() - lastConfirmedAt) < MATCH_COOLDOWN_MS) {
        return;
    }

    confirmInFlight = true;
    try {
        if (fingerprintMatch.student.id !== faceMatch.student.id) {
            await api("/api/biometric/confirm", {
                method: "POST",
                body: JSON.stringify({
                    sessionId: currentSessionId,
                    fingerprintStudentId: fingerprintMatch.student.id,
                    faceStudentId: faceMatch.student.id,
                    fingerprintScannedAt: fingerprintMatch.scannedAt,
                    faceScannedAt: faceMatch.scannedAt,
                    similarity: faceMatch.similarity || 0
                })
            });
            return;
        }

        setScannerStatus(`Fingerprint and face matched ${fingerprintMatch.student.rollNo}. Saving attendance...`);
        setCameraStatus(`Face verified for ${faceMatch.student.rollNo}.`);
        const result = await api("/api/biometric/confirm", {
            method: "POST",
            body: JSON.stringify({
                sessionId: currentSessionId,
                fingerprintStudentId: fingerprintMatch.student.id,
                faceStudentId: faceMatch.student.id,
                fingerprintScannedAt: fingerprintMatch.scannedAt,
                faceScannedAt: faceMatch.scannedAt,
                similarity: faceMatch.similarity || 0
            })
        });

        setLastScanResult(result.student, "MATCHED");
        appendLog(
            "MATCHED",
            `${result.student.rollNo} verified by fingerprint and face for ${result.subject}.`
        );
        setScannerStatus("MATCHED. Ready for next student.");
        setCameraStatus(`MATCHED: ${result.student.rollNo}`);
        announceIdentity(result.student);
        lastConfirmedStudentId = result.student.id;
        lastConfirmedAt = Date.now();
        pendingVerification = { fingerprint: null, face: null };
    } catch (error) {
        setLastScanResult({}, "NOT MATCHED");
        appendLog("NOT MATCHED", error.message || "Biometric verification failed.");
        setScannerStatus(error.message || "Biometric verification failed.", "warning");
        setCameraStatus(error.message || "Biometric verification failed.", "warning");
        pendingVerification = { fingerprint: null, face: null };
    } finally {
        confirmInFlight = false;
    }
}

async function processFingerprintScan(capture) {
    const result = await api("/api/biometric/scan", {
        method: "POST",
        body: JSON.stringify({
            sessionId: currentSessionId,
            fingerprintId: capture.fingerprintId,
            fingerprintToken: capture.fingerprintToken || capture.fingerprintId,
            templateData: capture.templateData,
            rawData: capture.rawData,
            pidData: capture.pidData || null,
            deferAttendance: true
        })
    });

    setPendingMatch("fingerprint", {
        student: result.student,
        scannedAt: result.scannedAt || nowIso()
    });
    setLastScanResult(result.student, "WAITING");
    setScannerStatus(`Fingerprint matched ${result.student.rollNo}. Waiting for face confirmation...`);
    appendLog(
        "Fingerprint matched",
        `${result.student.rollNo} identified by scanner. Waiting for face match.`
    );
    await confirmCombinedMatch();
}

async function processFaceScan() {
    const imageData = captureCameraFrame(faceCameraEl, 640, 480);
    const result = await api("/api/faces/scan", {
        method: "POST",
        body: JSON.stringify({
            imageData,
            sessionId: currentSessionId,
            deferAttendance: true
        })
    });

    setPendingMatch("face", {
        student: result.student,
        scannedAt: result.scannedAt || nowIso(),
        similarity: result.similarity || 0
    });
    setCameraStatus(`Face matched ${result.student.rollNo}. Waiting for fingerprint confirmation...`);
    appendLog(
        "Face matched",
        `${result.student.rollNo} identified by camera. Waiting for fingerprint match.`
    );
    lastFaceMatchAt = Date.now();
    await confirmCombinedMatch();
}

async function scanLoop() {
    while (scannerActive) {
        try {
            prunePendingMatches();
            setScannerStatus("Waiting for fingerprint scan...");
            scannerNoteEl.textContent = "Continuous fingerprint scan mode is active.";
            const capture = await scanner.capture(45000);
            if (!scannerActive) {
                break;
            }
            setScannerStatus("Fingerprint captured. Matching with enrolled templates...");
            await processFingerprintScan(capture);
        } catch (error) {
            if (!scannerActive) {
                break;
            }

            const message = error.message || "Fingerprint scan failed.";
            if (!/timeout/i.test(message)) {
                appendLog("Fingerprint skipped", message);
            }
            setScannerStatus(message, /not running|failed|permission/i.test(message) ? "error" : "warning");
            await sleep(1200);
        }
    }
}

async function faceLoop() {
    while (scannerActive) {
        try {
            prunePendingMatches();
            await ensureFaceCameraReady();
            if (!scannerActive) {
                break;
            }

            if ((Date.now() - lastFaceMatchAt) < 1400) {
                await sleep(700);
                continue;
            }

            setCameraStatus("Watching for enrolled student face...");
            await processFaceScan();
            await sleep(900);
        } catch (error) {
            if (!scannerActive) {
                break;
            }

            const message = error.message || "Face recognition failed.";
            if (!/No enrolled student matched|No face detected|Multiple faces detected/i.test(message)) {
                appendLog("Face skipped", message);
            }
            setCameraStatus(message, /not supported|denied|blocked|busy/i.test(message) ? "error" : "warning");
            await sleep(1200);
        }
    }
}

async function stopBiometric() {
    const pin = window.prompt("Enter PIN to stop biometric attendance");
    if (pin === null) {
        return;
    }
    if (pin !== "0299") {
        setScannerStatus("Invalid PIN", "error");
        appendLog("Stop rejected", "Invalid PIN entered.");
        return;
    }

    scannerActive = false;
    stopFaceCamera();
    try {
        const result = await api("/api/biometric/session/stop", {
            method: "POST",
            body: JSON.stringify({ sessionId: currentSessionId })
        });
        localStorage.setItem(BIO_STOP_SIGNAL_KEY, JSON.stringify({
            status: "stopped",
            sessionId: currentSessionId,
            message: result.message,
            ts: Date.now()
        }));
        localStorage.removeItem(BIOMETRIC_SESSION_STORAGE_KEY);
        setScannerStatus(result.message);
        appendLog("Biometric stopped", result.message);
    } catch (error) {
        setScannerStatus(error.message, "error");
        appendLog("Stop failed", error.message);
        scannerActive = true;
        return;
    }

    if (window.opener && !window.opener.closed) {
        try {
            window.opener.location.href = "teacher-dashboard.html";
        } catch (_error) {
        }
        window.close();
        return;
    }

    window.location.href = "teacher-dashboard.html";
}

async function enterFullscreen() {
    try {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen();
        }
    } catch (_error) {
    }
}

document.getElementById("stop-biometric-btn")?.addEventListener("click", stopBiometric);

window.addEventListener("beforeunload", () => {
    scannerActive = false;
    try {
        window.speechSynthesis?.cancel?.();
    } catch (_error) {
    }
    stopFaceCamera();
});

(async () => {
    try {
        await enterFullscreen();
        await loadSessionContext();
        await Promise.all([ensureScannerReady(), ensureFaceCameraReady()]);
        setScannerStatus("Fingerprint scanner active. Waiting for live scans.");
        scannerNoteEl.textContent = "Scanner and webcam are running in automatic continuous mode.";
        setCameraStatus("Face camera active.");
        appendLog("Session started", `Biometric session ${currentSessionId} is active in combined verification mode.`);
        setLastScanResult({}, "WAITING");
        await Promise.all([scanLoop(), faceLoop()]);
    } catch (error) {
        scannerActive = false;
        stopFaceCamera();
        setScannerStatus(error.message || "Unable to start biometric attendance.", "error");
        setCameraStatus(error.message || "Unable to start biometric attendance.", "error");
        appendLog("Startup failed", error.message || "Unable to start biometric attendance.");
    }
})();
