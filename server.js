// const express = require("express");
// const http = require("http");
// const { Server } = require("socket.io");

// const app = express();
// const server = http.createServer(app);
// const io = new Server(server);

// app.use(express.static("public"));

// io.on("connection", (socket) => {
//   console.log("User connected:", socket.id);

//   socket.on("join-room", (roomId) => {
//     socket.join(roomId);
//     socket.to(roomId).emit("user-joined", socket.id);
//   });

//   socket.on("request-screen", ({ roomId, from }) => {
//     socket.to(roomId).emit("screen-request", { from });
//   });

//   socket.on("permission-response", ({ to, accepted }) => {
//     io.to(to).emit("permission-result", accepted);
//   });

//   socket.on("offer", ({ roomId, offer }) => {
//     socket.to(roomId).emit("offer", offer);
//   });

//   socket.on("answer", ({ roomId, answer }) => {
//     socket.to(roomId).emit("answer", answer);
//   });

//   socket.on("ice-candidate", ({ roomId, candidate }) => {
//     socket.to(roomId).emit("ice-candidate", candidate);
//   });
// });

// server.listen(3000, () => {
//   console.log("Server running on http://localhost:3000");
// });

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const PORT = process.env.PORT || 9000;

const app = express();
const server = http.createServer(app);
// CORS (just for testing // later update with frontend url for production)
app.use(cors());

const io = new Server(server,{
  cors:{origin:'*'},// later: frontend deploye url
  methods:["GET","POST"]
});

// app.use(express.static(path.join(__dirname,'../frontend')));


io.on("connection", (socket) => {
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
