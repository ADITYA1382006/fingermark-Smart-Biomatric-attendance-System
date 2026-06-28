const session = JSON.parse(localStorage.getItem("session") || "null");
const token = localStorage.getItem("authToken");

if (!session || session.role !== "admin" || !token) {
    window.location.href = "login.html";
}

const adminNameEl = document.getElementById("admin-name");
if (adminNameEl) {
    adminNameEl.textContent = session?.username || "Admin";
}

const msgEl = document.getElementById("admin-message");
const scannerStatusEl = document.getElementById("scanner-status");
const studentScannerStatusEl = document.getElementById("student-scanner-status");
const studentFaceStatusEl = document.getElementById("student-face-status");
const studentFaceVideoEl = document.getElementById("student-face-video");
const studentFacePreviewEl = document.getElementById("student-face-preview");
const bioFaceStatusEl = document.getElementById("bio-face-status");
const bioFaceVideoEl = document.getElementById("bio-face-video");
const bioFacePreviewEl = document.getElementById("bio-face-preview");
let lastCapture = null;
let studentCapture = null;
let studentFaceCapture = null;
let studentFaceStream = null;
let bioFaceCapture = null;
let bioFaceStream = null;
let scanner;

try {
    scanner = new window.FingerprintScannerBridge((message) => {
        if (scannerStatusEl) {
            scannerStatusEl.textContent = message;
        }
    });
} catch (error) {
    scanner = {
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
    if (!msgEl) {
        return;
    }
    msgEl.textContent = message;
    msgEl.style.color = isError ? "#ff7f7f" : "#8df7c8";
}

function addLocalActivity(action, status = "Completed") {
    const body = document.getElementById("activity-body");
    if (!body) {
        return;
    }
    const row = document.createElement("tr");
    row.innerHTML = `
        <td>${new Date().toLocaleString()}</td>
        <td>${action}</td>
        <td><span class="tag">${status}</span></td>
    `;
    body.prepend(row);
}

function authHeaders(extra = {}) {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extra
    };
}

function stopMediaStream(stream) {
    stream?.getTracks?.().forEach((track) => track.stop());
}

async function captureFingerprintFromRdProxy() {
    const result = await api("/api/rd/capture", {
        method: "POST"
    });

    return {
        token: String(result?.fingerprintToken || result?.fingerprintId || result?.templateData || "").trim(),
        fingerprintToken: String(result?.fingerprintToken || result?.fingerprintId || result?.templateData || "").trim(),
        source: result?.source || "rd-service",
        capturedAt: result?.capturedAt || new Date().toISOString(),
        templateData: String(result?.templateData || result?.pidXml || "").trim(),
        rawData: String(result?.pidXml || result?.templateData || "").trim(),
        pidData: result?.pidData || null,
        deviceId: String(result?.deviceId || "MANTRA-RD").trim()
    };
}

async function startStudentFaceCamera() {
    if (!navigator.mediaDevices?.getUserMedia || !studentFaceVideoEl) {
        throw new Error("Camera access is not supported in this browser.");
    }

    stopMediaStream(studentFaceStream);
    studentFaceStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 }
        }
    });
    studentFaceVideoEl.srcObject = studentFaceStream;
    await studentFaceVideoEl.play();
    if (studentFaceStatusEl) {
        studentFaceStatusEl.textContent = "Camera ready. Keep one student face centered and capture.";
    }
}

async function startBioFaceCamera() {
    if (!navigator.mediaDevices?.getUserMedia || !bioFaceVideoEl) {
        throw new Error("Camera access is not supported in this browser.");
    }

    stopMediaStream(bioFaceStream);
    bioFaceStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 }
        }
    });
    bioFaceVideoEl.srcObject = bioFaceStream;
    await bioFaceVideoEl.play();
    if (bioFaceStatusEl) {
        bioFaceStatusEl.textContent = "Camera ready. Keep the student face centered and capture.";
    }
}

