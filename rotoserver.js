const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const http = require('http');
const { Server } = require('socket.io');
const mercadopago = require('mercadopago');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

// Validar variables de entorno
const requiredEnvVars = ['MONGO_URI', 'SESSION_SECRET', 'MERCADOPAGO_ACCESS_TOKEN'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Error: Falta la variable de entorno ${envVar}`);
        process.exit(1);
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Configuración de Mercado Pago
mercadopago.configure({
    access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
});

// Middleware
app.use(cors({ origin: '*' })); // Permitir todas las solicitudes CORS (ajustar en producción)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 1 día
        secure: process.env.NODE_ENV === 'production' // HTTPS en producción
    }
}));

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Conectado a MongoDB'))
    .catch(err => {
        console.error('Error al conectar a MongoDB:', err);
        process.exit(1);
    });

// Esquema de usuario
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    coins: { type: Number, default: 1000 },
    settings: {
        displayName: String,
        cvu: String,
        metamask: String
    },
    policiesAccepted: { type: Boolean, default: false },
    policiesVersion: { type: String, default: '1.3.0' },
    telegramVerified: { type: Boolean, default: false },
    stats: {
        wins: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        totalBets: { type: Number, default: 0 },
        losses: { type: Number, default: 0 }
    }
});

const User = mongoose.model('User', userSchema);

// Variables del juego
let pot = 0;
let lastPlayer = null;
let timer = 240;
let gameActive = false;
const developerPercentage = 0.05;
const potPercentage = 0.06;

// Actualizar temporizador
function startTimer() {
    if (!gameActive) {
        gameActive = true;
        const interval = setInterval(() => {
            timer--;
            io.emit('timer update', { seconds: timer, pot, lastPlayer });
            if (timer <= 0) {
                clearInterval(interval);
                if (lastPlayer) {
                    const playerWinAmount = Math.round(pot * 0.89);
                    const developerAmount = Math.round(pot * developerPercentage);
                    pot = Math.round(pot * potPercentage);
                    User.findOneAndUpdate(
                        { username: lastPlayer },
                        { $inc: { coins: playerWinAmount, 'stats.wins': 1 } },
                        { new: true }
                    ).then(user => {
                        if (user) {
                            io.emit('coins update', { username: lastPlayer, coins: user.coins });
                        }
                    }).catch(err => console.error('Error al actualizar ganador:', err));
                    lastPlayer = null;
                    timer = 240;
                    gameActive = false;
                    io.emit('timer update', { seconds: timer, pot, lastPlayer });
                }
            }
        }, 1000);
    }
}

// Socket.IO
const connectedUsers = new Set();
io.on('connection', (socket) => {
    socket.on('join', (username) => {
        if (username) {
            connectedUsers.add(username);
            socket.username = username;
            io.emit('user joined', { user: username });
            io.emit('users update', Array.from(connectedUsers));
        }
    });

    socket.on('leave', (username) => {
        if (username) {
            connectedUsers.delete(username);
            io.emit('user left', { user: username });
            io.emit('users update', Array.from(connectedUsers));
        }
    });

    socket.on('chat message', ({ user, message, type }) => {
        if (user && message) {
            io.emit('chat message', { user, message, type });
        }
    });

    socket.on('compete', ({ username }) => {
        if (username) {
            lastPlayer = username;
            pot += 100;
            startTimer();
            io.emit('timer update', { seconds: timer, pot, lastPlayer });
        }
    });

    socket.on('update coins', ({ username, coins }) => {
        if (username && coins >= 0) {
            User.findOneAndUpdate(
                { username },
                { coins },
                { new: true }
            ).then(user => {
                if (user) {
                    io.emit('coins update', { username, coins: user.coins });
                }
            }).catch(err => console.error('Error al actualizar monedas:', err));
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            connectedUsers.delete(socket.username);
            io.emit('user left', { user: socket.username });
            io.emit('users update', Array.from(connectedUsers));
        }
    });
});

// Rutas
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Registro solicitado para username: ${username}`);
    if (!username || !password) {
        return res.status(400).json({ success: false, detail: 'Faltan username o password.' });
    }
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ success: false, detail: 'El usuario ya existe.' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashedPassword });
        await user.save();
        res.json({ success: true });
    } catch (error) {
        console.error('Error al registrar:', error);
        res.status(500).json({ success: false, detail: 'Error al registrar usuario.' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Inicio de sesión solicitado para username: ${username}`);
    if (!username || !password) {
        return res.status(400).json({ success: false, detail: 'Faltan username o password.' });
    }
    try {
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, detail: 'Usuario o contraseña incorrectos.' });
        }
        req.session.user = { username };
        const sessionId = req.sessionID;
        res.json({
            success: true,
            username,
            sessionId,
            policiesAccepted: user.policiesAccepted,
            policiesVersion: user.policiesVersion,
            telegramVerified: user.telegramVerified
        });
    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        res.status(500).json({ success: false, detail: 'Error al iniciar sesión.' });
    }
});

app.post('/check-session', (req, res) => {
    console.log('Verificando sesión:', req.sessionID);
    if (req.session.user) {
        res.json({ success: true, username: req.session.user.username, sessionId: req.sessionID });
    } else {
        res.json({ success: false, detail: 'No hay sesión activa.' });
    }
});

app.post('/logout', (req, res) => {
    console.log('Cerrando sesión:', req.sessionID);
    req.session.destroy(err => {
        if (err) {
            console.error('Error al cerrar sesión:', err);
            return res.status(500).json({ success: false, detail: 'Error al cerrar sesión.' });
        }
        res.json({ success: true });
    });
});

app.get('/user/:username', async (req, res) => {
    const { username } = req.params;
    console.log(`Obteniendo usuario: ${username}`);
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        res.json({ success: true, user });
    } catch (error) {
        console.error('Error al obtener usuario:', error);
        res.status(500).json({ success: false, detail: 'Error al obtener usuario.' });
    }
});

app.post('/accept-policies', async (req, res) => {
    const { username, policiesVersion } = req.body;
    console.log(`Aceptando políticas para ${username}, versión: ${policiesVersion}`);
    if (!username || !policiesVersion) {
        return res.status(400).json({ success: false, detail: 'Faltan username o policiesVersion.' });
    }
    try {
        const user = await User.findOneAndUpdate(
            { username },
            { policiesAccepted: true, policiesVersion },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error al aceptar políticas:', error);
        res.status(500).json({ success: false, detail: 'Error al aceptar políticas.' });
    }
});

app.post('/ reject-policies', async (req, res) => {
    const { username, policiesVersion } = req.body;
    console.log(`Rechazando políticas para ${username}, versión: ${policiesVersion}`);
    if (!username || !policiesVersion) {
        return res.status(400).json({ success: false, detail: 'Faltan username o policiesVersion.' });
    }
    try {
        const user = await User.findOneAndUpdate(
            { username },
            { policiesAccepted: false, policiesVersion },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error al rechazar políticas:', error);
        res.status(500).json({ success: false, detail: 'Error al rechazar políticas.' });
    }
});

app.post('/update-settings', async (req, res) => {
    const { username, settings } = req.body;
    console.log(`Actualizando configuración para ${username}`);
    if (!username || !settings) {
        return res.status(400).json({ success: false, detail: 'Faltan username o settings.' });
    }
    try {
        const user = await User.findOneAndUpdate(
            { username },
            { settings },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ success: false, detail: 'Error al actualizar configuración.' });
    }
});

app.post('/compete', async (req, res) => {
    const { username, sessionId } = req.body;
    console.log(`Compitiendo: ${username}, sessionId: ${sessionId}`);
    if (!req.session.user || req.session.user.username !== username || req.sessionID !== sessionId) {
        return res.status(401).json({ success: false, detail: 'No autorizado.' });
    }
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        if (user.coins < 100) {
            return res.status(400).json({ success: false, detail: 'No tienes suficientes Neig.' });
        }
        await User.findOneAndUpdate(
            { username },
            { $inc: { coins: -100, 'stats.clicks': 1, 'stats.totalBets': 100 } },
            { new: true }
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error al competir:', error);
        res.status(500).json({ success: false, detail: 'Error al competir.' });
    }
});

app.post('/withdraw', async (req, res) => {
    const { username, amount, currency } = req.body;
    console.log(`Retirando ${amount} ${currency} para ${username}`);
    if (!username || !amount || !currency) {
        return res.status(400).json({ success: false, detail: 'Faltan username, amount o currency.' });
    }
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        if (amount > user.coins) {
            return res.status(400).json({ success: false, detail: 'No tienes suficientes Neig.' });
        }
        await User.findOneAndUpdate(
            { username },
            { $inc: { coins: -amount } },
            { new: true }
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error al retirar:', error);
        res.status(500).json({ success: false, detail: 'Error al procesar retiro.' });
    }
});

app.get('/stats', async (req, res) => {
    console.log('Obteniendo estadísticas');
    try {
        const users = await User.find();
        const winners = users
            .filter(user => user.stats.wins > 0)
            .map(user => ({
                username: user.username,
                timestamp: new Date().toISOString(),
                amount: user.stats.wins * 100 * 0.89
            }));
        const topWinners = {};
        const clicks = {};
        const totalBets = {};
        const losses = {};
        users.forEach(user => {
            topWinners[user.username] = user.stats.wins;
            clicks[user.username] = user.stats.clicks;
            totalBets[user.username] = user.stats.totalBets;
            losses[user.username] = user.stats.totalBets - (user.stats.wins * 100 * 0.89);
        });
        res.json({
            success: true,
            winners,
            topWinners,
            clicks,
            totalBets,
            losses
        });
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ success: false, detail: 'Error al obtener estadísticas.' });
    }
});

app.post('/create-payment', async (req, res) => {
    const { username, amount } = req.body;
    console.log(`Creando pago para ${username}, monto: ${amount}`);
    if (!username || !amount || amount <= 0) {
        return res.status(400).json({ success: false, detail: 'Faltan username o amount válido.' });
    }
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ success: false, detail: 'Usuario no encontrado.' });
        }
        if (!user.policiesAccepted || user.policiesVersion !== '1.3.0') {
            return res.status(403).json({ success: false, detail: 'Debes aceptar las políticas para recargar.' });
        }
        const preference = {
            items: [
                {
                    title: 'Recarga de Neighborcoin (Neig)',
                    unit_price: parseFloat(amount),
                    quantity: 1,
                    currency_id: 'ARS'
                }
            ],
            back_urls: {
                success: `https://neigame.onrender.com/success?username=${username}&amount=${amount}`,
                failure: 'https://neigame.onrender.com/failure',
                pending: 'https://neigame.onrender.com/pending'
            },
            auto_return: 'approved',
            notification_url: 'https://neigame.onrender.com/webhook',
            external_reference: username
        };
        const response = await mercadopago.preferences.create(preference);
        console.log('Enlace de pago creado:', response.body.init_point);
        res.json({ success: true, paymentUrl: response.body.init_point });
    } catch (error) {
        console.error('Error al crear enlace de pago:', error);
        res.status(500).json({ success: false, detail: 'Error al crear enlace de pago.' });
    }
});

