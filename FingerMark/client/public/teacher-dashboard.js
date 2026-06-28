const session = JSON.parse(localStorage.getItem("session") || "null");
const token = localStorage.getItem("authToken");

if (!session || session.role !== "teacher" || !token) {
    window.location.href = "login.html";
}

const messageEl = document.getElementById("teacher-message");
const bioScannerStatusEl = document.getElementById("bio-scanner-status");

let bioScanner;
let bioRunning = false;
let currentSessionId = null;
let currentSubjectName = "";
let bioDisplayWindow = null;
let bioDisplayClearTimer = null;
let bioLoopPromise = null;
let bioStopRequested = false;
let suppressSelectorSync = false;
const BIO_STOP_SIGNAL_KEY = "teacher-bio-stop-signal";
const BIOMETRIC_SESSION_STORAGE_KEY = "active-biometric-session";

try {
    bioScanner = new window.FingerprintScannerBridge((message) => {
        setBioStatus(message);
    });
} catch (_error) {
    bioScanner = {
        connected: false,
        source: "manual",
        async connectWebSocketBridge() { throw new Error("Scanner not available"); },
        async connectHttpBridge() { throw new Error("Scanner not available"); },
        async connectRDService() { throw new Error("Scanner not available"); },
        async connectHID() { throw new Error("Scanner not available"); },
        async connectSerial() { throw new Error("Scanner not available"); },
        async capture() { throw new Error("Scanner not available"); },
        getDeviceId() { return "NO-SCANNER"; }
    };
}

function showMessage(message, isError = false) {
    messageEl.textContent = message;
    messageEl.style.color = isError ? "#ff9d9d" : "#91f2c5";
}

function setBioStatus(message, isError = false) {
    bioScannerStatusEl.textContent = message;
    bioScannerStatusEl.style.color = isError ? "#ffb0b0" : "#dfe9ff";
}

function setBiometricUiRunning(running) {
    const startBtn = document.getElementById("start-bio-btn");
    if (startBtn) {
        startBtn.disabled = running;
        startBtn.textContent = running ? "Biometric Session Running" : "Start Biometric Attendance";
    }
}

function authHeaders(extra = {}) {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extra
    };
}

async function logout() {
    try {
        await fetch("/api/logout", {
            method: "POST",
            headers: authHeaders()
        });
    } catch (_error) {
    } finally {
        localStorage.removeItem("session");
        localStorage.removeItem("authToken");
        window.location.href = "login.html";
    }
}

document.getElementById("logout-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    logout();
});

async function api(url, options = {}) {
    const res = await fetch(url, {
        headers: authHeaders(options.headers || {}),
        ...options
    });

    if (res.status === 401) {
        await logout();
        throw new Error("Session expired. Login again.");
    }

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || "Request failed.");
    }
    return data;
}

async function loadRdStatus() {
    try {
        const result = await api("/api/rd/status");
        if (!result.running) {
            setBioStatus("Mantra RD Service not running. Please start RD service.", true);
            return;
        }
        setBioStatus(`RD ready on ${result.host || "127.0.0.1"}:${result.port}${result.path || "/rd/capture"}`);
    } catch (error) {
        setBioStatus(error.message || "Mantra RD Service not running. Please start RD service.", true);
    }
}

