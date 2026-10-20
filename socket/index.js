'use strict';
const Conversation = require('../models/conversation');
const presence = require('./presence');
const { userFromToken, parseCookies, cookieName, originAllowed } = require('../middleware/auth');
const { isObjectId } = require('../middleware/validation');
const { createSocketLimiter } = require('../middleware/rateLimit');

const limitTyping = createSocketLimiter(30, 10 * 1000); // 30 typing events / 10 s
const limitCall = createSocketLimiter(5, 60 * 1000); // 5 call requests / minute

// ids of everybody who shares a conversation with this user
async function partnerIdsOf(userId) {
  const convs = await Conversation.find({ participants: userId }).select('participants').lean();
  const ids = new Set();
  convs.forEach((c) => c.participants.forEach((p) => String(p) !== userId && ids.add(String(p))));
  return [...ids];
}

module.exports = function attachSockets(io) {
  // 1) Every socket must be logged in. Identity comes ONLY from the signed HttpOnly cookie.
  io.use(async (socket, next) => {
    try {
      const { origin, host, cookie } = socket.handshake.headers;
      if (origin && !originAllowed(origin, host)) return next(new Error('forbidden')); // blocks other websites
      const result = await userFromToken(parseCookies(cookie)[cookieName()]);
      if (result.error) return next(new Error('unauthorized'));
      socket.data.userId = String(result.user._id);
      socket.data.exp = result.exp;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId;

    // End the connection when the login expires
    const ttl = Math.max(socket.data.exp * 1000 - Date.now(), 0);
    const expiryTimer = setTimeout(() => socket.disconnect(true), ttl);

    try {
      socket.join(`user:${userId}`);

      // 2) The SERVER decides which rooms this user joins: only conversations where they are a member.
      //    There is no event that lets a browser join a room by sending a room id.
      const convs = await Conversation.find({ participants: userId }).select('_id participants').lean();
      convs.forEach((c) => socket.join(`conv:${c._id}`));

      if (presence.add(userId)) {
        // online status is shown only to people who share a conversation with this user
        (await partnerIdsOf(userId)).forEach((pid) =>
          io.to(`user:${pid}`).emit('presence:update', { userId, online: true })
        );
      }
    } catch (err) {
      console.error('Socket setup error:', err.message);
      socket.disconnect(true);
      return;
    }

    // Typing: allowed only in rooms the server put this socket in
    socket.on('typing', (payload) => {
      if (!limitTyping(userId) || !payload || typeof payload !== 'object') return;
      const { conversationId, isTyping } = payload;
      if (!isObjectId(conversationId) || typeof isTyping !== 'boolean') return;
      if (!socket.rooms.has(`conv:${conversationId}`)) return;
      socket.to(`conv:${conversationId}`).emit('typing', { conversationId, userId, isTyping });
    });

    // Call request: only the other member of the conversation is notified (calls themselves are not built yet)
    socket.on('call:request', (payload) => {
      if (!limitCall(userId) || !payload || typeof payload !== 'object') return;
      const { conversationId, kind } = payload;
      if (!isObjectId(conversationId) || (kind !== 'voice' && kind !== 'video')) return;
      if (!socket.rooms.has(`conv:${conversationId}`)) return;
      socket.to(`conv:${conversationId}`).emit('call:incoming', { conversationId, kind, from: userId });
    });

    socket.on('disconnect', async () => {
      clearTimeout(expiryTimer);
      try {
        if (presence.remove(userId)) {
          (await partnerIdsOf(userId)).forEach((pid) =>
            io.to(`user:${pid}`).emit('presence:update', { userId, online: false })
          );
        }
      } catch (err) {
        console.error('Socket disconnect error:', err.message);
      }
    });
  });
};
