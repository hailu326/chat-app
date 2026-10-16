// ============================================================
// HAILACHO CHAT APP - main.js (v2)
// NEW: send ANY file with a caption (like Telegram), no camera button
// ============================================================
const socket = io();

// ---------- ELEMENTS ----------
const container = document.querySelector('.container');
const signupForm = document.getElementById('signup-form');
const signupPage = document.getElementById('signup-page');
const loginPage = document.getElementById('login-page');
const loginForm = document.getElementById('login-form');
const clientsTotal = document.getElementById('clients-total');
const nameInput = document.getElementById('name-input');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const messageContainer = document.getElementById('message-container');
const messageTone = document.getElementById('message-tone');
const fileInput = document.getElementById('file-input');          // profile photo (signup)
const previewImg = document.getElementById('preview');
const chatAvatar = document.getElementById('chat-avatar');
const userListUI = document.getElementById('users-online');
const backBtn = document.getElementById('back-btn');
const sendBtn = document.querySelector('.send-button');

// File sending
const attachmentInput = document.getElementById('attachment-file-input');
const filePreview = document.getElementById('file-preview');
const filePreviewThumb = document.getElementById('file-preview-thumb');
const filePreviewName = document.getElementById('file-preview-name');
const filePreviewSize = document.getElementById('file-preview-size');
const filePreviewCancel = document.getElementById('file-preview-cancel');

// Edit profile
const editModal = document.getElementById('edit-profile-modal');
const editBtn = document.getElementById('edit-profile-btn');
const cancelEdit = document.getElementById('cancel-edit-btn');
const saveEdit = document.getElementById('save-edit-btn');
const editNameField = document.getElementById('edit-name-input');
const editPhoneField = document.getElementById('edit-phone-input');
const editPasswordField = document.getElementById('edit-password-input');
const editPreview = document.getElementById('edit-preview');
const editFileInp = document.getElementById('edit-file-input');

const MAX_FILE_SIZE = 50 * 1024 * 1024;   // 50 MB (must match server.js)

let currentUser = null;
let pendingFile = null;      // the file chosen with the paperclip
let previewObjectUrl = null;
let isSending = false;
let oldMessages = [];
let isTabActive = true;

// ---------- HELPERS ----------
function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// make a profile photo small so it fits in the socket message
function resizeImage(file, maxSize, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            callback(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function showLogin() {
    signupPage.style.display = 'none';
    loginPage.style.display = 'block';
}

function showSignup() {
    loginPage.style.display = 'none';
    signupPage.style.display = 'block';
}

function openChatView() {
    container.classList.add('chat-open');
}

function closeChatView() {
    container.classList.remove('chat-open');
}

function scrollToBottom() {
    messageContainer.scrollTo(0, messageContainer.scrollHeight);
}

function clearFeedback() {
    const el = document.querySelector('.message-feedback');
    if (el) el.remove();
}

messageContainer.innerHTML = '';

// ---------- CALL BUTTONS ----------
document.getElementById('voice-call-btn').onclick = () => startVoiceCall();
document.getElementById('video-call-btn').onclick = () => startVideoCall();

// ---------- FILE PICKER (PAPERCLIP) ----------
function showFilePreview(file) {
    pendingFile = file;
    filePreviewName.textContent = file.name;
    filePreviewSize.textContent = formatSize(file.size);

    if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
    }

    if (file.type.startsWith('image/')) {
        previewObjectUrl = URL.createObjectURL(file);
        filePreviewThumb.innerHTML = `<img src="${previewObjectUrl}" alt="">`;
    } else if (file.type.startsWith('video/')) {
        filePreviewThumb.textContent = '🎬';
    } else if (file.type.startsWith('audio/')) {
        filePreviewThumb.textContent = '🎵';
    } else {
        filePreviewThumb.textContent = '📄';
    }

    filePreview.classList.add('show');
    messageInput.placeholder = 'Add a caption...';
    messageInput.focus();
}

function clearFilePreview() {
    pendingFile = null;
    attachmentInput.value = '';
    filePreview.classList.remove('show');
    filePreviewThumb.textContent = '📄';
    messageInput.placeholder = 'Type a message...';
    if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
    }
}

attachmentInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
        alert('File is too big. Maximum is ' + formatSize(MAX_FILE_SIZE) + '.');
        this.value = '';
        return;
    }
    showFilePreview(file);
});

filePreviewCancel.onclick = clearFilePreview;

// ---------- BACK BUTTON ----------
if (backBtn) backBtn.onclick = closeChatView;

// ---------- EDIT PROFILE ----------
editBtn.onclick = () => {
    if (!currentUser) return;
    editModal.style.display = 'flex';
    editNameField.value = currentUser.name || '';
    editPreview.src = currentUser.profile || 'default-avatar.png';
    editPhoneField.value = currentUser.phone || '';
    editPasswordField.value = '';
};

