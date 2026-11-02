'use strict';
// ============================================================================
// Tests for calls (set-up over real sockets) and phone alerts (Web Push).
// A temporary in-memory MongoDB is used, so your real Atlas database is NEVER touched.
// The push service is replaced by a fake sender, so nothing is really sent anywhere.
// Run:  npx jest --runInBand --forceExit
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');

// The environment must be set BEFORE the app is loaded
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.PHONE_HASH_KEY = 'phone-key-'.padEnd(48, 'y');
process.env.RATE_LIMIT_OFF = '1';
process.env.CALL_RING_MS = '700';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-calls-'));
process.env.VAPID_PUBLIC_KEY = 'PUBLIC-KEY-FOR-TESTS';
process.env.VAPID_PRIVATE_KEY = 'private-key-for-tests';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
for (const k of ['STUN_URLS', 'TURN_URLS', 'TURN_SECRET', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN']) delete process.env[k];

const request = require('supertest');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/User');
const Conversation = require('../models/conversation');
const Message = require('../models/Message');
const PushSubscription = require('../models/PushSubscription');
const push = require('../utils/push');

const H = { 'X-Requested-With': 'chat-app' };
const PASSWORD = 'Passw0rdTest';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const CAND = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let mongod, app, server, io, baseUrl;
const openSockets = [];
let seq = 0;
let epSeq = 0;

// ---------------------------------------------------------------- helpers
const newAgent = () => request.agent(app).set(H);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const endpoint = () => `https://fcm.googleapis.com/fcm/send/test-${++epSeq}`;
const subBody = (ep, preview) => ({ subscription: { endpoint: ep, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, ...(preview === undefined ? {} : { preview }) });

async function makeUser(name) {
  const agent = newAgent();
  const email = `${name.toLowerCase()}${++seq}@test.com`;
  const res = await agent.post('/api/auth/register').send({ name, email, password: PASSWORD });
  expect(res.status).toBe(201);
  const cookie = res.headers['set-cookie'].map((c) => c.split(';')[0]).find((c) => c.startsWith('chat_session='));
  return { agent, id: res.body.user.id, email, name, cookie };
}
const openConv = async (a, b) => (await a.agent.post('/api/conversations').send({ userId: b.id })).body.conversation.id;

function connectSocket(cookie) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie } });
    s.log = [];
    s.onAny((ev, payload) => s.log.push([ev, payload]));
    openSockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => reject(err));
  });
}
const got = (s, ev) => s.log.filter((l) => l[0] === ev).map((l) => l[1]);
const ask = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const startCall = (s, conversationId, kind = 'audio') => ask(s, 'call:start', { conversationId, kind, sdp: SDP });
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return false;
};

// the fake push service
const sent = [];
const failFor = {};
const fakeSender = async (sub, payload, options) => {
  if (failFor[sub.endpoint]) throw Object.assign(new Error('push service error'), { statusCode: failFor[sub.endpoint] });
  sent.push({ endpoint: sub.endpoint, keys: sub.keys, payload: JSON.parse(payload), options });
};
const alerts = async (ms = 200) => { await sleep(ms); return sent.slice(); };

// ---------------------------------------------------------------- global setup / teardown
beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  ({ app, server, io } = require('../server'));
  await Promise.all([User.init(), Conversation.init(), Message.init(), PushSubscription.init()]);
  require('../socket')(io);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  push.setSender(fakeSender);
}, 240000);

afterAll(async () => {
  push.setSender(null);
  openSockets.forEach((s) => s.close());
  await sleep(500);
  if (io) await new Promise((resolve) => io.close(() => resolve()));
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongod) await mongod.stop();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
  for (const k of Object.keys(failFor)) delete failFor[k];
});

