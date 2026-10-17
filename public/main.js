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
  setAvatar(myAvatar, me.avatarUrl);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  connectSocket();
  loadConversations();
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
    loadConversations();
    if (activeConv) loadMessages(activeConv.id);
  });
  socket.on('message:new', onIncomingMessage);
  socket.on('message:edited', onMessageChanged);
  socket.on('message:deleted', onMessageChanged);
  socket.on('message:read', onMessagesRead);
  socket.on('conversation:new', () => loadConversations());
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
  socket.on('call:incoming', ({ conversationId, kind }) => {
    const conv = conversations.find((c) => c.id === conversationId);
    showToast(`${conv ? conv.partner.name : 'Someone'} is calling (${kind}). Calls are not built yet.`);
  });

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

function renderAttachment(m) {
  const a = m.attachment;
  if (a.mime.startsWith('image/')) {
    return el('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, el('img', { src: a.url, class: 'att-img', alt: a.name, loading: 'lazy' }));
  }
  if (a.mime.startsWith('video/')) return el('video', { src: a.url, controls: '', preload: 'metadata', class: 'att-video' });
  if (a.mime.startsWith('audio/')) return el('audio', { src: a.url, controls: '', preload: 'none', class: 'att-audio' });
  return el('a', { href: a.url, download: a.name, class: 'att-file' },
    el('span', { class: 'att-icon', text: '📄' }),
    el('span', { class: 'att-name', text: a.name }),
    el('span', { class: 'att-size', text: formatSize(a.size) }));
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
    messageTone.play().catch(() => {});
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(conv.partner.name, { body: m.text || '📎 ' + (m.attachment ? m.attachment.name : 'File') });
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
  if (!socket || !activeConv) return;
  socket.emit('call:request', { conversationId: activeConv.id, kind });
  showToast(`Calling ${activeConv.partner.name}... (calls are not built yet)`);
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
    setAvatar(myAvatar, me.avatarUrl);
    editModal.classList.remove('show');
    showToast('Profile updated');
  } catch (err) {
    errBox.textContent = errorText(err);
  }
});