function bindSidebarNavigation() {
    const items = Array.from(document.querySelectorAll(".nav-list li[data-target]"));
    const itemMap = new Map(items.map((item) => [item.dataset.target, item]));
    const sections = items
        .map((item) => document.getElementById(item.dataset.target))
        .filter(Boolean);

    function setActiveNav(targetId) {
        items.forEach((entry) => entry.classList.toggle("active", entry.dataset.target === targetId));
    }

    items.forEach((item) => {
        item.addEventListener("click", () => {
            const target = document.getElementById(item.dataset.target);
            if (!target) {
                return;
            }
            setActiveNav(item.dataset.target);
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    });

    if (!sections.length) {
        return;
    }

    if ("IntersectionObserver" in window) {
        let activeSectionId = sections[0].id;
        const visibleSections = new Map();
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    visibleSections.set(entry.target.id, entry.intersectionRatio);
                } else {
                    visibleSections.delete(entry.target.id);
                }
            });

            const nextSectionId = visibleSections.size
                ? Array.from(visibleSections.entries()).sort((a, b) => b[1] - a[1])[0][0]
                : activeSectionId;

            if (nextSectionId && nextSectionId !== activeSectionId && itemMap.has(nextSectionId)) {
                activeSectionId = nextSectionId;
                setActiveNav(nextSectionId);
            }
        }, {
            root: null,
            rootMargin: "-20% 0px -55% 0px",
            threshold: [0.15, 0.3, 0.45, 0.6]
        });

        sections.forEach((section) => observer.observe(section));
        setActiveNav(activeSectionId);
        return;
    }

    function updateActiveOnScroll() {
        const offset = window.innerHeight * 0.28;
        let activeSection = sections[0];

        sections.forEach((section) => {
            if (section.getBoundingClientRect().top - offset <= 0) {
                activeSection = section;
            }
        });

        if (activeSection && itemMap.has(activeSection.id)) {
            setActiveNav(activeSection.id);
        }
    }

    window.addEventListener("scroll", updateActiveOnScroll, { passive: true });
    updateActiveOnScroll();
}

function statusClass(status) {
    if (status === "Present") return "present";
    if (status === "Absent") return "absent";
    return "";
}

function boolMark(value) {
    return value === 1 ? "<span class='ok'>YES</span>" : "<span class='no'>NO</span>";
}

function attendanceWordMark(value) {
    return value === 1 ? "<span class='present'>Present</span>" : "<span class='absent'>Absent</span>";
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function selectHtml(items, placeholder, formatter) {
    return [`<option value="">${placeholder}</option>`, ...items.map(formatter)].join("");
}

async function loadCoursesInto(selectIds) {
    const courses = await api("/api/courses");
    const html = selectHtml(courses, "Choose course", (course) => `<option value="${course.id}">${course.name}</option>`);
    selectIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.innerHTML = html;
        }
    });
}

async function loadSemestersInto(courseId, selectId) {
    const semesters = await api(`/api/semesters?courseId=${encodeURIComponent(courseId)}`);
    document.getElementById(selectId).innerHTML = selectHtml(semesters, "Choose semester", (sem) => `<option value="${sem.id}">${sem.name} (${sem.academic_year})</option>`);
}

async function loadDivisionsInto(courseId, semesterId, selectId) {
    const params = new URLSearchParams({ courseId, semesterId });
    const divisions = await api(`/api/divisions?${params.toString()}`);
    document.getElementById(selectId).innerHTML = selectHtml(divisions, "Choose division", (div) => `<option value="${div.id}">${div.name}</option>`);
}

async function loadSubjectsInto(courseId, semesterId, selectId) {
    const params = new URLSearchParams({ courseId, semesterId });
    const subjects = await api(`/api/subjects?${params.toString()}`);
    document.getElementById(selectId).innerHTML = selectHtml(subjects, "Choose subject", (subject) => `<option value="${subject.id}">${subject.name}</option>`);
}

function resetSelect(selectId, placeholder) {
    const el = document.getElementById(selectId);
    if (el) {
        el.innerHTML = `<option value="">${placeholder}</option>`;
    }
}

function getSectionSelection(prefix) {
    return {
        courseId: document.getElementById(`${prefix}-course`)?.value || "",
        semesterId: document.getElementById(`${prefix}-semester`)?.value || "",
        divisionId: document.getElementById(`${prefix}-division`)?.value || "",
        subjectId: document.getElementById(`${prefix}-subject`)?.value || ""
    };
}

function getActiveSelection() {
    const bio = getSectionSelection("bio");
    if (bio.subjectId || bio.divisionId || bio.courseId || bio.semesterId) {
        return bio;
    }
    return getSectionSelection("manual");
}

function setSelectValue(selectId, value) {
    const el = document.getElementById(selectId);
    if (el) {
        el.value = value || "";
    }
}

