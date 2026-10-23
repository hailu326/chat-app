'use strict';
// Runs public/main.js against a tiny FAKE page and clicks through the new features.
// No browser and no packages needed:  node tests/ui-smoke.js
// It proves the script runs without errors and calls the right server addresses.
// It does NOT prove how things look or feel in a real browser or phone.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let pass = 0, fail = 0;
const results = [];
const test = (name, fn) => results.push({ name, fn });

// ---------------------------------------------------------------- fake page
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tag = tag; this.id = id; this.attrs = {}; this.children = []; this.listeners = {};
    this.style = { setProperty() {}, display: '' }; this.className = ''; this._text = '';
    this.value = ''; this.checked = false; this.src = ''; this.alt = ''; this.disabled = false; this.dataset = {};
    this.scrollHeight = 0; this.scrollTop = 0; this.placeholder = '';
    const set = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c), toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; want ? set.add(c) : set.delete(c); return want; }
    };
    this.played = 0; this.clicked = 0;
  }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...kids) { kids.forEach((k) => this.children.push(k)); }
  replaceChildren(...kids) { this.children = kids; this._text = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, extra = {}) { (this.listeners[t] || []).forEach((fn) => fn({ target: this, preventDefault() {}, ...extra })); }
  click() { this.clicked += 1; this.dispatch('click'); }
  remove() {} focus() {} scrollTo() {} reset() {} play() { this.played += 1; return Promise.resolve(); }
  querySelector() { return null; }
  find(pred) { const out = []; const walk = (n) => { if (typeof n === 'string') return; if (pred(n)) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
}

function makeEnv() {
  const store = {};
  const byId = (id) => store[id] || (store[id] = new FakeEl('div', id));
  const els = new Proxy(store, { get: (t, k) => (typeof k === 'string' ? byId(k) : t[k]) });
  const named = { container: new FakeEl(), main: new FakeEl(), send: new FakeEl('button'), viewport: new FakeEl('meta') };
  const calls = [];
  const docListeners = {}, winListeners = {};
  const fetchQueue = [];
  const env = {
    calls, els, named, docListeners, winListeners, fetchQueue, notifications: [], created: [],
    storage: {},
    document: {
      hidden: false, body: new FakeEl('body'), documentElement: new FakeEl('html'),
      getElementById: byId,
      querySelector: (sel) => (sel === '.container' ? named.container : sel === '.main' ? named.main : sel === '.send-button' ? named.send : sel === 'meta[name="viewport"]' ? named.viewport : null),
      createElement: (t) => { const e = new FakeEl(t); env.created.push(e); return e; },
      addEventListener: (t, fn) => (docListeners[t] = docListeners[t] || []).push(fn)
    }
  };
  env.window = {
    addEventListener: (t, fn) => (winListeners[t] = winListeners[t] || []).push(fn),
    confirm: () => true, prompt: () => null, location: { reload() { env.reloaded = true; } }
  };
  env.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    const r = fetchQueue.length
      ? fetchQueue.shift()
      : url === '/api/auth/me'
        ? { status: 401, ok: false, json: { error: 'Authentication required' } }
        : { json: { conversations: [], messages: [], hasMore: false, matches: [], settings: {}, ok: true } };
    return { ok: r.ok !== false && (r.status || 200) < 400, status: r.status || 200, json: async () => r.json, blob: async () => r.blob || { size: 1 } };
  };
  return env;
}

function load(env, extraGlobals = {}) {
  const sandbox = {
    document: env.document, window: env.window, console, setTimeout, clearTimeout, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    localStorage: { getItem: (k) => env.storage[k] || null, setItem: (k, v) => { env.storage[k] = String(v); } },
    navigator: {}, fetch: env.fetch, FormData: class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } },
    FileReader: class {}, Image: class {}, Date, Promise, Notification: class { constructor(t, o) { env.notifications.push([t, o]); } static get permission() { return env.permission || 'granted'; } static requestPermission() { return Promise.resolve(env.permission || 'granted'); } },
    io: () => ({ on() {}, connect() {}, disconnect() {}, emit() {}, connected: true }), ...extraGlobals
  };
  sandbox.window.Notification = sandbox.Notification;
  if (extraGlobals.ContactsManager) sandbox.window.ContactsManager = extraGlobals.ContactsManager;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8'), ctx, { filename: 'main.js' });
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
const tick = () => new Promise((r) => setTimeout(r, 5));
const USER = { id: 'u1', name: 'Me', email: 'm@x.com', phone: '', avatarUrl: '/a', settings: { readReceipts: true, showOnline: true, showTyping: true, discoverableByPhone: true } };

