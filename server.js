// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const PORT = process.env.PORT || 9000;

const app = express();
const server = http.createServer(app);
app.use(cors());

const io = new Server(server, {
  cors: { origin: "*" },
  methods: ["GET", "POST"]
});

io.on("connection", (socket) => {
  console.log('Connected:', socket.id);

  socket.on("join-room", (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const count = room ? room.size : 0;
    if (count >= 2) return socket.emit("room-full");
    socket.join(roomId);
    socket.to(roomId).emit("peer-joined");
  });

  // Permission request/response
  socket.on("request-screen", ({ roomId, from }) => {
    socket.to(roomId).emit("screen-request", { from });
  });
  socket.on("permission-response", ({ to, accepted }) => {
    io.to(to).emit("permission-result", accepted);
  });

  // WebRTC signaling (desc + candidates)
  socket.on("signal", ({ roomId, desc, candidate }) => {
    if (desc) socket.to(roomId).emit("signal", { desc });
    if (candidate) socket.to(roomId).emit("signal", { candidate });
  });

  socket.on("stop-share", (roomId) => {
    socket.to(roomId).emit("remote-stopped");
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("peer-left");
      }
    }
  });
});

server.listen(PORT, '0.0.0.0',() => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
