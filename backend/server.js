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

// Handlers globales para blindar el proceso de Node.js contra caídas no controladas (Requerimiento 5)
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection interceptado de forma segura:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception interceptado de forma segura:', err);
});

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

// Función auxiliar para registrar resultados en BD de forma aislada
async function logToDatabase({ sessionId, sendDate, rawNum, currentDni, selectedMessage, errorMsg }) {
  if (USE_DB && poolPromise) {
    try {
      const pool = await poolPromise;
      await pool.request()
        .input('id', sql.NVARCHAR(100), sessionId)
        .input('fecha', sql.DateTime, sendDate)
        .input('telefono', sql.NVARCHAR(50), rawNum)
        .input('dni', sql.NVARCHAR(50), currentDni)
        .input('mensaje', sql.NVARCHAR(sql.MAX), selectedMessage)
        .input('error', sql.NVARCHAR(sql.MAX), errorMsg)
        .query(`
          INSERT INTO iwassi (id, fecha, telefono, dni, mensaje, error)
          VALUES (@id, @fecha, @telefono, @dni, @mensaje, @error)
        `);
      console.log(`Registro guardado en BD para ${rawNum} (DNI: ${currentDni})${errorMsg ? ` - Error: ${errorMsg}` : ''}`);
    } catch (dbError) {
      console.error(`Error guardando en la BD para el número ${rawNum}:`, dbError);
    }
  }
}

// Inicializa una instancia temporal de WhatsApp sin persistencia
function getOrInitClient(sessionId) {
  if (activeClients.has(sessionId)) {
    return activeClients.get(sessionId);
  }

  console.log(`Iniciando cliente temporal de WhatsApp para sesión: ${sessionId}`);
  sessionStates.set(sessionId, { status: 'authenticating', lastQr: null, abortRequested: false });
  io.to(sessionId).emit('status', { status: 'authenticating' });

  const client = new Client({
    authStrategy: new NoAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    const currentState = sessionStates.get(sessionId) || {};
    sessionStates.set(sessionId, { ...currentState, status: 'qr', lastQr: null });
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) {
        const state = sessionStates.get(sessionId) || {};
        sessionStates.set(sessionId, { ...state, status: 'qr', lastQr: url });
        io.to(sessionId).emit('qr', { qr: url });
        io.to(sessionId).emit('status', { status: 'qr' });
      }
    });
  });

  client.on('ready', () => {
    const currentState = sessionStates.get(sessionId) || {};
    sessionStates.set(sessionId, { ...currentState, status: 'ready', lastQr: null });
    console.log(`Cliente listo en sesión temporal: ${sessionId}`);
    io.to(sessionId).emit('status', { status: 'ready' });
  });

  client.on('auth_failure', (msg) => {
    console.error(`Fallo de autenticación en sesión temporal ${sessionId}:`, msg);
    const currentState = sessionStates.get(sessionId) || {};
    sessionStates.set(sessionId, { ...currentState, status: 'disconnected', lastQr: null });
    io.to(sessionId).emit('status', { status: 'disconnected', message: msg });
  });

  client.on('disconnected', (reason) => {
    console.log(`Cliente desvinculado en sesión temporal ${sessionId}:`, reason);
    const currentState = sessionStates.get(sessionId) || {};
    sessionStates.set(sessionId, { ...currentState, status: 'disconnected', lastQr: null });
    io.to(sessionId).emit('status', { status: 'disconnected', reason });

    try {
      client.destroy();
    } catch (e) { }
    activeClients.delete(sessionId);
  });

  client.initialize().catch(err => {
    console.error(`Error al inicializar sesión temporal ${sessionId}:`, err);
    const currentState = sessionStates.get(sessionId) || {};
    sessionStates.set(sessionId, { ...currentState, status: 'disconnected', lastQr: null });
    io.to(sessionId).emit('status', { status: 'disconnected' });
  });

  activeClients.set(sessionId, client);
  return client;
}