// ---------------------------------------------------------------- tests
test('the script loads without errors; a visitor who is not logged in sees the login page and the page stays zoomable', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  assert.ok(!env.named.viewport.attrs.content.includes('maximum-scale'), 'login page must be zoomable');
  assert.strictEqual(env.els['login-page'].style.display, 'block');
});

test('after login the zoom is locked; after logout it is unlocked again', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`);
  assert.match(env.named.viewport.attrs.content, /maximum-scale=1, user-scalable=no/);
  assert.ok(env.document.documentElement.classList.contains('zoom-locked'));
  run(ctx, 'handleLoggedOut()');
  assert.ok(!env.named.viewport.attrs.content.includes('maximum-scale'));
  assert.ok(!env.document.documentElement.classList.contains('zoom-locked'));
});

test('"Allow pinch zoom" removes the lock and is remembered on this device', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`);
  env.els['settings-btn'].click();
  const box = env.els['set-allow-zoom']; box.checked = true; box.dispatch('change');
  assert.ok(!env.named.viewport.attrs.content.includes('maximum-scale'));
  assert.strictEqual(JSON.parse(env.storage['chat-device-settings']).allowZoom, true);
  // a new page load remembers it
  const env2 = makeEnv(); env2.storage = env.storage; const ctx2 = load(env2); await tick();
  run(ctx2, `enterApp(${JSON.stringify(USER)})`);
  assert.ok(!env2.named.viewport.attrs.content.includes('maximum-scale'));
});

test('ctrl + mouse-wheel zoom is blocked inside the chat but not when allowed or logged out', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  const wheel = env.winListeners.wheel[0];
  let blocked = 0; const ev = { ctrlKey: true, preventDefault() { blocked += 1; } };
  wheel(ev); assert.strictEqual(blocked, 0, 'logged out: not blocked');
  run(ctx, `enterApp(${JSON.stringify(USER)})`); wheel(ev); assert.strictEqual(blocked, 1, 'in the chat: blocked');
  wheel({ ctrlKey: false, preventDefault() { blocked += 1; } }); assert.strictEqual(blocked, 1, 'plain scrolling is never blocked');
  env.docListeners.gesturestart[0]({ preventDefault() { blocked += 1; } }); assert.strictEqual(blocked, 2, 'Safari pinch gesture blocked');
});

test('Settings opens only when logged in, and shows the saved values', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  env.els['settings-btn'].click();
  assert.ok(!env.els['settings-panel'].classList.contains('show'), 'closed when logged out');
  run(ctx, `enterApp(${JSON.stringify({ ...USER, settings: { readReceipts: false, showOnline: true, showTyping: false, discoverableByPhone: true } })})`);
  env.els['settings-btn'].click();
  assert.ok(env.els['settings-panel'].classList.contains('show'));
  assert.strictEqual(env.els['set-readReceipts'].checked, false);
  assert.strictEqual(env.els['set-showTyping'].checked, false);
  assert.strictEqual(env.els['set-showOnline'].checked, true);
  assert.strictEqual(env.els['set-text-size'].value, '15');
  assert.match(env.els['about-text'].textContent, /HAILACHO Chat · version/);
  env.els['settings-close'].click();
  assert.ok(!env.els['settings-panel'].classList.contains('show'));
});

