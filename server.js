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

const usersDB = new Map(); // username -> { email, passwordHash, avatar }
const emailsDB = new Set(); 
const onlineUsers = new Map(); 
const socketToUser = new Map(); 
const friendRequests = new Map(); 
const tempVerifyCodes = new Map(); 

function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
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
        tempVerifyCodes.set(cleanEmail, randomCode);

        callback({ success: true, msg: `تم تجهيز رمز التحقق: [ ${randomCode} ]` });
    });

    socket.on('register_with_code', async ({ email, username, password, code, avatar }, callback) => {
        const cleanEmail = email ? email.trim().toLowerCase() : '';
        const cleanName = username ? username.trim() : '';
        const savedCode = tempVerifyCodes.get(cleanEmail);

        if (!savedCode || savedCode !== code.trim()) {
            return callback({ success: false, msg: 'رمز التحقق غير صحيح!' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const defaultAvatar = avatar || 'https://scontent.fjed4-1.fna.fbcdn.net/v/t39.30808-6/475438259_1017618267032974_6259024097486820299_n.jpg?_nc_cat=105&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=F...'; // رابط افتراضي للفيسبوك
        
        usersDB.set(cleanName, { email: cleanEmail, passwordHash: hashedPassword, avatar: 'https://cdn.phototourl.com/member/2026-10-30-b138def7-8ffd-4d03-ad72-92deeb35ed72.png' });
        emailsDB.add(cleanEmail);
        friendRequests.set(cleanName, []);
        tempVerifyCodes.delete(cleanEmail);

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

        onlineUsers.set(targetUsername, socket.id);
        socketToUser.set(socket.id, targetUsername);

        callback({ success: true, username: targetUsername, avatar: user.avatar, email: user.email });
        broadcastOnlineStatus();
        broadcastAllUsersAvatars();
    });

    socket.on('auto_login', ({ username }, callback) => {
        const cleanName = username ? username.trim() : '';
        const user = usersDB.get(cleanName);
        if (user) {
            onlineUsers.set(cleanName, socket.id);
            socketToUser.set(socket.id, cleanName);
            callback({ success: true, username: cleanName, avatar: user.avatar, email: user.email });
            broadcastOnlineStatus();
            broadcastAllUsersAvatars();
        } else {
            callback({ success: false });
        }
    });

    // تحديث الصورة والاسم الشخصي
    socket.on('update_profile', ({ newAvatar, newUsername }, callback) => {
        const oldUsername = socketToUser.get(socket.id);
        if (!oldUsername) return callback({ success: false, msg: 'غير مسجل دخول!' });

        const userData = usersDB.get(oldUsername);
        if (!userData) return callback({ success: false, msg: 'المستخدم غير موجود!' });

        let finalUsername = oldUsername;

        if (newUsername && newUsername.trim() !== oldUsername) {
            finalUsername = newUsername.trim();
            if (usersDB.has(finalUsername)) return callback({ success: false, msg: 'اسم المستخدم مستخدم مسبقاً!' });
            
            // نقل بيانات الحساب لليوزر الجديد
            usersDB.set(finalUsername, userData);
            usersDB.delete(oldUsername);
            
            onlineUsers.delete(oldUsername);
            onlineUsers.set(finalUsername, socket.id);
            socketToUser.set(socket.id, finalUsername);
            
            friendRequests.set(finalUsername, friendRequests.get(oldUsername) || []);
            friendRequests.delete(oldUsername);
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

        if (!friendRequests.has(cleanTarget)) friendRequests.set(cleanTarget, []);
        const requestsList = friendRequests.get(cleanTarget);
        if (requestsList.includes(sender)) return callback({ success: false, msg: 'تم إرسال طلب مسبقاً!' });

        requestsList.push(sender);
        const targetSocketId = onlineUsers.get(cleanTarget);
        if (targetSocketId) io.to(targetSocketId).emit('new_friend_request', { from: sender });

        callback({ success: true, msg: 'تم إرسال طلب الصداقة بنجاح! ⏳' });
    });

    socket.on('get_friend_requests', (callback) => {
        const username = socketToUser.get(socket.id);
        if (!username) return callback([]);
        const requests = friendRequests.get(username) || [];
        callback(requests.map(reqName => ({ username: reqName, avatar: usersDB.get(reqName)?.avatar || 'https://www.facebook.com/photo/?fbid=1017618267032974&set=a.100287335432743' })));
    });

    socket.on('respond_friend_request', ({ fromUser, accept }, callback) => {
        const username = socketToUser.get(socket.id);
        if (!username) return;

        let requests = friendRequests.get(username) || [];
        friendRequests.set(username, requests.filter(r => r !== fromUser));

        if (accept) {
            callback({ success: true, friend: { username: fromUser, avatar: usersDB.get(fromUser)?.avatar || 'https://www.facebook.com/photo/?fbid=1017618267032974&set=a.100287335432743' } });
            const senderSocket = onlineUsers.get(fromUser);
            if (senderSocket) io.to(senderSocket).emit('friend_request_accepted', { by: username, avatar: usersDB.get(username)?.avatar });
        } else {
            callback({ success: false });
        }
    });

    function broadcastOnlineStatus() {
        io.emit('online_users_status', Array.from(onlineUsers.keys()));
    }

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
            io.emit('receive_group_message', payload);
        } else {
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
            onlineUsers.delete(user);
            socketToUser.delete(socket.id);
            broadcastOnlineStatus();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 -Nexus-messenger v11.0 يعمل بنجاح على المنفذ: ${PORT}`));