function captureVideoFrame(videoEl, width = 480, height = 360) {
    if (!videoEl || videoEl.readyState < 2) {
        throw new Error("Camera is not ready yet. Start the camera and try again.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(videoEl, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.9);
}

async function logout() {
    try {
        await fetch("/api/logout", { method: "POST", headers: authHeaders() });
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

function selectHtml(items, placeholder, formatter) {
    return [`<option value="">${placeholder}</option>`, ...items.map(formatter)].join("");
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

async function ensureScannerReady(options = {}) {
    if (scanner.connected) {
        return;
    }

    const errors = [];
    let rdStatus = null;

    try {
        await scanner.connectRDService();
        return;
    } catch (rdError) {
        errors.push(`RD Service: ${rdError.message}`);
        try {
            rdStatus = await api("/api/rd/status");
        } catch (_statusError) {
        }
    }
    try {
        await scanner.connectWebSocketBridge();
        return;
    } catch (wsError) {
        errors.push(`Bridge WS: ${wsError.message}`);
    }
    try {
        await scanner.connectHttpBridge();
        return;
    } catch (httpError) {
        errors.push(`Bridge HTTP: ${httpError.message}`);
    }

    scanner.connected = false;
    scanner.source = "keyboard-wedge";
    const vendorHint = rdStatus?.vendorRunning
        ? `Scanner vendor service detected (${(rdStatus.vendorProcesses || []).join(", ")}), but this machine is not exposing the standard RD HTTP capture API.`
        : "Scanner hardware not connected through RD/bridge.";
    const message = `${vendorHint} Waiting for scanner keyboard input. ${errors.join(" | ")}`;
    if (scannerStatusEl) {
        scannerStatusEl.textContent = message;
    }
    if (studentScannerStatusEl) {
        studentScannerStatusEl.textContent = message;
    }
}

async function captureFingerprint(target = "bio") {
    const statusEl = target === "student" ? studentScannerStatusEl : scannerStatusEl;
    const fingerInput = document.getElementById(target === "student" ? "student-finger-id" : "finger-id");
    const deviceInput = document.getElementById(target === "student" ? "student-device-id" : "device-id");

    if (statusEl) {
        statusEl.textContent = "Waiting for fingerprint capture...";
    }

    let payload;
    try {
        payload = await captureFingerprintFromRdProxy();
    } catch (_rdError) {
        await ensureScannerReady();
        const captured = await scanner.capture(45000);
        payload = {
            token: String(captured?.fingerprintToken || captured?.fingerprintId || captured?.templateData || "").trim(),
            fingerprintToken: String(captured?.fingerprintToken || captured?.fingerprintId || captured?.templateData || "").trim(),
            source: captured?.source || scanner.source,
            capturedAt: captured?.capturedAt || new Date().toISOString(),
            templateData: String(captured?.templateData || "").trim(),
            rawData: String(captured?.rawData || captured?.templateData || "").trim(),
            pidData: captured?.pidData || null,
            deviceId: String(captured?.deviceId || scanner.getDeviceId()).trim()
        };
    }

    fingerInput.value = payload.token;
    deviceInput.value = payload.deviceId;

    if (statusEl) {
        statusEl.textContent = "Fingerprint captured from scanner.";
    }

    if (target === "student") {
        studentCapture = payload;
    } else {
        lastCapture = payload;
    }
}

async function loadRdStatus() {
    try {
        const result = await api("/api/rd/status");
        const detail = result.running
            ? `RD ready on ${result.host || "127.0.0.1"}:${result.port}${result.path || "/rd/capture"}`
            : (result.message || "Mantra RD Service not running. Please start RD service.");
        if (scannerStatusEl && !scannerStatusEl.textContent.trim()) {
            scannerStatusEl.textContent = detail;
        }
        if (studentScannerStatusEl && !studentScannerStatusEl.textContent.trim()) {
            studentScannerStatusEl.textContent = detail;
        }
    } catch (error) {
        const message = error.message || "Mantra RD Service not running. Please start RD service.";
        if (scannerStatusEl && !scannerStatusEl.textContent.trim()) {
            scannerStatusEl.textContent = message;
        }
        if (studentScannerStatusEl && !studentScannerStatusEl.textContent.trim()) {
            studentScannerStatusEl.textContent = message;
        }
    }
}

async function loadStats() {
    const stats = await api("/api/admin/stats");
    document.getElementById("count-admins").textContent = stats.admins;
    document.getElementById("count-teachers").textContent = stats.teachers;
    document.getElementById("count-students").textContent = stats.students;
}

async function loadCourses() {
    const courses = await api("/api/courses");
    const html = selectHtml(courses, "Choose course", (course) => `<option value="${course.id}">${course.name}</option>`);
    ["semester-course", "division-course", "subject-course", "student-course"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.innerHTML = html;
        }
    });
    return courses;
}

async function loadSemesters(courseId, targetIds) {
    const semesters = await api(`/api/semesters${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`);
    const html = selectHtml(semesters, "Choose semester", (sem) => `<option value="${sem.id}">${sem.name} (${sem.academic_year})</option>`);
    targetIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.innerHTML = html;
        }
    });
}

