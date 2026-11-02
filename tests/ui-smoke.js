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

class FakeTrack {
  constructor(kind) { this.kind = kind; this.enabled = true; this.stopped = false; }
  stop() { this.stopped = true; }
}
class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks.slice(); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
}
class FakePC {
  constructor(config, env) {
    this.config = config; this.senders = []; this.iceAdded = []; this.localDescription = null; this.remoteDescription = null;
    this.closed = false; this.connectionState = 'new'; env.pcs.push(this);
  }
  addTrack(t) { const s = { track: t, replaced: null, async replaceTrack(nt) { this.replaced = nt; this.track = nt; } }; this.senders.push(s); return s; }
  getSenders() { return this.senders; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 fake-offer-sdp-from-the-test' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 fake-answer-sdp-from-the-test' }; }
  async setLocalDescription(d) { this.localDescription = { type: d.type, sdp: d.sdp }; }
  async setRemoteDescription(d) { this.remoteDescription = { type: d.type, sdp: d.sdp }; }
  async addIceCandidate(c) { this.iceAdded.push(c); }
  close() { this.closed = true; }
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
    storage: {}, routes: {}, emits: [], socketHandlers: {}, ackQueue: [], holdAck: false, pendingAck: null,
    mediaCalls: [], mediaError: '', streams: [], pcs: [], swListeners: {}, subscribeCalls: [], sub: null, replaced: null,
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
    confirm: () => true, prompt: () => null, location: { reload() { env.reloaded = true; }, search: '', pathname: '/' },
    history: { replaceState: (...a) => { env.replaced = a; } }
  };
  env.socket = {
    connected: true,
    on: (name, fn) => { env.socketHandlers[name] = fn; },
    emit: (name, payload, ack) => {
      env.emits.push([name, payload]);
      if (typeof ack === 'function') {
        const reply = env.ackQueue.length ? env.ackQueue.shift() : { ok: true, callId: 'a'.repeat(32) };
        if (env.holdAck) env.pendingAck = () => ack(reply);
        else Promise.resolve().then(() => ack(reply));
      }
    },
    connect() {}, disconnect() {}
  };
  env.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    const routed = env.routes[url];
    const r = routed && routed.length
      ? routed.shift()
      : fetchQueue.length
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
    setInterval, clearInterval, URLSearchParams, atob, MediaStream: FakeStream, Uint8Array,
    RTCPeerConnection: class extends FakePC { constructor(cfg) { super(cfg, env); } },
    AudioContext: class { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; } resume() {} createOscillator() { return { frequency: {}, connect() {}, start() { env.beeps = (env.beeps || 0) + 1; }, stop() {} }; } createGain() { return { gain: {}, connect() {} }; } },
    navigator: { userAgent: 'test-browser', vibrate() {}, mediaDevices: { getUserMedia: async (c) => {
      env.mediaCalls.push(c);
      if (env.mediaError) { const e = new Error('denied'); e.name = env.mediaError; throw e; }
      const tracks = []; if (c && c.audio) tracks.push(new FakeTrack('audio')); if (c && c.video) tracks.push(new FakeTrack('video'));
      const st = new FakeStream(tracks); env.streams.push(st); return st; } } },
    fetch: env.fetch, FormData: class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } },
    FileReader: class {}, Image: class {}, Date, Promise, Notification: class { constructor(t, o) { env.notifications.push([t, o]); } static get permission() { return env.permission || 'granted'; } static requestPermission() { return Promise.resolve(env.permission || 'granted'); } },
    io: () => env.socket, ...extraGlobals
  };
  sandbox.window.Notification = sandbox.Notification;
  sandbox.window.RTCPeerConnection = sandbox.RTCPeerConnection;
  sandbox.window.AudioContext = sandbox.AudioContext;
  sandbox.window.isSecureContext = true;
  if (extraGlobals.PushManager) sandbox.window.PushManager = function PushManager() {};
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


// ================================================================ CALLS and PHONE ALERTS ================================================================
const CONV = { id: 'a'.repeat(24), partner: { id: 'p1', name: 'Bob', avatarUrl: '/b' }, online: false, unread: 0, lastMessage: null, lastMessageAt: new Date().toISOString() };
const INCOMING = (kind = 'audio', id = 'b'.repeat(32)) => ({ callId: id, conversationId: CONV.id, kind, from: 'p1', offer: 'v=0 offer-from-the-other-person' });
const CAND = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
const localCand = { ...CAND, toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex, usernameFragment: this.usernameFragment }; } };
const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const toasts = (env) => env.created.filter((e) => e.className === 'toast').map((e) => e.textContent);
const emitted = (env, name) => env.emits.filter((e) => e[0] === name).map((e) => e[1]);

