#!/usr/bin/env node
const os = require("os");
const process = require("process");
const { io } = require("socket.io-client");
const { mouse, keyboard, Key, Point, Button, screen } = require("@nut-tree-fork/nut-js");
const { execSync } = require("child_process");

// --- Configuration ---
const MOVE_THROTTLE_MS = 15;
const FRAME_RATE_MS = 100; // Aiming for 10 FPS (1000ms / 100ms). Adjust based on performance.
const ROOM = process.env.ROOM || process.argv[2] || "room1";

// --- State Variables ---
let captureInfo = null;
let lastMoveTs = 0;
let isSharingActive = false;
let screenCaptureInterval = null;

// ---- Permission check ----
function checkPermissions() {
    const platform = os.platform();
    if (platform === "win32") {
        try {
            execSync("net session", { stdio: "ignore" });
            console.log("✅ Running as Administrator");
        } catch {
            console.warn("⚠️ Not running as Admin! Mouse/keyboard may fail");
        }
    } else if (platform === "darwin") {
        console.warn("⚠️ macOS requires Accessibility permission");
    } else if (platform === "linux" && process.getuid && process.getuid() !== 0) {
        console.warn("⚠️ Run with sudo");
    }
}
checkPermissions();

// ---- nut.js config ----
mouse.config.mouseSpeed = 1200;
keyboard.config.autoDelayMs = 0;

// ---- Socket ----
const socket = io("https://screensharing-test-backend.onrender.com", {
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000, // 2s delay before retry
    reconnectionDelayMax: 10000 // max 10s delay
});

// ---- Screen Capture Function (CORE NEW LOGIC) ----
/**
 * Captures the screen, encodes it as JPEG, and sends the buffer over the socket.
 */
async function captureAndSendScreen() {
    if (!isSharingActive) return;

    try {
        // 1. Capture the full screen
        const image = await screen.grab(); 
        
        // 2. Encode to JPEG for network efficiency (VNC-like compression)
        // .toJpg() returns a Buffer. Adjust quality if possible in your nut-js fork.
        const imageBuffer = await image.toJpg(); 
        
        // 3. Emit the compressed binary data (the VNC-like frame)
        socket.emit("screen-data", {
            roomId: ROOM,
            // The 'data' payload MUST be a Buffer
            data: imageBuffer
        });

    } catch (error) {
        // This often happens if the screen capture dependency fails or is slow
        console.error("❌ Screen Capture/Stream Error:", error.message);
    }
}


// ---- Socket Listeners ----
socket.on("connect", () => {
    console.log("✅ Agent connected:", socket.id,"Room:", ROOM);
    // Set a name so the viewer knows who the agent is
    socket.emit("set-name", { name: os.hostname() || "Remote Agent" }); 
    // Join room as agent
    socket.emit("join-room", { roomId: ROOM, isAgent: true });
});

socket.on("disconnect", () => console.log("❌ Agent disconnected"));

// NEW: Handle permission result from User2's browser
socket.on("permission-result", (accepted) => {
    if (accepted && !isSharingActive) {
        isSharingActive = true;
        console.log("▶️ Permission accepted. Starting screen capture...");
        
        // Start the capture loop to send screen data
        screenCaptureInterval = setInterval(captureAndSendScreen, FRAME_RATE_MS);
        
        // Send initial resolution info to the server/viewer for control scaling
        screen.width().then(w => screen.height().then(h => {
            socket.emit("capture-info", { 
                roomId: ROOM, 
                captureWidth: w, // Agent's screen width
                captureHeight: h, // Agent's screen height
                devicePixelRatio: 1
            });
        }));
    } else if (!accepted && isSharingActive) {
        // If rejected after already sharing (shouldn't happen), or just rejected
        socket.emit("stop-share", { roomId: ROOM, name: os.hostname() || "Remote Agent" });
    }
});


socket.on("capture-info", info => {
    // This is the viewer's screen info, which we need for correct mouse scaling.
    captureInfo = info; 
    console.log("📐 Viewer Capture info received for control scaling:", info);
});

// Update `stop-share` to clear the capture loop
socket.on("stop-share", ({ name }) => {
    captureInfo = null;
    if (screenCaptureInterval) {
        clearInterval(screenCaptureInterval);
        screenCaptureInterval = null;
        isSharingActive = false;
    }
    console.log(`🛑 Stop-share received from ${name}. Capture stopped.`);
});


