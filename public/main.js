'use strict';
// ============================================================
// HAILACHO CHAT APP - main.js (secure private chat)
// - Login is a server cookie (HttpOnly). Nothing secret is kept in localStorage.
// - All text is put on the page with textContent / DOM methods (never innerHTML) -> no XSS.
// - The server decides who may see which conversation. This file only shows what the server returns.
// ============================================================

const DEFAULT_AVATAR = '/default-avatar.svg';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // keep in sync with MAX_UPLOAD_MB on the server
const $ = (id) => document.getElementById(id);

// ---------- elements ----------
const container = document.querySelector('.container');
const signupPage = $('signup-page');
const loginPage = $('login-page');
const signupForm = $('signup-form');
const loginForm = $('login-form');
const previewImg = $('preview');
const fileInput = $('file-input');
const myAvatar = $('my-profile-img');
const usersList = $('users-online');
const searchInput = $('search-input');
const mainPane = document.querySelector('.main');
const chatAvatar = $('chat-avatar');
const chatName = $('chat-with-name');
const chatStatus = $('chat-status');
const messageList = $('message-container');
const messageForm = $('message-form');
const messageInput = $('message-input');
const sendBtn = document.querySelector('.send-button');
const attachmentInput = $('attachment-file-input');
const filePreview = $('file-preview');
const filePreviewThumb = $('file-preview-thumb');
const filePreviewName = $('file-preview-name');
const filePreviewSize = $('file-preview-size');
const messageTone = $('message-tone');
const editModal = $('edit-profile-modal');
const editPreview = $('edit-preview');

// ---------- state ----------
let me = null;
let socket = null;
let conversations = [];
let activeConv = null;
let messages = [];
let hasMore = false;
let searchResults = null; // null = show chats, array = show search results
let pendingFile = null;
let previewObjectUrl = null;
let isSending = false;
let partnerTyping = false;
let partnerTypingTimer = null;
let typingSent = false;
let typingIdleTimer = null;
let searchTimer = null;
let listRefreshTimer = null;
let editAvatarData = null;
let signupAvatarData = null;

// ---------- brand ----------
const APP_NAME = 'HAILACHO Chat'; // <-- your brand name as shown inside the app (Settings > About)
const APP_VERSION = '1.1.0';

// ---------- device settings: kept only on THIS phone or computer, never sent to the server ----------
const DEVICE_KEY = 'chat-device-settings';
const DEVICE_DEFAULTS = { sound: true, notify: true, preview: true, textSize: 15, pattern: true, allowZoom: false, push: false, ring: true, relay: false };
const TEXT_SIZES = [14, 15, 17, 19];

function loadDeviceSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const s = { ...DEVICE_DEFAULTS };
    ['sound', 'notify', 'preview', 'pattern', 'allowZoom', 'push', 'ring', 'relay'].forEach((k) => {
    if (typeof saved[k] === 'boolean') s[k] = saved[k];
  });
  if (TEXT_SIZES.includes(saved.textSize)) s.textSize = saved.textSize;
  return s;
}
let deviceSettings = loadDeviceSettings();

function saveDeviceSettings() {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(deviceSettings));
  } catch {
    /* private mode: ignore */
  }
}

// The zoom lock is active only INSIDE the chat (after login) and only while "Allow pinch zoom" is off.
// The login and sign-up pages stay zoomable, so nobody is locked out of reading them.
const zoomLocked = () => !!me && !deviceSettings.allowZoom;

// Applies the text size, the chat background and the zoom lock
function applyDeviceSettings() {
  document.documentElement.style.setProperty('--msg-font-size', deviceSettings.textSize + 'px');
  mainPane.classList.toggle('plain', !deviceSettings.pattern);
  document.documentElement.classList.toggle('zoom-locked', zoomLocked());
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) {
    viewport.setAttribute(
      'content',
      zoomLocked()
        ? 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'
        : 'width=device-width, initial-scale=1'
    );
  }
}
applyDeviceSettings();

// Stops accidental trackpad pinch-zoom (Ctrl + wheel) and Safari gestures.
// Keyboard zoom (Ctrl and +/-) and the browser's own text-size settings still work.
window.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey && zoomLocked()) e.preventDefault();
  },
  { passive: false }
);
['gesturestart', 'gesturechange', 'gestureend'].forEach((name) =>
  document.addEventListener(name, (e) => {
    if (zoomLocked()) e.preventDefault();
  })
);

// ---------- small helpers ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c); // strings become text nodes
  return node;
}

function avatarImg(url, cls = 'avatar') {
  const img = el('img', { src: url || DEFAULT_AVATAR, class: cls, alt: '' });
  img.addEventListener('error', () => {
    img.onerror = null;
    img.src = DEFAULT_AVATAR;
  });
  return img;
}

function setAvatar(imgEl, url) {
  imgEl.src = url || DEFAULT_AVATAR;
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = DEFAULT_AVATAR;
  };
}

const formatTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function errorText(err) {
  if (err && err.details && err.details.length) return err.details.map((d) => d.message).join('\n');
  return (err && err.message) || 'Something went wrong';
}

function showToast(text) {
  const t = el('div', { class: 'toast', text });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// Every request carries the custom header the server requires (CSRF protection) and the login cookie
async function api(method, url, body, isForm = false) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'chat-app' } };
  if (body !== undefined && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isForm) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no JSON body */
  }
  if (res.status === 401 && !url.startsWith('/api/auth/')) handleLoggedOut();
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

// Resize a chosen photo to a small JPEG (keeps avatars tiny and safe)
function resizeImage(file, maxSize, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => showToast('That file is not a valid image');
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ============================================================
// SCREENS / AUTH
// ============================================================
function showSignup() {
  loginPage.style.display = 'none';
  signupPage.style.display = 'block';
}
function showLogin() {
  signupPage.style.display = 'none';
  loginPage.style.display = 'block';
}
$('link-login').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
$('link-signup').addEventListener('click', (e) => { e.preventDefault(); showSignup(); });

fileInput.addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  resizeImage(file, 200, (data) => {
    signupAvatarData = data;
    previewImg.src = data;
  });
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('signup-error');
  errBox.textContent = '';
  const password = $('password').value;
  if (password !== $('confirm-password').value) {
    errBox.textContent = 'Passwords do not match';
    return;
  }
  try {
    const data = await api('POST', '/api/auth/register', {
      name: $('username').value,
      email: $('email').value,
      phone: $('phone').value,
      password,
      avatar: signupAvatarData || undefined
    });
    signupForm.reset();
    enterApp(data.user);
  } catch (err) {
    errBox.textContent = errorText(err);
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('login-error');
  errBox.textContent = '';
  try {
    const data = await api('POST', '/api/auth/login', {
      email: $('login-email').value,
      password: $('login-password').value
    });
    loginForm.reset();
    enterApp(data.user);
  } catch (err) {
    errBox.textContent = errorText(err);
  }
});

