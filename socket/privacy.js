'use strict';
// Privacy switches used by the real-time part of the app (online status and typing).
const User = require('../models/User');
const Conversation = require('../models/conversation');
const presence = require('./presence');
const { normalizeSettings } = require('../utils/settings');

const TTL_MS = 15 * 1000; // a switch change is also pushed through invalidate(), so this is only a safety net
const cache = new Map(); // userId -> { at, settings }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > TTL_MS) cache.delete(k);
}, 60 * 1000).unref();

async function getSettings(userId) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.settings;
  const u = await User.findById(key).select('settings').lean();
  const settings = normalizeSettings(u && u.settings);
  cache.set(key, { at: Date.now(), settings });
  return settings;
}

const invalidate = (userId) => cache.delete(String(userId));

// ids of everybody who shares a conversation with this user
async function partnerIdsOf(userId) {
  const me = String(userId);
  const convs = await Conversation.find({ participants: me }).select('participants').lean();
  const ids = new Set();
  convs.forEach((c) => c.participants.forEach((p) => String(p) !== me && ids.add(String(p))));
  return [...ids];
}

// Tells the chat partners whether this user is online.
// If the user turned "show when I am online" off, partners are told "offline" no matter what.
async function announce(io, userId) {
  const id = String(userId);
  const settings = await getSettings(id);
  const online = presence.isOnline(id) && settings.showOnline;
  (await partnerIdsOf(id)).forEach((pid) => io.to(`user:${pid}`).emit('presence:update', { userId: id, online }));
}

module.exports = { getSettings, invalidate, partnerIdsOf, announce };
