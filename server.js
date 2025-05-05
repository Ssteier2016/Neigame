const express = require('express');
const bcrypt = require('bcrypt');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const socketIo = require('socket.io');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    path: '/socket.io',
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const port = process.env.PORT || 3000;
const botToken = '7473215586:AAHSjicOkbWh5FVx_suIiZF9tRdD59dbJG8'; // Reemplaza con tu token real
const adminChatId = '1624130940'; // Reemplaza con tu ID de chat de Telegram

const bot = new TelegramBot(botToken, {
    polling: {
        interval: 1000,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// Manejar errores de polling
bot.on('polling_error', (error) => {
    console.error('Error en polling de Telegram:', error);
});

bot.on('message', (msg) => {
    console.log('Chat ID:', msg.chat.id);
    bot.sendMessage(msg.chat.id, `Tu Chat ID es: ${msg.chat.id}`);
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Base de datos en memoria
const users = {};
const verificationCodes = {};
const stats = {
    clicks: {}, // { username: número de clics }
    winners: [], // [{ username, timestamp, amount }]
    losses: {}, // { username: Neig perdidos }
    topWinners: {}, // { username: número de victorias }
    totalBets: {} // { username: total Neig apostados }
};

// Rutas
app.post('/register', async (req, res) => {
    const { username, password, email } = req.body;
    if (!username || !password || !email) {
        return res.status(400).json({ success: false, detail: 'Usuario, contraseña y email son requeridos' });
    }
    if (users[username]) {
        return res.status(400).json({ success: false, detail: 'El usuario ya existe' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationCode = uuidv4().slice(0, 8);
        users[username] = {
            password: hashedPassword,
            coins: 1000,
            telegramVerified: false,
            verificationCode,
            policiesAccepted: false,
            policiesVersion: null,
            settings: {},
            email,
            bankDetails: { cbu: null, cvu: null, alias: null }
        };
        verificationCodes[verificationCode] = username;
        res.json({ success: true, message: `Código de verificación: ${verificationCode}` });
    } catch (error) {
        console.error('Error al registrar:', error);
        res.status(500).json({ success: false, detail: 'Error interno del servidor' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ success: false, detail: 'Usuario o contraseña incorrectos' });
    }
    if (!user.telegramVerified) {
        return res.status(403).json({
            success: false,
            detail: 'Debes verificar tu cuenta con el bot de Telegram',
            telegramVerified: false
        });
    }
    const sessionId = uuidv4();
    res.json({
        success: true,
        sessionId,
        policiesAccepted: user.policiesAccepted,
        policiesVersion: user.policiesVersion,
        telegramVerified: user.telegramVerified
    });
});

app.get('/user/:username', (req, res) => {
    const user = users[username];
    if (!user) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    res.json({
        success: true,
        coins: user.coins,
        policiesAccepted: user.policiesAccepted,
        policiesVersion: user.policiesVersion,
        settings: user.settings,
        telegramVerified: user.telegramVerified,
        email: user.email,
        bankDetails: user.bankDetails
    });
});

app.post('/update-coins', (req, res) => {
    const { username, coins } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    users[username].coins = coins;
    res.json({ success: true });
});

app.post('/accept-policies', (req, res) => {
    const { username, policiesVersion } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    users[username].policiesAccepted = true;
    users[username].policiesVersion = policiesVersion;
    res.json({ success: true });
});

app.post('/reject-policies', (req, res) => {
    const { username, policiesVersion } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    users[username].policiesAccepted = false;
    users[username].policiesVersion = policiesVersion;
    res.json({ success: true });
});

app.post('/update-settings', (req, res) => {
    const { username, settings } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    users[username].settings = settings;
    res.json({ success: true });
});

app.post('/update-bank-details', (req, res) => {
    const { username, cbu, cvu, alias } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    if (!cbu && !cvu && !alias) {
        return res.status(400).json({ success: false, detail: 'Debe proporcionar al menos un CBU, CVU o alias' });
    }
    users[username].bankDetails = { cbu, cvu, alias };
    res.json({ success: true });
});

app.post('/withdraw', (req, res) => {
    const { username, amount, currency } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    if (amount <= 0 || !Number.isFinite(amount)) {
        return res.status(400).json({ success: false, detail: 'Cantidad inválida' });
    }
    if (amount > users[username].coins) {
        return res.status(400).json({ success: false, detail: 'Saldo insuficiente' });
    }
    if (currency === 'ARS' && !users[username].bankDetails.cbu && !users[username].bankDetails.cvu && !users[username].bankDetails.alias) {
        return res.status(400).json({ success: false, detail: 'Debe proporcionar datos bancarios para retiros en pesos' });
    }
    users[username].coins -= amount;
    const timestamp = new Date().toLocaleString('es-ES');
    const bankDetails = users[username].bankDetails;
    const notificationMessage = `
💸 *Nuevo Retiro*
👤 *Usuario*: ${username}
📅 *Fecha*: ${timestamp}
💰 *Monto*: ${amount} ${currency}
📧 *Email*: ${users[username].email || 'No proporcionado'}
🏦 *Datos Bancarios*:
  - CBU: ${bankDetails.cbu || 'No proporcionado'}
  - CVU: ${bankDetails.cvu || 'No proporcionado'}
  - Alias: ${bankDetails.alias || 'No proporcionado'}
    `;
    bot.sendMessage(adminChatId, notificationMessage, { parse_mode: 'Markdown' })
        .catch(error => {
            console.error('Error al enviar notificación de retiro:', error);
        });
    res.json({ success: true });
});

app.get('/stats', (req, res) => {
    const topWinners = {};
    stats.winners.forEach(winner => {
        topWinners[winner.username] = (topWinners[winner.username] || 0) + 1;
    });
    res.json({
        success: true,
        clicks: stats.clicks,
        winners: stats.winners,
        losses: stats.losses,
        topWinners,
        totalBets: stats.totalBets
    });
});

// Telegram Bot - Verificación
bot.onText(/\/verify (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1].trim();
    const username = verificationCodes[code];
    if (!username) {
        bot.sendMessage(chatId, 'Código de verificación inválido.');
        return;
    }
    users[username].telegramVerified = true;
    delete verificationCodes[code];
    bot.sendMessage(chatId, `¡Cuenta verificada para ${username}! Ahora puedes iniciar sesión.`);
});

// Socket.IO
const connectedUsers = new Set();
const players = [];
let pot = 0;
let timer = 240;
let lastPlayer = null;

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    socket.on('join', (username) => {
        connectedUsers.add(username);
        socket.username = username;
        io.emit('users update', Array.from(connectedUsers));
        io.emit('user joined', { user: username });
        io.to(socket.id).emit('timer update', { seconds: timer, pot, lastPlayer });
    });

    socket.on('compete', ({ username }) => {
        if (!players.includes(username)) {
            players.push(username);
            pot += 100;
            timer = 240;
            lastPlayer = username;
            stats.clicks[username] = (stats.clicks[username] || 0) + 1;
            stats.losses[username] = (stats.losses[username] || 0) + 100;
            stats.totalBets[username] = (stats.totalBets[username] || 0) + 100;
            io.emit('timer update', { seconds: timer, pot, lastPlayer });
        }
    });

    socket.on('chat message', ({ user, message, type }) => {
        io.emit('chat message', { user, message, type });
    });

    socket.on('leave', (username) => {
        connectedUsers.delete(username);
        io.emit('users update', Array.from(connectedUsers));
        io.emit('user left', { user: username });
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            connectedUsers.delete(socket.username);
            io.emit('users update', Array.from(connectedUsers));
            io.emit('user left', { user: socket.username });
        }
        console.log('Usuario desconectado:', socket.id);
    });
});

// Temporizador
setInterval(() => {
    if (timer > 0) {
        timer--;
        io.emit('timer update', { seconds: timer, pot, lastPlayer });
    } else {
        let winner = null;
        if (lastPlayer) {
            winner = lastPlayer;
            const playerWinAmount = Math.round(pot * 0.89);
            if (users[winner]) {
                users[winner].coins += playerWinAmount;
            }
            stats.winners.unshift({
                username: winner,
                timestamp: new Date().toLocaleString('es-ES'),
                amount: playerWinAmount
            });
            if (stats.winners.length > 5) {
                stats.winners.pop();
            }
            stats.losses[winner] = (stats.losses[winner] || 0) - playerWinAmount;
            stats.topWinners[winner] = (stats.topWinners[winner] || 0) + 1;
        }
        io.emit('timer update', { seconds: 0, pot, lastPlayer: winner });
        pot = Math.round(pot * 0.06);
        players.length = 0;
        lastPlayer = null;
        timer = 240;
    }
}, 1000);

// Iniciar servidor
server.listen(port, () => {
    console.log(`Servidor corriendo en el puerto ${port}`);
});

// Manejo de rutas no encontradas
app.use((req, res) => {
    res.status(404).json({ success: false, detail: 'Ruta no encontrada' });
});
