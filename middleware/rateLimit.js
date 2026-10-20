'use strict';
const { rateLimit } = require('express-rate-limit');

// RATE_LIMIT_OFF is honoured ONLY when NODE_ENV === 'test', so it can never switch limits off in production
const testSkip = () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_OFF === '1';

const make = (opts, message) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: testSkip,
    handler: (req, res) => res.status(429).json({ error: message }),
    ...opts
  });

const byUser = (req) => `u:${req.user._id}`;
const emailKey = (req) => {
  const e = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : 'none';
  return `acct:${e}`;
};

// Everything under /api (per IP)
const apiLimiter = make({ windowMs: 15 * 60 * 1000, limit: 600 }, 'Too many requests. Please slow down.');
// Login: 10 failed tries / 15 min per IP, and 10 per email address (stops password guessing)
const loginLimiter = make(
  { windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true },
  'Too many login attempts. Try again in 15 minutes.'
);
const loginAccountLimiter = make(
  { windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, keyGenerator: emailKey },
  'Too many login attempts. Try again in 15 minutes.'
);
const registerLimiter = make({ windowMs: 60 * 60 * 1000, limit: 10 }, 'Too many sign-ups from this network. Try later.');
// Sending / editing / deleting messages: 60 per minute per user
const messageLimiter = make({ windowMs: 60 * 1000, limit: 60, keyGenerator: byUser }, 'You are sending messages too fast.');
const searchLimiter = make({ windowMs: 60 * 1000, limit: 30, keyGenerator: byUser }, 'Too many searches. Please wait.');

// Tiny limiter for Socket.IO events (typing, call requests)
function createSocketLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    e.count += 1;
    return e.count <= max;
  };
}

module.exports = {
  apiLimiter,
  loginLimiter,
  loginAccountLimiter,
  registerLimiter,
  messageLimiter,
  searchLimiter,
  createSocketLimiter
}; 