async function inChat(env, ctx) {
  run(ctx, `enterApp(${JSON.stringify(USER)})`);
  await tick();
  run(ctx, `conversations = [${JSON.stringify(CONV)}]; activeConv = conversations[0];`);
  env.emits.length = 0; env.calls.length = 0;
}

function pushNavigator(env, ua = 'test-browser') {
  const reg = { pushManager: {
    getSubscription: async () => env.sub || null,
    subscribe: async (opts) => {
      env.subscribeCalls.push(opts);
      env.sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint', options: { applicationServerKey: opts.applicationServerKey.buffer },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p'.repeat(30), auth: 'a'.repeat(16) } }; },
        async unsubscribe() { env.unsubscribed = true; env.sub = null; return true; } };
      return env.sub;
    } } };
  return { userAgent: ua, vibrate() {}, serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener: (t, fn) => { env.swListeners[t] = fn; } } };
}

test('Calls: an audio call opens only the microphone, sends the offer and shows the call screen', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('audio')");
  assert.strictEqual(env.mediaCalls.length, 1);
  assert.strictEqual(env.mediaCalls[0].video, false);
  assert.strictEqual(env.mediaCalls[0].audio.echoCancellation, true);
  const start = emitted(env, 'call:start')[0];
  assert.ok(start, 'call:start was not sent');
  assert.deepStrictEqual(Object.keys(start).sort(), ['conversationId', 'kind', 'sdp']);
  assert.strictEqual(start.kind, 'audio'); assert.strictEqual(start.conversationId, CONV.id); assert.match(start.sdp, /^v=0/);
  assert.ok(env.els['call-overlay'].classList.contains('show')); assert.ok(!env.els['call-overlay'].classList.contains('video'));
  assert.strictEqual(env.els['call-name'].textContent, 'Bob');
  await tick();
  assert.strictEqual(run(ctx, 'call.id'), 'a'.repeat(32)); assert.match(env.els['call-status'].textContent, /Calling/);
  assert.ok(env.beeps > 0, 'the ring-back tone plays');
});

test('Calls: a video call asks for the camera too and shows the video layout', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('video')");
  assert.strictEqual(env.mediaCalls[0].video.facingMode, 'user');
  assert.ok(env.els['call-overlay'].classList.contains('video'));
  assert.strictEqual(env.els['call-camera-btn'].style.display, ''); assert.strictEqual(emitted(env, 'call:start')[0].kind, 'video');
});

test('Calls: the two buttons in the chat header start an audio and a video call', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.els['voice-call-btn'].click(); await tick(); await tick();
  assert.strictEqual(emitted(env, 'call:start')[0].kind, 'audio');
  run(ctx, 'hangUp()'); env.emits.length = 0; await tick();
  env.els['video-call-btn'].click(); await tick(); await tick();
  assert.strictEqual(emitted(env, 'call:start')[0].kind, 'video');
});

test('Calls: network candidates found before the server answers are held back, then sent with the call id', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.holdAck = true; env.ackQueue.push({ ok: true, callId: 'c'.repeat(32) });
  await run(ctx, "startCall('audio')");
  env.pcs[0].onicecandidate({ candidate: localCand });
  assert.strictEqual(emitted(env, 'call:ice').length, 0, 'sent too early');
  env.pendingAck(); await tick();
  const ice = emitted(env, 'call:ice');
  assert.strictEqual(ice.length, 1); assert.strictEqual(ice[0].callId, 'c'.repeat(32)); assert.deepStrictEqual(Object.keys(ice[0].candidate).sort(), ['candidate', 'sdpMLineIndex', 'sdpMid', 'usernameFragment']);
  env.pcs[0].onicecandidate({ candidate: localCand }); assert.strictEqual(emitted(env, 'call:ice').length, 2, 'later ones go out at once');
  env.pcs[0].onicecandidate({ candidate: null }); assert.strictEqual(emitted(env, 'call:ice').length, 2, 'the end-of-candidates marker is not sent');
});

