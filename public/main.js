// 1. ELEMENTOOTA HUNDA GUBBAA IRRATTI TOKKO QOFA DECLARE GODHI
const socket = io();
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
const chatAvatar = document.getElementById('chat-avatar');
const loginPage = document.getElementById('login-page');
const loginForm = document.getElementById('login-form');
const userListPage = document.getElementById('user-list-page');
const usersOnlineList = document.getElementById('users-online');
let currentUser = null; // Eenyummaa nama seenee qabachuuf
// Elementoota Edit Profile
const editModal = document.getElementById('edit-profile-modal');
const editBtn = document.getElementById('edit-profile-btn');
const cancelEdit = document.getElementById('cancel-edit-btn');
const saveEdit = document.getElementById('save-edit-btn');
const editNameField = document.getElementById('edit-name-input');
const editPhoneField = document.getElementById('edit-phone-input')
const editPasswordField = document.getElementById('edit-password-input');
const editPreview = document.getElementById('edit-preview');
const editFileInp = document.getElementById('edit-file-input');
document.getElementById('voice-call-btn').onclick = () => {
    startVoiceCall();
};

document.getElementById('video-call-btn').onclick = () => {
    startVideoCall();
};
document.getElementById('camera-btn').onclick = () => {
    document.getElementById('camera-input').click();
};
const cameraInp = document.getElementById('camera-input');
const cameraBtn = document.getElementById('camera-btn');

cameraBtn.onclick = () => {
    cameraInp.click();
};

cameraInp.onchange = function() {
    const file = this.files[0];
    if (file) {
        const fileURL = URL.createObjectURL(file);
        
        // Preview agarsiisuuf (previewImg kanaan dura qabda ta'a)
        if (previewImg) {
            previewImg.src = fileURL;
            previewImg.style.display = 'block';
        }

        // Amma 'sendMessage()' waamuu dandeessa ykn namni 'Send' akka cuqaasu eeguu dandeessa
        console.log("File captured: ", file.name);
    }
};



// Button "Back" (Gara User List-itti deebi'uuf)
const backBtn = document.getElementById('back-btn');
if(backBtn) {
    backBtn.onclick = () => {
        chatMain.style.display = 'none';
        userListPage.style.display = 'block';
    };
}

// User List keessatti "li" yeroo uumamu (Updated click logic)
// socket.on('update-user-list', (users) => {
//     usersOnlineList.innerHTML = '';
//     users.forEach(user => {
//         if (user.name !== currentUser.name) {
//             const li = document.createElement('li');
//             li.innerHTML = `
//                 <img src="${user.profile}" class="header-avatar">
//                 <div>
//                     <strong style="display:block;">${user.name}</strong>
//                     <span style="font-size:12px; color:gray;">Tap to chat</span>
//                 </div>
//             `;
//             li.onclick = () => {
//                 userListPage.style.display = 'none';
//                 chatMain.style.display = 'flex'; // Block dhiisii flex godhi
//                 chatAvatar.src = user.profile;
//                 document.getElementById('chat-with-name').innerText = user.name;
//             };
//             usersOnlineList.appendChild(li);
//         }
//     });
// });

// 1. Button Edit yeroo tuqamu modal bani
editBtn.onclick = () => {
    editModal.style.display = 'flex';
    editNameField.value = currentUser.name;
    editPreview.src = currentUser.profile;
    editPhoneField.value = currentUser.editPhoneField;
    editPasswordField.value = currentUser .editPasswordField;
};

// 2. Modal cufi
cancelEdit.onclick = () => editModal.style.display = 'none';

// 3. Suuraa jijjiiruu (Preview)
editFileInp.onchange = function() {
    const file = this.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => editPreview.src = e.target.result;
        reader.readAsDataURL(file);
    }
};

