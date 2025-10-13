// server.js (Ready-for-Render - Complete File) - RDP Forward Fix

const http = require('http');
const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 9000;
const FRONTEND_URL = "https://screen-sharing-frontend.vercel.app"; 

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === FRONTEND_URL) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true
}));

app.get("/", (req, res) => {
  res.send("Backend is LIVE ✅ (vFinal) — Agent + RDP + ScreenShare");
});

app.get("/download-agent", (req, res) => {
  const roomId = req.query.room || "room1";
  const agentDir = path.join(__dirname, "agent");

  try {
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
    const configPath = path.join(agentDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ roomId }, null, 2));
    console.log(`📝 Created config.json for agent (room=${roomId})`);
  } catch (err) {
    console.error("⚠️ Failed to write agent config:", err);
  }

  const exePath = path.join(agentDir, "agent.exe");
  if (!fs.existsSync(exePath)) {
    console.warn("⚠️ Agent executable not found at:", exePath);
    return res.status(404).send("Agent not available on server");
  }

  res.download(exePath, "remote-agent.exe", (err) => {
    if (err) {
      console.error("Agent download error:", err);
      try { res.status(500).send("Download failed"); } catch(e){}
    } else {
      console.log("⬇️ Agent download served for room:", roomId);
    }
  });
});

// socket.io setup
const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET","POST"] },
  pingTimeout: 30000,
  pingInterval: 10000,
});

const peers = {}; 
const users = {}; 
const pendingRDPRequests = {}; 
const rdpRequesters = {}; // NEW: roomId -> socketId who requested RDP

function broadcastUserList() {
  const list = Object.entries(peers).map(([id, p]) => ({
    id, name: p.name || "Unknown", roomId: p.roomId || null,
    isAgent: !!p.isAgent, isSharing: !!p.isSharing
  }));
  io.emit("peer-list", list);
}

io.on("connection", socket => {
  console.log("🟢 Socket connected:", socket.id);

  socket.on("set-name", ({ name }) => {
    peers[socket.id] = { ...peers[socket.id], name };
    users[socket.id] = { id: socket.id, name, room: peers[socket.id]?.roomId || null, isOnline: true };
    broadcastUserList();
    console.log(`📝 set-name: ${name} (${socket.id})`);
  });

  socket.on("join-room", ({ roomId, name, isAgent = false }) => {
    peers[socket.id] = { ...peers[socket.id], name, roomId, isAgent, isSharing: false };
    socket.join(roomId);
    users[socket.id] = { id: socket.id, name: name || peers[socket.id]?.name || "Unknown", room: roomId, isOnline: true };

    socket.to(roomId).emit("peer-joined", { id: socket.id, name: peers[socket.id].name, isAgent });
    broadcastUserList();
    console.log(`👤 ${name || 'Unknown'} joined room: ${roomId} (Agent=${isAgent})`);

    if (isAgent && pendingRDPRequests[roomId]) {
      console.log(`⚡ Pending RDP request found for room ${roomId} — sending start-rdp-capture to agent ${socket.id}`);
      io.to(socket.id).emit("start-rdp-capture");
      delete pendingRDPRequests[roomId];
    }
  });

  socket.on("get-peers", () => broadcastUserList());

  socket.on("request-screen", ({ roomId, from }) => {
    console.log(`📨 request-screen from ${socket.id} for room ${roomId}`);
    socket.to(roomId).emit("screen-request", { from, name: peers[socket.id]?.name || "Unknown" });
  });

  socket.on("permission-response", ({ to, accepted }) => {
    console.log(`🔁 permission-response from ${socket.id} to ${to} accepted=${accepted}`);
    if (accepted && peers[socket.id]) peers[socket.id].isSharing = true;
    io.to(to).emit("permission-result", accepted);
  });

  // start-rdp-capture: track requester
  socket.on("start-rdp-capture", ({ roomId }) => {
    console.log(`🚀 start-rdp-capture requested for room ${roomId} by ${socket.id}`);
    let sent = false;
    rdpRequesters[roomId] = socket.id; // store who requested RDP
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && p.isAgent) {
        io.to(id).emit("start-rdp-capture");
        console.log(`📡 start-rdp-capture sent to agent: ${id}`);
        sent = true;
      }
    }
    if (!sent) {
      console.log(`⏳ No agent online for room ${roomId} — storing pending request`);
      pendingRDPRequests[roomId] = true;
    }
  });

  // agent reports RDP ready → send only to requester
  socket.on("windows-rdp-ready", (data) => {
    const { roomId } = peers[socket.id] || {};
    const requesterId = rdpRequesters[roomId];
    console.log(`📨 windows-rdp-ready from ${socket.id} (room=${roomId}) -> ${data.ip || 'no-ip'}`);
    if (requesterId && io.sockets.sockets.get(requesterId)) {
      io.to(requesterId).emit("windows-rdp-connect", data);
      delete rdpRequesters[roomId]; // clear after sending
    }
  });

  // rest of your events unchanged
  socket.on("capture-info", (info) => {
    console.log("📐 capture-info:", info && info.roomId);
    peers[socket.id] = { ...peers[socket.id], captureInfo: info };
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === info.roomId && p.isAgent) io.to(id).emit("capture-info", info);
    }
  });

  socket.on("control", (data) => {
    const { roomId } = peers[socket.id] || {};
    if (!roomId) return;
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && p.isAgent) io.to(id).emit("control", data);
    }
  });

  socket.on("signal", ({ roomId, desc, candidate }) => {
    socket.to(roomId).emit("signal", { desc, candidate });
  });

  socket.on("stop-share", ({ roomId, name }) => {
    if (peers[socket.id]) peers[socket.id].isSharing = false;
    io.in(roomId).emit("stop-share", { name });
  });

  socket.on("leave-room", ({ roomId, name }) => {
    const actual = roomId || (peers[socket.id] && peers[socket.id].roomId);
    if (actual) {
      try { socket.leave(actual); } catch (e) {}
      if (peers[socket.id]) peers[socket.id].roomId = null;
      if (users[socket.id]) { users[socket.id].room = null; users[socket.id].isOnline = false; }
      socket.to(actual).emit("peer-left", { id: socket.id, name: name || peers[socket.id]?.name });
      broadcastUserList();
      console.log(`🚪 ${name || peers[socket.id]?.name || socket.id} left room ${actual}`);
    }
  });

  socket.on("disconnect", () => {
    const { roomId, isSharing } = peers[socket.id] || {};
    console.log(`❌ Disconnected: ${socket.id} (room=${roomId})`);
    delete peers[socket.id];
    delete users[socket.id];
    if (roomId) {
      socket.to(roomId).emit("peer-left", { id: socket.id });
      if (isSharing) socket.to(roomId).emit("stop-share");
    }
    broadcastUserList();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
