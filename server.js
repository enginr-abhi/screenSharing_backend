const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const PORT = process.env.PORT || 9000;
const app = express();
const server = http.createServer(app);

// Allow only your frontend
app.use(cors({
  origin: "https://screen-sharing-frontend.vercel.app",
  methods: ["GET", "POST"]
}));

const io = new Server(server, {
  cors: {
    origin: "https://screen-sharing-frontend.vercel.app",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // Join room
  socket.on("join-room", (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const count = room ? room.size : 0;
    if (count >= 2) return socket.emit("room-full");
    socket.join(roomId);

    // Notify existing peer
    socket.to(roomId).emit("peer-joined");
    socket.emit("peer-joined"); // notify self if second user
  });

  // Request to view screen
  socket.on("request-screen", ({ roomId, from }) => {
    socket.to(roomId).emit("screen-request", { from });
  });

  // Permission response (accept/reject)
  socket.on("permission-response", ({ to, accepted }) => {
    io.to(to).emit("permission-result", accepted);
  });

  // WebRTC signaling
  socket.on("signal", ({ roomId, desc, candidate }) => {
    if (desc) socket.to(roomId).emit("signal", { desc });
    if (candidate) socket.to(roomId).emit("signal", { candidate });
  });

  // Stop sharing
  socket.on("stop-share", (roomId) => {
    // Notify everyone in the room (including sharer & viewer)
    socket.to(roomId).emit("remote-stopped");
    socket.emit("remote-stopped");
  });

  // Leave room
  socket.on("leave-room", (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit("peer-left");
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("peer-left");
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