async function syncSelectors(sourcePrefix, targetPrefix) {
    if (suppressSelectorSync) {
        return;
    }

    const selection = getSectionSelection(sourcePrefix);
    suppressSelectorSync = true;
    try {
        setSelectValue(`${targetPrefix}-course`, selection.courseId);
        resetSelect(`${targetPrefix}-semester`, "Choose semester");
        resetSelect(`${targetPrefix}-division`, "Choose division");
        resetSelect(`${targetPrefix}-subject`, "Choose subject");

        if (!selection.courseId) {
            return;
        }

        await loadSemestersInto(selection.courseId, `${targetPrefix}-semester`);
        setSelectValue(`${targetPrefix}-semester`, selection.semesterId);

        if (!selection.semesterId) {
            return;
        }

        await Promise.all([
            loadDivisionsInto(selection.courseId, selection.semesterId, `${targetPrefix}-division`),
            loadSubjectsInto(selection.courseId, selection.semesterId, `${targetPrefix}-subject`)
        ]);
        setSelectValue(`${targetPrefix}-division`, selection.divisionId);
        setSelectValue(`${targetPrefix}-subject`, selection.subjectId);
    } finally {
        suppressSelectorSync = false;
    }
}

async function ensureScannerReady(options = {}) {
    if (bioScanner.connected) {
        return;
    }
    const errors = [];

    try {
        await bioScanner.connectRDService();
        return;
    } catch (rdError) {
        errors.push(`RD Service: ${rdError.message}`);
    }
    try {
        await bioScanner.connectWebSocketBridge();
        return;
    } catch (wsError) {
        errors.push(`Bridge WS: ${wsError.message}`);
    }
    try {
        await bioScanner.connectHttpBridge();
        return;
    } catch (httpError) {
        errors.push(`Bridge HTTP: ${httpError.message}`);
    }

    bioScanner.connected = false;
    bioScanner.source = "keyboard-wedge";
    setBioStatus(`Scanner hardware not connected through RD/bridge. Waiting for scanner keyboard input. ${errors.join(" | ")}`, true);
}

function ensureBioDisplayWindow() {
    if (!bioDisplayWindow || bioDisplayWindow.closed) {
        const features = [
            `width=${window.screen.availWidth || 1280}`,
            `height=${window.screen.availHeight || 720}`,
            "left=0",
            "top=0",
            "menubar=no",
            "toolbar=no",
            "location=no",
            "status=no",
            "scrollbars=no",
            "resizable=yes"
        ].join(",");
        bioDisplayWindow = window.open("", "biometric-student-display", features);
        if (!bioDisplayWindow) {
            throw new Error("Popup blocked. Allow popups to open the biometric display window.");
        }
        bioDisplayWindow.document.write(`<!doctype html><html><head><title>Live Biometric Display</title>
            <style>
                *{box-sizing:border-box}
                body{margin:0;font-family:Arial,sans-serif;background:radial-gradient(circle at top,#0e1d35,#050813 70%);color:#fff;min-height:100vh}
                .shell{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px}
                .topbar{width:min(94vw,1400px);display:flex;justify-content:flex-end;margin-bottom:18px}
                .stop-btn{border:none;border-radius:999px;padding:16px 26px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#ff8896,#ff5569);color:#fff;box-shadow:0 18px 44px rgba(255,85,105,.28)}
                .screen{width:min(94vw,1400px);min-height:min(74vh,900px);padding:48px;border-radius:28px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 80px rgba(0,0,0,.45);display:flex;flex-direction:column;justify-content:center}
                .eyebrow{display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.12);font-size:12px;letter-spacing:.16em;text-transform:uppercase}
                h1{font-size:clamp(42px,6vw,78px);margin:18px 0 10px}
                .line{font-size:clamp(22px,3vw,36px);margin:10px 0;color:#dce8ff}
                .sub{font-size:18px;color:#aebdd7;margin-top:18px}
                .error{color:#ffb1b1}
                @media (max-width:720px){.shell{padding:16px}.topbar,.screen{width:100%}.screen{padding:26px;min-height:68vh}.stop-btn{width:100%}}
            </style></head><body>
            <div class="shell">
                <div class="topbar">
                    <button type="button" class="stop-btn" id="display-stop-btn">Stop Session</button>
                </div>
                <div class="screen" id="display-card"><span class="eyebrow">Waiting</span><h1>Scanner Ready</h1><div class="line">Place finger on scanner</div></div>
            </div>
            <script>
                document.getElementById("display-stop-btn").addEventListener("click", function () {
                    const pin = window.prompt("Enter PIN to stop biometric attendance");
                    if (pin === null) {
                        return;
                    }
                    try {
                        localStorage.setItem("teacher-bio-stop-signal", JSON.stringify({
                            pin: pin,
                            ts: Date.now()
                        }));
                    } catch (_error) {
                    }
                    if (window.opener && !window.opener.closed) {
                        if (typeof window.opener.stopBiometricFromDisplay === "function") {
                            window.opener.stopBiometricFromDisplay(pin);
                        } else {
                            window.opener.postMessage({ type: "teacher-stop-biometric", pin: pin }, "*");
                        }
                    }
                    window.close();
                });
            <\/script>
            </body></html>`);
        bioDisplayWindow.document.close();
        try {
            bioDisplayWindow.moveTo(0, 0);
            bioDisplayWindow.resizeTo(window.screen.availWidth || 1280, window.screen.availHeight || 720);
            bioDisplayWindow.focus();
        } catch (_error) {
        }
    }
    return bioDisplayWindow;
}