$('logout-btn').addEventListener('click', async () => {
  await forgetThisDeviceForPush(); // this device stops getting this account's alerts
  try {
    await api('POST', '/api/auth/logout');
  } catch {
    /* ignore */
  }
  window.location.reload();
});

function handleLoggedOut() {
  if (!me) return;
  me = null;
  if (socket) socket.disconnect();
  applyDeviceSettings(); // the login page can be zoomed again
  endCallLocally(); // no call can continue without a login
  conversations = [];
  activeConv = null;
  messages = [];
  container.classList.add('logged-out');
  container.classList.remove('chat-open');
  mainPane.classList.add('no-chat');
  usersList.replaceChildren();
  messageList.replaceChildren();
  showLogin();
}

function enterApp(user) {
  me = user;
  signupPage.style.display = 'none';
  loginPage.style.display = 'none';
  container.classList.remove('logged-out');
  applyDeviceSettings(); // the zoom lock starts now that the user is inside the chat
  setAvatar(myAvatar, me.avatarUrl);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  connectSocket();
  loadConversations().then(openConversationFromUrl); // a tapped phone alert opens the right chat
  syncPushSubscription(); // keep this device registered for phone alerts
}


// On page load: is there already a valid login cookie?
(async function init() {
  try {
    const data = await api('GET', '/api/auth/me');
    enterApp(data.user);
  } catch {
    showLogin();
  }
})();

// ============================================================
// SOCKET (real-time). Login comes from the cookie; no id is ever sent by us.
// ============================================================
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ autoConnect: false });

  socket.on('connect_error', (err) => {
    if (err && (err.message === 'unauthorized' || err.message === 'forbidden')) handleLoggedOut();
  });
  socket.on('connect', () => {
    emitVisibility();
    loadConversations();
    if (activeConv) loadMessages(activeConv.id);
  });
  socket.on('message:new', onIncomingMessage);
  socket.on('message:edited', onMessageChanged);
  socket.on('message:deleted', onMessageChanged);
  socket.on('message:read', onMessagesRead);
  socket.on('conversation:new', () => loadConversations());
  socket.on('profile:updated', () => loadConversations().then(updateChatHeader));
  socket.on('presence:update', ({ userId, online }) => {
    const conv = conversations.find((c) => c.partner.id === userId);
    if (conv) {
      conv.online = online;
      renderConversationList();
      if (activeConv && activeConv.id === conv.id) updateChatHeader();
    }
  });
  socket.on('typing', ({ conversationId, isTyping }) => {
    if (!activeConv || activeConv.id !== conversationId) return;
    partnerTyping = isTyping;
    clearTimeout(partnerTypingTimer);
    if (isTyping) {
      partnerTypingTimer = setTimeout(() => {
        partnerTyping = false;
        updateChatHeader();
      }, 4000);
    }
    updateChatHeader();
  });
   registerCallSocketEvents(socket); // incoming calls, answers and network candidates (see the CALLS block at the bottom)

  socket.connect();
}

// ============================================================
// CONVERSATION LIST
// ============================================================
async function loadConversations() {
  try {
    const data = await api('GET', '/api/conversations');
    conversations = data.conversations;
    if (activeConv) activeConv = conversations.find((c) => c.id === activeConv.id) || activeConv;
    renderConversationList();
  } catch (err) {
    if (err.status !== 401) console.log('Could not load chats');
  }
}

function scheduleListRefresh() {
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(loadConversations, 300);
}

function sortConversations() {
  conversations.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
}

function previewText(conv) {
  const m = conv.lastMessage;
  if (!m) return 'No messages yet';
  const body = m.deleted ? 'Message deleted' : m.text || '📎 ' + (m.attachmentName || 'File');
  return (m.mine ? 'You: ' : '') + body;
}

function renderConversationList() {
  usersList.replaceChildren();

  if (searchResults !== null) {
    if (searchResults.length === 0) usersList.append(el('li', { class: 'list-note', text: 'No people found' }));
    searchResults.forEach((u) => {
      usersList.append(
        el('li', { class: 'chat-item', onclick: () => startChatWith(u.id) },
          avatarImg(u.avatarUrl),
          el('div', { class: 'chat-info' },
            el('div', { class: 'chat-name', text: u.name }),
            el('div', { class: 'chat-preview', text: 'Tap to start a private chat' })))
      );
    });
    return;
  }

  if (conversations.length === 0) {
    usersList.append(el('li', { class: 'list-note', text: 'No chats yet. Search a person by name to start.' }));
    return;
  }

  conversations.forEach((conv) => {
    const isActive = activeConv && activeConv.id === conv.id;
    usersList.append(
      el('li', { class: 'chat-item' + (isActive ? ' active' : ''), onclick: () => openConversation(conv.id) },
        el('div', { class: 'avatar-wrap' }, avatarImg(conv.partner.avatarUrl), conv.online ? el('span', { class: 'online-dot' }) : null),
        el('div', { class: 'chat-info' },
          el('div', { class: 'chat-name', text: conv.partner.name }),
          el('div', { class: 'chat-preview', text: previewText(conv) })),
        el('div', { class: 'chat-meta' },
          el('span', { class: 'chat-time', text: conv.lastMessage ? formatTime(conv.lastMessage.createdAt) : '' }),
          conv.unread > 0 ? el('span', { class: 'badge', text: String(conv.unread) }) : null))
    );
  });
}

// ---------- search people (by name only) ----------
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults = null;
    renderConversationList();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api('GET', '/api/users/search?query=' + encodeURIComponent(q));
      if (searchInput.value.trim() !== q) return; // the user kept typing
      searchResults = data.users;
      renderConversationList();
    } catch (err) {
      showToast(errorText(err));
    }
  }, 300);
});

async function startChatWith(userId) {
  try {
    const data = await api('POST', '/api/conversations', { userId });
    const existing = conversations.findIndex((c) => c.id === data.conversation.id);
    if (existing >= 0) conversations[existing] = data.conversation;
    else conversations.unshift(data.conversation);
    searchInput.value = '';
    searchResults = null;
    openConversation(data.conversation.id);
  } catch (err) {
    showToast(errorText(err));
  }
}

// ============================================================
// CHAT VIEW
// ============================================================
function updateChatHeader() {
  if (!activeConv) return;
  chatName.textContent = activeConv.partner.name;
  setAvatar(chatAvatar, activeConv.partner.avatarUrl);
  chatStatus.textContent = partnerTyping ? 'typing…' : activeConv.online ? 'Online' : 'Offline';
  chatStatus.classList.toggle('online', !partnerTyping && activeConv.online);
}

