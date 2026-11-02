// Quick checks you can run right now (no database needed):  node tests/quick-check.js
// Run it from the project root folder (chat-app). The full Jest + Supertest suite comes in the next step.
const assert = require('assert');
const Module = require('module');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', e.message); } };

// ---------- utils/fileType ----------
const ft = require(path.resolve('utils/fileType.js'));
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(32)]);
const jpg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(32)]);
const pdf = Buffer.from('%PDF-1.7\n....');
const html = Buffer.from('<html><script>alert(1)</script></html>');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
const zip = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.alloc(32)]);
const txt = Buffer.from('hello Oromoo, maaloo');
const bin = Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')]);
const mp4 = Buffer.concat([Buffer.from([0,0,0,0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);

t('real PNG named .png accepted', () => assert.strictEqual(ft.detectType(png, 'png').mime, 'image/png'));
t('real JPEG named .jpg accepted', () => assert.strictEqual(ft.detectType(jpg, 'jpg').mime, 'image/jpeg'));
t('PDF accepted, not inline', () => { const r = ft.detectType(pdf, 'pdf'); assert.strictEqual(r.mime, 'application/pdf'); assert.strictEqual(r.inline, false); });
t('HTML renamed .png is rejected', () => assert.strictEqual(ft.detectType(html, 'png'), null));
t('HTML named .html is rejected', () => assert.strictEqual(ft.detectType(html, 'html'), null));
t('SVG named .svg is rejected', () => assert.strictEqual(ft.detectType(svg, 'svg'), null));
t('SVG renamed .png is rejected', () => assert.strictEqual(ft.detectType(svg, 'png'), null));
t('EXE renamed .pdf is rejected', () => assert.strictEqual(ft.detectType(exe, 'pdf'), null));
t('EXE named .exe is rejected', () => assert.strictEqual(ft.detectType(exe, 'exe'), null));
t('PNG with .jpg extension is rejected (mismatch)', () => assert.strictEqual(ft.detectType(png, 'jpg'), null));
t('ZIP named .docx accepted as Word type', () => assert.ok(ft.detectType(zip, 'docx').mime.includes('wordprocessingml')));
t('ZIP named .js is rejected', () => assert.strictEqual(ft.detectType(zip, 'js'), null));
t('plain text .txt accepted', () => assert.strictEqual(ft.detectType(txt, 'txt').mime, 'text/plain'));
t('binary named .txt rejected', () => assert.strictEqual(ft.detectType(bin, 'txt'), null));
t('MP4 accepted and inline', () => { const r = ft.detectType(mp4, 'mp4'); assert.strictEqual(r.mime, 'video/mp4'); assert.strictEqual(r.inline, true); });
t('no extension rejected', () => assert.strictEqual(ft.detectType(png, ''), null));
t('empty / tiny buffer rejected', () => assert.strictEqual(ft.detectType(Buffer.alloc(2), 'png'), null));

t('sanitizeFileName removes path traversal', () => assert.strictEqual(ft.sanitizeFileName('../../etc/passwd'), 'passwd'));
t('sanitizeFileName removes windows path', () => assert.strictEqual(ft.sanitizeFileName('C:\\Users\\x\\evil.png'), 'evil.png'));
t('sanitizeFileName removes control chars and quotes', () => assert.ok(!/["<>:|?*\u0000-\u001f]/.test(ft.sanitizeFileName('a"b<c>d\u0000.png'))));
t('sanitizeFileName strips leading dots', () => assert.strictEqual(ft.sanitizeFileName('...hidden.txt'), 'hidden.txt'));
t('sanitizeFileName limits length', () => assert.ok(ft.sanitizeFileName('a'.repeat(500) + '.pdf').length <= 120));
t('sanitizeFileName repairs UTF-8 names read as latin1', () => assert.strictEqual(ft.sanitizeFileName(Buffer.from('ሰላም.png', 'utf8').toString('latin1')), 'ሰላም.png'));
t('sanitizeFileName empty -> "file"', () => assert.strictEqual(ft.sanitizeFileName(''), 'file'));

const okUrl = 'data:image/png;base64,' + png.toString('base64');
t('avatar data URL: real PNG accepted', () => assert.strictEqual(ft.parseImageDataUrl(okUrl).ok, true));
t('avatar data URL: SVG rejected', () => assert.strictEqual(ft.parseImageDataUrl('data:image/svg+xml;base64,' + svg.toString('base64')).ok, false));
t('avatar data URL: HTML pretending to be PNG rejected', () => assert.strictEqual(ft.parseImageDataUrl('data:image/png;base64,' + html.toString('base64')).ok, false));
t('avatar data URL: JPEG label on PNG bytes rejected', () => assert.strictEqual(ft.parseImageDataUrl('data:image/jpeg;base64,' + png.toString('base64')).ok, false));
t('avatar data URL: too large rejected', () => assert.strictEqual(ft.parseImageDataUrl('data:image/png;base64,' + Buffer.concat([png, Buffer.alloc(300 * 1024)]).toString('base64')).ok, false));
t('avatar data URL: non-string rejected', () => assert.strictEqual(ft.parseImageDataUrl({ $ne: 1 }).ok, false));

// ---------- utils/dto (no private fields leak) ----------
const dto = require(path.resolve('utils/dto.js'));
t('userPublic has no email or phone', () => { const u = dto.userPublic({ _id: 'a'.repeat(24), name: 'X', email: 'e@x.com', phone: '123', password: 'h' }); assert.deepStrictEqual(Object.keys(u).sort(), ['avatarUrl', 'id', 'name']); });
t('messageDTO hides text and file of deleted message', () => { const m = dto.messageDTO({ _id: 'b'.repeat(24), conversation: 'c'.repeat(24), sender: 'a'.repeat(24), text: 'secret', deletedAt: new Date(), attachment: { fileId: 'e'.repeat(24), originalName: 'x', mime: 'image/png', size: 1 } }); assert.strictEqual(m.text, ''); assert.strictEqual(m.attachment, null); });
t('messageDTO never exposes the stored file id or name', () => { const m = dto.messageDTO({ _id: 'b'.repeat(24), conversation: 'c'.repeat(24), sender: 'a'.repeat(24), text: 'hi', attachment: { fileId: 'e'.repeat(24), storedName: 'f'.repeat(32), originalName: 'x.png', mime: 'image/png', size: 1 } }); assert.ok(!JSON.stringify(m).includes('f'.repeat(32))); assert.ok(!JSON.stringify(m).includes('e'.repeat(24))); assert.ok(m.attachment && m.attachment.url.startsWith('/api/messages/')); });
t('messageDTO shows a file for both new (fileId) and old (storedName) messages', () => { for (const att of [{ fileId: 'e'.repeat(24) }, { storedName: 'f'.repeat(32) }]) { const m = dto.messageDTO({ _id: 'b'.repeat(24), conversation: 'c'.repeat(24), sender: 'a'.repeat(24), text: '', attachment: { ...att, originalName: 'x.png', mime: 'image/png', size: 1 } }); assert.ok(m.attachment); } });
t('messageDTO: no attachment object means no file', () => { assert.strictEqual(dto.messageDTO({ _id: 'b'.repeat(24), conversation: 'c'.repeat(24), sender: 'a'.repeat(24), text: 'hi' }).attachment, null); });

// ---------- Range header parsing (video seeking) ----------
const { parseRange } = require(path.resolve('utils/range.js'));
t('range: no header -> whole file', () => assert.strictEqual(parseRange(undefined, 100), null));
t('range: bytes=0-9 -> first 10 bytes', () => assert.deepStrictEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 }));
t('range: open end bytes=90- -> to the end', () => assert.deepStrictEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 }));
t('range: end beyond size is cut to the end', () => assert.deepStrictEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 }));
t('range: suffix bytes=-10 -> last 10 bytes', () => assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 }));
t('range: start beyond size -> invalid', () => assert.strictEqual(parseRange('bytes=999-1000', 100), 'invalid'));
t('range: start after end -> invalid', () => assert.strictEqual(parseRange('bytes=20-10', 100), 'invalid'));
t('range: zero-length suffix -> invalid', () => assert.strictEqual(parseRange('bytes=-0', 100), 'invalid'));
t('range: garbage and multi-range are ignored (whole file)', () => { assert.strictEqual(parseRange('lines=1-2', 100), null); assert.strictEqual(parseRange('bytes=0-1,5-6', 100), null); assert.strictEqual(parseRange('bytes=-', 100), null); });
t('range: huge numbers do not break it', () => assert.strictEqual(parseRange('bytes=99999999999999999999-', 100), 'invalid'));