// 4. SAVE GOCHUU
saveEdit.onclick = () => {
    const newName = editNameField.value;
    const newProfile = editPreview.src;
    const newPhone = editPhoneField.value;
    const newPassword = editPasswordField.value;

    if (newName.trim() === "") return alert("Maqaa galchi!");

    // currentUser Update godhi
    currentUser.name = newName;
    currentUser.profile = newProfile;
    currentUser.phone = newPhone;
    // LocalStorage update godhi
    localStorage.setItem('chat-user-token', JSON.stringify(currentUser));

    // UI irratti jijjiiri
    document.getElementById('chat-with-name').innerText = newName;
    document.getElementById('chat-avatar').src = newProfile;

    // Server-tti beeksisi (Database akka jijjiiru)
    socket.emit('update-profile', currentUser);

    editModal.style.display = 'none';
    alert("Profile Updated Successfully!");
};


window.addEventListener('load', () => {
    const token = localStorage.getItem('chat-user-token');
    if (token) {
        currentUser = JSON.parse(token);
        enterUserList(); // Ofumaan seensisi
    }
});




fileInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        previewImg.src = e.target.result;
    };
    reader.readAsDataURL(file);
});
sendMessage();

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

   // signupPage.style.display = 'none'; // Signup dhoksi
       // Koodii kee isa kanaan duraa keessatti kana bakka buusi
    currentUser = { name: username, profile: previewImg.src };
    localStorage.setItem('chat-user-token', JSON.stringify(currentUser)); // Token save godhi
    enterUserList(); 


  
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

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // Server-tti ergi (Kun server irratti hunda'a)
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

function enterUserList() {
    signupPage.style.display = 'none';
    chatMain.style.display = 'block';
    if(loginPage) loginPage.style.display = 'none';
    userListPage.style.display = 'block';
    nameInput.value = currentUser.name;
    socket.emit('new-user-joined', currentUser);
}

function logoutUser() {
    localStorage.removeItem('chat-user-token');
    socket.emit('logout-user');
    window.location.reload();
}


// 4. SOCKET.IO LOGIC
//const socket = io();

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

async function sendMessage() {
    if (!currentUser) {
    alert("Please login first");
    return;
}
    let fileData = null;

    // 1. File yoo jiraate dura upload godhi
    if (fileInput.files.length > 0) {
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);

        // HUBADHU: Mobile-n akka arguuf 'localhost' bakka IP address computer keetiin buusi
        const res = await fetch('http://localhost:3000/uploads', {
            method: 'POST',
            body: formData
        });

        if (res.ok) {
            fileData = await res.json();
        } else {
            console.log("Upload failed");
            return;
        }
    }

    // Ergaa duwwaa yoo ta'e dhiisi
    if (messageInput.value.trim() === '' && !fileData) return;
    
    const data = {
        name: currentUser.name,
        message: messageInput.value,
        profile: currentUser.profile || '/default-avatar.png', // Profile nama ergee qofa
        dateTime: new Date(),
        type: fileData ? 'file' : 'text',
        fileUrl: fileData ? fileData.fileUrl : null, // Fakkii/Vidiyoo ergame
        fileName: fileData ? fileData.fileName : null
    };
    
    socket.emit('chat-message', data);
    addMessageToUI(true, data); // Ofuma keetiif agarsiisi

    // 2. Erga ergitee booda qulqulleessi (Reset)
    messageInput.value = '';
    fileInput.value = '';
    if (typeof previewImg !== 'undefined') previewImg.src = "/default-avatar.png"; 
}

