// App & Server Setup (Isa dura ture)
require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./config/dbConfig');
const mongoose = require('mongoose');
const PORT = process.env.PORT || 3000;
const app = express();
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
const io = require('socket.io')(server);

// MongoDB Connection (Isa dura ture)
const dbURI = 'mongodb+srv://hailutadese786_db_user:Hailu3025@cluster0.lpba7lj.mongodb.net/?appName=Cluster0';
mongoose.connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to DB'))
    .catch(err => console.log('DB Connection Error:', err));

// Schemas (User Schema olitti Message Schema gadii)
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    profile: String
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    name: String,
    message: String,
    profile: String,
    dateTime: Date
});
const Message = mongoose.model('Message', messageSchema);

// Middleware (Static files)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // JSON data barbaaduuf

// Online Users Management
let onlineUsers = {};

// Socket.IO Connection
io.on('connection', (socket) => {
    
    // --- AUTHENTICATION EVENTS ---
    socket.on('signup-user', async (userData) => {
        try {
            // Already exists?
            const existingUser = await User.findOne({ email: userData.email });
            if (existingUser) return socket.emit('auth-error', 'Email already in use!');

            // Create new user
            const newUser = await User.create(userData);
            socket.emit('auth-success', newUser); // Login mirkaneessi
        } catch (e) { socket.emit('auth-error', 'Signup failed. Try again.'); console.log(e); }
    });

    socket.on('login-user', async (data) => {
        try {
            const user = await User.findOne({ email: data.email, password: data.password });
            if (user) {
                socket.emit('auth-success', user); // Login mirkaneessi
            } else {
                socket.emit('auth-error', 'Invalid Email or Password.');
            }
        } catch (e) { socket.emit('auth-error', 'Login failed.'); console.log(e); }
    });

    // --- USER LIST MANAGEMENT ---
    socket.on('new-user-joined', (userData) => {
        onlineUsers[socket.id] = userData;
        io.emit('update-user-list', Object.values(onlineUsers));
    });

    socket.on('logout-user', () => {
        if (onlineUsers[socket.id]) {
            delete onlineUsers[socket.id];
            io.emit('update-user-list', Object.values(onlineUsers));
        }
    });

    socket.on('disconnect', () => {
        if (onlineUsers[socket.id]) {
            delete onlineUsers[socket.id];
            io.emit('update-user-list', Object.values(onlineUsers));
        }
        // Osoo Message bahuu dhabe illee disconnect irratti delete godhu
    });

    // --- CHAT MESSAGE LOGIC ---
    socket.on('chat-message', async (data) => {
        try {
            // Message database irratti save godhi (Yoo barbaadde)
            // const newMessage = new Message(data);
            // await newMessage.save();

            // Ergaa nama hundaaf dabarsi (Broadcast)
            socket.broadcast.emit('chat-message', data);

        } catch (err) {
            console.log("Error saving message:", err);
        }
    });

    // Feedback logic (Isa dura ture)
    socket.on('feedback', (data) => {
        socket.broadcast.emit('feedback', data);
    });
});




