const session = JSON.parse(localStorage.getItem("session") || "null");
const token = localStorage.getItem("authToken");

if (!session || session.role !== "student" || !token) {
    window.location.href = "login.html";
}

const messageEl = document.getElementById("student-message");

function showMessage(message, isError = false) {
    messageEl.textContent = message;
    messageEl.style.color = isError ? "#ff9494" : "#91f2c5";
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

function statusClass(status) {
    return status === "Present" ? "present" : "absent";
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

function renderHeatmap(calendarRows) {
    const grid = document.getElementById("attendance-heatmap-grid");
    if (!calendarRows || !calendarRows.length) {
        grid.innerHTML = "<p class='empty-text'>No attendance history available yet.</p>";
        return;
    }

    const grouped = new Map();
    calendarRows.forEach((row) => {
        const key = row.attendance_date;
        const entry = grouped.get(key) || { total: 0, present: 0 };
        entry.total += 1;
        if (row.final_status === "Present") {
            entry.present += 1;
        }
        grouped.set(key, entry);
    });

    const dates = Array.from(grouped.keys()).sort();
    const end = new Date(dates[dates.length - 1]);
    const start = new Date(end);
    start.setDate(end.getDate() - 139);

    const cells = [];
    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const key = cursor.toISOString().slice(0, 10);
        const data = grouped.get(key);
        let level = 0;
        if (data) {
            const ratio = data.present / data.total;
            level = ratio === 1 ? 3 : ratio > 0 ? 2 : 1;
        }
        cells.push(`
            <div class="heat-cell level-${level}" title="${key}${data ? ` | ${data.present}/${data.total} present lectures` : " | No lecture"}"></div>
        `);
    }

    grid.innerHTML = cells.join("");
}

async function loadDashboard() {
    const data = await api(`/api/student/dashboard/${session.id}`);

    document.getElementById("profile-name").textContent = data.student.name || "-";
    document.getElementById("profile-roll").textContent = data.student.roll_no || "-";
    document.getElementById("profile-course").textContent = data.student.course_name || "-";
    document.getElementById("profile-semester").textContent = data.student.semester_name || "-";
    document.getElementById("profile-division").textContent = data.student.division_name || "-";

    document.getElementById("today-status").textContent = data.stats.todayStatus;
    document.getElementById("today-status").className = statusClass(data.stats.todayStatus);
    document.getElementById("attendance-percent").textContent = `${data.stats.percentage}%`;
    document.getElementById("lecture-count").textContent = `${data.stats.present} / ${data.stats.total}`;

    const body = document.getElementById("attendance-body");
    if (!data.recent.length) {
        body.innerHTML = "<tr><td colspan='3'>No attendance records yet.</td></tr>";
    } else {
        body.innerHTML = data.recent.map((row) => `
            <tr>
                <td>${row.attendance_date}</td>
                <td>${row.subject}</td>
                <td class="${statusClass(row.final_status)}">${row.final_status}</td>
            </tr>
        `).join("");
    }

    renderHeatmap(data.calendar || []);
}

async function loadNotifications() {
    const list = document.getElementById("notification-list");
    try {
        const notes = await api(`/api/student/notifications/${session.id}`);
        if (!notes.length) {
            list.innerHTML = "<tr><td colspan='4'>No notifications.</td></tr>";
            return;
        }
        list.innerHTML = notes.map((note) => `
            <tr>
                <td>${new Date(note.created_at).toLocaleString()}</td>
                <td>${note.subject || "-"}</td>
                <td>${note.source || "-"}</td>
                <td>${note.message}</td>
            </tr>
        `).join("");
    } catch (error) {
        list.innerHTML = "<tr><td colspan='4'>Unable to load notifications.</td></tr>";
    }
}

api("/api/me")
    .then(async () => {
        bindSidebarNavigation();
        await loadDashboard();
        await loadNotifications();
    })
    .catch((error) => showMessage(error.message, true));
