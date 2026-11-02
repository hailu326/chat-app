'use strict';
// Runs the REAL socket/index.js (the call handlers) with a fake server, fake sockets and fake database answers.
// No packages and no database needed:  node tests/socket-wiring.js
// It proves the rules in the code: who may start, answer, decline, hang up and send network candidates.
const Module = require('module');
const path = require('path');
const assert = require('assert');

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- fake database and helpers
let counter = 0;
const hex24 = () => String(++counter).padStart(24, 'c');
const conversations = {}; // id -> [userA, userB]
const newConv = (a, b) => { const id = hex24(); conversations[id] = [a, b]; return id; };
const fakeConversation = {
  findOne: (q) => ({ select: () => ({ lean: async () => { const p = conversations[q._id]; return p && p.includes(q.participants) ? { participants: p } : null; } }) }),
  find: (q) => ({ select: () => ({ lean: async () => Object.entries(conversations).filter(([, p]) => p.includes(q.participants)).map(([id, p]) => ({ _id: id, participants: p })) }) })
};
const privacySettings = {}; // userId -> { showTyping }
const fakePrivacy = { announce: async () => {}, getSettings: async (u) => ({ showTyping: true, showOnline: true, ...(privacySettings[u] || {}) }) };
const pushEvents = [];

function createSocketLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(); const e = hits.get(key);
    if (!e || e.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return true; }
    e.count += 1; return e.count <= max;
  };
}

const orig = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && parent.filename.endsWith(path.join('socket', 'index.js'))) {
    if (request === '../models/conversation') return fakeConversation;
    if (request === './privacy') return fakePrivacy;
    if (request === '../middleware/auth') return { userFromToken: async () => ({ error: 'missing' }), parseCookies: () => ({}), cookieName: () => 'c', originAllowed: () => true };
    if (request === '../middleware/validation') return { isObjectId: (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) };
    if (request === '../middleware/rateLimit') return { createSocketLimiter };
    if (request === '../utils/push') return { onCallEvent: async (e) => { pushEvents.push(e); } };
  }
  return orig.apply(this, arguments);
};
const attach = require(path.resolve('socket/index.js'));
Module._load = orig;
const visibility = require(path.resolve('socket/visibility.js'));

// ---------------------------------------------------------------- fake server and sockets
function makeServer() {
  const sockets = new Map();
  let connectionHandler;
  const io = {
    use() {},
    on(ev, fn) { if (ev === 'connection') connectionHandler = fn; },
    to(room) {
      return { _except: null, except(id) { this._except = id; return this; },
        emit(ev, payload) { for (const s of sockets.values()) if (s.rooms.has(room) && s.id !== this._except) s.received.push([ev, payload]); } };
    }
  };
  attach(io);
  let n = 0;
  const server = {
    sockets,
    async connect(userId) {
      const s = {
        id: `sock-${counter}-${++n}`, data: { userId, exp: Math.floor(Date.now() / 1000) + 3600 }, rooms: new Set(), handlers: {}, received: [], disconnected: false,
        join(r) { this.rooms.add(r); }, on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, payload) { this.received.push([ev, payload]); }, disconnect() { this.disconnected = true; },
        to(room) { return { emit: (ev, p) => { for (const o of sockets.values()) if (o !== this && o.rooms.has(room)) o.received.push([ev, p]); } }; }
      };
      s.rooms.add(s.id); sockets.set(s.id, s);
      await connectionHandler(s);
      return s;
    },
    async fire(s, ev, payload) { let ack; const p = s.handlers[ev](payload, (r) => { ack = r; }); await p; return ack; },
    async drop(s) { await s.handlers.disconnect(); sockets.delete(s.id); s.rooms.clear(); }
  };
  return server;
}
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const CAND = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
const got = (s, ev) => s.received.filter((r) => r[0] === ev).map((r) => r[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let u = 0;
const users = () => { u += 1; return [`alice${u}`, `bob${u}`, `carol${u}`]; };

// ---------------------------------------------------------------- tests
test('a call rings ALL devices of the other person only, and the caller gets a call id', async () => {
  const [A, B, C] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A), b1 = await srv.connect(B), b2 = await srv.connect(B), c = await srv.connect(C);
  const ack = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP });
  assert.ok(ack.ok); assert.match(ack.callId, /^[a-f0-9]{32}$/);
  for (const s of [b1, b2]) { const inc = got(s, 'call:incoming'); assert.strictEqual(inc.length, 1); assert.strictEqual(inc[0].callId, ack.callId); assert.strictEqual(inc[0].from, A); assert.strictEqual(inc[0].offer, SDP); assert.strictEqual(inc[0].kind, 'audio'); }
  assert.strictEqual(got(a, 'call:incoming').length, 0); assert.strictEqual(got(c, 'call:incoming').length, 0);
  assert.ok(pushEvents.some((e) => e.type === 'ringing' && e.call.calleeId === B && e.call.callerId === A));
});