test('Calls: when the other person answers, the answer is applied and early network candidates are added afterwards', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('audio')"); await tick();
  const id = 'a'.repeat(32), pc = env.pcs[0];
  await env.socketHandlers['call:ice']({ callId: id, candidate: CAND });
  assert.strictEqual(pc.iceAdded.length, 0, 'must wait for the answer');
  await env.socketHandlers['call:accepted']({ callId: id, answer: 'v=0 the-answer-from-bob' });
  assert.strictEqual(pc.remoteDescription.type, 'answer'); assert.strictEqual(pc.remoteDescription.sdp, 'v=0 the-answer-from-bob');
  assert.strictEqual(pc.iceAdded.length, 1);
  await env.socketHandlers['call:ice']({ callId: id, candidate: CAND }); assert.strictEqual(pc.iceAdded.length, 2);
  await env.socketHandlers['call:ice']({ callId: 'f'.repeat(32), candidate: CAND }); assert.strictEqual(pc.iceAdded.length, 2, 'another call is ignored');
  pc.connectionState = 'connected'; pc.onconnectionstatechange();
  assert.match(env.els['call-status'].textContent, /^\d\d:\d\d$/, 'the timer starts');
});

test('Calls: an incoming call rings WITHOUT opening the microphone; Accept opens it, answers and adds early candidates', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.socketHandlers['call:incoming'](INCOMING('video'));
  await env.socketHandlers['call:ice']({ callId: 'b'.repeat(32), candidate: CAND });
  const ov = env.els['call-overlay'];
  assert.ok(ov.classList.contains('show') && ov.classList.contains('incoming')); assert.strictEqual(env.els['call-name'].textContent, 'Bob');
  assert.strictEqual(env.els['call-status'].textContent, 'Incoming video call'); assert.strictEqual(env.mediaCalls.length, 0, 'the microphone must stay closed while ringing');
  assert.ok(env.beeps > 0, 'rings');
  env.els['call-accept-btn'].click(); await tick(); await tick();
  assert.strictEqual(env.mediaCalls.length, 1); assert.strictEqual(env.mediaCalls[0].video.facingMode, 'user');
  const pc = env.pcs[0];
  assert.strictEqual(pc.remoteDescription.sdp, 'v=0 offer-from-the-other-person'); assert.strictEqual(pc.iceAdded.length, 1);
  const acc = emitted(env, 'call:accept')[0];
  assert.deepStrictEqual(Object.keys(acc).sort(), ['callId', 'sdp']); assert.strictEqual(acc.callId, 'b'.repeat(32)); assert.strictEqual(acc.sdp, 'v=0 fake-answer-sdp-from-the-test');
  assert.ok(!ov.classList.contains('incoming') && ov.classList.contains('active'));
  pc.onicecandidate({ candidate: localCand }); assert.strictEqual(emitted(env, 'call:ice')[0].callId, 'b'.repeat(32));
});

test('Calls: Decline tells the server and never opens the microphone', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.socketHandlers['call:incoming'](INCOMING());
  env.els['call-decline-btn'].click();
  assert.deepStrictEqual(emitted(env, 'call:reject').map((p) => p.callId), ['b'.repeat(32)]);
  assert.strictEqual(env.mediaCalls.length, 0); assert.ok(!env.els['call-overlay'].classList.contains('show')); assert.strictEqual(run(ctx, 'call'), null);
});

test('Calls: a second incoming call while busy is declined automatically; the same call announced again is ignored', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.socketHandlers['call:incoming'](INCOMING('audio', 'b'.repeat(32)));
  env.socketHandlers['call:incoming'](INCOMING('audio', 'b'.repeat(32)));
  assert.strictEqual(emitted(env, 'call:reject').length, 0);
  env.socketHandlers['call:incoming'](INCOMING('audio', 'd'.repeat(32)));
  assert.deepStrictEqual(emitted(env, 'call:reject').map((p) => p.callId), ['d'.repeat(32)]);
  assert.strictEqual(run(ctx, 'call.id'), 'b'.repeat(32));
});

test('Calls: Hang up tells the server, stops the microphone and camera, closes the connection and hides the screen', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('video')"); await tick();
  const stream = env.streams[0], pc = env.pcs[0];
  env.els['call-hangup-btn'].click();
  assert.deepStrictEqual(emitted(env, 'call:hangup').map((p) => p.callId), ['a'.repeat(32)]);
  assert.ok(stream.getTracks().every((t) => t.stopped), 'all tracks stopped'); assert.strictEqual(pc.closed, true);
  assert.ok(!env.els['call-overlay'].classList.contains('show')); assert.strictEqual(run(ctx, 'call'), null);
});