async function requestBioDisplayFullscreen() {
    const win = ensureBioDisplayWindow();
    try {
        if (win.document.fullscreenElement) {
            return;
        }
        if (win.document.documentElement.requestFullscreen) {
            await win.document.documentElement.requestFullscreen();
        }
    } catch (_error) {
    }
}

function closeBioDisplayWindow() {
    if (bioDisplayClearTimer) {
        clearTimeout(bioDisplayClearTimer);
        bioDisplayClearTimer = null;
    }
    if (bioDisplayWindow && !bioDisplayWindow.closed) {
        try {
            if (bioDisplayWindow.document.fullscreenElement && bioDisplayWindow.document.exitFullscreen) {
                bioDisplayWindow.document.exitFullscreen().catch(() => {});
            }
        } catch (_error) {
        }
        bioDisplayWindow.close();
    }
    bioDisplayWindow = null;
}

function renderDisplay(state) {
    const win = ensureBioDisplayWindow();
    const card = win.document.getElementById("display-card");
    if (card) {
        card.innerHTML = state;
    }
}

function renderStudentOnDisplay(student, subject, scannedAt) {
    const timeLabel = new Date(scannedAt || Date.now()).toLocaleTimeString();
    renderDisplay(`
        <span class="eyebrow">Attendance Marked</span>
        <h1>${escapeHtml(student.name || "-")}</h1>
        <div class="line">Roll No: ${escapeHtml(student.rollNo || "-")}</div>
        <div class="line">Division: ${escapeHtml(student.division || "-")}</div>
        <div class="line">Semester: ${escapeHtml(student.semester || "-")}</div>
        <div class="line">Subject: ${escapeHtml(subject || "-")}</div>
        <div class="sub">Scanned at ${timeLabel}</div>
    `);
    if (bioDisplayClearTimer) {
        clearTimeout(bioDisplayClearTimer);
    }
    bioDisplayClearTimer = setTimeout(() => {
        renderDisplay(`<span class="eyebrow">Waiting</span><h1>Scanner Ready</h1><div class="line">Place finger on scanner</div>`);
    }, 5000);
}

function renderDivisionErrorOnDisplay(message) {
    renderDisplay(`
        <span class="eyebrow">Mismatch</span>
        <h1 class="error">${escapeHtml(message)}</h1>
        <div class="line">This biometric session is running for ${escapeHtml(currentSubjectName || "the selected subject")}.</div>
    `);
}

function appendBioViewRow(content, variant = "default") {
    const container = document.getElementById("bio-view");
    const row = document.createElement("div");
    row.className = `bio-feed-row ${variant}`;
    row.innerHTML = content;
    container.prepend(row);
}

