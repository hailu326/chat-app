'use strict';
const User = require('../models/User');
const { KEYS, normalizeSettings } = require('../utils/settings');
const privacy = require('../socket/privacy');

const getSettings = async (req, res) => {
  res.json({ settings: normalizeSettings(req.user.settings) });
};

// Only the logged-in user's OWN settings: the id comes from the login cookie, never from the request.
const updateSettings = async (req, res) => {
  const body = req.body || {};
  const set = {};
  for (const k of KEYS) if (typeof body[k] === 'boolean') set[`settings.${k}`] = body[k];
  if (Object.keys(set).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await User.updateOne({ _id: req.user._id }, { $set: set });
  privacy.invalidate(req.user._id);

  // "Show when I am online" changed: tell the chat partners right away
  const io = req.app.get('io');
  if (io && 'settings.showOnline' in set) await privacy.announce(io, String(req.user._id));

  const fresh = await User.findById(req.user._id).select('settings').lean();
  res.json({ settings: normalizeSettings(fresh && fresh.settings) });
};

module.exports = { getSettings, updateSettings };
