const http = require('http');
const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 9000;

const app = express();
const server = http.createServer(app);

app.use(cors());

app.get("/", (req, res) => {
  res.send("Backend is LIVE ✅, version: 6 (RDP support added)");
});

// ✅ Dynamic agent download (with room info)
app.get("/download-agent", (req, res) => {
  const roomId = req.query.room || "room1";
  const agentDir = path.join(__dirname, "agent");

  // Write config.json dynamically for the agent
  try {
    const configPath = path.join(agentDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ roomId }, null, 2));
    console.log(`📝 Created config.json for room: ${roomId}`);
  } catch (err) {
    console.error("⚠️ Failed to write config.json:", err);
  }

  const filePath = path.join(agentDir, "agent.exe");
  res.download(filePath, "remote-agent.exe", err => {
    if (err) {
      console.error("Download error:", err);
      res.status(500).send("File not found");
    }
  });
});

const io = new Server(server, {
  cors: { origin: "https://screen-sharing-frontend.vercel.app", methods: ["GET", "POST"] }
});

const peers = {}; // socketId -> { name, roomId, isAgent, isSharing, captureInfo? }
const users = {}; // socketId -> { id, name, room, isOnline }

// Helper: broadcast full user list to everyone
function broadcastUserList() {
  const userList = Object.entries(users).map(([id, u]) => ({
    id,
    name: u.name || "Unknown",
    roomId: u.room || "N/A",
    isOnline: !!u.isOnline
  }));
  io.emit("peer-list", userList);
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  // ---- NEW: System info receive kare ----
  socket.on('system-info', (systemInfo) => {
    console.log(`📊 System info from ${socket.id}:`, systemInfo.ip);
    peers[socket.id] = { ...peers[socket.id], systemInfo };
  });

  // ---- NEW: Windows RDP ready event ----
  socket.on('windows-rdp-ready', (data) => {
    const { roomId } = peers[socket.id] || {};
    if (roomId) {
      console.log(`📨 RDP Ready in room ${roomId}: ${data.ip}`);
      // User1 ko RDP connection details bhejo
      socket.to(roomId).emit('windows-rdp-connect', data);
    }
  });

  // ---- NEW: RDP start command ----
  socket.on('start-rdp-capture', ({ roomId }) => {
    console.log(`🚀 RDP start requested for room: ${roomId}`);
    // Room ke sab agents ko RDP start karne ka signal bhejo
    for (const [id, peer] of Object.entries(peers)) {
      if (peer.roomId === roomId && peer.isAgent) {
        io.to(id).emit('start-rdp-capture');
        console.log(`📡 Sent RDP start to agent: ${id}`);
      }
    }
  });

  // ---- EXISTING CODE (unchanged) ----
  socket.on("set-name", ({ name }) => {
    peers[socket.id] = { ...peers[socket.id], name };
    users[socket.id] = { id: socket.id, name, room: peers[socket.id]?.roomId || null, isOnline: true };
    io.emit("update-users", Object.values(users));
    broadcastUserList();
  });

  socket.on("join-room", ({ roomId, name, isAgent = false }) => {
    peers[socket.id] = { ...peers[socket.id], name, roomId, isAgent, isSharing: false };
    socket.join(roomId);
    users[socket.id] = { id: socket.id, name: name || peers[socket.id]?.name || "Unknown", room: roomId, isOnline: true };

    socket.to(roomId).emit("peer-joined", { id: socket.id, name: peers[socket.id].name, isAgent });
    io.emit("update-users", Object.values(users));
    broadcastUserList();

    console.log(`👤 ${name || 'Unknown'} joined room: ${roomId} (Agent: ${isAgent})`);
  });

  socket.on("get-peers", () => broadcastUserList());

  socket.on("leave-room", ({ roomId, name }) => {
    const actualRoom = roomId || (peers[socket.id] && peers[socket.id].roomId);
    if (actualRoom) {
      try { socket.leave(actualRoom); } catch (e) { /* ignore */ }

      if (peers[socket.id]) {
        peers[socket.id].roomId = null;
      }
      if (users[socket.id]) {
        users[socket.id].room = null;
        users[socket.id].isOnline = false;
      }

      socket.to(actualRoom).emit("peer-left", { id: socket.id, name: name || peers[socket.id]?.name });
      io.emit("update-users", Object.values(users));
      broadcastUserList();

      console.log(`🚪 ${name || peers[socket.id]?.name || socket.id} left room: ${actualRoom}`);
    }
  });

  socket.on("disconnect", () => {
    const { roomId, isSharing } = peers[socket.id] || {};
    delete peers[socket.id];
    delete users[socket.id];

    io.emit("update-users", Object.values(users));
    broadcastUserList();

    if (roomId) {
      socket.to(roomId).emit("peer-left", { id: socket.id });
      if (isSharing) socket.to(roomId).emit("stop-share");
    }
    console.log(`❌ Disconnected: ${socket.id}`);
  });

  // ---- Existing screen sharing events ----
  socket.on("request-screen", ({ roomId, from }) => {
    socket.to(roomId).emit("screen-request", { from, name: peers[socket.id]?.name });
  });

  socket.on("permission-response", ({ to, accepted }) => {
    if (accepted && peers[socket.id]) peers[socket.id].isSharing = true;
    io.to(to).emit("permission-result", accepted);
  });

  socket.on("stop-share", ({ roomId, name }) => {
    if (peers[socket.id]) peers[socket.id].isSharing = false;
    io.in(roomId).emit("stop-share", { name });
  });

  socket.on("signal", ({ roomId, desc, candidate }) => {
    socket.to(roomId).emit("signal", { desc, candidate });
  });

  socket.on("capture-info", info => {
    peers[socket.id] = { ...peers[socket.id], captureInfo: info, roomId: info.roomId };
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === info.roomId && p.isAgent) io.to(id).emit("capture-info", info);
    }
  });

  socket.on("control", data => {
    const { roomId } = peers[socket.id] || {};
    if (!roomId) return;
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === roomId && p.isAgent) io.to(id).emit("control", data);
    }
  });
});

server.listen(PORT, '0.0.0.0',() => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});