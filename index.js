/**
 * ============================================================================
 * Voice Booking Agent — Clinica Dental Sonrisa (MVP Railway)
 * ============================================================================
 *
 * Negocio: Clinica Dental Sonrisa
 * Servicios: revision (30min), limpieza (45min), empaste (60min)
 * Horario: L-V 09:00-14:00, 16:00-20:00
 * Timezone: Atlantic/Canary
 * Agenda: Google Calendar
 *
 * Flujo:
 * 1. Cliente llama -> Twilio SIP -> OpenAI -> POST webhook
 * 2. Respondemos 200 OK + Accept REST API
 * 3. WebSocket sideband para tools
 * 4. check_availability -> consulta Google Calendar
 * 5. book_appointment -> crea evento en Google Calendar
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { google } = require('googleapis');

// ============================================================================
// CONFIGURACION
// ============================================================================

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY no configurada');
  process.exit(1);
}

// ============================================================================
// GOOGLE CALENDAR — Service Account Auth
// ============================================================================

let calendar;

function initGoogleCalendar() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.warn('[GCAL] GOOGLE_SERVICE_ACCOUNT_KEY no configurada — tools usaran datos mock');
    return;
  }
  if (!GOOGLE_CALENDAR_ID) {
    console.warn('[GCAL] GOOGLE_CALENDAR_ID no configurado — tools usaran datos mock');
    return;
  }

  try {
    const key = JSON.parse(keyJson);
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    calendar = google.calendar({ version: 'v3', auth });
    console.log('[GCAL] Google Calendar inicializado correctamente');
  } catch (err) {
    console.error('[GCAL] Error inicializando Google Calendar:', err.message);
  }
}

// ============================================================================
// NEGOCIO — Clinica Dental Sonrisa
// ============================================================================

const BUSINESS = {
  name: 'Clinica Dental Sonrisa',
  timezone: 'Atlantic/Canary',
  services: {
    revision:  { name: 'Revision dental',     duration: 30 },
    limpieza:  { name: 'Limpieza dental',      duration: 45 },
    empaste:   { name: 'Empaste',              duration: 60 }
  },
  // Horario L-V (1=lunes ... 5=viernes)
  schedule: {
    1: [{ start: '09:00', end: '14:00' }, { start: '16:00', end: '20:00' }],
    2: [{ start: '09:00', end: '14:00' }, { start: '16:00', end: '20:00' }],
    3: [{ start: '09:00', end: '14:00' }, { start: '16:00', end: '20:00' }],
    4: [{ start: '09:00', end: '14:00' }, { start: '16:00', end: '20:00' }],
    5: [{ start: '09:00', end: '14:00' }, { start: '16:00', end: '20:00' }]
  }
};

// ============================================================================
// INSTRUCCIONES Y TOOLS
// ============================================================================

const SYSTEM_INSTRUCTIONS = [
  `Eres el asistente virtual de ${BUSINESS.name}.`,
  'Habla en castellano de Espana, se breve y amable.',
  'Al inicio saluda e indica que eres un asistente virtual.',
  'Pregunta el nombre del paciente y que servicio necesita.',
  `Los servicios disponibles son: ${Object.values(BUSINESS.services).map(s => s.name).join(', ')}.`,
  'Horario: lunes a viernes de 9 a 14 y de 16 a 20.',
  'Cuando el paciente pida cita, usa check_availability para consultar huecos reales.',
  'Nunca inventes disponibilidad.',
  'Cuando el paciente elija un hueco, usa book_appointment para confirmar la reserva.',
  'Si el usuario interrumpe, callate y escucha.',
  'Si no puedes resolver algo, ofrece pasar con una persona del equipo.'
].join(' ');

const TOOLS = [
  {
    type: 'function',
    name: 'check_availability',
    description: 'Consulta los huecos libres en la agenda de la clinica para un dia y servicio.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Fecha en formato YYYY-MM-DD.'
        },
        service_type: {
          type: 'string',
          enum: ['revision', 'limpieza', 'empaste'],
          description: 'Tipo de servicio dental.'
        }
      },
      required: ['date', 'service_type']
    }
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Reserva una cita en la agenda de la clinica.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Fecha en formato YYYY-MM-DD.'
        },
        time: {
          type: 'string',
          description: 'Hora de inicio en formato HH:MM (24h).'
        },
        service_type: {
          type: 'string',
          enum: ['revision', 'limpieza', 'empaste'],
          description: 'Tipo de servicio dental.'
        },
        patient_name: {
          type: 'string',
          description: 'Nombre del paciente.'
        }
      },
      required: ['date', 'time', 'service_type', 'patient_name']
    }
  }
];

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();
app.use(express.json());
const server = http.createServer(app);
const activeCalls = new Map();

// ============================================================================
// WEBHOOK — Llamada entrante
// ============================================================================

app.post('/openai/realtime/call-incoming', async (req, res) => {
  const callId = req.body.data?.call_id || req.body.call_id || req.body.id;
  console.log(`[WEBHOOK] Llamada entrante: call_id=${callId}`);

  res.status(200).send();

  if (!callId) {
    console.error('[WEBHOOK] No se encontro call_id');
    return;
  }

  const accepted = await acceptCall(callId);
  if (!accepted) return;

  openSideband(callId);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    business: BUSINESS.name,
    google_calendar: !!calendar,
    active_calls: activeCalls.size,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// ACCEPT CALL
// ============================================================================

async function acceptCall(callId) {
  const url = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;

  const body = {
    type: 'realtime',
    model: 'gpt-realtime',
    instructions: SYSTEM_INSTRUCTIONS
  };

  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
  if (OPENAI_PROJECT_ID) headers['OpenAI-Project'] = OPENAI_PROJECT_ID;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[ACCEPT] Error ${response.status}: ${text}`);
      return false;
    }

    console.log(`[ACCEPT] Llamada aceptada call_id=${callId}`);
    return true;
  } catch (err) {
    console.error(`[ACCEPT] Error de red:`, err.message);
    return false;
  }
}

// ============================================================================
// WEBSOCKET SIDEBAND
// ============================================================================

function openSideband(callId) {
  if (activeCalls.has(callId)) return;

  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
  const headers = { 'Authorization': `Bearer ${OPENAI_API_KEY}` };
  if (OPENAI_PROJECT_ID) headers['OpenAI-Project'] = OPENAI_PROJECT_ID;

  const ws = new WebSocket(url, { headers });

  const connectTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }, 10000);

  ws.on('open', () => {
    clearTimeout(connectTimeout);
    console.log(`[WS] Sideband conectado call_id=${callId}`);
    activeCalls.set(callId, ws);

    sendSessionUpdate(ws, callId);
    sendResponseCreate(ws, callId);
  });

  ws.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch { return; }

    if (event.type === 'response.function_call_arguments.done') {
      console.log(`[WS] Function call: ${event.name}`);
      handleFunctionCall(ws, event, callId);
      return;
    }

    switch (event.type) {
      case 'session.created':
        console.log(`[WS] Sesion creada`);
        break;
      case 'session.updated':
        console.log(`[WS] Sesion actualizada — tools configuradas`);
        break;
      case 'response.done':
        console.log(`[WS] Respuesta completada`);
        break;
      case 'input_audio_buffer.speech_started':
        console.log(`[WS] Usuario habla`);
        break;
      case 'input_audio_buffer.speech_stopped':
        console.log(`[WS] Usuario callo`);
        break;
      case 'response.audio_transcript.done':
        console.log(`[WS] Modelo: "${event.transcript}"`);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        console.log(`[WS] Usuario: "${event.transcript}"`);
        break;
      case 'error':
        console.error('[WS] Error:', JSON.stringify(event.error));
        break;
      default:
        break;
    }
  });

  ws.on('close', (code) => {
    clearTimeout(connectTimeout);
    console.log(`[WS] Cerrado call_id=${callId} (code=${code})`);
    activeCalls.delete(callId);
  });

  ws.on('error', (err) => {
    clearTimeout(connectTimeout);
    console.error(`[WS] Error call_id=${callId}:`, err.message);
    activeCalls.delete(callId);
  });
}

// ============================================================================
// SESSION UPDATE & RESPONSE CREATE
// ============================================================================

function sendSessionUpdate(ws, callId) {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.6
    }
  }));
  console.log(`[WS] Enviado session.update con ${TOOLS.length} tools`);
}

function sendResponseCreate(ws, callId) {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'response.create',
    response: {
      instructions: `Saluda al paciente, preséntate como el asistente virtual de ${BUSINESS.name} y pregunta en qué puedes ayudarle.`
    }
  }));
  console.log(`[WS] Enviado response.create — modelo saluda`);
}

// ============================================================================
// FUNCTION CALL HANDLER
// ============================================================================

function handleFunctionCall(ws, event, callId) {
  const functionName = event.name;
  const functionCallId = event.call_id;

  let args;
  try {
    args = JSON.parse(event.arguments);
  } catch {
    sendToolOutput(ws, functionCallId, { error: 'invalid_arguments' }, callId);
    return;
  }

  console.log(`[TOOL] ${functionName}(${JSON.stringify(args)})`);

  switch (functionName) {
    case 'check_availability':
      handleCheckAvailability(ws, functionCallId, args, callId);
      break;
    case 'book_appointment':
      handleBookAppointment(ws, functionCallId, args, callId);
      break;
    default:
      sendToolOutput(ws, functionCallId, { error: 'unknown_tool' }, callId);
      break;
  }
}

// ============================================================================
// CHECK AVAILABILITY — Google Calendar
// ============================================================================

async function handleCheckAvailability(ws, functionCallId, args, callId) {
  const { date, service_type } = args;
  const service = BUSINESS.services[service_type];

  if (!service) {
    sendToolOutput(ws, functionCallId, { error: `Servicio '${service_type}' no existe` }, callId);
    return;
  }

  // Que dia de la semana es (1=lunes ... 7=domingo)
  const dayDate = new Date(date + 'T12:00:00');
  const dayOfWeek = dayDate.getDay() === 0 ? 7 : dayDate.getDay(); // JS: 0=domingo
  const windows = BUSINESS.schedule[dayOfWeek];

  if (!windows) {
    sendToolOutput(ws, functionCallId, {
      status: 'no_availability',
      message: 'La clinica no abre ese dia (solo lunes a viernes).'
    }, callId);
    return;
  }

  // Si no tenemos Google Calendar, devolver slots teoricos
  if (!calendar) {
    const slots = generateTheoreticalSlots(date, windows, service.duration);
    sendToolOutput(ws, functionCallId, {
      status: 'success',
      date,
      service: service.name,
      duration_minutes: service.duration,
      available_slots: slots,
      note: 'Datos sin verificar contra agenda real (Google Calendar no configurado)'
    }, callId);
    return;
  }

  try {
    // Consultar eventos del dia en Google Calendar
    const timeMin = `${date}T00:00:00`;
    const timeMax = `${date}T23:59:59`;

    const eventsRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: BUSINESS.timezone
    });

    const busySlots = (eventsRes.data.items || []).map(ev => ({
      start: ev.start.dateTime || ev.start.date,
      end: ev.end.dateTime || ev.end.date
    }));

    console.log(`[GCAL] ${busySlots.length} eventos encontrados el ${date}`);

    // Generar slots libres
    const freeSlots = generateFreeSlots(date, windows, service.duration, busySlots);

    sendToolOutput(ws, functionCallId, {
      status: freeSlots.length > 0 ? 'success' : 'no_availability',
      date,
      service: service.name,
      duration_minutes: service.duration,
      available_slots: freeSlots,
      message: freeSlots.length === 0 ? 'No hay huecos disponibles ese dia.' : undefined
    }, callId);

  } catch (err) {
    console.error('[GCAL] Error consultando calendario:', err.message);
    sendToolOutput(ws, functionCallId, {
      error: 'Error consultando la agenda. Intentelo de nuevo.'
    }, callId);
  }
}

/**
 * Genera slots libres dados las ventanas horarias, duracion y eventos ocupados.
 */
