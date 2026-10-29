const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 5e7 
});

app.use(express.static(path.join(__dirname, 'public')));

const usersDB = new Map(); 
const onlineUsers = new Map(); 
const socketToUser = new Map(); 

io.on('connection', (socket) => {

    socket.on('register', async ({ username, password, avatar }, callback) => {
        const cleanName = username.trim();
        if (!cleanName || !password) return callback({ success: false, msg: 'يرجى إدخال البيانات كاملة' });
        
        if (usersDB.has(cleanName)) {
            return callback({ success: false, msg: 'اسم المستخدم مستخدم مسبقاً، يرجى اختيار اسم آخر' });
        }

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
        broadcastOnlineStatus();
    });

    socket.on('auto_login', ({ username }, callback) => {
        const cleanName = username ? username.trim() : '';
        const user = usersDB.get(cleanName);
        if (user) {
            onlineUsers.set(cleanName, socket.id);
            socketToUser.set(socket.id, cleanName);
            callback({ success: true, username: cleanName, avatar: user.avatar });
            broadcastOnlineStatus();
        } else {
            callback({ success: false });
        }
    });

    // البحث عن مستخدم باليوزر
    socket.on('search_user', ({ targetUsername }, callback) => {
        const cleanTarget = targetUsername.trim();
        if (usersDB.has(cleanTarget)) {
            const user = usersDB.get(cleanTarget);
            callback({ 
                found: true, 
                username: cleanTarget, 
                avatar: user.avatar,
                isOnline: onlineUsers.has(cleanTarget)
            });
        } else {
            callback({ found: false, msg: 'المستخدم غير موجود' });
        }
    });

    function broadcastOnlineStatus() {
        const onlineList = Array.from(onlineUsers.keys());
        io.emit('online_users_status', onlineList);
    }

    socket.on('send_message', ({ to, message, file, fileType, isGroup }) => {
        const sender = socketToUser.get(socket.id);
        if (!sender) return;

        const payload = {
            from: sender,
            to: to,
            message: message || '',
            file: file || null,
            fileType: fileType || null,
            isGroup: !!isGroup,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        if (isGroup) {
            io.emit('receive_group_message', payload);
        } else {
            const recipientSocketId = onlineUsers.get(to);
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('receive_message', payload);
            }
            socket.emit('receive_message', payload);
        }
    });

    // WebRTC Signaling
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
            broadcastOnlineStatus();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 -Nexus-messenger v5.0 يعمل بنجاح على المنفذ: ${PORT}`));