async function openConversation(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  stopTyping();
  activeConv = conv;
  partnerTyping = false;
  messages = [];
  clearFilePreview();
  messageInput.value = '';
  mainPane.classList.remove('no-chat');
  container.classList.add('chat-open');
  updateChatHeader();
  renderConversationList();
  await loadMessages(id);
  messageInput.focus();
}

function closeChat() {
  stopTyping();
  activeConv = null;
  messages = [];
  messageList.replaceChildren();
  mainPane.classList.add('no-chat');
  container.classList.remove('chat-open');
  renderConversationList();
}
$('back-btn').addEventListener('click', closeChat);

async function loadMessages(convId) {
  try {
    const data = await api('GET', `/api/conversations/${convId}/messages?limit=30`);
    if (!activeConv || activeConv.id !== convId) return;
    messages = data.messages;
    hasMore = data.hasMore;
    renderMessages();
    scrollToBottom();
    markActiveRead();
  } catch (err) {
    showToast(errorText(err));
  }
}

async function loadOlder() {
  if (!activeConv || messages.length === 0) return;
  try {
    const data = await api('GET', `/api/conversations/${activeConv.id}/messages?limit=30&before=${messages[0].id}`);
    const prevHeight = messageList.scrollHeight;
    messages = data.messages.concat(messages);
    hasMore = data.hasMore;
    renderMessages();
    messageList.scrollTop = messageList.scrollHeight - prevHeight;
  } catch (err) {
    showToast(errorText(err));
  }
}

function scrollToBottom() {
  messageList.scrollTo(0, messageList.scrollHeight);
}

function renderMessages() {
  messageList.replaceChildren();
  if (hasMore) messageList.append(el('li', { class: 'load-older' }, el('button', { type: 'button', text: 'Load older messages', onclick: loadOlder })));
  messages.forEach((m) => messageList.append(messageElement(m)));
}

// Saves a received file to the device. It works in the browser, the installed app and the Android app,
// and it shows a message if the download fails (instead of failing silently).
async function downloadAttachment(m) {
  try {
    const res = await fetch(m.attachment.url + '?download=1', { credentials: 'same-origin' });
    if (res.status === 401) {
      handleLoggedOut();
      return;
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'This file is no longer available' : 'Download failed. Please try again.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: m.attachment.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showToast(errorText(err));
  }
}

function renderAttachment(m) {
  const a = m.attachment;
  let content;
  if (a.mime.startsWith('image/')) {
    content = el('img', { src: a.url, class: 'att-img', alt: a.name, loading: 'lazy', onclick: () => openViewer(m) });
  } else if (a.mime.startsWith('video/')) {
    content = el('video', { src: a.url, controls: '', preload: 'metadata', class: 'att-video' });
  } else if (a.mime.startsWith('audio/')) {
    content = el('audio', { src: a.url, controls: '', preload: 'none', class: 'att-audio' });
  } else {
    content = el('div', { class: 'att-file', onclick: () => downloadAttachment(m) }, el('span', { class: 'att-icon', text: '📄' }));
  }
  return el('div', { class: 'att' }, content,
    el('div', { class: 'att-bar' },
      el('span', { class: 'att-name', text: a.name }),
      el('span', { class: 'att-size', text: formatSize(a.size) }),
      el('button', { type: 'button', class: 'att-dl', title: 'Download', text: '⬇ Download', onclick: () => downloadAttachment(m) })));
}

function messageElement(m) {
  const mine = m.senderId === me.id;
  const bubble = el('div', { class: 'bubble' });

  if (m.deleted) {
    bubble.append(el('div', { class: 'deleted', text: '🚫 This message was deleted' }));
  } else {
    if (m.attachment) bubble.append(renderAttachment(m));
    if (m.text) bubble.append(el('p', { class: 'msg-text', text: m.text }));
  }

  bubble.append(
    el('div', { class: 'msg-meta' },
      m.edited && !m.deleted ? el('span', { text: 'edited' }) : null,
      el('span', { text: formatTime(m.createdAt) }),
      mine && !m.deleted ? el('span', { class: 'ticks' + (m.readAt ? ' read' : ''), text: m.readAt ? '✓✓' : '✓' }) : null)
  );

  if (mine && !m.deleted) {
    bubble.append(
      el('div', { class: 'msg-actions' },
        el('button', { type: 'button', title: 'Edit', text: '✏️', onclick: () => editMessage(m) }),
        el('button', { type: 'button', title: 'Delete', text: '🗑️', onclick: () => deleteMessage(m) }))
    );
  }

  return el('li', { class: 'msg ' + (mine ? 'msg-mine' : 'msg-theirs'), 'data-id': m.id }, bubble);
}

function upsertMessage(m) {
  const i = messages.findIndex((x) => x.id === m.id);
  if (i >= 0) messages[i] = m;
  else messages.push(m);
}

// ---------- incoming real-time events ----------
async function onIncomingMessage(m) {
  let conv = conversations.find((c) => c.id === m.conversationId);
  if (!conv) {
    await loadConversations();
    conv = conversations.find((c) => c.id === m.conversationId);
    if (!conv) return;
  }
  const mine = m.senderId === me.id;
  conv.lastMessage = {
    text: m.text.slice(0, 80),
    attachmentName: m.attachment ? m.attachment.name : null,
    deleted: false,
    mine,
    createdAt: m.createdAt
  };
  conv.lastMessageAt = m.createdAt;

  const isActive = activeConv && activeConv.id === conv.id;
  if (isActive) {
    if (!messages.some((x) => x.id === m.id)) {
      messages.push(m);
      renderMessages();
      scrollToBottom();
    }
    if (!mine) markActiveRead();
  } else if (!mine) {
    conv.unread = (conv.unread || 0) + 1;
  }

  if (!mine) {
    if (deviceSettings.sound) messageTone.play().catch(() => {});
    if (deviceSettings.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const body = deviceSettings.preview ? m.text || '📎 ' + (m.attachment ? m.attachment.name : 'File') : 'New message';
      new Notification(conv.partner.name, { body, tag: 'conv-' + conv.id, icon: '/icons/icon-192.png' }); // same tag as the phone alert: you never get two
    }
  }
  sortConversations();
  renderConversationList();
}

function onMessageChanged(m) {
  if (activeConv && activeConv.id === m.conversationId) {
    upsertMessage(m);
    renderMessages();
  }
  scheduleListRefresh();
}

function onMessagesRead({ conversationId, readerId, readAt }) {
  if (readerId === me.id || !activeConv || activeConv.id !== conversationId) return;
  messages.forEach((m) => {
    if (m.senderId === me.id && !m.readAt) m.readAt = readAt;
  });
  renderMessages();
}

async function markActiveRead() {
  if (!activeConv || document.hidden) return;
  try {
    await api('POST', `/api/conversations/${activeConv.id}/read`);
    activeConv.unread = 0;
    renderConversationList();
  } catch {
    /* not important */
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) markActiveRead();
});

