const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const mercadopago = require('mercadopago');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Configurar Mercado Pago
mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN || 'TU_ACCESS_TOKEN',
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint para crear preferencia de pago
app.post('/create-preference', async (req, res) => {
  try {
    const { neig } = req.body;
    if (!neig || neig <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const pesos = parseFloat(neig); // 1 Neig = $1
    const preference = {
      items: [
        {
          title: 'Neighborcoin',
          quantity: 1,
          unit_price: pesos,
          currency_id: 'ARS',
        },
      ],
      back_urls: {
        success: 'https://neigame.onrender.com/success',
        failure: 'https://neigame.onrender.com/failure',
        pending: 'https://neigame.onrender.com/pending',
      },
      auto_return: 'approved',
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({ init_point: response.body.init_point });
  } catch (error) {
    console.error('Error al crear preferencia:', error);
    res.status(500).json({ error: 'Error al crear preferencia' });
  }
});

// Socket.IO
let pot = 0;
let players = [];
let timer = 240;
let interval;

function selectWinner() {
  if (players.length > 0) {
    const winnerIndex = Math.floor(Math.random() * players.length);
    return players[winnerIndex];
  }
  return null;
}

function resetGame() {
  const winner = selectWinner();
  io.emit('timer update', { seconds: 0, pot, winner: winner ? winner.username : null });
  pot = 0;
  players = [];
  timer = 240;
}

io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);

  socket.on('join', (username) => {
    socket.username = username;
    const users = Array.from(io.sockets.sockets.values()).map(s => s.username).filter(u => u);
    io.emit('users update', users);
    io.emit('user joined', { user: username });
  });

  socket.on('compete', ({ username, amount }) => {
    if (!players.find(p => p.username === username)) {
      players.push({ username, socketId: socket.id });
      pot += amount;
      io.emit('timer update', { seconds: timer, pot });
      if (!interval) {
        interval = setInterval(() => {
          timer -= 0.01;
          io.emit('timer update', { seconds: timer, pot });
          if (timer <= 0) {
            resetGame();
            clearInterval(interval);
            interval = null;
          }
        }, 10);
      }
    }
  });

  socket.on('chat message', ({ user, message, type }) => {
    io.emit('chat message', { user, message, type });
  });

  socket.on('leave', (username) => {
    io.emit('user left', { user: username });
    const users = Array.from(io.sockets.sockets.values()).map(s => s.username).filter(u => u && u !== username);
    io.emit('users update', users);
  });

  socket.on('disconnect', () => {
    console.log('Usuario desconectado:', socket.id);
    if (socket.username) {
      io.emit('user left', { user: socket.username });
      const users = Array.from(io.sockets.sockets.values()).map(s => s.username).filter(u => u && u !== socket.username);
      io.emit('users update', users);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
