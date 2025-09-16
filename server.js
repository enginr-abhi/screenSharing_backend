const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const PORT = process.env.PORT || 9000;
const app = express();
const server = http.createServer(app);
app.use(cors());


app.get("/", (req, res) => {
  res.send("Backend is LIVE ✅, version: 4 (Agent + ScreenShare)");
});

// --- Socket.IO setup
const io = new Server(server, {
  cors: { origin: "https://screen-sharing-frontend.vercel.app/", methods: ["GET","POST"] },
});

const peers = {};      // socket.id => name

// --- Helper: broadcast all users
function broadcastUsers() {
  io.emit("users-update", Object.values(peers));
}

// --- Socket.IO events
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // Set name (browser user)
  socket.on("set-name", (name) => {
    peers[socket.id] = name || "Unknown";
    broadcastUsers();
  });

  // Join room (screen share)
  socket.on("join-room", ({ roomId, name }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const count = room ? room.size : 0;
    if (count >= 2) return socket.emit("room-full");

    socket.join(roomId);
    peers[socket.id] = name;
    socket.to(roomId).emit("peer-joined");
    broadcastUsers();
  });

  // Screen request / permission
  socket.on("request-screen", ({ roomId, from }) => {
    const name = peers[from] || "Unknown";
    socket.to(roomId).emit("screen-request", { from, name });
  });

  socket.on("permission-response", ({ to, accepted }) => {
    io.to(to).emit("permission-result", accepted);
  });

  // WebRTC signaling + command forwarding
  socket.on("signal", ({ roomId, desc, candidate, command }) => {
    if (desc) socket.to(roomId).emit("signal", { desc });
    if (candidate) socket.to(roomId).emit("signal", { candidate });
    if (command) socket.to(roomId).emit("signal", { command });
  });

  // Stop sharing
  socket.on("stop-share", (roomId) => {
    socket.to(roomId).emit("remote-stopped");
  });

  // Disconnect / cleanup
  socket.on("disconnecting", () => {
    delete peers[socket.id];
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) socket.to(roomId).emit("peer-left");
    }
  });

  socket.on("disconnect", () => {
    broadcastUsers();
  });
});

// --- Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