// ============================================================================
describe('Calls: set-up over real sockets', () => {
  let alice, bob, carol, convAB, sA, sB, sB2, sC;
  beforeAll(async () => {
    alice = await makeUser('Alice');
    bob = await makeUser('Bob');
    carol = await makeUser('Carol');
    convAB = await openConv(alice, bob);
    sA = await connectSocket(alice.cookie);
    sB = await connectSocket(bob.cookie);
    sB2 = await connectSocket(bob.cookie); // Bob's second device
    sC = await connectSocket(carol.cookie);
    await sleep(300);
  });
  afterEach(async () => {
    for (const s of [sA, sB, sB2, sC]) s.log.length = 0;
    // end any call that a test left behind
    for (const s of [sA, sB]) for (const id of []) await ask(s, 'call:hangup', { callId: id });
  });

  test('a full call: it rings all of Bob\'s devices (not Carol), Bob answers, candidates go both ways, Bob hangs up', async () => {
    const ack = await startCall(sA, convAB, 'video');
    expect(ack.ok).toBe(true);
    expect(ack.callId).toMatch(/^[a-f0-9]{32}$/);
    await waitFor(() => got(sB, 'call:incoming').length && got(sB2, 'call:incoming').length);
    for (const s of [sB, sB2]) {
      const inc = got(s, 'call:incoming')[0];
      expect(inc).toMatchObject({ callId: ack.callId, conversationId: convAB, kind: 'video', from: alice.id, offer: SDP });
    }
    expect(got(sA, 'call:incoming')).toHaveLength(0);
    expect(got(sC, 'call:incoming')).toHaveLength(0);

    expect((await ask(sB, 'call:accept', { callId: ack.callId, sdp: SDP + 'a=answer\r\n' })).ok).toBe(true);
    await waitFor(() => got(sA, 'call:accepted').length && got(sB2, 'call:ended').length);
    expect(got(sA, 'call:accepted')[0].answer).toBe(SDP + 'a=answer\r\n');
    expect(got(sB2, 'call:ended')[0].reason).toBe('answered_elsewhere');
    expect(got(sB, 'call:ended')).toHaveLength(0);

    sA.emit('call:ice', { callId: ack.callId, candidate: CAND });
    sB.emit('call:ice', { callId: ack.callId, candidate: CAND });
    await waitFor(() => got(sA, 'call:ice').length && got(sB, 'call:ice').length);
    expect(got(sB, 'call:ice')[0].candidate).toEqual({ ...CAND });
    expect(got(sC, 'call:ice')).toHaveLength(0);

    expect((await ask(sB, 'call:hangup', { callId: ack.callId })).ok).toBe(true);
    await waitFor(() => got(sA, 'call:ended').length);
    expect(got(sA, 'call:ended')[0].reason).toBe('hangup');
  });

  test('the person called is read from the conversation: ids sent by the browser are ignored', async () => {
    const ack = await ask(sA, 'call:start', { conversationId: convAB, kind: 'audio', sdp: SDP, to: carol.id, calleeId: carol.id, userId: carol.id });
    expect(ack.ok).toBe(true);
    await waitFor(() => got(sB, 'call:incoming').length);
    expect(got(sC, 'call:incoming')).toHaveLength(0);
    await ask(sA, 'call:hangup', { callId: ack.callId });
  });

  test('Carol cannot call inside Alice and Bob\'s conversation, and cannot touch their call', async () => {
    expect((await startCall(sC, convAB)).error).toBe('forbidden');
    const ack = await startCall(sA, convAB);
    await sleep(100);
    expect((await ask(sC, 'call:accept', { callId: ack.callId, sdp: SDP })).error).toBe('forbidden');
    expect((await ask(sC, 'call:reject', { callId: ack.callId })).error).toBe('forbidden');
    expect((await ask(sC, 'call:hangup', { callId: ack.callId })).error).toBe('forbidden');
    sC.emit('call:ice', { callId: ack.callId, candidate: CAND });
    await sleep(200);
    expect(got(sA, 'call:ice')).toHaveLength(0);
    expect(got(sB, 'call:ice')).toHaveLength(0);
    expect(got(sA, 'call:ended')).toHaveLength(0);
    await ask(sA, 'call:hangup', { callId: ack.callId });
  });

  test('bad messages are refused and the server stays healthy', async () => {
    for (const bad of [null, 'x', {}, { conversationId: 'zzz', kind: 'audio', sdp: SDP }, { conversationId: convAB, kind: 'voice', sdp: SDP }, { conversationId: convAB, kind: 'audio', sdp: 'hello' }]) {
      const ack = await ask(sA, 'call:start', bad);
      expect(['invalid', 'rate_limited']).toContain(ack.error);
    }
    expect((await alice.agent.get('/api/auth/me')).status).toBe(200);
  });

  test('a person who is already in a call is busy, and the second caller is told so', async () => {
    const convCB = await openConv(carol, bob);
    sC.emit('visibility', { visible: true });
    const ack = await startCall(sA, convAB);
    expect(ack.ok).toBe(true);
    await sleep(100);
    expect((await startCall(sC, convCB)).error).toBe('busy');
    await ask(sA, 'call:hangup', { callId: ack.callId });
  });

  test('decline and cancel tell the right person', async () => {
    let ack = await startCall(sA, convAB);
    await sleep(100);
    expect((await ask(sB, 'call:reject', { callId: ack.callId })).ok).toBe(true);
    await waitFor(() => got(sA, 'call:ended').length);
    expect(got(sA, 'call:ended')[0].reason).toBe('rejected');
    sA.log.length = 0; sB.log.length = 0; sB2.log.length = 0;
    ack = await startCall(sA, convAB);
    await sleep(100);
    expect((await ask(sA, 'call:hangup', { callId: ack.callId })).ok).toBe(true);
    await waitFor(() => got(sB, 'call:ended').length);
    expect(got(sB, 'call:ended')[0].reason).toBe('cancelled');
  });

  test('a call nobody answers ends for both people after the ring time', async () => {
    await startCall(sA, convAB);
    await waitFor(() => got(sA, 'call:ended').length && got(sB, 'call:ended').length, 3000);
    expect(got(sA, 'call:ended')[0].reason).toBe('timeout');
    expect(got(sB, 'call:ended')[0].reason).toBe('timeout');
  });

  test('a person who connects while it rings receives the call and can answer it', async () => {
    const dave = await makeUser('Dave');
    const convAD = await openConv(alice, dave);
    const ack = await startCall(sA, convAD, 'audio');
    sA.emit('call:ice', { callId: ack.callId, candidate: CAND });
    await sleep(100);
    const sD = await connectSocket(dave.cookie);
    await waitFor(() => got(sD, 'call:incoming').length && got(sD, 'call:ice').length);
    expect(got(sD, 'call:incoming')[0]).toMatchObject({ callId: ack.callId, offer: SDP, kind: 'audio' });
    expect((await ask(sD, 'call:accept', { callId: ack.callId, sdp: SDP })).ok).toBe(true);
    await ask(sD, 'call:hangup', { callId: ack.callId });
  });

  test('the old "call:request" placeholder does nothing any more', async () => {
    sA.emit('call:request', { conversationId: convAB, kind: 'voice' });
    await sleep(300);
    expect(got(sB, 'call:incoming')).toHaveLength(0);
  });
});

