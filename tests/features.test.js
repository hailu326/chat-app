'use strict';
// ============================================================================
// Tests for: settings, privacy switches, phone-contact lookup, file downloads, new page elements.
// A temporary in-memory MongoDB is used, so your real Atlas database is NEVER touched.
// Run:  npx jest --runInBand --forceExit
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');

// The environment must be set BEFORE the app is loaded
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.PHONE_HASH_KEY = 'phone-key-'.padEnd(48, 'y');
process.env.DEFAULT_COUNTRY_CODE = '251';
process.env.RATE_LIMIT_OFF = '1';
process.env.MAX_UPLOAD_MB = '1';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-features-'));

const request = require('supertest');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/User');
const Conversation = require('../models/conversation');
const Message = require('../models/Message');
const { backfillPhoneHashes } = require('../utils/phone');

const H = { 'X-Requested-With': 'chat-app' };
const PASSWORD = 'Passw0rdTest';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TXT = Buffer.from('hello from the chat\nsecond line\n');

let mongod, app, server, io, baseUrl;
const openSockets = [];
let seq = 0;

// ---------------------------------------------------------------- helpers
const newAgent = () => request.agent(app).set(H);

async function makeUser(name, phone) {
  const agent = newAgent();
  const email = `${name.toLowerCase()}${++seq}@test.com`;
  const body = { name, email, password: PASSWORD };
  if (phone) body.phone = phone;
  const res = await agent.post('/api/auth/register').send(body);
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
const sendFile = (u, convId, buf, filename, contentType, text) => {
  let r = u.agent.post(`/api/conversations/${convId}/messages`);
  if (text) r = r.field('text', text);
  return r.attach('file', buf, { filename, contentType });
};
const match = (u, phones) => u.agent.post('/api/contacts/match').send({ phones });

function connectSocket(cookie) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie } });
    openSockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => reject(err));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const fetchFile = (agent, url, headers = {}) => agent.get(url).set(headers).buffer(true).parse(binaryParser);

// ---------------------------------------------------------------- global setup / teardown
beforeAll(async () => {
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
  await sleep(500);
  if (io) await new Promise((resolve) => io.close(() => resolve()));
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongod) await mongod.stop();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

// ============================================================================
describe('Settings', () => {
  test('a new account starts with every privacy switch ON, and /me shows them', async () => {
    const u = await makeUser('Setty');
    const res = await u.agent.get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ readReceipts: true, showOnline: true, showTyping: true, discoverableByPhone: true });
    expect((await u.agent.get('/api/auth/me')).body.user.settings).toEqual(res.body.settings);
  });

  test('changes are saved, and only the switches that were sent change', async () => {
    const u = await makeUser('Saver');
    const res = await u.agent.patch('/api/settings').send({ readReceipts: false, showTyping: false });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ readReceipts: false, showOnline: true, showTyping: false, discoverableByPhone: true });
    expect((await u.agent.get('/api/settings')).body.settings.readReceipts).toBe(false);
    const doc = await User.findById(u.id);
    expect(doc.settings.readReceipts).toBe(false);
    expect(doc.settings.showOnline).toBe(true);
  });

  test('values that are not real true/false are rejected and nothing changes', async () => {
    const u = await makeUser('Strict');
    for (const body of [{ readReceipts: 'no' }, { showOnline: 1 }, { showTyping: { $ne: 1 } }, { discoverableByPhone: null }, { readReceipts: [true] }]) {
      const res = await u.agent.patch('/api/settings').send(body);
      expect(res.status).toBe(400);
    }
    expect((await u.agent.get('/api/settings')).body.settings.readReceipts).toBe(true);
  });

  test('an empty request or unknown keys give 400', async () => {
    const u = await makeUser('Empty');
    expect((await u.agent.patch('/api/settings').send({})).status).toBe(400);
    expect((await u.agent.patch('/api/settings').send({ isAdmin: true, tokenVersion: 9 })).status).toBe(400);
    expect((await User.findById(u.id)).tokenVersion).toBe(0);
  });

  test('login and the custom header are required', async () => {
    expect((await request(app).get('/api/settings')).status).toBe(401);
    expect((await request(app).patch('/api/settings').set(H).send({ readReceipts: false })).status).toBe(401);
    const u = await makeUser('Csrf');
    expect((await request(app).patch('/api/settings').set('Cookie', u.cookie).send({ readReceipts: false })).status).toBe(403);
    expect((await request(app).patch('/api/settings').set(H).set('Cookie', 'chat_session=garbage').send({ readReceipts: false })).status).toBe(401);
  });

  test("nobody can change another user's settings (ids in the request are ignored)", async () => {
    const a = await makeUser('Victim');
    const b = await makeUser('Intruder');
    const res = await b.agent.patch('/api/settings').send({ readReceipts: false, userId: a.id, _id: a.id, id: a.id });
    expect(res.status).toBe(200);
    expect((await User.findById(a.id)).settings.readReceipts).toBe(true);
    expect((await User.findById(b.id)).settings.readReceipts).toBe(false);
  });

  test('old accounts that have no settings stored still work (defaults apply)', async () => {
    const u = await makeUser('Oldie');
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(u.id) }, { $unset: { settings: '' } });
    const res = await u.agent.get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.showOnline).toBe(true);
    expect((await request(app).post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD })).status).toBe(200);
    expect((await u.agent.patch('/api/settings').send({ showOnline: false })).body.settings.showOnline).toBe(false);
  });

  test("other people never see someone's settings", async () => {
    const a = await makeUser('Private');
    const b = await makeUser('Curious');
    await a.agent.patch('/api/settings').send({ showOnline: false });
    expect(JSON.stringify((await b.agent.get(`/api/users/${a.id}`)).body)).not.toMatch(/settings|showOnline/);
    expect(JSON.stringify((await b.agent.get('/api/users/search?query=Private')).body)).not.toMatch(/settings|showOnline/);
  });
});