test('the person to call is read from the conversation: ids sent by the browser are ignored', async () => {
  const [A, B, C] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A), b = await srv.connect(B), c = await srv.connect(C);
  const ack = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'video', sdp: SDP, to: C, calleeId: C, userId: C, callerId: B });
  assert.ok(ack.ok); assert.strictEqual(got(b, 'call:incoming').length, 1); assert.strictEqual(got(c, 'call:incoming').length, 0);
  assert.strictEqual(got(b, 'call:incoming')[0].from, A, 'the caller is the logged-in person');
});

test('a person who is not in the conversation cannot call in it (rooms AND database are checked)', async () => {
  const [A, B, C] = users(); const conv = newConv(A, B); const srv = makeServer();
  await srv.connect(A); const b = await srv.connect(B); const c = await srv.connect(C);
  assert.strictEqual((await srv.fire(c, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP })).error, 'forbidden');
  c.rooms.add('conv:' + conv); // even if she somehow had the room, the database check refuses
  assert.strictEqual((await srv.fire(c, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP })).error, 'forbidden');
  assert.strictEqual(got(b, 'call:incoming').length, 0);
});

test('bad call-start messages are refused with "invalid" and do not break anything', async () => {
  // every bad message is tried by a fresh person, because the limit of 5 call starts per minute also counts bad tries
  const srv = makeServer();
  const bads = [() => null, () => 'x', () => 5, () => [], () => ({}), () => ({ conversationId: 'zzz', kind: 'audio', sdp: SDP }),
    (c) => ({ conversationId: c, kind: 'voice', sdp: SDP }), (c) => ({ conversationId: c, kind: 'audio', sdp: 'hello' }), (c) => ({ conversationId: c, kind: 'audio', sdp: 'v=0 ' + 'x'.repeat(20001) }),
    () => ({ conversationId: { $ne: 1 }, kind: 'audio', sdp: SDP }), (c) => ({ conversationId: c, kind: ['audio'], sdp: SDP }), (c) => ({ conversationId: c, kind: 'audio', sdp: { a: 1 } })];
  for (const make of bads) {
    const [A, B] = users(); const conv = newConv(A, B);
    const a = await srv.connect(A); await srv.connect(B);
    const bad = make(conv);
    assert.strictEqual((await srv.fire(a, 'call:start', bad)).error, 'invalid', JSON.stringify(bad).slice(0, 70));
    assert.ok((await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP })).ok, 'a good request still works afterwards');
  }
  const [A2, B2] = users(); newConv(A2, B2); const a2 = await srv.connect(A2);
  await srv.sockets.get(a2.id).handlers['call:start']({ conversationId: 'zzz' }); // no answer function: must not throw
});

test('only the person who was called can accept; the answer reaches the caller; other devices stop ringing', async () => {
  const [A, B, C] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A), b1 = await srv.connect(B), b2 = await srv.connect(B), c = await srv.connect(C);
  const { callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP });
  assert.strictEqual((await srv.fire(a, 'call:accept', { callId, sdp: SDP })).error, 'forbidden', 'the caller cannot accept their own call');
  assert.strictEqual((await srv.fire(c, 'call:accept', { callId, sdp: SDP })).error, 'forbidden');
  assert.strictEqual((await srv.fire(b1, 'call:accept', { callId: 'f'.repeat(32), sdp: SDP })).error, 'not_found');
  assert.strictEqual((await srv.fire(b1, 'call:accept', { callId, sdp: 'junk' })).error, 'invalid');
  assert.ok((await srv.fire(b1, 'call:accept', { callId, sdp: SDP + 'a=answer\r\n' })).ok);
  assert.strictEqual(got(a, 'call:accepted').length, 1); assert.strictEqual(got(a, 'call:accepted')[0].answer, SDP + 'a=answer\r\n');
  assert.deepStrictEqual(got(b2, 'call:ended').map((e) => e.reason), ['answered_elsewhere']); assert.strictEqual(got(b1, 'call:ended').length, 0, 'the accepting device is not told');
  assert.strictEqual(got(c, 'call:accepted').length, 0);
  assert.strictEqual((await srv.fire(b2, 'call:accept', { callId, sdp: SDP })).error, 'not_ringing');
});