socket.off('chat-message');
socket.on('chat-message', (data) => {
    //if (data.userId === socket.id) return;// Ergaa ofiitii yoo ta'e hin fudhatin
    
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
    clearFeedback(); 
    let fileContent = '';

    // 1. Media Type Check (Image, Video, Audio, PDF)
    if (data.type === 'file' && data.fileUrl) {
        const fileExt = data.fileUrl.split('.').pop().toLowerCase();

        if (['jpg', 'jpeg', 'png', 'gif'].includes(fileExt)) {
            fileContent = `<img src="${data.fileUrl}" style="max-width:100%; border-radius:10px; display:block; margin-bottom:5px;">`;
        } 
        else if (['mp4', 'webm'].includes(fileExt)) {
            fileContent = `
            <video controls style="max-width:100%; border-radius:10px; display:block; margin-bottom:5px;">
                <source src="${data.fileUrl}">
            </video>`;
        } 
        else {
            fileContent = `<div style="background:#f1f1f1; padding:8px; border-radius:5px; margin-bottom:5px;">
                <a href="${data.fileUrl}" target="_blank" download style="color:#007bff; font-weight:bold; text-decoration:none;">
                    📄 ${data.fileName || 'View File'}
                </a>
            </div>`;
        }
    }

    // 2. UI Layout (Akkuma suuraa 2ffaa sanaatti bareechuuf)
    const element = `
        <li class="${isOwnMessage ? 'message-right' : 'message-left'}" style="list-style:none; margin-bottom:15px; display:flex; flex-direction: ${isOwnMessage ? 'row-reverse' : 'row'}; align-items: flex-end;">
            
            <!-- PROFILE: data.profile qofa fayyadamna -->
            <img src="${data.profile || 'default-avatar.png'}" style="width: 35px; height: 35px; border-radius: 50%; margin: 0 8px; object-fit: cover;">
            
            <div style="background: ${isOwnMessage ? '#dcf8c6' : '#ffffff'}; 
                        color: #000; 
                        padding: 10px 15px; 
                        border-radius: ${isOwnMessage ? '15px 15px 0 15px' : '15px 15px 15px 0'}; 
                        max-width: 250px; 
                        box-shadow: 0 1px 2px rgba(0,0,0,0.2);">
                
                <span style="font-size: 11px; font-weight: bold; color: #555; display: block; margin-bottom: 3px;">${data.name}</span>
                
                ${fileContent} <!-- Image/Video asitti bama -->
                
                <p style="margin: 0; word-wrap: break-word;">${data.message || ''}</p>
                
                <span style="font-size: 10px; opacity: 0.6; display: block; text-align: right; margin-top: 5px;">
                    ${moment(data.dateTime).format('LT')}
                </span>
            </div>
        </li>`;

    messageContainer.innerHTML += element;
    scrollToBottom();
}


socket.on('update-user-list', (users) => {
    const userListUI = document.getElementById('users-online'); // ID kana HTML irratti mirkaneessi
    if (!userListUI) return; 

    userListUI.innerHTML = ''; // Dura qulqulleessi

    users.forEach(user => {
        // Ofii kee akka list irratti of hin argine
        if (user.name !== currentUser.name) { 
            const li = document.createElement('li');
            li.style = "padding: 10px; display: flex; align-items: center; cursor: pointer; border-bottom: 1px solid #eee; transition: 0.3s;";
            
            // Mouse irra yeroo deemu halluu akka jijjiiru (optional)
            li.onmouseover = () => li.style.background = "#f5f5f5";
            li.onmouseout = () => li.style.background = "transparent";

            li.innerHTML = `
                <img src="${user.profile}" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 12px; object-fit: cover;">
                <span style="font-size: 16px; font-weight: 500;">${user.name}</span>
            `;

            // --- NAMA FILATAME WALIIN CHAT JALQABUU ---
            li.onclick = () => {
                // 1. Fuula filannoo (User list) dhoksi
                userListPage.style.display = 'none';
                
                // 2. Chat room (.main) mul'isi
                chatMain.style.display = 'block';
                messageContainer.innerHTML = '';
                
                // 3. Suuraa nama filatamee sanaa Header irratti galchi
                chatAvatar.src = user.profile || 'default-avatar.png';
                
                // 4. Maqaa isaa Header irratti barreessi
                const chatHeaderName = document.getElementById('chat-with-name');
                if (chatHeaderName) {
                    chatHeaderName.innerText = user.name;
                }
            };
            userListUI.appendChild(li); // Elementii 'li' HTML keessa galchi
        }
    });
}); // <--- Cufinsa koodii isa citee


//  signupForm.addEventListener('submit', (e) => {
//      e.preventDefault();
//      const username = document.getElementById('username').value;
//      currentUser ={name:username,profile:previewImg.src};
//      localStorage.setItem('chat-user-token', JSON.stringify(currentUser));
    
//      socket.emit('new-user-joined', { name: currentUser.name, profile: currentUser.profile });
//      enterUserList();
//  });
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
        feedback: `✍️ ${currentUser.name } is typing a message`
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
socket.on('load-old-messages', (messages) => {
    messages.forEach(data =>{
        const isOwnMessage = data.name === currentUser.name;
        addMessageToUI(isOwnMessage, data);
    });
});
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
