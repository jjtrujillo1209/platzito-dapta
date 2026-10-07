# 1. Stack y topología

- **Frontend:** Angular (standalone + esbuild), design system propio `dui-*`, i18n en/es.
- **Hosting:** AWS `us-east-2`, Kubernetes (EKS) tras ALBs.
- **Auth:** WorkOS AuthKit (`auth.dapta.ai`).
- **Observabilidad:** PostHog autohospedado (proxy), Sentry, Datadog RUM.
- **Marketing/CRM propio:** HubSpot, Brevo, UserGuiding, GTM.

## Microservicios (de la config de entorno del bundle)

| Host | Rol inferido |
|---|---|
| `api.dapta.ai` (flowrunner) | **Motor de flows** (Flow Studio): cada endpoint de negocio es un flow publicado `/api/{workspace}/{flow}`. Aquí entran los webhooks de WhatsApp/IG/Messenger |
| `agents-v2.dapta.ai/text-agent-v2/api/v2` | Agentes de texto v2 (conversaciones, mensajes, feedback, export) |
| `call-rest-api.dapta.ai` | API de llamadas (logs, columnas, export) |
| `webcall-back.dapta.ai` | Crea web calls |
| `brains.dapta.ai` | Knowledge base |
| `backend.dapta.ai` | Backend general (números, regulación Twilio) |
| `orbit.dapta.ai/crm`, `services2.dapta.ai` | CRM interno y "Dapta DB" |
| `services.dapta.ai/ta/v1/workflow/generate` | Generación de flows con IA |
| `notetaker.dapta.ai` | Notetaker de reuniones (Recall.ai) |
| `widget.dapta.ai`, `widget-v2.dapta.ai` | Widget web de chat/voz embebible |

## Proveedores detectados

| Capa | Proveedores |
|---|---|
| Voz | **Retell AI**; migración a LiveKit propio (flag `sip_trunk_migration` → `isLiveKitAgent()`) |
| WhatsApp | Meta directo (actual), Twilio, Aldeamo, Bird/MessageBird (legacy; también IG y Messenger) |
| LLM | OpenAI (incl. `gpt-realtime`), Gemini (incl. `gemini-live`), Anthropic, Groq |
| TTS / STT | ElevenLabs, Cartesia / Deepgram |
| Telefonía | Twilio + SIP trunks del cliente |