// ---------- edit / delete (only your own messages; the server checks again) ----------
async function editMessage(m) {
  const text = window.prompt('Edit message', m.text);
  if (text === null) return;
  try {
    const data = await api('PATCH', `/api/messages/${m.id}`, { text });
    upsertMessage(data.message);
    renderMessages();
    scheduleListRefresh();
  } catch (err) {
    showToast(errorText(err));
  }
}

async function deleteMessage(m) {
  if (!window.confirm('Delete this message for everyone?')) return;
  try {
    const data = await api('DELETE', `/api/messages/${m.id}`);
    upsertMessage(data.message);
    renderMessages();
    scheduleListRefresh();
  } catch (err) {
    showToast(errorText(err));
  }
}

// ============================================================
// SEND (text, or file + caption)
// ============================================================
function showFilePreview(file) {
  pendingFile = file;
  filePreviewName.textContent = file.name;
  filePreviewSize.textContent = formatSize(file.size);
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  filePreviewThumb.replaceChildren();

  if (file.type.startsWith('image/')) {
    previewObjectUrl = URL.createObjectURL(file);
    filePreviewThumb.append(el('img', { src: previewObjectUrl, alt: '' }));
  } else {
    filePreviewThumb.textContent = file.type.startsWith('video/') ? '🎬' : file.type.startsWith('audio/') ? '🎵' : '📄';
  }
  filePreview.classList.add('show');
  messageInput.placeholder = 'Add a caption...';
  messageInput.focus();
}

function clearFilePreview() {
  pendingFile = null;
  attachmentInput.value = '';
  filePreview.classList.remove('show');
  filePreviewThumb.replaceChildren();
  messageInput.placeholder = 'Type a message...';
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
}

attachmentInput.addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    showToast('File is too big. Maximum is ' + formatSize(MAX_FILE_SIZE) + '.');
    this.value = '';
    return;
  }
  showFilePreview(file);
});
$('file-preview-cancel').addEventListener('click', clearFilePreview);

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

async function sendMessage() {
  if (!activeConv || isSending) return;
  const text = messageInput.value.trim();
  if (!text && !pendingFile) return;

  isSending = true;
  sendBtn.disabled = true;
  try {
    const url = `/api/conversations/${activeConv.id}/messages`;
    let data;
    if (pendingFile) {
      const fd = new FormData();
      fd.append('text', text);
      fd.append('file', pendingFile);
      data = await api('POST', url, fd, true);
    } else {
      data = await api('POST', url, { text });
    }

    const m = data.message;
    if (!messages.some((x) => x.id === m.id)) {
      messages.push(m);
      renderMessages();
      scrollToBottom();
    }
    activeConv.lastMessage = {
      text: m.text.slice(0, 80),
      attachmentName: m.attachment ? m.attachment.name : null,
      deleted: false,
      mine: true,
      createdAt: m.createdAt
    };
    activeConv.lastMessageAt = m.createdAt;
    sortConversations();
    renderConversationList();

    messageInput.value = '';
    clearFilePreview();
    stopTyping();
  } catch (err) {
    showToast(errorText(err));
  } finally {
    isSending = false;
    sendBtn.disabled = false;
  }
}

// ---------- typing indicator (only the other member of this conversation receives it) ----------
function stopTyping() {
  clearTimeout(typingIdleTimer);
  if (typingSent && socket && activeConv) socket.emit('typing', { conversationId: activeConv.id, isTyping: false });
  typingSent = false;
}

messageInput.addEventListener('input', () => {
  if (!socket || !activeConv) return;
  if (!typingSent) {
    typingSent = true;
    socket.emit('typing', { conversationId: activeConv.id, isTyping: true });
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, 3000);
});
messageInput.addEventListener('blur', stopTyping);

// ---------- call buttons ----------
function requestCall(kind) {
  startCall(kind === 'voice' ? 'audio' : 'video'); // a real WebRTC call (see the CALLS block at the bottom of this file)
}
$('voice-call-btn').addEventListener('click', () => requestCall('voice'));
$('video-call-btn').addEventListener('click', () => requestCall('video'));

// ============================================================
// EDIT PROFILE
// ============================================================
$('edit-profile-btn').addEventListener('click', () => {
  if (!me) return;
  $('edit-name-input').value = me.name || '';
  $('edit-phone-input').value = me.phone || '';
  $('edit-current-password').value = '';
  $('edit-new-password').value = '';
  $('edit-error').textContent = '';
  editAvatarData = null;
  setAvatar(editPreview, me.avatarUrl);
  editModal.classList.add('show');
});

$('cancel-edit-btn').addEventListener('click', () => editModal.classList.remove('show'));

$('edit-file-input').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  resizeImage(file, 200, (data) => {
    editAvatarData = data;
    editPreview.src = data;
  });
});

$('save-edit-btn').addEventListener('click', async () => {
  const errBox = $('edit-error');
  errBox.textContent = '';
  const body = { name: $('edit-name-input').value, phone: $('edit-phone-input').value };
  if (editAvatarData) body.avatar = editAvatarData;
  if ($('edit-new-password').value) {
    body.newPassword = $('edit-new-password').value;
    body.currentPassword = $('edit-current-password').value;
  }
  try {
    const data = await api('PATCH', '/api/auth/me', body);
    me = data.user;
    if (body.newPassword) syncPushSubscription(); // other devices were signed out: register this one again
    setAvatar(myAvatar, me.avatarUrl);
    editModal.classList.remove('show');
    showToast('Profile updated');
  } catch (err) {
    errBox.textContent = errorText(err);
  }
});

// ============================================================
// INSTALLABLE APP (PWA): lets Chrome / Edge install the chat like a normal app
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* not important: the chat works without it */
    });
  });
}

// ============================================================
// PICTURE VIEWER (opens a picture inside the app, with a Download button)
// ============================================================
const viewerEl = $('viewer');
const viewerImg = $('viewer-img');
let viewerMessage = null;

function openViewer(m) {
  viewerMessage = m;
  viewerImg.src = m.attachment.url;
  viewerImg.alt = m.attachment.name;
  $('viewer-name').textContent = m.attachment.name;
  viewerEl.classList.add('show');
}
function closeViewer() {
  viewerEl.classList.remove('show');
  viewerImg.removeAttribute('src');
  viewerMessage = null;
}
$('viewer-close').addEventListener('click', closeViewer);
$('viewer-download').addEventListener('click', () => {
  if (viewerMessage) downloadAttachment(viewerMessage);
});
viewerEl.addEventListener('click', (e) => {
  if (e.target === viewerEl) closeViewer();
});

// ============================================================
// SETTINGS
// ============================================================
const settingsPanel = $('settings-panel');
const SERVER_SETTING_KEYS = ['readReceipts', 'showOnline', 'showTyping', 'discoverableByPhone'];

