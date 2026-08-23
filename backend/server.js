import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import pkg from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = pkg;

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

// Configuración de almacenamiento en memoria para archivos adjuntos
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Variable global para mantener el estado del cliente de WhatsApp
let client;
let clientStatus = 'disconnected'; // 'disconnected' | 'authenticating' | 'ready' | 'qr'
let lastQr = null;

function initWhatsApp() {
  console.log('Iniciando cliente de WhatsApp...');
  clientStatus = 'authenticating';
  io.emit('status', { status: clientStatus });

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    clientStatus = 'qr';
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) {
        lastQr = url;
        io.emit('qr', { qr: url });
        io.emit('status', { status: 'qr' });
      }
    });
  });

  client.on('ready', () => {
    clientStatus = 'ready';
    lastQr = null;
    console.log('Cliente de WhatsApp listo.');
    io.emit('status', { status: 'ready' });
  });

  client.on('authenticated', () => {
    console.log('Cliente autenticado.');
  });

  client.on('auth_failure', (msg) => {
    console.error('Fallo de autenticación:', msg);
    clientStatus = 'disconnected';
    io.emit('status', { status: 'disconnected', message: msg });
  });

  client.on('disconnected', (reason) => {
    console.log('Cliente desconectado:', reason);
    clientStatus = 'disconnected';
    io.emit('status', { status: 'disconnected', reason });
    // Intenta reinicializar si se desconecta
    try {
      client.destroy();
    } catch (e) {}
    initWhatsApp();
  });

  client.initialize().catch(err => {
    console.error('Error al inicializar cliente:', err);
    clientStatus = 'disconnected';
    io.emit('status', { status: 'disconnected' });
  });
}

// Inicializar el cliente al arrancar el servidor
initWhatsApp();

// Manejo de conexiones de WebSocket
io.on('connection', (socket) => {
  console.log('Cliente web conectado vía Socket.IO ID:', socket.id);
  
  // Enviar estado actual al nuevo cliente
  socket.emit('status', { status: clientStatus });
  if (clientStatus === 'qr' && lastQr) {
    socket.emit('qr', { qr: lastQr });
  }
});

// Función auxiliar para formatear los números de teléfono
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

// Helper para pausar la ejecución
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Endpoint para reiniciar el cliente / cerrar sesión
app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      await client.logout();
      await client.destroy();
    }
    initWhatsApp();
    res.json({ success: true, message: 'Sesión cerrada e inicializando nuevo código QR' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para procesar el envío masivo
app.post('/api/send-bulk', upload.single('attachment'), async (req, res) => {
  if (clientStatus !== 'ready') {
    return res.status(400).json({ success: false, error: 'El servicio de WhatsApp no está listo' });
  }

  const { numbers: rawNumbers, message, delaySeconds } = req.body;
  const file = req.file;

  if (!rawNumbers || !message) {
    return res.status(400).json({ success: false, error: 'Números y mensaje son campos obligatorios' });
  }

  // Procesar lista de números
  const numbers = rawNumbers
    .split(/[\n,]+/)
    .map(num => num.trim())
    .filter(num => num.length > 0);

  const parsedDelay = Math.max(parseInt(delaySeconds, 10) || 5, 2) * 1000;

  if (numbers.length === 0) {
    return res.status(400).json({ success: false, error: 'No se encontraron números válidos' });
  }

  // Responder inmediatamente que el proceso ha iniciado
  res.json({ success: true, message: 'Proceso de envío masivo iniciado', total: numbers.length });

  // Ejecución en segundo plano para no bloquear la petición HTTP
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
          // Envía primero el archivo con el texto en el caption
          await client.sendMessage(formattedNum, media, { caption: message });
        } else {
          await client.sendMessage(formattedNum, message);
        }

        io.emit('progress', {
          current: i + 1,
          total: numbers.length,
          number: rawNum,
          status: 'Enviado',
          time: timestamp,
          error: null
        });
      } catch (error) {
        console.error(`Error enviando a ${rawNum}:`, error);
        io.emit('progress', {
          current: i + 1,
          total: numbers.length,
          number: rawNum,
          status: 'Fallido',
          time: timestamp,
          error: error.message || 'Error en el envío'
        });
      }

      // Evitar aplicar retraso en el último mensaje enviado
      if (i < numbers.length - 1) {
        await delay(parsedDelay);
      }
    }
  })();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});