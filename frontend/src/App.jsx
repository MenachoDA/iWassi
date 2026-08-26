import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  QrCode,
  AlertTriangle,
  Send,
  FileUp,
  Trash2,
  RefreshCw,
  Info
} from 'lucide-react';

const BACKEND_URL = window.location.origin;

// Generador de clave de sesión temporal
const generateTempSessionId = () => {
  return 'iWassi_temp_' + Math.random().toString(36).substring(2, 11);
};

export default function App() {
  // Estado para la sesión temporal (almacenada en sessionStorage para que muera al cerrar la pestaña)
  const [sessionId] = useState(() => {
    let session = sessionStorage.getItem('iwassi_ephemeral_session');
    if (!session) {
      session = generateTempSessionId();
      sessionStorage.setItem('iwassi_ephemeral_session', session);
    }
    return session;
  });

  // Estados de conexión
  const [status, setStatus] = useState('disconnected');
  const [qrCode, setQrCode] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);

  // Estados del Formulario de Envío
  const [numbers, setNumbers] = useState('');
  const [message, setMessage] = useState('');
  const [delay, setDelay] = useState(30);
  const [file, setFile] = useState(null);

  // Estado de Envío y Progreso
  const [isSending, setIsSending] = useState(false);
  const [isScheduledWaiting, setIsScheduledWaiting] = useState(false);
  const [dispatchMode, setDispatchMode] = useState('immediate');
  const [scheduledDateTime, setScheduledDateTime] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [logs, setLogs] = useState([]);

  const socketRef = useRef(null);

  useEffect(() => {
    // Inicializar conexión Socket.IO con la sesión única de esta pestaña
    socketRef.current = io(BACKEND_URL);

    socketRef.current.on('connect', () => {
      setSocketConnected(true);
      socketRef.current.emit('join-session', { sessionId: sessionId });
    });

    socketRef.current.on('disconnect', () => {
      setSocketConnected(false);
      setStatus('disconnected');
    });

    socketRef.current.on('status', (data) => {
      setStatus(data.status);
      if (data.status !== 'qr') {
        setQrCode(null);
      }
    });

    socketRef.current.on('qr', (data) => {
      setQrCode(data.qr);
    });

    socketRef.current.on('progress', (data) => {
      setIsScheduledWaiting(false);
      setProgress({ current: data.current, total: data.total });
      setLogs((prev) => [data, ...prev]);

      if (data.current === data.total) {
        setIsSending(false);
      }
    });

    socketRef.current.on('waiting_schedule', (data) => {
      setIsScheduledWaiting(true);
      setLogs((prev) => [{ status: 'info', number: 'Sistema', time: new Date().toLocaleTimeString(), error: data.message }, ...prev]);
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, [sessionId]);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const removeFile = () => {
    setFile(null);
  };

  const handleLogout = async () => {
    if (window.confirm('¿Seguro que deseas cerrar sesión de forma inmediata? Se perderá la vinculación de este celular.')) {
      try {
        const response = await fetch(`${BACKEND_URL}/api/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId })
        });
        const data = await response.json();
        if (data.success) {
          setQrCode(null);
          setStatus('disconnected');
        }
      } catch (err) {
        alert('Error al desconectar la sesión');
      }
    }
  };

  const startSending = async () => {
    setShowConfirm(false);
    setIsSending(true);
    setIsScheduledWaiting(false);
    setProgress({ current: 0, total: 0 });
    setLogs([]);

    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('numbers', numbers);
    formData.append('message', message);
    formData.append('delaySeconds', delay.toString());

    if (dispatchMode === 'scheduled' && scheduledDateTime) {
      const date = new Date(scheduledDateTime);
      formData.append('scheduledDate', date.toISOString());
    }

    if (file) {
      formData.append('attachment', file);
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/send-bulk`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (!data.success) {
        alert(data.error || 'Error al iniciar el envío');
        setIsSending(false);
      }
    } catch (error) {
      alert('Error de red al intentar enviar');
      setIsSending(false);
    }
  };

  const parsedNumbersCount = numbers
    .split(/[\n,]+/)
    .map(n => n.trim())
    .filter(n => n.length > 0).length;

  const isScheduleValid = () => {
    if (dispatchMode === 'immediate') return true;
    if (!scheduledDateTime) return false;
    const scheduleDate = new Date(scheduledDateTime);
    return scheduleDate.getTime() > Date.now();
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      {/* Cabecera */}
      <header className="bg-emerald-600 text-white shadow-md">
        <div className="max-w-6xl mx-auto px-4 py-5 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">iWassi</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs bg-emerald-700 px-3 py-1.5 rounded-full border border-emerald-500 text-emerald-50">
              Servidor: {BACKEND_URL}
            </span>
            <div className={`w-3 h-3 rounded-full ${socketConnected ? 'bg-green-400' : 'bg-red-400'}`} title={socketConnected ? 'Socket conectado' : 'Socket desconectado'} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">

        {/* Columna Izquierda: Control de Conexión */}
        <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col h-fit">
          <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
            <span>1. Conexión de tu WhatsApp</span>
          </h2>

          {/* Badge de estados */}
          <div className="mb-6">
            {status === 'disconnected' && (
              <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Desconectado</p>
                  <p className="text-xs text-red-600 mt-0.5">El motor de tu WhatsApp está inactivo.</p>
                </div>
              </div>
            )}

            {status === 'authenticating' && (
              <div className="bg-amber-50 border border-amber-200 text-amber-700 p-4 rounded-xl flex items-start gap-3">
                <Loader2 className="w-5 h-5 animate-spin flex-shrink-0 mt-0.5 text-amber-500" />
                <div>
                  <p className="font-semibold text-sm">Cargando Motor</p>
                  <p className="text-xs text-amber-600 mt-0.5">Generando QR de conexión</p>
                </div>
              </div>
            )}

            {status === 'qr' && (
              <div className="bg-blue-50 border border-blue-200 text-blue-700 p-4 rounded-xl flex items-start gap-3">
                <QrCode className="w-5 h-5 flex-shrink-0 mt-0.5 text-blue-500" />
                <div>
                  <p className="font-semibold text-sm">Escaneo Requerido</p>
                  <p className="text-xs text-blue-600 mt-0.5">Escanea el código QR para activar tu sesión privada.</p>
                </div>
              </div>
            )}

            {status === 'ready' && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 p-4 rounded-xl flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5 text-emerald-600" />
                <div>
                  <p className="font-semibold text-sm">WhatsApp Vinculado</p>
                  <p className="text-xs text-emerald-600 mt-0.5">Listo para el envío de mensajes.</p>
                </div>
              </div>
            )}
          </div>

          {/* Renderizado de QR o Info Conexión */}
          {status === 'qr' && qrCode ? (
            <div className="flex flex-col items-center bg-slate-50 p-4 rounded-xl border border-slate-200">
              <img src={qrCode} alt="Código QR WhatsApp" className="w-48 h-48 rounded shadow-sm" />
              <p className="text-xs text-slate-500 mt-3 text-center">
                Abre WhatsApp &gt; Dispositivos vinculados &gt; Vincular un dispositivo
              </p>
            </div>
          ) : status === 'ready' ? (
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 mb-2">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <p className="text-xs text-slate-500 text-center mb-4 text-amber-600 font-medium">
                Esta conexión se destruirá por seguridad al cerrar esta pestaña o apagar la PC.
              </p>
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-red-200 text-red-600 hover:bg-red-50 text-xs font-semibold rounded-lg transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Desconectar WhatsApp Ahora
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center p-8 border border-dashed border-slate-200 rounded-xl">
              <p className="text-xs text-slate-400 text-center">Conectando instancia de envío segura...</p>
            </div>
          )}
        </section>

        {/* Columna Centro: Panel de Envío */}
        <section className="md:col-span-2 space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
            <h2 className="text-lg font-bold text-slate-800 mb-5 flex items-center gap-2">
              <span>2. Parámetros del Mensaje Masivo</span>
            </h2>

            <div className="space-y-4">
              {/* Números */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Destinatarios (un número por línea)
                </label>
                <textarea
                  disabled={status !== 'ready' || isSending}
                  value={numbers}
                  onChange={(e) => setNumbers(e.target.value)}
                  placeholder="Ejemplo:&#10;922018420&#10;999888777"
                  rows={5}
                  className="w-full p-3 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400 font-mono resize-none"
                />
                <span className="text-xs text-slate-500 flex justify-end mt-1">
                  Contactos detectados: {parsedNumbersCount}
                </span>
              </div>

              {/* Modo de Envío */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
                  Modo de Envío
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="dispatchMode"
                      value="immediate"
                      checked={dispatchMode === 'immediate'}
                      onChange={() => setDispatchMode('immediate')}
                      disabled={status !== 'ready' || isSending}
                      className="accent-emerald-600 w-4 h-4"
                    />
                    <span className="text-sm text-slate-700">Inmediato</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="dispatchMode"
                      value="scheduled"
                      checked={dispatchMode === 'scheduled'}
                      onChange={() => setDispatchMode('scheduled')}
                      disabled={status !== 'ready' || isSending}
                      className="accent-emerald-600 w-4 h-4"
                    />
                    <span className="text-sm text-slate-700">Programado</span>
                  </label>
                </div>

                {dispatchMode === 'scheduled' && (
                  <div className="mt-3 p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Fecha y Hora de inicio</label>
                      <input
                        type="datetime-local"
                        value={scheduledDateTime}
                        onChange={(e) => setScheduledDateTime(e.target.value)}
                        disabled={status !== 'ready' || isSending}
                        className="w-full p-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                      />
                    </div>
                    <div className="flex items-start gap-2 bg-amber-50 p-2 rounded-lg border border-amber-200 text-amber-800 text-xs">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <p>
                        <strong>Importante:</strong> Esta pestaña debe permanecer abierta hasta que empiece y finalice el envío programado.
                        Si cierras la pestaña, la conexión de WhatsApp se destruirá y el envío fallará.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Mensaje */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Mensaje a Enviar
                </label>
                <textarea
                  disabled={status !== 'ready' || isSending}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Escribe el mensaje aquí..."
                  rows={4}
                  className="w-full p-3 text-sm border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400 resize-none"
                />
              </div>

              {/* Retraso */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Intervalo entre envíos: {delay} segundos
                </label>
                <input
                  type="range"
                  min="30"
                  max="70"
                  disabled={status !== 'ready' || isSending}
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                />
                <div className="flex justify-between text-[10px] text-slate-400 px-1 mt-1">
                  <span>30s</span>
                  <span>50s</span>
                  <span>70s</span>
                </div>
              </div>

              {/* Adjunto de archivo */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Documento / Imagen Adjunta (Opcional)
                </label>

                {!file ? (
                  <div className="border-2 border-dashed border-slate-200 hover:border-emerald-500 hover:bg-slate-50 rounded-xl p-4 transition-colors relative cursor-pointer">
                    <input
                      type="file"
                      disabled={status !== 'ready' || isSending}
                      onChange={handleFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                    />
                    <div className="flex flex-col items-center justify-center gap-2">
                      <FileUp className="w-6 h-6 text-slate-400" />
                      <span className="text-xs text-slate-600">Haz clic para buscar un archivo</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <div className="p-2 bg-emerald-100 text-emerald-700 rounded-lg">
                        <FileUp className="w-4 h-4" />
                      </div>
                      <div className="overflow-hidden">
                        <p className="text-xs font-semibold text-slate-700 truncate">{file.name}</p>
                        <p className="text-[10px] text-slate-400">{(file.size / 1024).toFixed(1)} KB</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isSending}
                      onClick={removeFile}
                      className="text-slate-400 hover:text-red-500 p-1.5 rounded transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Botón Disparador */}
              <button
                type="button"
                onClick={() => setShowConfirm(true)}
                disabled={status !== 'ready' || isSending || parsedNumbersCount === 0 || !message || !isScheduleValid()}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm py-3 px-4 rounded-xl shadow-md transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {isScheduledWaiting ? 'Esperando inicio...' : `Enviando lote... (${progress.current}/${progress.total})`}
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    {dispatchMode === 'scheduled' ? 'Programar Envío' : 'Iniciar Envío Masivo'}
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Monitor de Progreso */}
          {(isSending || logs.length > 0) && (
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Monitor de Progreso</h3>
                <span className="text-xs font-mono font-bold text-slate-500">
                  {progress.current} / {progress.total}
                </span>
              </div>

              {/* Barra de progreso */}
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-emerald-500 h-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>

              {/* Consola de Eventos */}
              <div className="bg-slate-900 text-slate-200 rounded-xl p-4 h-56 overflow-y-auto font-mono text-xs space-y-2">
                {logs.length === 0 && <span className="text-slate-500">Esperando transmisiones...</span>}
                {logs.map((log, index) => (
                  <div key={index} className="flex justify-between border-b border-slate-800 pb-1.5 last:border-0">
                    <div className="flex items-center gap-2">
                      {log.status === 'Enviado' ? (
                        <span className="text-green-400 font-bold">[OK]</span>
                      ) : log.status === 'info' ? (
                        <span className="text-blue-400 font-bold">[INFO]</span>
                      ) : (
                        <span className="text-red-400 font-bold">[ERROR]</span>
                      )}
                      <span>{log.number}</span>
                      {log.error && <span className="text-slate-500 text-[10px]">({log.error})</span>}
                    </div>
                    <span className="text-slate-500 text-[10px]">{log.time}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Modal de Confirmación */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-md w-full border border-slate-100 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Info className="w-5 h-5 text-amber-500" />
              Confirmar Envío Masivo
            </h3>
            <p className="text-xs text-slate-500 mt-2">
              Vas a realizar un envío masivo de mensajes desde el número de WhatsApp con el que escaneaste el QR.
            </p>

            <div className="my-4 p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-1.5">
              <div className="flex justify-between"><span className="text-slate-400">Total de destinatarios:</span> <span className="font-bold">{parsedNumbersCount}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Tiempo entre envíos:</span> <span className="font-bold">{delay} segundos</span></div>
              <div className="flex justify-between">
                <span className="text-slate-400">Modo de inicio:</span>
                <span className="font-bold">
                  {dispatchMode === 'immediate' ? 'Inmediato' : new Date(scheduledDateTime).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-slate-400">Archivo Adjunto:</span> <span className="font-bold text-slate-700 truncate max-w-[200px]">{file ? file.name : 'Ninguno'}</span></div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={startSending}
                className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                Sí, iniciar envío
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}