// ---------- presence ----------
const presence = require(path.resolve('socket/presence.js'));
t('presence: online after first socket, offline after last', () => { assert.strictEqual(presence.add('u1'), true); assert.strictEqual(presence.add('u1'), false); assert.strictEqual(presence.remove('u1'), false); assert.strictEqual(presence.isOnline('u1'), true); assert.strictEqual(presence.remove('u1'), true); assert.strictEqual(presence.isOnline('u1'), false); });

// ---------- middleware/auth helpers (database and jwt libraries stubbed) ----------
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'jsonwebtoken') return { sign() {}, verify() {} };
  if (request.endsWith('models/User')) return { findById() {} };
  return origLoad.apply(this, arguments);
};
const auth = require(path.resolve('middleware/auth.js'));
Module._load = origLoad;

t('parseCookies parses normal cookies', () => assert.strictEqual(auth.parseCookies('a=1; chat_session=abc.def')['chat_session'], 'abc.def'));
t('parseCookies is safe against __proto__ cookie', () => { const c = auth.parseCookies('__proto__=x; a=1'); assert.strictEqual(Object.getPrototypeOf(c), null); });
t('parseCookies handles garbage', () => { assert.deepStrictEqual(Object.keys(auth.parseCookies(undefined)), []); assert.deepStrictEqual(Object.keys(auth.parseCookies('%%%=%')), ['%%%']); });
t('originAllowed: same host allowed', () => assert.strictEqual(auth.originAllowed('http://localhost:3000', 'localhost:3000'), true));
t('originAllowed: other website blocked', () => assert.strictEqual(auth.originAllowed('https://evil.com', 'localhost:3000'), false));
t('originAllowed: garbage origin blocked', () => assert.strictEqual(auth.originAllowed('null', 'localhost:3000'), false));