function updateNotifyStatus() {
  const box = $('notify-status');
  if (!('Notification' in window)) {
    box.textContent = 'This browser cannot show notifications.';
    return;
  }
  box.textContent =
    Notification.permission === 'denied'
      ? 'Notifications are blocked. Allow them in your browser or phone settings for this site.'
      : Notification.permission === 'granted'
        ? 'Notifications are allowed on this device.'
        : 'Not asked yet. Turn the switch on to allow them.';
}

function fillSettings() {
  SERVER_SETTING_KEYS.forEach((k) => {
    $('set-' + k).checked = !!(me && me.settings && me.settings[k]);
  });
  $('set-sound').checked = deviceSettings.sound;
  $('set-notify').checked = deviceSettings.notify && 'Notification' in window && Notification.permission === 'granted';
  $('set-preview').checked = deviceSettings.preview;
  $('set-text-size').value = String(deviceSettings.textSize);
  $('set-pattern').checked = deviceSettings.pattern;
  $('set-allow-zoom').checked = deviceSettings.allowZoom;
  $('about-text').textContent = `${APP_NAME} · version ${APP_VERSION}`;
  updateNotifyStatus();
  $('set-push').checked = deviceSettings.push && pushReady();
  $('set-ring').checked = deviceSettings.ring;
  $('set-relay').checked = deviceSettings.relay;
  updatePushStatus();
}

function openSettings() {
  if (!me) return;
  fillSettings();
  settingsPanel.classList.add('show');
}
function closeSettings() {
  settingsPanel.classList.remove('show');
}
$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
settingsPanel.addEventListener('click', (e) => {
  if (e.target === settingsPanel) closeSettings();
});

// Privacy switches live on the SERVER (they change what other people see)
SERVER_SETTING_KEYS.forEach((key) => {
  $('set-' + key).addEventListener('change', async (e) => {
    const box = e.target;
    const wanted = box.checked;
    try {
      const data = await api('PATCH', '/api/settings', { [key]: wanted });
      me.settings = data.settings;
      showToast('Saved');
    } catch (err) {
      box.checked = !wanted; // put the switch back if saving failed
      showToast(errorText(err));
    }
  });
});

// Device switches live only on this phone / computer
function deviceSwitch(id, key) {
  $(id).addEventListener('change', (e) => {
    deviceSettings[key] = e.target.checked;
    saveDeviceSettings();
    applyDeviceSettings();
  });
}
deviceSwitch('set-sound', 'sound');
deviceSwitch('set-preview', 'preview');
deviceSwitch('set-pattern', 'pattern');
deviceSwitch('set-allow-zoom', 'allowZoom');

$('set-text-size').addEventListener('change', (e) => {
  const size = Number(e.target.value);
  if (!TEXT_SIZES.includes(size)) return;
  deviceSettings.textSize = size;
  saveDeviceSettings();
  applyDeviceSettings();
});

$('set-notify').addEventListener('change', async (e) => {
  const box = e.target;
  if (!box.checked) {
    deviceSettings.notify = false;
    saveDeviceSettings();
    updateNotifyStatus();
    return;
  }
  if (!('Notification' in window)) {
    box.checked = false;
    updateNotifyStatus();
    return;
  }
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  deviceSettings.notify = permission === 'granted';
  box.checked = deviceSettings.notify;
  saveDeviceSettings();
  updateNotifyStatus();
});

$('set-edit-profile').addEventListener('click', () => {
  closeSettings();
  $('edit-profile-btn').click();
});
$('set-logout').addEventListener('click', () => $('logout-btn').click());
$('set-logout-all').addEventListener('click', async () => {
  if (!window.confirm('Log out of ALL devices, including this one?')) return;
  try {
    await api('POST', '/api/auth/logout-all');
  } catch {
    /* ignore: the page reloads anyway */
  }
  window.location.reload();
});
$('set-reset').addEventListener('click', () => {
  if (!window.confirm('Reset the notification, text size and zoom settings on this device?')) return;
  disablePush().catch(() => {}); // the reset turns alerts off, so stop them on the server too
  deviceSettings = { ...DEVICE_DEFAULTS };
  saveDeviceSettings();
  applyDeviceSettings();
  fillSettings();
  showToast('Device settings reset');
});

// "Install this app" button (Chrome and Edge show it when the app can be installed)
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('install-btn').style.display = 'block';
});
$('install-btn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  try {
    await installEvent.userChoice;
  } catch {
    /* ignore */
  }
  installEvent = null;
  $('install-btn').style.display = 'none';
});
window.addEventListener('appinstalled', () => {
  $('install-btn').style.display = 'none';
});

// ============================================================
// CONTACTS (find people from your phone book who already use the app)
// ============================================================
const contactsPanel = $('contacts-panel');
const pickBtn = $('pick-contacts-btn');
// The phone's contact picker exists in Chrome on Android. Other browsers get the "type numbers" box.
const canPickContacts = 'contacts' in navigator && 'ContactsManager' in window;

function closeContacts() {
  contactsPanel.classList.remove('show');
}

$('contacts-btn').addEventListener('click', () => {
  if (!me) return;
  $('contacts-error').textContent = '';
  $('contacts-results').replaceChildren();
  pickBtn.style.display = canPickContacts ? 'block' : 'none';
  $('contacts-support').textContent = canPickContacts
    ? ''
    : 'This browser cannot open your phone contacts (it works in Chrome on Android). Type phone numbers below instead.';
  contactsPanel.classList.add('show');
});
$('contacts-close').addEventListener('click', closeContacts);
contactsPanel.addEventListener('click', (e) => {
  if (e.target === contactsPanel) closeContacts();
});

// entries = [{ name, phone }]. The names stay on this device; only the numbers are sent.
async function findContacts(entries) {
  const list = $('contacts-results');
  const err = $('contacts-error');
  list.replaceChildren();
  err.textContent = '';
  entries = entries.slice(0, 300);
  if (entries.length === 0) {
    err.textContent = 'No phone numbers to check.';
    return;
  }
  try {
    const data = await api('POST', '/api/contacts/match', { phones: entries.map((e) => e.phone) });
    if (data.matches.length === 0) {
      list.append(el('li', { class: 'list-note', text: 'None of these contacts use this app yet.' }));
    }
    data.matches.forEach((m) => {
      const local = m.indexes.map((i) => entries[i] && entries[i].name).find(Boolean) || '';
      list.append(
        el('li', { class: 'chat-item', onclick: () => { closeContacts(); startChatWith(m.user.id); } },
          avatarImg(m.user.avatarUrl),
          el('div', { class: 'chat-info' },
            el('div', { class: 'chat-name', text: m.user.name }),
            el('div', { class: 'chat-preview', text: local ? `In your contacts: ${local}` : 'Tap to start a private chat' })))
      );
    });
    if (data.invalid > 0) {
      list.append(el('li', { class: 'list-note', text: `${data.invalid} item(s) were not valid phone numbers.` }));
    }
  } catch (e) {
    err.textContent = errorText(e);
  }
}