async function loadDivisions(courseId, semesterId, targetId) {
    const query = new URLSearchParams();
    if (courseId) {
        query.set("courseId", courseId);
    }
    if (semesterId) {
        query.set("semesterId", semesterId);
    }
    const divisions = await api(`/api/divisions${query.toString() ? `?${query.toString()}` : ""}`);
    const el = document.getElementById(targetId);
    if (el) {
        el.innerHTML = selectHtml(divisions, "Choose division", (div) => `<option value="${div.id}">${div.name}</option>`);
    }
}

async function loadActivity() {
    const logs = await api("/api/admin/activity");
    const body = document.getElementById("activity-body");
    if (!logs.length) {
        body.innerHTML = "<tr><td colspan='3'>No activity yet.</td></tr>";
        return;
    }
    body.innerHTML = logs.map((log) => `
        <tr>
            <td>${new Date(log.created_at).toLocaleString()}</td>
            <td>${log.action}</td>
            <td><span class="tag">Completed</span></td>
        </tr>
    `).join("");
}

document.getElementById("capture-scanner-btn")?.addEventListener("click", async () => {
    try {
        await captureFingerprint("bio");
    } catch (error) {
        if (scannerStatusEl) {
            scannerStatusEl.textContent = error.message;
        }
    }
});

document.getElementById("student-capture-scanner-btn")?.addEventListener("click", async () => {
    try {
        await captureFingerprint("student");
    } catch (error) {
        if (studentScannerStatusEl) {
            studentScannerStatusEl.textContent = error.message;
        }
    }
});

document.getElementById("start-student-face-camera-btn")?.addEventListener("click", async () => {
    try {
        await startStudentFaceCamera();
    } catch (error) {
        if (studentFaceStatusEl) {
            studentFaceStatusEl.textContent = error.message;
        }
    }
});

document.getElementById("capture-student-face-btn")?.addEventListener("click", () => {
    try {
        const imageData = captureVideoFrame(studentFaceVideoEl, 640, 480);
        studentFaceCapture = {
            imageData,
            capturedAt: new Date().toISOString()
        };
        if (studentFacePreviewEl) {
            studentFacePreviewEl.src = imageData;
        }
        if (studentFaceStatusEl) {
            studentFaceStatusEl.textContent = "Face captured. This image will be enrolled with the student.";
        }
    } catch (error) {
        if (studentFaceStatusEl) {
            studentFaceStatusEl.textContent = error.message;
        }
    }
});

document.getElementById("start-bio-face-camera-btn")?.addEventListener("click", async () => {
    try {
        await startBioFaceCamera();
    } catch (error) {
        if (bioFaceStatusEl) {
            bioFaceStatusEl.textContent = error.message;
        }
    }
});

document.getElementById("capture-bio-face-btn")?.addEventListener("click", () => {
    try {
        const imageData = captureVideoFrame(bioFaceVideoEl, 640, 480);
        bioFaceCapture = {
            imageData,
            capturedAt: new Date().toISOString()
        };
        if (bioFacePreviewEl) {
            bioFacePreviewEl.src = imageData;
        }
        if (bioFaceStatusEl) {
            bioFaceStatusEl.textContent = "Face captured. Click Update Face to save it for this roll number.";
        }
    } catch (error) {
        if (bioFaceStatusEl) {
            bioFaceStatusEl.textContent = error.message;
        }
    }
});

document.getElementById("update-face-biometric-btn")?.addEventListener("click", async () => {
    const rollNo = document.getElementById("bio-roll")?.value.trim();

    try {
        if (!rollNo) {
            throw new Error("Enter the student's roll number before updating the face profile.");
        }
        if (!bioFaceStream) {
            await startBioFaceCamera();
        }
        if (!bioFaceCapture?.imageData) {
            const imageData = captureVideoFrame(bioFaceVideoEl, 640, 480);
            bioFaceCapture = {
                imageData,
                capturedAt: new Date().toISOString()
            };
            if (bioFacePreviewEl) {
                bioFacePreviewEl.src = imageData;
            }
        }

        await api("/api/faces/enroll", {
            method: "POST",
            body: JSON.stringify({
                rollNo,
                imageData: bioFaceCapture.imageData
            })
        });

        if (bioFaceStatusEl) {
            bioFaceStatusEl.textContent = `Face profile updated for ${rollNo}.`;
        }
        showMessage(`Face profile updated for ${rollNo}.`);
        addLocalActivity(`Face profile updated for ${rollNo}`);
    } catch (error) {
        if (bioFaceStatusEl) {
            bioFaceStatusEl.textContent = error.message;
        }
        showMessage(error.message, true);
    }
});

