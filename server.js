// ✅ server.js (Render Ready + Screen Share Visible Fix)
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 9000;
const FRONTEND_URL = "https://screen-sharing-frontend.vercel.app";

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === FRONTEND_URL) return callback(null, true);
    callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true,
}));

app.get("/", (req, res) => {
  res.send("✅ Backend is LIVE — ScreenShare + Remote Control Ready");
});

// --- Agent Download Route ---
app.get("/download-agent", (req, res) => {
  const roomId = req.query.room || "room1";
  const agentDir = path.join(__dirname, "agent");

  try {
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "config.json"),
      JSON.stringify({ roomId }, null, 2)
    );
    console.log(`📝 Agent config created for room=${roomId}`);
  } catch (err) {
    console.error("⚠️ Failed to write agent config:", err);
  }

  const exePath = path.join(agentDir, "agent.exe");
  if (!fs.existsSync(exePath)) {
    console.warn("⚠️ Agent.exe missing at:", exePath);
    return res.status(404).send("Agent executable not found on server");
  }

  res.download(exePath, "remote-agent.exe", (err) => {
    if (err) {
      console.error("⚠️ Agent download error:", err);
      res.status(500).send("Download failed");
    } else {
      console.log(`⬇️ Agent download started for room=${roomId}`);
    }
  });
});

// --- SOCKET.IO Setup ---
const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// --- Memory store ---
const peers = {};
const users = {};
const pendingRDPRequests = {};
const rdpRequesters = {};

// --- Helper: Broadcast online users ---
function broadcastUserList() {
  const list = Object.entries(peers).map(([id, p]) => ({
    id,
    name: p.name || "Unknown",
    roomId: p.roomId || null,
    isAgent: !!p.isAgent,
    isSharing: !!p.isSharing,
  }));
  io.emit("peer-list", list);
}

// --- SOCKET EVENTS ---
io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);

  // ✅ Set Name
  socket.on("set-name", ({ name }) => {
    peers[socket.id] = { ...peers[socket.id], name };
    users[socket.id] = {
      id: socket.id,
      name,
      room: peers[socket.id]?.roomId || null,
      isOnline: true,
    };
    broadcastUserList();
    console.log(`👤 set-name: ${name}`);
  });

  // ✅ Join Room
  socket.on("join-room", ({ roomId, name, isAgent = false }) => {
    peers[socket.id] = { ...peers[socket.id], name, roomId, isAgent, isSharing: false };
    socket.join(roomId);
    users[socket.id] = { id: socket.id, name, room: roomId, isOnline: true };

    socket.to(roomId).emit("peer-joined", { id: socket.id, name, isAgent });
    broadcastUserList();

    console.log(`📥 ${name} joined ${roomId} (Agent=${isAgent})`);

    if (isAgent && pendingRDPRequests[roomId]) {
      console.log(`⚡ Sending pending start-rdp-capture to agent for ${roomId}`);
      io.to(socket.id).emit("start-rdp-capture");
      delete pendingRDPRequests[roomId];
    }
  });

  // ✅ Screen Request (viewer → target)
  socket.on("request-screen", ({ roomId, from }) => {
    socket.to(roomId).emit("screen-request", { from, name: peers[socket.id]?.name || "Unknown" });
  });

  // ✅ Target’s Permission Response
  socket.on("permission-response", ({ to, accepted }) => {
    console.log(`🔁 permission-response: ${accepted}`);
    if (accepted && peers[socket.id]) peers[socket.id].isSharing = true;
    io.to(to).emit("permission-result", accepted);
  });

  // ✅ Start RDP
  socket.on("start-rdp-capture", ({ roomId }) => {
    console.log(`🚀 start-rdp-capture for room ${roomId}`);
    rdpRequesters[roomId] = socket.id;
    let sent = false;

    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && p.isAgent) {
        io.to(id).emit("start-rdp-capture");
        console.log(`📡 start-rdp-capture sent to agent ${id}`);
        sent = true;
      }
    }

    if (!sent) {
      console.log(`⏳ No agent online — stored pending request for ${roomId}`);
      pendingRDPRequests[roomId] = true;
    }
  });

  // ✅ Agent confirms RDP ready
  socket.on("windows-rdp-ready", (data) => {
    const { roomId } = peers[socket.id] || {};
    const requesterId = rdpRequesters[roomId];
    console.log(`💻 RDP ready from agent (${socket.id}) for room=${roomId}`);

    if (requesterId) {
      io.to(requesterId).emit("windows-rdp-connect", data);
      delete rdpRequesters[roomId];
    }
  });

  // ✅ Send live screenshots (Agent → Frontend)
  socket.on("screen-frame", ({ roomId, image }) => {
    // Forward image only to non-agent users in the same room
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && !p.isAgent) {
        io.to(id).emit("screen-frame", { image }); // frontend shows this on <img id="remoteImg">
      }
    }
  });

  // ✅ Capture Info + Mouse/Keyboard Control
  socket.on("capture-info", (info) => {
    const { roomId } = info || {};
    if (!roomId) return;
    peers[socket.id] = { ...peers[socket.id], captureInfo: info };

    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && p.isAgent) io.to(id).emit("capture-info", info);
    }
  });

  socket.on("control", (data) => {
    const { roomId } = peers[socket.id] || {};
    if (!roomId) return;
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && p.isAgent) io.to(id).emit("control", data);
    }
  });

  // ✅ Signaling (for optional WebRTC)
  socket.on("signal", ({ roomId, desc, candidate }) => {
    socket.to(roomId).emit("signal", { desc, candidate });
  });

  // ✅ Stop Share
  socket.on("stop-share", ({ roomId, name }) => {
    if (peers[socket.id]) peers[socket.id].isSharing = false;
    io.in(roomId).emit("stop-share", { name });
  });

  // ✅ Leave Room
  socket.on("leave-room", ({ roomId, name }) => {
    const actual = roomId || (peers[socket.id] && peers[socket.id].roomId);
    if (!actual) return;
    socket.leave(actual);

    if (peers[socket.id]) peers[socket.id].roomId = null;
    if (users[socket.id]) users[socket.id].isOnline = false;

    socket.to(actual).emit("peer-left", { id: socket.id, name });
    broadcastUserList();

    console.log(`🚪 ${name || socket.id} left ${actual}`);
  });

  // ✅ Disconnect
  socket.on("disconnect", () => {
    const { roomId, isSharing } = peers[socket.id] || {};
    delete peers[socket.id];
    delete users[socket.id];

    if (roomId) {
      socket.to(roomId).emit("peer-left", { id: socket.id });
      if (isSharing) socket.to(roomId).emit("stop-share");
    }

    broadcastUserList();
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