const run = (req) => { const out = { status: null, nextCalled: false }; const res = { status(s) { out.status = s; return this; }, json() { return this; } }; auth.csrfGuard({ method: req.method, get: (h) => req.headers[h.toLowerCase()] }, res, () => { out.nextCalled = true; }); return out; };
t('csrfGuard: GET passes', () => assert.strictEqual(run({ method: 'GET', headers: {} }).nextCalled, true));
t('csrfGuard: POST from evil origin -> 403', () => assert.strictEqual(run({ method: 'POST', headers: { origin: 'https://evil.com', host: 'localhost:3000', 'x-requested-with': 'chat-app' } }).status, 403));
t('csrfGuard: POST without custom header -> 403', () => assert.strictEqual(run({ method: 'POST', headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }).status, 403));
t('csrfGuard: legit POST passes', () => assert.strictEqual(run({ method: 'POST', headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'x-requested-with': 'chat-app' } }).nextCalled, true));
t('assertAuthConfig rejects missing/short secret', () => { delete process.env.JWT_SECRET; assert.throws(() => auth.assertAuthConfig()); process.env.JWT_SECRET = 'short'; assert.throws(() => auth.assertAuthConfig()); process.env.JWT_SECRET = 'x'.repeat(40); assert.doesNotThrow(() => auth.assertAuthConfig()); });

// ---------- STEP 5: phone numbers, privacy switches, receipts ----------
process.env.PHONE_HASH_KEY = 'k'.repeat(40);
const phone = require(path.resolve('utils/phone.js'));
const settingsLib = require(path.resolve('utils/settings.js'));

t('phone: "+251 91 122 3344" -> 251911223344', () => assert.strictEqual(phone.normalizePhone('+251 91 122 3344'), '251911223344'));
t('phone: local "0911223344" gets the default country code', () => assert.strictEqual(phone.normalizePhone('0911223344'), '251911223344'));
t('phone: "(0911) 223-344" and dots/spaces are cleaned', () => { assert.strictEqual(phone.normalizePhone('(0911) 223-344'), '251911223344'); assert.strictEqual(phone.normalizePhone('0911.223.344'), '251911223344'); });
t('phone: "00251911223344" and "251911223344" are the same number', () => { assert.strictEqual(phone.normalizePhone('00251911223344'), '251911223344'); assert.strictEqual(phone.normalizePhone('251911223344'), '251911223344'); });
t('phone: another country code is respected (+1 212 555 1234)', () => assert.strictEqual(phone.normalizePhone('+1 (212) 555-1234'), '12125551234'));
t('phone: the default country code can be changed', () => assert.strictEqual(phone.normalizePhone('0712345678', '254'), '254712345678'));
t('phone: garbage is rejected', () => { for (const bad of ['', 'abc', '12', '+0123456789012', '1234567', 'a0911223344', '0911223344'.repeat(5), null, undefined, 5, {}, ['0911223344']]) assert.strictEqual(phone.normalizePhone(bad), null, String(bad)); });
t('phone: every spelling of one number has the same fingerprint', () => { const h = phone.phoneHashOf('+251911223344'); assert.ok(/^[a-f0-9]{64}$/.test(h)); assert.strictEqual(phone.phoneHashOf('0911223344'), h); assert.strictEqual(phone.phoneHashOf('251 911 223 344'), h); });
t('phone: different numbers have different fingerprints', () => assert.notStrictEqual(phone.phoneHashOf('0911223344'), phone.phoneHashOf('0911223345')));
t('phone: the fingerprint depends on the secret key', () => { const a = phone.phoneHashOf('0911223344'); process.env.PHONE_HASH_KEY = 'z'.repeat(40); const b = phone.phoneHashOf('0911223344'); process.env.PHONE_HASH_KEY = 'k'.repeat(40); assert.notStrictEqual(a, b); });
t('phone: the fingerprint never contains the number', () => assert.ok(!phone.phoneHashOf('0911223344').includes('911223344')));
t('phone: an unusable number gives no fingerprint', () => assert.strictEqual(phone.phoneHashOf('hello'), null));

