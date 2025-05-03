const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Permitir todas las conexiones en desarrollo
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Servir index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Manejar conexiones de Socket.IO
io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);

  // Enviar lista de usuarios conectados
  const users = Array.from(io.sockets.sockets.keys());
  io.emit('users', users);

  // Manejar mensajes de chat
  socket.on('chatMessage', (msg) => {
    io.emit('chatMessage', { id: socket.id, message: msg });
  });

  // Manejar mensajes de voz
  socket.on('voiceMessage', (audio) => {
    io.emit('voiceMessage', { id: socket.id, audio });
  });

  // Manejar desconexión
  socket.on('disconnect', () => {
    console.log('Usuario desconectado:', socket.id);
    const users = Array.from(io.sockets.sockets.keys());
    io.emit('users', users);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