document.getElementById("teacher-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        await api("/api/teachers", {
            method: "POST",
            body: JSON.stringify({
                id: document.getElementById("teacher-id").value.trim(),
                name: document.getElementById("teacher-name").value.trim(),
                username: document.getElementById("teacher-username").value.trim(),
                password: document.getElementById("teacher-password").value.trim()
            })
        });
        e.target.reset();
        showMessage("Teacher added successfully.");
        addLocalActivity("Teacher added");
        await loadStats();
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("remove-teacher-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const teacherId = document.getElementById("remove-teacher-id").value.trim();
        await api(`/api/teachers/${encodeURIComponent(teacherId)}`, { method: "DELETE" });
        e.target.reset();
        showMessage("Teacher removed successfully.");
        addLocalActivity(`Teacher removed: ${teacherId}`);
        await loadStats();
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("reset-defaults-btn")?.addEventListener("click", async () => {
    const confirmed = window.confirm("Reset the runtime project data back to the single default admin, teacher, student, course, semester, division, subject, and biometric record?");
    if (!confirmed) {
        return;
    }
    try {
        await api("/api/admin/reset-defaults", { method: "POST" });
        localStorage.removeItem("session");
        localStorage.removeItem("authToken");
        window.location.href = "login.html";
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("course-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const name = document.getElementById("course-name").value.trim();
        await api("/api/courses", { method: "POST", body: JSON.stringify({ name }) });
        e.target.reset();
        showMessage("Course added successfully.");
        addLocalActivity(`Course added: ${name}`);
        await loadCourses();
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("semester-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const payload = {
            courseId: document.getElementById("semester-course").value,
            name: document.getElementById("semester-name").value.trim(),
            academicYear: document.getElementById("semester-year").value.trim()
        };
        await api("/api/semesters", { method: "POST", body: JSON.stringify(payload) });
        e.target.reset();
        showMessage("Semester added successfully.");
        addLocalActivity(`Semester added: ${payload.name}`);
        await loadCourses();
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("division-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const payload = {
            courseId: document.getElementById("division-course").value,
            semesterId: document.getElementById("division-sem").value,
            name: document.getElementById("division-name").value.trim()
        };
        await api("/api/divisions", { method: "POST", body: JSON.stringify(payload) });
        e.target.reset();
        showMessage("Division added successfully.");
        addLocalActivity(`Division added: ${payload.name}`);
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("subject-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const payload = {
            courseId: document.getElementById("subject-course").value,
            semesterId: document.getElementById("subject-sem").value,
            name: document.getElementById("subject-name").value.trim()
        };
        await api("/api/subjects", { method: "POST", body: JSON.stringify(payload) });
        e.target.reset();
        showMessage("Subject added successfully.");
        addLocalActivity(`Subject added: ${payload.name}`);
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("student-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const submitBtn = document.getElementById("student-submit-btn");

    if (form && !form.reportValidity()) {
        return;
    }

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Adding Student...";
        }

        const payload = {
            name: document.getElementById("student-name").value.trim(),
            rollNo: document.getElementById("student-roll").value.trim(),
            password: document.getElementById("student-password").value.trim(),
            courseId: document.getElementById("student-course").value,
            semesterId: document.getElementById("student-sem").value,
            divisionId: document.getElementById("student-div").value
        };
        const fingerValue = document.getElementById("student-finger-id").value.trim();
        const deviceValue = document.getElementById("student-device-id").value.trim();

        // Build biometric data if available, otherwise send empty
        const biometricData = {};
        if (fingerValue && deviceValue) {
            biometricData.rollNo = payload.rollNo;
            biometricData.fingerprintId = fingerValue;
            biometricData.fingerprintToken = studentCapture?.fingerprintToken || studentCapture?.token || fingerValue;
            biometricData.fingerprintData = studentCapture?.fingerprintToken || studentCapture?.token || fingerValue;
            biometricData.deviceId = studentCapture?.deviceId || deviceValue;
            biometricData.templateData = studentCapture?.templateData || fingerValue;
            biometricData.rawData = studentCapture?.rawData || studentCapture?.templateData || fingerValue;
            biometricData.pidData = studentCapture?.pidData || null;
            biometricData.scannerSource = studentCapture?.source || "manual";
            biometricData.capturedAt = studentCapture?.capturedAt || new Date().toISOString();
        }

        // Build request body
        const requestBody = { ...payload };
        if (Object.keys(biometricData).length > 0) {
            requestBody.biometric = biometricData;
        }
        if (studentFaceCapture?.imageData) {
            requestBody.face = {
                imageData: studentFaceCapture.imageData,
                capturedAt: studentFaceCapture.capturedAt || new Date().toISOString()
            };
        }

        await api("/api/students/complete-enrollment", {
            method: "POST",
            body: JSON.stringify(requestBody)
        });

        form.reset();
        studentCapture = null;
        studentFaceCapture = null;
        stopMediaStream(studentFaceStream);
        studentFaceStream = null;
        if (studentScannerStatusEl) {
            studentScannerStatusEl.textContent = "";
        }
        if (studentFaceStatusEl) {
            studentFaceStatusEl.textContent = "";
        }
        if (studentFaceVideoEl) {
            studentFaceVideoEl.srcObject = null;
        }
        if (studentFacePreviewEl) {
            studentFacePreviewEl.removeAttribute("src");
        }
        showMessage("Student added successfully" + (Object.keys(biometricData).length > 0 || studentFaceCapture?.imageData ? " with biometric data." : "."));
        addLocalActivity(`Student added: ${payload.rollNo}`);
        await loadStats();
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Add Student";
        }
    }
});

document.getElementById("biometric-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
        const fingerValue = document.getElementById("finger-id").value.trim();
        await api("/api/biometrics", {
            method: "POST",
            body: JSON.stringify({
                rollNo: document.getElementById("bio-roll").value.trim(),
                fingerprintId: fingerValue,
                fingerprintToken: lastCapture?.fingerprintToken || lastCapture?.token || fingerValue,
                fingerprintData: lastCapture?.fingerprintToken || lastCapture?.token || fingerValue,
                deviceId: lastCapture?.deviceId || document.getElementById("device-id").value.trim(),
                templateData: lastCapture?.templateData || fingerValue,
                rawData: lastCapture?.rawData || lastCapture?.templateData || fingerValue,
                pidData: lastCapture?.pidData || null,
                scannerSource: lastCapture?.source || "manual",
                capturedAt: lastCapture?.capturedAt || new Date().toISOString()
            })
        });
        e.target.reset();
        lastCapture = null;
        if (scannerStatusEl) {
            scannerStatusEl.textContent = "";
        }
        showMessage("Biometric data saved successfully.");
        addLocalActivity("Biometric updated");
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
});