// ============================================================================
describe('Privacy switches are enforced', () => {
  let alice, bob, conv, sA, sB;
  beforeAll(async () => {
    alice = await makeUser('Alice');
    bob = await makeUser('Bob');
    conv = await openConv(alice, bob);
    sA = await connectSocket(alice.cookie);
    sB = await connectSocket(bob.cookie);
    await sleep(400);
  });

  test('read receipts OFF: the sender gets no blue ticks and no live event, the reader still clears the unread badge', async () => {
    expect((await bob.agent.patch('/api/settings').send({ readReceipts: false })).status).toBe(200);
    await sendMsg(alice, conv, 'one');
    const silent = noEvent(sA, 'message:read');
    expect((await bob.agent.post(`/api/conversations/${conv}/read`)).body.updated).toBe(1);
    await silent;
    const msgs = (await alice.agent.get(`/api/conversations/${conv}/messages`)).body.messages;
    expect(msgs.find((m) => m.text === 'one').readAt).toBeNull();
    expect((await bob.agent.get('/api/conversations')).body.conversations[0].unread).toBe(0);
  });

  test('read receipts ON again: ticks and the live event come back, the earlier hidden message stays hidden', async () => {
    expect((await bob.agent.patch('/api/settings').send({ readReceipts: true })).status).toBe(200);
    await sendMsg(alice, conv, 'two');
    const got = waitEvent(sA, 'message:read');
    await bob.agent.post(`/api/conversations/${conv}/read`);
    expect((await got).readerId).toBe(bob.id);
    const msgs = (await alice.agent.get(`/api/conversations/${conv}/messages`)).body.messages;
    expect(msgs.find((m) => m.text === 'two').readAt).toBeTruthy();
    expect(msgs.find((m) => m.text === 'one').readAt).toBeNull();
  });

  test('typing OFF: the partner receives no typing signal; the other direction still works; ON restores it', async () => {
    await bob.agent.patch('/api/settings').send({ showTyping: false });
    const notA = noEvent(sA, 'typing');
    sB.emit('typing', { conversationId: conv, isTyping: true });
    await notA;

    const gotB = waitEvent(sB, 'typing');
    sA.emit('typing', { conversationId: conv, isTyping: true });
    expect((await gotB).userId).toBe(alice.id);

    await bob.agent.patch('/api/settings').send({ showTyping: true });
    const gotA = waitEvent(sA, 'typing');
    sB.emit('typing', { conversationId: conv, isTyping: true });
    expect((await gotA).userId).toBe(bob.id);
  });

  test('online OFF: the partner is told "offline" at once and sees "offline" in the chat list; ON restores it', async () => {
    expect((await alice.agent.get('/api/conversations')).body.conversations[0].online).toBe(true);

    const gotOff = waitEvent(sA, 'presence:update');
    await bob.agent.patch('/api/settings').send({ showOnline: false });
    expect(await gotOff).toEqual({ userId: bob.id, online: false });
    expect((await alice.agent.get('/api/conversations')).body.conversations[0].online).toBe(false);

    const gotOn = waitEvent(sA, 'presence:update');
    await bob.agent.patch('/api/settings').send({ showOnline: true });
    expect(await gotOn).toEqual({ userId: bob.id, online: true });
    expect((await alice.agent.get('/api/conversations')).body.conversations[0].online).toBe(true);
  });

  test('an outsider never receives presence updates caused by a settings change', async () => {
    const carol = await makeUser('Carol');
    const sC = await connectSocket(carol.cookie);
    await sleep(300);
    const quiet = noEvent(sC, 'presence:update');
    await bob.agent.patch('/api/settings').send({ showOnline: false });
    await quiet;
    await bob.agent.patch('/api/settings').send({ showOnline: true });
  });
});