test('network candidates: cleaned, forwarded to the other person only, and strangers are ignored', async () => {
  const [A, B, C] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A), b = await srv.connect(B), c = await srv.connect(C);
  const { callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP });
  await srv.fire(b, 'call:accept', { callId, sdp: SDP });
  await srv.fire(a, 'call:ice', { callId, candidate: { ...CAND, evil: 'x', __proto__: { p: 1 } } });
  await srv.fire(b, 'call:ice', { callId, candidate: CAND });
  await srv.fire(c, 'call:ice', { callId, candidate: CAND }); // a stranger
  await srv.fire(a, 'call:ice', { callId, candidate: { candidate: 'not a candidate' } }); // bad
  await srv.fire(a, 'call:ice', { callId: 'zz', candidate: CAND }); // bad id
  await srv.fire(a, 'call:ice', null);
  const toB = got(b, 'call:ice'), toA = got(a, 'call:ice');
  assert.strictEqual(toB.length, 1); assert.deepStrictEqual(Object.keys(toB[0].candidate).sort(), ['candidate', 'sdpMLineIndex', 'sdpMid', 'usernameFragment']); assert.strictEqual(toB[0].callId, callId);
  assert.strictEqual(toA.length, 1); assert.strictEqual(got(c, 'call:ice').length, 0);
});

test('declining, cancelling and hanging up tell the right people, and a stranger cannot do any of it', async () => {
  const [A, B, C] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A), b = await srv.connect(B), c = await srv.connect(C);
  let { callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP });
  assert.strictEqual((await srv.fire(c, 'call:reject', { callId })).error, 'forbidden'); assert.strictEqual((await srv.fire(c, 'call:hangup', { callId })).error, 'forbidden');
  assert.ok((await srv.fire(b, 'call:reject', { callId })).ok);
  assert.deepStrictEqual(got(a, 'call:ended').map((e) => e.reason), ['rejected']);
  a.received.length = 0; b.received.length = 0; pushEvents.length = 0;
  ({ callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP }));
  assert.ok((await srv.fire(a, 'call:hangup', { callId })).ok);
  assert.deepStrictEqual(got(b, 'call:ended').map((e) => e.reason), ['cancelled']); assert.ok(pushEvents.some((e) => e.type === 'missed'));
  b.received.length = 0; a.received.length = 0;
  ({ callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'video', sdp: SDP })); await srv.fire(b, 'call:accept', { callId, sdp: SDP }); a.received.length = 0; b.received.length = 0;
  assert.ok((await srv.fire(b, 'call:hangup', { callId })).ok); assert.deepStrictEqual(got(a, 'call:ended').map((e) => e.reason), ['hangup']);
  assert.strictEqual((await srv.fire(a, 'call:hangup', { callId })).error, 'not_found', 'already over');
});

test('one call at a time: a busy person cannot be called, and a person in a call cannot start another', async () => {
  const [A, B, C] = users(); const ab = newConv(A, B), cb = newConv(C, B), ac = newConv(A, C); const srv = makeServer();
  const a = await srv.connect(A), b = await srv.connect(B), c = await srv.connect(C);
  assert.ok((await srv.fire(a, 'call:start', { conversationId: ab, kind: 'audio', sdp: SDP })).ok);
  assert.strictEqual((await srv.fire(c, 'call:start', { conversationId: cb, kind: 'audio', sdp: SDP })).error, 'busy');
  assert.strictEqual((await srv.fire(a, 'call:start', { conversationId: ac, kind: 'audio', sdp: SDP })).error, 'already_in_call');
  assert.strictEqual(got(b, 'call:incoming').length, 1, 'the busy person is not disturbed by the second caller');
});

test('at most 5 call starts per minute per person', async () => {
  const [A, B] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A); await srv.connect(B);
  for (let i = 0; i < 5; i++) { const ack = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP }); assert.ok(ack.ok, 'call ' + i); await srv.fire(a, 'call:hangup', { callId: ack.callId }); }
  assert.strictEqual((await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP })).error, 'rate_limited');
});

