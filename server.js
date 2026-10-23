const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
// زيادة حد حجم البيانات المقبولة لاستقبال الصور عالية الدقة
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e7 // 10MB limit for image attachments
});

app.use(express.static(path.join(__dirname, 'public')));

const usersDB = new Map(); 
const onlineUsers = new Map(); 
const socketToUser = new Map(); 

io.on('connection', (socket) => {
    socket.on('register', async ({ username, password, avatar }, callback) => {
        const cleanName = username.trim();
        if (!cleanName || !password) return callback({ success: false, msg: 'يرجى إدخال البيانات كاملة' });
        if (usersDB.has(cleanName)) return callback({ success: false, msg: 'اسم المستخدم مسجل مسبقاً' });

        const hashedPassword = await bcrypt.hash(password, 10);
        usersDB.set(cleanName, { passwordHash: hashedPassword, avatar: avatar || '⚡' });
        callback({ success: true, msg: 'تم إنشاء الحساب بنجاح!' });
    });

    socket.on('login', async ({ username, password }, callback) => {
        const cleanName = username.trim();
        const user = usersDB.get(cleanName);
        if (!user) return callback({ success: false, msg: 'المستخدم غير موجود' });

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return callback({ success: false, msg: 'كلمة المرور غير صحيحة' });

        onlineUsers.set(cleanName, socket.id);
        socketToUser.set(socket.id, cleanName);

        callback({ success: true, username: cleanName, avatar: user.avatar });
        broadcastOnlineList();
    });

    function broadcastOnlineList() {
        const list = Array.from(onlineUsers.keys()).map(name => ({
            username: name,
            avatar: usersDB.get(name)?.avatar || '⚡'
        }));
        io.emit('update_online_users', list);
    }

    // دعم إرسال النص أو الصور (image)
    socket.on('send_private_msg', ({ to, message, image }) => {
        const sender = socketToUser.get(socket.id);
        const recipientSocketId = onlineUsers.get(to);

        if (sender && recipientSocketId) {
            const payload = {
                from: sender,
                to: to,
                message: message || '',
                image: image || null,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            io.to(recipientSocketId).emit('receive_private_msg', payload);
            socket.emit('receive_private_msg', payload);
        }
    });

    // إشارات المكالمات عبر WebRTC
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
            broadcastOnlineList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل على المنفذ: ${PORT}`));
