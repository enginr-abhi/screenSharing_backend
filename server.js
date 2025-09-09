const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const PORT = process.env.PORT || 9000;
const app = express();
const server = http.createServer(app);
app.use(cors());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// socket.id => { name, role }
const peers = {};

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --- Join room
  socket.on("join-room", ({ roomId, name, role }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const members = room ? [...room] : [];

    // ✅ Only 1 sharer allowed
    if (role === "sharer") {
      const sharerExists = members.some(id => peers[id]?.role === "sharer");
      if (sharerExists) {
        return socket.emit("room-full", "Sharer already exists in this room.");
      }
    }

    socket.join(roomId);
    peers[socket.id] = { name, role: role || "viewer" };

    // Notify others (but not agent)
    if (role !== "agent") {
      socket.to(roomId).emit("peer-joined", { id: socket.id, name, role });
    }

    console.log(`🔗 ${name} (${role || "viewer"}) joined room ${roomId}`);
  });

  // --- Screen request
  socket.on("request-screen", ({ roomId, from }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return;

    for (const id of room) {
      if (id !== from && peers[id]?.role === "sharer") {
        const name = peers[from]?.name || "Unknown";
        io.to(id).emit("screen-request", { from, name });
      }
    }
  });

  socket.on("permission-response", ({ to, accepted }) => {
    io.to(to).emit("permission-result", accepted);
  });

  // --- WebRTC signaling
  socket.on("signal", ({ roomId, desc, candidate }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return;

    for (const id of room) {
      if (id !== socket.id) {
        if (desc) io.to(id).emit("signal", { desc });
        if (candidate) io.to(id).emit("signal", { candidate });
      }
    }
  });

  // --- 🔹 Remote control events
  socket.on("control-event", ({ roomId, event }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return;

    // Forward to all except sender
    for (const id of room) {
      if (id !== socket.id) {
        io.to(id).emit("control-event", { event });
      }
    }

    // Also forward as system-control for agents
    io.to(roomId).emit("system-control", event);
  });

  // --- Stop sharing
  socket.on("stop-share", (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return;

    for (const id of room) {
      if (id !== socket.id) io.to(id).emit("remote-stopped");
    }
  });

  // --- Disconnect
  socket.on("disconnecting", () => {
    const peerInfo = peers[socket.id];
    delete peers[socket.id];

    for (const roomId of socket.rooms) {
      if (roomId !== socket.id && peerInfo?.role !== "agent") {
        socket.to(roomId).emit("peer-left", { id: socket.id });
      }
    }
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});