t('settings: missing values fall back to the defaults (old accounts)', () => assert.deepStrictEqual(settingsLib.normalizeSettings(undefined), { readReceipts: true, showOnline: true, showTyping: true, discoverableByPhone: true }));
t('settings: saved values are kept, other values are ignored', () => assert.deepStrictEqual(settingsLib.normalizeSettings({ readReceipts: false, showOnline: 'no', showTyping: 0, extra: 1 }), { readReceipts: false, showOnline: true, showTyping: true, discoverableByPhone: true }));
t('dto: the logged-in user gets their own settings, other people never do', () => { const u = { _id: 'a'.repeat(24), name: 'X', email: 'e@x.com', phone: '1', settings: { showTyping: false } }; assert.strictEqual(dto.userSelf(u).settings.showTyping, false); assert.strictEqual(dto.userSelf(u).settings.readReceipts, true); assert.ok(!('settings' in dto.userPublic(u))); });
t('dto: blue ticks are hidden when the reader turned receipts off', () => { const base = { _id: 'b'.repeat(24), conversation: 'c'.repeat(24), sender: 'a'.repeat(24), text: 'hi', readAt: new Date() }; assert.ok(dto.messageDTO({ ...base }).readAt); assert.strictEqual(dto.messageDTO({ ...base, readHidden: true }).readAt, null); assert.strictEqual(dto.messageDTO({ ...base, readAt: null }).readAt, null); });

// ---------- STEP 6: calls (rules, checks, network servers) and phone alerts ----------
const pending = []; // tests that must wait for something (async). They run one after the other.
let chain = Promise.resolve();
const ta = (name, fn) => {
  chain = chain.then(() => Promise.resolve().then(fn)).then(
    () => { pass++; console.log('PASS', name); },
    (e) => { fail++; console.log('FAIL', name, '->', String(e && e.message).split('\n')[0]); }
  );
  pending.push(chain);
};
const { CallManager } = require(path.resolve('socket/calls.js'));
const callVal = require(path.resolve('utils/callValidation.js'));
const callIce = require(path.resolve('utils/callIce.js'));
const pushPay = require(path.resolve('utils/pushPayload.js'));
const visib = require(path.resolve('socket/visibility.js'));
const nodeCrypto = require('crypto');

const A = 'alice', B = 'bob', C = 'carol';
function mkCalls(extra = {}) {
  const sent = [], timers = [], notes = [];
  let n = 0;
  const mgr = new CallManager({
    emitToUser: (u, ev, p, except) => sent.push({ u, ev, p, except }),
    notify: (e) => notes.push(e),
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (id) => { if (timers[id]) timers[id].cleared = true; },
    newId: () => 'a'.repeat(31) + String(++n % 10),
    ...extra
  });
  return { mgr, sent, timers, notes };
}
const fire = (timers, i) => { if (!timers[i].cleared) timers[i].fn(); };
const startAB = (m, o = {}) => m.mgr.start({ callerId: A, calleeId: B, conversationId: 'c1', kind: 'audio', offer: 'v=0 offer', socketId: 's-a', ...o });
const other = (callerId, calleeId, conv) => ({ callerId, calleeId, conversationId: conv, kind: 'audio', offer: 'v=0 x' });

