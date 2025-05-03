const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    path: '/socket.io'
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let pot = 0;
let players = [];
let timer = 240;
let interval;
let users = new Set();

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

function startTimer() {
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

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    socket.on('join', (username) => {
        socket.username = username;
        users.add(username);
        io.emit('users update', Array.from(users));
        io.emit('user joined', { user: username });
        console.log('Usuario unido:', username);
    });

    socket.on('compete', ({ username }) => {
        if (!players.find(p => p.username === username)) {
            players.push({ username, socketId: socket.id });
            pot += 100;
            timer = 240; // Reiniciar temporizador al participar
            io.emit('timer update', { seconds: timer, pot });
            startTimer();
        }
    });

    socket.on('chat message', ({ user, message, type }) => {
        io.emit('chat message', { user, message, type });
    });

    socket.on('leave', (username) => {
        users.delete(username);
        io.emit('user left', { user: username });
        io.emit('users update', Array.from(users));
        console.log('Usuario salió:', username);
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            users.delete(socket.username);
            io.emit('user left', { user: socket.username });
            io.emit('users update', Array.from(users));
            console.log('Usuario desconectado:', socket.username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
