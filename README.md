# Voice Booking Agent MVP

MVP de agente de voz para gestionar reservas mediante conversación natural.

---

## Qué es

Este proyecto explora cómo construir un agente de voz capaz de atender llamadas, entender una intención de reserva y conectarse con un sistema backend para confirmar disponibilidad sin inventar información.

El foco no está solo en que el agente “hable bien”, sino en que el flujo sea fiable: que consulte datos, confirme pasos y evite errores típicos como dobles reservas o respuestas alucinadas.

---

## Por qué lo hice

Los agentes de voz son una de las áreas más interesantes de la IA aplicada a negocios pequeños: restaurantes, clínicas, barberías, centros deportivos, academias o cualquier negocio que recibe llamadas repetitivas.

Quería probar una arquitectura donde el agente conversacional no tuviera todo el control, sino que actuara como interfaz de voz sobre una lógica más determinista.

---

## Objetivos del MVP

- Probar una experiencia de reserva por voz.
- Separar conversación y lógica de negocio.
- Diseñar un flujo con confirmación antes de guardar una reserva.
- Evitar dobles reservas mediante backend.
- Explorar integraciones con proveedores de voz, webhooks y base de datos.

---

## Arquitectura conceptual

1. El usuario habla con el agente.
2. El agente recoge intención, fecha, hora y datos básicos.
3. El backend valida disponibilidad.
4. El sistema confirma la reserva o propone alternativas.
5. La conversación se mantiene natural, pero las decisiones críticas pasan por lógica controlada.

---

## Qué estoy practicando con este proyecto

- Agentes de voz.
- IA conversacional.
- Webhooks.
- Backend para lógica determinista.
- Diseño de flujos seguros para reservas.
- Integración entre herramientas de IA y sistemas de negocio.

---

## Posibles casos de uso

- Restaurantes.
- Barberías.
- Clínicas.
- Centros deportivos.
- Academias.
- Negocios con llamadas repetitivas y agenda.

---

## Próximas mejoras posibles

- Añadir persistencia real de reservas.
- Conectar con Google Calendar.
- Añadir panel de administración.
- Mejorar trazabilidad de llamadas.
- Probar varios proveedores de voz.
- Añadir métricas de latencia y tasa de éxito.