t('calls: starting a call rings ONLY the callee, with exactly the expected fields', () => {
  const m = mkCalls(); const r = startAB(m);
  assert.ok(r.ok); assert.strictEqual(m.sent.length, 1);
  const e = m.sent[0];
  assert.strictEqual(e.u, B); assert.strictEqual(e.ev, 'call:incoming');
  assert.deepStrictEqual(Object.keys(e.p).sort(), ['callId', 'conversationId', 'from', 'kind', 'offer']);
  assert.strictEqual(e.p.from, A); assert.strictEqual(e.p.offer, 'v=0 offer'); assert.match(e.p.callId, /^[a-f0-9]{32}$/);
  assert.strictEqual(m.notes[0].type, 'ringing'); assert.strictEqual(m.timers[0].ms, 45000);
});
t('calls: one call at a time per person (busy, already in a call, no calling yourself)', () => {
  const m = mkCalls(); startAB(m);
  assert.strictEqual(m.mgr.start(other(C, B, 'c2')).error, 'busy');
  assert.strictEqual(m.mgr.start(other(A, C, 'c3')).error, 'already_in_call');
  assert.strictEqual(m.mgr.start(other(B, C, 'c4')).error, 'already_in_call');
  assert.strictEqual(m.mgr.start(other(C, C, 'c5')).error, 'invalid');
  assert.strictEqual(m.mgr.start(other('', B, 'c6')).error, 'invalid');
});
t('calls: only the person who was called can accept; the caller hears the answer; other devices stop ringing', () => {
  const m = mkCalls(); const id = startAB(m).call.id; m.sent.length = 0;
  assert.strictEqual(m.mgr.accept({ userId: A, callId: id, answer: 'v=0 a' }).error, 'forbidden');
  assert.strictEqual(m.mgr.accept({ userId: C, callId: id, answer: 'v=0 a' }).error, 'forbidden');
  assert.strictEqual(m.mgr.accept({ userId: B, callId: 'f'.repeat(32), answer: 'v=0 a' }).error, 'not_found');
  assert.strictEqual(m.sent.length, 0, 'failed attempts send nothing');
  assert.ok(m.mgr.accept({ userId: B, callId: id, answer: 'v=0 ans', socketId: 's-b1' }).ok);
  const acc = m.sent.find((e) => e.ev === 'call:accepted');
  assert.strictEqual(acc.u, A); assert.deepStrictEqual(Object.keys(acc.p).sort(), ['answer', 'callId']);
  const end = m.sent.find((e) => e.ev === 'call:ended');
  assert.strictEqual(end.u, B); assert.strictEqual(end.p.reason, 'answered_elsewhere'); assert.strictEqual(end.except, 's-b1');
  assert.ok(m.timers[0].cleared, 'the ring timer is cancelled');
  assert.strictEqual(m.mgr.accept({ userId: B, callId: id, answer: 'v=0 ans' }).error, 'not_ringing');
});
t('calls: declining informs the caller, frees both people and stops other devices', () => {
  const m = mkCalls(); const id = startAB(m).call.id; m.sent.length = 0;
  assert.strictEqual(m.mgr.reject({ userId: A, callId: id }).error, 'forbidden');
  assert.ok(m.mgr.reject({ userId: B, callId: id, socketId: 's-b1' }).ok);
  assert.ok(m.sent.some((e) => e.u === A && e.ev === 'call:ended' && e.p.reason === 'rejected'));
  assert.ok(m.sent.some((e) => e.u === B && e.p.reason === 'rejected_elsewhere' && e.except === 's-b1'));
  assert.ok(startAB(m).ok, 'free to call again');
});
t('calls: hanging up (ringing = cancelled + missed call; in progress = ends for the other person); strangers cannot', () => {
  let m = mkCalls(); let id = startAB(m).call.id; m.sent.length = 0;
  assert.strictEqual(m.mgr.hangup({ userId: C, callId: id }).error, 'forbidden');
  assert.ok(m.mgr.hangup({ userId: A, callId: id }).ok);
  assert.ok(m.sent.some((e) => e.u === B && e.p.reason === 'cancelled')); assert.ok(m.notes.some((n) => n.type === 'missed'));
  assert.strictEqual(m.mgr.hangup({ userId: A, callId: id }).error, 'not_found');

  m = mkCalls(); id = startAB(m).call.id; m.mgr.accept({ userId: B, callId: id, answer: 'v=0 a' }); m.sent.length = 0;
  assert.ok(m.mgr.hangup({ userId: B, callId: id }).ok);
  assert.deepStrictEqual(m.sent.map((e) => [e.u, e.ev, e.p.reason]), [[A, 'call:ended', 'hangup']]);
  assert.ok(!m.notes.some((n) => n.type === 'missed'));

  m = mkCalls(); id = startAB(m).call.id; m.sent.length = 0;
  assert.ok(m.mgr.hangup({ userId: B, callId: id }).ok, 'the callee hanging up while it rings = decline');
  assert.ok(m.sent.some((e) => e.u === A && e.p.reason === 'rejected'));
});
t('calls: network candidates go to the OTHER person only; strangers cannot send; the number is limited', () => {
  const m = mkCalls(); const id = startAB(m).call.id; m.sent.length = 0;
  assert.ok(m.mgr.ice({ userId: A, callId: id, candidate: { candidate: 'candidate:1' } }).ok);
  assert.deepStrictEqual(m.sent.map((e) => [e.u, e.ev]), [[B, 'call:ice']]);
  assert.strictEqual(m.mgr.ice({ userId: C, callId: id, candidate: {} }).error, 'forbidden');
  assert.strictEqual(m.mgr.ice({ userId: A, callId: 'f'.repeat(32), candidate: {} }).error, 'not_found');
  assert.strictEqual(m.sent.length, 1);
  for (let i = 0; i < 100; i++) assert.ok(m.mgr.ice({ userId: B, callId: id, candidate: { candidate: 'candidate:x' } }).ok);
  assert.strictEqual(m.mgr.ice({ userId: B, callId: id, candidate: { candidate: 'candidate:x' } }).error, 'too_many');
});
t("calls: the caller's candidates are kept while ringing so a late callee gets them; nothing is kept after answering", () => {
  const m = mkCalls(); const id = startAB(m).call.id;
  m.mgr.ice({ userId: A, callId: id, candidate: { candidate: 'candidate:1' } }); m.mgr.ice({ userId: B, callId: id, candidate: { candidate: 'candidate:2' } });
  const p = m.mgr.pendingFor(B);
  assert.deepStrictEqual(Object.keys(p).sort(), ['callId', 'conversationId', 'from', 'ice', 'kind', 'offer']);
  assert.strictEqual(p.ice.length, 1); assert.strictEqual(m.mgr.pendingFor(A), null, 'the caller has nothing pending');
  m.mgr.accept({ userId: B, callId: id, answer: 'v=0 a' }); assert.strictEqual(m.mgr.pendingFor(B), null);
});
t('calls: an unanswered call times out for both people and counts as missed; an answered call never times out', () => {
  let m = mkCalls(); startAB(m); m.sent.length = 0; fire(m.timers, 0);
  assert.deepStrictEqual(m.sent.map((e) => [e.u, e.p.reason]).sort(), [[A, 'timeout'], [B, 'timeout']]);
  assert.ok(m.notes.some((n) => n.type === 'missed')); assert.ok(startAB(m).ok, 'free again');
  m = mkCalls(); const id = startAB(m).call.id; m.mgr.accept({ userId: B, callId: id, answer: 'v=0 a' }); m.sent.length = 0; fire(m.timers, 0);
  assert.strictEqual(m.sent.length, 0); assert.ok(m.mgr.get(id));
});
t('calls: a caller who goes offline while ringing cancels; a callee who goes offline can still pick up later', () => {
  const m = mkCalls(); startAB(m); m.sent.length = 0; m.mgr.userGone(B);
  assert.strictEqual(m.sent.length, 0); assert.ok(m.mgr.pendingFor(B));
  m.mgr.userGone(A);
  assert.ok(m.sent.some((e) => e.u === B && e.p.reason === 'cancelled')); assert.ok(m.notes.some((n) => n.type === 'missed')); assert.ok(startAB(m).ok);
});
t('calls: a call in progress survives a short loss of connection and ends after the grace time', () => {
  const m = mkCalls({ graceMs: 20000 }); const id = startAB(m).call.id; m.mgr.accept({ userId: B, callId: id, answer: 'v=0 a' }); m.sent.length = 0;
  m.mgr.userGone(A); m.mgr.userGone(A);
  const grace = m.timers.filter((x) => x.ms === 20000); assert.strictEqual(grace.length, 1, 'one grace timer only');
  m.mgr.userBack(A); assert.ok(grace[0].cleared); fire(m.timers, m.timers.indexOf(grace[0])); assert.strictEqual(m.sent.length, 0);
  m.mgr.userGone(A); m.timers[m.timers.length - 1].fn();
  assert.deepStrictEqual(m.sent.map((e) => [e.u, e.p.reason]), [[B, 'disconnected']]); assert.strictEqual(m.mgr.get(id), undefined);
});
t('calls: a person with no call is not affected by userGone / userBack / pendingFor', () => {
  const m = mkCalls(); m.mgr.userGone(A); m.mgr.userBack(A); assert.strictEqual(m.mgr.pendingFor(A), null); assert.strictEqual(m.sent.length, 0);
});

