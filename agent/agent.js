// agent.js — FINAL FIX (Screen + Control working for demo)

const os = require("os");
const process = require("process");
const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");
const { mouse, keyboard, Key, Point, Button, screen } = require("@nut-tree-fork/nut-js");
const { execSync } = require("child_process");
const screenshot = require("screenshot-desktop");

// ---- CONFIG ----
const BACKEND_URL = "https://screensharing-test-backend.onrender.com"; // 🔧 Change if self-hosted
let ROOM = "room1";
const STREAM_FPS = 8; // frames per second
const STREAM_INTERVAL_MS = 1000 / STREAM_FPS;

// ---- READ roomId from config.json / args / env ----
try {
  const configPath = path.join(__dirname, "config.json");
  if (fs.existsSync(configPath)) {
    ROOM = JSON.parse(fs.readFileSync(configPath, "utf8")).roomId || ROOM;
  } else if (process.argv[2]) {
    ROOM = process.argv[2];
  } else if (process.env.ROOM) {
    ROOM = process.env.ROOM;
  }
} catch (err) {
  console.warn("⚠️ Could not read config.json:", err.message);
}

// ---- Helper ----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const getSystemInfo = () => {
  const nets = os.networkInterfaces();
  let ip = "localhost";
  for (const n of Object.values(nets).flat()) {
    if (n.family === "IPv4" && !n.internal) { ip = n.address; break; }
  }
  return { ip, username: os.userInfo().username, computerName: os.hostname(), platform: os.platform(), roomId: ROOM };
};

// ---- Permission Check ----
try {
  if (os.platform() === "win32") execSync("net session", { stdio: "ignore" });
  console.log("✅ Agent running with Admin rights");
} catch {
  console.warn("⚠️ Run as Administrator for full control");
}

// ---- Socket.io Connection ----
const socket = io(BACKEND_URL, { transports: ["websocket"], reconnection: true });
let captureInfo = null, lastMove = 0, screenTimer = null;

// ---- Screen Stream Loop ----
async function startScreenStream() {
  if (screenTimer) return;
  console.log("📺 Starting screen stream...");
  screenTimer = setInterval(async () => {
    try {
      const img = await screenshot({ format: "png" });
      const base64 = img.toString("base64");
      socket.emit("screen-frame", { roomId: ROOM, frame: base64 });
    } catch (e) {
      console.warn("⚠️ Screen capture failed:", e.message);
    }
  }, STREAM_INTERVAL_MS);
}
function stopScreenStream() {
  if (screenTimer) {
    clearInterval(screenTimer);
    screenTimer = null;
    console.log("🛑 Screen stream stopped");
  }
}

// ---- Socket Events ----
socket.on("connect", () => {
  console.log("✅ Connected to server:", socket.id);
  socket.emit("join-room", { roomId: ROOM, isAgent: true });
  socket.emit("system-info", getSystemInfo());
});

socket.on("start-rdp-capture", async () => {
  console.log("🚀 Start screen share requested");
  socket.emit("windows-rdp-ready", getSystemInfo());
  startScreenStream();
});

socket.on("stop-share", () => {
  console.log("🛑 Stop share received");
  stopScreenStream();
});

socket.on("disconnect", () => {
  console.warn("❌ Disconnected from backend");
  stopScreenStream();
});

// ---- Control Handling ----
const keyMap = {
  escape: Key.Escape, enter: Key.Enter, tab: Key.Tab, shift: Key.LeftShift,
  control: Key.LeftControl, alt: Key.LeftAlt, meta: Key.LeftSuper, space: Key.Space,
  backspace: Key.Backspace, delete: Key.Delete, left: Key.Left, up: Key.Up,
  right: Key.Right, down: Key.Down, f1: Key.F1, f2: Key.F2, f3: Key.F3,
  f4: Key.F4, f5: Key.F5, f6: Key.F6, f7: Key.F7, f8: Key.F8, f9: Key.F9,
  f10: Key.F10, f11: Key.F11, f12: Key.F12
};

socket.on("capture-info", info => {
  captureInfo = info;
  console.log("📐 Capture info:", info);
});

socket.on("control", async data => {
  if (!captureInfo) return;
  try {
    const now = Date.now();
    if (data.type === "mousemove" && now - lastMove < 20) return;
    lastMove = now;

    const w = await screen.width(), h = await screen.height();
    const x = clamp(Math.round(data.x * w), 0, w - 1);
    const y = clamp(Math.round(data.y * h), 0, h - 1);

    if (["mousemove", "click", "mousedown", "mouseup", "dblclick"].includes(data.type))
      await mouse.setPosition(new Point(x, y));

    if (data.type === "click") await mouse.click();
    else if (data.type === "dblclick") await mouse.doubleClick();
    else if (data.type === "mousedown") await mouse.pressButton(Button.LEFT);
    else if (data.type === "mouseup") await mouse.releaseButton(Button.LEFT);
    else if (data.type === "wheel") {
      if (data.deltaY > 0) await mouse.scrollDown(200);
      else await mouse.scrollUp(200);
    }

    if (["keydown", "keyup"].includes(data.type)) {
      const key = (data.key || "").toLowerCase();
      if (keyMap[key]) {
        if (data.type === "keydown") await keyboard.pressKey(keyMap[key]);
        else await keyboard.releaseKey(keyMap[key]);
      } else if (data.type === "keydown" && key.length === 1) {
        await keyboard.type(key);
      }
    }
  } catch (err) {
    console.error("⚠️ Control error:", err.message);
  }
});

// ---- Cleanup ----
process.on("SIGINT", () => {
  console.log("👋 Agent exiting...");
  stopScreenStream();
  process.exit(0);
});

console.log("🟢 Agent ready for remote control & screen streaming...");
