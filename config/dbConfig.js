'use strict';
const mongoose = require('mongoose');

// Connects to MongoDB Atlas. server.js waits for this before it starts listening.
async function connectDB() {
  const uri = process.env.CONN_STRING;
  if (!uri) throw new Error('CONN_STRING is missing in .env');
  await mongoose.connect(uri);
  console.log('MongoDB connected');
}

module.exports = connectDB;