app.post('/webhook', async (req, res) => {
    const payment = req.body;
    console.log('Webhook recibido:', payment);
    try {
        if (payment.type === 'payment' && payment.data && payment.data.id) {
            const paymentInfo = await mercadopago.payment.findById(payment.data.id);
            console.log('Información del pago:', paymentInfo.body);
            const username = paymentInfo.body.external_reference;
            const amount = paymentInfo.body.transaction_amount;
            if (paymentInfo.body.status === 'approved' && username && amount) {
                const user = await User.findOneAndUpdate(
                    { username },
                    { $inc: { coins: amount } },
                    { new: true }
                );
                if (user) {
                    console.log(`Saldo actualizado para ${username}: ${user.coins} Neig`);
                    io.emit('coins update', {
                        username,
                        coins: user.coins,
                        message: `Usted compró ${amount} Neig`
                    });
                }
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error en webhook:', error);
        res.status(500).send('Error');
    }
});

app.get('/success', async (req, res) => {
    const { username, amount } = req.query;
    console.log(`Redirección de éxito para ${username}, monto: ${amount}`);
    try {
        const user = await User.findOne({ username });
        if (!user) {
            console.error('Usuario no encontrado en /success:', username);
            return res.redirect('/?error=Usuario no encontrado');
        }
        res.redirect(`/?amount=${amount}`);
    } catch (error) {
        console.error('Error en redirección de éxito:', error);
        res.redirect('/?error=Error en el procesamiento');
    }
});

app.get('/failure', (req, res) => {
    console.log('Redirección de fallo de pago');
    res.redirect('/?error=Pago fallido');
});

app.get('/pending', (req, res) => {
    console.log('Redirección de pago pendiente');
    res.redirect('/?error=Pago pendiente');
});

app.get('/', (req, res) => {
    console.log('Sirviendo index.html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
