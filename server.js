const express = require('express');
const bcrypt = require('bcrypt');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const socketIo = require('socket.io');
const http = require('http');
const path = require('path');
const mercadopago = require('mercadopago'); // Agregar Mercado Pago

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
const botToken = '7473215586:AAHSjicOkbWh5FVx_suIiZF9tRdD59dbJG8';
const ADMIN_CHAT_ID = '1624130940';

// Configurar Mercado Pago
mercadopago.configure({
    access_token: 'YOUR_MERCADO_PAGO_ACCESS_TOKEN' // Reemplaza con tu access token de Mercado Pago
});

const bot = new TelegramBot(botToken, {
    polling: {
        interval: 1000,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

bot.on('polling_error', (error) => {
    console.error('Error en polling de Telegram:', error);
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Base de datos en memoria
const users = {};
const pendingVerifications = {}; // { username: { chatId: null } }
const telegramChatIds = {}; // { chatId: username }
const stats = {
    clicks: {},
    winners: [],
    losses: {},
    topWinners: {},
    totalBets: {}
};

// Rutas
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, detail: 'Usuario y contraseña son requeridos' });
    }
    if (users[username]) {
        return res.status(400).json({ success: false, detail: 'El usuario ya existe' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        users[username] = {
            password: hashedPassword,
            coins: 1000,
            telegramVerified: false,
            telegramChatId: null,
            policiesAccepted: false,
            policiesVersion: null,
            settings: {}
        };
        pendingVerifications[username] = { chatId: null };
        res.json({ success: true, message: `Registro exitoso. Verifica tu cuenta enviando /start ${username} a @NeigBot en Telegram.` });
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
            detail: 'Debes verificar tu cuenta con el bot de Telegram enviando /start ' + username,
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
    const user = users[req.params.username];
    if (!user) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    res.json({
        success: true,
        coins: user.coins,
        policiesAccepted: user.policiesAccepted,
        policiesVersion: user.policiesVersion,
        settings: user.settings,
        telegramVerified: user.telegramVerified
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
// Ruta para iniciar la recarga con Mercado Pago
app.post('/reload', async (req, res) => {
    const { username, amount } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    if (amount <= 0) {
        return res.status(400).json({ success: false, detail: 'Cantidad inválida' });
    }
    if (!users[username].policiesAccepted || users[username].policiesVersion !== '1.3.0') {
        return res.status(403).json({ success: false, detail: 'Debes aceptar las políticas para recargar Neig' });
    }

    try {
        // Crear preferencia de pago en Mercado Pago
        const preference = {
            items: [
                {
                    title: 'Recarga de Neig',
                    unit_price: parseFloat(amount), // Monto en pesos argentinos (1 Neig = 1 ARS)
                    quantity: 1,
                    currency_id: 'ARS'
                }
            ],
            back_urls: {
                success: 'https://neigame.onrender.com/reload/success',
                failure: 'https://neigame.onrender.com/reload/failure',
                pending: 'https://neigame.onrender.com/reload/pending'
            },
            auto_return: 'approved',
            external_reference: `${username}:${amount}`, // Guardar username y amount para identificar el pago
            notification_url: 'https://neigame.onrender.com/webhook/mercadopago' // Webhook para notificaciones
        };

        const response = await mercadopago.preferences.create(preference);
        res.json({
            success: true,
            payment_url: response.body.init_point // Enlace para redirigir al usuario
        });
    } catch (error) {
        console.error('Error al crear preferencia de Mercado Pago:', error);
        res.status(500).json({ success: false, detail: 'Error al procesar la recarga' });
    }
});

// Webhook para recibir notificaciones de Mercado Pago
app.post('/webhook/mercadopago', async (req, res) => {
    const payment = req.body;
    console.log('Webhook recibido:', payment);

    if (payment.type === 'payment' && payment.data && payment.data.id) {
        try {
            // Consultar el estado del pago
            const paymentInfo = await mercadopago.payment.get(payment.data.id);
            if (paymentInfo.body.status === 'approved') {
                const [username, amount] = paymentInfo.body.external_reference.split(':');
                if (users[username]) {
                    users[username].coins += parseInt(amount);
                    io.emit('coins update', { username, coins: users[username].coins });
                    try {
                        await bot.sendMessage(
                            ADMIN_CHAT_ID,
                            `💰 Recarga exitosa:\nUsuario: ${username}\nCantidad: ${amount} Neig\nFecha: ${new Date().toLocaleString('es-ES')}`
                        );
                    } catch (error) {
                        console.error('Error al notificar recarga:', error);
                    }
                }
            }
        } catch (error) {
            console.error('Error al procesar webhook:', error);
        }
    }
    res.sendStatus(200); // Responder siempre con 200 para evitar reintentos
});

// Rutas de redirección tras el pago
app.get('/reload/success', (req, res) => {
    res.redirect('/?message=Recarga exitosa. Tus Neig han sido acreditados.');
});

app.get('/reload/failure', (req, res) => {
    res.redirect('/?message=Error en la recarga. Intenta nuevamente.');
});

app.get('/reload/pending', (req, res) => {
    res.redirect('/?message=Recarga pendiente. Espera la confirmación del pago.');
});

app.post('/withdraw', async (req, res) => {
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
    users[username].coins -= amount;
    
    try {
        const timestamp = new Date().toLocaleString('es-ES');
        const settings = users[username].settings || {};
        const withdrawalMethod = currency === 'Pesos' 
            ? (settings.cvu || 'No proporcionado')
            : (settings.metamask || 'No proporcionado');
        const methodLabel = currency === 'Pesos' ? 'CBU/CVU/Alias' : 'Dirección MetaMask';
        const message = `📤 Retiro procesado:\n` +
                        `Usuario: ${username}\n` +
                        `Cantidad: ${amount} ${currency}\n` +
                        `${methodLabel}: ${withdrawalMethod}\n` +
                        `Fecha: ${timestamp}`;
        await bot.sendMessage(ADMIN_CHAT_ID, message);
    } catch (error) {
        console.error('Error al enviar notificación de retiro:', error);
    }

    res.json({ success: true });
});

app.post('/reload', (req, res) => {
    const { username, amount } = req.body;
    if (!users[username]) {
        return res.status(404).json({ success: false, detail: 'Usuario no encontrado' });
    }
    if (amount <= 0) {
        return res.status(400).json({ success: false, detail: 'Cantidad inválida' });
    }
    users[username].coins += amount;
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
bot.onText(/\/start (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const username = match[1].trim();
    
    if (telegramChatIds[chatId]) {
        bot.sendMessage(chatId, `Este ID de Telegram ya está asociado a la cuenta ${telegramChatIds[chatId]}. No puedes verificar otra cuenta.`);
        return;
    }
    
    if (!users[username] || !pendingVerifications[username]) {
        bot.sendMessage(chatId, 'Usuario no encontrado o no pendiente de verificación. Por favor, registra la cuenta primero.');
        return;
    }
    
    users[username].telegramVerified = true;
    users[username].telegramChatId = chatId;
    telegramChatIds[chatId] = username;
    delete pendingVerifications[username];
    bot.sendMessage(chatId, `¡Cuenta ${username} verificada exitosamente! Ahora puedes iniciar sesión.`);
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
