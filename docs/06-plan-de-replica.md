# 6. Plan de réplica

**Principio:** no copiar pieza por pieza. Reutilizar lo que ya existe (motor de secuencias multicanal, workflows por eventos, RBAC, LLM intercambiable) y construir solo los **canales vivos** (WhatsApp entrante, voz) y las **reglas de ejecución**.

## Arquitectura objetivo

```
WhatsApp (Meta Cloud) ─► /webhooks/whatsapp ─► Conversation/Message ─► TextAgent ─┐
Retell (voz) ──WS─────► /voice/llm-ws/{call} ─► VoiceAgent ─────────────────────►│
Retell webhooks ──────► /webhooks/retell ─► CallAttempt                          ▼
                                   Brain (LLM) + tools: knowledge_search · book_meeting ·
                                   send_whatsapp_template · transfer · save_lead
sequences.tick (scheduler 1 min) ─► email · whatsapp(plantilla) · call(Retell)
workflows.emit_event ─► etapa · webhook · CRM · notificación          Postgres (+ pgvector)
```

## Fases

| Fase | Entregable | Depende de |
|---|---|---|
| 0 | App Meta + Tech Provider (Business Verification + App Review de `whatsapp_business_management` y `whatsapp_business_messaging`), cuenta Retell, número de prueba. **Cuello de botella: arrancar ya** | — |
| 1 | WhatsApp entrante + agente de texto + Inbox con toma humana | 0 |
| 2 | Plantillas + sequences WA (warm-up, tope diario, dedupe 24 h, pausa por quality rating) | 1 |
| 3 | Voz outbound con Retell (Custom LLM WS, SIP, webhooks, tools, web call de prueba) | 0 |
| 4 | Reglas de campaña (intentos, franjas, cooldown, concurrencia, rotación, A/B, fallbacks) | 2, 3 |
| 5 | Brains (RAG local) con `knowledge_search` en texto y voz | — |
| 6 | Análisis estructurado, métricas, simulador de personas | 1, 3 |
| 7 | Embedded Signup self-serve; migrar voz a LiveKit + SIP si el costo lo exige | volumen |

## Validación empírica de la réplica (2026-10-06)

Se construyeron las fases 1, 3 y 5 y se probó contra servicios reales:

| Hallazgo | Detalle |
|---|---|
| Retell E2E OK | Agente creado y sincronizado con custom-llm; web call; Retell abre el WS; `call_details` → saludo con variables; webhooks firmados responden 200 |
| Gotcha del SDK | `create-web-call` v3 exige pasar `transport="gateway"` + `ice_servers` |
| LLM local no basta para tools | `qwen2.5:7b` escribe las llamadas a tools como texto y no escala a humano ni cuelga solo → **guardas deterministas** (texto con tool filtrada nunca se envía; pedido de humano → escala; despedida → cuelga) |
| Latencia | LLM local 1,4–6 s/turno → **usar Claude (o equivalente nativo con tools) para voz**; embeddings pueden seguir locales |
| Audio en navegador | No verificable en Chrome automatizado (permiso de micrófono en `prompt`) |
| Túnel | Con túnel temporal, al cerrarlo hay que re-sincronizar el agente con la URL nueva; en prod usar instancia pública estable que solo sirva webhooks y el WS |

Pendiente: fases 2 y 4, trámite Tech Provider de Meta y validar payloads reales (ver [Límites](../README.md#límites)).