t('call checks: ids and kinds', () => {
  assert.ok(callVal.isCallId('a'.repeat(32))); for (const bad of ['A'.repeat(32), 'a'.repeat(31), 'g'.repeat(32), '', null, 5, {}]) assert.ok(!callVal.isCallId(bad), String(bad));
  assert.ok(callVal.isCallKind('audio') && callVal.isCallKind('video')); for (const bad of ['voice', 'AUDIO', '', null, ['audio']]) assert.ok(!callVal.isCallKind(bad));
});
t('call checks: session text must start with v=0 and have a sane size', () => {
  assert.ok(callVal.validSdp('v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'));
  for (const bad of ['', 'v=0', 'x'.repeat(30), 'v=0 ' + 'x'.repeat(20001), null, 5, {}, ['v=0 aaaaaaaaaaaaaaaaaaaaaa']]) assert.ok(!callVal.validSdp(bad));
});
t('call checks: a network candidate is cleaned to its 4 fields; bad ones are refused', () => {
  const ok = callVal.cleanCandidate({ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ab', evil: 'x', __proto__: { polluted: 1 } });
  assert.deepStrictEqual(Object.keys(ok).sort(), ['candidate', 'sdpMLineIndex', 'sdpMid', 'usernameFragment']);
  assert.deepStrictEqual(callVal.cleanCandidate({ candidate: 'candidate:1' }), { candidate: 'candidate:1', sdpMid: null, sdpMLineIndex: null, usernameFragment: null });
  const bads = [null, 'x', [], {}, { candidate: '' }, { candidate: 'nope' }, { candidate: 'candidate:' + 'x'.repeat(2000) }, { candidate: 'candidate:1', sdpMid: 5 }, { candidate: 'candidate:1', sdpMid: 'x'.repeat(65) },
    { candidate: 'candidate:1', sdpMLineIndex: -1 }, { candidate: 'candidate:1', sdpMLineIndex: 11 }, { candidate: 'candidate:1', sdpMLineIndex: 1.5 }, { candidate: 'candidate:1', sdpMLineIndex: '0' }, { candidate: 'candidate:1', usernameFragment: {} }, { candidate: { $ne: 1 } }];
  for (const bad of bads) assert.strictEqual(callVal.cleanCandidate(bad), null, JSON.stringify(bad));
});
t('visibility: a person counts as "looking" while at least one connection is visible', () => {
  visib.set('u1', 's1', true); visib.set('u1', 's2', true); assert.ok(visib.hasVisible('u1'));
  visib.set('u1', 's1', false); assert.ok(visib.hasVisible('u1')); visib.clear('s2'); assert.ok(!visib.hasVisible('u1'));
  visib.clear('unknown'); assert.ok(!visib.hasVisible('nobody'));
});

ta('ice: with nothing set up only public STUN is returned', async () => {
  callIce.resetCache(); const r = await callIce.buildIceServers({ userId: 'u1', env: {} });
  assert.strictEqual(r.hasTurn, false); assert.strictEqual(r.iceServers.length, 1); assert.ok(r.iceServers[0].urls.every((u) => u.startsWith('stun:')));
  const own = await callIce.buildIceServers({ userId: 'u1', env: { STUN_URLS: 'stun:a.example:3478, stun:b.example:3478' } });
  assert.deepStrictEqual(own.iceServers[0].urls, ['stun:a.example:3478', 'stun:b.example:3478']);
});
ta('ice: a fixed username and password (for example Metered Open Relay)', async () => {
  const r = await callIce.buildIceServers({ userId: 'u1', env: { TURN_URLS: 'turn:r.example:80,turns:r.example:443?transport=tcp', TURN_USERNAME: 'user', TURN_CREDENTIAL: 'pass' } });
  assert.strictEqual(r.hasTurn, true); assert.deepStrictEqual(r.iceServers[1], { urls: ['turn:r.example:80', 'turns:r.example:443?transport=tcp'], username: 'user', credential: 'pass' });
  const half = await callIce.buildIceServers({ userId: 'u1', env: { TURN_URLS: 'turn:r.example:80', TURN_USERNAME: 'user' } });
  assert.strictEqual(half.hasTurn, false, 'an incomplete setup is ignored');
});
ta('ice: your own coturn server gets a short-lived password made from the shared secret', async () => {
  const env = { TURN_URLS: 'turn:t.example:3478?transport=udp,turns:t.example:5349?transport=tcp', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: '3600' };
  const r = await callIce.buildIceServers({ userId: 'u1', env, now: () => 1700000000000 });
  const turn = r.iceServers[1];
  assert.strictEqual(turn.username, `${1700000000 + 3600}:u1`);
  assert.strictEqual(turn.credential, nodeCrypto.createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
  assert.strictEqual(turn.urls.length, 2); assert.strictEqual(r.hasTurn, true); assert.ok(!JSON.stringify(r).includes('s3cret'), 'the secret itself is never sent');
  const short = await callIce.buildIceServers({ userId: 'u1', env: { ...env, TURN_TTL_SECONDS: '5' }, now: () => 1700000000000 });
  assert.strictEqual(short.iceServers[1].username, `${1700000000 + 300}:u1`, 'the lifetime is at least 5 minutes');
});
ta('ice: Cloudflare TURN: the API is called once and the answer is reused for 10 minutes', async () => {
  callIce.resetCache(); let calls = 0, seen;
  const fetchImpl = async (url, opts) => { calls++; seen = { url, opts }; return { ok: true, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'cfuser', credential: 'cfpass', extra: 'x' }, { urls: 'http://evil.example' }, null] }) }; };
  const env = { CF_TURN_KEY_ID: 'key123', CF_TURN_API_TOKEN: 'tok-secret' }; let now = 1000000; const nowFn = () => now;
  const r = await callIce.buildIceServers({ userId: 'u', env, now: nowFn, fetchImpl });
  assert.strictEqual(seen.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
  assert.strictEqual(seen.opts.method, 'POST'); assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok-secret'); assert.strictEqual(JSON.parse(seen.opts.body).ttl, 3600);
  assert.strictEqual(r.hasTurn, true); assert.strictEqual(r.iceServers.length, 2, 'bad entries are dropped'); assert.strictEqual(r.iceServers[1].username, 'cfuser'); assert.ok(!('extra' in r.iceServers[1]));
  assert.ok(!JSON.stringify(r).includes('tok-secret'), 'the API token is never sent to the browser');
  await callIce.buildIceServers({ userId: 'u', env, now: nowFn, fetchImpl }); assert.strictEqual(calls, 1, 'reused');
  now += 11 * 60 * 1000; await callIce.buildIceServers({ userId: 'u', env, now: nowFn, fetchImpl }); assert.strictEqual(calls, 2, 'asked again after 10 minutes');
});
ta('ice: if Cloudflare fails or answers badly, calls fall back to STUN only', async () => {
  for (const fetchImpl of [async () => ({ ok: false }), async () => { throw new Error('down'); }, async () => ({ ok: true, json: async () => ({ nonsense: 1 }) })]) {
    callIce.resetCache();
    const r = await callIce.buildIceServers({ userId: 'u', env: { CF_TURN_KEY_ID: 'k', CF_TURN_API_TOKEN: 't' }, fetchImpl });
    assert.strictEqual(r.hasTurn, false); assert.strictEqual(r.iceServers.length, 1);
  }
});
ta('ice: Cloudflare settings win over the others', async () => {
  callIce.resetCache();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ iceServers: { urls: ['turn:cf.example'], username: 'a', credential: 'b' } }) });
  const r = await callIce.buildIceServers({ userId: 'u', env: { CF_TURN_KEY_ID: 'k', CF_TURN_API_TOKEN: 't', TURN_URLS: 'turn:own.example', TURN_USERNAME: 'x', TURN_CREDENTIAL: 'y' }, fetchImpl });
  assert.strictEqual(r.iceServers[1].urls, 'turn:cf.example'); assert.strictEqual(r.iceServers.length, 2);
});

