const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 5e7 // حد 50 ميجابايت للوسائط
});

app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = new Map(); // username -> socketId
const socketToUser = new Map(); // socketId -> username

io.on('connection', (socket) => {

    // تسجيل الحضور والتواجد فورياً
    socket.on('user_connected', (username) => {
        if (!username) return;
        const cleanName = username.trim();
        onlineUsers.set(cleanName, socket.id);
        socketToUser.set(socket.id, cleanName);

        io.emit('online_status_change', Array.from(onlineUsers.keys()));
    });

    // إشعار فوري للرسائل عبر Socket.io
    socket.on('send_private_msg', (payload) => {
        const recipientSocketId = onlineUsers.get(payload.to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('receive_private_msg', payload);
        }
        socket.emit('receive_private_msg', payload);
    });

    // إشارات مكالمات الصوت والفيديو (WebRTC Signaling)
    socket.on('call_user', ({ to, offer, isVideo }) => {
        const caller = socketToUser.get(socket.id);
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('incoming_call', { from: caller, offer, isVideo });
        }
    });

    socket.on('answer_call', ({ to, answer }) => {
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('call_answered', { answer });
        }
    });

    socket.on('ice_candidate', ({ to, candidate }) => {
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('ice_candidate', { candidate });
        }
    });

    socket.on('end_call', ({ to }) => {
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('call_ended');
        }
    });

    socket.on('disconnect', () => {
        const user = socketToUser.get(socket.id);
        if (user) {
            onlineUsers.delete(user);
            socketToUser.delete(socket.id);
            io.emit('online_status_change', Array.from(onlineUsers.keys()));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر الأسطوري يعمل بنجاح على المنفذ: ${PORT}`));