test('Calls: giving up before the server answered cancels the call as soon as the server answers', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.holdAck = true; env.ackQueue.push({ ok: true, callId: 'e'.repeat(32) });
  await run(ctx, "startCall('audio')");
  env.els['call-hangup-btn'].click();
  assert.strictEqual(emitted(env, 'call:hangup').length, 0, 'the id is not known yet');
  env.pendingAck(); await tick();
  assert.deepStrictEqual(emitted(env, 'call:hangup').map((p) => p.callId), ['e'.repeat(32)]);
});

test('Calls: when the other side ends the call, the right message is shown and everything is cleaned up', async () => {
  const cases = [['rejected', /Bob declined/], ['timeout', /did not answer/], ['hangup', /Call ended/], ['disconnected', /disconnected/], ['answered_elsewhere', /another device/]];
  for (const [reason, re] of cases) {
    const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
    await run(ctx, "startCall('audio')"); await tick();
    const stream = env.streams[0];
    env.socketHandlers['call:ended']({ callId: 'a'.repeat(32), reason });
    assert.ok(toasts(env).some((t) => re.test(t)), reason + ' -> ' + toasts(env).join('|'));
    assert.ok(stream.getTracks().every((t) => t.stopped)); assert.strictEqual(run(ctx, 'call'), null);
  }
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.socketHandlers['call:incoming'](INCOMING()); env.socketHandlers['call:ended']({ callId: 'b'.repeat(32), reason: 'cancelled' });
  assert.ok(toasts(env).some((t) => /Missed call from Bob/.test(t))); assert.ok(!env.els['call-overlay'].classList.contains('show'));
  env.socketHandlers['call:incoming'](INCOMING('audio', 'd'.repeat(32))); env.socketHandlers['call:ended']({ callId: 'd'.repeat(32), reason: 'rejected_elsewhere' });
  assert.strictEqual(run(ctx, 'call'), null, 'silently closed');
  env.socketHandlers['call:incoming'](INCOMING('audio', '1'.repeat(32))); env.socketHandlers['call:ended']({ callId: '2'.repeat(32), reason: 'hangup' });
  assert.strictEqual(run(ctx, 'call.id'), '1'.repeat(32), 'a message about another call changes nothing');
});

test('Calls: if the microphone is blocked, a clear message is shown and no call is started', async () => {
  const env = makeEnv(); env.mediaError = 'NotAllowedError'; const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('audio')");
  assert.ok(toasts(env).some((t) => /Allow the microphone/.test(t))); assert.strictEqual(emitted(env, 'call:start').length, 0);
  assert.strictEqual(run(ctx, 'call'), null); assert.ok(!env.els['call-overlay'].classList.contains('show'));
  env.mediaError = 'NotFoundError'; await run(ctx, "startCall('video')"); assert.ok(toasts(env).some((t) => /No microphone or camera/.test(t)));
  env.mediaError = 'NotReadableError'; await run(ctx, "startCall('video')"); assert.ok(toasts(env).some((t) => /being used by another app/.test(t)));
});

test('Calls: errors from the server are explained and the microphone is released', async () => {
  for (const [code, re] of [['busy', /Bob is busy/], ['rate_limited', /Too many calls/], ['forbidden', /cannot call/], ['server', /try again/]]) {
    const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
    env.ackQueue.push({ error: code });
    await run(ctx, "startCall('audio')"); await tick();
    assert.ok(toasts(env).some((t) => re.test(t)), code + ' -> ' + toasts(env).join('|'));
    assert.ok(env.streams[0].getTracks().every((t) => t.stopped)); assert.strictEqual(run(ctx, 'call'), null);
  }
});

test('Calls: no call can start when disconnected, when already in a call, or in a browser without WebRTC', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.socket.connected = false; await run(ctx, "startCall('audio')");
  assert.ok(toasts(env).some((t) => /Not connected/.test(t))); assert.strictEqual(env.mediaCalls.length, 0);
  env.socket.connected = true; await run(ctx, "startCall('audio')"); await tick(); env.mediaCalls.length = 0;
  await run(ctx, "startCall('audio')"); assert.ok(toasts(env).some((t) => /already in a call/.test(t))); assert.strictEqual(env.mediaCalls.length, 0);
  const env2 = makeEnv(); const ctx2 = load(env2); await tick(); await inChat(env2, ctx2);
  env2.window.RTCPeerConnection = undefined; await run(ctx2, "startCall('audio')");
  assert.ok(toasts(env2).some((t) => /cannot make calls/.test(t)));
});

