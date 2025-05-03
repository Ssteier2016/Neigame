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
    origin: '*', // Permitir todas las conexiones en desarrollo
    methods: ['GET', 'POST'],
  },
});

// Configurar Mercado Pago
mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN || 'TU_ACCESS_TOKEN', // Usar variable de entorno
});

app.use(cors());
app.use(express.json()); // Para parsear JSON
app.use(express.static(path.join(__dirname, 'public')));

// Servir index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint para crear preferencia de pago
app.post('/create-preference', async (req, res) => {
  try {
    const { neig } = req.body; // Monto en Neig enviado desde el frontend
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

// Manejar conexiones de Socket.IO
io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);
  const users = Array.from(io.sockets.sockets.keys());
  io.emit('users', users);

  socket.on('chatMessage', (msg) => {
    io.emit('chatMessage', { id: socket.id, message: msg });
  });

  socket.on('voiceMessage', (audio) => {
    io.emit('voiceMessage', { id: socket.id, audio });
  });

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
