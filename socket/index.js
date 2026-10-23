'use strict';
const Conversation = require('../models/conversation');
const presence = require('./presence');
const privacy = require('./privacy');
const { userFromToken, parseCookies, cookieName, originAllowed } = require('../middleware/auth');
const { isObjectId } = require('../middleware/validation');
const { createSocketLimiter } = require('../middleware/rateLimit');

const limitTyping = createSocketLimiter(30, 10 * 1000); // 30 typing events / 10 s
const limitCall = createSocketLimiter(5, 60 * 1000); // 5 call requests / minute

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

      // online status is shown only to people who share a conversation with this user,
      // and only if this user did not turn "show when I am online" off
      if (presence.add(userId)) await privacy.announce(io, userId);
    } catch (err) {
      console.error('Socket setup error:', err.message);
      socket.disconnect(true);
      return;
    }

    // Typing: allowed only in rooms the server put this socket in
    socket.on('typing', async (payload) => {
      if (!limitTyping(userId) || !payload || typeof payload !== 'object') return;
      const { conversationId, isTyping } = payload;
      if (!isObjectId(conversationId) || typeof isTyping !== 'boolean') return;
      if (!socket.rooms.has(`conv:${conversationId}`)) return;
      try {
        if (!(await privacy.getSettings(userId)).showTyping) return; // "show when I am typing" is off
      } catch {
        return;
      }
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
        if (presence.remove(userId)) await privacy.announce(io, userId);
      } catch (err) {
        console.error('Socket disconnect error:', err.message);
      }
    });
  });
};
