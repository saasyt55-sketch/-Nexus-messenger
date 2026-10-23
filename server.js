const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 5e7 
});

app.use(express.static(path.join(__dirname, 'public')));

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
const onlineUsers = new Map(); 
const socketToUser = new Map(); 

io.on('connection', (socket) => {

    // تسجيل حساب جديد
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

    // تسجيل الدخول العادي
    socket.on('login', async ({ username, password }, callback) => {
        const cleanName = username.trim();
        const user = db.users[cleanName];

        if (!user) return callback({ success: false, msg: 'المستخدم غير موجود' });

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return callback({ success: false, msg: 'كلمة المرور غير صحيحة' });

        handleUserLogin(socket, cleanName, callback);
    });

    // تسجيل الدخول التلقائي عند العودة للموقع
    socket.on('auto_login', ({ username }, callback) => {
        const cleanName = username ? username.trim() : '';
        if (db.users[cleanName]) {
            handleUserLogin(socket, cleanName, callback);
        } else {
            callback({ success: false });
        }
    });

    function handleUserLogin(socket, username, callback) {
        onlineUsers.set(username, socket.id);
        socketToUser.set(socket.id, username);

        const userChats = {};
        for (let chatKey in db.chats) {
            if (chatKey.includes(username)) {
                userChats[chatKey] = db.chats[chatKey];
            }
        }

        callback({ 
            success: true, 
            username: username, 
            avatar: db.users[username].avatar,
            history: userChats
        });

        broadcastAllUsers();
    }

    // إرسال قائمة بكل المستخدمين المسجلين (مع حالة الاتصال متصل/غير متصل)
    function broadcastAllUsers() {
        const list = Object.keys(db.users).map(name => ({
            username: name,
            avatar: db.users[name].avatar,
            isOnline: onlineUsers.has(name)
        }));
        io.emit('update_users_list', list);
    }

    // إرسال الرسائل والوسائط
    socket.on('send_private_msg', ({ to, message, file, fileType }) => {
        const sender = socketToUser.get(socket.id);
        const recipientSocketId = onlineUsers.get(to);

        if (sender) {
            const payload = {
                from: sender,
                to: to,
                message: message || '',
                file: file || null,
                fileType: fileType || null,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            const chatKey = [sender, to].sort().join('_');
            if (!db.chats[chatKey]) db.chats[chatKey] = [];
            db.chats[chatKey].push(payload);
            saveData(db);

            if (recipientSocketId) {
                io.to(recipientSocketId).emit('receive_private_msg', payload);
            }
            socket.emit('receive_private_msg', payload);
        }
    });

    // إشارات المكالمات
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
            broadcastAllUsers();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل بحفظ تام والدخول التلقائي على المنفذ: ${PORT}`));
