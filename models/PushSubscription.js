'use strict';
const mongoose = require('mongoose');

// One row per device (browser) that agreed to receive phone alerts.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 600 }, // the push service address of this device
    p256dh: { type: String, required: true, maxlength: 200 }, // the device's public key (alerts are encrypted for it)
    auth: { type: String, required: true, maxlength: 100 },
    preview: { type: Boolean, default: true }, // show the message text in this device's alerts?
    userAgent: { type: String, maxlength: 200 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema, 'push_subscriptions');