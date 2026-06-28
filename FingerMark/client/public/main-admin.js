const session = JSON.parse(localStorage.getItem("session") || "null");
const token = localStorage.getItem("authToken");

const mainMsg = document.getElementById("main-msg");
const authArea = document.getElementById("auth-area");
const controlsArea = document.getElementById("controls-area");
const rdServiceStatusEl = document.getElementById("rd-service-status");

function showMessage(msg, isError = false) {
    mainMsg.textContent = msg;
    mainMsg.style.color = isError ? "#ff4d4d" : "#7CFC00";
}

function isMainAdminSession() {
    const s = JSON.parse(localStorage.getItem("session") || "null");
    const t = localStorage.getItem("authToken");
    return s && s.username === "Aditya" && s.role === "main-admin" && t === "main-admin-local-token";
}

function requireAuthUI() {
    if (isMainAdminSession()) {
        authArea.style.display = "none";
        controlsArea.style.display = "block";
        showMessage("Authenticated as main admin.");
    } else {
        authArea.style.display = "block";
        controlsArea.style.display = "none";
        showMessage("");
    }
}

document.getElementById("main-login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const user = document.getElementById("main-username").value.trim();
    const pass = document.getElementById("main-password").value.trim();
    if (user === "Aditya" && pass === "aditya0299") {
        localStorage.setItem("session", JSON.stringify({ username: "Aditya", role: "main-admin" }));
        localStorage.setItem("authToken", "main-admin-local-token");
        requireAuthUI();
        return;
    }
    showMessage("Invalid main admin credentials.", true);
});

document.getElementById("logout-link").addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem("session");
    localStorage.removeItem("authToken");
    window.location.href = "login.html";
});

async function api(url, options = {}) {
    const headers = { "Content-Type": "application/json" };
    const t = localStorage.getItem("authToken");
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(url, { headers, ...options });
    let data = null;
    try {
        data = await res.json();
    } catch (_error) {
    }
    if (!res.ok) {
        throw new Error(data?.error || data?.message || `Request failed with status ${res.status}`);
    }
    return data;
}

async function loadRdStatusForMain() {
    if (!rdServiceStatusEl) {
        return;
    }
    try {
        const data = await api("/api/rd/status");
        rdServiceStatusEl.textContent = data.running
            ? `RD ready on ${data.host}:${data.port}${data.path}`
            : "RD service not available.";
    } catch (error) {
        rdServiceStatusEl.textContent = error.message || "RD service not available.";
    }
}

function optionHtml(items, placeholder, formatter) {
    return [`<option value="">${placeholder}</option>`, ...items.map(formatter)].join('');
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
                const isVisible = entry.isIntersecting && entry.boundingClientRect.height > 0;
                if (isVisible) {
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
            if (section.offsetHeight > 0 && section.getBoundingClientRect().top - offset <= 0) {
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

// Add / Remove Admin
document.getElementById("add-admin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("add-admin-username").value.trim();
    const password = document.getElementById("add-admin-password").value.trim();
    try {
        await api('/api/admins', { method: 'POST', body: JSON.stringify({ username, password }) });
        e.target.reset();
        showMessage('Admin added');
    } catch (err) { showMessage(err.message, true); }
});

document.getElementById("remove-admin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("remove-admin-username").value.trim();
    try {
        await api(`/api/admins/${encodeURIComponent(username)}`, { method: 'DELETE' });
        e.target.reset();
        showMessage('Admin removed');
    } catch (err) { showMessage(err.message, true); }
});

// Teachers
document.getElementById("add-teacher-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("add-teacher-name").value.trim();
    const username = document.getElementById("add-teacher-username").value.trim();
    const password = document.getElementById("add-teacher-password").value.trim();
    try {
        await api('/api/teachers', { method: 'POST', body: JSON.stringify({ name, username, password }) });
        e.target.reset();
        showMessage('Teacher added');
    } catch (err) { showMessage(err.message, true); }
});

document.getElementById("remove-teacher-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("remove-teacher-username").value.trim();
    try {
        await api(`/api/teachers/${encodeURIComponent(username)}`, { method: 'DELETE' });
        e.target.reset();
        showMessage('Teacher removed');
    } catch (err) { showMessage(err.message, true); }
});