test('a privacy switch is saved on the server with PATCH /api/settings and the right body', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`); env.calls.length = 0;
  env.fetchQueue.push({ json: { settings: { readReceipts: false, showOnline: true, showTyping: true, discoverableByPhone: true } } });
  const box = env.els['set-readReceipts']; box.checked = false; box.dispatch('change'); await tick();
  const call = env.calls.find((c) => c.url === '/api/settings');
  assert.ok(call, 'no settings request'); assert.strictEqual(call.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(call.body), { readReceipts: false });
  assert.strictEqual(call.headers['X-Requested-With'], 'chat-app');
  assert.strictEqual(run(ctx, 'me.settings.readReceipts'), false);
});

test('if saving a privacy switch fails, the switch jumps back', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`);
  env.fetchQueue.push({ status: 500, ok: false, json: { error: 'Server error' } });
  const box = env.els['set-showTyping']; box.checked = false; box.dispatch('change'); await tick();
  assert.strictEqual(box.checked, true);
});

test('device switches work without the server: sound, preview, text size, background', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`); env.calls.length = 0;
  env.els['set-sound'].checked = false; env.els['set-sound'].dispatch('change');
  env.els['set-pattern'].checked = false; env.els['set-pattern'].dispatch('change');
  env.els['set-text-size'].value = '19'; env.els['set-text-size'].dispatch('change');
  env.els['set-text-size'].value = '999'; env.els['set-text-size'].dispatch('change'); // ignored
  const saved = JSON.parse(env.storage['chat-device-settings']);
  assert.strictEqual(saved.sound, false); assert.strictEqual(saved.pattern, false); assert.strictEqual(saved.textSize, 19);
  assert.ok(env.named.main.classList.contains('plain'));
  assert.strictEqual(env.calls.length, 0, 'device settings must not call the server');
});

test('bad data in localStorage cannot break the app', async () => {
  const env = makeEnv(); env.storage['chat-device-settings'] = '{"textSize":"huge","sound":"no","allowZoom":1}';
  const ctx = load(env); await tick();
  assert.strictEqual(run(ctx, 'deviceSettings.textSize'), 15);
  assert.strictEqual(run(ctx, 'deviceSettings.sound'), true);
  const env2 = makeEnv(); env2.storage['chat-device-settings'] = 'not json{{';
  load(env2); // must not throw
});

test('sound, notification text and the notification switch follow the device settings', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`);
  run(ctx, `conversations = [{ id: 'c1', partner: { id: 'p', name: 'Bob', avatarUrl: '' }, online: false, unread: 0, lastMessage: null, lastMessageAt: new Date().toISOString() }]`);
  const msg = (t) => `({ id: 'm${Math.random()}', conversationId: 'c1', senderId: 'p', text: '${t}', deleted: false, edited: false, attachment: null, createdAt: new Date().toISOString(), readAt: null })`;
  env.document.hidden = true; const tone = env.els['message-tone'];
  await run(ctx, `onIncomingMessage(${msg('secret words')})`);
  assert.strictEqual(tone.played, 1); assert.strictEqual(env.notifications.at(-1)[1].body, 'secret words');
  run(ctx, 'deviceSettings.preview = false; deviceSettings.sound = false');
  await run(ctx, `onIncomingMessage(${msg('more secrets')})`);
  assert.strictEqual(tone.played, 1, 'no sound'); assert.strictEqual(env.notifications.at(-1)[1].body, 'New message');
  run(ctx, 'deviceSettings.notify = false'); const before = env.notifications.length;
  await run(ctx, `onIncomingMessage(${msg('third')})`);
  assert.strictEqual(env.notifications.length, before, 'notifications off');
});

