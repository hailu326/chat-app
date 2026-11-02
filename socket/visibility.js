
'use strict';

// Which connections have the app VISIBLE (in front of the person).
// Phone alerts are sent only when a person has no visible connection.
const visibleByUser = new Map(); // userId -> Set(socketId)
const userBySocket = new Map(); // socketId -> userId

function set(userId, socketId, visible) {
  userId = String(userId);
  socketId = String(socketId);

  if (visible) {
    if (!visibleByUser.has(userId)) {
      visibleByUser.set(userId, new Set());
    }

    visibleByUser.get(userId).add(socketId);
    userBySocket.set(socketId, userId);
  } else {
    clear(socketId);
  }
}

function clear(socketId) {
  socketId = String(socketId);

  const userId = userBySocket.get(socketId);
  if (!userId) return;

  userBySocket.delete(socketId);

  const sockets = visibleByUser.get(userId);

  if (sockets) {
    sockets.delete(socketId);

    if (sockets.size === 0) {
      visibleByUser.delete(userId);
    }
  }
}

const hasVisible = (userId) => visibleByUser.has(String(userId));

module.exports = { set, clear, hasVisible };