cancelEdit.onclick = () => (editModal.style.display = 'none');

editFileInp.onchange = function () {
    const file = this.files[0];
    if (file) resizeImage(file, 200, (data) => (editPreview.src = data));
};

saveEdit.onclick = () => {
    const newName = editNameField.value;
    if (newName.trim() === '') return alert('Maqaa galchi!');

    currentUser.name = newName;
    currentUser.profile = editPreview.src;
    currentUser.phone = editPhoneField.value;

    localStorage.setItem('chat-user-token', JSON.stringify(currentUser));
    document.getElementById('my-profile-img').src = currentUser.profile;
    socket.emit('update-profile', currentUser);

    editModal.style.display = 'none';
    alert('Profile Updated Successfully!');
};

// ---------- AUTO LOGIN ----------
window.addEventListener('load', () => {
    const token = localStorage.getItem('chat-user-token');
    if (token) {
        currentUser = JSON.parse(token);
        enterUserList();
    }
});

// ---------- SIGNUP PHOTO PREVIEW ----------
fileInput.addEventListener('change', function () {
    const file = this.files[0];
    if (file) resizeImage(file, 200, (data) => (previewImg.src = data));
    else previewImg.src = 'default-avatar.png';
});

// ---------- SIGNUP ----------
signupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const phone = document.getElementById('phone').value;

    if (name === '') return alert('Maaloo maqaa guutuu galchi!');
    if (password !== confirmPassword) return alert('Passwords do not match!');

    socket.emit('signup-user', {
        name,
        email,
        phone,
        password,
        profile: previewImg.src
    });
});

// ---------- LOGIN ----------
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('login-user', {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
    });
});

socket.on('auth-success', (userData) => {
    currentUser = userData;
    localStorage.setItem('chat-user-token', JSON.stringify(userData));
    enterUserList();
});

socket.on('auth-error', (msg) => alert(msg));

function enterUserList() {
    signupPage.style.display = 'none';
    loginPage.style.display = 'none';
    closeChatView();
    nameInput.value = currentUser.name;
    document.getElementById('my-profile-img').src = currentUser.profile || 'default-avatar.png';
    socket.emit('new-user-joined', currentUser);
    renderHistory();
}

function logoutUser() {
    localStorage.removeItem('chat-user-token');
    socket.emit('logout-user');
    window.location.reload();
}

// ---------- TAB / NOTIFICATION ----------
document.addEventListener('visibilitychange', () => {
    isTabActive = !document.hidden;
});

if ('Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
}

// ---------- SEND MESSAGE (text, or file + caption) ----------
messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
});

socket.on('clients-total', (data) => {
    clientsTotal.innerText = `Total clients: ${data}`;
});

async function sendMessage() {
    if (!currentUser) {
        alert('Please login first');
        return;
    }
    if (isSending) return;

    const caption = messageInput.value.trim();
    if (caption === '' && !pendingFile) return;

    isSending = true;
    sendBtn.disabled = true;

    try {
        let fileData = null;

        // 1. upload the file first (if there is one)
        if (pendingFile) {
            const formData = new FormData();
            formData.append('file', pendingFile);

            const res = await fetch('/uploads', { method: 'POST', body: formData });

            if (!res.ok) {
                let msg = 'Upload failed';
                try {
                    const err = await res.json();
                    if (err.error) msg = err.error;
                } catch (e) { /* ignore */ }
                alert(msg);
                return;
            }
            fileData = await res.json();
        }

        // 2. send the message (caption = text)
        const data = {
            name: currentUser.name,
            message: caption,
            profile: currentUser.profile || '/default-avatar.png',
            dateTime: new Date(),
            type: fileData ? 'file' : 'text',
            fileUrl: fileData ? fileData.fileUrl : null,
            fileName: fileData ? fileData.fileName : null
        };

        socket.emit('chat-message', data);
        addMessageToUI(true, data);

        // 3. reset
        messageInput.value = '';
        clearFilePreview();

    } catch (err) {
        console.log('Send error:', err);
        alert('Could not send. Please check your connection.');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
    }
}

socket.off('chat-message');
socket.on('chat-message', (data) => {
    messageTone.play().catch(() => {});
    addMessageToUI(false, data);

    if (!isTabActive && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(`New message: ${data.name}`, {
            body: data.message || data.fileName || 'New file',
            icon: '/favicon.ico'
        });
    }
});

