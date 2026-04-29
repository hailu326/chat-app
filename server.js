const bcrypt = require('bcrypt');
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

const io = require('socket.io')(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const dbURI = process.env.CONN_STRING;

// ================= DB CONNECT =================
mongoose.connect(dbURI)
.then(() => {
    console.log("DB Connected");

    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });

    startSocket(); // start socket after DB ready
})
.catch(err => console.log(err));


// ================= SCHEMAS =================
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phone: { type: String, required: true },
    profile: String
});

const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    name: String,
    message: String,
    profile: String,
    dateTime: Date,
    fileUrl: String,
    fileName: String,
    fileType: String
});

const Message = mongoose.model('Message', messageSchema);


// ================= MIDDLEWARE =================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({ storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/uploads', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send("No file");

    res.json({
        fileUrl: `/uploads/${req.file.filename}`,
        fileName: req.file.originalname
    });
});


// ================= ONLINE USERS =================
let onlineUsers = {};


// ================= SOCKET LOGIC =================
function startSocket() {

    io.on('connection', (socket) => {

        // LOAD OLD MESSAGES
        Message.find().sort({ dateTime: 1 }).limit(50)
        .then(messages => {
            socket.emit('load-old-messages', messages);
        });

        // ================= AUTH =================
        socket.on('signup-user', async (userData) => {
            try {
                const existingUser = await User.findOne({ email: userData.email });
                if (existingUser) {
                    return socket.emit('auth-error', 'Email already in use!');
                }

                const hashedPassword = await bcrypt.hash(userData.password, 10);

                const newUser = await User.create({
                    name: userData.name,
                    email: userData.email,
                    password: hashedPassword,
                    phone: userData.phone,
                    profile: userData.profile
                });

                const safeUser = {
                    name: newUser.name,
                    email: newUser.email,
                    phone: newUser.phone,
                    profile: newUser.profile
                };

                socket.emit('auth-success', safeUser);

            } catch (e) {
                console.log(e);
                socket.emit('auth-error', 'Signup failed');
            }
        });


        socket.on('login-user', async (data) => {
            try {
                const user = await User.findOne({ email: data.email });

                if (!user) {
                    return socket.emit('auth-error', 'Invalid credentials');
                }

                const isMatch = await bcrypt.compare(data.password, user.password);

                if (!isMatch) {
                    return socket.emit('auth-error', 'Invalid credentials');
                }

                const safeUser = {
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    profile: user.profile
                };

                socket.emit('auth-success', safeUser);

            } catch (e) {
                socket.emit('auth-error', 'Login failed');
            }
        });


        // ================= PROFILE =================
        socket.on('update-profile', async (data) => {
            try {
                await User.updateOne(
                    { email: data.email },
                    {
                        name: data.name,
                        phone: data.phone,
                        profile: data.profile
                    }
                );

                if (onlineUsers[socket.id]) {
                    onlineUsers[socket.id] = data;
                    io.emit('update-user-list', Object.values(onlineUsers));
                }

            } catch (err) {
                console.log(err);
            }
        });


        // ================= USERS =================
        socket.on('new-user-joined', (userData) => {
            onlineUsers[socket.id] = userData;
            io.emit('update-user-list', Object.values(onlineUsers));
        });

        socket.on('logout-user', () => {
            delete onlineUsers[socket.id];
            io.emit('update-user-list', Object.values(onlineUsers));
        });

        socket.on('disconnect', () => {
            delete onlineUsers[socket.id];
            io.emit('update-user-list', Object.values(onlineUsers));
        });


        // ================= CHAT =================
        socket.on('chat-message', async (data) => {
            try {
                const newMessage = new Message(data);
                await newMessage.save();

                socket.broadcast.emit('chat-message', data);

            } catch (err) {
                console.log("Error saving message:", err);
            }
        });


        // ================= CALL =================
        socket.on('voice-call-request', (data) => {
            socket.broadcast.emit('incoming-voice-call', data);
        });

        socket.on('video-call-request', (data) => {
            socket.broadcast.emit('incoming-video-call', data);
        });


        // ================= FEEDBACK =================
        socket.on('feedback', (data) => {
            socket.broadcast.emit('feedback', data);
        });

    });
}