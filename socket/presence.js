'use strict';
// Who is online right now (counts open sockets per user). Works for ONE server process.
// If you ever run several servers, replace this with Redis.
const counts = new Map();

function add(userId) {
  const n = (counts.get(userId) || 0) + 1;
  counts.set(userId, n);
  return n === 1; // true = user just came online
}

function remove(userId) {
  const n = (counts.get(userId) || 0) - 1;
  if (n <= 0) {
    counts.delete(userId);
    return true; // true = user just went offline
  }
  counts.set(userId, n);
  return false;
}

const isOnline = (userId) => counts.has(String(userId));

module.exports = { add, remove, isOnline };