// ---- Control handler (Remains largely the same, but relies on captureInfo) ----
const keyMap = {
    enter: Key.Enter, escape: Key.Escape, tab: Key.Tab,
    backspace: Key.Backspace, delete: Key.Delete,
    control: Key.LeftControl, ctrl: Key.LeftControl,
    shift: Key.LeftShift, alt: Key.LeftAlt, meta: Key.LeftSuper,
    arrowup: Key.Up, arrowdown: Key.Down,
    arrowleft: Key.Left, arrowright: Key.Right,
    space: Key.Space,
    f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4, f5: Key.F5,
    f6: Key.F6, f7: Key.F7, f8: Key.F8, f9: Key.F9, f10: Key.F10,
    f11: Key.F11, f12: Key.F12
};
function isPrintableChar(s) { return typeof s === "string" && s.length === 1; }
const mapBtn = btn => btn === 2 ? Button.RIGHT : (btn === 1 ? Button.MIDDLE : Button.LEFT);

socket.on("control", async data => {
    // Ensure sharing is active AND we have viewer's info for scaling
    if (!isSharingActive || !captureInfo) return; 
    
    try {
        if (["mousemove", "click", "mousedown", "mouseup", "dblclick", "wheel"].includes(data.type)) {
            const now = Date.now();
            if (data.type === "mousemove" && now - lastMoveTs < MOVE_THROTTLE_MS) return;
            lastMoveTs = now;

            // Dimensions used for scaling (based on viewer's canvas size)
            const w = (captureInfo.captureWidth || 1280) * (captureInfo.devicePixelRatio || 1);
            const h = (captureInfo.captureHeight || 720) * (captureInfo.devicePixelRatio || 1);
            
            // Get local display dimensions
            const displayWidth = await screen.width();
            const displayHeight = await screen.height();
            
            // Scale viewer's (data.x, data.y) position to Agent's screen (absX, absY)
            const srcX = typeof data.x === "number" ? Math.round(data.x * w) : null;
            const srcY = typeof data.y === "number" ? Math.round(data.y * h) : null;
            
            const absX = srcX !== null ? clamp(Math.round(srcX * (displayWidth / Math.max(1, w))), 0, displayWidth - 1) : null;
            const absY = srcY !== null ? clamp(Math.round(srcY * (displayHeight / Math.max(1, h))), 0, displayHeight - 1) : null;

            try {
                if (absX !== null && absY !== null) {
                    await mouse.setPosition(new Point(absX, absY));
                }
            } catch (e) {
                console.warn("⚠️ Mouse move failed:", e.message);
            }

            if (data.type === "click") await mouse.click(mapBtn(data.button));
            else if (data.type === "dblclick") await mouse.doubleClick(mapBtn(data.button));
            else if (data.type === "mousedown") await mouse.pressButton(mapBtn(data.button));
            else if (data.type === "mouseup") await mouse.releaseButton(mapBtn(data.button));
            else if (data.type === "wheel") {
                if (data.deltaY > 0) await mouse.scrollDown(200);
                else await mouse.scrollUp(200);
            }
        }
        if (["keydown", "keyup"].includes(data.type)) {
            const rawKey = (data.key || "").toString();
            const keyName = rawKey.toLowerCase();
            const mapped = keyMap[keyName];
            if (data.type === "keydown") {
                if (mapped) await keyboard.pressKey(mapped);
                else if (isPrintableChar(rawKey)) await keyboard.type(rawKey);
            } else if (data.type === "keyup") {
                if (mapped) await keyboard.releaseKey(mapped);
            }
        }
    } catch (err) {
        console.error("⚠️ Error handling control:", err);
    }
});

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ---- Keep agent alive ----
process.stdin.resume(); // keeps Node process running
console.log("🟢 Agent is now alive and waiting for remote control events...");

// ---- Graceful exit ----
process.on("SIGINT", async () => {
    console.log("👋 Agent shutting down...");
    if (screenCaptureInterval) clearInterval(screenCaptureInterval);
    await keyboard.releaseKey(...Object.values(keyMap)); // release any stuck keys
    process.exit();
});