// ============================================================================
describe('Calls: network details (STUN / TURN)', () => {
  let u;
  beforeAll(async () => { u = await makeUser('Netty'); });
  afterEach(() => { for (const k of ['TURN_URLS', 'TURN_SECRET', 'TURN_USERNAME', 'TURN_CREDENTIAL']) delete process.env[k]; });

  test('login is required', async () => {
    expect((await request(app).get('/api/calls/ice')).status).toBe(401);
  });
  test('with nothing set up: public STUN only, never cached', async () => {
    const res = await u.agent.get('/api/calls/ice');
    expect(res.status).toBe(200);
    expect(res.body.hasTurn).toBe(false);
    expect(res.body.iceServers[0].urls.every((x) => x.startsWith('stun:'))).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });
  test('a fixed TURN login is passed on, and the settings of other options never leak', async () => {
    process.env.TURN_URLS = 'turn:r.example:80';
    process.env.TURN_USERNAME = 'user';
    process.env.TURN_CREDENTIAL = 'pass';
    const res = await u.agent.get('/api/calls/ice');
    expect(res.body.hasTurn).toBe(true);
    expect(res.body.iceServers[1]).toEqual({ urls: 'turn:r.example:80', username: 'user', credential: 'pass' });
  });
  test('with a shared secret the password is short-lived and the secret never leaves the server', async () => {
    process.env.TURN_URLS = 'turn:t.example:3478';
    process.env.TURN_SECRET = 'top-secret-value';
    const res = await u.agent.get('/api/calls/ice');
    expect(res.body.iceServers[1].username).toMatch(new RegExp(`^\\d{10}:${u.id}$`));
    expect(JSON.stringify(res.body)).not.toContain('top-secret-value');
  });
  test('only this site may use the camera and microphone (security header)', async () => {
    const res = await request(app).get('/');
    expect(res.headers['permissions-policy']).toMatch(/camera=\(self\)/);
    expect(res.headers['permissions-policy']).toMatch(/microphone=\(self\)/);
    expect(res.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
  });
});

// ============================================================================
describe('Phone alerts: registering devices', () => {
  let alice, bob;
  beforeAll(async () => { alice = await makeUser('AliceP'); bob = await makeUser('BobP'); });

  test('the public key is given out when alerts are set up, and hidden when not', async () => {
    let res = await alice.agent.get('/api/push/key');
    expect(res.body).toEqual({ enabled: true, publicKey: 'PUBLIC-KEY-FOR-TESTS' });
    expect(JSON.stringify(res.body)).not.toContain('private-key-for-tests');
    const saved = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    res = await alice.agent.get('/api/push/key');
    expect(res.body).toEqual({ enabled: false });
    process.env.VAPID_PUBLIC_KEY = saved;
  });

  test('login and the custom header are required', async () => {
    expect((await request(app).get('/api/push/key')).status).toBe(401);
    expect((await request(app).post('/api/push/subscribe').set(H).send(subBody(endpoint()))).status).toBe(401);
    expect((await request(app).post('/api/push/subscribe').set('Cookie', alice.cookie).send(subBody(endpoint()))).status).toBe(403);
  });

  test('a real browser push address is stored with the preview choice', async () => {
    const ep = endpoint();
    const res = await alice.agent.post('/api/push/subscribe').send(subBody(ep, false));
    expect(res.status).toBe(201);
    const row = await PushSubscription.findOne({ endpoint: ep });
    expect(String(row.user)).toBe(alice.id);
    expect(row.preview).toBe(false);
    expect(row.p256dh).toBe('B'.repeat(87));
  });

  test('strange registrations are refused: wrong shape, other addresses, internal addresses', async () => {
    const before = await PushSubscription.countDocuments();
    const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
    const bads = [
      {}, { subscription: 'x' }, { subscription: null }, { subscription: { endpoint: 5, keys } }, { subscription: { endpoint: endpoint(), keys: { p256dh: 'short', auth: 'a'.repeat(22) } } },
      { subscription: { endpoint: endpoint(), keys: { p256dh: 'B'.repeat(87), auth: 'bad chars!!' } } }, { subscription: { endpoint: endpoint() } },
      { ...subBody(endpoint()), preview: 'yes' }, { subscription: { endpoint: { $ne: 1 }, keys } }
    ];
    for (const b of bads) expect((await alice.agent.post('/api/push/subscribe').send(b)).status).toBe(400);
    for (const ep of ['http://fcm.googleapis.com/fcm/send/x', 'https://example.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.com/x']) {
      expect((await alice.agent.post('/api/push/subscribe').send(subBody(ep))).status).toBe(400);
    }
    expect(await PushSubscription.countDocuments()).toBe(before);
  });

  test('a device that is used by another account moves to it; people can only remove their own device', async () => {
    const ep = endpoint();
    await alice.agent.post('/api/push/subscribe').send(subBody(ep));
    await bob.agent.post('/api/push/subscribe').send(subBody(ep));
    expect(await PushSubscription.countDocuments({ endpoint: ep })).toBe(1);
    expect(String((await PushSubscription.findOne({ endpoint: ep })).user)).toBe(bob.id);
    await alice.agent.post('/api/push/unsubscribe').send({ endpoint: ep });
    expect(await PushSubscription.countDocuments({ endpoint: ep })).toBe(1);
    await bob.agent.post('/api/push/unsubscribe').send({ endpoint: ep });
    expect(await PushSubscription.countDocuments({ endpoint: ep })).toBe(0);
  });

  test('at most 10 devices per person', async () => {
    const carol = await makeUser('CarolP');
    for (let i = 0; i < 12; i++) await carol.agent.post('/api/push/subscribe').send(subBody(endpoint()));
    expect(await PushSubscription.countDocuments({ user: carol.id })).toBe(10);
  });
});

// ============================================================================
describe('Phone alerts: messages and calls (real flow)', () => {
  let alice, bob, carol, conv, epBob, epBobNoPreview;
  beforeAll(async () => {
    alice = await makeUser('AliceM');
    bob = await makeUser('BobM');
    carol = await makeUser('CarolM');
    conv = await openConv(alice, bob);
  });
  beforeEach(async () => {
    await PushSubscription.deleteMany({});
    epBob = endpoint();
    await bob.agent.post('/api/push/subscribe').send(subBody(epBob, true));
  });

  test('a new message alerts the OTHER person\'s devices only, with the text when preview is on', async () => {
    await carol.agent.post('/api/push/subscribe').send(subBody(endpoint()));
    await alice.agent.post('/api/push/subscribe').send(subBody(endpoint()));
    const res = await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'secret plan' });
    expect(res.status).toBe(201);
    const list = await alerts();
    expect(list).toHaveLength(1);
    expect(list[0].endpoint).toBe(epBob);
    expect(list[0].payload).toMatchObject({ type: 'message', title: 'AliceM', body: 'secret plan', conversationId: conv, url: `/?c=${conv}` });
    expect(list[0].options).toMatchObject({ urgency: 'high', TTL: 86400 });
  });

  test('a device that chose "no preview" never receives the text', async () => {
    await bob.agent.post('/api/push/subscribe').send(subBody(epBob, false));
    await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'private words' });
    const list = await alerts();
    expect(list[0].payload.body).toBe('New message');
    expect(JSON.stringify(list[0].payload)).not.toContain('private words');
  });

  test('a file message shows the file name', async () => {
    const res = await alice.agent.post(`/api/conversations/${conv}/messages`).attach('file', PNG, { filename: 'holiday.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect((await alerts())[0].payload.body).toBe('📎 holiday.png');
  });

  test('no alert while Bob is looking at the app; alerts return when he is not', async () => {
    const sB = await connectSocket(bob.cookie);
    sB.emit('visibility', { visible: true });
    await sleep(150);
    await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'one' });
    expect(await alerts()).toHaveLength(0);
    sB.emit('visibility', { visible: false });
    await sleep(150);
    await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'two' });
    expect(await alerts()).toHaveLength(1);
    sB.emit('visibility', { visible: true });
    await sleep(100);
    sB.close();
    await sleep(300);
    await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'three' });
    expect(await alerts()).toHaveLength(2);
  });

  test('a device that no longer exists is removed, and a failing push service never breaks sending', async () => {
    failFor[epBob] = 410;
    const res = await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'x' });
    expect(res.status).toBe(201);
    await sleep(300);
    expect(await PushSubscription.countDocuments({ endpoint: epBob })).toBe(0);
    const ep2 = endpoint();
    await bob.agent.post('/api/push/subscribe').send(subBody(ep2));
    failFor[ep2] = 500;
    expect((await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'y' })).status).toBe(201);
    await sleep(300);
    expect(await PushSubscription.countDocuments({ endpoint: ep2 })).toBe(1);
  });

  test('when alerts are not set up, messages still work and nothing is sent', async () => {
    const saved = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY, sub: process.env.VAPID_SUBJECT };
    push.setSender(null);
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT;
    try {
      expect((await alice.agent.post(`/api/conversations/${conv}/messages`).send({ text: 'quiet' })).status).toBe(201);
      expect(await alerts()).toHaveLength(0);
      expect((await bob.agent.post('/api/push/subscribe').send(subBody(endpoint()))).status).toBe(503);
    } finally {
      push.setSender(fakeSender);
      process.env.VAPID_PUBLIC_KEY = saved.pub; process.env.VAPID_PRIVATE_KEY = saved.priv; process.env.VAPID_SUBJECT = saved.sub;
    }
  });

  test('calls: ringing alert, then a "missed call" alert when the caller gives up; an answered call sends no missed alert', async () => {
    const sA = await connectSocket(alice.cookie);
    await sleep(200);
    let ack = await startCall(sA, conv, 'video');
    expect(ack.ok).toBe(true);
    let list = await alerts();
    expect(list.map((a) => a.payload.type)).toEqual(['call']);
    expect(list[0].payload).toMatchObject({ title: 'AliceM', body: 'Incoming video call' });
    expect(list[0].options).toMatchObject({ urgency: 'high', TTL: 30 });
    await ask(sA, 'call:hangup', { callId: ack.callId });
    list = await alerts();
    expect(list.map((a) => a.payload.type)).toEqual(['call', 'missed']);
    expect(list[1].payload.tag).toBe(list[0].payload.tag);

    sent.length = 0;
    const sB = await connectSocket(bob.cookie);
    sB.emit('visibility', { visible: false });
    ack = await startCall(sA, conv, 'audio');
    await ask(sB, 'call:accept', { callId: ack.callId, sdp: SDP });
    await ask(sA, 'call:hangup', { callId: ack.callId });
    expect((await alerts()).map((a) => a.payload.type)).not.toContain('missed');
    sA.close(); sB.close();
    await sleep(200);
  });
});

