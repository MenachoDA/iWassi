import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import pkg from 'whatsapp-web.js';
import path from 'path';
import { fileURLToPath } from 'url';
import sql from 'mssql';

// Cargar variables de entorno
dotenv.config();

// Extraemos NoAuth para sesiones efímeras sin almacenamiento en disco
const { Client, NoAuth, MessageMedia } = pkg;

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const USE_DB = process.env.USE_DB === 'true'; // Variable que controla el entorno

let poolPromise = null;

if (USE_DB) {
  // CONFIGURACIÓN DE LA BASE DE DATOS SQL SERVER DESDE .ENV
  const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_CERT === 'true'
    }
  };

  // Crear el pool de conexión a la BD
  poolPromise = sql.connect(dbConfig).then(pool => {
    console.log('Conectado a SQL Server exitosamente.');
    return pool;
  }).catch(err => {
    console.error('Error al conectar a SQL Server:', err);
  });
} else {
  console.log('Modo local: Ejecutando sin conexión a base de datos.');
}

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Mapas en memoria para sesiones dinámicas
const activeClients = new Map();
const sessionStates = new Map();
const disconnectTimers = new Map();

// Inicializa una instancia temporal de WhatsApp sin persistencia
function getOrInitClient(sessionId) {
  if (activeClients.has(sessionId)) {
    return activeClients.get(sessionId);
  }

  console.log(`Iniciando cliente temporal de WhatsApp para sesión: ${sessionId}`);
  sessionStates.set(sessionId, { status: 'authenticating', lastQr: null });
  io.to(sessionId).emit('status', { status: 'authenticating' });

  const client = new Client({
    authStrategy: new NoAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    sessionStates.set(sessionId, { status: 'qr', lastQr: null });
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) {
        sessionStates.set(sessionId, { status: 'qr', lastQr: url });
        io.to(sessionId).emit('qr', { qr: url });
        io.to(sessionId).emit('status', { status: 'qr' });
      }
    });
  });

  client.on('ready', () => {
    sessionStates.set(sessionId, { status: 'ready', lastQr: null });
    console.log(`Cliente listo en sesión temporal: ${sessionId}`);
    io.to(sessionId).emit('status', { status: 'ready' });
  });

  client.on('auth_failure', (msg) => {
    console.error(`Fallo de autenticación en sesión temporal ${sessionId}:`, msg);
    sessionStates.set(sessionId, { status: 'disconnected', lastQr: null });
    io.to(sessionId).emit('status', { status: 'disconnected', message: msg });
  });

  client.on('disconnected', (reason) => {
    console.log(`Cliente desvinculado en sesión temporal ${sessionId}:`, reason);
    sessionStates.set(sessionId, { status: 'disconnected', lastQr: null });
    io.to(sessionId).emit('status', { status: 'disconnected', reason });

    try {
      client.destroy();
    } catch (e) { }
    activeClients.delete(sessionId);
  });

  client.initialize().catch(err => {
    console.error(`Error al inicializar sesión temporal ${sessionId}:`, err);
    sessionStates.set(sessionId, { status: 'disconnected', lastQr: null });
    io.to(sessionId).emit('status', { status: 'disconnected' });
  });

  activeClients.set(sessionId, client);
  return client;
}

// Configuración de conexiones de WebSockets
io.on('connection', (socket) => {
  socket.on('join-session', ({ sessionId }) => {
    if (!sessionId) return;

    socket.sessionId = sessionId;
    socket.join(sessionId);
    console.log(`Socket unido a sesión temporal: ${sessionId}`);

    if (disconnectTimers.has(sessionId)) {
      clearTimeout(disconnectTimers.get(sessionId));
      disconnectTimers.delete(sessionId);
      console.log(`Reconexión rápida detectada. Cancelado temporizador de cierre para: ${sessionId}`);
    }

    getOrInitClient(sessionId);

    const state = sessionStates.get(sessionId);
    if (state) {
      socket.emit('status', { status: state.status });
      if (state.lastQr) {
        socket.emit('qr', { qr: state.lastQr });
      }
    }
  });

  socket.on('disconnect', () => {
    const sessionId = socket.sessionId;
    if (sessionId) {
      console.log(`Pestaña desconectada para sesión ${sessionId}. Esperando 15 segundos antes de destruir...`);

      const timer = setTimeout(async () => {
        console.log(`Tiempo de gracia cumplido. Destruyendo sesión de WhatsApp de forma segura: ${sessionId}`);
        const client = activeClients.get(sessionId);
        if (client) {
          try {
            await client.destroy();
          } catch (e) {
            console.error(`Error al cerrar cliente temporal ${sessionId}:`, e);
          }
          activeClients.delete(sessionId);
        }
        sessionStates.delete(sessionId);
        disconnectTimers.delete(sessionId);
      }, 15000);

      disconnectTimers.set(sessionId, timer);
    }
  });
});