// ============================================================================
describe('Phone contacts', () => {
  let alice, bob, carol, dave, erin, frank, grace;
  beforeAll(async () => {
    alice = await makeUser('AliceC', '0911223344');
    bob = await makeUser('BobC', '+251922334455');
    carol = await makeUser('CarolC', '0933445566');
    dave = await makeUser('DaveC'); // no phone number
    erin = await makeUser('ErinC', '0944556677');
    frank = await makeUser('FrankC', '0955667788');
    grace = await makeUser('GraceC', '0955667788'); // same number as Frank
  });

  test('numbers written in different styles find the same people', async () => {
    const res = await match(carol, ['+251 91 122 3344', '0911223344', '251911223344', '(0922) 334-455', 'abc']);
    expect(res.status).toBe(200);
    const a = res.body.matches.find((m) => m.user.id === alice.id);
    const b = res.body.matches.find((m) => m.user.id === bob.id);
    expect(a.indexes.sort()).toEqual([0, 1, 2]);
    expect(b.indexes).toEqual([3]);
    expect(res.body.invalid).toBe(1);
    expect(res.body.checked).toBe(2);
  });

  test('a result contains only id, name and photo link: never a number, email or fingerprint', async () => {
    const res = await match(carol, ['0911223344']);
    expect(Object.keys(res.body.matches[0]).sort()).toEqual(['indexes', 'user']);
    expect(Object.keys(res.body.matches[0].user).sort()).toEqual(['avatarUrl', 'id', 'name']);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('911223344');
    expect(text).not.toContain(alice.email);
    expect(text).not.toMatch(/phoneHash|[a-f0-9]{64}/);
  });

  test('you never find yourself', async () => {
    expect((await match(alice, ['0911223344'])).body.matches).toHaveLength(0);
  });

  test('people without a phone number, and unknown numbers, are not found', async () => {
    expect((await match(carol, ['0999999999', '+14155550123'])).body.matches).toHaveLength(0);
  });

  test('two accounts with the same number are both returned', async () => {
    const ids = (await match(carol, ['0955667788'])).body.matches.map((m) => m.user.id).sort();
    expect(ids).toEqual([frank.id, grace.id].sort());
  });

  test('"let people find me by my phone number" OFF hides the account; ON shows it again', async () => {
    await erin.agent.patch('/api/settings').send({ discoverableByPhone: false });
    expect((await match(carol, ['0944556677'])).body.matches).toHaveLength(0);
    await erin.agent.patch('/api/settings').send({ discoverableByPhone: true });
    expect((await match(carol, ['0944556677'])).body.matches.map((m) => m.user.id)).toEqual([erin.id]);
  });

  test('changing the phone number in Edit profile updates what can be found', async () => {
    expect((await dave.agent.patch('/api/auth/me').send({ phone: '0966778899' })).status).toBe(200);
    expect((await match(carol, ['0966778899'])).body.matches.map((m) => m.user.id)).toEqual([dave.id]);
    expect((await dave.agent.patch('/api/auth/me').send({ phone: '0977889900' })).status).toBe(200);
    expect((await match(carol, ['0966778899'])).body.matches).toHaveLength(0);
    expect((await match(carol, ['0977889900'])).body.matches.map((m) => m.user.id)).toEqual([dave.id]);
  });

  test('a found person can be chatted with', async () => {
    const found = (await match(carol, ['0911223344'])).body.matches[0].user;
    const res = await carol.agent.post('/api/conversations').send({ userId: found.id });
    expect([200, 201]).toContain(res.status);
  });

  test('bad requests are rejected safely', async () => {
    expect((await carol.agent.post('/api/contacts/match').send({})).status).toBe(400);
    expect((await match(carol, [])).status).toBe(400);
    expect((await carol.agent.post('/api/contacts/match').send({ phones: '0911223344' })).status).toBe(400);
    expect((await carol.agent.post('/api/contacts/match').send({ phones: { $ne: 1 } })).status).toBe(400);
    expect((await match(carol, [{ $ne: 1 }])).status).toBe(400);
    expect((await match(carol, [12345678])).status).toBe(400);
    expect((await match(carol, ['ab'])).status).toBe(400);
    expect((await match(carol, ['1'.repeat(41)])).status).toBe(400);
    expect((await match(carol, Array.from({ length: 301 }, () => '0911223344'))).status).toBe(400);
    expect((await match(carol, Array.from({ length: 300 }, () => '0911223344'))).status).toBe(200);
  });

  test('login and the custom header are required', async () => {
    expect((await request(app).post('/api/contacts/match').set(H).send({ phones: ['0911223344'] })).status).toBe(401);
    expect((await request(app).post('/api/contacts/match').set('Cookie', carol.cookie).send({ phones: ['0911223344'] })).status).toBe(403);
  });

  test('accounts created before this feature get their fingerprint at start-up (and it is safe to run twice)', async () => {
    const old = await makeUser('Veteran', '0988776655');
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(old.id) }, { $unset: { phoneHash: '' } });
    expect((await match(carol, ['0988776655'])).body.matches).toHaveLength(0);
    expect(await backfillPhoneHashes(User)).toBeGreaterThanOrEqual(1);
    expect((await match(carol, ['0988776655'])).body.matches.map((m) => m.user.id)).toEqual([old.id]);
    expect(await backfillPhoneHashes(User)).toBe(0);
  });

  test('at most 20 lookups per hour per user (429 on the 21st)', async () => {
    const lim = await makeUser('Limited', '0900112233');
    process.env.RATE_LIMIT_OFF = '0';
    try {
      const statuses = [];
      for (let i = 0; i < 21; i++) statuses.push((await match(lim, ['0911223344'])).status);
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses[20]).toBe(429);
    } finally {
      process.env.RATE_LIMIT_OFF = '1';
    }
  });
});

