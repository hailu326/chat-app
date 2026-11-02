'use strict';
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const visibility = require('../socket/visibility');
const { messagePayload, callPayload, missedCallPayload } = require('./pushPayload');

let injectedSender = null; // used by tests
let realSender = null;

// Alerts are switched on only when the three VAPID variables are set (see .env.example)
function isConfigured() {
  return !!injectedSender || !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function getSender() {
  if (injectedSender) return injectedSender;
  if (!realSender) {
    const webpush = require('web-push'); // installed with: npm install web-push
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    realSender = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
  }
  return realSender;
}

const setSender = (fn) => {
  injectedSender = fn;
};

// makePayload(preview) builds the alert for ONE device (each device chooses whether the text is shown)
async function sendToUser(userId, makePayload, options = {}) {
  if (!isConfigured()) return 0;
  const subs = await PushSubscription.find({ user: userId }).lean();
  if (subs.length === 0) return 0;

  const send = getSender();
  const dead = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await send(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(makePayload(s.preview !== false)),
          { TTL: options.ttl || 3600, urgency: options.urgency || 'normal' }
        );
        sent += 1;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(s._id); // the device is gone
      }
    })
  );
  if (dead.length) await PushSubscription.deleteMany({ _id: { $in: dead } }).catch(() => {});
  return sent;
}

// A new chat message. Sent only when the person is NOT looking at the app.
async function notifyNewMessage({ recipientId, senderName, text, attachmentName, conversationId }) {
  try {
    if (!isConfigured() || visibility.hasVisible(recipientId)) return 0;
    return await sendToUser(
      recipientId,
      (preview) => messagePayload({ senderName, text, attachmentName, conversationId, preview }),
      { urgency: 'high', ttl: 86400 }
    );
  } catch (err) {
    console.error('Phone alert skipped:', err.message);
    return 0;
  }
}

// A call is ringing, or was missed
async function onCallEvent({ type, call }) {
  try {
    if (!isConfigured() || visibility.hasVisible(call.calleeId)) return 0;
    const caller = await User.findById(call.callerId).select('name').lean();
    const callerName = caller ? caller.name : 'Someone';
    if (type === 'ringing') {
      return await sendToUser(call.calleeId, () => callPayload({ callerName, kind: call.kind, callId: call.id, conversationId: call.conversationId }), { urgency: 'high', ttl: 30 });
    }
    if (type === 'missed') {
      return await sendToUser(call.calleeId, () => missedCallPayload({ callerName, kind: call.kind, conversationId: call.conversationId }), { urgency: 'high', ttl: 3600 });
    }
    return 0;
  } catch (err) {
    console.error('Phone alert skipped:', err.message);
    return 0;
  }
}

module.exports = { isConfigured, setSender, sendToUser, notifyNewMessage, onCallEvent };