t('alerts: only the real browser push services are accepted (the server can never be sent to another address)', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/Qabc', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(pushPay.isAllowedEndpoint(ok, ''), ok);
  const bad = ['http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x',
    'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'javascript:alert(1)', 'ftp://fcm.googleapis.com/x', '', 'not a url', 'https://example.com/x', 'https://notfcm.googleapis.com/x', null, 5, {}, 'https://fcm.googleapis.com/' + 'a'.repeat(700)];
  for (const b of bad) assert.ok(!pushPay.isAllowedEndpoint(b, ''), String(b).slice(0, 60));
  assert.ok(pushPay.isAllowedEndpoint('https://push.mycompany.example/x', 'push.mycompany.example'), 'a host you added yourself');
  assert.ok(!pushPay.isAllowedEndpoint('https://other.mycompany.example/x', 'push.mycompany.example'));
});
t('alerts: a message alert never contains the text when the device chose "no preview"', () => {
  const base = { senderName: 'Alice', text: 'my secret plan', attachmentName: '', conversationId: 'a'.repeat(24) };
  const on = pushPay.messagePayload({ ...base, preview: true }), off = pushPay.messagePayload({ ...base, preview: false });
  assert.strictEqual(on.body, 'my secret plan'); assert.strictEqual(off.body, 'New message'); assert.ok(!JSON.stringify(off).includes('secret'));
  assert.strictEqual(on.title, 'Alice'); assert.strictEqual(on.type, 'message'); assert.strictEqual(on.tag, 'conv-' + 'a'.repeat(24)); assert.strictEqual(on.url, '/?c=' + 'a'.repeat(24));
  assert.deepStrictEqual(Object.keys(on).sort(), ['body', 'conversationId', 'tag', 'title', 'type', 'url']);
});
t('alerts: long text is shortened, a file shows its name, strange ids are not put in the address', () => {
  const long = pushPay.messagePayload({ senderName: 'A\nB  C', text: 'x'.repeat(500), conversationId: 'a'.repeat(24), preview: true });
  assert.ok(long.body.length <= 140); assert.ok(long.body.endsWith('…')); assert.strictEqual(long.title, 'A B C');
  assert.strictEqual(pushPay.messagePayload({ senderName: 'A', text: '', attachmentName: 'photo.png', conversationId: 'a'.repeat(24), preview: true }).body, '📎 photo.png');
  const odd = pushPay.messagePayload({ senderName: '', text: 'hi', conversationId: '../../x', preview: true });
  assert.strictEqual(odd.url, '/'); assert.strictEqual(odd.tag, 'chat'); assert.strictEqual(odd.conversationId, ''); assert.strictEqual(odd.title, 'New message');
});
t('alerts: call alerts: ringing and missed share one tag, so "missed" replaces "ringing"', () => {
  const ring = pushPay.callPayload({ callerName: 'Alice', kind: 'video', callId: 'b'.repeat(32), conversationId: 'a'.repeat(24) });
  const miss = pushPay.missedCallPayload({ callerName: 'Alice', kind: 'video', conversationId: 'a'.repeat(24) });
  assert.strictEqual(ring.type, 'call'); assert.strictEqual(ring.body, 'Incoming video call'); assert.strictEqual(ring.callId, 'b'.repeat(32));
  assert.strictEqual(miss.type, 'missed'); assert.strictEqual(miss.body, 'Missed video call'); assert.strictEqual(ring.tag, miss.tag);
  assert.strictEqual(pushPay.callPayload({ callerName: 'A', kind: 'audio', callId: 'zz', conversationId: 'a'.repeat(24) }).callId, '');
  assert.strictEqual(pushPay.callPayload({ callerName: 'A', kind: 'audio', callId: 'b'.repeat(32), conversationId: 'a'.repeat(24) }).body, 'Incoming audio call');
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
