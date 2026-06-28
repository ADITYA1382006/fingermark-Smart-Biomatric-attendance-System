const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { promisify } = require("util");
const express = require("express");
const compression = require("compression");
const sqlite3 = require("sqlite3").verbose();
const faceRecognition = require("./face-recognition");

const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 3000;

const CLASSIC_DIR = __dirname;
const MAIN_DIR = path.join(__dirname, "..", "minor-project--main");
const PRIMARY_DB_PATH = path.join(__dirname, "attendance.db");
const RUNTIME_DB_PATH = path.join(__dirname, "attendance.runtime.db");

function cloneDbIfNeeded(sourcePath, targetPath) {
    if (fs.existsSync(targetPath)) {
        return targetPath;
    }

    if (!fs.existsSync(sourcePath)) {
        return targetPath;
    }

    fs.copyFileSync(sourcePath, targetPath);
    const suffixes = ["-wal", "-shm"];
    for (const suffix of suffixes) {
        const sourceSidecar = `${sourcePath}${suffix}`;
        const targetSidecar = `${targetPath}${suffix}`;
        if (fs.existsSync(sourceSidecar)) {
            fs.copyFileSync(sourceSidecar, targetSidecar);
        } else if (fs.existsSync(targetSidecar)) {
            fs.unlinkSync(targetSidecar);
        }
    }
    return targetPath;
}

const DB_PATH = (() => {
    try {
        return cloneDbIfNeeded(PRIMARY_DB_PATH, RUNTIME_DB_PATH);
    } catch (_error) {
        return PRIMARY_DB_PATH;
    }
})();

const db = new sqlite3.Database(DB_PATH);

const DEFAULT_DATA = {
    admin: {
        username: "admin",
        password: "admin123"
    },
    teacher: {
        name: "Default Teacher",
        username: "teacher1",
        password: "teacher123"
    },
    student: {
        name: "Default Student",
        rollNo: "24CS101",
        password: "student123"
    },
    course: {
        name: "B.Tech Computer Science"
    },
    semester: {
        name: "Semester 1",
        academicYear: "2026-27"
    },
    division: {
        name: "Division A"
    },
    subject: {
        name: "Data Structures"
    },
    biometric: {
        token: "FP-1001",
        deviceId: "SCN-01"
    }
};

app.use(compression());
app.use(express.json({ limit: "1mb" }));

const staticOptions = {
    etag: true,
    maxAge: 0,
    setHeaders(res) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
    }
};

app.use("/classic", express.static(CLASSIC_DIR, staticOptions));
app.use("/main", express.static(MAIN_DIR, staticOptions));
app.use(express.static(CLASSIC_DIR, staticOptions));

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(rows);
        });
    });
}

function todayDate() {
    return new Date().toISOString().slice(0, 10);
}

function normalizeFingerprintPayload(value) {
    return String(value || "").trim();
}

function fingerprintHash(value) {
    return crypto.createHash("sha256").update(normalizeFingerprintPayload(value), "utf8").digest("hex");
}

function parseJsonArray(value) {
    if (!value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
        return [];
    }
}

function getBiometricEncryptionKey() {
    const seed = process.env.BIOMETRIC_SECRET
        || process.env.AUTH_SECRET
        || `${DB_PATH}:${os.hostname()}:fingermark-local-key`;
    return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function encryptBiometricValue(value) {
    const normalized = String(value || "");
    if (!normalized) {
        return "";
    }
    if (normalized.startsWith("enc:v1:")) {
        return normalized;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getBiometricEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptBiometricValue(value) {
    const normalized = String(value || "");
    if (!normalized || !normalized.startsWith("enc:v1:")) {
        return normalized;
    }

    const [, , ivBase64, tagBase64, dataBase64] = normalized.split(":");
    if (!ivBase64 || !tagBase64 || !dataBase64) {
        return "";
    }

    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            getBiometricEncryptionKey(),
            Buffer.from(ivBase64, "base64")
        );
        decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(dataBase64, "base64")),
            decipher.final()
        ]);
        return decrypted.toString("utf8");
    } catch (_error) {
        return "";
    }
}

function parseEncryptedJsonArray(value) {
    return parseJsonArray(decryptBiometricValue(value));
}

function isXmlFingerprintPayload(value) {
    const normalized = normalizeFingerprintPayload(value);
    return normalized.startsWith("<") && normalized.endsWith(">");
}

function isIncompleteFingerprintPayload(value) {
    const normalized = normalizeFingerprintPayload(value);
    return normalized === '<?xml version="1.0"?>' || (normalized.startsWith("<?xml") && normalized.length < 80);
}

function extractXmlAttribute(xml, attributeName) {
    const match = String(xml || "").match(new RegExp(`${attributeName}="([^"]*)"`, "i"));
    return match ? match[1] : "";
}

function extractXmlTag(xml, tagName) {
    const match = String(xml || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
    return match ? match[1].trim() : "";
}

function parsePidXml(xml) {
    const normalized = normalizeFingerprintPayload(xml);
    if (!normalized || !normalized.startsWith("<")) {
        return null;
    }

    return {
        errCode: extractXmlAttribute(normalized, "errCode"),
        errInfo: extractXmlAttribute(normalized, "errInfo"),
        qScore: extractXmlAttribute(normalized, "qScore"),
        dataType: extractXmlAttribute(normalized, "type"),
        pidBlock: extractXmlTag(normalized, "Data"),
        hmac: extractXmlTag(normalized, "Hmac"),
        skey: extractXmlTag(normalized, "Skey"),
        deviceInfo: {
            dpId: extractXmlAttribute(normalized, "dpId"),
            rdsId: extractXmlAttribute(normalized, "rdsId"),
            rdsVer: extractXmlAttribute(normalized, "rdsVer"),
            mi: extractXmlAttribute(normalized, "mi"),
            mc: extractXmlAttribute(normalized, "mc"),
            dc: extractXmlAttribute(normalized, "dc")
        }
    };
}

function generateFingerprintToken(pidData, fallbackValue = "") {
    const dataValue = normalizeFingerprintPayload(pidData?.pidBlock);
    const hmacValue = normalizeFingerprintPayload(pidData?.hmac);
    if (dataValue && hmacValue) {
        return fingerprintHash(`${dataValue}${hmacValue}`);
    }
    return fallbackValue ? fingerprintHash(fallbackValue) : "";
}

function buildFingerprintCandidates({ fingerprintId, templateData, rawData, pidData }) {
    const candidates = new Set();
    const fingerprintToken = generateFingerprintToken(
        pidData,
        normalizeFingerprintPayload(templateData || rawData || fingerprintId)
    );
    const values = [
        fingerprintToken,
        normalizeFingerprintPayload(fingerprintId),
        normalizeFingerprintPayload(templateData),
        normalizeFingerprintPayload(rawData),
        normalizeFingerprintPayload(pidData?.pidBlock),
        normalizeFingerprintPayload(pidData?.hmac)
    ];

    for (const value of values) {
        if (!value) {
            continue;
        }
        candidates.add(value);
    }

    return Array.from(candidates);
}

const RD_DISCOVERY_HOSTS = Array.from(new Set([
    process.env.RD_HOST,
    "127.0.0.1",
    "localhost"
].filter(Boolean)));
const RD_DISCOVERY_PORTS = Array.from(new Set([
    process.env.RD_PORT ? Number(process.env.RD_PORT) : null,
    11100, 11101, 11102, 11103, 11104, 11105,
    8005, 8006
].filter((value) => Number.isInteger(value) && value > 0)));
const RD_INFO_PATHS = ["/rd/info", "/info", "/getDeviceInfo", "/device/info"];
const RD_CAPTURE_PATHS = ["/rd/capture", "/capture"];
const RD_INFO_METHODS = ["DEVICEINFO", "GET"];
const RD_CAPTURE_METHODS = ["CAPTURE", "POST"];
const RD_CAPTURE_BODY = `<?xml version="1.0"?>
<PidOptions ver="1.0">
  <Opts
    env="P"
    fCount="1"
    fType="0"
    iCount="0"
    iType="0"
    pCount="0"
    pType="0"
    format="0"
    pidVer="2.0"
    timeout="10000"
    otp=""
    wadh=""
    posh="UNKNOWN"/>
  <Demo/>
  <CustOpts/>
</PidOptions>`;
let rdServiceCache = {
    host: null,
    port: null,
    infoPath: null,
    capturePath: null,
    checkedAt: 0
};

function requestRdService(host, port, routePath, options = {}) {
    const http = require("http");
    const method = options.method || "GET";
    const body = typeof options.body === "string" ? options.body : "";
    const headers = {
        ...(options.headers || {})
    };

    if (body && !headers["Content-Length"]) {
        headers["Content-Length"] = Buffer.byteLength(body, "utf8");
    }

    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: host,
            port,
            path: routePath,
            method,
            headers,
            timeout: options.timeout || 8000
        }, (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                text += chunk;
            });
            response.on("end", () => {
                resolve({
                    status: response.statusCode || 0,
                    text
                });
            });
        });

        request.on("error", reject);
        request.on("timeout", () => {
            request.destroy(new Error("RD request timeout"));
        });

        if (body) {
            request.write(body, "utf8");
        }
        request.end();
    });
}

