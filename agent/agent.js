// agent.js (Node.js) - FINAL FIX with WebSocket screen streaming

const os = require("os");
const process = require("process");
const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");
const { mouse, keyboard, Key, Point, Button, screen } = require("@nut-tree-fork/nut-js");
const { execSync, spawn } = require("child_process");

// NEW deps for screen streaming
let WebSocket;
let screenshot;
try {
  WebSocket = require('ws');
  screenshot = require('screenshot-desktop');
} catch (err) {
  console.warn("⚠️ Missing optional streaming deps. Run: npm install ws screenshot-desktop");
}

// NOTE: Apne backend URL se badal lein.
const BACKEND_URL = "https://screensharing-test-backend.onrender.com"; 

// ---- Permission check (UPDATED: Clearer Admin Check) ----
function checkPermissions() {
  const platform = os.platform();
  if (platform === "win32") {
    try {
      execSync("net session", { stdio: "ignore" });
      console.log("✅ Running as Administrator");
    } catch {
      console.error("\n\n#####################################################");
      console.error("🛑 ERROR: Agent is NOT running as Administrator!");
      console.error("RDP service and Control WILL FAIL. Please relaunch with Admin rights.");
      console.error("#####################################################\n");
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
const socket = io(BACKEND_URL, { 
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000
});

let captureInfo = null, lastMoveTs = 0;
const MOVE_THROTTLE_MS = 15;

// --- Screen streaming state ---
let screenWSS = null;
let screenInterval = null;
let screenPort = null;
let streamClients = 0;
const STREAM_FPS = 8; // default fps (adjust for performance)
const STREAM_INTERVAL_MS = Math.round(1000 / STREAM_FPS);

// ---- Windows RDP Functions (FIXED for Firewall) ----
function enableWindowsRDP() {
  try {
    console.log("🔄 Enabling Windows RDP and opening Firewall Port (3389)...");
    
    // 1. Enable RDP via Registry
    execSync('reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f', { stdio: "ignore" });
    
    // 2. Enable Firewall rules for Remote Desktop (Opens default rule group)
    execSync('netsh advfirewall firewall set rule group="remote desktop" new enable=Yes', { stdio: "ignore" });
    
    // 3. Set User Authentication (less strict for testing)
    execSync('reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f', { stdio: "ignore" });
    
    // 4. FIX: Explicitly add an inbound rule for Port 3389 (in case group rule fails)
    try {
      execSync('netsh advfirewall firewall add rule name="AllowRDP_Custom" dir=in action=allow protocol=TCP localport=3389', { stdio: "ignore" });
      console.log("✅ Firewall rule (Port 3389) added successfully.");
    } catch(e) {
      console.warn("⚠️ Could not add custom firewall rule. Network security may block connection.");
    }
    
    console.log("✅ Windows RDP Enabled Successfully");
    
    // Get IP and send ready signal
    const systemInfo = getSystemInfo();
    socket.emit('windows-rdp-ready', systemInfo);
    
    console.log(`📡 RDP Ready - IP: ${systemInfo.ip}, Username: ${systemInfo.username}, Computer: ${systemInfo.computerName}`);
    return true;
  } catch (error) {
    console.error('❌ RDP Enable Failed:', error.message.includes('Access is denied') ? 
      'RDP Enable Failed: Run Agent as Administrator!' : 
      `RDP Enable Failed: ${error.message}`);
    return false;
  }
}

function getSystemInfo() {
  const networkInterfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const interfaceName in networkInterfaces) {
    for (const iface of networkInterfaces[interfaceName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
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

// ---- WebSocket screen streaming ----
async function startScreenStream() {
  if (!WebSocket || !screenshot) {
    console.warn("⚠️ WebSocket or screenshot module not available. Install 'ws' and 'screenshot-desktop'.");
    return null;
  }
  if (screenWSS) {
    console.log("ℹ️ Screen stream already running on port", screenPort);
    return screenPort;
  }

  // Create WebSocket server on ephemeral port (0 => pick free port)
  screenWSS = new WebSocket.Server({ port: 0 });
  screenWSS.on('listening', () => {
    const address = screenWSS.address();
    screenPort = (address && address.port) || screenPort;
    console.log(`📺 Screen WebSocket server listening on port ${screenPort}`);
    // Notify backend (so backend can forward addr/port to the requester)
    const sys = getSystemInfo();
    socket.emit('screen-stream-ready', { roomId: ROOM, ip: sys.ip, port: screenPort });
  });

  screenWSS.on('connection', (ws, req) => {
    streamClients++;
    console.log("👀 Screen viewer connected (clients):", streamClients);
    // When a client connects, start capturing if not already
    if (!screenInterval) {
      screenInterval = setInterval(async () => {
        try {
          // screenshot returns Buffer (PNG) by default
          const imgBuf = await screenshot({ format: 'png' });
          // Broadcast to all clients
          for (const client of screenWSS.clients) {
            if (client.readyState === WebSocket.OPEN) {
              // send binary PNG frame
              client.send(imgBuf);
            }
          }
        } catch (err) {
          console.error("⚠️ Screenshot failed:", err && err.message ? err.message : err);
        }
      }, STREAM_INTERVAL_MS);
      console.log(`🔁 Screen capture loop started (${STREAM_FPS} FPS)`);
    }

    ws.on('close', () => {
      streamClients = Math.max(0, streamClients - 1);
      console.log("👋 Screen viewer disconnected. clients:", streamClients);
      if (streamClients === 0 && screenInterval) {
        clearInterval(screenInterval);
        screenInterval = null;
        console.log("🛑 Screen capture loop stopped (no viewers)");
      }
    });

    ws.on('error', (e) => console.warn("⚠️ Screen WS error:", e));
  });

  screenWSS.on('error', (err) => {
    console.error("⚠️ Screen WSS error:", err && err.message ? err.message : err);
    // try to close and cleanup
    try { screenWSS.close(); } catch(e){ }
    screenWSS = null;
    screenPort = null;
  });

  return screenPort;
}

function stopScreenStream() {
  if (screenInterval) {
    clearInterval(screenInterval);
    screenInterval = null;
  }
  if (screenWSS) {
    try { screenWSS.clients.forEach(c => c.terminate()); } catch(e){}
    try { screenWSS.close(); } catch(e){}
    screenWSS = null;
    console.log("🛑 Screen WebSocket server stopped");
  }
}

// ---- RDP Start Command ----
socket.on('start-rdp-capture', async () => {
  console.log("🚀 Received RDP start command");
  if (os.platform() === 'win32') {
    const success = enableWindowsRDP();
    if (!success) {
      // If RDP failed, send fallback system info
      const systemInfo = getSystemInfo();
      socket.emit('windows-rdp-ready', systemInfo);
    }
  } else {
    const systemInfo = getSystemInfo();
    socket.emit('windows-rdp-ready', systemInfo);
  }

  // Start screen streaming (optional but helpful) and notify backend
  try {
    const port = await startScreenStream();
    if (port) {
      console.log("📡 Screen stream ready on port", port);
      // backend already received 'screen-stream-ready' when WSS started
    }
  } catch (err) {
    console.warn("⚠️ Could not start screen stream:", err);
  }
});

// ---- Existing Events (Unchanged) ----
socket.on("disconnect", () => {
  console.log("❌ Agent disconnected");
  // cleanup streaming on disconnect
  stopScreenStream();
});

socket.on("capture-info", info => {
  captureInfo = info;
  console.log("📐 Capture info received (Control Enabled):", info);
});

socket.on("stop-share", ({ name }) => {
  captureInfo = null;
  console.log(`🛑 Stop-share received from ${name}`);
  stopScreenStream();
});

// ---- Key mapping and Control handler (Unchanged) ----
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
      
      // Convert relative coordinates (0 to 1) from client to screen coordinates
      // frontend should send normalized 0..1 coords (we expect that)
      const displayWidth = await screen.width();
      const displayHeight = await screen.height();
      const absX = typeof data.x === "number" ? clamp(Math.round(data.x * displayWidth), 0, displayWidth - 1) : null;
      const absY = typeof data.y === "number" ? clamp(Math.round(data.y * displayHeight), 0, displayHeight - 1) : null;
      
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
console.log("🔧 RDP & Screen Stream: Enabled - Will auto-enable Windows Remote Desktop when requested");

// ---- Graceful exit ----
process.on("SIGINT", async () => {
  console.log("👋 Agent shutting down...");
  stopScreenStream();
  try { await keyboard.releaseKey(...Object.values(keyMap)); } catch(e){}
  process.exit();
});

// ---- Auto-reconnect and status ----
socket.on("reconnect", () => {
  console.log("🔁 Reconnected to server");
  socket.emit("join-room", { roomId: ROOM, isAgent: true });
});
