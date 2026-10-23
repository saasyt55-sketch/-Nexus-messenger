const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// تقديم الملفات الستاتيكية من مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// تخزين الغرف والرسائل في الذاكرة (أو ربطها بقاعدة بيانات مستقبلاً)
const activeUsers = new Map();

io.on('connection', (socket) => {
    console.log(`⚡ مستخدم جديد اتصل: ${socket.id}`);

    // انضمام مستخدم باسم ومجال محدد
    socket.on('join_room', ({ username, room }) => {
        socket.join(room);
        activeUsers.set(socket.id, { username, room });

        // إشعار باقي الأعضاء في الغرفة
        socket.to(room).emit('system_message', {
            text: `🔥 انضم المبدع ${username} إلى القناة!`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        // تحديث عدد المتواجدين
        const roomClients = io.sockets.adapter.rooms.get(room);
        io.to(room).emit('room_stats', {
            onlineCount: roomClients ? roomClients.size : 1
        });
    });

    // استقبال وإرسال الرسائل الفورية
    socket.on('send_message', (data) => {
        const user = activeUsers.get(socket.id);
        if (user) {
            io.to(user.room).emit('receive_message', {
                id: socket.id,
                username: user.username,
                message: data.message,
                avatar: data.avatar || '⚡',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    });

    // عند انقطاع الاتصال
    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            io.to(user.room).emit('system_message', {
                text: `👋 غادر ${user.username} القناة.`,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            activeUsers.delete(socket.id);
        }
        console.log(`❌ انقطع اتصال: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر الأسطوري يعمل بنجاح على المنفذ: ${PORT}`);
});
