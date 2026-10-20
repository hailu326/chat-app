'use strict';
// ============================================================================
// Security tests for the private chat.
// They use a temporary in-memory MongoDB, so your real Atlas database is NEVER touched.
// Run:  npx jest --runInBand --forceExit
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');

// The environment must be set BEFORE the app is loaded
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.RATE_LIMIT_OFF = '1';
process.env.MAX_UPLOAD_MB = '1';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-uploads-'));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/User');
const Conversation = require('../models/conversation');
const Message = require('../models/Message');

const H = { 'X-Requested-With': 'chat-app' }; // header the API requires on every state-changing request
const PASSWORD = 'Passw0rdTest';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let mongod, app, server, io, baseUrl;
const openSockets = [];
let seq = 0;

// ---------------------------------------------------------------- helpers
const newAgent = () => request.agent(app).set(H);

async function makeUser(name) {
  const agent = newAgent();
  const email = `${name.toLowerCase()}${++seq}@test.com`;
  const res = await agent.post('/api/auth/register').send({ name, email, password: PASSWORD, phone: '0911223344' });
  expect(res.status).toBe(201);
  const cookie = res.headers['set-cookie'].map((c) => c.split(';')[0]).find((c) => c.startsWith('chat_session='));
  return { agent, id: res.body.user.id, email, name, cookie };
}

const openConv = async (a, b) => {
  const res = await a.agent.post('/api/conversations').send({ userId: b.id });
  expect([200, 201]).toContain(res.status);
  return res.body.conversation.id;
};
const sendMsg = (u, convId, text) => u.agent.post(`/api/conversations/${convId}/messages`).send({ text });
const withCookie = (method, url, cookie) => {
  const r = request(app)[method](url).set('Cookie', cookie);
  return method === 'get' ? r : r.set(H);
};

function connectSocket(cookie, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const s = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: headers });
    s.seen = [];
    s.onAny((ev) => s.seen.push(ev));
    openSockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => reject(err));
  });
}
const socketError = (cookie, extraHeaders = {}) =>
  new Promise((resolve) => {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const s = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: headers });
    openSockets.push(s);
    s.once('connect', () => resolve('connected'));
    s.once('connect_error', (err) => resolve(err.message));
  });

const waitEvent = (s, ev, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${ev}"`)), ms);
    s.once(ev, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });
const noEvent = (s, ev, ms = 800) =>
  new Promise((resolve, reject) => {
    const h = (d) => reject(new Error(`unexpected "${ev}" event: ${JSON.stringify(d)}`));
    s.once(ev, h);
    setTimeout(() => {
      s.off(ev, h);
      resolve();
    }, ms);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gridFiles = () => mongoose.connection.db.collection('private_files.files');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signFor = (userId, extra = {}, opts = {}) =>
  jwt.sign({ tv: 0, ...extra }, opts.secret || process.env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: opts.issuer || 'hailacho-chat',
    subject: String(userId),
    expiresIn: opts.expiresIn === undefined ? 3600 : opts.expiresIn
  });

// ---------------------------------------------------------------- global setup / teardown
beforeAll(async () => {
  // The default start-up limit is 10 s. On Windows the first start can be slow (antivirus scans the new mongod.exe).
  mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await mongoose.connect(mongod.getUri());
  ({ app, server, io } = require('../server'));
  await Promise.all([User.init(), Conversation.init(), Message.init()]);
  require('../socket')(io);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 240000);

afterAll(async () => {
  openSockets.forEach((s) => s.close());
  await sleep(500); // let the server finish its disconnect work before the database is closed
  if (io) await new Promise((resolve) => io.close(() => resolve()));
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongod) await mongod.stop();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

// ============================================================================
describe('Private chat security', () => {
  let alice, bob, carol, convAB, firstMsg;

  beforeAll(async () => {
    alice = await makeUser('Alice');
    bob = await makeUser('Bob');
    carol = await makeUser('Carol');
    convAB = await openConv(alice, bob);
    firstMsg = (await sendMsg(alice, convAB, 'hello bob, this is a secret plan')).body.message;
  });

  // ------------------------------------------------------------------ 1
  describe('1. Authorized users can use their own conversations', () => {
    test('Alice and Bob both see the conversation in their lists', async () => {
      for (const u of [alice, bob]) {
        const res = await u.agent.get('/api/conversations');
        expect(res.status).toBe(200);
        expect(res.body.conversations.map((c) => c.id)).toContain(convAB);
      }
    });
    test('Alice and Bob can both read the messages', async () => {
      for (const u of [alice, bob]) {
        const res = await u.agent.get(`/api/conversations/${convAB}/messages`);
        expect(res.status).toBe(200);
        expect(res.body.messages.map((m) => m.text)).toContain('hello bob, this is a secret plan');
      }
    });
    test('opening the same conversation twice does not create a duplicate', async () => {
      const again = await openConv(bob, alice);
      expect(again).toBe(convAB);
      expect(await Conversation.countDocuments({ participants: { $all: [alice.id, bob.id] } })).toBe(1);
    });
  });

  // ------------------------------------------------------------------ 2
  describe('2. An outsider cannot read another conversation', () => {
    test('Carol gets 404 for the messages (same answer as "does not exist")', async () => {
      const res = await carol.agent.get(`/api/conversations/${convAB}/messages`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('secret plan');
    });
    test('Carol gets the same 404 for a conversation id that does not exist', async () => {
      const res = await carol.agent.get(`/api/conversations/${new mongoose.Types.ObjectId()}/messages`);
      expect(res.status).toBe(404);
    });
    test("Carol's conversation list does not contain Alice and Bob's chat", async () => {
      const res = await carol.agent.get('/api/conversations');
      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(0);
    });
    test('Carol cannot mark the conversation as read', async () => {
      expect((await carol.agent.post(`/api/conversations/${convAB}/read`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ 3
  describe('3. An outsider cannot send into a conversation', () => {
    test('Carol gets 404 and nothing is saved', async () => {
      const res = await sendMsg(carol, convAB, 'I am sneaking in');
      expect(res.status).toBe(404);
      expect(await Message.countDocuments({ conversation: convAB, sender: carol.id })).toBe(0);
      expect(await Message.countDocuments({ text: 'I am sneaking in' })).toBe(0);
    });
    test('Carol cannot upload a file into it either (and no file is left on disk)', async () => {
      const before = fs.readdirSync(process.env.UPLOAD_DIR).length;
      const res = await carol.agent
        .post(`/api/conversations/${convAB}/messages`)
        .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(404);
      expect(fs.readdirSync(process.env.UPLOAD_DIR).length).toBe(before);
    });
  });

  // ------------------------------------------------------------------ 4
  describe('4. Nobody can pretend to be another sender', () => {
    test('sender / conversation / date sent in the body are ignored', async () => {
      const res = await alice.agent
        .post(`/api/conversations/${convAB}/messages`)
        .send({ text: 'I am Bob', sender: bob.id, senderId: bob.id, conversation: new mongoose.Types.ObjectId(), createdAt: '2000-01-01T00:00:00Z' });
      expect(res.status).toBe(201);
      expect(res.body.message.senderId).toBe(alice.id);
      expect(res.body.message.conversationId).toBe(convAB);
      const doc = await Message.findById(res.body.message.id);
      expect(String(doc.sender)).toBe(alice.id);
      expect(String(doc.conversation)).toBe(convAB);
      expect(doc.createdAt.getFullYear()).toBeGreaterThan(2020);
    });
    test('Carol cannot post "as Alice" into the conversation', async () => {
      const res = await carol.agent.post(`/api/conversations/${convAB}/messages`).send({ text: 'fake', sender: alice.id });
      expect(res.status).toBe(404);
    });
    test('profile update ignores extra fields (id, email, tokenVersion, password)', async () => {
      const res = await bob.agent
        .patch('/api/auth/me')
        .send({ name: 'Bobby', email: 'hacker@evil.com', tokenVersion: 99, password: 'Hacked1234', id: alice.id });
      expect(res.status).toBe(200);
      const dbBob = await User.findById(bob.id);
      expect(dbBob.email).toBe(bob.email);
      expect(dbBob.tokenVersion).toBe(0);
      expect((await User.findById(alice.id)).name).toBe('Alice');
      const login = await request(app).post('/api/auth/login').set(H).send({ email: bob.email, password: PASSWORD });
      expect(login.status).toBe(200); // old password still works, so the "password" field was ignored
      await bob.agent.patch('/api/auth/me').send({ name: 'Bob' });
    });
  });

  // ------------------------------------------------------------------ 5
  describe('5. Socket.IO rooms are private', () => {
    let sA, sB, sC;
    beforeAll(async () => {
      sA = await connectSocket(alice.cookie);
      sB = await connectSocket(bob.cookie);
      sC = await connectSocket(carol.cookie);
      await sleep(300); // let the server finish joining rooms
    });

    test('the server put only Alice and Bob in the conversation room', async () => {
      const ids = (await io.in(`conv:${convAB}`).fetchSockets()).map((s) => s.data.userId);
      expect(ids).toEqual(expect.arrayContaining([alice.id, bob.id]));
      expect(ids).not.toContain(carol.id);
    });
    test('Carol cannot join the room by sending room ids or fake join events', async () => {
      ['join', 'join-room', 'joinRoom', 'subscribe'].forEach((ev) => {
        sC.emit(ev, `conv:${convAB}`);
        sC.emit(ev, { room: `conv:${convAB}`, conversationId: convAB });
      });
      await sleep(400);
      const ids = (await io.in(`conv:${convAB}`).fetchSockets()).map((s) => s.data.userId);
      expect(ids).not.toContain(carol.id);
    });
    test('a new message reaches Bob but never Carol', async () => {
      const gotB = waitEvent(sB, 'message:new');
      const notC = noEvent(sC, 'message:new');
      await sendMsg(alice, convAB, 'live secret');
      expect((await gotB).text).toBe('live secret');
      await notC;
    });
    test("Carol's typing in Alice and Bob's room is not delivered", async () => {
      const notA = noEvent(sA, 'typing');
      const notB = noEvent(sB, 'typing');
      sC.emit('typing', { conversationId: convAB, isTyping: true });
      await Promise.all([notA, notB]);
    });
    test("Alice's typing reaches Bob but not Carol", async () => {
      const gotB = waitEvent(sB, 'typing');
      const notC = noEvent(sC, 'typing');
      sA.emit('typing', { conversationId: convAB, isTyping: true });
      const t = await gotB;
      expect(t.userId).toBe(alice.id);
      await notC;
    });
    test("Carol's fake call request is not delivered", async () => {
      const notB = noEvent(sB, 'call:incoming');
      sC.emit('call:request', { conversationId: convAB, kind: 'voice' });
      await notB;
    });
    test('read receipts go only to the conversation members', async () => {
      const gotA = waitEvent(sA, 'message:read');
      const notC = noEvent(sC, 'message:read');
      expect((await bob.agent.post(`/api/conversations/${convAB}/read`)).status).toBe(200);
      expect((await gotA).readerId).toBe(bob.id);
      await notC;
    });
    test('online status is shown only to people who share a conversation', async () => {
      const dave = await makeUser('Dave');
      const gotB = waitEvent(sB, 'presence:update');
      const notC = noEvent(sC, 'presence:update');
      const sAnother = await connectSocket(alice.cookie); // Alice already online -> no change, so use a fresh user
      sAnother.close();
      const sD = await connectSocket(dave.cookie); // Dave has no chats: nobody should hear about him
      await sleep(500);
      expect(sC.seen.filter((e) => e === 'presence:update')).toHaveLength(0);
      sD.close();
      gotB.catch(() => {});
      await notC;
    });
    test('old public events are gone: fake "chat-message" and "update-profile" do nothing', async () => {
      const notA = noEvent(sA, 'chat-message');
      sC.emit('chat-message', { name: 'Alice', message: 'forged old-style message', dateTime: new Date() });
      sC.emit('update-profile', { email: alice.email, name: 'HACKED' });
      await notA;
      await sleep(300);
      expect(await Message.countDocuments({ text: 'forged old-style message' })).toBe(0);
      expect((await User.findById(alice.id)).name).toBe('Alice');
    });
    test('a new socket does not receive the old global history', async () => {
      const s = await connectSocket(carol.cookie);
      await sleep(400);
      expect(s.seen).not.toContain('load-old-messages');
      expect(s.seen).not.toContain('clients-total');
    });
    test('garbage socket payloads do not crash the server', async () => {
      [null, 'x', 5, [], { conversationId: { $ne: 1 } }, { conversationId: 'zzz', isTyping: 'yes' }].forEach((p) => sA.emit('typing', p));
      [null, 'x', { kind: 'voice' }, { conversationId: convAB, kind: 'laser' }].forEach((p) => sA.emit('call:request', p));
      await sleep(300);
      expect((await alice.agent.get('/api/auth/me')).status).toBe(200);
    });
    test('a new conversation is joined by both sockets right away', async () => {
      const erin = await makeUser('Erin');
      const sE = await connectSocket(erin.cookie);
      const gotE = waitEvent(sE, 'conversation:new');
      const convAE = await openConv(alice, erin);
      expect((await gotE).conversationId).toBe(convAE);
      const gotMsg = waitEvent(sE, 'message:new');
      await sendMsg(alice, convAE, 'hi erin');
      expect((await gotMsg).text).toBe('hi erin');
    });
  });

  // ------------------------------------------------------------------ 6
  describe('6. Files and images are private', () => {
    let fileMsg;
    beforeAll(async () => {
      const res = await alice.agent
        .post(`/api/conversations/${convAB}/messages`)
        .field('text', 'my photo')
        .attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      fileMsg = res.body.message;
    });

    test('the response shows name, type and an API link, but never the stored file name', () => {
      expect(fileMsg.attachment.mime).toBe('image/png');
      expect(fileMsg.attachment.url).toBe(`/api/messages/${fileMsg.id}/attachment`);
      expect(JSON.stringify(fileMsg)).not.toMatch(/[a-f0-9]{32}/);
    });
    test('Bob (a member) can download it with safe headers', async () => {
      const res = await bob.agent.get(fileMsg.attachment.url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/png/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toMatch(/sandbox/);
      expect(Buffer.compare(res.body, PNG)).toBe(0);
    });
    test('Carol (not a member) gets 404', async () => {
      expect((await carol.agent.get(fileMsg.attachment.url)).status).toBe(404);
    });
    test('a visitor who is not logged in gets 401', async () => {
      expect((await request(app).get(fileMsg.attachment.url)).status).toBe(401);
    });
    test('the old public /uploads address does not serve files', async () => {
      expect((await request(app).get('/uploads/photo.png')).status).toBe(404);
      expect((await request(app).get('/uploads/')).status).toBe(404);
      expect((await request(app).get('/private_uploads/photo.png')).status).toBe(404);
    });
    test('the file is stored inside MongoDB (GridFS) and no loose file is left on disk', async () => {
      const doc = await gridFiles().findOne({ filename: 'photo.png' });
      expect(doc).toBeTruthy();
      expect(doc.length).toBe(PNG.length);
      expect(doc.metadata.mime).toBe('image/png');
      expect(fs.readdirSync(process.env.UPLOAD_DIR)).toHaveLength(0);
    });
    test('video/audio style Range requests work (206) and bad ranges give 416', async () => {
      const part = await bob.agent.get(fileMsg.attachment.url).set('Range', 'bytes=0-9').buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 0-9/${PNG.length}`);
      expect(Buffer.compare(part.body, PNG.subarray(0, 10))).toBe(0);
      expect((await bob.agent.get(fileMsg.attachment.url).set('Range', 'bytes=999-1000')).status).toBe(416);
      expect((await carol.agent.get(fileMsg.attachment.url).set('Range', 'bytes=0-9')).status).toBe(404);
    });
    test('a rejected upload leaves nothing in MongoDB and nothing on disk', async () => {
      const before = await gridFiles().countDocuments();
      const res = await alice.agent
        .post(`/api/conversations/${convAB}/messages`)
        .attach('file', Buffer.from('<html>x</html>'), { filename: 'bad.png', contentType: 'image/png' });
      expect(res.status).toBe(415);
      expect(await gridFiles().countDocuments()).toBe(before);
      expect(fs.readdirSync(process.env.UPLOAD_DIR)).toHaveLength(0);
    });
    test('HTML pretending to be a PNG is rejected', async () => {
      const res = await alice.agent
        .post(`/api/conversations/${convAB}/messages`)
        .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'evil.png', contentType: 'image/png' });
      expect(res.status).toBe(415);
    });
    test('.html, .svg, .exe and .js files are rejected', async () => {
      for (const name of ['page.html', 'image.svg', 'run.exe', 'code.js']) {
        const res = await alice.agent
          .post(`/api/conversations/${convAB}/messages`)
          .attach('file', Buffer.from('MZ<svg><script>1</script></svg>'), { filename: name, contentType: 'application/octet-stream' });
        expect(res.status).toBe(415);
      }
    });
    test('a PNG renamed .pdf (extension does not match the real type) is rejected', async () => {
      const res = await alice.agent.post(`/api/conversations/${convAB}/messages`).attach('file', PNG, { filename: 'fake.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(415);
    });
    test('a file bigger than the limit is rejected with 413', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]);
      const res = await alice.agent.post(`/api/conversations/${convAB}/messages`).attach('file', big, { filename: 'big.png', contentType: 'image/png' });
      expect(res.status).toBe(413);
    });
    test('a path like ../../evil.png is reduced to a safe display name', async () => {
      const res = await alice.agent.post(`/api/conversations/${convAB}/messages`).attach('file', PNG, { filename: '../../evil.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      expect(res.body.message.attachment.name).toBe('evil.png');
      expect(fs.readdirSync(process.env.UPLOAD_DIR)).toHaveLength(0); // the temporary copy is always removed
    });
    test('deleting a message also deletes its file from MongoDB', async () => {
      const res = await alice.agent.post(`/api/conversations/${convAB}/messages`).attach('file', PNG, { filename: 'gone.png', contentType: 'image/png' });
      const fileId = (await Message.findById(res.body.message.id)).attachment.fileId;
      expect(await gridFiles().countDocuments({ _id: fileId })).toBe(1);
      expect((await alice.agent.delete(`/api/messages/${res.body.message.id}`)).status).toBe(200);
      expect(await gridFiles().countDocuments({ _id: fileId })).toBe(0);
      expect((await bob.agent.get(res.body.message.attachment.url)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ 7
  describe('7. Edit and delete are only for the sender', () => {
    let msg;
    beforeEach(async () => {
      msg = (await sendMsg(alice, convAB, 'original text')).body.message;
    });

    test('Carol (outsider) gets 404 for edit and delete', async () => {
      expect((await carol.agent.patch(`/api/messages/${msg.id}`).send({ text: 'hacked' })).status).toBe(404);
      expect((await carol.agent.delete(`/api/messages/${msg.id}`)).status).toBe(404);
      expect((await Message.findById(msg.id)).text).toBe('original text');
    });
    test("Bob (a member, but not the sender) gets 403 and the message is unchanged", async () => {
      expect((await bob.agent.patch(`/api/messages/${msg.id}`).send({ text: 'hacked' })).status).toBe(403);
      expect((await bob.agent.delete(`/api/messages/${msg.id}`)).status).toBe(403);
      const doc = await Message.findById(msg.id);
      expect(doc.text).toBe('original text');
      expect(doc.deletedAt).toBeUndefined();
    });
    test('Alice can edit her own message and Bob receives the change live', async () => {
      const sB = await connectSocket(bob.cookie);
      await sleep(200);
      const got = waitEvent(sB, 'message:edited');
      const res = await alice.agent.patch(`/api/messages/${msg.id}`).send({ text: 'edited text' });
      expect(res.status).toBe(200);
      expect(res.body.message.edited).toBe(true);
      expect((await got).text).toBe('edited text');
    });
    test('Alice can delete her own message: text is removed and Bob sees "deleted"', async () => {
      const res = await alice.agent.delete(`/api/messages/${msg.id}`);
      expect(res.status).toBe(200);
      expect(res.body.message.deleted).toBe(true);
      expect(res.body.message.text).toBe('');
      const doc = await Message.findById(msg.id);
      expect(doc.text).toBe('');
      expect(doc.deletedAt).toBeTruthy();
      const list = await bob.agent.get(`/api/conversations/${convAB}/messages`);
      const shown = list.body.messages.find((m) => m.id === msg.id);
      expect(shown.deleted).toBe(true);
      expect(shown.text).toBe('');
      expect(shown.attachment).toBeNull();
    });
    test('a deleted message cannot be edited', async () => {
      await alice.agent.delete(`/api/messages/${msg.id}`);
      expect((await alice.agent.patch(`/api/messages/${msg.id}`).send({ text: 'zombie' })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ 8
  describe('8. Invalid ids and malformed requests are rejected safely', () => {
    const safe = (res) => {
      const t = JSON.stringify(res.body) + (res.text || '');
      expect(t).not.toMatch(/stack|at .*\.js|node_modules|mongoose|MongoServerError|CastError|ValidationError/i);
    };

    test.each(['not-an-id', '123', '%7B%24ne%3Anull%7D', 'x'.repeat(40)])('conversation id "%s" -> 400', async (id) => {
      const res = await alice.agent.get(`/api/conversations/${id}/messages`);
      expect(res.status).toBe(400);
      safe(res);
    });
    test('a valid but unknown conversation id -> 404', async () => {
      expect((await alice.agent.get(`/api/conversations/${new mongoose.Types.ObjectId()}/messages`)).status).toBe(404);
    });
    test('message ids: bad -> 400, unknown -> 404', async () => {
      expect((await alice.agent.patch('/api/messages/abc').send({ text: 'x' })).status).toBe(400);
      expect((await alice.agent.delete('/api/messages/abc')).status).toBe(400);
      expect((await alice.agent.get('/api/messages/abc/attachment')).status).toBe(400);
      expect((await alice.agent.delete(`/api/messages/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    });
    test('bad "before" cursor and bad "limit" are handled', async () => {
      expect((await alice.agent.get(`/api/conversations/${convAB}/messages?before=zzz`)).status).toBe(400);
      expect((await alice.agent.get(`/api/conversations/${convAB}/messages?limit=-5`)).status).toBe(200);
      expect((await alice.agent.get(`/api/conversations/${convAB}/messages?limit=999999`)).body.messages.length).toBeLessThanOrEqual(50);
    });
    test('NoSQL injection in login is rejected', async () => {
      for (const body of [
        { email: { $ne: null }, password: 'x' },
        { email: { $gt: '' }, password: { $ne: '' } },
        { email: alice.email, password: { $ne: '' } }
      ]) {
        const res = await request(app).post('/api/auth/login').set(H).send(body);
        expect(res.status).toBe(400);
        safe(res);
      }
    });
    test('NoSQL injection in register, open-conversation, message text and search is rejected', async () => {
      expect((await request(app).post('/api/auth/register').set(H).send({ name: { $ne: 1 }, email: 'a@b.com', password: PASSWORD })).status).toBe(400);
      expect((await alice.agent.post('/api/conversations').send({ userId: { $ne: null } })).status).toBe(400);
      expect((await alice.agent.post(`/api/conversations/${convAB}/messages`).send({ text: { $ne: '' } })).status).toBe(400);
      expect((await alice.agent.get('/api/users/search?query[$ne]=x')).status).toBe(400);
      expect((await alice.agent.get('/api/users/search?query=a&query=b')).status).toBe(400);
    });
    test('search text is literal (regex characters match nothing)', async () => {
      const res = await alice.agent.get('/api/users/search?query=' + encodeURIComponent('.*'));
      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(0);
    });
    test('chatting with yourself or with an unknown user is refused', async () => {
      expect((await alice.agent.post('/api/conversations').send({ userId: alice.id })).status).toBe(400);
      expect((await alice.agent.post('/api/conversations').send({ userId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
    });
    test('empty, whitespace-only and too-long messages are refused', async () => {
      expect((await sendMsg(alice, convAB, '')).status).toBe(400);
      expect((await sendMsg(alice, convAB, '     ')).status).toBe(400);
      expect((await sendMsg(alice, convAB, 'a'.repeat(4001))).status).toBe(400);
    });
    test('broken JSON -> 400 and a huge body -> 413, with safe messages', async () => {
      const broken = await request(app).post('/api/auth/login').set(H).set('Content-Type', 'application/json').send('{bad json');
      expect(broken.status).toBe(400);
      expect(broken.body.error).toBe('Invalid JSON');
      const huge = await request(app).post('/api/auth/login').set(H).send({ email: 'a@b.com', password: 'a'.repeat(400 * 1024) });
      expect(huge.status).toBe(413);
      safe(broken);
      safe(huge);
    });
    test('validation errors never echo the submitted password', async () => {
      const res = await request(app).post('/api/auth/register').set(H).send({ name: 'Zed', email: 'zed@test.com', password: 'weakpass123' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('weakpass123');
    });
    test('unknown API routes return a clean JSON 404', async () => {
      const res = await request(app).get('/api/does-not-exist');
      expect(res.status).toBe(404);
      safe(res);
    });
    test('avatar uploads must be real PNG/JPEG images', async () => {
      const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64');
      const fakePng = 'data:image/png;base64,' + Buffer.from('<html><script>1</script></html>').toString('base64');
      expect((await alice.agent.patch('/api/auth/me').send({ avatar: svg })).status).toBe(400);
      expect((await alice.agent.patch('/api/auth/me').send({ avatar: fakePng })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------ 9
  describe('9. Authentication failures, expired and forged tokens', () => {
    test('no cookie -> 401 on every protected area', async () => {
      for (const url of ['/api/conversations', '/api/auth/me', '/api/users/search?query=ab', `/api/conversations/${convAB}/messages`, `/api/users/${alice.id}`]) {
        expect((await request(app).get(url)).status).toBe(401);
      }
    });
    test('garbage cookie -> 401', async () => {
      expect((await withCookie('get', '/api/auth/me', 'chat_session=not.a.jwt')).status).toBe(401);
    });
    test('expired token -> 401 with a "session expired" message', async () => {
      const res = await withCookie('get', '/api/auth/me', 'chat_session=' + signFor(alice.id, {}, { expiresIn: -60 }));
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/expired/i);
    });
    test('token signed with the wrong secret -> 401', async () => {
      const res = await withCookie('get', '/api/auth/me', 'chat_session=' + signFor(alice.id, {}, { secret: 'attacker-secret'.padEnd(40, 'z') }));
      expect(res.status).toBe(401);
    });
    test('token with the wrong issuer -> 401', async () => {
      expect((await withCookie('get', '/api/auth/me', 'chat_session=' + signFor(alice.id, {}, { issuer: 'someone-else' }))).status).toBe(401);
    });
    test('"alg: none" token -> 401', async () => {
      const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: alice.id, tv: 0, iss: 'hailacho-chat', exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
      expect((await withCookie('get', '/api/auth/me', 'chat_session=' + forged)).status).toBe(401);
    });
    test('a token for a user that no longer exists -> 401', async () => {
      const ghost = await makeUser('Ghost');
      await User.deleteOne({ _id: ghost.id });
      expect((await withCookie('get', '/api/auth/me', ghost.cookie)).status).toBe(401);
    });
    test('a token with an old tokenVersion is revoked', async () => {
      expect((await withCookie('get', '/api/auth/me', 'chat_session=' + signFor(alice.id, { tv: 5 }))).status).toBe(401);
    });
    test('"log out everywhere" cancels the old cookie', async () => {
      const u = await makeUser('Frank');
      expect((await withCookie('get', '/api/auth/me', u.cookie)).status).toBe(200);
      expect((await u.agent.post('/api/auth/logout-all')).status).toBe(200);
      expect((await withCookie('get', '/api/auth/me', u.cookie)).status).toBe(401);
    });
    test('changing the password cancels old cookies but the browser stays logged in', async () => {
      const u = await makeUser('Gina');
      const res = await u.agent.patch('/api/auth/me').send({ currentPassword: PASSWORD, newPassword: 'N3wPassword99' });
      expect(res.status).toBe(200);
      expect((await withCookie('get', '/api/auth/me', u.cookie)).status).toBe(401);
      expect((await u.agent.get('/api/auth/me')).status).toBe(200);
      expect((await request(app).post('/api/auth/login').set(H).send({ email: u.email, password: 'N3wPassword99' })).status).toBe(200);
      expect((await request(app).post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD })).status).toBe(401);
    });
    test('changing the password needs the correct current password', async () => {
      const res = await alice.agent.patch('/api/auth/me').send({ currentPassword: 'WrongPass123', newPassword: 'N3wPassword99' });
      expect(res.status).toBe(400);
    });
    test('wrong password and unknown email give the same answer', async () => {
      const a = await request(app).post('/api/auth/login').set(H).send({ email: alice.email, password: 'WrongPass123' });
      const b = await request(app).post('/api/auth/login').set(H).send({ email: 'nobody@test.com', password: 'WrongPass123' });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.body).toEqual(b.body);
    });
    test('duplicate email is refused', async () => {
      const res = await request(app).post('/api/auth/register').set(H).send({ name: 'Copy', email: alice.email, password: PASSWORD });
      expect(res.status).toBe(409);
    });
    test('login cookie is HttpOnly and SameSite=Lax', async () => {
      const res = await request(app).post('/api/auth/login').set(H).send({ email: alice.email, password: PASSWORD });
      const c = res.headers['set-cookie'][0];
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ/); // the token is never in the JSON body
    });
    test('in production the cookie is also Secure, __Host- prefixed and has no Domain', async () => {
      const old = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await request(app).post('/api/auth/login').set(H).send({ email: alice.email, password: PASSWORD });
        const c = res.headers['set-cookie'][0];
        expect(c).toMatch(/^__Host-chat_session=/);
        expect(c).toMatch(/Secure/i);
        expect(c).toMatch(/HttpOnly/i);
        expect(c).toMatch(/Path=\//);
        expect(c).not.toMatch(/Domain=/i);
      } finally {
        process.env.NODE_ENV = old;
      }
    });
    test('requests from another website (Origin) are refused', async () => {
      const res = await alice.agent.post('/api/conversations').set('Origin', 'https://evil.example').send({ userId: bob.id });
      expect(res.status).toBe(403);
    });
    test('state-changing requests without the custom header are refused (CSRF)', async () => {
      const res = await request(app).post(`/api/conversations/${convAB}/messages`).set('Cookie', alice.cookie).send({ text: 'csrf attempt' });
      expect(res.status).toBe(403);
      expect(await Message.countDocuments({ text: 'csrf attempt' })).toBe(0);
    });
    test('sockets: no cookie, expired token and a foreign Origin are all refused', async () => {
      expect(await socketError(null)).toBe('unauthorized');
      expect(await socketError('chat_session=' + signFor(alice.id, {}, { expiresIn: -60 }))).toBe('unauthorized');
      expect(await socketError('chat_session=garbage')).toBe('unauthorized');
      expect(await socketError(alice.cookie, { origin: 'https://evil.example' })).toBe('forbidden');
      expect(await socketError(alice.cookie, { origin: baseUrl })).toBe('connected');
    });
    test('logging out disconnects the sockets', async () => {
      const u = await makeUser('Hank');
      const s = await connectSocket(u.cookie);
      const gone = new Promise((resolve) => s.once('disconnect', resolve));
      expect((await withCookie('post', '/api/auth/logout', u.cookie)).status).toBe(200);
      await gone;
      expect(s.connected).toBe(false);
    });
  });

  // ------------------------------------------------------------------ 10
  describe('10. Normal chat features still work', () => {
    let u1, u2, conv;
    beforeAll(async () => {
      u1 = await makeUser('Zoe');
      u2 = await makeUser('Yan');
      conv = await openConv(u1, u2);
    });

    test('register, me, logout and login work', async () => {
      const me = await u1.agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe(u1.email);
      expect((await u1.agent.post('/api/auth/logout')).status).toBe(200);
      expect((await u1.agent.get('/api/auth/me')).status).toBe(401);
      const login = await u1.agent.post('/api/auth/login').send({ email: u1.email, password: PASSWORD });
      expect(login.status).toBe(200);
      expect((await u1.agent.get('/api/auth/me')).status).toBe(200);
    });
    test('messages arrive live, with unread counts and read receipts', async () => {
      const s2 = await connectSocket((await u2.agent.post('/api/auth/login').send({ email: u2.email, password: PASSWORD })).headers['set-cookie'][0].split(';')[0]);
      await sleep(200);
      const live = waitEvent(s2, 'message:new');
      await sendMsg(u1, conv, 'hello Yan');
      expect((await live).text).toBe('hello Yan');

      let list = await u2.agent.get('/api/conversations');
      expect(list.body.conversations[0].unread).toBe(1);
      expect(list.body.conversations[0].lastMessage.text).toBe('hello Yan');
      expect(list.body.conversations[0].online).toBe(false); // Zoe has no open connection yet
      const zoeCookie = (await u1.agent.post('/api/auth/login').send({ email: u1.email, password: PASSWORD })).headers['set-cookie'][0].split(';')[0];
      await connectSocket(zoeCookie);
      await sleep(300);
      expect((await u2.agent.get('/api/conversations')).body.conversations[0].online).toBe(true); // now Zoe is online

      await u2.agent.post(`/api/conversations/${conv}/read`);
      list = await u2.agent.get('/api/conversations');
      expect(list.body.conversations[0].unread).toBe(0);
      const msgs = await u1.agent.get(`/api/conversations/${conv}/messages`);
      expect(msgs.body.messages[0].readAt).toBeTruthy();
    });
    test('older messages can be loaded page by page', async () => {
      for (let i = 0; i < 5; i++) await sendMsg(u1, conv, `page message ${i}`);
      const p1 = await u1.agent.get(`/api/conversations/${conv}/messages?limit=3`);
      expect(p1.body.messages).toHaveLength(3);
      expect(p1.body.hasMore).toBe(true);
      const p2 = await u1.agent.get(`/api/conversations/${conv}/messages?limit=50&before=${p1.body.messages[0].id}`);
      expect(p2.body.messages.length).toBeGreaterThan(0);
      expect(p2.body.messages.every((m) => m.id < p1.body.messages[0].id)).toBe(true);
    });
    test('a message with a file and a caption is delivered to the partner', async () => {
      const res = await u1.agent.post(`/api/conversations/${conv}/messages`).field('text', 'look at this').attach('file', PNG, { filename: 'pic.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      expect(res.body.message.text).toBe('look at this');
      expect((await u2.agent.get(res.body.message.attachment.url)).status).toBe(200);
    });
    test('a file without a caption is allowed', async () => {
      const res = await u1.agent.post(`/api/conversations/${conv}/messages`).attach('file', PNG, { filename: 'nocaption.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
    });
    test('search finds people by name and shows only id, name and photo link', async () => {
      const res = await u1.agent.get('/api/users/search?query=ya');
      expect(res.status).toBe(200);
      const yan = res.body.users.find((u) => u.id === u2.id);
      expect(yan).toBeTruthy();
      expect(Object.keys(yan).sort()).toEqual(['avatarUrl', 'id', 'name']);
      expect(JSON.stringify(res.body)).not.toContain(u2.email);
      expect(JSON.stringify(res.body)).not.toContain('0911223344');
      expect(res.body.users.find((u) => u.id === u1.id)).toBeUndefined(); // you are not in your own results
    });
    test('other users profile shows no email or phone', async () => {
      const res = await u1.agent.get(`/api/users/${u2.id}`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.user).sort()).toEqual(['avatarUrl', 'id', 'name']);
    });
    test('no response ever contains a password hash or a token', async () => {
      const outputs = [
        await u1.agent.get('/api/auth/me'),
        await u1.agent.get('/api/conversations'),
        await u1.agent.get(`/api/conversations/${conv}/messages`),
        await u1.agent.get('/api/users/search?query=ya')
      ];
      outputs.forEach((r) => {
        const t = JSON.stringify(r.body);
        expect(t).not.toMatch(/\$2[aby]\$/);
        expect(t).not.toMatch(/"password"/);
        expect(t).not.toMatch(/tokenVersion/);
      });
    });
    test('profile name changes reach the chat partner live', async () => {
      const s2 = await connectSocket((await u2.agent.post('/api/auth/login').send({ email: u2.email, password: PASSWORD })).headers['set-cookie'][0].split(';')[0]);
      await sleep(200);
      const outsider = await connectSocket(carol.cookie);
      const got = waitEvent(s2, 'profile:updated');
      const notC = noEvent(outsider, 'profile:updated');
      expect((await u1.agent.patch('/api/auth/me').send({ name: 'Zoe Renamed' })).status).toBe(200);
      expect((await got).userId).toBe(u1.id);
      await notC;
      const list = await u2.agent.get('/api/conversations');
      expect(list.body.conversations[0].partner.name).toBe('Zoe Renamed');
    });
    test('a valid avatar can be set and any logged-in user can view it; visitors cannot', async () => {
      const avatar = 'data:image/png;base64,' + PNG.toString('base64');
      expect((await u1.agent.patch('/api/auth/me').send({ avatar })).status).toBe(200);
      const res = await u2.agent.get(`/api/users/${u1.id}/avatar`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/png/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect((await request(app).get(`/api/users/${u1.id}/avatar`)).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ extra: headers + rate limits
  describe('Security headers and rate limits', () => {
    test('the page is served with a strict Content-Security-Policy and no X-Powered-By', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
      expect(res.headers['content-security-policy']).toMatch(/script-src-attr 'none'/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
    test('the health check works and shows nothing private', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
    test('the index page has no inline event handlers (so the strict CSP works)', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, ''); // ignore HTML comments
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    });
    test('too many wrong passwords -> 429 on the 11th try', async () => {
      process.env.RATE_LIMIT_OFF = '0';
      try {
        const statuses = [];
        for (let i = 0; i < 11; i++) {
          const r = await request(app).post('/api/auth/login').set(H).send({ email: 'ratelimit@test.com', password: 'WrongPass123' });
          statuses.push(r.status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
        expect(statuses[10]).toBe(429);
      } finally {
        process.env.RATE_LIMIT_OFF = '1';
      }
    });
  });
});
