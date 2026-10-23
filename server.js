const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

// زيادة الحجم الأقصى للملفات لتسهيل رفع الفيديو والصور (حتى 50 ميجابايت)
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 5e7 
});

app.use(express.static(path.join(__dirname, 'public')));

// نظام حفظ البيانات المحلي (JSON Database)
const DB_FILE = path.join(__dirname, 'database.json');

function loadData() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = { users: {}, chats: {} };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return { users: {}, chats: {} };
    }
}

function saveData(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();
const onlineUsers = new Map(); // username -> socketId
const socketToUser = new Map(); // socketId -> username

io.on('connection', (socket) => {

    // 1. تسجيل حساب جديد
    socket.on('register', async ({ username, password, avatar }, callback) => {
        const cleanName = username.trim();
        if (!cleanName || !password) return callback({ success: false, msg: 'يرجى إدخال البيانات كاملة' });
        
        if (db.users[cleanName]) {
            return callback({ success: false, msg: 'اسم المستخدم مسجل مسبقاً' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        db.users[cleanName] = { passwordHash: hashedPassword, avatar: avatar || '⚡' };
        saveData(db);

        callback({ success: true, msg: 'تم إنشاء الحساب وحفظه بنجاح!' });
    });

    // 2. تسجيل الدخول
    socket.on('login', async ({ username, password }, callback) => {
        const cleanName = username.trim();
        const user = db.users[cleanName];

        if (!user) return callback({ success: false, msg: 'المستخدم غير موجود' });

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return callback({ success: false, msg: 'كلمة المرور غير صحيحة' });

        onlineUsers.set(cleanName, socket.id);
        socketToUser.set(socket.id, cleanName);

        // إرجاع المحادثات السابقة المخزنة
        const userChats = {};
        for (let chatKey in db.chats) {
            if (chatKey.includes(cleanName)) {
                userChats[chatKey] = db.chats[chatKey];
            }
        }

        callback({ 
            success: true, 
            username: cleanName, 
            avatar: user.avatar,
            history: userChats
        });

        broadcastOnlineList();
    });

    function broadcastOnlineList() {
        const list = Array.from(onlineUsers.keys()).map(name => ({
            username: name,
            avatar: db.users[name]?.avatar || '⚡'
        }));
        io.emit('update_online_users', list);
    }

    // 3. إرسال الرسائل والوسائط (صور وفيديو)
    socket.on('send_private_msg', ({ to, message, file, fileType }) => {
        const sender = socketToUser.get(socket.id);
        const recipientSocketId = onlineUsers.get(to);

        if (sender) {
            const payload = {
                from: sender,
                to: to,
                message: message || '',
                file: file || null,
                fileType: fileType || null, // 'image' أو 'video'
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            // حفظ المحادثة دائماً في قاعدة البيانات
            const chatKey = [sender, to].sort().join('_');
            if (!db.chats[chatKey]) db.chats[chatKey] = [];
            db.chats[chatKey].push(payload);
            saveData(db);

            // إرسال الرسالة للطرفين
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('receive_private_msg', payload);
            }
            socket.emit('receive_private_msg', payload);
        }
    });

    // 4. إشارات WebRTC المحسنة للمكالمات الصوتية والمرئية
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
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل بحفظ تام على المنفذ: ${PORT}`));
