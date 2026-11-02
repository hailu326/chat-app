'use strict';
const Conversation = require('../models/conversation');
const presence = require('./presence');
const privacy = require('./privacy');
const visibility = require('./visibility');
const { CallManager } = require('./calls');
const { isCallId, isCallKind, validSdp, cleanCandidate } = require('../utils/callValidation');
const push = require('../utils/push');
const { userFromToken, parseCookies, cookieName, originAllowed } = require('../middleware/auth');
const { isObjectId } = require('../middleware/validation');
const { createSocketLimiter } = require('../middleware/rateLimit');
 
const limitTyping = createSocketLimiter(30, 10 * 1000); // 30 typing events / 10 s
const limitCall = createSocketLimiter(5, 60 * 1000); // 5 call requests / minute
const limitSignal = createSocketLimiter(600, 60 * 1000); // 600 call set-up messages / minute (network candidates)
const limitVisibility = createSocketLimiter(60, 60 * 1000);
 
module.exports = function attachSockets(io) {
  // Real-time calls. The WebRTC SET-UP messages travel through here; the audio and the video themselves go
  // directly between the two people (or through a TURN relay), never through this server.
  const calls = new CallManager({
    emitToUser: (userId, event, payload, exceptSocketId) => {
      const target = io.to(`user:${userId}`);
      (exceptSocketId ? target.except(exceptSocketId) : target).emit(event, payload);
    },
    notify: (evt) => {
      push.onCallEvent(evt).catch(() => {});
    },
    ringMs: Number(process.env.CALL_RING_MS) || 45000
  });
 
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
 
    // The page says whether it is visible. Phone alerts are sent only when the person is NOT looking at the app.
    // This is registered FIRST, before the database work below: the page sends it the moment it connects, and a
    // message that arrives before its listener exists is lost.
    socket.on('visibility', (payload) => {
      if (!limitVisibility(userId) || !payload || typeof payload.visible !== 'boolean') return;
      visibility.set(userId, socket.id, payload.visible);
    });
    socket.once('disconnect', () => visibility.clear(socket.id)); // never leave a "visible" mark behind for a connection that is gone
 
    try {
      socket.join(`user:${userId}`);
 
      // 2) The SERVER decides which rooms this user joins: only conversations where they are a member.
      //    There is no event that lets a browser join a room by sending a room id.
      const convs = await Conversation.find({ participants: userId }).select('_id participants').lean();
      convs.forEach((c) => socket.join(`conv:${c._id}`));
 
      // online status is shown only to people who share a conversation with this user,
      // and only if this user did not turn "show when I am online" off
      if (presence.add(userId)) await privacy.announce(io, userId);
 
      // Calls: a person who connects late (for example from a phone alert) receives the call that is still ringing
      calls.userBack(userId);
      const ringing = calls.pendingFor(userId);
      if (ringing) {
        socket.emit('call:incoming', { callId: ringing.callId, conversationId: ringing.conversationId, kind: ringing.kind, from: ringing.from, offer: ringing.offer });
        ringing.ice.forEach((candidate) => socket.emit('call:ice', { callId: ringing.callId, candidate }));
      }
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
 
    // ---------- CALLS (WebRTC set-up messages) ----------
    // The person who is called is read from the conversation in the database (never sent by the browser),
    // and every later message is checked against the call that the SERVER recorded.
    const replyTo = (ack) => (typeof ack === 'function' ? ack : () => {});
 
    socket.on('call:start', async (payload, ack) => {
      const reply = replyTo(ack);
      try {
        if (!payload || typeof payload !== 'object') return reply({ error: 'invalid' });
        if (!limitCall(userId)) return reply({ error: 'rate_limited' });
        const { conversationId, kind, sdp } = payload;
        if (!isObjectId(conversationId) || !isCallKind(kind) || !validSdp(sdp)) return reply({ error: 'invalid' });
        if (!socket.rooms.has(`conv:${conversationId}`)) return reply({ error: 'forbidden' });
        const conv = await Conversation.findOne({ _id: conversationId, participants: userId }).select('participants').lean();
        if (!conv) return reply({ error: 'forbidden' });
        const calleeId = conv.participants.map(String).find((p) => p !== userId);
        const result = calls.start({ callerId: userId, calleeId, conversationId: String(conversationId), kind, offer: sdp, socketId: socket.id });
        if (result.error) return reply({ error: result.error });
        reply({ ok: true, callId: result.call.id });
      } catch {
        reply({ error: 'server' });
      }
    });
 
    socket.on('call:accept', (payload, ack) => {
      const reply = replyTo(ack);
      if (!payload || typeof payload !== 'object' || !limitSignal(userId)) return reply({ error: 'invalid' });
      if (!isCallId(payload.callId) || !validSdp(payload.sdp)) return reply({ error: 'invalid' });
      const r = calls.accept({ userId, callId: payload.callId, answer: payload.sdp, socketId: socket.id });
      reply(r.error ? { error: r.error } : { ok: true });
    });
 
    socket.on('call:reject', (payload, ack) => {
      const reply = replyTo(ack);
      if (!payload || typeof payload !== 'object' || !limitSignal(userId) || !isCallId(payload.callId)) return reply({ error: 'invalid' });
      const r = calls.reject({ userId, callId: payload.callId, socketId: socket.id });
      reply(r.error ? { error: r.error } : { ok: true });
    });
 
    socket.on('call:hangup', (payload, ack) => {
      const reply = replyTo(ack);
      if (!payload || typeof payload !== 'object' || !limitSignal(userId) || !isCallId(payload.callId)) return reply({ error: 'invalid' });
      const r = calls.hangup({ userId, callId: payload.callId, socketId: socket.id });
      reply(r.error ? { error: r.error } : { ok: true });
    });
 
    socket.on('call:ice', (payload) => {
      if (!payload || typeof payload !== 'object' || !limitSignal(userId) || !isCallId(payload.callId)) return;
      const candidate = cleanCandidate(payload.candidate);
      if (candidate) calls.ice({ userId, callId: payload.callId, candidate });
    });
 
    socket.on('disconnect', async () => {
      clearTimeout(expiryTimer);
      visibility.clear(socket.id);
      try {
        if (presence.remove(userId)) {
          calls.userGone(userId); // a call ends (or gets a short grace time) when the person is completely offline
          await privacy.announce(io, userId);
        }
      } catch (err) {
        console.error('Socket disconnect error:', err.message);
      }
    });
  });
};