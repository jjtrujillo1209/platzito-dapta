# 2. Agentes de texto y WhatsApp

## Rutas de conexión a WhatsApp (de la más nueva a la legacy)

| Ruta | Cómo funciona |
|---|---|
| **Meta directo (Tech Provider)** | **Embedded Signup v3 + Coexistence**: `FB.login({config_id, response_type:"code", extras:{featureType:"whatsapp_business_app_onboarding", sessionInfoVersion:3}})`. El front entrega `{code, waba_id, phone_number_id}` al backend, que canjea el code por token, suscribe la app a la WABA y registra el número. El cliente conserva su número y la app WhatsApp Business; lo que el equipo responde desde el celular llega al Inbox (`smb_message_echoes`). Meta factura el envío al cliente |
| Twilio WhatsApp Senders | Subcuentas Twilio; canal `twilio_whatsapp` (legacy) |
| Aldeamo / Bird | BSPs anteriores; Bird también cubría IG y Messenger |

Otros canales: `widget` web, `sms` (EE. UU., A2P 10DLC), `email`.

## Agente de texto

- **Config:** nombre, propósito (solo siembra el prompt inicial; **el prompt es la fuente de verdad**), contexto de empresa, modelo + temperatura por agente.
- **Ciclo:** borrador → playground → publicar (`/draft`, `/publish`, `/duplicate`, `/execute`), versionado.
- **Conversación:** cierre por inactividad (10 min–24 h), demora antes de responder, respuestas partidas, indicador "escribiendo".
- **Follow-ups:** hasta 3, entre 5 min y 24 h desde la última respuesta del agente, siempre dentro de la ventana de 24 h. Contenido estático, generado por IA o vía webhook.
- **Tools:** `API` genérica (el LLM llena los parámetros), `request_human_agent`, agendamiento. Nodos internos: `api`, `conditional`, `human_handover`, `tool_call`, `end_conversation`, `webhook`.
- **Inbox humano:** estados `Open` / `Awaiting first reply` / `Closed`. Asignar = toma humana y **apaga la IA**; quitar asignación = vuelve la IA.

## Plantillas y sequences de WhatsApp

- Plantillas con carpetas, variables, A/B (`/template-experiment`), registro por línea y sync con Meta.
- Estados de sequence: Queued, Running, Waiting (horario/contactos/tope diario), Paused, Completed, Cancelled, Failed.
- **Protección de línea** (lo más valioso a replicar): monitoreo de quality rating y tier, calentamiento de líneas nuevas, tope diario ligado al volumen reciente, dedupe de 24 h por contacto y canal, opt-out, **pausa automática de marketing** si cae la calidad, reintentos (3 si transitorio; espera si rate limit).
- **Costos:** Dapta cobra créditos por IA; Meta cobra el envío directo (CO marketing USD 0,0125 / utility 0,0008; MX 0,0397 / 0,0085). Respuestas de servicio gratis hasta 1.000/mes por número.

## Qué construir

| Capacidad | Requisito |
|---|---|
| Embedded Signup + Coexistence | App Meta + Tech Provider; endpoint de intercambio code→token + `subscribed_apps` + `register`; tokens cifrados |
| Webhook entrante | Verificación `X-Hub-Signature-256`, dedupe por `wamid`, cola, loop agéntico, respuesta por Cloud API |
| Agente configurable | Modelo `TextAgent` por tenant, draft/publish, tools API + `request_human_agent` |
| Inbox | `Conversation`/`Message`, asignación que apaga la IA |
| Sequences WA | Plantillas aprobadas (fuera de 24 h el texto libre lo rechaza Meta), warm-up, tope diario, supresión |
| Análisis al cerrar | Evento `conversation_closed` + extractor con esquema |