test('Contacts: without a phone contact picker the "type numbers" box is shown and numbers (not names) are sent', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`); env.calls.length = 0;
  env.els['contacts-btn'].click();
  assert.ok(env.els['contacts-panel'].classList.contains('show'));
  assert.strictEqual(env.els['pick-contacts-btn'].style.display, 'none');
  assert.match(env.els['contacts-support'].textContent, /Type phone numbers/);
  env.els['contacts-manual'].value = '0911223344\n+251 92 233 4455, abc';
  env.fetchQueue.push({ json: { matches: [{ user: { id: 'u9', name: 'Alice', avatarUrl: '/x' }, indexes: [0] }], checked: 2, invalid: 1 } });
  env.els['contacts-find-btn'].click(); await tick();
  const call = env.calls.find((c) => c.url === '/api/contacts/match');
  assert.strictEqual(call.method, 'POST');
  assert.deepStrictEqual(JSON.parse(call.body), { phones: ['0911223344', '+251 92 233 4455', 'abc'] });
  const items = env.els['contacts-results'].children;
  assert.strictEqual(items.length, 2, 'one match + one note about invalid numbers');
  assert.match(items[0].textContent, /Alice/); assert.match(items[1].textContent, /1 item\(s\) were not valid/);
});

test('Contacts: with the phone picker, only the chosen contacts are used and their names stay on the device', async () => {
  const env = makeEnv();
  const ctx = load(env, { ContactsManager: function () {}, navigator: { contacts: { select: async (props, opts) => { assert.strictEqual(JSON.stringify(props), '["name","tel"]'); assert.strictEqual(opts.multiple, true); return [{ name: ['Mom'], tel: ['+251911223344', '0911000000'] }, { name: [], tel: [] }]; } } } });
  await tick(); run(ctx, `enterApp(${JSON.stringify(USER)})`); env.calls.length = 0;
  env.els['contacts-btn'].click();
  assert.strictEqual(env.els['pick-contacts-btn'].style.display, 'block');
  env.fetchQueue.push({ json: { matches: [{ user: { id: 'u9', name: 'Alice A', avatarUrl: '/x' }, indexes: [0] }], checked: 2, invalid: 0 } });
  env.els['pick-contacts-btn'].click(); await tick(); await tick();
  const call = env.calls.find((c) => c.url === '/api/contacts/match');
  assert.deepStrictEqual(JSON.parse(call.body), { phones: ['+251911223344', '0911000000'] });
  assert.ok(!call.body.includes('Mom'), 'names must never be sent');
  assert.match(env.els['contacts-results'].children[0].textContent, /In your contacts: Mom/);
});

test('Contacts: choosing a match opens a chat with that person; cancelling the picker shows no error', async () => {
  const env = makeEnv();
  const ctx = load(env, { ContactsManager: function () {}, navigator: { contacts: { select: async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; } } } });
  await tick(); run(ctx, `enterApp(${JSON.stringify(USER)})`);
  env.els['contacts-btn'].click(); env.els['pick-contacts-btn'].click(); await tick(); await tick();
  assert.strictEqual(env.els['contacts-error'].textContent, '');
  env.els['contacts-manual'].value = '0911223344'; env.calls.length = 0;
  env.fetchQueue.push({ json: { matches: [{ user: { id: 'u9', name: 'Alice', avatarUrl: '/x' }, indexes: [0] }], checked: 1, invalid: 0 } });
  env.fetchQueue.push({ json: { conversation: { id: 'c9', partner: { id: 'u9', name: 'Alice', avatarUrl: '/x' }, online: false, unread: 0, lastMessage: null, lastMessageAt: new Date().toISOString() } } });
  env.fetchQueue.push({ json: { messages: [], hasMore: false } }); env.fetchQueue.push({ json: { ok: true } });
  env.els['contacts-find-btn'].click(); await tick();
  env.els['contacts-results'].children[0].dispatch('click'); await tick(); await tick();
  assert.ok(env.calls.some((c) => c.url === '/api/conversations' && c.method === 'POST' && JSON.parse(c.body).userId === 'u9'));
  assert.ok(!env.els['contacts-panel'].classList.contains('show'), 'panel closes');
});

test('every attachment type gets a Download button, and the picture opens the viewer', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  const att = (mime, name) => `({ attachment: { name: '${name}', mime: '${mime}', size: 2048, url: '/api/messages/m1/attachment' } })`;
  for (const [mime, name] of [['image/png', 'a.png'], ['video/mp4', 'v.mp4'], ['audio/mpeg', 's.mp3'], ['application/pdf', 'r.pdf'], ['text/plain', 't.txt']]) {
    const node = run(ctx, `renderAttachment(${att(mime, name)})`);
    const buttons = node.find((n) => n.tag === 'button');
    assert.strictEqual(buttons.length, 1, mime + ' has one Download button');
    assert.match(buttons[0].textContent, /Download/);
    assert.match(node.textContent, new RegExp(name.replace('.', '\\.')));
  }
  const img = run(ctx, `renderAttachment(${att('image/png', 'a.png')})`).find((n) => n.tag === 'img')[0];
  img.dispatch('click');
  assert.ok(env.els.viewer.classList.contains('show')); assert.strictEqual(env.els['viewer-name'].textContent, 'a.png');
  env.docListeners.keydown[0]({ key: 'Escape' });
  assert.ok(!env.els.viewer.classList.contains('show'));
});

test('the Download button asks for ?download=1, saves the file with its name, and cleans up', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); env.calls.length = 0;
  env.fetchQueue.push({ json: null, blob: { size: 5 } });
  const m = { attachment: { name: 'Report ሰላም.pdf', mime: 'application/pdf', size: 5, url: '/api/messages/m1/attachment' } };
  ctx.__m = m; await run(ctx, 'downloadAttachment(__m)');
  assert.strictEqual(env.calls[0].url, '/api/messages/m1/attachment?download=1');
  const link = env.created.filter((e) => e.tag === 'a').at(-1);
  assert.strictEqual(link.attrs.download, 'Report ሰላም.pdf'); assert.strictEqual(link.clicked, 1);
});

test('a failed download shows a message instead of failing silently; an expired login logs out', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`);
  ctx.__m = { attachment: { name: 'x.pdf', mime: 'application/pdf', size: 5, url: '/api/messages/m1/attachment' } };
  const toasts = () => env.created.filter((e) => e.className === 'toast').map((e) => e.textContent);
  env.fetchQueue.push({ status: 404, ok: false, json: { error: 'File not found' } });
  await run(ctx, 'downloadAttachment(__m)'); assert.ok(toasts().some((t) => /no longer available/.test(t)));
  env.fetchQueue.push({ status: 500, ok: false, json: {} });
  await run(ctx, 'downloadAttachment(__m)'); assert.ok(toasts().some((t) => /Download failed/.test(t)));
  env.fetchQueue.push({ status: 401, ok: false, json: {} });
  await run(ctx, 'downloadAttachment(__m)'); assert.strictEqual(run(ctx, 'me'), null, 'logged out after a 401');
});