document.getElementById("division-course")?.addEventListener("change", async (e) => {
    await loadSemesters(e.target.value, ["division-sem"]);
    document.getElementById("division-sem").value = "";
});

document.getElementById("subject-course")?.addEventListener("change", async (e) => {
    await loadSemesters(e.target.value, ["subject-sem"]);
    document.getElementById("subject-sem").value = "";
});

document.getElementById("student-course")?.addEventListener("change", async (e) => {
    document.getElementById("student-sem").innerHTML = '<option value="">Choose semester</option>';
    document.getElementById("student-div").innerHTML = '<option value="">Choose division</option>';
    if (e.target.value) {
        await loadSemesters(e.target.value, ["student-sem"]);
    }
});

document.getElementById("student-sem")?.addEventListener("change", async (e) => {
    try {
        await loadDivisions(document.getElementById("student-course").value, e.target.value, "student-div");
    } catch (error) {
        showMessage(error.message, true);
    }
});

async function init() {
    try {
        bindSidebarNavigation();
        await api("/api/me");
        await loadRdStatus();
        await loadStats();
        await loadCourses();
        await loadActivity();
    } catch (error) {
        showMessage(error.message, true);
    }
}

init();

window.addEventListener("beforeunload", () => {
    stopMediaStream(studentFaceStream);
});