test('a person who connects while a call rings for them receives it, with the caller\'s network candidates', async () => {
  const [A, B] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A); // Bob is offline
  const { callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'video', sdp: SDP });
  await srv.fire(a, 'call:ice', { callId, candidate: CAND });
  const b = await srv.connect(B);
  const inc = got(b, 'call:incoming'); assert.strictEqual(inc.length, 1); assert.strictEqual(inc[0].callId, callId); assert.strictEqual(inc[0].kind, 'video'); assert.strictEqual(inc[0].offer, SDP);
  assert.strictEqual(got(b, 'call:ice').length, 1);
  assert.ok((await srv.fire(b, 'call:accept', { callId, sdp: SDP })).ok);
});

test('a ringing call that nobody answers ends for both people (and counts as missed)', async () => {
  process.env.CALL_RING_MS = '150';
  const [A, B] = users(); const conv = newConv(A, B); const srv = makeServer(); delete process.env.CALL_RING_MS;
  const a = await srv.connect(A), b = await srv.connect(B); pushEvents.length = 0;
  await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP });
  await sleep(300);
  assert.deepStrictEqual(got(a, 'call:ended').map((e) => e.reason), ['timeout']); assert.deepStrictEqual(got(b, 'call:ended').map((e) => e.reason), ['timeout']);
  assert.ok(pushEvents.some((e) => e.type === 'missed'));
});

test('when the caller goes completely offline while ringing, the call is cancelled; a call in progress is kept for a while', async () => {
  const [A, B] = users(); const conv = newConv(A, B); const srv = makeServer();
  let a = await srv.connect(A); const b = await srv.connect(B);
  await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP }); await srv.drop(a);
  assert.deepStrictEqual(got(b, 'call:ended').map((e) => e.reason), ['cancelled']);
  b.received.length = 0; a = await srv.connect(A);
  const { callId } = await srv.fire(a, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP }); await srv.fire(b, 'call:accept', { callId, sdp: SDP }); a.received.length = 0; b.received.length = 0;
  await srv.drop(b);
  assert.strictEqual(got(a, 'call:ended').length, 0, 'a short loss of connection does not end the call at once');
  const b2 = await srv.connect(B);
  assert.ok((await srv.fire(b2, 'call:hangup', { callId })).ok, 'the person can come back and still hang up');
});

test('a person with two devices stays "in the call" until BOTH are gone', async () => {
  const [A, B] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a1 = await srv.connect(A), a2 = await srv.connect(A), b = await srv.connect(B);
  await srv.fire(a1, 'call:start', { conversationId: conv, kind: 'audio', sdp: SDP });
  await srv.drop(a1);
  assert.strictEqual(got(b, 'call:ended').length, 0, 'one device left: the call goes on'); await srv.drop(a2);
  assert.deepStrictEqual(got(b, 'call:ended').map((e) => e.reason), ['cancelled']);
});

test('the page can say whether it is visible; strange messages are ignored', async () => {
  const [A] = users(); const srv = makeServer(); const a = await srv.connect(A);
  await srv.fire(a, 'visibility', { visible: true }); assert.ok(visibility.hasVisible(A));
  await srv.fire(a, 'visibility', { visible: 'yes' }); await srv.fire(a, 'visibility', null); assert.ok(visibility.hasVisible(A), 'unchanged by strange input');
  await srv.fire(a, 'visibility', { visible: false }); assert.ok(!visibility.hasVisible(A));
  await srv.fire(a, 'visibility', { visible: true }); await srv.drop(a); assert.ok(!visibility.hasVisible(A), 'a closed connection no longer counts as visible');
});

test('typing still follows the privacy switch, and the old "call:request" placeholder is gone', async () => {
  const [A, B] = users(); const conv = newConv(A, B); const srv = makeServer();
  const a = await srv.connect(A), b = await srv.connect(B);
  await srv.fire(a, 'typing', { conversationId: conv, isTyping: true }); assert.strictEqual(got(b, 'typing').length, 1);
  privacySettings[A] = { showTyping: false }; b.received.length = 0;
  await srv.fire(a, 'typing', { conversationId: conv, isTyping: true }); assert.strictEqual(got(b, 'typing').length, 0);
  assert.strictEqual(a.handlers['call:request'], undefined);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', String(e.message).split('\n').slice(0, 3).join(' | ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
