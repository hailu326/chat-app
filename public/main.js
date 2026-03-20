const socket =io("http://localhost:3000",{})

const clientsTotal =document.getElementById('client-total')

socket.on('clients-total',(data) =>{
  clientsTotal.innerText ='Total clients:${data}'
})