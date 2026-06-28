const fs = require("fs");
const path = require("path");
const jpeg = require("jpeg-js");
const Human = require("./node_modules/@vladmandic/human/dist/human.node-wasm.js");

const MATCH_THRESHOLD = 0.5;
const DUPLICATE_ENROLL_THRESHOLD = 0.72;
const AMBIGUOUS_GAP = 0.03;
const MIN_FACE_SCORE = 0.45;

let humanInstance = null;
let initPromise = null;

function toFileUrl(targetPath) {
    return `file:///${path.resolve(targetPath).replace(/\\/g, "/")}`;
}

function patchFetchForLocalFiles() {
    if (global.__humanFaceFetchPatched) {
        return;
    }

    const nativeFetch = global.fetch;
    global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url;
        if (typeof url === "string" && url.startsWith("file:///")) {
            const resolvedPath = decodeURIComponent(url.slice("file:///".length)).replace(/\//g, path.sep);
            const buffer = await fs.promises.readFile(resolvedPath);
            return new Response(buffer, {
                status: 200,
                headers: {
                    "Content-Type": url.endsWith(".json") ? "application/json" : "application/octet-stream"
                }
            });
        }
        return nativeFetch(input, init);
    };
    global.__humanFaceFetchPatched = true;
}

async function getHuman() {
    if (humanInstance) {
        return humanInstance;
    }
    if (initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        patchFetchForLocalFiles();

        const human = new Human.Human({
            backend: "wasm",
            async: false,
            debug: false,
            modelBasePath: toFileUrl(path.join(__dirname, "node_modules", "@vladmandic", "human", "models")),
            wasmPath: `${toFileUrl(path.join(__dirname, "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist"))}/`,
            filter: { enabled: true, equalization: true },
            face: {
                enabled: true,
                detector: { rotation: false, return: true, maxDetected: 3, minConfidence: 0.35 },
                mesh: { enabled: false },
                iris: { enabled: false },
                emotion: { enabled: false },
                antispoof: { enabled: false },
                liveness: { enabled: false },
                description: { enabled: true, minConfidence: 0.3 }
            },
            body: { enabled: false },
            hand: { enabled: false },
            object: { enabled: false },
            gesture: { enabled: false }
        });

        await human.tf.ready();
        await human.load();
        humanInstance = human;
        return human;
    })();

    return initPromise;
}

function decodeImageData(imageData) {
    const match = String(imageData || "").match(/^data:image\/jpeg;base64,(.+)$/i);
    if (!match) {
        throw new Error("Captured face image must be a JPEG data URL.");
    }

    const buffer = Buffer.from(match[1], "base64");
    const decoded = jpeg.decode(buffer, { useTArray: true });
    if (!decoded?.width || !decoded?.height || !decoded?.data?.length) {
        throw new Error("Unable to decode captured face image.");
    }

    const rgb = new Uint8Array(decoded.width * decoded.height * 3);
    for (let src = 0, dst = 0; src < decoded.data.length; src += 4, dst += 3) {
        rgb[dst] = decoded.data[src];
        rgb[dst + 1] = decoded.data[src + 1];
        rgb[dst + 2] = decoded.data[src + 2];
    }

    return {
        tensorData: rgb,
        width: decoded.width,
        height: decoded.height
    };
}

async function analyzeFaceImage(imageData) {
    const human = await getHuman();
    const decoded = decodeImageData(imageData);
    const tensor = human.tf.tensor3d(decoded.tensorData, [decoded.height, decoded.width, 3], "int32");

    try {
        const result = await human.detect(tensor);
        const faces = Array.isArray(result?.face) ? result.face : [];
        if (!faces.length) {
            throw new Error("No face detected. Keep only one student face clearly visible.");
        }
        if (faces.length > 1) {
            throw new Error("Multiple faces detected. Keep only one student in front of the camera.");
        }

        const face = faces[0];
        if (!Array.isArray(face.embedding) || !face.embedding.length) {
            throw new Error("Face descriptor could not be generated. Capture again in better light.");
        }

        const score = Number(face.faceScore || face.boxScore || 0);
        if (score < MIN_FACE_SCORE) {
            throw new Error("Face image quality is too low. Look straight at the camera in better light and capture again.");
        }

        return {
            embedding: Array.from(face.embedding),
            score,
            age: Number(face.age || 0),
            gender: face.gender || null,
            imageData
        };
    } finally {
        human.tf.dispose(tensor);
    }
}

function compareEmbeddingToCandidates(embedding, candidates = []) {
    const human = humanInstance;
    if (!human) {
        throw new Error("Face recognition service is not initialized.");
    }

    const ranked = candidates
        .filter((candidate) => Array.isArray(candidate.embedding) && candidate.embedding.length)
        .map((candidate) => ({
            ...candidate,
            similarity: human.match.similarity(embedding, candidate.embedding, { order: 2, multiplier: 25, min: 0.2, max: 0.8 })
        }))
        .sort((a, b) => b.similarity - a.similarity);

    return ranked;
}

module.exports = {
    MATCH_THRESHOLD,
    DUPLICATE_ENROLL_THRESHOLD,
    AMBIGUOUS_GAP,
    MIN_FACE_SCORE,
    analyzeFaceImage,
    compareEmbeddingToCandidates,
    getHuman
};
