/**
 * ============================================================================
 * Voice Booking Agent — MVP Railway
 * ============================================================================
 *
 * Arquitectura SIP Directo:
 *
 *   [Telefono] --> [Twilio SIP Trunk] --> [OpenAI Realtime API] <--> [Este servidor]
 *                                               |                          |
 *                                          Audio (RTP)              Control (WebSocket)
 *
 * FLUJO:
 * 1. Un cliente llama al numero del negocio.
 * 2. Twilio enruta el audio via SIP TLS directamente a OpenAI.
 * 3. OpenAI dispara un webhook HTTP POST a nuestro endpoint /openai/realtime/call-incoming.
 * 4. Respondemos con las instrucciones de sesion (prompt, voz, tools).
 * 5. NOSOTROS abrimos un WebSocket sideband hacia OpenAI usando el call_id.
 * 6. Cuando el modelo necesita consultar disponibilidad, emite un function call por el WS.
 * 7. Ejecutamos la logica de negocio y devolvemos el resultado por el mismo WS.
 * 8. OpenAI verbaliza la respuesta al cliente por telefono.
 *
 * PRINCIPIO CLAVE: El audio NUNCA pasa por este servidor. Solo control y datos.
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ============================================================================
// CONFIGURACION
// ============================================================================

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID;

if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY no configurada');
  process.exit(1);
}

const app = express();
app.use(express.json());

const server = http.createServer(app);

// Map de llamadas activas: call_id -> WebSocket
const activeCalls = new Map();

// ============================================================================
// ENDPOINT HTTP — Webhook de llamada entrante
// ============================================================================
//
// OpenAI envia un POST aqui cuando una llamada SIP llega.
// Respondemos con la configuracion de sesion y ABRIMOS el WebSocket sideband.
//

app.post('/openai/realtime/call-incoming', (req, res) => {
  // Log del body COMPLETO para ver la estructura real de OpenAI
  console.log('[WEBHOOK] Body completo:', JSON.stringify(req.body, null, 2));
  console.log('[WEBHOOK] Headers:', JSON.stringify(req.headers, null, 2));

  // Extraer campos — buscar en estructura plana y anidada
  const callId = req.body.call_id || req.body.data?.call_id || req.body.id;
  const from = req.body.from || req.body.data?.from;
  const to = req.body.to || req.body.data?.to;

  console.log(`[WEBHOOK] Llamada entrante: call_id=${callId}, from=${from}, to=${to}`);

  // TODO: Validar firma del webhook
  // const signature = req.headers['openai-signature'];
  // const secret = process.env.OPENAI_WEBHOOK_SECRET;

  // Configuracion de sesion para OpenAI
  const sessionConfig = {
    instructions: [
      'Eres el asistente de reservas del negocio.',
      'Sé breve, amable y directo en castellano de España.',
      'Indica al inicio que eres un asistente virtual.',
      'Pide nombre y el servicio deseado.',
      'Nunca inventes disponibilidad, siempre usa la herramienta check_availability.',
      'Si el usuario interrumpe, cállate inmediatamente y escucha.',
      'Si no puedes completar la gestión, ofrece pasar con una persona del equipo.'
    ].join(' '),

    voice: 'alloy',
    temperature: 0.6,

    tools: [
      {
        type: 'function',
        name: 'check_availability',
        description: 'Comprueba los huecos libres en el calendario para un día y servicio específico.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Fecha en formato ISO 8601 (YYYY-MM-DD).'
            },
            service_type: {
              type: 'string',
              enum: ['fisioterapia', 'consulta_general', 'revision'],
              description: 'Tipo de servicio solicitado.'
            }
          },
          required: ['date', 'service_type']
        }
      }
    ]
  };

  console.log('[WEBHOOK] Respondiendo con session config...');
  res.status(200).json(sessionConfig);

  // Abrir WebSocket sideband hacia OpenAI para esta llamada
  // Lo hacemos DESPUES de responder al webhook (no bloqueamos la respuesta HTTP)
  if (callId) {
    openSideband(callId);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    active_calls: activeCalls.size,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// WEBSOCKET SIDEBAND — Nosotros conectamos hacia OpenAI
// ============================================================================
//
// Despues de aceptar la llamada via webhook, NOSOTROS abrimos un WebSocket
// contra OpenAI usando el call_id. Este es el canal por donde:
//   - Recibimos function calls del modelo
//   - Enviamos resultados de herramientas
//   - Controlamos el flujo de la conversacion
//
// URL: wss://api.openai.com/v1/realtime?call_id=<CALL_ID>
// Auth: Bearer token + OpenAI-Project header
//

function openSideband(callId) {
  // Evitar duplicados
  if (activeCalls.has(callId)) {
    console.warn(`[WS] Sideband ya abierto para call_id=${callId}`);
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;

  console.log(`[WS] Abriendo sideband hacia OpenAI para call_id=${callId}`);

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };

  // Si tenemos Project ID, lo incluimos
  if (OPENAI_PROJECT_ID) {
    headers['OpenAI-Project'] = OPENAI_PROJECT_ID;
  }

  const ws = new WebSocket(url, { headers });

  // Timeout de conexion: 10 segundos
  const connectTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      console.error(`[WS] Timeout conectando sideband para call_id=${callId}`);
      ws.terminate();
    }
  }, 10000);

  ws.on('open', () => {
    clearTimeout(connectTimeout);
    console.log(`[WS] Sideband conectado para call_id=${callId}`);
    activeCalls.set(callId, ws);
  });

  ws.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.error('[WS] Error parseando mensaje:', err.message);
      return;
    }

    // -----------------------------------------------------------------------
    // FUNCTION CALL COMPLETADO — El modelo quiere ejecutar una herramienta
    // -----------------------------------------------------------------------
    if (event.type === 'response.function_call_arguments.done') {
      console.log(`[WS] Function call recibido: ${event.name}`);
      handleFunctionCall(ws, event, callId);
      return;
    }

    // Eventos de lifecycle
    switch (event.type) {
      case 'session.created':
        console.log(`[WS] Sesion creada para call_id=${callId}`);
        break;
      case 'session.updated':
        console.log(`[WS] Sesion actualizada para call_id=${callId}`);
        break;
      case 'response.done':
        console.log(`[WS] Respuesta del modelo completada`);
        break;
      case 'input_audio_buffer.speech_started':
        console.log(`[WS] Usuario empezo a hablar`);
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log(`[WS] Usuario dejo de hablar`);
        break;
      case 'response.audio.delta':
        // Audio del modelo — lo ignoramos, va directo por SIP
        break;
      case 'response.audio_transcript.delta':
        // Transcript parcial del modelo — util para debug
        process.stdout.write(event.delta || '');
        break;
      case 'response.audio_transcript.done':
        console.log(`\n[WS] Modelo dijo: "${event.transcript}"`);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        console.log(`[WS] Usuario dijo: "${event.transcript}"`);
        break;
      case 'error':
        console.error('[WS] Error de OpenAI:', JSON.stringify(event.error));
        break;
      default:
        // Muchos eventos mas (deltas, etc.) — los ignoramos
        break;
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(connectTimeout);
    console.log(`[WS] Sideband cerrado para call_id=${callId} (code=${code})`);
    activeCalls.delete(callId);
  });

  ws.on('error', (err) => {
    clearTimeout(connectTimeout);
    console.error(`[WS] Error sideband call_id=${callId}:`, err.message);
    activeCalls.delete(callId);
  });
}

// ============================================================================
// HANDLER DE FUNCTION CALLS
// ============================================================================

function handleFunctionCall(ws, event, callId) {
  const functionName = event.name;
  const functionCallId = event.call_id;

  let args;
  try {
    args = JSON.parse(event.arguments);
  } catch (err) {
    console.error('[TOOL] Error parseando argumentos:', err.message);
    sendToolOutput(ws, functionCallId, { status: 'error', message: 'invalid_arguments' }, callId);
    return;
  }

  console.log(`[TOOL] ${functionName}(${JSON.stringify(args)})`);

  switch (functionName) {
    case 'check_availability':
      handleCheckAvailability(ws, functionCallId, args, callId);
      break;
    default:
      console.warn(`[TOOL] Herramienta desconocida: ${functionName}`);
      sendToolOutput(ws, functionCallId, { status: 'error', message: 'unknown_tool' }, callId);
      break;
  }
}

/**
 * check_availability — Consulta huecos disponibles.
 * MVP: Respuesta simulada con 2 huecos.
 * TODO: Reemplazar con consulta real a BD.
 */
