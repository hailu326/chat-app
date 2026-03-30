

const socket =io();

const clientsTotal =document.getElementById('clients-total')
const messageContainer = document.getElementById('message-container')
const nameInput =  document.getElementById('name-input')
const messageForm = document.getElementById('message-form')
const messageInput =  document.getElementById('message-input')
//const messageTone = new Audio('/universfieid-new-notification-021-370045.mp3')
const messageTone =document.getElementById('message-tone')

let isTabActive =true;
document.addEventListener('visibilitychange',()=>{
  isTabActive=!document.hidden;
});
if (Notification.permission !=="granted"){
  Notification.requestPermission();
}

messageForm.addEventListener('submit',(e)=>{
  e.preventDefault();
  sendMessage()
})

socket.on('clients-total',(data) =>{
  clientsTotal.innerText =`Total clients:${data}`
})

function sendMessage(){
  console.log(messageInput.value)
  const data ={
    name: nameInput.value,
    message: messageInput.value,
    dateTime: new Date()
  }
  socket.emit('chat-message',data)
    addMessageToUI(true,data)
    messageInput.value =''
}
socket.on('chat-message', (data)=>{
  //console.log(data)
  messageTone.play()
  addMessageToUI(false, data);
  if (!isTabActive && Notification.permission ==="granted"){
    new Notification(`new message:${data.name}`,{
      body:data.message,
      icon:'/favicon.ico'
    })
  }
});
function addMessageToUI(isOwnMessage, data) {
  clearFeedback()
    const element = `
        <li class="${isOwnMessage ? 'message-right' : 'message-left'}">
            <p class="message">
                ${data.message}
                <span>${data.name} ● ${moment(data.dateTime).fromNow()}</span>
            </p>
        </li>`;

    messageContainer.innerHTML += element; // Ergaa fuula irratti dabalata
    scrollToBottom();
}


function scrollToBottom() {
    messageContainer.scrollTo(0, messageContainer.scrollHeight);
}
messageInput.addEventListener('focus',(e)=>{
  socket.emit('feedback',{
    feedback:`✍️${nameInput.value}is typing a message`
  })
})

messageInput.addEventListener('keypress', (e) => {
 socket.emit('feedback',{
    feedback:`✍️${nameInput.value}is typing a message`,
})
})
messageInput.addEventListener('blur', (e) => {
   socket.emit('feedback',{
    feedback:''
      })
})
 socket.on('feedback', (data)=> {
  clearFeedback()
  const element = `
           <li class="message-feedback">
                <p class="feedback" id="feedback">${data.feedback}</p>
            </li>
 `
messageContainer.innerHTML += element    
})
function clearFeedback(){
  document.querySelectorAll('li.message-feedback').forEach(element=>{
    element.parentNode.removeChild(element)
  })
}
