# 3. Voz y telefonía

## Arquitectura real

```
 contacto ◄──► Twilio / SIP trunk ◄──► RETELL AI (STT, TTS, turnos, buzón, DTMF)
                                          │  LLM: Retell-LLM  ó  Custom LLM por WebSocket ──► servidor de Dapta
                                          ▼
                        webhooks de llamada → post-call analysis → flows / CRM
```

El "agente de voz" de Dapta es un registro que **espeja un agente Retell** (`voice_retell_agent_id`, `voice_llm_id`, `voice_retell_llm_websocket_url`, `voice_retell_webhook_url`). Web call: `webcall-back` → token Retell → `wss://retell-ai-*.livekit.cloud`.

## Superficie de configuración (46 campos, casi idénticos a la API de Retell)

| Grupo | Campos |
|---|---|
| Identidad | `name`, `purpose`, `instructions`, `company_context_id`, `begin_message` (+ tipo, delay), variables `{{var}}` |
| LLM | `model`, `temperature`, `top_p`, `kb_config`, `show_sources` |
| Voz | `voice`, `voice_model`, `voice_language`, `voice_speed`, `voice_temperature`, `voice_volume` |
| Turnos | `voice_interruption_sensitivity`, `voice_responsiveness`, `enable_backchannel`, `boosted_keywords`, `speech_replacements`, `normalize_for_speech`, `stt_mode` |
| Llamada | `end_call_after_silence_ms`, `max_call_duration_ms`, `reminder_trigger_ms`/`reminder_max_count`, `voice_ambient_sound`, `allow_user_dtmf`, `digit_limit`, `termination_key` |
| Buzón | `voicemail_detection_enabled`, `voicemail_response_type` (colgar/dejar mensaje), `voicemail_message` |
| Telefonía | `caller_id_type` (`phone_number`/`sip_trunk`), `voice_agent_phone_number`, `sip_trunk_id` |
| Post-llamada | `post_call_analysis_data`, `analysis_summary_prompt`, `analysis_successful_prompt`, `dapta_webhook` |

## Acciones en llamada (`general_tools`)

`end_call`, `transfer_call` (fría), `bridge_transfer`/`cancel_transfer`, `agent_swap`, `press_digit` (IVR), `check_availability_cal`/`book_appointment_cal`, `hubspot`, `custom` (webhook enmascarado) y **`send_whatsapp_template`** (en plena llamada envía una plantilla aprobada). Parámetros tipados: text, number, currency, date, enum, email, phone, boolean, con opción `encrypt`.

## Voz por WhatsApp

Usa la **WhatsApp Business Calling API** sobre la línea del agente de texto. Requiere negocio verificado y límite de 2.000 conversaciones iniciadas por la empresa en 24 h; por eso se conecta primero el agente de texto.

## Telefonía: cuatro formas de tener número

| Modo | Detalle |
|---|---|
| Comprado en Dapta | Subcuentas Twilio; self-serve solo EE. UU. |
| Cumplimiento regulatorio | Wrapper de Twilio Regulatory Compliance (bundles por país); requerido en CO/MX y A2P 10DLC |
| Caller ID verificado | Twilio Verified Caller ID (llama mostrando el número, no recibe) |
| **SIP trunk propio** | Host, puerto, credenciales, DIDs, caller IDs, dirección, canales concurrentes. Enterprise: proxy SIP dedicado con IP fija |

Llamada saliente: `POST /ca/v1/create-phone-call` (→ Retell, o LiveKit SIP con el flag de migración). Campañas con **rotación de números** para no quemar un caller ID como spam.

**Para CO/MX:** conviene número local (la contestación cae mucho con +1): Twilio con bundle regulatorio o SIP trunk con operador local (más barato y mejor reputación).

## Qué construir

| Capacidad | Decisión |
|---|---|
| Motor de voz | **Fase 1: Retell** + Custom LLM WebSocket al mismo cerebro del agente de texto (comparten prompt, tools y guardas). **Fase 2:** LiveKit Agents + SIP autohospedado si el costo por minuto no cierra |
| Config | Modelo `VoiceAgent` con subconjunto (prompt, voz, idioma, interrupción, buzón, silencio, duración, variables), sync por `PATCH` a Retell |
| Tools en llamada | `end_call`, `transfer_call`, `book_meeting`, `send_whatsapp_template` |
| Webhooks | `/webhooks/retell` con firma `x-retell-signature` → eventos `call_completed/voicemail/no_answer` |
| Números | Modelo `PhoneNumber` + `SipTrunk` (credenciales cifradas). Compra y regulatorio manuales en v1 |