pickBtn.addEventListener('click', async () => {
  try {
    // The phone shows its own contact list; we only receive the contacts the user selects
    const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    const entries = [];
    picked.forEach((c) => (c.tel || []).forEach((t) => entries.push({ name: (c.name && c.name[0]) || '', phone: t })));
    await findContacts(entries);
  } catch (e) {
    if (e && e.name !== 'AbortError') $('contacts-error').textContent = 'Could not open your contacts.';
  }
});

$('contacts-find-btn').addEventListener('click', () => {
  const entries = $('contacts-manual')
    .value.split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((phone) => ({ name: '', phone }));
  findContacts(entries);
});

// Escape closes any open panel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeViewer();
    closeSettings();
    closeContacts();
  }
});

// ============================================================
// CALLS (real audio and video calls with WebRTC)
// The set-up messages go through the server (Socket.IO). The sound and the picture go directly between the two
// phones, or through a TURN relay when a direct path is not possible.
// ============================================================
const callOverlay = $('call-overlay');
const remoteVideo = $('remote-video');
const localVideo = $('local-video');

let call = null; // the call in progress (or ringing)
let ringTimer = null;
let audioCtx = null;

const FALLBACK_ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], hasTurn: false };

function canCall() {
  return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function callErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow the microphone (and camera) for this site in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone or camera was found on this device.';
  if (name === 'NotReadableError') return 'The microphone or camera is being used by another app.';
  return 'Could not start the call.';
}

function callStartError(code, name) {
  if (code === 'busy') return `${name} is busy right now.`;
  if (code === 'already_in_call') return 'You are already in a call.';
  if (code === 'forbidden') return 'You cannot call this person.';
  if (code === 'rate_limited') return 'Too many calls. Please wait a minute.';
  return 'Could not start the call. Please try again.';
}

function openMedia(kind) {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
  });
}

async function loadIce() {
  try {
    return await api('GET', '/api/calls/ice'); // STUN and (if set up) TURN servers
  } catch {
    return FALLBACK_ICE;
  }
}

// ---------- ring tone ----------
function stopRingtone() {
  if (ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  if (navigator.vibrate) navigator.vibrate(0);
}

function startRingtone(outgoing) {
  stopRingtone();
  if (!deviceSettings.ring) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const beep = () => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = outgoing ? 425 : 520;
      gain.gain.value = outgoing ? 0.05 : 0.12;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);
    };
    beep();
    ringTimer = setInterval(beep, outgoing ? 3000 : 1600);
    if (!outgoing && navigator.vibrate) navigator.vibrate([400, 200, 400, 1000, 400, 200, 400]);
  } catch {
    /* no sound: the call still works */
  }
}

// ---------- the call screen ----------
function setCallStatus(text) {
  $('call-status').textContent = text;
}

function showCallUi() {
  if (!call) return;
  const ringingForMe = call.role === 'callee' && call.state === 'ringing';
  $('call-name').textContent = call.partner.name;
  setAvatar($('call-avatar'), call.partner.avatarUrl);
  callOverlay.classList.add('show');
  callOverlay.classList.toggle('video', call.kind === 'video');
  callOverlay.classList.toggle('incoming', ringingForMe);
  callOverlay.classList.toggle('active', !ringingForMe);
  $('call-camera-btn').style.display = call.kind === 'video' ? '' : 'none';
  $('call-flip-btn').style.display = call.kind === 'video' ? '' : 'none';
}

function newCall({ role, kind, conversationId, partner, id, offer }) {
  return {
    id: id || null,
    role,
    kind,
    conversationId,
    partner,
    offer: offer || null,
    state: role === 'callee' ? 'ringing' : 'calling',
    pc: null,
    localStream: null,
    remoteStream: null,
    outIce: [], // network candidates found before the server gave the call an id
    inIce: [], // network candidates received before the other side's description was set
    cancelled: false,
    startedAt: 0,
    timer: null,
    ringTimeout: null,
    dropTimer: null,
    facing: 'user'
  };
}

// Stops everything: tracks, connection, sounds, screen
function endCallLocally() {
  const c = call;
  call = null;
  stopRingtone();
  if (!c) return;
  clearTimeout(c.ringTimeout);
  clearTimeout(c.dropTimer);
  clearInterval(c.timer);
  if (c.pc) {
    c.pc.onicecandidate = null;
    c.pc.ontrack = null;
    c.pc.onconnectionstatechange = null;
    try {
      c.pc.close();
    } catch {
      /* already closed */
    }
  }
  if (c.localStream) c.localStream.getTracks().forEach((t) => t.stop());
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  callOverlay.classList.remove('show', 'incoming', 'active', 'video', 'remote-on');
}

function attachLocal(c) {
  localVideo.srcObject = c.localStream;
  const p = localVideo.play && localVideo.play();
  if (p && p.catch) p.catch(() => {});
}

function startCallTimer(c) {
  c.startedAt = Date.now();
  stopRingtone();
  showCallUi();
  const tick = () => {
    const s = Math.floor((Date.now() - c.startedAt) / 1000);
    setCallStatus(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
  };
  tick();
  c.timer = setInterval(tick, 1000);
}

// ---------- the connection ----------
function sendIce(c, cand) {
  const j = typeof cand.toJSON === 'function' ? cand.toJSON() : cand;
  const candidate = { candidate: j.candidate, sdpMid: j.sdpMid, sdpMLineIndex: j.sdpMLineIndex, usernameFragment: j.usernameFragment || null };
  if (c.id && socket) socket.emit('call:ice', { callId: c.id, candidate });
  else c.outIce.push(candidate);
}

function makePeer(c, ice) {
  const pc = new RTCPeerConnection({
    iceServers: ice.iceServers,
    iceTransportPolicy: deviceSettings.relay && ice.hasTurn ? 'relay' : 'all' // "relay" hides this device's network address
  });
  pc.onicecandidate = (e) => {
    if (e.candidate) sendIce(c, e.candidate);
  };
  pc.ontrack = (e) => {
    c.remoteStream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
    remoteVideo.srcObject = c.remoteStream;
    callOverlay.classList.toggle('remote-on', c.kind === 'video');
    const p = remoteVideo.play && remoteVideo.play();
    if (p && p.catch) p.catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (call !== c) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      clearTimeout(c.dropTimer);
      c.state = 'active';
      if (!c.startedAt) startCallTimer(c);
    } else if (s === 'disconnected') {
      setCallStatus('Reconnecting…');
      clearTimeout(c.dropTimer);
      c.dropTimer = setTimeout(() => {
        if (call === c && pc.connectionState !== 'connected') {
          showToast('The call was disconnected.');
          hangUp();
        }
      }, 12000);
    } else if (s === 'failed') {
      showToast('The call could not connect. Check your internet and try again.');
      hangUp();
    }
  };
  c.pc = pc;
  return pc;
}