async function loadSummary() {
    const { subjectId, divisionId } = getActiveSelection();
    const params = new URLSearchParams();
    if (subjectId) params.set("subjectId", subjectId);
    if (divisionId) params.set("divisionId", divisionId);
    const rows = await api(`/api/teacher/summary${params.toString() ? `?${params.toString()}` : ""}`);
    const body = document.getElementById("summary-body");
    if (!rows.length) {
        body.innerHTML = "<tr><td colspan='5'>No records for today.</td></tr>";
        document.getElementById("summary-present-count").textContent = "0";
        document.getElementById("summary-absent-count").textContent = "0";
        return;
    }

    let presentCount = 0;
    let absentCount = 0;
    body.innerHTML = rows.map((row) => {
        if (row.final_status === "Present") presentCount += 1;
        else if (row.final_status === "Absent") absentCount += 1;
        return `
            <tr>
                <td>${row.roll_no}</td>
                <td>${row.name}</td>
                <td>${boolMark(row.biometric_present)}</td>
                <td>${attendanceWordMark(row.manual_present)}</td>
                <td class="${statusClass(row.final_status)}">${row.final_status}</td>
            </tr>
        `;
    }).join("");
    document.getElementById("summary-present-count").textContent = String(presentCount);
    document.getElementById("summary-absent-count").textContent = String(absentCount);
}

async function loadManualBulkState() {
    const { subjectId, divisionId } = getSectionSelection("manual");
    const textarea = document.getElementById("manual-rolls");
    if (!textarea) {
        return;
    }
    if (!subjectId || !divisionId) {
        textarea.value = "";
        return;
    }

    const params = new URLSearchParams({ subjectId, divisionId });
    try {
        const result = await api(`/api/attendance/manual/bulk-state?${params.toString()}`);
        textarea.value = (result.rollNos || []).join("\n");
    } catch (error) {
        showMessage(error.message, true);
    }
}

async function processBiometricScanToken(tokenValue) {
    try {
        const result = await api("/api/biometric/scan", {
            method: "POST",
            body: JSON.stringify({
                fingerprintId: tokenValue,
                templateData: tokenValue,
                sessionId: currentSessionId
            })
        });
        showMessage(result.message);
        appendBioViewRow(`
            <div>
                <strong>${result.student.rollNo}</strong>
                <span>${result.student.name}</span>
            </div>
            <small>${result.subject} | ${new Date(result.scannedAt).toLocaleTimeString()}</small>
        `, "success");
        renderStudentOnDisplay(result.student, result.subject, result.scannedAt);
        await loadSummary();
    } catch (error) {
        if (error.message === "You are not from this division.") {
            showMessage(error.message, true);
            appendBioViewRow(`<div><strong>Rejected</strong><span>${error.message}</span></div>`, "error");
            renderDivisionErrorOnDisplay(error.message);
            return;
        }
        throw error;
    }
}

async function biometricLoop() {
    while (bioRunning) {
        try {
            setBioStatus("Waiting for scanner input...");
            const tokenValue = String(await bioScanner.capture(45000)).trim();
            if (!bioRunning || bioStopRequested) break;
            if (!tokenValue) continue;
            setBioStatus("Fingerprint captured. Matching...");
            await processBiometricScanToken(tokenValue);
        } catch (error) {
            if (!bioRunning || bioStopRequested) break;
            setBioStatus(error.message, true);
            await sleep(1000);
        }
    }
}

