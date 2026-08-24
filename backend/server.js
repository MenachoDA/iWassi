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

// Extraemos NoAuth para sesiones efímeras sin almacenamiento en disco
const { Client, NoAuth, MessageMedia } = pkg;

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Mapas en memoria para sesiones dinámicas
const activeClients = new Map();
const sessionStates = new Map(); 
const disconnectTimers = new Map(); // Temporizadores de gracia para desconexión

// Inicializa una instancia temporal de WhatsApp sin persistencia
function getOrInitClient(sessionId) {
  if (activeClients.has(sessionId)) {
    return activeClients.get(sessionId);
  }

  console.log(`Iniciando cliente temporal de WhatsApp para sesión: ${sessionId}`);
  sessionStates.set(sessionId, { status: 'authenticating', lastQr: null });
  io.to(sessionId).emit('status', { status: 'authenticating' });

  const client = new Client({
    authStrategy: new NoAuth(), // No guarda archivos ni credenciales en el servidor
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
    } catch (e) {}
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

    // Si había un temporizador de destrucción para esta pestaña, se cancela (el usuario refrescó la página)
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

  // Si la pestaña se cierra o el ordenador remoto se apaga
  socket.on('disconnect', () => {
    const sessionId = socket.sessionId;
    if (sessionId) {
      console.log(`Pestaña desconectada para sesión ${sessionId}. Esperando 15 segundos antes de destruir...`);
      
      const timer = setTimeout(async () => {
        console.log(`Tiempo de gracia cumplido. Destruyendo sesión de WhatsApp de forma segura: ${sessionId}`);
        const client = activeClients.get(sessionId);
        if (client) {
          try {
            await client.destroy(); // Apaga Puppeteer y libera la memoria RAM
          } catch (e) {
            console.error(`Error al cerrar cliente temporal ${sessionId}:`, e);
          }
          activeClients.delete(sessionId);
        }
        sessionStates.delete(sessionId);
        disconnectTimers.delete(sessionId);
      }, 15000); // 15 segundos de tolerancia
      
      disconnectTimers.set(sessionId, timer);
    }
  });
});

// Función auxiliar para formatear los números de teléfono (Perú)
function formatPhoneNumber(num) {
  let cleaned = num.replace(/\D/g, '');

  if(cleaned.length === 9){
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

// Endpoint para reiniciar el cliente / desvincular
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

// Endpoint para procesar el envío masivo
app.post('/api/send-bulk', upload.single('attachment'), async (req, res) => {
  const { sessionId, numbers: rawNumbers, message, delaySeconds } = req.body;
  const file = req.file;

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Se requiere el identificador de sesión' });
  }

  const client = activeClients.get(sessionId);
  const state = sessionStates.get(sessionId);

  if (!client || !state || state.status !== 'ready') {
    return res.status(400).json({ success: false, error: 'El servicio de WhatsApp temporal no está listo' });
  }

  if (!rawNumbers || !message) {
    return res.status(400).json({ success: false, error: 'Números y mensaje son campos obligatorios' });
  }

  const numbers = rawNumbers
    .split(/[\n,]+/)
    .map(num => num.trim())
    .filter(num => num.length > 0);

  const parsedDelay = Math.max(parseInt(delaySeconds, 10) || 30, 2) * 1000;

  if (numbers.length === 0) {
    return res.status(400).json({ success: false, error: 'No se encontraron números válidos' });
  }

  res.json({ success: true, message: 'Proceso de envío masivo iniciado', total: numbers.length });

  (async () => {
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
      const formattedNum = formatPhoneNumber(rawNum);
      const timestamp = new Date().toLocaleTimeString();

      try {
        if (media) {
          await client.sendMessage(formattedNum, media, { caption: message });
        } else {
          await client.sendMessage(formattedNum, message);
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
        console.error(`[Sesión ${sessionId}] Error:`, error);
        io.to(sessionId).emit('progress', {
          current: i + 1,
          total: numbers.length,
          number: rawNum,
          status: 'Fallido',
          time: timestamp,
          error: error.message || 'Error en el envío'
        });
      }

      if (i < numbers.length - 1) {
        await delay(parsedDelay);
      }
    }
  })();
});

// CONFIGURACIÓN PARA SERVIR EL FRONTEND UNIFICADO
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../frontend/dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});