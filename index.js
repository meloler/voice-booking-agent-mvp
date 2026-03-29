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
 * FLUJO CORRECTO (3 pasos):
 * 1. Cliente llama -> Twilio SIP -> OpenAI -> POST webhook a nosotros
 * 2. Respondemos 200 OK + llamamos REST API para ACEPTAR la llamada
 * 3. Abrimos WebSocket sideband para control (tools, session.update)
 * 4. Enviamos session.update con tools + response.create para que el modelo hable
 * 5. Cuando el modelo necesita datos, emite function call por el WS
 * 6. Ejecutamos logica y devolvemos resultado por el WS
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
// INSTRUCCIONES DEL ASISTENTE Y TOOLS
// ============================================================================

const SYSTEM_INSTRUCTIONS = [
  'Eres el asistente de reservas del negocio.',
  'Se breve, amable y directo en castellano de Espana.',
  'Indica al inicio que eres un asistente virtual.',
  'Pide nombre y el servicio deseado.',
  'Nunca inventes disponibilidad, siempre usa la herramienta check_availability.',
  'Si el usuario interrumpe, callate inmediatamente y escucha.',
  'Si no puedes completar la gestion, ofrece pasar con una persona del equipo.'
].join(' ');

const TOOLS = [
  {
    type: 'function',
    name: 'check_availability',
    description: 'Comprueba los huecos libres en el calendario para un dia y servicio especifico.',
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
];

// ============================================================================
// ENDPOINT HTTP — Webhook de llamada entrante
// ============================================================================
//
// OpenAI envia un POST aqui cuando una llamada SIP llega.
// Flujo:
//   1. Responder 200 OK (solo acknowledge)
//   2. Llamar REST API para aceptar la llamada
//   3. Abrir WebSocket sideband
//

app.post('/openai/realtime/call-incoming', async (req, res) => {
  console.log('[WEBHOOK] Body completo:', JSON.stringify(req.body, null, 2));
  console.log('[WEBHOOK] Headers:', JSON.stringify(req.headers, null, 2));

  // Extraer call_id de la estructura del evento
  const callId = req.body.data?.call_id || req.body.call_id || req.body.id;
  const from = req.body.data?.from || req.body.from;
  const to = req.body.data?.to || req.body.to;

  console.log(`[WEBHOOK] Llamada entrante: call_id=${callId}, from=${from}, to=${to}`);

  // Paso 1: Responder 200 OK inmediatamente (solo acknowledge)
  res.status(200).send();
  console.log('[WEBHOOK] Respondido 200 OK');

  if (!callId) {
    console.error('[WEBHOOK] No se encontro call_id en el body');
    return;
  }

  // Paso 2: Aceptar la llamada via REST API
  const accepted = await acceptCall(callId);
  if (!accepted) {
    console.error(`[WEBHOOK] No se pudo aceptar la llamada call_id=${callId}`);
    return;
  }

  // Paso 3: Abrir WebSocket sideband
  openSideband(callId);
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
// ACCEPT CALL — REST API para aceptar la llamada
// ============================================================================
//
// POST https://api.openai.com/v1/realtime/calls/{call_id}/accept
// Esto le dice a OpenAI que aceptamos la llamada y con que configuracion base.
// Las tools se configuran DESPUES via session.update en el WebSocket.
//

async function acceptCall(callId) {
  const url = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;

  const body = {
    model: 'gpt-4o-realtime-preview',
    session: {
      type: 'realtime',
      voice: 'alloy',
      instructions: SYSTEM_INSTRUCTIONS,
      input_audio_transcription: {
        model: 'gpt-4o-mini-transcribe'
      }
    }
  };

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };

  if (OPENAI_PROJECT_ID) {
    headers['OpenAI-Project'] = OPENAI_PROJECT_ID;
  }

  console.log(`[ACCEPT] Aceptando llamada call_id=${callId}`);
  console.log(`[ACCEPT] URL: ${url}`);
  console.log(`[ACCEPT] Body: ${JSON.stringify(body)}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const responseText = await response.text();
    console.log(`[ACCEPT] Status: ${response.status}`);
    console.log(`[ACCEPT] Response: ${responseText}`);

    if (!response.ok) {
      console.error(`[ACCEPT] Error aceptando llamada: ${response.status} ${responseText}`);
      return false;
    }

    console.log(`[ACCEPT] Llamada aceptada exitosamente call_id=${callId}`);
    return true;
  } catch (err) {
    console.error(`[ACCEPT] Error de red aceptando llamada:`, err.message);
    return false;
  }
}

// ============================================================================
// WEBSOCKET SIDEBAND — Nosotros conectamos hacia OpenAI
// ============================================================================
//
// Despues de aceptar la llamada, abrimos un WebSocket sideband.
// Este es el canal por donde:
//   - Configuramos tools via session.update
//   - Recibimos function calls del modelo
//   - Enviamos resultados de herramientas
//   - Pedimos al modelo que hable con response.create
//

function openSideband(callId) {
  if (activeCalls.has(callId)) {
    console.warn(`[WS] Sideband ya abierto para call_id=${callId}`);
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;

  console.log(`[WS] Abriendo sideband hacia OpenAI para call_id=${callId}`);

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`
  };

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

    // Configurar la sesion con tools via session.update
    sendSessionUpdate(ws, callId);
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
        console.log(`[WS] Sesion actualizada para call_id=${callId} — tools configuradas`);
        // Ahora que las tools estan configuradas, pedimos al modelo que salude
        sendResponseCreate(ws, callId);
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
// SESSION UPDATE — Configurar tools en el WebSocket
// ============================================================================

function sendSessionUpdate(ws, callId) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn(`[WS] Socket cerrado, no se puede enviar session.update (call_id=${callId})`);
    return;
  }

  const sessionUpdate = {
    type: 'session.update',
    session: {
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.6
    }
  };

  ws.send(JSON.stringify(sessionUpdate));
  console.log(`[WS] Enviado session.update con ${TOOLS.length} tools para call_id=${callId}`);
}

// ============================================================================
// RESPONSE CREATE — Pedir al modelo que inicie la conversacion
// ============================================================================

function sendResponseCreate(ws, callId) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn(`[WS] Socket cerrado, no se puede enviar response.create (call_id=${callId})`);
    return;
  }

  ws.send(JSON.stringify({ type: 'response.create' }));
  console.log(`[WS] Enviado response.create para call_id=${callId} — modelo deberia saludar`);
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
  console.log('');
  console.log('  Flujo: Webhook 200 -> Accept REST API -> WS Sideband');
  console.log('');
});
