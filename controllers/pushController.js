'use strict';
const PushSubscription = require('../models/PushSubscription');
const push = require('../utils/push');
const { isAllowedEndpoint } = require('../utils/pushPayload');

const MAX_DEVICES = 10; // one person can have at most 10 registered devices

// The browser needs the PUBLIC key to register. (The private key never leaves the server.)
const getKey = (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!push.isConfigured() || !process.env.VAPID_PUBLIC_KEY) return res.json({ enabled: false });
  res.json({ enabled: true, publicKey: process.env.VAPID_PUBLIC_KEY });
};

const subscribe = async (req, res) => {
  if (!push.isConfigured()) return res.status(503).json({ error: 'Phone alerts are not set up on the server' });

  const { subscription, preview } = req.body;
  const { endpoint, keys } = subscription;
  // Only real browser push services: the server must never be tricked into calling any other address
  if (!isAllowedEndpoint(endpoint)) return res.status(400).json({ error: 'This push service is not supported' });

  try {
    // One row per device. If the same device was used by another account before, it now belongs to THIS account.
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        $set: {
          user: req.user._id,
          p256dh: keys.p256dh,
          auth: keys.auth,
          preview: preview !== false,
          userAgent: String(req.get('user-agent') || '').slice(0, 200)
        }
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (!err || err.code !== 11000) throw err; // two requests at the same moment: the other one won, fine
  }

  const extra = await PushSubscription.find({ user: req.user._id }).sort({ updatedAt: -1 }).skip(MAX_DEVICES).select('_id').lean();
  if (extra.length) await PushSubscription.deleteMany({ _id: { $in: extra.map((s) => s._id) } });

  res.status(201).json({ ok: true });
};

// A person can only remove THEIR OWN device
const unsubscribe = async (req, res) => {
  await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.user._id });
  res.json({ ok: true });
};

module.exports = { getKey, subscribe, unsubscribe };