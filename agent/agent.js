#!/usr/bin/env node
const os = require("os");
const process = require("process");
const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");
const { mouse, keyboard, Key, Point, Button, screen } = require("@nut-tree-fork/nut-js");
const { execSync, spawn } = require("child_process");

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

// ---- Read dynamic room from config.json or args ----
let ROOM = "room1";
try {
  const configPath = path.join(__dirname, "config.json");
  if (fs.existsSync(configPath)) {
    const { roomId } = JSON.parse(fs.readFileSync(configPath, "utf8"));
    ROOM = roomId || ROOM;
  } else if (process.argv[2]) {
    ROOM = process.argv[2];
  } else if (process.env.ROOM) {
    ROOM = process.env.ROOM;
  }
} catch (err) {
  console.error("⚠️ Failed to read config.json:", err);
}

// ---- Socket ----
const socket = io("https://screensharing-test-backend.onrender.com", {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000
});

let captureInfo = null, lastMoveTs = 0;
const MOVE_THROTTLE_MS = 15;

// ---- Windows RDP Functions ----
function enableWindowsRDP() {
    try {
        console.log("🔄 Enabling Windows RDP...");
        
        // 1. RDP enable registry me
        execSync('reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f', { stdio: "ignore" });
        
        // 2. Firewall me RDP allow kare
        execSync('netsh advfirewall firewall set rule group="remote desktop" new enable=Yes', { stdio: "ignore" });
        
        // 3. NLA disable kare (easier connection)
        execSync('reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f', { stdio: "ignore" });
        
        console.log("✅ Windows RDP Enabled Successfully");
        
        // IP address get kare
        const networkInterfaces = os.networkInterfaces();
        let localIP = 'localhost';
        
        for (const interfaceName in networkInterfaces) {
            for (const interface of networkInterfaces[interfaceName]) {
                if (interface.family === 'IPv4' && !interface.internal) {
                    localIP = interface.address;
                    break;
                }
            }
        }
        
        // User1 ko RDP connection details bhejo
        const username = os.userInfo().username;
        const computerName = os.hostname();
        
        socket.emit('windows-rdp-ready', {
            ip: localIP,
            username: username,
            computerName: computerName,
            platform: 'windows',
            roomId: ROOM
        });
        
        console.log(`📡 RDP Ready - IP: ${localIP}, Username: ${username}, Computer: ${computerName}`);
        
        return true;
    } catch (error) {
        console.error('❌ RDP Enable Failed:', error);
        return false;
    }
}

function getSystemInfo() {
    const networkInterfaces = os.networkInterfaces();
    let localIP = 'localhost';
    
    for (const interfaceName in networkInterfaces) {
        for (const interface of networkInterfaces[interfaceName]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                localIP = interface.address;
                break;
            }
        }
    }
    
    return {
        ip: localIP,
        username: os.userInfo().username,
        computerName: os.hostname(),
        platform: os.platform(),
        roomId: ROOM
    };
}

// ---- On connect, join as Agent ----
socket.on("connect", () => {
  console.log("✅ Agent connected:", socket.id, "Room:", ROOM);
  socket.emit("join-room", { roomId: ROOM, isAgent: true });
  
  // Automatically system info send karo
  const systemInfo = getSystemInfo();
  socket.emit('system-info', systemInfo);
  console.log("📊 System info sent to server");
});

// ---- RDP Start Command ----
socket.on('start-rdp-capture', () => {
    console.log("🚀 Received RDP start command");
    if (os.platform() === 'win32') {
        const success = enableWindowsRDP();
        if (!success) {
            // Fallback: system info bhejo
            const systemInfo = getSystemInfo();
            socket.emit('windows-rdp-ready', systemInfo);
        }
    } else {
        // Non-Windows systems ke liye system info bhejo
        const systemInfo = getSystemInfo();
        socket.emit('windows-rdp-ready', systemInfo);
    }
});

// ---- Existing Events ----
socket.on("disconnect", () => console.log("❌ Agent disconnected"));

socket.on("capture-info", info => {
  captureInfo = info;
  console.log("📐 Capture info:", info);
});

socket.on("stop-share", ({ name }) => {
  captureInfo = null;
  console.log(`🛑 Stop-share received from ${name}`);
});

// ---- Key mapping ----
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

// ---- Control handler ----
socket.on("control", async data => {
  if (!captureInfo) return;
  try {
    if (["mousemove", "click", "mousedown", "mouseup", "dblclick", "wheel"].includes(data.type)) {
      const now = Date.now();
      if (data.type === "mousemove" && now - lastMoveTs < MOVE_THROTTLE_MS) return;
      lastMoveTs = now;

      const w = (captureInfo.captureWidth || 1280) * (captureInfo.devicePixelRatio || 1);
      const h = (captureInfo.captureHeight || 720) * (captureInfo.devicePixelRatio || 1);
      const srcX = typeof data.x === "number" ? Math.round(data.x * w) : null;
      const srcY = typeof data.y === "number" ? Math.round(data.y * h) : null;
      const displayWidth = await screen.width();
      const displayHeight = await screen.height();
      const absX = srcX !== null ? clamp(Math.round(srcX * (displayWidth / Math.max(1, w))), 0, displayWidth - 1) : null;
      const absY = srcY !== null ? clamp(Math.round(srcY * (displayHeight / Math.max(1, h))), 0, displayHeight - 1) : null;

      if (absX !== null && absY !== null) await mouse.setPosition(new Point(absX, absY));

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
process.stdin.resume();
console.log("🟢 Agent is now alive and waiting for remote control events...");
console.log("🔧 RDP Support: Enabled - Will auto-enable Windows Remote Desktop when requested");

// ---- Graceful exit ----
process.on("SIGINT", async () => {
  console.log("👋 Agent shutting down...");
  await keyboard.releaseKey(...Object.values(keyMap));
  process.exit();
});

// ---- Auto-reconnect and status ----
socket.on("reconnect", () => {
  console.log("🔁 Reconnected to server");
  socket.emit("join-room", { roomId: ROOM, isAgent: true });
});