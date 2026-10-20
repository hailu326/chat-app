'use strict';
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // a login lasts 12 hours
const ISSUER = 'hailacho-chat';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const isProd = () => process.env.NODE_ENV === 'production';
// "__Host-" prefix (production only) makes the browser refuse cookies that are not Secure / site-wide
const cookieName = () => (isProd() ? '__Host-chat_session' : 'chat_session');

function assertAuthConfig() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET is missing or too short in .env (use at least 32 random characters)');
  }
}

function signToken(user) {
  return jwt.sign({ tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SECONDS,
    issuer: ISSUER,
    subject: String(user._id)
  });
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

const baseCookie = () => ({ httpOnly: true, secure: isProd(), sameSite: 'lax', path: '/' });

function setAuthCookie(res, token) {
  res.cookie(cookieName(), token, { ...baseCookie(), maxAge: TOKEN_TTL_SECONDS * 1000 });
}

function clearAuthCookie(res) {
  res.clearCookie(cookieName(), baseCookie());
}

// Checks the token AND that the user still exists AND that the login was not cancelled.
async function userFromToken(token) {
  if (!token || typeof token !== 'string') return { error: 'missing' };
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
  } catch (err) {
    return { error: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
  if (typeof payload.sub !== 'string' || !OBJECT_ID.test(payload.sub)) return { error: 'invalid' };
  const user = await User.findById(payload.sub).select('name email phone tokenVersion updatedAt');
  if (!user || (user.tokenVersion || 0) !== payload.tv) return { error: 'revoked' };
  return { user, exp: payload.exp };
}

// Protects REST routes. The user id ALWAYS comes from the signed cookie, never from the request body.
async function authenticate(req, res, next) {
  const result = await userFromToken(parseCookies(req.headers.cookie)[cookieName()]);
  if (result.error) {
    if (result.error !== 'missing') clearAuthCookie(res);
    return res.status(401).json({
      error: result.error === 'expired' ? 'Session expired. Please log in again.' : 'Authentication required'
    });
  }
  req.user = result.user;
  next();
}

function originAllowed(origin, host) {
  const extra = (process.env.CLIENT_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// CSRF protection for cookie logins:
//  1) SameSite cookie, 2) the Origin header must be our own site, 3) a custom header that
//  other websites cannot add to a cross-site request.
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !originAllowed(origin, req.get('host'))) return res.status(403).json({ error: 'Forbidden' });
  if (req.get('x-requested-with') !== 'chat-app') return res.status(403).json({ error: 'Forbidden' });
  next();
}

module.exports = {
  assertAuthConfig,
  signToken,
  parseCookies,
  cookieName,
  setAuthCookie,
  clearAuthCookie,
  userFromToken,
  authenticate,
  originAllowed,
  csrfGuard
};