async function flushRemoteIce(c) {
  const list = c.inIce.splice(0);
  for (const cand of list) {
    try {
      await c.pc.addIceCandidate(cand);
    } catch {
      /* ignore one bad candidate */
    }
  }
}

// ---------- start a call (the caller) ----------
async function startCall(kind) {
  if (!activeConv) return;
  if (call) {
    showToast('You are already in a call.');
    return;
  }
  if (!socket || !socket.connected) {
    showToast('Not connected. Please try again in a moment.');
    return;
  }
  if (!canCall()) {
    showToast('This browser cannot make calls. Try Chrome, Edge, Firefox or Safari.');
    return;
  }
  if (window.isSecureContext === false) {
    showToast('Calls need a secure (https) address.');
    return;
  }

  const c = newCall({ role: 'caller', kind, conversationId: activeConv.id, partner: activeConv.partner });
  call = c;
  showCallUi();
  setCallStatus('Starting…');
  try {
    const stream = await openMedia(kind); // the browser asks for the microphone (and camera)
    if (call !== c) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    c.localStream = stream;
    attachLocal(c);
    const ice = await loadIce();
    if (call !== c) return;
    const pc = makePeer(c, ice);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    await pc.setLocalDescription(await pc.createOffer());
    if (call !== c) return;

    setCallStatus('Calling…');
    startRingtone(true);
    const waitForServer = setTimeout(() => {
      if (call === c && !c.id) {
        showToast('Could not reach the server. Please try again.');
        endCallLocally();
      }
    }, 10000);
    socket.emit('call:start', { conversationId: c.conversationId, kind, sdp: pc.localDescription.sdp }, (res) => {
      clearTimeout(waitForServer);
      if (!res || !res.ok) {
        if (call === c) {
          showToast(callStartError(res && res.error, c.partner.name));
          endCallLocally();
        }
        return;
      }
      c.id = res.callId;
      if (c.cancelled || call !== c) {
        socket.emit('call:hangup', { callId: res.callId }); // the person gave up before the server answered
        return;
      }
      c.outIce.splice(0).forEach((candidate) => socket.emit('call:ice', { callId: c.id, candidate }));
    });
  } catch (err) {
    if (call === c) {
      showToast(callErrorText(err));
      endCallLocally();
    }
  }
}

// ---------- answer a call (the person who is called) ----------
function onIncomingCall(d) {
  if (!d || typeof d !== 'object' || typeof d.callId !== 'string' || typeof d.offer !== 'string' || (d.kind !== 'audio' && d.kind !== 'video')) return;
  if (call) {
    if (call.id === d.callId) return; // the same call again (after a reconnect)
    if (socket) socket.emit('call:reject', { callId: d.callId }); // already in another call
    return;
  }
  const conv = conversations.find((x) => x.id === d.conversationId);
  const partner = conv ? conv.partner : { id: d.from, name: 'Someone', avatarUrl: '' };
  const c = newCall({ role: 'callee', kind: d.kind, conversationId: d.conversationId, partner, id: d.callId, offer: d.offer });
  call = c;
  showCallUi();
  setCallStatus(d.kind === 'video' ? 'Incoming video call' : 'Incoming audio call');
  startRingtone(false);
  c.ringTimeout = setTimeout(() => {
    if (call === c && c.state === 'ringing') endCallLocally();
  }, 50000);
  if (!conv) {
    loadConversations().then(() => {
      const k = conversations.find((x) => x.id === d.conversationId);
      if (k && call === c) {
        c.partner = k.partner;
        showCallUi();
      }
    });
  }
  if (document.hidden && deviceSettings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(partner.name, {
        body: d.kind === 'video' ? 'Incoming video call' : 'Incoming audio call',
        tag: 'call-' + d.conversationId,
        requireInteraction: true,
        icon: '/icons/icon-192.png'
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* ignore */
    }
  }
}

async function acceptCall() {
  const c = call;
  if (!c || c.role !== 'callee' || c.state !== 'ringing') return;
  stopRingtone();
  clearTimeout(c.ringTimeout);
  c.state = 'connecting';
  showCallUi();
  setCallStatus('Connecting…');
  try {
    const stream = await openMedia(c.kind);
    if (call !== c) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    c.localStream = stream;
    attachLocal(c);
    const ice = await loadIce();
    if (call !== c) return;
    const pc = makePeer(c, ice);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    await pc.setRemoteDescription({ type: 'offer', sdp: c.offer });
    await flushRemoteIce(c);
    await pc.setLocalDescription(await pc.createAnswer());
    if (call !== c) return;
    socket.emit('call:accept', { callId: c.id, sdp: pc.localDescription.sdp }, (res) => {
      if (!res || !res.ok) {
        if (call === c) {
          showToast('This call is no longer available.');
          endCallLocally();
        }
      }
    });
  } catch (err) {
    if (call === c) {
      showToast(callErrorText(err));
      if (c.id && socket) socket.emit('call:reject', { callId: c.id });
      endCallLocally();
    }
  }
}

function declineCall() {
  const c = call;
  if (!c) return;
  if (c.id && socket) socket.emit('call:reject', { callId: c.id });
  endCallLocally();
}

function hangUp() {
  const c = call;
  if (!c) return;
  if (c.id && socket) socket.emit('call:hangup', { callId: c.id });
  else c.cancelled = true; // the server does not know this call yet: it is cancelled as soon as the server answers
  endCallLocally();
}

// ---------- messages from the other person (through the server) ----------
async function onCallAccepted(d) {
  const c = call;
  if (!c || !d || d.callId !== c.id || c.role !== 'caller' || !c.pc || typeof d.answer !== 'string') return;
  try {
    stopRingtone();
    c.state = 'connecting';
    setCallStatus('Connecting…');
    showCallUi();
    await c.pc.setRemoteDescription({ type: 'answer', sdp: d.answer });
    await flushRemoteIce(c);
  } catch {
    if (call === c) {
      showToast('The call could not connect.');
      hangUp();
    }
  }
}

async function onRemoteIce(d) {
  const c = call;
  if (!c || !d || d.callId !== c.id || !d.candidate) return;
  if (c.pc && c.pc.remoteDescription) {
    try {
      await c.pc.addIceCandidate(d.candidate);
    } catch {
      /* ignore one bad candidate */
    }
  } else {
    c.inIce.push(d.candidate); // kept until the other side's description is set
  }
}

function endedText(reason, c) {
  const name = c.partner.name;
  if (reason === 'rejected') return `${name} declined the call.`;
  if (reason === 'timeout') return c.role === 'caller' ? `${name} did not answer.` : `Missed call from ${name}.`;
  if (reason === 'cancelled') return `Missed call from ${name}.`;
  if (reason === 'hangup') return 'Call ended.';
  if (reason === 'disconnected') return 'The call was disconnected.';
  if (reason === 'answered_elsewhere') return 'Answered on another device.';
  return '';
}

function onCallEnded(d) {
  const c = call;
  if (!c || !d || d.callId !== c.id) return;
  const text = endedText(d.reason, c);
  endCallLocally();
  if (text) showToast(text);
}

function registerCallSocketEvents(sock) {
  sock.on('call:incoming', onIncomingCall);
  sock.on('call:accepted', onCallAccepted);
  sock.on('call:ice', onRemoteIce);
  sock.on('call:ended', onCallEnded);
}

// ---------- buttons on the call screen ----------
function toggleMute() {
  if (!call || !call.localStream) return;
  const tracks = call.localStream.getAudioTracks();
  const enable = tracks.some((t) => !t.enabled);
  tracks.forEach((t) => {
    t.enabled = enable;
  });
  const btn = $('call-mute-btn');
  btn.classList.toggle('off', !enable);
  btn.title = enable ? 'Mute microphone' : 'Unmute microphone';
}

function toggleCamera() {
  if (!call || !call.localStream) return;
  const tracks = call.localStream.getVideoTracks();
  const enable = tracks.some((t) => !t.enabled);
  tracks.forEach((t) => {
    t.enabled = enable;
  });
  const btn = $('call-camera-btn');
  btn.classList.toggle('off', !enable);
  btn.title = enable ? 'Turn camera off' : 'Turn camera on';
}

async function flipCamera() {
  const c = call;
  if (!c || !c.localStream || !c.pc) return;
  const facing = c.facing === 'user' ? 'environment' : 'user';
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    const track = fresh.getVideoTracks()[0];
    const sender = c.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && track) await sender.replaceTrack(track);
    c.localStream.getVideoTracks().forEach((t) => {
      t.stop();
      c.localStream.removeTrack(t);
    });
    c.localStream.addTrack(track);
    c.facing = facing;
    attachLocal(c);
  } catch {
    showToast('Could not switch the camera.');
  }
}