// ============================================================================
describe('Phone alerts: logging out stops them', () => {
  test('"log out of all devices" removes every registered device of the account', async () => {
    const u = await makeUser('LogoutAll');
    for (let i = 0; i < 3; i++) await u.agent.post('/api/push/subscribe').send(subBody(endpoint()));
    expect(await PushSubscription.countDocuments({ user: u.id })).toBe(3);
    expect((await u.agent.post('/api/auth/logout-all')).status).toBe(200);
    expect(await PushSubscription.countDocuments({ user: u.id })).toBe(0);
  });

  test('changing the password removes every registered device (other devices were signed out)', async () => {
    const u = await makeUser('NewPass');
    await u.agent.post('/api/push/subscribe').send(subBody(endpoint()));
    await u.agent.post('/api/push/subscribe').send(subBody(endpoint()));
    const res = await u.agent.patch('/api/auth/me').send({ currentPassword: PASSWORD, newPassword: 'N3wPassword99' });
    expect(res.status).toBe(200);
    expect(await PushSubscription.countDocuments({ user: u.id })).toBe(0);
  });

  test('a normal log out leaves other devices alone (the page removes only its own device)', async () => {
    const u = await makeUser('NormalOut');
    const mine = endpoint(), other = endpoint();
    await u.agent.post('/api/push/subscribe').send(subBody(mine));
    await u.agent.post('/api/push/subscribe').send(subBody(other));
    await u.agent.post('/api/push/unsubscribe').send({ endpoint: mine });
    await u.agent.post('/api/auth/logout');
    expect(await PushSubscription.countDocuments({ user: u.id })).toBe(1);
  });
});
