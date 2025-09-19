//server.js //
const http = require('http');
const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const PORT = process.env.PORT || 9000;
const app = express();
const server = http.createServer(app);
const path = require("path");
app.use(cors());
app.get("/", (req, res) => {
  res.send("Backend is LIVE ✅, version: 2");
});
app.get("/download-agent", (req, res) => {
  res.download(path.join(__dirname, "../remote-agent/agent.exe"));
});

const io = new Server(server, { cors: { origin: "https://screen-sharing-frontend.vercel.app/" , methods: ["GET","POST"] } });

const peers = {}; // socketId -> { name, roomId, isAgent, isSharing, captureInfo? }

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("set-name", ({ name }) => { peers[socket.id] = { ...peers[socket.id], name }; });

  socket.on("join-room", ({ roomId, isAgent = false }) => {
    peers[socket.id] = { ...peers[socket.id], roomId, isAgent, isSharing: false };
    socket.join(roomId);
    socket.to(roomId).emit("peer-joined", { id: socket.id, name: peers[socket.id].name, isAgent });
  });

  socket.on("disconnect", () => {
    const { roomId, isSharing } = peers[socket.id] || {};
    if (roomId) {
      socket.to(roomId).emit("peer-left", { id: socket.id });
      if (isSharing) socket.to(roomId).emit("stop-share");
    }
    delete peers[socket.id];
  });

  // ---- Screen request & permission ----
  socket.on("request-screen", ({ roomId, from }) => {
    socket.to(roomId).emit("screen-request", { from, name: peers[socket.id]?.name });
  });

  socket.on("permission-response", ({ to, accepted }) => {
    if (accepted && peers[socket.id]) peers[socket.id].isSharing = true;
    io.to(to).emit("permission-result", accepted);
  });

  socket.on("stop-share", roomId => {
    if (peers[socket.id]) peers[socket.id].isSharing = false;
    socket.to(roomId).emit("stop-share");
  });

  // ---- WebRTC signaling ----
  socket.on("signal", ({ roomId, desc, candidate }) => {
    socket.to(roomId).emit("signal", { desc, candidate });
  });

  // ---- Capture info (resolution & scaling) ----
  socket.on("capture-info", info => {
    peers[socket.id] = { ...peers[socket.id], captureInfo: info, roomId: info.roomId };
    for (const [id, p] of Object.entries(peers)) {
      if (p.roomId === info.roomId && p.isAgent) io.to(id).emit("capture-info", info);
    }
  });

  // ---- Remote control events ----
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