async function startBiometric() {
    if (bioRunning) {
        showMessage("Biometric session already running in the full-screen window.");
        return;
    }

    const payload = {
        courseId: document.getElementById("bio-course").value,
        semesterId: document.getElementById("bio-semester").value,
        divisionId: document.getElementById("bio-division").value,
        subjectId: document.getElementById("bio-subject").value
    };

    if (!payload.courseId || !payload.semesterId || !payload.divisionId || !payload.subjectId) {
        showMessage("Select course, semester, division, and subject before starting.", true);
        return;
    }

    let biometricWindow = null;
    try {
        await ensureScannerReady();
        biometricWindow = window.open(
            "about:blank",
            "biometric-attendance-window",
            [
                `width=${window.screen.availWidth || 1280}`,
                `height=${window.screen.availHeight || 720}`,
                "left=0",
                "top=0",
                "menubar=no",
                "toolbar=no",
                "location=no",
                "status=no",
                "scrollbars=no",
                "resizable=yes"
            ].join(",")
        );

        if (!biometricWindow) {
            throw new Error("Popup blocked. Allow popups to open biometric-attendance.html.");
        }

        biometricWindow.document.write(`<!doctype html><html><head><title>Starting biometric attendance</title>
            <style>
                body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#f4f8ff;font-family:Segoe UI,Tahoma,sans-serif}
                .card{width:min(92vw,720px);padding:32px;border-radius:24px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.38)}
                h1{margin:0 0 12px;font-size:clamp(28px,5vw,42px)}
                p{margin:0;color:#b5c6e3;font-size:18px;line-height:1.55}
            </style></head><body>
            <div class="card">
                <h1>Starting biometric attendance</h1>
                <p>Preparing RD fingerprint capture and live face camera for this class session.</p>
            </div>
            </body></html>`);
        biometricWindow.document.close();

        const result = await api("/api/biometric/session/start", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        currentSessionId = result.id;
        currentSubjectName = result.subject;
        bioRunning = true;
        setBiometricUiRunning(true);
        try {
            localStorage.removeItem(BIO_STOP_SIGNAL_KEY);
            localStorage.setItem(BIOMETRIC_SESSION_STORAGE_KEY, JSON.stringify({
                sessionId: result.id,
                subject: result.subject,
                courseId: payload.courseId,
                semesterId: payload.semesterId,
                divisionId: payload.divisionId,
                subjectId: payload.subjectId
            }));
        } catch (_error) {
        }

        const biometricUrl = `biometric-attendance.html?sessionId=${encodeURIComponent(result.id)}`;
        biometricWindow.location.replace(biometricUrl);

        try {
            biometricWindow.focus();
        } catch (_error) {
        }

        document.getElementById("bio-view").innerHTML = `
            <div class="bio-feed-row success">
                <div>
                    <strong>${result.subject}</strong>
                    <span>Biometric session started in the full-screen attendance window.</span>
                </div>
                <small>${new Date().toLocaleTimeString()}</small>
            </div>
        `;
        showMessage(result.message || "Biometric attendance started.");
        setBioStatus("Biometric screen opened. Scanner loop is active in the attendance window.");
    } catch (error) {
        bioRunning = false;
        setBiometricUiRunning(false);
        if (biometricWindow && !biometricWindow.closed) {
            try {
                biometricWindow.close();
            } catch (_error) {
            }
        }
        showMessage(error.message, true);
        setBioStatus(error.message, true);
    }
}

async function stopBiometric(options = {}) {
    const { pin = null, redirect = true } = options;
    const enteredPin = pin ?? prompt("Enter PIN to stop biometric attendance");
    if (enteredPin !== "0299") {
        if (enteredPin !== null) {
            showMessage("Incorrect PIN.", true);
        }
        return;
    }

    try {
        bioStopRequested = true;
        bioRunning = false;
        if (currentSessionId) {
            const result = await api("/api/biometric/session/stop", {
                method: "POST",
                body: JSON.stringify({ sessionId: currentSessionId })
            });
            showMessage(result.message);
        }
        bioLoopPromise = null;
        setBiometricUiRunning(false);
        currentSessionId = null;
        currentSubjectName = "";
        setBioStatus("Biometric session stopped.");
        closeBioDisplayWindow();
        try {
            localStorage.removeItem(BIO_STOP_SIGNAL_KEY);
        } catch (_error) {
        }
        await loadSummary();
        if (redirect) {
            window.location.replace("teacher-dashboard.html");
        }
    } catch (error) {
        showMessage(error.message, true);
        setBioStatus(error.message, true);
    }
}

async function submitManualAttendance() {
    const courseId = document.getElementById("manual-course").value;
    const semesterId = document.getElementById("manual-semester").value;
    const divisionId = document.getElementById("manual-division").value;
    const subjectId = document.getElementById("manual-subject").value;
    const raw = document.getElementById("manual-rolls").value.trim();

    if (!courseId || !semesterId || !divisionId || !subjectId || !raw) {
        showMessage("Select course, semester, division, subject, and enter roll numbers.", true);
        return;
    }

    const rolls = Array.from(new Set(raw.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)));
    if (!rolls.length) {
        showMessage("Enter at least one roll number.", true);
        return;
    }

    try {
        const result = await api("/api/attendance/manual/bulk", {
            method: "POST",
            body: JSON.stringify({ subjectId, courseId, semesterId, divisionId, presentRollNos: rolls })
        });
        showMessage(result.message || `Manual attendance saved. ${result.presentCount} present, ${result.absentCount} absent.`);
        await loadManualBulkState();
        await loadSummary();
    } catch (error) {
        showMessage(error.message, true);
    }
}