// Configuración de conexiones de WebSockets
io.on('connection', (socket) => {
  const handleJoinSession = ({ sessionId }) => {
    if (!sessionId) return;

    socket.sessionId = sessionId;
    socket.join(sessionId);
    console.log(`Socket unido a sesión temporal: ${sessionId}`);

    // Si había un temporizador de desconexión corriendo, se cancela al reconectarse (Requerimiento 2)
    if (disconnectTimers.has(sessionId)) {
      clearTimeout(disconnectTimers.get(sessionId));
      disconnectTimers.delete(sessionId);
      console.log(`Reconexión rápida detectada. Cancelado temporizador de cierre para: ${sessionId}`);
    }

    const state = sessionStates.get(sessionId);
    if (state) {
      state.abortRequested = false;
    }

    getOrInitClient(sessionId);

    const currentState = sessionStates.get(sessionId);
    if (currentState) {
      socket.emit('status', { status: currentState.status });
      if (currentState.lastQr) {
        socket.emit('qr', { qr: currentState.lastQr });
      }
    }
  };

  socket.on('join-session', handleJoinSession);
  socket.on('join_session', handleJoinSession);

  socket.on('disconnect', () => {
    const sessionId = socket.sessionId;
    if (sessionId) {
      console.log(`Pestaña desconectada para sesión ${sessionId}. Esperando 2 minutos antes de destruir...`);

      // Tiempo de gracia ampliado a 2 minutos (120,000 ms) (Requerimiento 2)
      const timer = setTimeout(async () => {
        console.log(`[Sesión ${sessionId}] Tiempo de gracia de 2 min cumplido sin reconexión.`);
        
        // Activar bandera de cancelación por sesión (Requerimiento 3)
        const state = sessionStates.get(sessionId);
        if (state) {
          state.abortRequested = true;
        }

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
      }, 120000);

      disconnectTimers.set(sessionId, timer);
    }
  });
});

