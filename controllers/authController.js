'use strict';
const bcrypt = require('bcrypt');
const User = require('../models/User');
const Conversation = require('../models/conversation');
const { userSelf } = require('../utils/dto');
const { parseImageDataUrl } = require('../utils/fileType');
const {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  parseCookies,
  cookieName,
  userFromToken
} = require('../middleware/auth');

// Used so that "unknown email" and "wrong password" take the same time (no user guessing by timing)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const disconnectUserSockets = (req, userId) => {
  const io = req.app.get('io');
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
};

// The login token is sent ONLY as an HttpOnly cookie. JavaScript in the page (or an attacker's script)
// can never read it, and it is NOT returned in the JSON body.
const register = async (req, res) => {
  const { name, email, password, phone, avatar } = req.body || {};

  let profile;
  if (avatar) {
    const img = parseImageDataUrl(avatar);
    if (!img.ok) return res.status(400).json({ error: img.error });
    profile = avatar;
  }

  if (await User.exists({ email })) return res.status(409).json({ error: 'Email already registered' });

  let user;
  try {
    user = await User.create({ name, email, password, phone: phone || undefined, profile });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }

  setAuthCookie(res, signToken(user));
  res.status(201).json({ user: userSelf(user) });
};

const login = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password');
  const ok = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

  setAuthCookie(res, signToken(user));
  res.json({ user: userSelf(user) });
};

// Works even if the session already expired (it just clears the cookie).
const logout = async (req, res) => {
  const result = await userFromToken(parseCookies(req.headers.cookie)[cookieName()]);
  clearAuthCookie(res);
  if (!result.error) disconnectUserSockets(req, result.user._id);
  res.json({ message: 'Logged out' });
};

// "Log out everywhere": raising tokenVersion makes every old login token invalid.
const logoutAll = async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  clearAuthCookie(res);
  disconnectUserSockets(req, req.user._id);
  res.json({ message: 'Logged out on all devices' });
};

const getProfile = async (req, res) => {
  res.json({ user: userSelf(req.user) });
};

const updateProfile = async (req, res) => {
  const { name, phone, avatar, currentPassword, newPassword } = req.body || {};
  const user = await User.findById(req.user._id).select('+password +profile');
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone || undefined;

  if (avatar) {
    const img = parseImageDataUrl(avatar);
    if (!img.ok) return res.status(400).json({ error: img.error });
    user.profile = avatar;
  }

  let passwordChanged = false;
  if (newPassword) {
    if (!currentPassword || !(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    user.password = newPassword; // hashed by the model before saving
    user.tokenVersion = (user.tokenVersion || 0) + 1; // cancels every old login
    passwordChanged = true;
  }

  await user.save();

  if (passwordChanged) {
    setAuthCookie(res, signToken(user)); // this browser stays logged in
    disconnectUserSockets(req, user._id); // other devices must log in again
  }

  // Only people who share a conversation with this user hear about the change
  const io = req.app.get('io');
  if (io) {
    const convs = await Conversation.find({ participants: user._id }).select('participants').lean();
    convs.forEach((c) =>
      c.participants.forEach((p) => {
        if (String(p) !== String(user._id)) io.to(`user:${p}`).emit('profile:updated', { userId: String(user._id) });
      })
    );
  }
  res.json({ user: userSelf(user) });
};

module.exports = { register, login, logout, logoutAll, getProfile, updateProfile };
