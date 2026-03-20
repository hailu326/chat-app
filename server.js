const express = require('express');
// const http = require('http');
// const { Server } = require('socket.io');
const path = require('path');
const PORT=process.env.PORT||3000

const app = express();
const server = app.listen(PORT,() => console.log('🗨️server on port${PORT}'))
const io = require('socket.io')(server);
//const io=require('socket.io')(server)

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection',onconnected)

function onconnected(socket)                                                                   {
    console.log(socket.id);
    socketsconnected.add(socket.id)
    
    io.emit('clients-total',socketsconnected.size)

    socket.on('disconnect',() =>{
        console.log('socket disconnected',socket.id);
        socketsconnected.delete(socket.id)
        io.emit('clients-total',socketsconnected.size)
    })
}


//     socket.on('chat message', (msg) => {
//         io.emit('chat message', msg);
//     });

//     socket.on('disconnect', () => {
//         console.log('Namni tokko ba\'eera');
//     });
// });

// const PORT = 3000;
// server.listen(PORT, () => {
//     console.log(`Server koo http://localhost:${PORT} irratti hojjechaa jira`);
// });

