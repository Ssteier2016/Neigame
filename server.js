const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: 'https://neigame.onrender.com',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

app.use(cors({
    origin: 'https://neigame.onrender.com',
    methods: ['GET', 'POST'],
    credentials: true
}));
app.use(express.static(__dirname));

let users = [];
let pot = 0;
let timer = null;
let seconds = 240;
let participants = [];

function startTimer() {
    if (timer) {
        clearInterval(timer);
    }
    seconds = 240; // Reiniciar a 240 segundos
    timer = setInterval(() => {
        seconds -= 0.1;
        if (seconds <= 0) {
            endRound();
        }
        io.emit('timer update', { seconds, pot, winner: null });
    }, 100);
}

function endRound() {
    clearInterval(timer);
    timer = null;
    let winner = null;
    if (participants.length > 0) {
        winner = participants[Math.floor(Math.random() * participants.length)];
        const playerWinAmount = Math.round(pot * 0.89);
        const potLeftover = Math.round(pot * 0.11); // 11% restante (6% desarrollador + 5% sobrante)
        pot = potLeftover;
        participants = [];
        seconds = 240;
        io.emit('timer update', { seconds, pot, winner });
    } else {
        pot = 0;
        seconds = 240;
        io.emit('timer update', { seconds, pot, winner: null });
    }
}

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        if (!users.includes(username)) {
            users.push(username);
            io.emit('user joined', { user: username });
            io.emit('users update', users);
        }
        socket.emit('timer update', { seconds, pot, winner: null });
    });

    socket.on('chat message', ({ user, message, type }) => {
        io.emit('chat message', { user, message, type });
    });

    socket.on('compete', ({ username, amount }) => {
        if (!users.includes(username)) {
            users.push(username);
        }
        if (!participants.includes(username)) {
            participants.push(username);
            pot += amount;
            startTimer();
            io.emit('timer update', { seconds, pot, winner: null });
        }
    });

    socket.on('leave', (username) => {
        users = users.filter((u) => u !== username);
        io.emit('user left', { user: username });
        io.emit('users update', users);
    });

    socket.on('disconnect', () => {
        io.emit('users update', users);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