function formatPhoneNumber(num) {
  let cleaned = num.replace(/\D/g, '');

  if (cleaned.length === 9) {
    cleaned = `51${cleaned}`;
  }
  else if (cleaned.length > 9 && !cleaned.startsWith('51')) {
    cleaned = `51${cleaned}`;
  }

  if (!cleaned.endsWith('@c.us')) {
    cleaned = `${cleaned}@c.us`;
  }
  return cleaned;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/logout', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Se requiere el identificador de sesión' });
  }

  try {
    const client = activeClients.get(sessionId);
    if (client) {
      await client.destroy();
      activeClients.delete(sessionId);
    }
    sessionStates.delete(sessionId);
    getOrInitClient(sessionId);
    res.json({ success: true, message: 'Sesión temporal cerrada correctamente' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/send-bulk', upload.single('attachment'), async (req, res) => {
  const { sessionId, numbers: rawNumbers, dnis: rawDnis, message, messages: rawMessages, delaySeconds, scheduledDate } = req.body;
  const file = req.file;

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Se requiere el identificador de sesión' });
  }

  const client = activeClients.get(sessionId);
  const state = sessionStates.get(sessionId);

  if (!client || !state || state.status !== 'ready') {
    return res.status(400).json({ success: false, error: 'El servicio de WhatsApp temporal no está listo' });
  }

  let messagesList = [];
  if (rawMessages) {
    try {
      messagesList = typeof rawMessages === 'string' ? JSON.parse(rawMessages) : rawMessages;
    } catch (e) {
      messagesList = Array.isArray(rawMessages) ? rawMessages : [rawMessages];
    }
  }
  if (!Array.isArray(messagesList) || messagesList.length === 0) {
    if (message) {
      messagesList = [message];
    }
  }
  messagesList = messagesList
    .map(m => (typeof m === 'string' ? m.trim() : ''))
    .filter(m => m.length > 0);

  if (messagesList.length === 0) {
    return res.status(400).json({ success: false, error: 'Debes proporcionar al menos un mensaje' });
  }

  if (!rawNumbers || !rawDnis) {
    return res.status(400).json({ success: false, error: 'Números y DNIs son campos obligatorios' });
  }

  const numbers = rawNumbers
    .split(/[\n,]+/)
    .map(num => num.trim())
    .filter(num => num.length > 0);

  const dnis = (rawDnis || '')
    .split(/[\n,]+/)
    .map(dni => dni.trim())
    .filter(dni => dni.length > 0);

  if (numbers.length === 0) {
    return res.status(400).json({ success: false, error: 'No se encontraron números válidos' });
  }

  if (numbers.length !== dnis.length) {
    return res.status(400).json({ success: false, error: 'La cantidad de números no coincide con la cantidad de DNIs' });
  }

  if (!dnis.every(dni => /^\d{8}$/.test(dni))) {
    return res.status(400).json({ success: false, error: 'Todos los DNIs deben contener exactamente 8 dígitos numéricos' });
  }

  const parsedDelay = Math.max(parseInt(delaySeconds, 10) || 30, 2) * 1000;

  let waitMs = 0;
  if (scheduledDate) {
    const targetDate = new Date(scheduledDate);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, error: 'La fecha programada no es válida' });
    }
    waitMs = targetDate.getTime() - Date.now();
    if (waitMs < 0) {
      return res.status(400).json({ success: false, error: 'La fecha programada no puede ser anterior a la fecha actual' });
    }
  }

  res.json({ success: true, message: 'Proceso de envío masivo iniciado', total: numbers.length });

  (async () => {
    if (waitMs > 0) {
      io.to(sessionId).emit('waiting_schedule', {
        scheduledDate,
        message: 'Esperando a la hora programada...'
      });
      console.log(`[Sesión ${sessionId}] Esperando ${Math.round(waitMs / 1000)}s para envío programado.`);
      await delay(waitMs);
    }

    let media = null;
    if (file) {
      media = new MessageMedia(
        file.mimetype,
        file.buffer.toString('base64'),
        file.originalname
      );
    }

    for (let i = 0; i < numbers.length; i++) {
      const rawNum = numbers[i];
      const currentDni = dnis[i];
      const formattedNum = formatPhoneNumber(rawNum);
      const sendDate = new Date();
      const timestamp = sendDate.toLocaleTimeString();

      const randomMessage = messagesList[Math.floor(Math.random() * messagesList.length)];

      let errorMsg = null;

      try {
        if (media) {
          await client.sendMessage(formattedNum, media, { caption: randomMessage });
        } else {
          await client.sendMessage(formattedNum, randomMessage);
        }

        io.to(sessionId).emit('progress', {
          current: i + 1,
          total: numbers.length,
          number: rawNum,
          status: 'Enviado',
          time: timestamp,
          error: null
        });
      } catch (error) {
        console.error(`[Sesión ${sessionId}] Error al enviar a ${rawNum}:`, error);
        errorMsg = error.message || 'Error en el envío';
        io.to(sessionId).emit('progress', {
          current: i + 1,
          total: numbers.length,
          number: rawNum,
          status: 'Fallido',
          time: timestamp,
          error: errorMsg
        });
      }

      // ==============================================================
      // INSERCIÓN EN LA BASE DE DATOS SQL SERVER (CONDICIONAL)
      // ==============================================================
      if (USE_DB && poolPromise) {
        try {
          const pool = await poolPromise;
          await pool.request()
            .input('id', sql.NVARCHAR(100), sessionId)
            .input('fecha', sql.DateTime, sendDate)
            .input('telefono', sql.NVARCHAR(50), rawNum)
            .input('dni', sql.NVARCHAR(50), currentDni)
            .input('mensaje', sql.NVARCHAR(sql.MAX), randomMessage)
            .input('error', sql.NVARCHAR(sql.MAX), errorMsg)
            .query(`
              INSERT INTO iwassi (id, fecha, telefono, dni, mensaje, error)
              VALUES (@id, @fecha, @telefono, @dni, @mensaje, @error)
            `);
          console.log(`Registro guardado en BD para ${rawNum} (DNI: ${currentDni})`);
        } catch (dbError) {
          console.error(`Error guardando en la BD para el número ${rawNum}:`, dbError);
        }
      }
      // ==============================================================

      if (i < numbers.length - 1) {
        await delay(parsedDelay);
      }
    }
  })();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../frontend/dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});