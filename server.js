const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    path: '/socket.io'
});

// Configuración del bot de Telegram
const TELEGRAM_BOT_TOKEN = '7860281561:AAHKvL7YS14JMb7TdGERGCkiY-dAz_BjKKo'; // Reemplaza con el token de @BotFather
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Almacenamiento en memoria (reemplaza con base de datos si es necesario)
const users = {};
const verificationCodes = {};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Registro de usuario
app.post('/register', (req, res) => {
    const { username, password } = req.body;

    if (users[username]) {
        return res.status(400).json({ detail: 'El usuario ya existe' });
    }

    // Generar código de verificación
    const verificationCode = Math.random().toString(36).substr(2, 8).toUpperCase();
    verificationCodes[username] = verificationCode;

    // Guardar usuario (sin verificar)
    users[username] = {
        password,
        coins: 1000,
        policiesAccepted: false,
        policiesVersion: '',
        telegramVerified: false,
        telegramChatId: null
    };

    // Enviar mensaje al usuario (puedes usar Telegram aquí si ya tienes chatId, o mostrar en UI)
    res.json({ message: `Usuario registrado. Envía este código a @MiVerificadorBot: ${verificationCode}` });
});

// Login de usuario
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const user = users[username];
    if (!user || user.password !== password) {
        return res.status(400).json({ detail: 'Credenciales incorrectas' });
    }

    if (!user.telegramVerified) {
        return res.status(400).json({ detail: 'Debes verificar tu cuenta con el bot de Telegram' });
    }

    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2);
    res.json({
        success: true,
        sessionId,
        policiesAccepted: user.policiesAccepted,
        policiesVersion: user.policiesVersion,
        telegramVerified: user.telegramVerified
    });
});

// Bot de Telegram
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '¡Hola! Registra tu cuenta en la aplicación y envíame el código de verificación.');
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const code = msg.text.trim().toUpperCase();

    // Ignorar comandos como /start
    if (code.startsWith('/')) return;

    // Buscar usuario con el código
    let verifiedUsername = null;
    for (const [username, storedCode] of Object.entries(verificationCodes)) {
        if (storedCode === code) {
            verifiedUsername = username;
            break;
        }
    }

    if (verifiedUsername && users[verifiedUsername]) {
        users[verifiedUsername].telegramVerified = true;
        users[verifiedUsername].telegramChatId = chatId;
        delete verificationCodes[verifiedUsername];
        bot.sendMessage(chatId, '¡Cuenta verificada exitosamente! Ahora puedes iniciar sesión.');
    } else {
        bot.sendMessage(chatId, 'Código incorrecto. Por favor, verifica e intenta de nuevo.');
    }
});

// Lógica del juego (mantenida de tu server.js original)
const gameState = {
    pot: 0,
    seconds: 240,
    lastWinner: null,
    players: []
};

setInterval(() => {
    if (gameState.seconds > 0) {
        gameState.seconds -= 1;
        io.emit('timer update', { seconds: gameState.seconds, pot: gameState.pot, winner: null });
    } else {
        if (gameState.players.length > 0) {
            const winnerIndex = Math.floor(Math.random() * gameState.players.length);
            const winner = gameState.players[winnerIndex];
            const playerWinAmount = Math.round(gameState.pot * 0.89);
            users[winner].coins += playerWinAmount;
            gameState.lastWinner = winner;
            gameState.pot = Math.round(gameState.pot * 0.06);
            io.emit('timer update', { seconds: 0, pot: gameState.pot, winner });
        }
        gameState.seconds = 240;
        gameState.players = [];
        io.emit('timer update', { seconds: gameState.seconds, pot: gameState.pot, winner: null });
    }
}, 1000);

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    socket.on('join', (username) => {
        socket.username = username;
        io.emit('user joined', { user: username });
        io.emit('users update', Object.keys(users).filter(u => users[u].telegramVerified));
    });

    socket.on('compete', ({ username }) => {
        if (users[username] && users[username].telegramVerified && !gameState.players.includes(username)) {
            if (users[username].coins >= 100) {
                users[username].coins -= 100;
                gameState.pot += 100;
                gameState.players.push(username);
                io.emit('timer update', { seconds: gameState.seconds, pot: gameState.pot, winner: null });
            }
        }
    });

    socket.on('chat message', ({ user, message, type }) => {
        io.emit('chat message', { user, message, type });
    });

    socket.on('leave', (username) => {
        io.emit('user left', { user: username });
        io.emit('users update', Object.keys(users).filter(u => users[u].telegramVerified));
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            io.emit('user left', { user: socket.username });
            io.emit('users update', Object.keys(users).filter(u => users[u].telegramVerified));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