function handleCheckAvailability(ws, functionCallId, args, callId) {
  const { date, service_type } = args;

  console.log(`[TOOL] Consultando disponibilidad: ${service_type} el ${date}`);

  const mockResponse = {
    status: 'success',
    date: date,
    service_type: service_type,
    available_slots: [
      `${date}T16:00:00+02:00`,
      `${date}T18:30:00+02:00`
    ]
  };

  console.log(`[TOOL] Huecos encontrados: ${mockResponse.available_slots.length}`);
  sendToolOutput(ws, functionCallId, mockResponse, callId);
}

// ============================================================================
// UTILIDADES DE ENVIO WEBSOCKET
// ============================================================================

/**
 * Envia el resultado de un function call de vuelta a OpenAI.
 *
 * Flujo en dos pasos:
 * 1. conversation.item.create con function_call_output -> le da el dato al modelo
 * 2. response.create -> le dice al modelo "ahora habla"
 */
function sendToolOutput(ws, functionCallId, output, callId) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn(`[WS] Socket cerrado, no se puede enviar respuesta (call_id=${callId})`);
    return;
  }

  // Paso 1: Resultado del function call
  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: functionCallId,
      output: JSON.stringify(output)
    }
  }));
  console.log(`[WS] Enviado function_call_output para call_id=${functionCallId}`);

  // Paso 2: Pedir al modelo que retome la palabra
  ws.send(JSON.stringify({ type: 'response.create' }));
  console.log('[WS] Enviado response.create');
}

// ============================================================================
// ARRANQUE
// ============================================================================

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('  Voice Booking Agent — MVP Railway');
  console.log('='.repeat(60));
  console.log(`  HTTP:      http://0.0.0.0:${PORT}`);
  console.log(`  Webhook:   POST /openai/realtime/call-incoming`);
  console.log(`  Health:    GET /health`);
  console.log(`  Project:   ${OPENAI_PROJECT_ID || '(no configurado)'}`);
  console.log('='.repeat(60));
});
