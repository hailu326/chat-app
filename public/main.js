// 1. ELEMENTOOTA HUNDA GUBBAA IRRATTI TOKKO QOFA DECLARE GODHI
const signupForm = document.getElementById('signup-form');
const signupPage = document.getElementById('signup-page');
const chatMain = document.querySelector('.main');
const chatTitle = document.querySelector('.title');
const clientsTotal = document.getElementById('clients-total');
const nameInput = document.getElementById('name-input');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const messageContainer = document.getElementById('message-container');
const messageTone = document.getElementById('message-tone');
const fileInput = document.getElementById('file-input');
const previewImg = document.getElementById('preview');
const chatAvatar =document.getElementById('chat-avatar');

fileInput.onchange = function(evt) {
    const [file] = this.files;
    if (file) {
        previewImg.src = URL.createObjectURL(file);
    }
};

// 2. SIGNUP LOGIC
signupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    
    if (username.trim() === '') { // Maqaan duwwaa hin ta'uu mirkaneessi
        alert("Maaloo maqaa guutuu galchi!");
        return; // Kana booda hin deemne
    }
    
    nameInput.value = username; // Maqaa galmeessite chat keessa galchi
    chatAvatar.src =previewImg.src;

    signupPage.style.display = 'none'; // Signup dhoksi
    chatTitle.style.display = 'block'; // Chat Room mul'isi
    chatMain.style.display = 'block';
    if (clientsTotal) clientsTotal.style.display = 'block'; // ClientsTotal jira ta'e mul'isi
});

// 3. SUURAA PROFILE PREVIEW GOCHUUF (KANA AMMA SIRRIITTI HOJJETA)
if (fileInput && previewImg) {
    fileInput.addEventListener('change', function() {
        const file = this.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                previewImg.src = e.target.result;
            };
            reader.readAsDataURL(file);
        } else {
            previewImg.src = "default-avatar.png"; // Default suuraa deebisi
        }
    });
}

// 4. SOCKET.IO LOGIC
const socket = io();

let isTabActive = true;
document.addEventListener('visibilitychange', () => {
    isTabActive = !document.hidden;
});

if (Notification.permission !== "granted") {
    Notification.requestPermission();
}

messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
});

socket.on('clients-total', (data) => {
    clientsTotal.innerText = `Total clients: ${data}`;
});

function sendMessage() {
    if (messageInput.value.trim() === '') return; // Ergaa duwwaa hin ergin
    
    const data = {
        name: nameInput.value,
        message: messageInput.value,
        profile: previewImg.src,
        dateTime: new Date()
    };
    
    socket.emit('chat-message', data);
    addMessageToUI(true, data);
    messageInput.value = '';
}

socket.on('chat-message', (data) => {
    if(data.name === nameInput.value) return; // Ergaa ofiitii yoo ta'e hin fudhatin
    
    messageTone.play();
    addMessageToUI(false, data); // Kanaafuu `false` godhi, kan birootii waan ta'eef
    
    if (!isTabActive && Notification.permission === "granted") {
        new Notification(`New message: ${data.name}`, {
            body: data.message,
            icon: '/favicon.ico'
        });
    }
});

function addMessageToUI(isOwnMessage, data) {
    clearFeedback(); // Feedback delete godhi
    
    const element = `
            <li class="${isOwnMessage ? 'message-right' : 'message-left'}" style="list-style: none;">
                <div style="display: flex; align-items: flex-end; flex-direction: ${isOwnMessage ? 'row-reverse' : 'row'}; margin-bottom: 10px;">
                    <!-- Suuraa Profile (Sarara 114) -->
                    <img src="${data.profile}" style="width: 35px; height: 35px; border-radius: 50%; margin: 0 8px; object-fit: cover;">
                    
                    <!-- Bubble Ergaa (Sarara 115-118) -->
                    <div style="background: ${isOwnMessage ? '#2d2d2d' : '#fff'}; color: ${isOwnMessage ? '#fff' : '#000'}; padding: 10px 15px; border-radius: 20px; max-width: 250px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                        <p style="margin: 0;">${data.message}</p>
                        <!-- Sarara 117: Maqaan keessaa badeera, yeroo qofatu hafe -->
                        <span style="font-size: 10px; opacity: 0.6; display: block; margin-top: 5px; text-align: right;">
                            ${moment(data.dateTime).format('LT')}
                        </span>
                    </div>
                </div>
            </li>`;

    messageContainer.innerHTML += element;
    scrollToBottom();
}
socket.on('update-user-list', (users) => {
    const userListUI = document.getElementById('users-online');
    userListUI.innerHTML = ''; // Qulqulleessi
    users.forEach(user => {
        userListUI.innerHTML += `
            <li style="padding: 5px; display: flex; align-items: center; cursor: pointer;">
                <img src="${user.profile}" style="width: 25px; height: 25px; border-radius: 50%; margin-right: 10px;">
                <span style="font-size: 14px;">${user.name}</span>
            </li>`;
    });
});
signupForm.addEventListener('submit', (e) => {
    
    socket.emit('new-user-joined', { name: nameInput.value, profile: previewImg.src });
});
function scrollToBottom() {
    messageContainer.scrollTo(0, messageContainer.scrollHeight);
}

function clearFeedback() {
    // Namni barreessaa jira ta'ee feedback delete godhi
    const feedbackElement = document.querySelector('.message-feedback');
    if (feedbackElement) {
        feedbackElement.parentNode.removeChild(feedbackElement);
    }
}

// Namni barreessuu jalqabe
messageInput.addEventListener('focus', () => {
    socket.emit('feedback', {
        feedback: `✍️ ${nameInput.value} is typing a message`
    });
});

// Namni barreessuu dhiise (yoo input irraa xiqqaate)
messageInput.addEventListener('blur', () => {
    socket.emit('feedback', {
        feedback: '' // feedback dhabamsiisi
    });
});

// Server irraa feedback yoo dhufe
socket.on('feedback', (data) => {
    const feedbackElement = document.querySelector('.message-feedback');
    if (data.feedback) {
        if (feedbackElement) {
            feedbackElement.innerHTML = `<p class="feedback">${data.feedback}</p>`;
        } else {
            // Yoo feedback element hin jiraanne, haaraa uumi
            const newFeedbackElement = document.createElement('li');
            newFeedbackElement.classList.add('message-feedback');
            newFeedbackElement.innerHTML = `<p class="feedback">${data.feedback}</p>`;
            messageContainer.appendChild(newFeedbackElement);
        }
    } else {
        // Yoo feedback hin jirre, elementicha kaasi
        if (feedbackElement) {
            feedbackElement.parentNode.removeChild(feedbackElement);
        }
    }
});

