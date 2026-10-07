# 4. Campañas outbound

Dapta usa dos motores de **un solo canal** unidos por fallback cruzado:

```
Voice Sequence ──(no contestó tras N intentos)──► plantilla WhatsApp  (WhatsApp fallback)
Text Sequence  ──(sin respuesta en 1–24 h)─────► llamada del agente   (Call fallback)
```

## Voice Sequence

| Regla | Valor |
|---|---|
| Asistente | nombre + agente (A/B hasta 4 agentes, pesos suman 100 %) → horario → fuente de contactos → mapeo |
| Contactos | CSV/XLSX, Google Sheet sincronizado, webhook, lista HubSpot, HTTP API, Flow Studio |
| Horario | zona horaria, días, varias franjas/día; fuera de franja se reprograma sin contar intento |
| Intentos | máx. por contacto 1–40, por día 1–5 (recomendado 3 y 1) |
| Ritmo | lotes 1–500 (def. 100), 1 llamada cada 3 s por secuencia |
| Cooldown | **1 h por contacto, global entre secuencias** |
| Concurrencia | Free 1 · Pro 5 · Scale-Up 20 · Enterprise 30 llamadas vivas |
| Rotación | 2+ números de salida |
| WhatsApp fallback | plantilla aprobada, "enviar tras el intento N", solo si **nunca** conectó |
| Estados | Draft, Scheduled, Running, Waiting, Paused, Completed, Failed, Manual Running |

## Text Sequence (WhatsApp)

Ver [02](02-texto-y-whatsapp.md). **Call fallback:** espera 1–24 h; si no hubo respuesta llama el agente de voz con variables mapeadas, dentro de franja. Estados: Scheduled, Calling, Call made, Answered, Not called, Could not call. El reintento manual se salta franja y fecha fin (confirmar antes).

## Qué construir

Un único modelo multicanal (`Sequence → Step(canal, delay) → Enrollment`, tick idempotente, `stop_on_reply`) cubre los dos motores. Falta agregar las reglas de ejecución del paso de llamada:

| Entidad | Campos |
|---|---|
| Paso `call` | `voice_agent_id`, `max_attempts`, `attempts_per_day`, `retry_gap_min`, `fallback_after_attempt` |
| Sequence | `timezone`, `schedule` (día → franjas), `ab_agents` (agente → peso), `phone_number_ids[]`, `batch_size` |
| `CallAttempt` | n.º de intento, outcome (`answered/no_answer/busy/voicemail/failed`), `retell_call_id`, duración, número usado |
| Motor (`tick`) | ventana por zona del lead, cooldown global 1 h, semáforo de concurrencia por tenant, ritmo, avance según outcome (`no_answer` → reintento o paso WhatsApp) |
| Paso `whatsapp` | `template_name` + `variables`; condición "sin respuesta en X h" → paso `call` |
| Worker | Scheduler externo (p. ej. Cloud Scheduler → `POST /sequences/tick` cada minuto) |
