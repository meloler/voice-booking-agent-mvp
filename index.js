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
 * 5. OpenAI abre un WebSocket sideband con nuestro servidor para tool calling.
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
const { WebSocketServer } = require('ws');

// ============================================================================
// CONFIGURACION
// ============================================================================

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Servidor HTTP que compartiran Express y el WebSocketServer
const server = http.createServer(app);

// ============================================================================
// ENDPOINT HTTP — Webhook de llamada entrante
// ============================================================================
//
// OpenAI envia un POST aqui cuando una llamada SIP llega.
// Respondemos con la configuracion de sesion: instrucciones, voz, tools.
// Esta respuesta le dice a OpenAI COMO debe comportarse el asistente.
//

app.post('/openai/realtime/call-incoming', (req, res) => {
  console.log('[WEBHOOK] Llamada entrante recibida:', JSON.stringify(req.body, null, 2));

  // TODO: Validar firma del webhook para asegurar que viene de OpenAI.
  // const signature = req.headers['openai-signature'];
  // const secret = process.env.OPENAI_WEBHOOK_SECRET;
  // if (!verifySignature(req.body, signature, secret)) {
  //   return res.status(401).json({ error: 'invalid_signature' });
  // }

  // Configuracion de sesion que OpenAI usara para esta llamada.
  // Define el comportamiento del asistente, la voz, y las herramientas disponibles.
  const sessionConfig = {
    // Prompt de sistema: le dice al modelo quien es y como comportarse
    instructions: [
      'Eres el asistente de reservas del negocio.',
      'Sé breve, amable y directo en castellano de España.',
      'Pide nombre y el servicio deseado.',
      'Si el usuario interrumpe, cállate inmediatamente y escucha.'
    ].join(' '),

    // Voz del asistente (opciones: alloy, echo, fable, onyx, nova, shimmer)
    voice: 'alloy',

    // Temperatura baja-moderada: menos dispersión verbal, mas fiable en flujos transaccionales
    temperature: 0.6,

    // Herramientas que el modelo puede invocar.
    // Cada tool call llega por el WebSocket sideband, NO por HTTP.
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

  console.log('[WEBHOOK] Sesion configurada. Respondiendo a OpenAI...');
  res.status(200).json(sessionConfig);
});

// Health check — Railway y OpenAI lo usan para verificar que el servidor esta vivo
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// SERVIDOR WEBSOCKET — Canal de control sideband
// ============================================================================
//
// Despues de aceptar la llamada, OpenAI abre un WebSocket con nuestro servidor.
// Por este canal recibimos los function calls (tool calling) y enviamos respuestas.
//
// El flujo de un function call es:
//   1. OpenAI envia: response.function_call_arguments.done (con nombre + args)
//   2. Nosotros ejecutamos la logica (consulta BD, etc.)
//   3. Enviamos: conversation.item.create (con function_call_output)
//   4. Enviamos: response.create (para que el modelo retome la palabra)
//

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Nueva conexion sideband establecida');

  ws.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      console.error('[WS] Error parseando mensaje:', err.message);
      return;
    }

    console.log('[WS] Evento recibido:', event.type);

    // -----------------------------------------------------------------------
    // FUNCTION CALL COMPLETADO — El modelo quiere ejecutar una herramienta
    // -----------------------------------------------------------------------
    // Este es el evento canonico: llega cuando el modelo ha terminado de
    // generar los argumentos completos del function call.
    //
    if (event.type === 'response.function_call_arguments.done') {
      handleFunctionCall(ws, event);
      return;
    }

    // Otros eventos de lifecycle que podemos loguear
    switch (event.type) {
      case 'session.created':
        console.log('[WS] Sesion de OpenAI creada');
        break;
      case 'session.updated':
        console.log('[WS] Sesion actualizada');
        break;
      case 'response.done':
        console.log('[WS] Respuesta del modelo completada');
        break;
      case 'input_audio_buffer.speech_started':
        console.log('[WS] Usuario empezo a hablar');
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log('[WS] Usuario dejo de hablar');
        break;
      case 'error':
        console.error('[WS] Error de OpenAI:', JSON.stringify(event.error));
        break;
      default:
        // Hay muchos eventos (audio deltas, transcriptions, etc.)
        // Los ignoramos porque no procesamos audio.
        break;
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[WS] Conexion cerrada (code=${code}, reason=${reason})`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error en WebSocket:', err.message);
  });
});

// ============================================================================
// HANDLER DE FUNCTION CALLS
// ============================================================================

/**
 * Procesa un function call emitido por el modelo.
 *
 * @param {WebSocket} ws - Conexion WebSocket activa
 * @param {object} event - Evento con type, name, call_id, arguments
 */
function handleFunctionCall(ws, event) {
  const functionName = event.name;
  const callId = event.call_id;

  let args;
  try {
    args = JSON.parse(event.arguments);
  } catch (err) {
    console.error('[TOOL] Error parseando argumentos:', err.message);
    sendToolOutput(ws, callId, { status: 'error', message: 'invalid_arguments' });
    return;
  }

  console.log(`[TOOL] Function call: ${functionName}`, args);

  // -------------------------------------------------------------------------
  // DISPATCH — Ejecutar la herramienta correspondiente
  // -------------------------------------------------------------------------
  switch (functionName) {
    case 'check_availability':
      handleCheckAvailability(ws, callId, args);
      break;

    default:
      console.warn(`[TOOL] Herramienta desconocida: ${functionName}`);
      sendToolOutput(ws, callId, { status: 'error', message: 'unknown_tool' });
      break;
  }
}

/**
 * check_availability — Consulta huecos disponibles para un servicio en una fecha.
 *
 * MVP: Respuesta simulada. En produccion esto consulta la BD real.
 *
 * @param {WebSocket} ws
 * @param {string} callId - ID del function call (para mapear la respuesta)
 * @param {object} args - { date, service_type }
 */
function handleCheckAvailability(ws, callId, args) {
  const { date, service_type } = args;

  console.log(`[TOOL] Consultando disponibilidad: ${service_type} el ${date}`);

  // TODO: Reemplazar con consulta real a la base de datos.
  // Debe: leer horario del negocio + reservas existentes + duracion del servicio
  // y calcular los huecos libres.
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

  // Enviar resultado al modelo
  sendToolOutput(ws, callId, mockResponse);
}

// ============================================================================
// UTILIDADES DE ENVIO WEBSOCKET
// ============================================================================

/**
 * Envia el resultado de un function call de vuelta a OpenAI por el WebSocket.
 *
 * Flujo en dos pasos:
 * 1. conversation.item.create con function_call_output → le da el dato al modelo
 * 2. response.create → le dice al modelo "ya tienes el dato, ahora habla"
 *
 * @param {WebSocket} ws
 * @param {string} callId - El call_id del function call original
 * @param {object} output - El resultado a enviar
 */
function sendToolOutput(ws, callId, output) {
  // Verificar que el WebSocket sigue abierto
  if (ws.readyState !== ws.OPEN) {
    console.warn('[WS] WebSocket cerrado, no se puede enviar respuesta de tool');
    return;
  }

  // Paso 1: Enviar el resultado del function call
  const functionOutput = {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output)
    }
  };

  ws.send(JSON.stringify(functionOutput));
  console.log(`[WS] Enviado function_call_output para call_id=${callId}`);

  // Paso 2: Pedir al modelo que retome la conversacion
  // Sin esto, el modelo se quedaria esperando indefinidamente.
  const resumeResponse = {
    type: 'response.create'
  };

  ws.send(JSON.stringify(resumeResponse));
  console.log('[WS] Enviado response.create — el modelo retomara la palabra');
}

// ============================================================================
// ARRANQUE DEL SERVIDOR
// ============================================================================

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('  Voice Booking Agent — MVP Railway');
  console.log('='.repeat(60));
  console.log(`  HTTP:      http://0.0.0.0:${PORT}`);
  console.log(`  Webhook:   POST /openai/realtime/call-incoming`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`  Health:    GET /health`);
  console.log('='.repeat(60));
});
