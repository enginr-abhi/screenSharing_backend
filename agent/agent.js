// agent.js (Node.js)

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
      console.warn("⚠️ Not running as Admin! Mouse/keyboard may fail. Please run with Admin rights.");
    }
  } else if (platform === "darwin") {
    console.warn("⚠️ macOS requires Accessibility permission for control.");
  } else if (platform === "linux" && process.getuid && process.getuid() !== 0) {
    console.warn("⚠️ Run with sudo for control.");
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
const socket = io("https://screensharing-test-backend.onrender.com", { // Apne backend URL se badal lein
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
    execSync('reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f', { stdio: "ignore" });
    execSync('netsh advfirewall firewall set rule group="remote desktop" new enable=Yes', { stdio: "ignore" });
    execSync('reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f', { stdio: "ignore" });
    console.log("✅ Windows RDP Enabled Successfully");
    
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
      // If RDP failed, send fallback system info
      const systemInfo = getSystemInfo();
      socket.emit('windows-rdp-ready', systemInfo);
    }
  } else {
    // Send system info for non-windows platforms (User must use external RDP/VNC)
    const systemInfo = getSystemInfo();
    socket.emit('windows-rdp-ready', systemInfo);
  }
});

// ---- Existing Events (Unchanged) ----
socket.on("disconnect", () => console.log("❌ Agent disconnected"));

socket.on("capture-info", info => {
  captureInfo = info;
  console.log("📐 Capture info received (Control Enabled):", info);
});

socket.on("stop-share", ({ name }) => {
  captureInfo = null;
  console.log(`🛑 Stop-share received from ${name}`);
});

// ---- Key mapping and Control handler ----
const keyMap = {
  'escape': Key.Escape, 'enter': Key.Enter, 'tab': Key.Tab, 'capslock': Key.CapsLock,
  'shift': Key.LeftShift, 'control': Key.LeftControl, 'alt': Key.LeftAlt,
  'meta': Key.LeftSuper, // Windows key or Command key
  'delete': Key.Delete, 'backspace': Key.Backspace, 'space': Key.Space,
  'insert': Key.Insert, 'home': Key.Home, 'end': Key.End,
  'pageup': Key.PageUp, 'pagedown': Key.PageDown,
  'left': Key.Left, 'up': Key.Up, 'right': Key.Right, 'down': Key.Down,
  'f1': Key.F1, 'f2': Key.F2, 'f3': Key.F3, 'f4': Key.F4,
  'f5': Key.F5, 'f6': Key.F6, 'f7': Key.F7, 'f8': Key.F8,
  'f9': Key.F9, 'f10': Key.F10, 'f11': Key.F11, 'f12': Key.F12,
  ';': Key.Semicolon, '=': Key.Equal, ',': Key.Comma, '-': Key.Minus, '.': Key.Period, '/': Key.Slash,
  '`': Key.Grave, '[': Key.OpenBracket, '\\': Key.Backslash, ']': Key.CloseBracket, "'": Key.Quote,
  '1': Key.D1, '2': Key.D2, '3': Key.D3, '4': Key.D4, '5': Key.D5,
  '6': Key.D6, '7': Key.D7, '8': Key.D8, '9': Key.D9, '0': Key.D0,
  'a': Key.A, 'b': Key.B, 'c': Key.C, 'd': Key.D, 'e': Key.E, 'f': Key.F, 'g': Key.G,
  'h': Key.H, 'i': Key.I, 'j': Key.J, 'k': Key.K, 'l': Key.L, 'm': Key.M, 'n': Key.N,
  'o': Key.O, 'p': Key.P, 'q': Key.Q, 'r': Key.R, 's': Key.S, 't': Key.T, 'u': Key.U,
  'v': Key.V, 'w': Key.W, 'x': Key.X, 'y': Key.Y, 'z': Key.Z,
};

socket.on("control", async data => {
  // Check for captureInfo (set by script.js)
  if (!captureInfo) {
    console.warn("⚠️ Control received but captureInfo is missing. Control disabled.");
    return;
  }
  try {
    if (["mousemove", "click", "mousedown", "mouseup", "dblclick", "wheel"].includes(data.type)) {
      
      const now = Date.now();
      if (data.type === "mousemove" && now - lastMoveTs < MOVE_THROTTLE_MS) return;
      lastMoveTs = now;
      
      // Calculate absolute coordinates based on the fixed size sent by the client (1280x720)
      const w = (captureInfo.captureWidth || 1280) * (captureInfo.devicePixelRatio || 1);
      const h = (captureInfo.captureHeight || 720) * (captureInfo.devicePixelRatio || 1);
      
      // Convert relative coordinates (0 to 1) from client to source coordinates
      const srcX = typeof data.x === "number" ? Math.round(data.x * w) : null;
      const srcY = typeof data.y === "number" ? Math.round(data.y * h) : null;
      
      // Get actual screen resolution
      const displayWidth = await screen.width();
      const displayHeight = await screen.height();
      
      // Map source coordinates to actual display coordinates
      const absX = srcX !== null ? clamp(Math.round(srcX * (displayWidth / Math.max(1, w))), 0, displayWidth - 1) : null;
      const absY = srcY !== null ? clamp(Math.round(srcY * (displayHeight / Math.max(1, h))), 0, displayHeight - 1) : null;
      
      // Execute mouse movement
      if (absX !== null && absY !== null) await mouse.setPosition(new Point(absX, absY));
      
      // Execute mouse clicks
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
function isPrintableChar(s) { return typeof s === "string" && s.length === 1; }
const mapBtn = btn => btn === 2 ? Button.RIGHT : (btn === 1 ? Button.MIDDLE : Button.LEFT);

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