async function discoverRdService(forceRefresh = false) {
    const cacheFresh = rdServiceCache.port && rdServiceCache.host && (Date.now() - rdServiceCache.checkedAt) < 15000;
    if (!forceRefresh && cacheFresh) {
        return rdServiceCache;
    }

    console.log("RD discovery started");
    for (const host of RD_DISCOVERY_HOSTS) {
        for (const port of RD_DISCOVERY_PORTS) {
            console.log(`Trying RD host ${host} port ${port}`);
            for (const infoPath of RD_INFO_PATHS) {
                for (const method of RD_INFO_METHODS) {
                    try {
                        const result = await requestRdService(host, port, infoPath, {
                            method,
                            headers: {
                                Accept: "text/xml, application/xml, text/plain, */*"
                            },
                            timeout: 3000
                        });

                        const payload = String(result.text || "").trim();
                        if (result.status >= 200 && result.status < 500 && payload) {
                            const version = extractXmlAttribute(payload, "rdsVer")
                                || extractXmlAttribute(payload, "ver")
                                || "unknown";
                            console.log(`RD service found on ${host}:${port}${infoPath} using ${method}`);
                            console.log("RD service version:", version);

                            rdServiceCache = {
                                host,
                                port,
                                infoPath,
                                capturePath: RD_CAPTURE_PATHS[0],
                                checkedAt: Date.now()
                            };
                            return rdServiceCache;
                        }
                    } catch (error) {
                        console.log(`RD info probe failed on ${host}:${port}${infoPath} via ${method}: ${error.message}`);
                    }
                }
            }

            for (const capturePath of RD_CAPTURE_PATHS) {
                for (const method of RD_CAPTURE_METHODS) {
                    try {
                        const result = await requestRdService(host, port, capturePath, {
                            method,
                            headers: {
                                "Content-Type": "text/xml"
                            },
                            body: RD_CAPTURE_BODY,
                            timeout: 4000
                        });
                        const payload = String(result.text || "").trim();
                        const pidData = parsePidXml(payload);
                        if (
                            (result.status >= 200 && result.status < 300 && payload)
                            || (payload && (pidData?.errCode || payload.startsWith("<")))
                        ) {
                            console.log(`RD capture probe found service on ${host}:${port}${capturePath} using ${method}`);
                            rdServiceCache = {
                                host,
                                port,
                                infoPath: null,
                                capturePath,
                                checkedAt: Date.now()
                            };
                            return rdServiceCache;
                        }
                    } catch (error) {
                        console.log(`RD capture probe failed on ${host}:${port}${capturePath} via ${method}: ${error.message}`);
                    }
                }
            }
        }
    }

    rdServiceCache = {
        host: null,
        port: null,
        infoPath: null,
        capturePath: null,
        checkedAt: Date.now()
    };
    return null;
}

