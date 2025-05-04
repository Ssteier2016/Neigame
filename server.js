const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    path: '/socket.io'
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) {
    console.error('Error: TELEGRAM_BOT_TOKEN o TELEGRAM_ADMIN_CHAT_ID no están definidos');
    process.exit(1);
}

const WEBHOOK_URL = 'https://neigame.onrender.com/telegram-webhook';
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// Configurar webhook
bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log('Webhook configurado exitosamente');
}).catch(err => {
    console.error('Error al configurar webhook:', err);
});

// Endpoint para recibir actualizaciones de Telegram
app.post('/telegram-webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const users = {};
const verificationCodes = {};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ detail: 'Nombre de usuario y contraseña son requeridos' });
    }
    if (users[username]) {
        return res.status(400).json({ detail: 'El usuario ya existe' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.random().toString(36).substr(2, 8).toUpperCase();
    verificationCodes[username] = verificationCode;
    users[username] = {
        password: hashedPassword,
        coins: 1000,
        policiesAccepted: false,
        policiesVersion: '',
        telegramVerified: false,
        telegramChatId: null
    };

    // Enviar código de verificación al administrador
    bot.sendMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `Nuevo registro: ${username}. Código de verificación: ${verificationCode}`
    ).catch(err => {
        console.error('Error al enviar mensaje de Telegram:', err);
    });

    res.json({
        success: true,
        message: `Código de verificación: ${verificationCode}`
    });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (!user || !(await bcrypt.compare(password, user.password))) {
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

app.get('/user/:username', (req, res) => {
    const { username } = req.params;
    const user = users[username];
    if (!user) {
        return res.status(404).json({ detail: 'Usuario no encontrado' });
    }
    res.json({
        username,
        coins: user.coins,
        policiesAccepted: user.policiesAccepted,
        policiesVersion: user.policiesVersion,
        telegramVerified: user.telegramVerified
    });
});

app.post('/update-policies', (req, res) => {
    const { username, policiesAccepted, policiesVersion } = req.body;
    const user = users[username];
    if (!user) {
        return res.status(404).json({ detail: 'Usuario no encontrado' });
    }
    user.policiesAccepted = policiesAccepted;
    user.policiesVersion = policiesVersion;
    res.json({ success: true });
});

app.post('/update-coins', (req, res) => {
    const { username, coins } = req.body;
    const user = users[username];
    if (!user) {
        return res.status(404).json({ detail: 'Usuario no encontrado' });
    }
    user.coins = coins;
    res.json({ success: true });
});

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '¡Hola! Registra tu cuenta en la aplicación y envíame el código de verificación con /verify <código>.');
});

bot.onText(/\/verify (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1].trim().toUpperCase();
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
            io.emit('chat message', {
                user: 'Sistema',
                message: `¡${winner} ganó ${playerWinAmount} Neig!`,
                type: 'text'
            });
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
                io.emit('chat message', {
                    user: 'Sistema',
                    message: `${username} ha apostado 100 Neig.`,
                    type: 'text'
                });
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
