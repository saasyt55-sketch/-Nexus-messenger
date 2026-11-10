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

const usersDB = new Map(); // username -> { email, passwordHash, avatar, contacts: [] }
const emailsDB = new Set(); 
const onlineUsers = new Map(); // username -> socket.id
const socketToUser = new Map(); // socket.id -> username
const chatHistories = new Map(); // chatKey -> [messages]

const DEFAULT_AVATAR = "https://cdn.phototourl.com/member/2026-10-30-b138def7-8ffd-4d03-ad72-92deeb35ed72.png";

function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function getChatKey(user1, user2) {
    return [user1, user2].sort().join('___');
}

io.on('connection', (socket) => {

    socket.on('request_verification_code', ({ email, username }, callback) => {
        const cleanEmail = email ? email.trim().toLowerCase() : '';
        const cleanName = username ? username.trim() : '';

        if (!cleanEmail || !cleanName) return callback({ success: false, msg: 'يرجى إدخال البريد واسم المستخدم' });
        if (!isValidEmail(cleanEmail)) return callback({ success: false, msg: 'البريد الإلكتروني غير صالح' });
        if (emailsDB.has(cleanEmail)) return callback({ success: false, msg: 'هذا البريد مسجل مسبقاً!' });
        if (usersDB.has(cleanName)) return callback({ success: false, msg: 'اسم المستخدم مستخدم مسبقاً!' });

        const randomCode = Math.floor(100 + Math.random() * 900).toString();
        socket.tempCode = randomCode;
        socket.tempEmail = cleanEmail;

        callback({ success: true, msg: `تم تجهيز رمز التحقق: [ ${randomCode} ]` });
    });

    socket.on('register_with_code', async ({ email, username, password, code }, callback) => {
        const cleanEmail = email ? email.trim().toLowerCase() : '';
        const cleanName = username ? username.trim() : '';

        if (!socket.tempCode || socket.tempCode !== code.trim()) {
            return callback({ success: false, msg: 'رمز التحقق غير صحيح!' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        usersDB.set(cleanName, { 
            email: cleanEmail, 
            passwordHash: hashedPassword, 
            avatar: DEFAULT_AVATAR,
            contacts: [] 
        });
        emailsDB.add(cleanEmail);

        callback({ success: true, msg: 'تم توثيق بريدك وإنشاء الحساب بنجاح! 🎉' });
    });

    socket.on('login', async ({ identifier, password }, callback) => {
        const cleanId = identifier ? identifier.trim() : '';
        if (!cleanId || !password) return callback({ success: false, msg: 'يرجى إدخال البيانات' });

        let targetUsername = cleanId;
        if (cleanId.includes('@')) {
            for (let [uname, udata] of usersDB.entries()) {
                if (udata.email === cleanId.toLowerCase()) { targetUsername = uname; break; }
            }
        }

        const user = usersDB.get(targetUsername);
        if (!user) return callback({ success: false, msg: 'المستخدم غير موجود' });

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) return callback({ success: false, msg: 'كلمة المرور غير صحيحة' });

        // ربط الجلسة الجديدة بثبات وتحديث الـ Socket ID
        onlineUsers.set(targetUsername, socket.id);
        socketToUser.set(socket.id, targetUsername);

        callback({ 
            success: true, 
            username: targetUsername, 
            avatar: user.avatar, 
            email: user.email,
            contacts: user.contacts 
        });
        broadcastOnlineStatus();
        broadcastAllUsersAvatars();
    });

    socket.on('auto_login', ({ username }, callback) => {
        const cleanName = username ? username.trim() : '';
        const user = usersDB.get(cleanName);
        if (user) {
            onlineUsers.set(cleanName, socket.id);
            socketToUser.set(socket.id, cleanName);
            callback({ 
                success: true, 
                username: cleanName, 
                avatar: user.avatar, 
                email: user.email,
                contacts: user.contacts 
            });
            broadcastOnlineStatus();
            broadcastAllUsersAvatars();
        } else {
            callback({ success: false });
        }
    });

    socket.on('update_profile', ({ newAvatar, newUsername }, callback) => {
        const oldUsername = socketToUser.get(socket.id);
        if (!oldUsername) return callback({ success: false, msg: 'غير مسجل دخول!' });

        const userData = usersDB.get(oldUsername);
        if (!userData) return callback({ success: false, msg: 'المستخدم غير موجود!' });

        let finalUsername = oldUsername;

        if (newUsername && newUsername.trim() !== oldUsername) {
            finalUsername = newUsername.trim();
            if (usersDB.has(finalUsername)) return callback({ success: false, msg: 'اسم المستخدم مستخدم مسبقاً!' });
            
            usersDB.set(finalUsername, userData);
            usersDB.delete(oldUsername);
            
            onlineUsers.delete(oldUsername);
            onlineUsers.set(finalUsername, socket.id);
            socketToUser.set(socket.id, finalUsername);
        }

        if (newAvatar) {
            userData.avatar = newAvatar;
        }

        callback({ success: true, username: finalUsername, avatar: userData.avatar });
        broadcastOnlineStatus();
        broadcastAllUsersAvatars();
    });

    function broadcastAllUsersAvatars() {
        const avatarsMap = {};
        for (let [uname, udata] of usersDB.entries()) {
            avatarsMap[uname] = udata.avatar;
        }
        io.emit('users_avatars_sync', avatarsMap);
    }

    socket.on('send_friend_request', ({ targetUsername }, callback) => {
        const sender = socketToUser.get(socket.id);
        const cleanTarget = targetUsername.trim();

        if (!usersDB.has(cleanTarget)) return callback({ success: false, msg: 'المستخدم غير موجود!' });
        if (cleanTarget === sender) return callback({ success: false, msg: 'لا يمكنك إضافة نفسك!' });

        const targetUser = usersDB.get(cleanTarget);
        if (targetUser.contacts.some(c => c.username === sender)) {
            return callback({ success: false, msg: 'أنتما أصدقاء بالفعل!' });
        }

        const targetSocketId = onlineUsers.get(cleanTarget);
        if (targetSocketId) io.to(targetSocketId).emit('new_friend_request', { from: sender });

        callback({ success: true, msg: 'تم إرسال طلب الصداقة بنجاح! ⏳' });
    });

    socket.on('respond_friend_request', ({ fromUser, accept }, callback) => {
        const username = socketToUser.get(socket.id);
        if (!username) return;

        if (accept) {
            const myUser = usersDB.get(username);
            const friendUser = usersDB.get(fromUser);

            if (myUser && !myUser.contacts.some(c => c.username === fromUser)) {
                myUser.contacts.push({ username: fromUser, isGroup: false });
            }
            if (friendUser && !friendUser.contacts.some(c => c.username === username)) {
                friendUser.contacts.push({ username: username, isGroup: false });
            }

            callback({ success: true, contacts: myUser.contacts });

            const senderSocket = onlineUsers.get(fromUser);
            if (senderSocket) {
                io.to(senderSocket).emit('friend_request_accepted', { by: username, contacts: friendUser.contacts });
            }
        } else {
            callback({ success: false });
        }
    });

    socket.on('add_group', ({ groupName }, callback) => {
        const username = socketToUser.get(socket.id);
        if (!username) return;
        const user = usersDB.get(username);
        if (user && !user.contacts.some(c => c.username === groupName)) {
            user.contacts.push({ username: groupName, isGroup: true });
            callback({ success: true, contacts: user.contacts });
        }
    });

    socket.on('get_chat_history', ({ peer }, callback) => {
        const sender = socketToUser.get(socket.id);
        if (!sender) return callback([]);
        const chatKey = getChatKey(sender, peer);
        const history = chatHistories.get(chatKey) || [];
        callback(history);
    });

    socket.on('get_group_history', ({ groupName }, callback) => {
        const history = chatHistories.get(groupName) || [];
        callback(history);
    });

    socket.on('typing', ({ to, isTyping, isGroup }) => {
        const sender = socketToUser.get(socket.id);
        if (!sender) return;

        if (isGroup) {
            socket.broadcast.emit('display_typing', { from: sender, to, isTyping });
        } else {
            const recipientSocketId = onlineUsers.get(to);
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('display_typing', { from: sender, to: sender, isTyping });
            }
        }
    });

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
            if (!chatHistories.has(to)) chatHistories.set(to, []);
            chatHistories.get(to).push(payload);
            io.emit('receive_group_message', payload);
        } else {
            const chatKey = getChatKey(sender, to);
            if (!chatHistories.has(chatKey)) chatHistories.set(chatKey, []);
            chatHistories.get(chatKey).push(payload);

            const recipientSocketId = onlineUsers.get(to);
            if (recipientSocketId) io.to(recipientSocketId).emit('receive_message', payload);
            socket.emit('receive_message', payload);
        }
    });

    socket.on('call_user', ({ to, offer, isVideo }) => {
        const caller = socketToUser.get(socket.id);
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) io.to(recipientSocketId).emit('incoming_call', { from: caller, offer, isVideo });
    });

    socket.on('answer_call', ({ to, answer }) => {
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) io.to(recipientSocketId).emit('call_answered', { answer });
    });

    socket.on('ice_candidate', ({ to, candidate }) => {
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) io.to(recipientSocketId).emit('ice_candidate', { candidate });
    });

    socket.on('end_call', ({ to }) => {
        const recipientSocketId = onlineUsers.get(to);
        if (recipientSocketId) io.to(recipientSocketId).emit('call_ended');
    });

    socket.on('disconnect', () => {
        const user = socketToUser.get(socket.id);
        if (user) {
            // فقط إذا كان نفس الـ socket الحالي هو المتصل يتم إزالته لتفادي مسح الجلسات المستقرة
            if (onlineUsers.get(user) === socket.id) {
                onlineUsers.delete(user);
            }
            socketToUser.delete(socket.id);
            broadcastOnlineStatus();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 -Nexus-messenger v15.0 يعمل بنجاح على المنفذ: ${PORT}`));