window.addEventListener("storage", (event) => {
    if (event.key === BIOMETRIC_SESSION_STORAGE_KEY && !event.newValue) {
        bioRunning = false;
        currentSessionId = null;
        currentSubjectName = "";
        setBiometricUiRunning(false);
        setBioStatus("Biometric session stopped. Manual attendance is ready.");
        loadSummary().catch(() => {});
        return;
    }

    if (event.key !== BIO_STOP_SIGNAL_KEY || !event.newValue) {
        return;
    }
    try {
        const payload = JSON.parse(event.newValue);
        if (payload?.status === "stopped") {
            bioRunning = false;
            currentSessionId = null;
            currentSubjectName = "";
            setBiometricUiRunning(false);
            showMessage(payload.message || "Biometric session stopped.");
            setBioStatus("Biometric session stopped. Manual attendance is ready.");
            loadSummary().catch(() => {});
        }
    } catch (_error) {
    }
});

window.addEventListener("beforeunload", () => {
    bioStopRequested = true;
    bioRunning = false;
});

function bindAcademicSelectors(prefix) {
    document.getElementById(`${prefix}-course`)?.addEventListener("change", async (e) => {
        const courseId = e.target.value;
        resetSelect(`${prefix}-semester`, "Choose semester");
        resetSelect(`${prefix}-division`, "Choose division");
        resetSelect(`${prefix}-subject`, "Choose subject");
        if (!courseId) return;
        await loadSemestersInto(courseId, `${prefix}-semester`);
        await syncSelectors(prefix, prefix === "manual" ? "bio" : "manual");
        await loadManualBulkState();
        await loadSummary();
    });

    document.getElementById(`${prefix}-semester`)?.addEventListener("change", async (e) => {
        const courseId = document.getElementById(`${prefix}-course`).value;
        const semesterId = e.target.value;
        resetSelect(`${prefix}-division`, "Choose division");
        resetSelect(`${prefix}-subject`, "Choose subject");
        if (!courseId || !semesterId) return;
        await Promise.all([
            loadDivisionsInto(courseId, semesterId, `${prefix}-division`),
            loadSubjectsInto(courseId, semesterId, `${prefix}-subject`)
        ]);
        await syncSelectors(prefix, prefix === "manual" ? "bio" : "manual");
        await loadManualBulkState();
        await loadSummary();
    });

    document.getElementById(`${prefix}-subject`)?.addEventListener("change", async () => {
        await syncSelectors(prefix, prefix === "manual" ? "bio" : "manual");
        await loadManualBulkState();
        await loadSummary();
    });

    document.getElementById(`${prefix}-division`)?.addEventListener("change", async () => {
        await syncSelectors(prefix, prefix === "manual" ? "bio" : "manual");
        await loadManualBulkState();
        await loadSummary();
    });
}

document.getElementById("manual-submit-btn")?.addEventListener("click", submitManualAttendance);
document.getElementById("start-bio-btn")?.addEventListener("click", startBiometric);

api("/api/me")
    .then(async () => {
        bindSidebarNavigation();
        await loadRdStatus();
        bindAcademicSelectors("manual");
        bindAcademicSelectors("bio");
        await loadCoursesInto(["manual-course", "bio-course"]);
        await loadManualBulkState();
        await loadSummary();
    })
    .catch((error) => showMessage(error.message, true));