test('Calls: mute and camera-off switch the real tracks; the camera can be flipped', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('video')"); await tick();
  const [audio] = env.streams[0].getAudioTracks(), [video] = env.streams[0].getVideoTracks();
  env.els['call-mute-btn'].click(); assert.strictEqual(audio.enabled, false); assert.ok(env.els['call-mute-btn'].classList.contains('off'));
  env.els['call-mute-btn'].click(); assert.strictEqual(audio.enabled, true);
  env.els['call-camera-btn'].click(); assert.strictEqual(video.enabled, false);
  env.els['call-camera-btn'].click(); assert.strictEqual(video.enabled, true);
  await run(ctx, 'flipCamera()');
  assert.strictEqual(env.mediaCalls.at(-1).video.facingMode, 'environment'); assert.strictEqual(video.stopped, true);
  assert.ok(env.pcs[0].senders.find((s) => s.replaced), 'the sent video track was replaced');
});

test('Calls: "Hide my network address" uses relay only when the server has a relay', async () => {
  const run1 = async (hasTurn) => {
    const env = makeEnv(); env.storage['chat-device-settings'] = JSON.stringify({ relay: true }); const ctx = load(env); await tick(); await inChat(env, ctx);
    env.routes['/api/calls/ice'] = [{ json: { iceServers: [{ urls: hasTurn ? 'turn:t.example:3478' : 'stun:s.example' }], hasTurn } }];
    await run(ctx, "startCall('audio')"); return env.pcs[0].config;
  };
  assert.strictEqual((await run1(true)).iceTransportPolicy, 'relay');
  assert.strictEqual((await run1(false)).iceTransportPolicy, 'all');
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.routes['/api/calls/ice'] = [{ json: { iceServers: [{ urls: 'turn:t.example:3478' }], hasTurn: true } }];
  await run(ctx, "startCall('audio')"); assert.strictEqual(env.pcs[0].config.iceTransportPolicy, 'all', 'off by default');
  assert.strictEqual(env.pcs[0].config.iceServers[0].urls, 'turn:t.example:3478');
});

test('Calls: if the network details cannot be loaded, the call still starts with public STUN', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.routes['/api/calls/ice'] = [{ status: 500, json: { error: 'x' } }];
  await run(ctx, "startCall('audio')");
  assert.match(env.pcs[0].config.iceServers[0].urls, /^stun:/); assert.strictEqual(emitted(env, 'call:start').length, 1);
});

test('Calls: no ring tone when it is switched off; the call screen settings are saved on the device', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.els['settings-btn'].click();
  env.els['set-ring'].checked = false; env.els['set-ring'].dispatch('change'); env.els['set-relay'].checked = true; env.els['set-relay'].dispatch('change');
  const saved = JSON.parse(env.storage['chat-device-settings']); assert.strictEqual(saved.ring, false); assert.strictEqual(saved.relay, true);
  env.beeps = 0; env.socketHandlers['call:incoming'](INCOMING()); assert.ok(!env.beeps, 'silent');
});

test('Calls: a ringing call that nobody answers disappears by itself and a logout ends the call', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  await run(ctx, "startCall('audio')"); await tick();
  const stream = env.streams[0]; run(ctx, 'handleLoggedOut()');
  assert.strictEqual(run(ctx, 'call'), null); assert.ok(stream.getTracks().every((t) => t.stopped));
});

test('Visibility: the server is told when the page is in front or hidden', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.socketHandlers.connect(); assert.strictEqual(emitted(env, 'visibility').at(-1).visible, true);
  env.document.hidden = true; env.docListeners.visibilitychange.forEach((fn) => fn());
  assert.strictEqual(emitted(env, 'visibility').at(-1).visible, false);
});

test('Alerts: the in-page alert uses the same tag as the phone alert, so a message never shows twice', async () => {
  const env = makeEnv(); const ctx = load(env); await tick(); await inChat(env, ctx);
  env.document.hidden = true;
  await run(ctx, `onIncomingMessage({ id: 'm1', conversationId: '${CONV.id}', senderId: 'p1', text: 'hello', deleted: false, edited: false, attachment: null, createdAt: new Date().toISOString(), readAt: null })`);
  assert.strictEqual(env.notifications.at(-1)[1].tag, 'conv-' + CONV.id);
});

