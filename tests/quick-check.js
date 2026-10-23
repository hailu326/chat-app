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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
