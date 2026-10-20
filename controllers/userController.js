'use strict';
const User = require('../models/User');
const { userPublic } = require('../utils/dto');
const { detectImage } = require('../utils/fileType');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Search by NAME only. Results contain id, name and photo -- never email or phone.
const searchUsers = async (req, res) => {
  const q = req.query.query;
  if (typeof q !== 'string') return res.status(400).json({ error: 'Invalid search' });
  const query = q.trim();
  if (query.length < 2 || query.length > 50) {
    return res.status(400).json({ error: 'Search must be 2-50 characters' });
  }

  // escapeRegex: the text is searched literally (blocks regex injection / ReDoS)
  const users = await User.find({ _id: { $ne: req.user._id }, name: new RegExp(escapeRegex(query), 'i') })
    .select('name updatedAt')
    .limit(20)
    .lean();

  res.json({ users: users.map(userPublic) });
};

const getUserById = async (req, res) => {
  const user = await User.findById(req.params.userId).select('name updatedAt').lean();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: userPublic(user) });
};

// Avatars are stored as data URLs. We decode them and send real image bytes with a fixed,
// verified content type, so a fake "image" can never run as a script.
const getAvatar = async (req, res) => {
  const user = await User.findById(req.params.userId).select('+profile').lean();
  const m = user && typeof user.profile === 'string' ? /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(user.profile) : null;
  if (!m) return res.status(404).end();

  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0 || buffer.length > 1024 * 1024 || detectImage(buffer) !== m[1]) return res.status(404).end();

  res.set({
    'Content-Type': m[1],
    'Content-Length': String(buffer.length),
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
  res.end(buffer);
};

module.exports = { searchUsers, getUserById, getAvatar };