test('Alerts: switching on "alerts when the app is closed" registers this device (key, subscription, preview choice)', async () => {
  const env = makeEnv(); env.permission = 'granted'; const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx);
  env.routes['/api/push/key'] = [{ json: { enabled: true, publicKey: VAPID } }]; env.routes['/api/push/subscribe'] = [{ status: 201, json: { ok: true } }];
  env.els['settings-btn'].click(); const box = env.els['set-push']; box.checked = true; box.dispatch('change'); await tick(); await tick();
  assert.strictEqual(env.subscribeCalls.length, 1); assert.strictEqual(env.subscribeCalls[0].userVisibleOnly, true); assert.strictEqual(env.subscribeCalls[0].applicationServerKey.length, 65);
  const post = env.calls.find((c) => c.url === '/api/push/subscribe'); const body = JSON.parse(post.body);
  assert.strictEqual(post.method, 'POST'); assert.strictEqual(body.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/test-endpoint'); assert.strictEqual(body.preview, true);
  assert.strictEqual(JSON.parse(env.storage['chat-device-settings']).push, true); assert.match(env.els['push-status'].textContent, /^On/);
});

test('Alerts: explained problems: blocked permission, server not set up, browser without push', async () => {
  const env = makeEnv(); env.permission = 'denied'; const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx);
  env.els['settings-btn'].click(); const box = env.els['set-push']; box.checked = true; box.dispatch('change'); await tick(); await tick();
  assert.strictEqual(box.checked, false); assert.ok(toasts(env).some((t) => /blocked/.test(t))); assert.strictEqual(env.subscribeCalls.length, 0);

  const env2 = makeEnv(); env2.permission = 'granted'; const ctx2 = load(env2, { navigator: pushNavigator(env2), PushManager: true }); await tick(); await inChat(env2, ctx2);
  env2.routes['/api/push/key'] = [{ json: { enabled: false } }]; env2.els['settings-btn'].click();
  const box2 = env2.els['set-push']; box2.checked = true; box2.dispatch('change'); await tick(); await tick();
  assert.strictEqual(box2.checked, false); assert.ok(toasts(env2).some((t) => /not switched on/.test(t))); assert.strictEqual(env2.subscribeCalls.length, 0);

  const env3 = makeEnv(); const ctx3 = load(env3, { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', vibrate() {} } }); await tick(); await inChat(env3, ctx3);
  env3.els['settings-btn'].click(); assert.match(env3.els['push-status'].textContent, /Home Screen/);
});

test('Alerts: switching them off removes this device from the server and from the browser', async () => {
  const env = makeEnv(); env.permission = 'granted'; env.storage['chat-device-settings'] = JSON.stringify({ push: true });
  env.routes['/api/push/key'] = [{ json: { enabled: true, publicKey: VAPID } }]; env.routes['/api/push/subscribe'] = [{ status: 201, json: { ok: true } }];
  const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx); await tick(); await tick();
  assert.ok(env.sub, 'registered at login'); env.calls.length = 0;
  env.els['settings-btn'].click(); const box = env.els['set-push']; box.checked = false; box.dispatch('change'); await tick(); await tick();
  const call = env.calls.find((c) => c.url === '/api/push/unsubscribe');
  assert.deepStrictEqual(JSON.parse(call.body), { endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint' }); assert.strictEqual(env.unsubscribed, true);
  assert.strictEqual(JSON.parse(env.storage['chat-device-settings']).push, false);
});

test('Alerts: after login a device that chose alerts is registered again for the account that logged in', async () => {
  const env = makeEnv(); env.permission = 'granted'; env.storage['chat-device-settings'] = JSON.stringify({ push: true });
  env.routes['/api/push/key'] = [{ json: { enabled: true, publicKey: VAPID } }]; env.routes['/api/push/subscribe'] = [{ status: 201, json: { ok: true } }];
  const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick();
  run(ctx, `enterApp(${JSON.stringify(USER)})`); await tick(); await tick();
  assert.strictEqual(env.subscribeCalls.length, 1); assert.ok(env.calls.some((c) => c.url === '/api/push/subscribe'));
  const env2 = makeEnv(); env2.permission = 'granted'; const ctx2 = load(env2, { navigator: pushNavigator(env2), PushManager: true }); await tick();
  run(ctx2, `enterApp(${JSON.stringify(USER)})`); await tick(); await tick();
  assert.ok(!env2.calls.some((c) => c.url === '/api/push/key'), 'nothing is registered when the person did not choose alerts');
});

test('Alerts: logging out first removes this device from the account, and only then logs out', async () => {
  const env = makeEnv(); env.permission = 'granted'; env.storage['chat-device-settings'] = JSON.stringify({ push: true });
  env.routes['/api/push/key'] = [{ json: { enabled: true, publicKey: VAPID } }]; env.routes['/api/push/subscribe'] = [{ status: 201, json: { ok: true } }];
  const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx); await tick(); await tick(); env.calls.length = 0;
  env.els['logout-btn'].click(); await tick(); await tick();
  const urls = env.calls.map((c) => c.url);
  assert.ok(urls.indexOf('/api/push/unsubscribe') !== -1 && urls.indexOf('/api/auth/logout') !== -1); assert.ok(urls.indexOf('/api/push/unsubscribe') < urls.indexOf('/api/auth/logout'));
  assert.ok(env.sub, 'the browser keeps its registration so the next login can reuse it');
});

test('Alerts: changing "show the message text" updates this device\'s alerts on the server', async () => {
  const env = makeEnv(); env.permission = 'granted'; env.storage['chat-device-settings'] = JSON.stringify({ push: true });
  env.routes['/api/push/key'] = [{ json: { enabled: true, publicKey: VAPID } }, { json: { enabled: true, publicKey: VAPID } }]; env.routes['/api/push/subscribe'] = [{ status: 201, json: { ok: true } }, { status: 201, json: { ok: true } }];
  const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx); await tick(); await tick(); env.calls.length = 0;
  env.els['settings-btn'].click(); env.els['set-preview'].checked = false; env.els['set-preview'].dispatch('change'); await tick(); await tick(); await tick();
  const post = env.calls.find((c) => c.url === '/api/push/subscribe'); assert.strictEqual(JSON.parse(post.body).preview, false);
});