// ============================================================================
describe('File downloads', () => {
  let alice, bob, carol, conv;
  beforeAll(async () => {
    alice = await makeUser('AliceF');
    bob = await makeUser('BobF');
    carol = await makeUser('CarolF');
    conv = await openConv(alice, bob);
  });

  test('the recipient can download a text file and a PDF with the right type and identical bytes', async () => {
    for (const [buf, name, type, mime] of [[TXT, 'notes.txt', 'text/plain', /^text\/plain/], [PDF, 'report.pdf', 'application/pdf', /^application\/pdf/]]) {
      const sent = await sendFile(alice, conv, buf, name, type);
      expect(sent.status).toBe(201);
      const res = await fetchFile(bob.agent, sent.body.message.attachment.url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(mime);
      expect(res.headers['content-disposition']).toMatch(/^attachment/);
      expect(Buffer.compare(res.body, buf)).toBe(0);
    }
  });

  test('pictures stay inline normally, and ?download=1 forces a real download of the same bytes', async () => {
    const sent = (await sendFile(alice, conv, PNG, 'photo.png', 'image/png', 'a picture')).body.message;
    const inline = await fetchFile(bob.agent, sent.attachment.url);
    expect(inline.headers['content-disposition']).toMatch(/^inline/);
    const forced = await fetchFile(bob.agent, sent.attachment.url + '?download=1');
    expect(forced.status).toBe(200);
    expect(forced.headers['content-disposition']).toMatch(/^attachment; filename="photo\.png"/);
    expect(forced.headers['content-type']).toMatch(/^image\/png/);
    expect(forced.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(forced.body, PNG)).toBe(0);
  });

  test('the sender can download too, and file names with Oromo or Amharic letters are kept', async () => {
    const name = 'ሰላም-barumsa.png';
    const sent = (await sendFile(alice, conv, PNG, name, 'image/png')).body.message;
    expect(sent.attachment.name).toBe(name);
    const res = await fetchFile(alice.agent, sent.attachment.url + '?download=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  test('a larger file arrives complete, and partial downloads (Range) still work', async () => {
    const big = Buffer.alloc(900 * 1024, 97);
    const sent = (await sendFile(alice, conv, big, 'big.txt', 'text/plain')).body.message;
    const full = await fetchFile(bob.agent, sent.attachment.url + '?download=1');
    expect(full.status).toBe(200);
    expect(full.body.length).toBe(big.length);
    const part = await fetchFile(bob.agent, sent.attachment.url + '?download=1', { Range: 'bytes=1000-1999' });
    expect(part.status).toBe(206);
    expect(part.body.length).toBe(1000);
  });

  test('only the two chat members can download: outsiders get 404, visitors 401 (with or without ?download=1)', async () => {
    const sent = (await sendFile(alice, conv, PDF, 'secret.pdf', 'application/pdf')).body.message;
    for (const suffix of ['', '?download=1']) {
      expect((await carol.agent.get(sent.attachment.url + suffix)).status).toBe(404);
      expect((await request(app).get(sent.attachment.url + suffix)).status).toBe(401);
    }
    expect((await bob.agent.get(sent.attachment.url + '?download=1')).status).toBe(200);
  });

  test('the ?download parameter cannot be used to get anything except 0/1 behaviour', async () => {
    const sent = (await sendFile(alice, conv, PNG, 'p.png', 'image/png')).body.message;
    for (const q of ['?download=0', '?download=yes', '?download[]=1', '?download=1&download=0']) {
      const res = await bob.agent.get(sent.attachment.url + q);
      expect(res.status).toBe(200);
    }
  });

  test('a deleted message\'s file can no longer be downloaded', async () => {
    const sent = (await sendFile(alice, conv, TXT, 'gone.txt', 'text/plain')).body.message;
    expect((await alice.agent.delete(`/api/messages/${sent.id}`)).status).toBe(200);
    expect((await bob.agent.get(sent.attachment.url + '?download=1')).status).toBe(404);
  });
});

// ============================================================================
describe('The page and its script (static checks)', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'public', ...p), 'utf8');

  test('every element id that main.js uses exists in index.html (no typos)', () => {
    const js = read('main.js');
    const html = read('index.html');
    const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    ['readReceipts', 'showOnline', 'showTyping', 'discoverableByPhone'].forEach((k) => used.add('set-' + k));
    const have = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    expect([...used].filter((id) => !have.has(id))).toEqual([]);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test('the Contacts and Settings icons are in the top bar, and the old Edit profile and Log out icons are still there', () => {
    const html = read('index.html');
    for (const id of ['contacts-btn', 'settings-btn', 'edit-profile-btn', 'logout-btn']) expect(html).toContain(`id="${id}"`);
  });

  test('the zoom lock exists, applies only inside the chat, and can be turned off in Settings', () => {
    expect(read('index.html')).toContain('id="set-allow-zoom"');
    const js = read('main.js');
    expect(js).toMatch(/maximum-scale=1, user-scalable=no/);
    expect(js).toMatch(/const zoomLocked = \(\) => !!me && !deviceSettings\.allowZoom/);
    expect(js).toMatch(/allowZoom/);
    expect(read('style.css')).toMatch(/touch-action: manipulation/);
    expect(read('style.css')).toMatch(/font-size: 16px !important/);
  });

  test('there are still no inline event handlers (the strict Content-Security-Policy keeps working)', () => {
    expect(read('index.html').replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test('every attachment gets a Download button', () => {
    expect(read('main.js')).toMatch(/att-dl/);
    expect(read('main.js')).toMatch(/\?download=1/);
  });

  test('the installed-app files are served: manifest, 4 icons and the service worker with the new cache name', async () => {
    expect((await request(app).get('/manifest.webmanifest')).status).toBe(200);
    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
      const res = await request(app).get('/icons/' + icon);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
    }
    expect((await request(app).get('/sw.js')).text).toContain('hailacho-shell-v2');
  });
});