function generateFreeSlots(date, windows, durationMinutes, busySlots) {
  const slots = [];
  const now = new Date();

  for (const window of windows) {
    const [startH, startM] = window.start.split(':').map(Number);
    const [endH, endM] = window.end.split(':').map(Number);
    const windowStartMin = startH * 60 + startM;
    const windowEndMin = endH * 60 + endM;

    // Generar slots cada 30 minutos dentro de la ventana
    for (let min = windowStartMin; min + durationMinutes <= windowEndMin; min += 30) {
      const slotStart = new Date(`${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

      // Saltar slots en el pasado
      if (slotStart < now) continue;

      // Verificar que no solape con ningun evento existente
      const overlaps = busySlots.some(busy => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return slotStart < busyEnd && slotEnd > busyStart;
      });

      if (!overlaps) {
        slots.push(`${pad(Math.floor(min / 60))}:${pad(min % 60)}`);
      }
    }
  }

  return slots;
}

/**
 * Genera slots teoricos sin verificar agenda (fallback sin Google Calendar).
 */
function generateTheoreticalSlots(date, windows, durationMinutes) {
  const slots = [];
  const now = new Date();

  for (const window of windows) {
    const [startH, startM] = window.start.split(':').map(Number);
    const [endH, endM] = window.end.split(':').map(Number);
    const windowStartMin = startH * 60 + startM;
    const windowEndMin = endH * 60 + endM;

    for (let min = windowStartMin; min + durationMinutes <= windowEndMin; min += 30) {
      const slotStart = new Date(`${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`);
      if (slotStart < now) continue;
      slots.push(`${pad(Math.floor(min / 60))}:${pad(min % 60)}`);
    }
  }
  return slots;
}

function pad(n) { return n.toString().padStart(2, '0'); }

// ============================================================================
// BOOK APPOINTMENT — Google Calendar
// ============================================================================

async function handleBookAppointment(ws, functionCallId, args, callId) {
  const { date, time, service_type, patient_name } = args;
  const service = BUSINESS.services[service_type];

  if (!service) {
    sendToolOutput(ws, functionCallId, { error: `Servicio '${service_type}' no existe` }, callId);
    return;
  }

  if (!calendar) {
    sendToolOutput(ws, functionCallId, {
      status: 'success',
      message: `Cita reservada (modo demo): ${service.name} para ${patient_name} el ${date} a las ${time}.`,
      note: 'Google Calendar no configurado — reserva no guardada realmente'
    }, callId);
    return;
  }

  try {
    const [h, m] = time.split(':').map(Number);
    const startDateTime = `${date}T${pad(h)}:${pad(m)}:00`;
    const endMinutes = h * 60 + m + service.duration;
    const endDateTime = `${date}T${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}:00`;

    // Verificar que el slot sigue libre
    const eventsRes = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: new Date(startDateTime).toISOString(),
      timeMax: new Date(endDateTime).toISOString(),
      singleEvents: true,
      timeZone: BUSINESS.timezone
    });

    if (eventsRes.data.items && eventsRes.data.items.length > 0) {
      sendToolOutput(ws, functionCallId, {
        status: 'conflict',
        message: 'Ese hueco ya esta ocupado. Por favor elige otro horario.'
      }, callId);
      return;
    }

    // Crear evento
    const event = {
      summary: `${service.name} - ${patient_name}`,
      description: `Reserva automatica via telefono.\nPaciente: ${patient_name}\nServicio: ${service.name} (${service.duration} min)`,
      start: {
        dateTime: startDateTime,
        timeZone: BUSINESS.timezone
      },
      end: {
        dateTime: endDateTime,
        timeZone: BUSINESS.timezone
      },
      colorId: '9' // Azul
    };

    const created = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      resource: event
    });

    console.log(`[GCAL] Evento creado: ${created.data.id}`);

    sendToolOutput(ws, functionCallId, {
      status: 'success',
      message: `Cita confirmada: ${service.name} para ${patient_name} el ${date} a las ${time}.`,
      event_id: created.data.id
    }, callId);

  } catch (err) {
    console.error('[GCAL] Error creando evento:', err.message);
    sendToolOutput(ws, functionCallId, {
      error: 'Error guardando la cita. Intentelo de nuevo.'
    }, callId);
  }
}

// ============================================================================
// WEBSOCKET SEND HELPERS
// ============================================================================

function sendToolOutput(ws, functionCallId, output, callId) {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: functionCallId,
      output: JSON.stringify(output)
    }
  }));

  ws.send(JSON.stringify({ type: 'response.create' }));
  console.log(`[WS] Enviado tool output + response.create`);
}

// ============================================================================
// ARRANQUE
// ============================================================================

initGoogleCalendar();

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`  ${BUSINESS.name} — Voice Agent`);
  console.log('='.repeat(60));
  console.log(`  HTTP:       http://0.0.0.0:${PORT}`);
  console.log(`  Calendar:   ${calendar ? 'Google Calendar OK' : 'NO CONFIGURADO (mock)'}`);
  console.log(`  Servicios:  ${Object.values(BUSINESS.services).map(s => `${s.name} (${s.duration}min)`).join(', ')}`);
  console.log('='.repeat(60));
});