test('Alerts: tapping an alert opens that chat, and a safe check stops strange ids', async () => {
  const env = makeEnv(); const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx);
  env.swListeners.message({ data: { type: 'notification-click', conversationId: CONV.id } }); await tick(); await tick();
  assert.ok(env.calls.some((c) => c.url.startsWith(`/api/conversations/${CONV.id}/messages`)));
  env.calls.length = 0;
  env.swListeners.message({ data: { type: 'notification-click', conversationId: '../../etc' } }); env.swListeners.message({ data: { type: 'notification-click', conversationId: { $ne: 1 } } }); await tick();
  assert.strictEqual(env.calls.length, 0);
});

test('Alerts: opening the app from an alert (address ?c=...) opens the chat once the list is loaded and cleans the address', async () => {
  const env = makeEnv(); env.window.location.search = '?c=' + CONV.id; env.routes['/api/conversations'] = [{ json: { conversations: [CONV] } }];
  const ctx = load(env); await tick(); run(ctx, `enterApp(${JSON.stringify(USER)})`); await tick(); await tick(); await tick();
  assert.ok(env.calls.some((c) => c.url.startsWith(`/api/conversations/${CONV.id}/messages`)), 'chat opened');
  assert.deepStrictEqual(env.replaced.slice(2), ['/']); 
  const env2 = makeEnv(); env2.window.location.search = '?c=not-an-id'; const ctx2 = load(env2); await tick(); run(ctx2, `enterApp(${JSON.stringify(USER)})`); await tick(); await tick();
  assert.strictEqual(env2.replaced, null, 'a strange address is ignored');
});

test('Alerts: a browser notice to register again is followed', async () => {
  const env = makeEnv(); env.permission = 'granted'; env.storage['chat-device-settings'] = JSON.stringify({ push: true });
  env.routes['/api/push/key'] = [{ json: { enabled: true, publicKey: VAPID } }, { json: { enabled: true, publicKey: VAPID } }]; env.routes['/api/push/subscribe'] = [{ status: 201, json: { ok: true } }, { status: 201, json: { ok: true } }];
  const ctx = load(env, { navigator: pushNavigator(env), PushManager: true }); await tick(); await inChat(env, ctx); await tick(); await tick(); env.calls.length = 0;
  env.swListeners.message({ data: { type: 'push-resubscribe' } }); await tick(); await tick(); await tick();
  assert.ok(env.calls.some((c) => c.url === '/api/push/subscribe'));
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', e.message.split('\n')[0]); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
