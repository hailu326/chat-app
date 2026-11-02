'use strict';
// Runs the REAL phone-alert code (utils/push.js and controllers/pushController.js) with a fake database
// and a fake sender. No packages and no database needed:  node tests/push-wiring.js
const Module = require('module');
const path = require('path');
const assert = require('assert');

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- fake database
const rows = new Map(); // endpoint -> row
let idc = 0;
let clock = 0;
const names = { u1: 'Alice', u2: 'Bob' };
function chain(get) {
  return { _sort: false, _skip: 0, sort() { this._sort = true; return this; }, skip(n) { this._skip = n; return this; }, select() { return this; },
    lean() { let a = get(); if (this._sort) a = a.sort((x, y) => y.updatedAt - x.updatedAt); return Promise.resolve(a.slice(this._skip)); } };
}
const FakePush = {
  find: (q) => chain(() => [...rows.values()].filter((r) => !q.user || String(r.user) === String(q.user))),
  async findOneAndUpdate(q, upd) { const cur = rows.get(q.endpoint); if (cur) Object.assign(cur, upd.$set, { updatedAt: ++clock }); else rows.set(q.endpoint, { _id: ++idc, endpoint: q.endpoint, ...upd.$set, updatedAt: ++clock }); },
  async deleteOne(q) { const r = rows.get(q.endpoint); if (r && String(r.user) === String(q.user)) rows.delete(q.endpoint); },
  async deleteMany(q) { for (const [e, r] of [...rows]) if ((q._id && q._id.$in.includes(r._id)) || (q.user && String(r.user) === String(q.user))) rows.delete(e); }
};
const FakeUser = { findById: (id) => ({ select: () => ({ lean: async () => (names[id] ? { name: names[id] } : null) }) }) };

const orig = Module._load;
Module._load = function (request, parent) {
  const f = (parent && parent.filename) || '';
  if (f.endsWith(path.join('utils', 'push.js')) || f.endsWith(path.join('controllers', 'pushController.js'))) {
    if (request === '../models/PushSubscription') return FakePush;
    if (request === '../models/User') return FakeUser;
  }
  return orig.apply(this, arguments);
};
const push = require(path.resolve('utils/push.js'));
const controller = require(path.resolve('controllers/pushController.js'));
Module._load = orig;
const visibility = require(path.resolve('socket/visibility.js'));

// ---------------------------------------------------------------- helpers
const res = () => ({ statusCode: 200, headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const sub = (endpoint, preview) => ({ subscription: { endpoint, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } }, ...(preview === undefined ? {} : { preview }) });
const fcm = (n) => 'https://fcm.googleapis.com/fcm/send/device-' + n;
const reqOf = (user, body) => ({ user: { _id: user }, body, get: () => 'TestBrowser/1.0' });
const sent = [];
let failWith = null;
const sender = async (subscription, payload, options) => { if (failWith) throw failWith(subscription); sent.push({ subscription, payload: JSON.parse(payload), options }); };
function reset() { rows.clear(); sent.length = 0; failWith = null; push.setSender(sender); process.env.VAPID_PUBLIC_KEY = 'PUBLICKEY'; process.env.VAPID_PRIVATE_KEY = 'x'; process.env.VAPID_SUBJECT = 'mailto:a@b.c'; }
const CONV = 'a'.repeat(24);
const msg = { recipientId: 'u2', senderName: 'Alice', text: 'secret words', attachmentName: '', conversationId: CONV };

// ---------------------------------------------------------------- tests
test('nothing is sent and the key is hidden until the three push settings exist', async () => {
  reset(); push.setSender(null); delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT;
  let r = res(); controller.getKey(reqOf('u1', {}), r); assert.deepStrictEqual(r.body, { enabled: false });
  r = res(); await controller.subscribe(reqOf('u1', sub(fcm(1))), r); assert.strictEqual(r.statusCode, 503); assert.strictEqual(rows.size, 0);
  assert.strictEqual(await push.notifyNewMessage(msg), 0);
  assert.strictEqual(await push.onCallEvent({ type: 'ringing', call: { calleeId: 'u2', callerId: 'u1', kind: 'audio', id: 'b'.repeat(32), conversationId: CONV } }), 0);
});

test('with the settings in place the public key is given out (never the private one), without caching', async () => {
  reset(); const r = res(); controller.getKey(reqOf('u1', {}), r);
  assert.deepStrictEqual(r.body, { enabled: true, publicKey: 'PUBLICKEY' }); assert.strictEqual(r.headers['Cache-Control'], 'no-store'); assert.ok(!JSON.stringify(r.body).includes('"x"'));
});

test('registering a device stores only what is needed; strange push services are refused', async () => {
  reset(); let r = res(); await controller.subscribe(reqOf('u2', sub(fcm(1), false)), r);
  assert.strictEqual(r.statusCode, 201); const row = rows.get(fcm(1));
  assert.strictEqual(String(row.user), 'u2'); assert.strictEqual(row.preview, false); assert.strictEqual(row.p256dh, 'p'.repeat(40)); assert.strictEqual(row.userAgent, 'TestBrowser/1.0');
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.com/x', 'https://u:p@fcm.googleapis.com/x']) {
    r = res(); await controller.subscribe(reqOf('u2', sub(bad)), r); assert.strictEqual(r.statusCode, 400, bad);
  }
  assert.strictEqual(rows.size, 1, 'nothing else was stored');
});

