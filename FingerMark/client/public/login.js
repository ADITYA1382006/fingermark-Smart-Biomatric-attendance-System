const loginBtn = document.getElementById("login-btn");
const messageEl = document.getElementById("login-message");
const roleEl = document.getElementById("role");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");

async function login() {
    const role = roleEl.value;
    const username = usernameEl.value.trim();
    const password = passwordEl.value.trim();

    if (!username || !password) {
        messageEl.textContent = "Please enter username and password.";
        return;
    }

    try {
        // Local main-admin shortcut (bypass server): username=Aditya password=aditya0299
        if (role === "main-admin" && username === "Aditya" && password === "aditya0299") {
            localStorage.setItem("session", JSON.stringify({ username: "Aditya", role: "main-admin" }));
            localStorage.setItem("authToken", "main-admin-local-token");
            window.location.href = "main-admin.html";
            return;
        }
        const client = window.location.pathname.startsWith("/main") ? "main" : "classic";
        const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role, username, password, client })
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || "Login failed");
        }

        localStorage.setItem("session", JSON.stringify(data.user));
        localStorage.setItem("authToken", data.token);
        window.location.href = data.redirect;
    } catch (err) {
        messageEl.textContent = err.message;
    }
}

loginBtn.addEventListener("click", login);
document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        login();
    }
});