test('Settings > Account buttons: edit profile opens the old modal, logout-all calls the server and reloads', async () => {
  const env = makeEnv(); const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`); env.els['settings-btn'].click();
  env.els['set-edit-profile'].click();
  assert.ok(!env.els['settings-panel'].classList.contains('show'));
  assert.strictEqual(env.els['edit-profile-btn'].clicked, 1, 'the existing Edit profile button was used');
  env.els['set-logout'].click(); assert.strictEqual(env.els['logout-btn'].clicked, 1);
  env.calls.length = 0; env.fetchQueue.push({ json: { message: 'ok' } });
  env.els['set-logout-all'].click(); await tick(); await tick();
  assert.ok(env.calls.some((c) => c.url === '/api/auth/logout-all' && c.method === 'POST'));
  assert.strictEqual(env.reloaded, true);
});

test('Settings > notifications switch asks the browser for permission and shows the answer', async () => {
  const env = makeEnv(); env.permission = 'default'; const ctx = load(env); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`); env.els['settings-btn'].click();
  assert.strictEqual(env.els['set-notify'].checked, false, 'not granted yet');
  env.permission = 'denied'; const box = env.els['set-notify']; box.checked = true; box.dispatch('change'); await tick();
  assert.strictEqual(box.checked, false); assert.match(env.els['notify-status'].textContent, /blocked/);
});

test('the existing features still load: Edit profile, Log out, search and the message form are wired', async () => {
  const env = makeEnv(); load(env); await tick();
  for (const id of ['edit-profile-btn', 'logout-btn', 'search-input', 'message-form', 'attachment-file-input', 'file-preview-cancel', 'back-btn', 'voice-call-btn', 'video-call-btn', 'save-edit-btn', 'cancel-edit-btn', 'signup-form', 'login-form']) {
    assert.ok(Object.keys(env.els[id].listeners).length > 0, id + ' has no event listener');
  }
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', e.message.split('\n')[0]); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