$('call-accept-btn').addEventListener('click', acceptCall);
$('call-decline-btn').addEventListener('click', declineCall);
$('call-hangup-btn').addEventListener('click', hangUp);
$('call-mute-btn').addEventListener('click', toggleMute);
$('call-camera-btn').addEventListener('click', toggleCamera);
$('call-flip-btn').addEventListener('click', flipCamera);

// The server sends phone alerts only when the app is NOT in front of the person, so it needs to know
function emitVisibility() {
  if (socket && socket.connected) socket.emit('visibility', { visible: !document.hidden });
}
document.addEventListener('visibilitychange', emitVisibility);

// ============================================================
// PHONE ALERTS (Web Push): alerts when the app is closed or in another tab
// ============================================================
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushReady = () => pushSupported && Notification.permission === 'granted';

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameBytes(a, b) {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function updatePushStatus() {
  const box = $('push-status');
  const ios = /iphone|ipad|ipod/i.test((navigator && navigator.userAgent) || '');
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (navigator && navigator.standalone);
  if (!pushSupported) {
    box.textContent = ios && !standalone
      ? 'On iPhone: add this app to your Home Screen first (Share, then Add to Home Screen), then open it from there.'
      : 'This browser cannot receive alerts when the app is closed.';
  } else if (Notification.permission === 'denied') {
    box.textContent = 'Notifications are blocked. Allow them in your browser or phone settings for this site.';
  } else {
    box.textContent = deviceSettings.push && Notification.permission === 'granted'
      ? 'On. You get alerts even when the app is closed.'
      : 'Off. Turn it on to get alerts when the app is closed.';
  }
}

// Registers THIS device for alerts. Returns '' when it worked, or a message that explains the problem.
async function enablePush() {
  if (!pushSupported) return 'This browser cannot receive alerts when the app is closed.';
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'Notifications are blocked for this site. Allow them in your browser or phone settings.';

  const keyData = await api('GET', '/api/push/key');
  if (!keyData.enabled) return 'Alerts when the app is closed are not switched on on the server yet.';

  const reg = await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(keyData.publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options && sub.options.applicationServerKey && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe(); // it was made with an older server key
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), preview: deviceSettings.preview });
  return '';
}

async function disablePush() {
  if (!pushSupported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  try {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  } catch {
    /* ignore */
  }
  await sub.unsubscribe();
}

// After login: make sure this device is registered for the account that just logged in
async function syncPushSubscription() {
  if (!pushSupported || !deviceSettings.push || Notification.permission !== 'granted') return;
  try {
    await enablePush();
  } catch {
    /* alerts are optional: ignore */
  }
}

// On logout: this device stops getting this account's alerts (it registers again at the next login)
async function forgetThisDeviceForPush() {
  if (!pushSupported) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  } catch {
    /* ignore */
  }
}

$('set-push').addEventListener('change', async (e) => {
  const box = e.target;
  try {
    if (box.checked) {
      const problem = await enablePush();
      if (problem) {
        box.checked = false;
        deviceSettings.push = false;
        showToast(problem);
      } else {
        deviceSettings.push = true;
        showToast('Alerts are on, even when the app is closed.');
      }
    } else {
      await disablePush();
      deviceSettings.push = false;
    }
  } catch (err) {
    box.checked = !box.checked;
    showToast(errorText(err));
  }
  saveDeviceSettings();
  updatePushStatus();
});

// the "show message text" choice also belongs to this device's alerts
$('set-preview').addEventListener('change', () => {
  if (deviceSettings.push) syncPushSubscription();
});
$('set-ring').addEventListener('change', (e) => {
  deviceSettings.ring = e.target.checked;
  saveDeviceSettings();
});
$('set-relay').addEventListener('change', (e) => {
  deviceSettings.relay = e.target.checked;
  saveDeviceSettings();
});

// Tapping an alert: open that chat (the page may already be open, or be opened by the alert)
function openConversationById(id) {
  if (!me) return;
  if (conversations.some((c) => c.id === id)) {
    openConversation(id);
    return;
  }
  loadConversations().then(() => {
    if (conversations.some((c) => c.id === id)) openConversation(id);
  });
}

function openConversationFromUrl() {
  let id = '';
  try {
    id = new URLSearchParams(window.location.search).get('c') || '';
  } catch {
    id = '';
  }
  if (!/^[a-f0-9]{24}$/i.test(id)) return;
  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch {
    /* ignore */
  }
  openConversationById(id);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = (e && e.data) || {};
    if (d.type === 'notification-click' && me && /^[a-f0-9]{24}$/i.test(String(d.conversationId || ''))) openConversationById(d.conversationId);
    if (d.type === 'push-resubscribe') syncPushSubscription();
  });
}