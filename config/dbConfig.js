// const mongoose = require('mongoose')
// require('dotenv').config();
// const dbURI = process.env.CONN_STRING;
// //connection logic
// mongoose.connect(dbURI);

//connection state
//const db = mongoose.connection;
//db.on('connected',() =>{
//     console.log('mongoose conected successfully')
// }
// db.on('error', () => {
//     console.log('DB connection failed')
// })

// module.exports = db;
const mongoose = require('mongoose');
require('dotenv').config();

const dbURI = process.env.CONN_STRING;

// MongoDB Atlas Connection
mongoose.connect(dbURI)
    .then(() => {
        console.log('MongoDB Atlas Connected Successfully! ✅');
        console.log('Database Name: chat-app 📂');
    })
    .catch((err) => {
        console.log('Atlas Connection Error: ❌', err.message);
    });

const db = mongoose.connection;
module.exports = db;