test('a device that changes account moves to the new account; people can only remove their OWN device', async () => {
  reset(); await controller.subscribe(reqOf('u1', sub(fcm(1))), res()); await controller.subscribe(reqOf('u2', sub(fcm(1))), res());
  assert.strictEqual(rows.size, 1); assert.strictEqual(String(rows.get(fcm(1)).user), 'u2');
  await controller.unsubscribe(reqOf('u1', { endpoint: fcm(1) }), res()); assert.strictEqual(rows.size, 1, 'u1 cannot remove the device of u2');
  await controller.unsubscribe(reqOf('u2', { endpoint: fcm(1) }), res()); assert.strictEqual(rows.size, 0);
});

test('one person can register at most 10 devices (the oldest are dropped)', async () => {
  reset(); for (let i = 1; i <= 12; i++) await controller.subscribe(reqOf('u2', sub(fcm(i))), res());
  const mine = [...rows.values()].filter((r) => String(r.user) === 'u2'); assert.strictEqual(mine.length, 10);
  assert.ok(rows.has(fcm(12)) && !rows.has(fcm(1)) && !rows.has(fcm(2)), 'newest kept, oldest removed');
});

test('each device decides if the text is shown; with "no preview" the text is never in the alert', async () => {
  reset(); await controller.subscribe(reqOf('u2', sub(fcm(1), true)), res()); await controller.subscribe(reqOf('u2', sub(fcm(2), false)), res());
  assert.strictEqual(await push.notifyNewMessage(msg), 2);
  const a = sent.find((s) => s.subscription.endpoint === fcm(1)), b = sent.find((s) => s.subscription.endpoint === fcm(2));
  assert.strictEqual(a.payload.body, 'secret words'); assert.strictEqual(b.payload.body, 'New message'); assert.ok(!JSON.stringify(b.payload).includes('secret'));
  assert.strictEqual(a.payload.title, 'Alice'); assert.strictEqual(a.payload.url, '/?c=' + CONV);
  assert.deepStrictEqual(Object.keys(a.subscription).sort(), ['endpoint', 'keys']); assert.deepStrictEqual(Object.keys(a.subscription.keys).sort(), ['auth', 'p256dh']);
  assert.strictEqual(a.options.urgency, 'high'); assert.strictEqual(a.options.TTL, 86400);
});

test('only the RECIPIENT\'s devices get the alert (not the sender\'s, not other people\'s)', async () => {
  reset(); await controller.subscribe(reqOf('u1', sub(fcm(1))), res()); await controller.subscribe(reqOf('u2', sub(fcm(2))), res()); await controller.subscribe(reqOf('u3', sub(fcm(3))), res());
  await push.notifyNewMessage(msg);
  assert.deepStrictEqual(sent.map((s) => s.subscription.endpoint), [fcm(2)]);
});

