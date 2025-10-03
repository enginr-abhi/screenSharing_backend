// server.js (Updated for Agent-Only VNC/RDP-like streaming)
const http = require('http');
const express = require("express");
const { Server } = require("socket.io");
const cors = require("cors");
const PORT = process.env.PORT || 9000;
const path = require('path');
const app = express();
const server = http.createServer(app);

app.use(cors());

// --- API Endpoints ---
app.get("/", (req, res) => {
    res.send("Backend is LIVE ✅, version: 3 (Agent-Stream Ready)");
});

app.get("/download-agent", (req, res) => {
    const filePath = path.join(__dirname, "agent", "agent.exe");
    res.download(filePath, "remote-agent.exe", (err) => {
        if (err) {
            console.error("Download error:", err);
            res.status(500).send("File not found");
        }
    });
});

// --- Socket.IO Setup ---
const io = new Server(server, { 
    cors: { 
        origin: "https://screen-sharing-frontend.vercel.app/" , 
        methods: ["GET", "POST"] 
    },
    // IMPORTANT: Increase maxPayload if VNC/RDP frames are large
    maxHttpBufferSize: 1e8 // Set to 100MB, adjust as needed 
});

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
        // This request will now implicitly target the Agent user (User2)
        socket.to(roomId).emit("screen-request", { from, name: peers[socket.id]?.name });
    });

    socket.on("permission-response", ({ to, accepted }) => {
        if (accepted && peers[socket.id]) peers[socket.id].isSharing = true;
        io.to(to).emit("permission-result", accepted);
        
        // If accepted, immediately notify the viewer to prepare for the VNC stream
        if (accepted) {
            const agentRoomId = peers[socket.id]?.roomId;
            io.to(to).emit("stream-start", { agentId: socket.id, roomId: agentRoomId });
        }
    });

    socket.on("stop-share",({roomId,name}) => {
        if (peers[socket.id]) peers[socket.id].isSharing = false;
        // broadcast with the name
        io.in(roomId).emit("stop-share", { name });
    });

    // ==========================================================
    // --- VNC/RDP-like Screen Stream Data ---
    // This is the core new event: Agent sends compressed screen frames here
    socket.on("screen-data", ({ roomId, data }) => {
        const sender = peers[socket.id];
        
        // Security check: Only allow agents who are currently sharing to send data
        if (!sender || !sender.isAgent || !sender.isSharing || sender.roomId !== roomId) {
            console.warn(`Unauthorized or non-sharing sender tried to send screen data: ${socket.id}`);
            return;
        }

        // Broadcast the VNC/RDP frame data packet to all viewers in the room
        // 'data' will be the raw, compressed VNC frame payload (e.g., a Buffer)
        // Viewers (User1's browser) must listen to 'screen-stream' and feed 'data' into a VNC client library (like noVNC).
        socket.to(roomId).emit("screen-stream", { data });
    });
    // ==========================================================


    // ---- Capture info (resolution & scaling) ----
    socket.on("capture-info", info => {
        peers[socket.id] = { ...peers[socket.id], captureInfo: info, roomId: info.roomId };
        // Broadcast capture info to all peers in the room (including viewers/agents)
        socket.to(info.roomId).emit("capture-info", info);
    });

    // ---- Remote control events ----
    // This logic is still correct: Viewer sends command -> Server routes to Agent.
    socket.on("control", data => {
        const { roomId } = peers[socket.id] || {};
        if (!roomId) return;
        
        // Find the designated sharing agent in the room and send the control command
        for (const [id, p] of Object.entries(peers)) {
            if (p.roomId === roomId && p.isAgent && p.isSharing) {
                io.to(id).emit("control", data);
                break; // Assuming only one agent is sharing per room
            }
        }
    });
});


server.listen(PORT, '0.0.0.0',() => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});