// Students
document.getElementById("add-student-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("add-student-name").value.trim();
    const roll = document.getElementById("add-student-roll").value.trim();
    const password = document.getElementById("add-student-password").value.trim();
    const courseId = document.getElementById("add-student-course").value;
    const semesterId = document.getElementById("add-student-semester").value;
    const divisionId = document.getElementById("add-student-division").value;
    try {
        await api('/api/students', { method: 'POST', body: JSON.stringify({ name, rollNo: roll, password, courseId, semesterId, divisionId }) });
        e.target.reset();
        showMessage('Student added');
    } catch (err) { showMessage(err.message, true); }
});

document.getElementById("remove-student-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const roll = document.getElementById("remove-student-roll").value.trim();
    try {
        await api(`/api/students/${encodeURIComponent(roll)}`, { method: 'DELETE' });
        e.target.reset();
        showMessage('Student removed');
    } catch (err) { showMessage(err.message, true); }
});

document.getElementById("reset-project-btn")?.addEventListener("click", async () => {
    const confirmed = window.confirm("Reset the full runtime project data back to the single default dataset?");
    if (!confirmed) {
        return;
    }
    try {
        await api('/api/admin/reset-defaults', { method: 'POST' });
        showMessage('Project reset to defaults. Please login again.');
        localStorage.removeItem("session");
        localStorage.removeItem("authToken");
        window.location.href = "login.html";
    } catch (err) {
        showMessage(err.message, true);
    }
});

document.getElementById("refresh-rd-status-btn")?.addEventListener("click", loadRdStatusForMain);

// Load divisions for change-division form
async function loadDivisionsForMain() {
    try {
        const divisions = await api('/api/divisions');
        const sel = document.getElementById('change-division-select');
        if (!sel) return;
        sel.innerHTML = ['<option value="">Choose division</option>', ...divisions.map(d => `<option value="${d.id}">${d.name} (${d.semester_name || ''})</option>`)].join('');
    } catch (err) {
        // ignore
    }
}

async function loadCoursesForMain() {
    try {
        const courses = await api('/api/courses');
        const courseSel = document.getElementById('add-student-course');
        if (courseSel) {
            courseSel.innerHTML = optionHtml(courses, 'Choose course', c => `<option value="${c.id}">${c.name}</option>`);
        }
    } catch (_err) {
    }
}

async function loadSemestersForMain(courseId) {
    try {
        const semesters = await api(`/api/semesters?courseId=${encodeURIComponent(courseId)}`);
        const semSel = document.getElementById('add-student-semester');
        if (semSel) {
            semSel.innerHTML = optionHtml(semesters, 'Choose semester', s => `<option value="${s.id}">${s.name} (${s.academic_year})</option>`);
        }
    } catch (_err) {
    }
}

async function loadFilteredDivisionsForMain(courseId, semesterId) {
    try {
        const query = new URLSearchParams();
        if (courseId) query.set('courseId', courseId);
        if (semesterId) query.set('semesterId', semesterId);
        const divisions = await api(`/api/divisions?${query.toString()}`);
        const divSel = document.getElementById('add-student-division');
        if (divSel) {
            divSel.innerHTML = optionHtml(divisions, 'Choose division', d => `<option value="${d.id}">${d.name}</option>`);
        }
    } catch (_err) {
    }
}

document.getElementById('change-division-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const roll = document.getElementById('change-division-roll').value.trim();
    const divisionId = document.getElementById('change-division-select').value;
    if (!roll || !divisionId) { showMessage('Provide roll and division', true); return; }
    try {
        await api(`/api/students/${encodeURIComponent(roll)}/division`, { method: 'PUT', body: JSON.stringify({ divisionId }) });
        e.target.reset();
        showMessage('Student division updated');
    } catch (err) { showMessage(err.message, true); }
});

// initialize divisions
bindSidebarNavigation();
loadDivisionsForMain();
loadCoursesForMain();

document.getElementById('add-student-course')?.addEventListener('change', async (e) => {
    const courseId = e.target.value;
    const semSel = document.getElementById('add-student-semester');
    const divSel = document.getElementById('add-student-division');
    if (semSel) semSel.innerHTML = '<option value="">Choose semester</option>';
    if (divSel) divSel.innerHTML = '<option value="">Choose division</option>';
    if (!courseId) return;
    await loadSemestersForMain(courseId);
});

document.getElementById('add-student-semester')?.addEventListener('change', async (e) => {
    const courseId = document.getElementById('add-student-course').value;
    const semesterId = e.target.value;
    const divSel = document.getElementById('add-student-division');
    if (divSel) divSel.innerHTML = '<option value="">Choose division</option>';
    if (!courseId || !semesterId) return;
    await loadFilteredDivisionsForMain(courseId, semesterId);
});

requireAuthUI();
loadRdStatusForMain();