test('no alert while the person is looking at the app; alerts come back when they are not', async () => {
  reset(); await controller.subscribe(reqOf('u2', sub(fcm(1))), res());
  visibility.set('u2', 's1', true); assert.strictEqual(await push.notifyNewMessage(msg), 0); assert.strictEqual(sent.length, 0);
  visibility.clear('s1'); assert.strictEqual(await push.notifyNewMessage(msg), 1);
});

test('a file without text shows its name, with preview on', async () => {
  reset(); await controller.subscribe(reqOf('u2', sub(fcm(1), true)), res());
  await push.notifyNewMessage({ ...msg, text: '', attachmentName: 'photo.png' }); assert.strictEqual(sent[0].payload.body, '📎 photo.png');
});

test('devices that no longer exist (404 / 410) are removed; other errors keep them; sending never throws', async () => {
  reset(); for (const i of [1, 2, 3, 4]) await controller.subscribe(reqOf('u2', sub(fcm(i))), res());
  const codes = { [fcm(1)]: 410, [fcm(2)]: 404, [fcm(3)]: 500 };
  push.setSender(async (s, p, o) => {
    if (codes[s.endpoint]) throw Object.assign(new Error('push service says ' + codes[s.endpoint]), { statusCode: codes[s.endpoint] });
    sent.push({ subscription: s, payload: JSON.parse(p), options: o });
  });
  assert.strictEqual(await push.notifyNewMessage(msg), 1, 'only device 4 received it');
  assert.ok(!rows.has(fcm(1)) && !rows.has(fcm(2)), '410 and 404 are removed');
  assert.ok(rows.has(fcm(3)) && rows.has(fcm(4)), 'a temporary error (500) keeps the device');
  push.setSender(async () => { throw new Error('everything is broken'); });
  assert.strictEqual(await push.notifyNewMessage(msg), 0, 'no exception reaches the chat');
  push.setSender(async () => { throw undefined; }); // even a strange error value
  assert.strictEqual(await push.notifyNewMessage(msg), 0);
});

test('call alerts: ringing and missed, with the caller\'s name, and silent while the person is looking', async () => {
  reset(); await controller.subscribe(reqOf('u2', sub(fcm(1))), res());
  const call = { calleeId: 'u2', callerId: 'u1', kind: 'video', id: 'b'.repeat(32), conversationId: CONV };
  assert.strictEqual(await push.onCallEvent({ type: 'ringing', call }), 1);
  const ring = sent[0]; assert.strictEqual(ring.payload.type, 'call'); assert.strictEqual(ring.payload.title, 'Alice'); assert.strictEqual(ring.payload.body, 'Incoming video call'); assert.strictEqual(ring.options.TTL, 30); assert.strictEqual(ring.options.urgency, 'high');
  assert.strictEqual(await push.onCallEvent({ type: 'missed', call }), 1);
  const miss = sent[1]; assert.strictEqual(miss.payload.type, 'missed'); assert.strictEqual(miss.payload.body, 'Missed video call'); assert.strictEqual(miss.payload.tag, ring.payload.tag);
  assert.strictEqual(await push.onCallEvent({ type: 'something-else', call }), 0);
  sent.length = 0; visibility.set('u2', 's9', true); assert.strictEqual(await push.onCallEvent({ type: 'ringing', call }), 0); visibility.clear('s9');
  await push.onCallEvent({ type: 'ringing', call: { ...call, callerId: 'ghost' } }); assert.strictEqual(sent[0].payload.title, 'Someone', 'unknown caller');
});

test('if the push library is missing or the keys are wrong, nothing crashes and nothing is sent', async () => {
  reset(); await controller.subscribe(reqOf('u2', sub(fcm(1))), res()); push.setSender(null); // the real sender is used now
  assert.strictEqual(await push.notifyNewMessage(msg), 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', String(e.message).split('\n').slice(0, 3).join(' | ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