// ---------- SHOW MESSAGE ----------
function renderFile(data) {
    if (!data.fileUrl) return '';

    const fileExt = data.fileUrl.split('.').pop().toLowerCase();
    const safeName = escapeHtml(data.fileName || 'file');

    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExt)) {
        return `<a href="${data.fileUrl}" target="_blank">
                    <img src="${data.fileUrl}" style="max-width:100%; border-radius:10px; display:block; margin-bottom:5px;">
                </a>`;
    }
    if (['mp4', 'webm', 'mov'].includes(fileExt)) {
        return `<video controls style="max-width:100%; border-radius:10px; display:block; margin-bottom:5px;">
                    <source src="${data.fileUrl}">
                </video>`;
    }
    if (['mp3', 'wav', 'ogg', 'm4a'].includes(fileExt)) {
        return `<audio controls src="${data.fileUrl}" style="max-width:100%; margin-bottom:5px;"></audio>`;
    }

    // any other file: pdf, doc, zip, ...  -> download card
    return `<a href="${data.fileUrl}" download="${safeName}" target="_blank"
               style="display:flex; align-items:center; gap:10px; background:#f1f1f1; padding:10px; border-radius:8px; margin-bottom:5px; text-decoration:none; color:#111b21;">
                <span style="font-size:28px;">📄</span>
                <span style="font-weight:600; font-size:13px; word-break:break-all;">${safeName}</span>
                <span style="font-size:18px;">⬇️</span>
            </a>`;
}

function addMessageToUI(isOwnMessage, data) {
    clearFeedback();

    const element = `
        <li class="${isOwnMessage ? 'message-right' : 'message-left'}" style="list-style:none; margin-bottom:15px; display:flex; flex-direction:${isOwnMessage ? 'row-reverse' : 'row'}; align-items:flex-end;">
            <img src="${data.profile ? data.profile : '/default-avatar.png'}" style="width:35px; height:35px; border-radius:50%; margin:0 8px; object-fit:cover;">
            <div style="background:${isOwnMessage ? '#dcf8c6' : '#ffffff'};
                        color:#000;
                        padding:10px 15px;
                        border-radius:${isOwnMessage ? '15px 15px 0 15px' : '15px 15px 15px 0'};
                        max-width:280px;
                        box-shadow:0 1px 2px rgba(0,0,0,0.2);">
                <span style="font-size:11px; font-weight:bold; color:#555; display:block; margin-bottom:3px;">${escapeHtml(data.name)}</span>
                ${renderFile(data)}
                ${data.message ? `<p style="margin:0; word-wrap:break-word;">${escapeHtml(data.message)}</p>` : ''}
                <span style="font-size:10px; opacity:0.6; display:block; text-align:right; margin-top:5px;">
                    ${moment(data.dateTime).format('LT')}
                </span>
            </div>
        </li>`;

    messageContainer.insertAdjacentHTML('beforeend', element);
    scrollToBottom();
}

// ---------- OLD MESSAGES ----------
function renderHistory() {
    messageContainer.innerHTML = '';
    if (!currentUser) return;
    oldMessages.forEach((data) => {
        addMessageToUI(data.name === currentUser.name, data);
    });
}

socket.on('load-old-messages', (messages) => {
    oldMessages = messages;
    renderHistory();
});

// ---------- USER LIST ----------
socket.on('update-user-list', (users) => {
    if (!userListUI || !currentUser) return;
    userListUI.innerHTML = '';

    users.forEach((user) => {
        if (user.name === currentUser.name) return;

        const li = document.createElement('li');
        li.innerHTML = `
            <img src="${user.profile || 'default-avatar.png'}" style="width:40px; height:40px; border-radius:50%; margin-right:12px; object-fit:cover;">
            <span style="font-size:16px; font-weight:500;">${escapeHtml(user.name)}</span>
        `;

        li.onclick = () => {
            openChatView();
            chatAvatar.src = user.profile || 'default-avatar.png';
            document.getElementById('chat-with-name').innerText = user.name;
            renderHistory();
        };

        userListUI.appendChild(li);
    });
});

// ---------- TYPING FEEDBACK ----------
messageInput.addEventListener('focus', () => {
    if (!currentUser) return;
    socket.emit('feedback', { feedback: `✍️ ${currentUser.name} is typing a message` });
});

messageInput.addEventListener('blur', () => {
    socket.emit('feedback', { feedback: '' });
});

socket.on('feedback', (data) => {
    const feedbackElement = document.querySelector('.message-feedback');
    if (data.feedback) {
        if (feedbackElement) {
            feedbackElement.innerHTML = `<p class="feedback">${escapeHtml(data.feedback)}</p>`;
        } else {
            const li = document.createElement('li');
            li.classList.add('message-feedback');
            li.innerHTML = `<p class="feedback">${escapeHtml(data.feedback)}</p>`;
            messageContainer.appendChild(li);
            scrollToBottom();
        }
    } else if (feedbackElement) {
        feedbackElement.remove();
    }
});

// ---------- CALLS ----------
function startVoiceCall() {
    socket.emit('voice-call-request', {
        from: currentUser,
        to: document.getElementById('chat-with-name').innerText
    });
}

function startVideoCall() {
    socket.emit('video-call-request', {
        from: currentUser,
        to: document.getElementById('chat-with-name').innerText
    });
}