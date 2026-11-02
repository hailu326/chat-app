'use strict';
// Which web-push services a browser may register. Anything else is refused, so a person can never make
// this server send requests to an address of their choice (SSRF).
const HOST_PATTERNS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge, Samsung Internet, Opera (Android and desktop)
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, // Safari, iPhone Home Screen apps
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/ // old Edge
];

function isAllowedEndpoint(raw, extraHosts = process.env.PUSH_EXTRA_HOSTS) {
  if (typeof raw !== 'string' || raw.length > 600) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  const extra = String(extraHosts || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return extra.includes(host) || HOST_PATTERNS.some((re) => re.test(host));
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const isHex24 = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

// New chat message. With "preview" off the text is never put in the alert.
function messagePayload({ senderName, text, attachmentName, conversationId, preview }) {
  const id = isHex24(conversationId) ? conversationId : '';
  const body = preview ? (text ? clip(text, 140) : '📎 ' + clip(attachmentName || 'File', 60)) : 'New message';
  return {
    type: 'message',
    title: clip(senderName, 60) || 'New message',
    body,
    conversationId: id,
    tag: id ? 'conv-' + id : 'chat',
    url: id ? '/?c=' + id : '/'
  };
}

function callPayload({ callerName, kind, callId, conversationId }) {
  const id = isHex24(conversationId) ? conversationId : '';
  return {
    type: 'call',
    title: clip(callerName, 60) || 'Incoming call',
    body: kind === 'video' ? 'Incoming video call' : 'Incoming audio call',
    conversationId: id,
    callId: /^[a-f0-9]{32}$/.test(String(callId)) ? callId : '',
    tag: 'call-' + id, // a missed-call alert uses the same tag and replaces the ringing one
    url: id ? '/?c=' + id : '/'
  };
}

function missedCallPayload({ callerName, kind, conversationId }) {
  const id = isHex24(conversationId) ? conversationId : '';
  return {
    type: 'missed',
    title: clip(callerName, 60) || 'Missed call',
    body: kind === 'video' ? 'Missed video call' : 'Missed audio call',
    conversationId: id,
    tag: 'call-' + id,
    url: id ? '/?c=' + id : '/'
  };
}

module.exports = { isAllowedEndpoint, messagePayload, callPayload, missedCallPayload, clip };