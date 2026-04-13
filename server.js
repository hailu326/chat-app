const express = require('express');
// const http = require('http');
// const { Server } = require('socket.io');
const path = require('path');
const PORT=process.env.PORT||3000
const mongoose =require('mongoose');

const app = express();
const server = app.listen(PORT,"0.0.0.0",() => console.log(`server on port${PORT}`))
const io = require('socket.io')(server);
//const io=require('socket.io')(server)

const dbURI ='mongodb+srv://hailutadese786_db_user:Hailu3025@cluster0.lpba7lj.mongodb.net/?appName=Cluster0'
mongoose.connect(dbURI).then(()=>console.log('connected to db'))
.catch(err=>console.log('db connection error:',err));
let socketsConnected =new Set();
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection',onConnected)

function onConnected(socket){
    console.log(socket.id);
    socketsConnected.add(socket.id)
    
    io.emit('clients-total',socketsConnected.size)

    socket.on('disconnect',() =>{
        console.log('socket disconnected',socket.id);
        socketsConnected.delete(socket.id)
        io.emit('clients-total',socketsConnected.size)
    })
    socket.on('chat-message',(data)=>{
        console.log(data)
        socket.broadcast.emit('chat-message',data);
    })
    socket.on('feedback',(data)=>{
         socket.broadcast.emit('feedback',data);
    })
}