async function captureFromRdService() {
    let rdService = await discoverRdService();
    if (!rdService) {
        throw new Error("Mantra RD Service not running. Please start RD service.");
    }

    let captureResult = null;
    let lastError = null;

    for (let pass = 0; pass < 2; pass += 1) {
        if (pass === 1) {
            rdService = await discoverRdService(true);
            if (!rdService) {
                break;
            }
        }

        for (const method of RD_CAPTURE_METHODS) {
            try {
                console.log(`Sending capture request via ${method}`);
                captureResult = await requestRdService(rdService.host, rdService.port, rdService.capturePath || RD_CAPTURE_PATHS[0], {
                    method,
                    headers: {
                        "Content-Type": "text/xml"
                    },
                    body: RD_CAPTURE_BODY,
                    timeout: 20000
                });
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (captureResult) {
            break;
        }
    }

    if (!captureResult) {
        throw lastError || new Error("Mantra RD Service not running. Please start RD service.");
    }

    console.log("RD capture response received");

    if (captureResult.status < 200 || captureResult.status >= 300) {
        const xmlError = normalizeFingerprintPayload(captureResult.text);
        throw new Error(xmlError || `RD capture failed with status ${captureResult.status}.`);
    }

    const pidXml = normalizeFingerprintPayload(captureResult.text);
    if (!pidXml) {
        throw new Error("RD service returned an empty capture response.");
    }

    const pidData = parsePidXml(pidXml);
    if (pidData?.errCode && pidData.errCode !== "0") {
        throw new Error(pidData.errInfo || `RD error ${pidData.errCode}`);
    }

    return {
        host: rdService.host,
        port: rdService.port,
        pidXml,
        pidData,
        fingerprintToken: generateFingerprintToken(pidData, pidXml),
        fingerprintId: generateFingerprintToken(pidData, pidXml),
        deviceId: pidData?.deviceInfo?.mi || pidData?.deviceInfo?.mc || "MANTRA-RD",
        capturedAt: new Date().toISOString()
    };
}

function buildFinalStatus(biometricPresent, manualPresent) {
    if (biometricPresent === 0 && manualPresent === 0) {
        return "Pending";
    }
    return biometricPresent === 1 && manualPresent === 1 ? "Present" : "Absent";
}

function nowPlusDays(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getBearerToken(req) {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) {
        return null;
    }
    return auth.slice(7).trim();
}

async function ensureColumn(tableName, columnName, columnSql) {
    const columns = await all(`PRAGMA table_info(${tableName})`);
    const exists = columns.some((col) => col.name === columnName);
    if (!exists) {
        await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
    }
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = await scryptAsync(password, salt, 64);
    return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function verifyPassword(stored, input) {
    if (!stored) {
        return false;
    }
    if (!stored.startsWith("scrypt$")) {
        return stored === input;
    }

    const parts = stored.split("$");
    if (parts.length !== 3) {
        return false;
    }

    const salt = parts[1];
    const expected = parts[2];
    const derived = await scryptAsync(input, salt, 64);
    const expectedBuffer = Buffer.from(expected, "hex");
    return expectedBuffer.length === derived.length && crypto.timingSafeEqual(expectedBuffer, derived);
}

async function verifyAndMigratePassword(role, userId, stored, input) {
    const matched = await verifyPassword(stored, input);
    if (!matched) {
        return false;
    }

    if (!stored.startsWith("scrypt$")) {
        const hashed = await hashPassword(input);
        if (role === "admin") {
            await run(`UPDATE admins SET password = ? WHERE id = ?`, [hashed, userId]);
        } else if (role === "teacher") {
            await run(`UPDATE teachers SET password = ? WHERE id = ?`, [hashed, userId]);
        } else {
            await run(`UPDATE students SET password = ? WHERE id = ?`, [hashed, userId]);
        }
    }

    return true;
}

async function createSession(userRole, userId) {
    const token = crypto.randomBytes(32).toString("hex");
    await run(
        `INSERT INTO sessions (token, user_role, user_id, expires_at) VALUES (?, ?, ?, ?)`,
        [token, userRole, userId, nowPlusDays(7)]
    );
    return token;
}

async function cleanupExpiredSessions() {
    await run(`DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP`);
}

function listRunningProcessNames() {
    try {
        const output = require("child_process")
            .execSync("tasklist /FO CSV /NH", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const match = line.match(/^"([^"]+)"/);
                return match ? match[1] : "";
            })
            .filter(Boolean);
    } catch (_error) {
        return [];
    }
}

function detectVendorScannerProcesses() {
    const processNames = listRunningProcessNames();
    const matches = processNames.filter((name) => /mantra|mfs|rdservice|bridgecommunication/i.test(name));
    return {
        running: matches.length > 0,
        processes: matches
    };
}

async function getSessionByToken(token) {
    return get(
        `SELECT token, user_role, user_id, expires_at
         FROM sessions
         WHERE token = ? AND expires_at > CURRENT_TIMESTAMP`,
        [token]
    );
}

function authRequired(roles = []) {
    return async (req, res, next) => {
        try {
            const token = getBearerToken(req);
            if (!token) {
                return res.status(401).json({ error: "Missing auth token." });
            }

            const session = await getSessionByToken(token);
            if (!session) {
                return res.status(401).json({ error: "Invalid or expired session." });
            }

            if (roles.length && !roles.includes(session.user_role)) {
                return res.status(403).json({ error: "Not allowed for this role." });
            }

            req.auth = {
                token,
                role: session.user_role,
                userId: session.user_id
            };
            next();
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };
}

function mainAdminRequired(req, res, next) {
    const token = getBearerToken(req);
    if (token !== "main-admin-local-token") {
        return res.status(403).json({ error: "Only main admin can perform this action." });
    }
    req.auth = {
        token,
        role: "main-admin",
        userId: null
    };
    next();
}

async function logActivity(actorRole, actorId, action) {
    await run(
        `INSERT INTO activity_logs (actor_role, actor_id, action) VALUES (?, ?, ?)`,
        [actorRole, actorId || null, action]
    );
}

async function createNotification(studentId, subject, source, message) {
    await run(
        `INSERT INTO notifications (student_id, subject, source, message) VALUES (?, ?, ?, ?)`,
        [studentId, subject || null, source || null, message]
    );
}

async function logBiometricAttempt({
    sessionId = null,
    teacherId = null,
    studentId = null,
    attemptType,
    outcome,
    message,
    metadata = null
}) {
    await run(
        `INSERT INTO biometric_attempts (session_id, teacher_id, student_id, attempt_type, outcome, message, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            sessionId,
            teacherId,
            studentId,
            attemptType,
            outcome,
            message,
            metadata ? JSON.stringify(metadata) : null
        ]
    );
}

async function resetToDefaultData() {
    await run(`DELETE FROM notifications`);
    await run(`DELETE FROM biometric_attempts`);
    await run(`DELETE FROM sessions`);
    await run(`DELETE FROM activity_logs`);
    await run(`DELETE FROM attendance`);
    await run(`DELETE FROM biometric_sessions`);
    await run(`DELETE FROM student_faces`);
    await run(`DELETE FROM biometrics`);
    await run(`DELETE FROM students`);
    await run(`DELETE FROM subjects`);
    await run(`DELETE FROM divisions`);
    await run(`DELETE FROM semesters`);
    await run(`DELETE FROM courses`);
    await run(`DELETE FROM teachers`);
    await run(`DELETE FROM admins`);

    await run(`DELETE FROM sqlite_sequence`);

    const adminInsert = await run(
        `INSERT INTO admins (username, password) VALUES (?, ?)`,
        [DEFAULT_DATA.admin.username, await hashPassword(DEFAULT_DATA.admin.password)]
    );

    const teacherInsert = await run(
        `INSERT INTO teachers (name, username, password) VALUES (?, ?, ?)`,
        [DEFAULT_DATA.teacher.name, DEFAULT_DATA.teacher.username, await hashPassword(DEFAULT_DATA.teacher.password)]
    );

    const courseInsert = await run(
        `INSERT INTO courses (name) VALUES (?)`,
        [DEFAULT_DATA.course.name]
    );

    const semesterInsert = await run(
        `INSERT INTO semesters (course_id, name, academic_year) VALUES (?, ?, ?)`,
        [courseInsert.id, DEFAULT_DATA.semester.name, DEFAULT_DATA.semester.academicYear]
    );

    const divisionInsert = await run(
        `INSERT INTO divisions (course_id, semester_id, name) VALUES (?, ?, ?)`,
        [courseInsert.id, semesterInsert.id, DEFAULT_DATA.division.name]
    );

    const subjectInsert = await run(
        `INSERT INTO subjects (course_id, semester_id, name) VALUES (?, ?, ?)`,
        [courseInsert.id, semesterInsert.id, DEFAULT_DATA.subject.name]
    );

    const studentInsert = await run(
        `INSERT INTO students (name, roll_no, password, course_id, semester_id, division_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [
            DEFAULT_DATA.student.name,
            DEFAULT_DATA.student.rollNo,
            await hashPassword(DEFAULT_DATA.student.password),
            courseInsert.id,
            semesterInsert.id,
            divisionInsert.id
        ]
    );

    await run(
        `UPDATE students
         SET fingerprint_data = ?
         WHERE id = ?`,
        [DEFAULT_DATA.biometric.token, studentInsert.id]
    );

    const templateHash = fingerprintHash(DEFAULT_DATA.biometric.token);
    await run(
        `INSERT INTO biometrics (student_id, fingerprint_id, device_id, template_hash, template_data, scanner_source, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            studentInsert.id,
            DEFAULT_DATA.biometric.token,
            DEFAULT_DATA.biometric.deviceId,
            templateHash,
            DEFAULT_DATA.biometric.token,
            "seed"
        ]
    );

    await logActivity("system", null, `Reset runtime data to defaults for admin ${adminInsert.id}, teacher ${teacherInsert.id}, subject ${subjectInsert.id}`);
}

async function seedDefaultDataIfEmpty() {
    const adminCount = await get(`SELECT COUNT(*) AS count FROM admins`);
    if ((adminCount?.count || 0) > 0) {
        return;
    }
    await resetToDefaultData();
}

async function getSubjectContext(subjectId) {
    return get(
        `SELECT sub.id,
                sub.name,
                sub.course_id,
                sub.semester_id,
                sem.name AS semester_name,
                sem.academic_year,
                sem.course_id AS semester_course_id,
                c.name AS course_name
         FROM subjects sub
         JOIN semesters sem ON sem.id = sub.semester_id
         JOIN courses c ON c.id = sub.course_id
         WHERE sub.id = ?`,
        [subjectId]
    );
}

async function getRunningSessionForTeacher(sessionId, teacherId) {
    return get(
        `SELECT bs.id, bs.teacher_id, bs.course_id, bs.semester_id, bs.division_id, bs.subject_id, bs.attendance_date,
                c.name AS course_name, sem.name AS semester_name, d.name AS division_name, sub.name AS subject_name
         FROM biometric_sessions bs
         JOIN courses c ON c.id = bs.course_id
         JOIN semesters sem ON sem.id = bs.semester_id
         JOIN divisions d ON d.id = bs.division_id
         JOIN subjects sub ON sub.id = bs.subject_id
         WHERE bs.id = ? AND bs.teacher_id = ? AND bs.status = 'running'`,
        [sessionId, teacherId]
    );
}

function mapStudentSummary(row) {
    return {
        id: row.student_id,
        name: row.name,
        rollNo: row.roll_no,
        branch: row.branch_name || "-",
        semester: row.semester_name || "-",
        division: row.division_name || "-"
    };
}

async function getStudentByRollNo(rollNo) {
    return get(
        `SELECT s.id, s.roll_no, s.name, s.course_id, s.semester_id, s.division_id,
                c.name AS branch_name, sem.name AS semester_name, d.name AS division_name
         FROM students s
         LEFT JOIN courses c ON c.id = s.course_id
         LEFT JOIN semesters sem ON sem.id = s.semester_id
         LEFT JOIN divisions d ON d.id = s.division_id
         WHERE s.roll_no = ?`,
        [rollNo]
    );
}

async function saveStudentBiometric({
    student,
    rollNo,
    fingerprintId,
    fingerprintToken,
    fingerprintData,
    deviceId,
    templateData,
    rawData,
    pidData,
    scannerSource,
    capturedAt
}) {
    const normalizedTemplate = normalizeFingerprintPayload(templateData || rawData || fingerprintId);
    const parsedPidData = pidData || parsePidXml(normalizedTemplate) || null;
    const normalizedFingerprintToken = normalizeFingerprintPayload(
        fingerprintToken
        || fingerprintData
        || generateFingerprintToken(parsedPidData, normalizedTemplate)
        || fingerprintId
    );

    if (!rollNo || !normalizedTemplate || !deviceId) {
        const error = new Error("Roll no, captured fingerprint data and device id are required.");
        error.statusCode = 400;
        throw error;
    }
    if (isIncompleteFingerprintPayload(normalizedTemplate)) {
        const error = new Error("Incomplete fingerprint capture. Please capture the fingerprint again.");
        error.statusCode = 400;
        throw error;
    }

    const conflictingStudentFingerprint = normalizedFingerprintToken
        ? await get(
            `SELECT id
             FROM students
             WHERE roll_no != ?
               AND fingerprint_data = ?`,
            [rollNo, normalizedFingerprintToken]
        )
        : null;
    if (conflictingStudentFingerprint) {
        const error = new Error("This fingerprint is already assigned to another student.");
        error.statusCode = 400;
        throw error;
    }

    const templateHash = fingerprintHash(normalizedTemplate);
    const candidateValues = buildFingerprintCandidates({
        fingerprintId: normalizedFingerprintToken,
        templateData: normalizedTemplate,
        rawData,
        pidData
    });
    const candidateHashes = candidateValues.map((value) => fingerprintHash(value));
    const conflictingBiometric = await get(
        `SELECT student_id
         FROM biometrics
         WHERE student_id != ?
           AND (
                template_hash IN (${candidateHashes.map(() => "?").join(", ")})
                OR (? != '' AND fingerprint_id = ?)
           )`,
        [student.id, ...candidateHashes, normalizedFingerprintToken, normalizedFingerprintToken]
    );
    if (conflictingBiometric) {
        const error = new Error("This fingerprint is already assigned to another student.");
        error.statusCode = 400;
        throw error;
    }

    const storedTemplate = encryptBiometricValue(normalizedTemplate);
    const existing = await get(`SELECT id FROM biometrics WHERE student_id = ?`, [student.id]);
    if (existing) {
        await run(
            `UPDATE biometrics
             SET fingerprint_id = ?, device_id = ?, template_hash = ?, template_data = ?, scanner_source = ?, captured_at = ?
             WHERE student_id = ?`,
            [normalizedFingerprintToken || templateHash.slice(0, 16), deviceId, templateHash, storedTemplate, scannerSource || null, capturedAt || null, student.id]
        );
    } else {
        await run(
            `INSERT INTO biometrics (student_id, fingerprint_id, device_id, template_hash, template_data, scanner_source, captured_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [student.id, normalizedFingerprintToken || templateHash.slice(0, 16), deviceId, templateHash, storedTemplate, scannerSource || null, capturedAt || null]
        );
    }

    await run(
        `UPDATE students
         SET fingerprint_data = ?
         WHERE id = ?`,
        [normalizedFingerprintToken || normalizedTemplate, student.id]
    );

    return {
        fingerprintToken: normalizedFingerprintToken || templateHash.slice(0, 16),
        deviceId,
        templateHash,
        scannerSource: scannerSource || null,
        capturedAt: capturedAt || null,
        pidData: parsedPidData
    };
}

async function saveStudentFaceProfile({ student, rollNo, imageData }) {
    if (!rollNo || !imageData) {
        const error = new Error("Roll no and captured face image are required.");
        error.statusCode = 400;
        throw error;
    }

    const analysis = await faceRecognition.analyzeFaceImage(imageData);
    const existingFaces = await all(
        `SELECT sf.student_id, sf.embedding_json, s.roll_no
         FROM student_faces sf
         JOIN students s ON s.id = sf.student_id
         WHERE sf.student_id != ?`,
        [student.id]
    );
    const rankedMatches = faceRecognition.compareEmbeddingToCandidates(
        analysis.embedding,
        existingFaces.map((entry) => ({
            studentId: entry.student_id,
            rollNo: entry.roll_no,
            embedding: parseEncryptedJsonArray(entry.embedding_json)
        }))
    );

    if (rankedMatches[0] && rankedMatches[0].similarity >= faceRecognition.DUPLICATE_ENROLL_THRESHOLD) {
        const error = new Error(`This face already looks enrolled for ${rankedMatches[0].rollNo}. Capture a clearer face image for the correct student.`);
        error.statusCode = 400;
        throw error;
    }

    const storedImage = encryptBiometricValue(analysis.imageData);
    const storedEmbedding = encryptBiometricValue(JSON.stringify(analysis.embedding));
    const existing = await get(`SELECT id FROM student_faces WHERE student_id = ?`, [student.id]);
    if (existing) {
        await run(
            `UPDATE student_faces
             SET image_data = ?, embedding_json = ?, detector_score = ?, captured_at = CURRENT_TIMESTAMP
             WHERE student_id = ?`,
            [storedImage, storedEmbedding, analysis.score, student.id]
        );
    } else {
        await run(
            `INSERT INTO student_faces (student_id, image_data, embedding_json, detector_score, captured_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [student.id, storedImage, storedEmbedding, analysis.score]
        );
    }

    return analysis;
}

async function matchFingerprintForSession({ sessionId, teacherId, fingerprintId, fingerprintToken, templateData, rawData, pidData }) {
    const normalizedTemplate = normalizeFingerprintPayload(templateData || rawData || fingerprintId);
    const parsedPidData = pidData || parsePidXml(normalizedTemplate) || null;
    const normalizedFingerprintToken = normalizeFingerprintPayload(
        fingerprintToken
        || generateFingerprintToken(parsedPidData, normalizedTemplate)
        || fingerprintId
    );

    if (!normalizedTemplate) {
        const error = new Error("Captured fingerprint data is required.");
        error.statusCode = 400;
        throw error;
    }
    if (isIncompleteFingerprintPayload(normalizedTemplate)) {
        const error = new Error("Incomplete fingerprint capture. Scan again.");
        error.statusCode = 400;
        throw error;
    }

    const session = await getRunningSessionForTeacher(sessionId, teacherId);
    if (!session) {
        const error = new Error("Biometric session not found or already stopped.");
        error.statusCode = 404;
        throw error;
    }

    const candidateValues = buildFingerprintCandidates({
        fingerprintId: normalizedFingerprintToken,
        templateData: normalizedTemplate,
        rawData,
        pidData: parsedPidData
    });
    const hashCandidates = Array.from(new Set(candidateValues.map((value) => fingerprintHash(value))));
    const tokenCandidates = Array.from(new Set(candidateValues.filter((value) => value && !value.startsWith("<"))));

    const matches = await all(
        `SELECT DISTINCT
                s.id AS student_id,
                s.roll_no,
                s.name,
                s.course_id,
                s.semester_id,
                s.division_id,
                c.name AS branch_name,
                sem.name AS semester_name,
                d.name AS division_name
         FROM students s
         LEFT JOIN biometrics b ON b.student_id = s.id
         LEFT JOIN courses c ON c.id = s.course_id
         LEFT JOIN semesters sem ON sem.id = s.semester_id
         LEFT JOIN divisions d ON d.id = s.division_id
         WHERE (${tokenCandidates.length ? `s.fingerprint_data IN (${tokenCandidates.map(() => "?").join(", ")})` : "1 = 0"})
            OR (${hashCandidates.length ? `b.template_hash IN (${hashCandidates.map(() => "?").join(", ")})` : "1 = 0"})
            OR (${tokenCandidates.length ? `b.fingerprint_id IN (${tokenCandidates.map(() => "?").join(", ")})` : "1 = 0"})
         ORDER BY s.id ASC`,
        [...tokenCandidates, ...hashCandidates, ...tokenCandidates]
    );

    if (!matches.length) {
        const error = new Error(
            isXmlFingerprintPayload(normalizedTemplate)
                ? "Fingerprint not registered. The RD PID XML was captured correctly, but it did not match any enrolled fingerprint identifier in the database."
                : "Fingerprint not registered."
        );
        error.statusCode = 404;
        throw error;
    }
    if (matches.length > 1) {
        const error = new Error("Fingerprint match is ambiguous. Re-enroll biometric data for the affected students.");
        error.statusCode = 409;
        throw error;
    }

    const matchedStudent = matches[0];
    if (
        matchedStudent.course_id !== session.course_id ||
        matchedStudent.semester_id !== session.semester_id ||
        matchedStudent.division_id !== session.division_id
    ) {
        await createNotification(
            matchedStudent.student_id,
            session.subject_name,
            "biometric",
            `You are not from this division. Active attendance is for ${session.subject_name}.`
        );
        const error = new Error("You are not from this division.");
        error.statusCode = 403;
        error.studentId = matchedStudent.student_id;
        throw error;
    }

    return {
        session,
        student: mapStudentSummary(matchedStudent),
        pidData: parsedPidData
    };
}

async function matchFaceForSession({ sessionId, teacherId, imageData }) {
    if (!imageData || !sessionId) {
        const error = new Error("Captured face image and session id are required.");
        error.statusCode = 400;
        throw error;
    }

    const session = await getRunningSessionForTeacher(sessionId, teacherId);
    if (!session) {
        const error = new Error("Running biometric session not found.");
        error.statusCode = 404;
        throw error;
    }

    const analysis = await faceRecognition.analyzeFaceImage(imageData);
    const enrolledFaces = await all(
        `SELECT sf.student_id,
                sf.embedding_json,
                s.roll_no,
                s.name,
                c.name AS branch_name,
                sem.name AS semester_name,
                d.name AS division_name
         FROM student_faces sf
         JOIN students s ON s.id = sf.student_id
         LEFT JOIN courses c ON c.id = s.course_id
         LEFT JOIN semesters sem ON sem.id = s.semester_id
         LEFT JOIN divisions d ON d.id = s.division_id
         WHERE s.course_id = ? AND s.semester_id = ? AND s.division_id = ?`,
        [session.course_id, session.semester_id, session.division_id]
    );
    if (!enrolledFaces.length) {
        const error = new Error("No enrolled student faces found for this class.");
        error.statusCode = 404;
        throw error;
    }

    const rankedMatches = faceRecognition.compareEmbeddingToCandidates(
        analysis.embedding,
        enrolledFaces.map((entry) => ({
            studentId: entry.student_id,
            rollNo: entry.roll_no,
            name: entry.name,
            branch: entry.branch_name,
            semester: entry.semester_name,
            division: entry.division_name,
            embedding: parseEncryptedJsonArray(entry.embedding_json)
        }))
    );

    const bestMatch = rankedMatches[0];
    const secondMatch = rankedMatches[1];
    if (!bestMatch || bestMatch.similarity < faceRecognition.MATCH_THRESHOLD) {
        const similarityText = bestMatch
            ? ` Closest match similarity ${bestMatch.similarity.toFixed(3)} is below threshold ${faceRecognition.MATCH_THRESHOLD.toFixed(2)}.`
            : "";
        const error = new Error(`No enrolled student matched this face.${similarityText}`);
        error.statusCode = 404;
        throw error;
    }
    if (secondMatch && (bestMatch.similarity - secondMatch.similarity) < faceRecognition.AMBIGUOUS_GAP) {
        const error = new Error("Face match is ambiguous. Re-enroll clearer face photos for the affected students.");
        error.statusCode = 409;
        throw error;
    }

    return {
        session,
        student: {
            id: bestMatch.studentId,
            name: bestMatch.name,
            rollNo: bestMatch.rollNo,
            branch: bestMatch.branch || "-",
            semester: bestMatch.semester || "-",
            division: bestMatch.division || "-"
        },
        similarity: Number(bestMatch.similarity.toFixed(4)),
        detectorScore: Number(analysis.score.toFixed(4))
    };
}

async function upsertAttendanceRecord({
    studentId,
    teacherId,
    attendanceDate,
    subjectId,
    subjectName,
    courseId,
    semesterId,
    divisionId,
    biometricPresent,
    manualPresent,
    sessionId = null
}) {
    const existing = await get(
        `SELECT id, locked FROM attendance WHERE student_id = ? AND attendance_date = ? AND subject = ?`,
        [studentId, attendanceDate, subjectName]
    );

    if (!existing) {
        const finalStatus = buildFinalStatus(biometricPresent, manualPresent);
        await run(
            `INSERT INTO attendance (
                student_id, teacher_id, attendance_date, subject, subject_id, course_id, semester_id, division_id, session_id,
                biometric_present, manual_present, final_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [studentId, teacherId, attendanceDate, subjectName, subjectId, courseId, semesterId, divisionId, sessionId, biometricPresent, manualPresent, finalStatus]
        );
        return;
    }

    if (existing.locked) {
        return;
    }

    await run(
        `UPDATE attendance
         SET teacher_id = COALESCE(?, teacher_id),
             subject_id = COALESCE(?, subject_id),
             course_id = COALESCE(?, course_id),
             semester_id = COALESCE(?, semester_id),
             division_id = COALESCE(?, division_id),
             session_id = COALESCE(?, session_id),
             biometric_present = ?,
             manual_present = ?,
             final_status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            teacherId,
            subjectId,
            courseId,
            semesterId,
            divisionId,
            sessionId,
            biometricPresent,
            manualPresent,
            buildFinalStatus(biometricPresent, manualPresent),
            existing.id
        ]
    );
}

async function initDb() {
    await run(`PRAGMA foreign_keys = ON`);
    await run(`PRAGMA journal_mode = WAL`);
    await run(`PRAGMA synchronous = NORMAL`);
    await run(`PRAGMA temp_store = MEMORY`);

    await run(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS semesters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id INTEGER,
            name TEXT NOT NULL,
            academic_year TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS courses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS divisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id INTEGER,
            semester_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(semester_id, name),
            FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
            FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            roll_no TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            course_id INTEGER,
            semester_id INTEGER NOT NULL,
            division_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (course_id) REFERENCES courses(id),
            FOREIGN KEY (semester_id) REFERENCES semesters(id),
            FOREIGN KEY (division_id) REFERENCES divisions(id)
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS biometrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER UNIQUE NOT NULL,
            fingerprint_id TEXT,
            device_id TEXT NOT NULL,
            template_hash TEXT,
            template_data TEXT,
            scanner_source TEXT,
            captured_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS student_faces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER UNIQUE NOT NULL,
            image_data TEXT NOT NULL,
            embedding_json TEXT NOT NULL,
            detector_score REAL,
            captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id INTEGER NOT NULL,
            semester_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(course_id, semester_id, name),
            FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
            FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS biometric_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id INTEGER NOT NULL,
            course_id INTEGER NOT NULL,
            semester_id INTEGER NOT NULL,
            division_id INTEGER NOT NULL,
            subject_id INTEGER NOT NULL,
            attendance_date TEXT NOT NULL,
            status TEXT DEFAULT 'running',
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            stopped_at DATETIME,
            UNIQUE(teacher_id, attendance_date, subject_id, division_id, status),
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
            FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
            FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
            FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS biometric_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            teacher_id INTEGER,
            student_id INTEGER,
            attempt_type TEXT NOT NULL,
            outcome TEXT NOT NULL,
            message TEXT NOT NULL,
            metadata_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES biometric_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
    `);

    await ensureColumn("biometrics", "template_data", "template_data TEXT");
    await ensureColumn("biometrics", "template_hash", "template_hash TEXT");
    await ensureColumn("biometrics", "scanner_source", "scanner_source TEXT");
    await ensureColumn("biometrics", "captured_at", "captured_at DATETIME");
    await ensureColumn("semesters", "course_id", "course_id INTEGER");
    await ensureColumn("divisions", "course_id", "course_id INTEGER");
    await ensureColumn("students", "course_id", "course_id INTEGER");
    await ensureColumn("students", "fingerprint_data", "fingerprint_data TEXT");
    await ensureColumn("student_faces", "detector_score", "detector_score REAL");
    await ensureColumn("student_faces", "captured_at", "captured_at DATETIME");

    await run(`
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            teacher_id INTEGER,
            attendance_date TEXT NOT NULL,
            subject TEXT NOT NULL,
            subject_id INTEGER,
            course_id INTEGER,
            semester_id INTEGER,
            division_id INTEGER,
            session_id INTEGER,
            biometric_present INTEGER DEFAULT 0,
            manual_present INTEGER,
            final_status TEXT DEFAULT 'Pending',
            locked INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(student_id, attendance_date, subject),
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id),
            FOREIGN KEY (subject_id) REFERENCES subjects(id),
            FOREIGN KEY (course_id) REFERENCES courses(id),
            FOREIGN KEY (semester_id) REFERENCES semesters(id),
            FOREIGN KEY (division_id) REFERENCES divisions(id),
            FOREIGN KEY (session_id) REFERENCES biometric_sessions(id)
        )
    `);

    await ensureColumn("attendance", "subject_id", "subject_id INTEGER");
    await ensureColumn("attendance", "course_id", "course_id INTEGER");
    await ensureColumn("attendance", "semester_id", "semester_id INTEGER");
    await ensureColumn("attendance", "division_id", "division_id INTEGER");
    await ensureColumn("attendance", "session_id", "session_id INTEGER");

    await run(`
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_role TEXT NOT NULL,
            actor_id INTEGER,
            action TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            subject TEXT,
            source TEXT,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            user_role TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await run(`CREATE INDEX IF NOT EXISTS idx_attendance_date_subject ON attendance(attendance_date, subject)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_biometrics_template_hash ON biometrics(template_hash)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_student_faces_student ON student_faces(student_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_biometric_attempts_session ON biometric_attempts(session_id, created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs(created_at DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);

    await seedDefaultDataIfEmpty();
    await cleanupExpiredSessions();
}

function loginResponse(role, user, token, client = "classic") {
    const base = client === "main" ? "/main" : "/classic";
    if (role === "admin") {
        return { redirect: `${base}/admin.html`, token, user: { id: user.id, role, username: user.username } };
    }
    if (role === "teacher") {
        return { redirect: `${base}/teacher-dashboard.html`, token, user: { id: user.id, role, name: user.name, username: user.username } };
    }
    return { redirect: `${base}/student.html`, token, user: { id: user.id, role, name: user.name, rollNo: user.roll_no } };
}

app.get("/api/health", (_req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
});

app.post("/api/login", async (req, res) => {
    try {
        const { role, username, password, client } = req.body;

        if (!["admin", "teacher", "student"].includes(role)) {
            return res.status(400).json({ error: "Invalid role." });
        }

        let user;
        if (role === "admin") {
            user = await get(`SELECT id, username, password FROM admins WHERE username = ?`, [username]);
        } else if (role === "teacher") {
            user = await get(`SELECT id, name, username, password FROM teachers WHERE username = ?`, [username]);
        } else {
            user = await get(`SELECT id, name, roll_no, password FROM students WHERE roll_no = ?`, [username]);
        }

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        const valid = await verifyAndMigratePassword(role, user.id, user.password, password);
        if (!valid) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        const token = await createSession(role, user.id);
        res.json(loginResponse(role, user, token, client));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/logout", authRequired(), async (req, res) => {
    try {
        await run(`DELETE FROM sessions WHERE token = ?`, [req.auth.token]);
        res.json({ message: "Logged out." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/me", authRequired(), async (req, res) => {
    try {
        if (req.auth.role === "admin") {
            const row = await get(`SELECT id, username FROM admins WHERE id = ?`, [req.auth.userId]);
            return res.json({ role: "admin", user: row });
        }
        if (req.auth.role === "teacher") {
            const row = await get(`SELECT id, name, username FROM teachers WHERE id = ?`, [req.auth.userId]);
            return res.json({ role: "teacher", user: row });
        }
        const row = await get(`SELECT id, name, roll_no FROM students WHERE id = ?`, [req.auth.userId]);
        res.json({ role: "student", user: row });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/admin/stats", async (_req, res) => {
    try {
        const admins = await get(`SELECT COUNT(*) AS total FROM admins`);
        const teachers = await get(`SELECT COUNT(*) AS total FROM teachers`);
        const students = await get(`SELECT COUNT(*) AS total FROM students`);
        res.json({ admins: admins.total, teachers: teachers.total, students: students.total });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/semesters", authRequired(["admin", "teacher", "main-admin"]), async (req, res) => {
    try {
        const courseId = req.query.courseId;
        const semesters = await all(
            `SELECT sem.id, sem.name, sem.academic_year, sem.course_id, c.name AS course_name
             FROM semesters sem
             LEFT JOIN courses c ON c.id = sem.course_id
             ${courseId ? "WHERE sem.course_id = ?" : ""}
             ORDER BY sem.id DESC`,
            courseId ? [courseId] : []
        );
        res.json(semesters);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/divisions", authRequired(["admin", "teacher", "main-admin"]), async (req, res) => {
    try {
        const semesterId = req.query.semesterId;
        const courseId = req.query.courseId;
        const filters = [];
        const params = [];
        if (courseId) {
            filters.push(`d.course_id = ?`);
            params.push(courseId);
        }
        if (semesterId) {
            filters.push(`d.semester_id = ?`);
            params.push(semesterId);
        }
        const sql = `
            SELECT d.id, d.name, d.semester_id, d.course_id, sem.name AS semester_name, c.name AS course_name
            FROM divisions d
            LEFT JOIN semesters sem ON sem.id = d.semester_id
            LEFT JOIN courses c ON c.id = d.course_id
            ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
            ORDER BY d.id DESC
        `;
        const divisions = await all(sql, params);
        res.json(divisions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/admin/activity", authRequired(["admin"]), async (_req, res) => {
    try {
        const logs = await all(`SELECT created_at, action FROM activity_logs ORDER BY id DESC LIMIT 20`);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/admin/reset-defaults", mainAdminRequired, async (_req, res) => {
    try {
        await resetToDefaultData();
        await cleanupExpiredSessions();
        res.json({
            message: "Project data reset to defaults.",
            defaults: {
                admin: DEFAULT_DATA.admin,
                teacher: { username: DEFAULT_DATA.teacher.username, password: DEFAULT_DATA.teacher.password },
                student: { username: DEFAULT_DATA.student.rollNo, password: DEFAULT_DATA.student.password },
                mainAdmin: { username: "Aditya", password: "aditya0299" }
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/admins", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required." });
        }

        const result = await run(`INSERT INTO admins (username, password) VALUES (?, ?)`, [username, await hashPassword(password)]);
        await logActivity("admin", req.auth.userId, `Added admin ${username}`);
        res.status(201).json({ id: result.id, message: "Admin added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete("/api/admins/:username", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const result = await run(`DELETE FROM admins WHERE username = ?`, [req.params.username]);
        if (!result.changes) {
            return res.status(404).json({ error: "Admin not found." });
        }
        res.json({ message: "Admin removed." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/teachers", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { name, username, password } = req.body;
        if (!name || !username || !password) {
            return res.status(400).json({ error: "Name, username and password are required." });
        }

        const result = await run(
            `INSERT INTO teachers (name, username, password) VALUES (?, ?, ?)`,
            [name, username, await hashPassword(password)]
        );
        await logActivity("admin", req.auth.userId, `Added teacher ${name} (${username})`);
        res.status(201).json({ id: result.id, message: "Teacher added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete("/api/teachers/:id", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const result = await run(`DELETE FROM teachers WHERE username = ? OR id = ?`, [req.params.id, req.params.id]);
        if (!result.changes) {
            return res.status(404).json({ error: "Teacher not found." });
        }
        res.json({ message: "Teacher removed." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/semesters", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { courseId, name, academicYear } = req.body;
        if (!courseId || !name || !academicYear) {
            return res.status(400).json({ error: "Course, semester name and academic year are required." });
        }

        const result = await run(`INSERT INTO semesters (course_id, name, academic_year) VALUES (?, ?, ?)`, [courseId, name, academicYear]);
        await logActivity("admin", req.auth.userId, `Added semester ${name} (${academicYear})`);
        res.status(201).json({ id: result.id, message: "Semester added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/divisions", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { courseId, semesterId, name } = req.body;
        if (!courseId || !semesterId || !name) {
            return res.status(400).json({ error: "Course, semester and division name are required." });
        }

        // Check if division name already exists for the same course and semester
        const existing = await get(
            `SELECT id FROM divisions WHERE course_id = ? AND semester_id = ? AND name = ?`,
            [courseId, semesterId, name]
        );
        if (existing) {
            return res.status(400).json({ error: `Division "${name}" already exists for this course and semester.` });
        }

        const result = await run(`INSERT INTO divisions (course_id, semester_id, name) VALUES (?, ?, ?)`, [courseId, semesterId, name]);
        await logActivity("admin", req.auth.userId, `Added division ${name}`);
        res.status(201).json({ id: result.id, message: "Division added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/courses", authRequired(), async (_req, res) => {
    try {
        const courses = await all(`SELECT id, name FROM courses ORDER BY id DESC`);
        res.json(courses);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/courses", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: "Course name is required." });
        }

        const result = await run(`INSERT INTO courses (name) VALUES (?)`, [name]);
        await logActivity("admin", req.auth.userId, `Added course ${name}`);
        res.status(201).json({ id: result.id, message: "Course added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get("/api/subjects", authRequired(["admin", "teacher"]), async (req, res) => {
    try {
        const { courseId, semesterId } = req.query;
        const filters = [];
        const params = [];
        if (courseId) {
            filters.push(`s.course_id = ?`);
            params.push(courseId);
        }
        if (semesterId) {
            filters.push(`s.semester_id = ?`);
            params.push(semesterId);
        }
        const rows = await all(
            `SELECT s.id, s.name, s.course_id, s.semester_id, c.name AS course_name, sem.name AS semester_name
             FROM subjects s
             JOIN courses c ON c.id = s.course_id
             JOIN semesters sem ON sem.id = s.semester_id
             ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
             ORDER BY s.name`,
            params
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/subjects", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { courseId, semesterId, name } = req.body;
        if (!courseId || !semesterId || !name) {
            return res.status(400).json({ error: "Course, semester and subject name are required." });
        }

        const result = await run(`INSERT INTO subjects (course_id, semester_id, name) VALUES (?, ?, ?)`, [courseId, semesterId, name]);
        await logActivity("admin", req.auth.userId, `Added subject ${name}`);
        res.status(201).json({ id: result.id, message: "Subject added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/students", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { name, rollNo, password, courseId, semesterId, divisionId } = req.body;
        if (!name || !rollNo || !password || !courseId || !semesterId || !divisionId) {
            return res.status(400).json({ error: "All student fields are required." });
        }

        const result = await run(
            `INSERT INTO students (name, roll_no, password, course_id, semester_id, division_id) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, rollNo, await hashPassword(password), courseId, semesterId, divisionId]
        );
        await logActivity("admin", req.auth.userId, `Added student ${rollNo} (${name})`);
        res.status(201).json({ id: result.id, message: "Student added." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/students/complete-enrollment", authRequired(["admin", "main-admin"]), async (req, res) => {
    let transactionOpen = false;
    try {
        const {
            name,
            rollNo,
            password,
            courseId,
            semesterId,
            divisionId,
            biometric,
            face
        } = req.body;

        if (!name || !rollNo || !password || !semesterId || !divisionId) {
            return res.status(400).json({ error: "Student name, roll number, password, semester, and division are required." });
        }

        await run("BEGIN IMMEDIATE TRANSACTION");
        transactionOpen = true;

        const hashedPassword = await hashPassword(password);
        const insertResult = await run(
            `INSERT INTO students (name, roll_no, password, course_id, semester_id, division_id) VALUES (?, ?, ?, ?, ?, ?)`,
            [name, rollNo, hashedPassword, courseId || null, semesterId, divisionId]
        );

        const student = await getStudentByRollNo(rollNo);
        
        // Save biometric data only if provided
        if (biometric && Object.keys(biometric).length > 0) {
            await saveStudentBiometric({
                student,
                rollNo,
                ...biometric
            });
        }
        
        // Save face profile only if provided
        let faceAnalysis = null;
        if (face?.imageData) {
            faceAnalysis = await saveStudentFaceProfile({
                student,
                rollNo,
                imageData: face.imageData
            });
        }

        const bioStatus = biometric && Object.keys(biometric).length > 0 ? " with biometric" : "";
        const faceStatus = face?.imageData ? " and face" : "";
        await logActivity("admin", req.auth.userId, `Added student ${rollNo} (${name})${bioStatus}${faceStatus}`);
        await run("COMMIT");
        transactionOpen = false;

        res.status(201).json({
            id: insertResult.id,
            message: "Student added" + (bioStatus || faceStatus ? " with" + bioStatus + faceStatus + "." : "."),
            detectorScore: faceAnalysis?.score || null,
            student: mapStudentSummary({
                student_id: student.id,
                name: student.name,
                roll_no: student.roll_no,
                branch_name: student.branch_name,
                semester_name: student.semester_name,
                division_name: student.division_name
            })
        });
    } catch (error) {
        if (transactionOpen) {
            try {
                await run("ROLLBACK");
            } catch (_rollbackError) {
            }
        }
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.delete("/api/students/:rollNo", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const result = await run(`DELETE FROM students WHERE roll_no = ?`, [req.params.rollNo]);
        if (!result.changes) {
            return res.status(404).json({ error: "Student not found." });
        }
        res.json({ message: "Student removed." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.put("/api/students/:rollNo/division", authRequired(["admin", "main-admin"]), async (req, res) => {
    try {
        const { divisionId } = req.body;
        if (!divisionId) {
            return res.status(400).json({ error: "Division is required." });
        }
        const division = await get(`SELECT id, semester_id, course_id FROM divisions WHERE id = ?`, [divisionId]);
        if (!division) {
            return res.status(404).json({ error: "Division not found." });
        }
        const result = await run(
            `UPDATE students
             SET division_id = ?, semester_id = ?, course_id = COALESCE(?, course_id)
             WHERE roll_no = ?`,
            [division.id, division.semester_id, division.course_id || null, req.params.rollNo]
        );
        if (!result.changes) {
            return res.status(404).json({ error: "Student not found." });
        }
        res.json({ message: "Student division updated." });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/biometrics", authRequired(["admin"]), async (req, res) => {
    try {
        const { rollNo } = req.body;
        const student = await getStudentByRollNo(rollNo);
        if (!student) {
            return res.status(404).json({ error: "Student not found." });
        }

        const saved = await saveStudentBiometric({
            student,
            rollNo,
            ...req.body
        });

        await logActivity("admin", req.auth.userId, `Saved biometric for ${rollNo} from ${saved.scannerSource || "manual"}`);
        res.json({ message: "Biometric saved.", fingerprintToken: saved.fingerprintToken });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.post("/api/faces/enroll", authRequired(["admin"]), async (req, res) => {
    try {
        const { rollNo, imageData } = req.body;
        const student = await getStudentByRollNo(rollNo);
        if (!student) {
            return res.status(404).json({ error: "Student not found." });
        }

        const analysis = await saveStudentFaceProfile({ student, rollNo, imageData });

        await logActivity("admin", req.auth.userId, `Saved face profile for ${rollNo}`);
        res.json({
            message: "Student face saved.",
            detectorScore: analysis.score
        });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.post("/api/faces/scan", authRequired(["teacher"]), async (req, res) => {
    try {
        const { imageData, sessionId, deferAttendance = false } = req.body;
        const result = await matchFaceForSession({ sessionId, teacherId: req.auth.userId, imageData });

        await logBiometricAttempt({
            sessionId: result.session.id,
            teacherId: req.auth.userId,
            studentId: result.student.id,
            attemptType: "face",
            outcome: deferAttendance ? "matched-awaiting-fingerprint" : "matched",
            message: `Face matched ${result.student.rollNo}`,
            metadata: {
                similarity: result.similarity,
                detectorScore: result.detectorScore
            }
        });

        if (!deferAttendance) {
            const existing = await get(
                `SELECT biometric_present, manual_present, locked
                 FROM attendance
                 WHERE student_id = ? AND attendance_date = ? AND subject = ?`,
                [result.student.id, result.session.attendance_date, result.session.subject_name]
            );
            if (existing && existing.locked) {
                return res.status(400).json({ error: "Attendance is locked for this student and subject." });
            }

            await upsertAttendanceRecord({
                studentId: result.student.id,
                teacherId: req.auth.userId,
                attendanceDate: result.session.attendance_date,
                subjectId: result.session.subject_id,
                subjectName: result.session.subject_name,
                courseId: result.session.course_id,
                semesterId: result.session.semester_id,
                divisionId: result.session.division_id,
                biometricPresent: 1,
                manualPresent: existing ? existing.manual_present : 0,
                sessionId: result.session.id
            });
        }

        await logActivity("teacher", req.auth.userId, `Face scan for ${result.student.rollNo} in ${result.session.subject_name}`);
        res.json({
            message: `Face matched: ${result.student.name} (${result.student.rollNo})`,
            verificationRequired: Boolean(deferAttendance),
            similarity: result.similarity,
            scannedAt: new Date().toISOString(),
            detectorScore: result.detectorScore,
            subject: result.session.subject_name,
            student: result.student
        });
    } catch (error) {
        if (!/No face detected|No enrolled student matched this face/i.test(error.message || "")) {
            await logBiometricAttempt({
                sessionId: req.body?.sessionId || null,
                teacherId: req.auth.userId,
                studentId: error.studentId || null,
                attemptType: "face",
                outcome: "rejected",
                message: error.message || "Face scan failed."
            }).catch(() => {});
        }
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.post("/api/biometric/scan", authRequired(["admin", "teacher", "student"]), async (req, res) => {
    try {
        if (req.auth.role !== "teacher") {
            return res.status(403).json({ error: "Only teachers can run biometric attendance scans." });
        }

        const { fingerprintId, fingerprintToken, templateData, rawData, pidData, sessionId, deferAttendance = false } = req.body;
        const result = await matchFingerprintForSession({
            sessionId,
            teacherId: req.auth.userId,
            fingerprintId,
            fingerprintToken,
            templateData,
            rawData,
            pidData
        });

        await logBiometricAttempt({
            sessionId: result.session.id,
            teacherId: req.auth.userId,
            studentId: result.student.id,
            attemptType: "fingerprint",
            outcome: deferAttendance ? "matched-awaiting-face" : "matched",
            message: `Fingerprint matched ${result.student.rollNo}`,
            metadata: {
                source: req.body?.source || "scanner"
            }
        });

        if (!deferAttendance) {
            const existingAttendance = await get(
                `SELECT manual_present, locked
                 FROM attendance
                 WHERE student_id = ? AND attendance_date = ? AND subject = ?`,
                [result.student.id, result.session.attendance_date, result.session.subject_name]
            );
            if (existingAttendance?.locked) {
                return res.status(400).json({ error: "Attendance is already locked for this student." });
            }

            await upsertAttendanceRecord({
                studentId: result.student.id,
                teacherId: req.auth.userId,
                attendanceDate: result.session.attendance_date,
                subjectId: result.session.subject_id,
                subjectName: result.session.subject_name,
                courseId: result.session.course_id,
                semesterId: result.session.semester_id,
                divisionId: result.session.division_id,
                biometricPresent: 1,
                manualPresent: existingAttendance ? existingAttendance.manual_present : 0,
                sessionId: result.session.id
            });
        }

        await logActivity(req.auth.role, req.auth.userId, `Biometric scan for ${result.student.rollNo} in ${result.session.subject_name}`);
        res.json({
            message: `Fingerprint matched: ${result.student.name} (${result.student.rollNo})`,
            verificationRequired: Boolean(deferAttendance),
            rollNo: result.student.rollNo,
            scannedAt: new Date().toISOString(),
            sessionId: result.session.id,
            subject: result.session.subject_name,
            pidData: result.pidData,
            student: result.student
        });
    } catch (error) {
        await logBiometricAttempt({
            sessionId: req.body?.sessionId || null,
            teacherId: req.auth?.userId || null,
            studentId: error.studentId || null,
            attemptType: "fingerprint",
            outcome: "rejected",
            message: error.message || "Fingerprint scan failed."
        }).catch(() => {});
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post("/api/biometric/confirm", authRequired(["teacher"]), async (req, res) => {
    try {
        const { sessionId, fingerprintStudentId, faceStudentId, fingerprintScannedAt, faceScannedAt, similarity } = req.body;
        if (!sessionId || !fingerprintStudentId || !faceStudentId) {
            return res.status(400).json({ error: "Session id, fingerprint student id, and face student id are required." });
        }

        const session = await getRunningSessionForTeacher(sessionId, req.auth.userId);
        if (!session) {
            return res.status(404).json({ error: "Running biometric session not found." });
        }

        if (String(fingerprintStudentId) !== String(faceStudentId)) {
            await logBiometricAttempt({
                sessionId: session.id,
                teacherId: req.auth.userId,
                attemptType: "combined",
                outcome: "rejected",
                message: "Fingerprint and face matched different students.",
                metadata: {
                    fingerprintStudentId,
                    faceStudentId,
                    fingerprintScannedAt,
                    faceScannedAt
                }
            });
            return res.status(409).json({ error: "Fingerprint and face did not match the same student." });
        }

        const student = await get(
            `SELECT s.id AS student_id,
                    s.roll_no,
                    s.name,
                    c.name AS branch_name,
                    sem.name AS semester_name,
                    d.name AS division_name
             FROM students s
             LEFT JOIN courses c ON c.id = s.course_id
             LEFT JOIN semesters sem ON sem.id = s.semester_id
             LEFT JOIN divisions d ON d.id = s.division_id
             WHERE s.id = ? AND s.course_id = ? AND s.semester_id = ? AND s.division_id = ?`,
            [fingerprintStudentId, session.course_id, session.semester_id, session.division_id]
        );
        if (!student) {
            return res.status(404).json({ error: "Matched student is not part of the active class session." });
        }

        const existingAttendance = await get(
            `SELECT manual_present, locked, biometric_present
             FROM attendance
             WHERE student_id = ? AND attendance_date = ? AND subject = ?`,
            [student.student_id, session.attendance_date, session.subject_name]
        );
        if (existingAttendance?.locked) {
            return res.status(400).json({ error: "Attendance is already locked for this student." });
        }

        await upsertAttendanceRecord({
            studentId: student.student_id,
            teacherId: req.auth.userId,
            attendanceDate: session.attendance_date,
            subjectId: session.subject_id,
            subjectName: session.subject_name,
            courseId: session.course_id,
            semesterId: session.semester_id,
            divisionId: session.division_id,
            biometricPresent: 1,
            manualPresent: existingAttendance ? existingAttendance.manual_present : 0,
            sessionId: session.id
        });

        await logBiometricAttempt({
            sessionId: session.id,
            teacherId: req.auth.userId,
            studentId: student.student_id,
            attemptType: "combined",
            outcome: "accepted",
            message: `Combined biometric verification accepted for ${student.roll_no}.`,
            metadata: {
                fingerprintScannedAt,
                faceScannedAt,
                similarity: Number(similarity || 0)
            }
        });
        await logActivity("teacher", req.auth.userId, `Combined biometric attendance for ${student.roll_no} in ${session.subject_name}`);

        res.json({
            message: `MATCHED: ${student.name} (${student.roll_no})`,
            scannedAt: new Date().toISOString(),
            sessionId: session.id,
            subject: session.subject_name,
            student: mapStudentSummary(student)
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post("/api/biometric/session/start", authRequired(["teacher"]), async (req, res) => {
    try {
        const { courseId, semesterId, divisionId, subjectId } = req.body;
        const attendanceDate = todayDate();
        if (!courseId || !semesterId || !divisionId || !subjectId) {
            return res.status(400).json({ error: "Course, semester, division and subject are required." });
        }

        const subject = await getSubjectContext(subjectId);
        if (!subject) {
            return res.status(404).json({ error: "Subject not found." });
        }
        if (String(subject.course_id) !== String(courseId) || String(subject.semester_id) !== String(semesterId)) {
            return res.status(400).json({ error: "Selected subject does not belong to the chosen course and semester." });
        }

        const existingRunningSession = await get(
            `SELECT id
             FROM biometric_sessions
             WHERE teacher_id = ? AND attendance_date = ? AND subject_id = ? AND division_id = ? AND status = 'running'`,
            [req.auth.userId, attendanceDate, subjectId, divisionId]
        );
        if (existingRunningSession) {
            await logActivity("teacher", req.auth.userId, `Resumed biometric session for ${subject.name}`);
            return res.status(200).json({
                id: existingRunningSession.id,
                subject: subject.name,
                message: "Biometric session already running."
            });
        }

        const runningSessions = await all(
            `SELECT id, subject_id, division_id
             FROM biometric_sessions
             WHERE teacher_id = ? AND attendance_date = ? AND status = 'running'`,
            [req.auth.userId, attendanceDate]
        );

        for (const session of runningSessions) {
            const stoppedExists = await get(
                `SELECT id
                 FROM biometric_sessions
                 WHERE teacher_id = ? AND attendance_date = ? AND subject_id = ? AND division_id = ? AND status = 'stopped'`,
                [req.auth.userId, attendanceDate, session.subject_id, session.division_id]
            );

            await run(
                `UPDATE biometric_sessions
                 SET status = ?, stopped_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [stoppedExists ? `closed-${session.id}` : "stopped", session.id]
            );
        }

        const existingStoppedSession = await get(
            `SELECT id
             FROM biometric_sessions
             WHERE teacher_id = ? AND attendance_date = ? AND subject_id = ? AND division_id = ? AND status = 'stopped'`,
            [req.auth.userId, attendanceDate, subjectId, divisionId]
        );

        let sessionId = null;
        let createdNew = false;

        if (existingStoppedSession) {
            await run(
                `UPDATE biometric_sessions
                 SET course_id = ?,
                     semester_id = ?,
                     division_id = ?,
                     subject_id = ?,
                     status = 'running',
                     stopped_at = NULL
                 WHERE id = ?`,
                [courseId, semesterId, divisionId, subjectId, existingStoppedSession.id]
            );
            sessionId = existingStoppedSession.id;
        } else {
            const result = await run(
                `INSERT INTO biometric_sessions (teacher_id, course_id, semester_id, division_id, subject_id, attendance_date, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'running')`,
                [req.auth.userId, courseId, semesterId, divisionId, subjectId, attendanceDate]
            );
            sessionId = result.id;
            createdNew = true;
        }

        if (!sessionId) {
            return res.status(400).json({ error: "Unable to start biometric session." });
        }

        const students = await all(
            `SELECT id FROM students WHERE course_id = ? AND semester_id = ? AND division_id = ?`,
            [courseId, semesterId, divisionId]
        );
        for (const student of students) {
            await upsertAttendanceRecord({
                studentId: student.id,
                teacherId: req.auth.userId,
                attendanceDate,
                subjectId,
                subjectName: subject.name,
                courseId,
                semesterId,
                divisionId,
                biometricPresent: 0,
                manualPresent: 0,
                sessionId
            });
        }

        await logActivity("teacher", req.auth.userId, `Started biometric session for ${subject.name}`);
        res.status(createdNew ? 201 : 200).json({
            id: sessionId,
            subject: subject.name,
            message: createdNew ? "Biometric session started." : "Biometric session resumed."
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/api/biometric/session/stop", authRequired(["teacher"]), async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: "Session id is required." });
        }

        const session = await get(
            `SELECT bs.id, bs.subject_id, bs.division_id, bs.attendance_date, sub.name AS subject_name
             FROM biometric_sessions bs
             JOIN subjects sub ON sub.id = bs.subject_id
             WHERE bs.id = ? AND bs.teacher_id = ? AND bs.status = 'running'`,
            [sessionId, req.auth.userId]
        );
        if (!session) {
            return res.status(404).json({ error: "Running biometric session not found." });
        }

        await run(
            `UPDATE biometric_sessions SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [session.id]
        );
        const result = await run(
            `UPDATE attendance
             SET final_status = CASE WHEN biometric_present = 1 AND manual_present = 1 THEN 'Present' ELSE 'Absent' END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE session_id = ? AND attendance_date = ?`,
            [session.id, session.attendance_date]
        );

        await logActivity("teacher", req.auth.userId, `Stopped biometric session for ${session.subject_name}`);
        res.json({ message: `Biometric session stopped. ${result.changes} attendance record(s) are ready for manual completion.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/biometric/session/:sessionId", authRequired(["teacher"]), async (req, res) => {
    try {
        const session = await get(
            `SELECT bs.id, bs.teacher_id, bs.course_id, bs.semester_id, bs.division_id, bs.subject_id, bs.attendance_date, bs.status,
                    c.name AS course_name, sem.name AS semester_name, d.name AS division_name, sub.name AS subject_name
             FROM biometric_sessions bs
             JOIN courses c ON c.id = bs.course_id
             JOIN semesters sem ON sem.id = bs.semester_id
             JOIN divisions d ON d.id = bs.division_id
             JOIN subjects sub ON sub.id = bs.subject_id
             WHERE bs.id = ? AND bs.teacher_id = ?`,
            [req.params.sessionId, req.auth.userId]
        );

        if (!session) {
            return res.status(404).json({ error: "Biometric session not found." });
        }

        res.json(session);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function handleRdCapture(_req, res) {
    try {
        const result = await captureFromRdService();

        return res.json({
            fingerprintId: result.fingerprintId,
            fingerprintToken: result.fingerprintToken,
            templateData: result.pidXml,
            pidXml: result.pidXml,
            pidData: result.pidData,
            deviceId: result.deviceId,
            source: "rd-service",
            capturedAt: result.capturedAt,
            rdPort: result.port,
            rdPath: "/rd/capture"
        });
    } catch (err) {
        const message = err.message === "Mantra RD Service not running. Please start RD service."
            ? err.message
            : `RD capture failed. ${err.message}`;
        res.status(502).json({
            error: message,
            xmlError: err.message && err.message.trim().startsWith("<") ? err.message : null
        });
    }
}

// Backend RD capture proxy used by admin/teacher attendance screens.
app.post("/api/rd/capture", authRequired(["admin", "teacher", "student"]), handleRdCapture);
app.post("/api/rd/scan", authRequired(["admin", "teacher", "student"]), handleRdCapture);

app.get("/api/rd/status", authRequired(["admin", "teacher", "main-admin"]), async (_req, res) => {
    try {
        const discovery = await discoverRdService();
        const vendorStatus = detectVendorScannerProcesses();
        if (!discovery) {
            return res.json({
                running: false,
                host: RD_DISCOVERY_HOSTS[0] || "127.0.0.1",
                path: RD_CAPTURE_PATHS[0],
                vendorRunning: vendorStatus.running,
                vendorProcesses: vendorStatus.processes,
                message: vendorStatus.running
                    ? "Scanner vendor services are running, but the standard RD HTTP capture API is not exposed on this machine."
                    : "Mantra RD Service not running. Please start RD service."
            });
        }

        res.json({
            running: true,
            port: discovery.port,
            host: discovery.host,
            path: discovery.capturePath || RD_CAPTURE_PATHS[0],
            vendorRunning: vendorStatus.running,
            vendorProcesses: vendorStatus.processes
        });
    } catch (error) {
        const vendorStatus = detectVendorScannerProcesses();
        res.status(500).json({
            running: false,
            host: RD_DISCOVERY_HOSTS[0] || "127.0.0.1",
            path: RD_CAPTURE_PATHS[0],
            vendorRunning: vendorStatus.running,
            vendorProcesses: vendorStatus.processes,
            message: error.message || "Unable to detect RD service."
        });
    }
});

app.post("/api/attendance/manual", authRequired(["teacher"]), async (req, res) => {
    try {
        const { rollNo, subjectId, status, courseId, semesterId, divisionId } = req.body;
        if (!rollNo || !subjectId || !status || !courseId || !semesterId || !divisionId) {
            return res.status(400).json({ error: "Roll no, course, semester, division, subject and status are required." });
        }

        const subject = await getSubjectContext(subjectId);
        if (!subject) {
            return res.status(404).json({ error: "Subject not found." });
        }
        if (String(subject.course_id) !== String(courseId) || String(subject.semester_id) !== String(semesterId)) {
            return res.status(400).json({ error: "Selected subject does not belong to the chosen course and semester." });
        }

        const student = await get(
            `SELECT id, course_id, semester_id, division_id
             FROM students
             WHERE roll_no = ?`,
            [rollNo]
        );
        if (!student) {
            return res.status(404).json({ error: "Student not found." });
        }
        if (
            String(student.course_id) !== String(courseId) ||
            String(student.semester_id) !== String(semesterId) ||
            String(student.division_id) !== String(divisionId)
        ) {
            return res.status(400).json({ error: `${rollNo} does not belong to the selected course, semester, and division.` });
        }

        const manualPresent = status === "present" ? 1 : 0;
        const teacherId = req.auth.userId;
        const attendanceDate = todayDate();
        const existing = await get(
            `SELECT biometric_present, locked
             FROM attendance
             WHERE student_id = ? AND attendance_date = ? AND subject = ?`,
            [student.id, attendanceDate, subject.name]
        );
        if (existing && existing.locked) {
            return res.status(400).json({ error: "Attendance is locked for this student and subject." });
        }

        await upsertAttendanceRecord({
            studentId: student.id,
            teacherId,
            attendanceDate,
            subjectId,
            subjectName: subject.name,
            courseId,
            semesterId,
            divisionId,
            biometricPresent: existing ? existing.biometric_present : 0,
            manualPresent
        });

        await logActivity("teacher", teacherId, `Manual attendance ${status} for ${rollNo} in ${subject.name}`);
        res.json({ message: "Manual attendance saved." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/attendance/manual/bulk", authRequired(["teacher"]), async (req, res) => {
    try {
        const { subjectId, courseId, semesterId, divisionId, presentRollNos } = req.body;
        if (!subjectId || !courseId || !semesterId || !divisionId || !Array.isArray(presentRollNos)) {
            return res.status(400).json({ error: "Course, semester, division, subject and present roll numbers are required." });
        }

        const normalizedRolls = Array.from(new Set(presentRollNos.map((value) => String(value || "").trim()).filter(Boolean)));
        if (!normalizedRolls.length) {
            return res.status(400).json({ error: "Enter at least one roll number to mark present." });
        }

        const subject = await getSubjectContext(subjectId);
        if (!subject) {
            return res.status(404).json({ error: "Subject not found." });
        }
        if (String(subject.course_id) !== String(courseId) || String(subject.semester_id) !== String(semesterId)) {
            return res.status(400).json({ error: "Selected subject does not belong to the chosen course and semester." });
        }

        const students = await all(
            `SELECT id, roll_no
             FROM students
             WHERE course_id = ? AND semester_id = ? AND division_id = ?
             ORDER BY roll_no`,
            [courseId, semesterId, divisionId]
        );
        if (!students.length) {
            return res.status(404).json({ error: "No students found for the selected course, semester, and division." });
        }

        const studentMap = new Map(students.map((student) => [student.roll_no, student]));
        const invalidRolls = normalizedRolls.filter((rollNo) => !studentMap.has(rollNo));
        if (invalidRolls.length) {
            return res.status(400).json({ error: `These roll numbers do not belong to the selected class: ${invalidRolls.join(", ")}` });
        }

        const presentSet = new Set(normalizedRolls);
        const attendanceDate = todayDate();
        const teacherId = req.auth.userId;
        let presentCount = 0;
        let absentCount = 0;
        let lockedCount = 0;

        for (const student of students) {
            const manualPresent = presentSet.has(student.roll_no) ? 1 : 0;
            const existing = await get(
                `SELECT biometric_present, locked
                 FROM attendance
                 WHERE student_id = ? AND attendance_date = ? AND subject = ?`,
                [student.id, attendanceDate, subject.name]
            );

            if (existing && existing.locked) {
                lockedCount += 1;
                continue;
            }

            await upsertAttendanceRecord({
                studentId: student.id,
                teacherId,
                attendanceDate,
                subjectId,
                subjectName: subject.name,
                courseId,
                semesterId,
                divisionId,
                biometricPresent: existing ? existing.biometric_present : 0,
                manualPresent
            });

            if (manualPresent) {
                presentCount += 1;
            } else {
                absentCount += 1;
            }
        }

        await logActivity("teacher", teacherId, `Manual bulk attendance saved for ${subject.name}: ${presentCount} present, ${absentCount} absent`);
        const lockedNote = lockedCount ? ` ${lockedCount} locked record(s) were skipped.` : "";
        res.json({
            message: `Manual attendance saved. ${presentCount} present, ${absentCount} absent.${lockedNote}`.trim(),
            presentCount,
            absentCount,
            lockedCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/attendance/verify", authRequired(["teacher"]), async (req, res) => {
    try {
        const { subject } = req.body;
        if (!subject) {
            return res.status(400).json({ error: "Subject is required." });
        }

        const result = await run(
            `UPDATE attendance
             SET final_status = CASE
                 WHEN manual_present IS NULL THEN 'Pending'
                 WHEN biometric_present = 1 AND manual_present = 1 THEN 'Present'
                 ELSE 'Absent'
             END,
             teacher_id = COALESCE(?, teacher_id),
             updated_at = CURRENT_TIMESTAMP
             WHERE attendance_date = ? AND subject = ? AND locked = 0`,
            [req.auth.userId, todayDate(), subject]
        );

        await logActivity("teacher", req.auth.userId, `Verified attendance for ${subject}`);
        res.json({ message: `Verified ${result.changes} record(s).` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/attendance/lock", authRequired(["teacher"]), async (req, res) => {
    try {
        const { subject } = req.body;
        if (!subject) {
            return res.status(400).json({ error: "Subject is required." });
        }

        const result = await run(
            `UPDATE attendance SET locked = 1, teacher_id = COALESCE(?, teacher_id) WHERE attendance_date = ? AND subject = ?`,
            [req.auth.userId, todayDate(), subject]
        );

        await logActivity("teacher", req.auth.userId, `Locked attendance for ${subject}`);
        res.json({ message: `Locked ${result.changes} record(s).` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/teacher/summary", authRequired(["teacher"]), async (req, res) => {
    try {
        const subjectId = req.query.subjectId;
        const divisionId = req.query.divisionId;
        const date = req.query.date || todayDate();
        const filters = [`a.attendance_date = ?`];
        const params = [date];
        if (subjectId) {
            filters.push(`a.subject_id = ?`);
            params.push(subjectId);
        }
        if (divisionId) {
            filters.push(`a.division_id = ?`);
            params.push(divisionId);
        }
        const rows = await all(
            `SELECT s.roll_no, s.name, a.biometric_present, a.manual_present, a.final_status, a.subject
             FROM attendance a
             JOIN students s ON s.id = a.student_id
             WHERE ${filters.join(" AND ")}
             ORDER BY s.roll_no`,
            params
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/attendance/manual/bulk-state", authRequired(["teacher"]), async (req, res) => {
    try {
        const { subjectId, divisionId, date } = req.query;
        if (!subjectId || !divisionId) {
            return res.status(400).json({ error: "Subject and division are required." });
        }

        const rows = await all(
            `SELECT s.roll_no
             FROM attendance a
             JOIN students s ON s.id = a.student_id
             WHERE a.subject_id = ?
               AND a.division_id = ?
               AND a.attendance_date = ?
               AND a.manual_present = 1
             ORDER BY s.roll_no`,
            [subjectId, divisionId, date || todayDate()]
        );

        res.json({
            rollNos: rows.map((row) => row.roll_no)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/student/dashboard/:studentId", authRequired(["student", "admin", "teacher"]), async (req, res) => {
    try {
        const studentId = Number(req.params.studentId);

        if (req.auth.role === "student" && req.auth.userId !== studentId) {
            return res.status(403).json({ error: "Not allowed for this student profile." });
        }

        const student = await get(
            `SELECT s.id, s.name, s.roll_no, c.name AS course_name, sem.name AS semester_name, d.name AS division_name
             FROM students s
             LEFT JOIN courses c ON c.id = s.course_id
             JOIN semesters sem ON sem.id = s.semester_id
             JOIN divisions d ON d.id = s.division_id
             LEFT JOIN biometrics b ON b.student_id = s.id
             WHERE s.id = ?`,
            [studentId]
        );

        if (!student) {
            return res.status(404).json({ error: "Student not found." });
        }

        const summary = await get(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN final_status = 'Present' THEN 1 ELSE 0 END) AS present_count
             FROM attendance
             WHERE student_id = ?`,
            [studentId]
        );

        const today = await get(
            `SELECT final_status
             FROM attendance
             WHERE student_id = ? AND attendance_date = ?
             ORDER BY id DESC LIMIT 1`,
            [studentId, todayDate()]
        );

        const recent = await all(
            `SELECT attendance_date, subject, final_status
             FROM attendance
             WHERE student_id = ?
             ORDER BY attendance_date DESC, id DESC
             LIMIT 30`,
            [studentId]
        );

        const calendar = await all(
            `SELECT attendance_date, final_status
             FROM attendance
             WHERE student_id = ?
             ORDER BY attendance_date ASC`,
            [studentId]
        );

        const total = summary.total || 0;
        const present = summary.present_count || 0;
        const percent = total ? Math.round((present * 100) / total) : 0;

        res.json({
            student,
            stats: { total, present, percentage: percent, todayStatus: today ? today.final_status : "Pending" },
            recent,
            calendar
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/student/notifications/:studentId", authRequired(["student", "admin", "teacher"]), async (req, res) => {
    try {
        const studentId = Number(req.params.studentId);
        if (req.auth.role === "student" && req.auth.userId !== studentId) {
            return res.status(403).json({ error: "Not allowed for this student profile." });
        }
        const rows = await all(
            `SELECT created_at, subject, source, message
             FROM notifications
             WHERE student_id = ?
             ORDER BY id DESC
             LIMIT 20`,
            [studentId]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/", (_req, res) => {
    res.sendFile(path.join(CLASSIC_DIR, "login.html"));
});

// Simple endpoint to receive fingerprint XML from frontend capture (RD Service)
app.post("/attendance", (req, res) => {
    const fingerprintData = req.body && req.body.fingerprint;
    console.log("Fingerprint captured");
    if (!fingerprintData) {
        return res.status(400).json({ status: "error", message: "Missing fingerprint data." });
    }

    res.json({ status: "success" });
});

app.get("/main", (_req, res) => {
    res.sendFile(path.join(MAIN_DIR, "login.html"));
});

initDb()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
            console.log("Classic UI: /classic/login.html | Main UI: /main/login.html");
            console.log("Default logins: admin/admin123, teacher1/teacher123, 24CS101/student123, Main Admin Aditya/aditya0299");
        });
    })
    .catch((error) => {
        console.error("Database init failed:", error);
        process.exit(1);
    });