function formatPhoneNumber(num) {
  if (!num || typeof num !== 'string') return null;
  let cleaned = num.replace(/\D/g, '');

  if (cleaned.length < 8) {
    return null;
  }

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

// Espera interrumpible que evalúa periódicamente la bandera abortRequested (Requerimiento 3)
async function waitWithAbortCheck(ms, sessionId) {
  const checkInterval = 250;
  let elapsed = 0;
  while (elapsed < ms) {
    const st = sessionStates.get(sessionId);
    if (st?.abortRequested || !activeClients.has(sessionId)) {
      return true;
    }
    const chunk = Math.min(checkInterval, ms - elapsed);
    await delay(chunk);
    elapsed += chunk;
  }
  const st = sessionStates.get(sessionId);
  return !!(st?.abortRequested || !activeClients.has(sessionId));
}

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

  if (state && state.status === 'sending') {
    return res.status(429).json({ success: false, error: 'Ya hay un proceso de envío en curso para esta sesión' });
  }

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

  // Establecer estado de la sesión en 'sending' y resetear abortRequested
  sessionStates.set(sessionId, { ...state, status: 'sending', abortRequested: false });

  res.json({ success: true, message: 'Proceso de envío masivo iniciado', total: numbers.length });

  (async () => {
    try {
      if (waitMs > 0) {
        io.to(sessionId).emit('waiting_schedule', {
          scheduledDate,
          message: 'Esperando a la hora programada...'
        });
        console.log(`[Sesión ${sessionId}] Esperando ${Math.round(waitMs / 1000)}s para envío programado.`);
        
        const isAbortedSchedule = await waitWithAbortCheck(waitMs, sessionId);
        if (isAbortedSchedule) {
          console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
          return;
        }
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
        // Evaluación de bandera de cancelación por sesión antes de procesar cada contacto (Requerimiento 3)
        const currentSessionState = sessionStates.get(sessionId);
        if (currentSessionState?.abortRequested || !activeClients.has(sessionId)) {
          console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
          break;
        }

        const rawNum = numbers[i];
        const currentDni = dnis[i];
        const formattedNum = formatPhoneNumber(rawNum);
        const sendDate = new Date();
        const timestamp = sendDate.toLocaleTimeString();

        // Selección secuencial y equitativa de mensajes
        const selectedMessage = messagesList[i % messagesList.length];

        let errorMsg = null;

        // 1. Validación de formato de teléfono
        if (!formattedNum) {
          errorMsg = 'Número inválido';
          io.to(sessionId).emit('progress', {
            current: i + 1,
            total: numbers.length,
            number: rawNum,
            status: 'Fallido',
            time: timestamp,
            error: errorMsg
          });

          await logToDatabase({
            sessionId,
            sendDate,
            rawNum,
            currentDni,
            selectedMessage,
            errorMsg
          });

          if (i < numbers.length - 1) {
            const isAborted = await waitWithAbortCheck(parsedDelay, sessionId);
            if (isAborted) {
              console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
              break;
            }
          }
          continue;
        }

        // 2. Validación nativa del destinatario con getNumberId (Requerimiento 1)
        let contactId = null;
        try {
          contactId = await client.getNumberId(formattedNum);
        } catch (getIdError) {
          const getIdErrStr = getIdError?.message || String(getIdError);
          console.warn(`[Sesión ${sessionId}] Error al consultar getNumberId para ${formattedNum}:`, getIdErrStr);
          
          if (getIdErrStr.includes('detached Frame')) {
            errorMsg = `Error fatal detached Frame: ${getIdErrStr}`;
            io.to(sessionId).emit('progress', {
              current: i + 1,
              total: numbers.length,
              number: rawNum,
              status: 'Fallido',
              time: timestamp,
              error: errorMsg
            });
            await logToDatabase({ sessionId, sendDate, rawNum, currentDni, selectedMessage, errorMsg });
            
            console.error(`[Sesión ${sessionId}] Error fatal de Frame en getNumberId. Abortando todo el envío.`);
            await client.destroy().catch(err => console.warn('Aviso al destruir cliente con frame roto:', err.message));
            activeClients.delete(sessionId);
            sessionStates.delete(sessionId);
            break;
          }
        }

        if (!contactId) {
          errorMsg = 'Número no registrado en WhatsApp';
          console.warn(`[Sesión ${sessionId}] Número no registrado en WhatsApp: ${rawNum} (${formattedNum})`);

          io.to(sessionId).emit('progress', {
            current: i + 1,
            total: numbers.length,
            number: rawNum,
            status: 'Fallido',
            time: timestamp,
            error: errorMsg
          });

          await logToDatabase({
            sessionId,
            sendDate,
            rawNum,
            currentDni,
            selectedMessage,
            errorMsg
          });

          if (i < numbers.length - 1) {
            const isAborted = await waitWithAbortCheck(parsedDelay, sessionId);
            if (isAborted) {
              console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
              break;
            }
          }
          continue;
        }

        const targetNum = contactId._serialized || formattedNum;

        // 3. Intento de envío con reintentos para errores específicos y captura de errores fatales/LID (Requerimientos 1 y 4)
        const retryableErrors = [
          'Execution context was destroyed',
          'navigating',
          'Target closed',
          'getChat'
        ];

        let sendSuccess = false;
        let attempts = 0;
        const maxRetries = 2;
        let lastError = null;
        let isFatalFrame = false;
        let isNoLidError = false;

        while (attempts <= maxRetries && !sendSuccess) {
          const stState = sessionStates.get(sessionId);
          if (stState?.abortRequested || !activeClients.has(sessionId)) {
            console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
            break;
          }

          try {
            if (media) {
              await client.sendMessage(targetNum, media, { caption: selectedMessage });
            } else {
              await client.sendMessage(targetNum, selectedMessage);
            }
            sendSuccess = true;
          } catch (error) {
            lastError = error;
            const errorStr = error?.message || String(error);

            if (errorStr.includes('detached Frame')) {
              isFatalFrame = true;
              break;
            }

            if (errorStr.includes('No LID for user')) {
              isNoLidError = true;
              break;
            }

            const isRetryable = retryableErrors.some(errText => errorStr.includes(errText));

            if (isRetryable && attempts < maxRetries) {
              attempts++;
              console.warn(`[Sesión ${sessionId}] Error reintentable (${attempts}/${maxRetries}) para ${rawNum}: ${errorStr}. Reintentando en 3s...`);
              await delay(3000);
            } else {
              break;
            }
          }
        }

        // Evaluar aborto tras intentar el envío
        const postState = sessionStates.get(sessionId);
        if (postState?.abortRequested || !activeClients.has(sessionId)) {
          if (!sendSuccess && !isFatalFrame) {
            console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
            break;
          }
        }

        if (sendSuccess) {
          io.to(sessionId).emit('progress', {
            current: i + 1,
            total: numbers.length,
            number: rawNum,
            status: 'Enviado',
            time: timestamp,
            error: null
          });

          await logToDatabase({
            sessionId,
            sendDate,
            rawNum,
            currentDni,
            selectedMessage,
            errorMsg: null
          });
        } else if (isFatalFrame) {
          // Manejo del error fatal "detached Frame" y limpieza segura (Requerimiento 4)
          errorMsg = lastError?.message || 'detached Frame';
          console.error(`[Sesión ${sessionId}] Error fatal detached Frame para ${rawNum}:`, errorMsg);

          io.to(sessionId).emit('progress', {
            current: i + 1,
            total: numbers.length,
            number: rawNum,
            status: 'Fallido',
            time: timestamp,
            error: errorMsg
          });

          await logToDatabase({
            sessionId,
            sendDate,
            rawNum,
            currentDni,
            selectedMessage,
            errorMsg
          });

          console.error(`[Sesión ${sessionId}] Pestaña de Chromium colapsó de manera irreversible. Destruyendo sesión y abortando envío.`);
          await client.destroy().catch(err => console.warn('Aviso al destruir cliente con frame roto:', err.message));
          activeClients.delete(sessionId);
          sessionStates.delete(sessionId);
          break; // Salir inmediatamente del bucle
        } else if (isNoLidError) {
          // Manejo del error "No LID for user" en catch (Requerimiento 1)
          errorMsg = 'Número no registrado en WhatsApp';
          console.warn(`[Sesión ${sessionId}] Error No LID for user para ${rawNum}: registrado como número no registrado.`);

          io.to(sessionId).emit('progress', {
            current: i + 1,
            total: numbers.length,
            number: rawNum,
            status: 'Fallido',
            time: timestamp,
            error: errorMsg
          });

          await logToDatabase({
            sessionId,
            sendDate,
            rawNum,
            currentDni,
            selectedMessage,
            errorMsg
          });

          if (i < numbers.length - 1) {
            const isAborted = await waitWithAbortCheck(parsedDelay, sessionId);
            if (isAborted) {
              console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
              break;
            }
          }
          continue; // Salto al siguiente número sin detener el bucle
        } else {
          // Otros errores aislados
          errorMsg = lastError?.message || 'Error en el envío';
          console.error(`[Sesión ${sessionId}] Error al enviar a ${rawNum}:`, errorMsg);

          io.to(sessionId).emit('progress', {
            current: i + 1,
            total: numbers.length,
            number: rawNum,
            status: 'Fallido',
            time: timestamp,
            error: errorMsg
          });

          await logToDatabase({
            sessionId,
            sendDate,
            rawNum,
            currentDni,
            selectedMessage,
            errorMsg
          });
        }

        // 4. Intervalo de espera con evaluación de cancelación pacífica (Requerimientos 2 y 3)
        if (i < numbers.length - 1) {
          const isAborted = await waitWithAbortCheck(parsedDelay, sessionId);
          if (isAborted) {
            console.log(`[Sesión ${sessionId}] Envío detenido pacíficamente por superar los 2 min de desconexión.`);
            break;
          }
        }
      }
    } catch (criticalErr) {
      console.error(`[Sesión ${sessionId}] Error crítico no controlado en envío masivo:`, criticalErr);
    } finally {
      // Al finalizar el bucle, si la sesión sigue en activeClients, restablecer el estado a ready (Requerimiento 5)
      const currentClient = activeClients.get(sessionId);
      const currentState = sessionStates.get(sessionId);
      if (currentClient && currentState) {
        sessionStates.set(sessionId, { ...currentState, status: 'ready' });
        io.to(sessionId).emit('status', { status: 'ready' });
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