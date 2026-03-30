const express = require('express');
// const http = require('http');
// const { Server } = require('socket.io');
const path = require('path');
const PORT=process.env.PORT||3000

const app = express();
const server = app.listen(PORT,"0.0.0.0",() => console.log(`server on port${PORT}`))
const io = require('socket.io')(server);
//const io=require('socket.io')(server)
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




