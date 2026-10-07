# 5. Knowledge base, análisis y calidad

## Knowledge base ("Brains", `brains.dapta.ai`)

- API: `/brain/v1/workspaces/{ws}/brains[/{id}]`, fuentes en `/brains/{id}/sources` (alta, borrado masivo, `PATCH`, `/retry`), `sitemap/discover`.
- **Un Brain por workspace**, compartido por agentes de texto y voz (`brain_ids[]`). Nombre ≤ 40 caracteres, **hasta 25 fuentes**.
- Fuentes: web (sitemap con árbol por subdominio o URL), archivos (pdf, doc, csv, xls, ppt, msg, html, xml, epub, imágenes con OCR), texto pegado.
- Pipeline asíncrono por fuente: `pending → processing → completed | failed` (reintento).
- Recuperación por agente: `kb_config = { top_k, filter_score }` + `show_sources`.
- En voz el Brain se **espeja a una KB de Retell** (`retell_knowledge_base_id`) para cumplir la latencia; el texto legacy usaba OpenAI Vector Stores.
- **Company Context** (texto de la empresa desde su URL) se inyecta al prompt, no al RAG.

**Construir:** `Brain`/`BrainSource`/`Chunk` por tenant; embeddings por interfaz (`ollama` local `nomic-embed-text`, o proveedor externo; **nunca mock en producción**); sitemap + scraping a markdown, chunks ~800 tokens con solape; archivos pdf/docx/xlsx/csv en v1; tool `knowledge_search` disponible en texto **y** voz (vía el WebSocket, sin depender de la KB de Retell). pgvector cuando pase de unos miles de fragmentos.

## Análisis post-llamada / post-conversación

- **Voz:** `post_call_analysis_data` = variables `{nombre, instrucción, tipo (texto/enum/booleano/número), ejemplos}` + `analysis_summary_prompt` + `analysis_successful_prompt`. Al terminar va a webhook, flow, notificaciones, Sheets o HubSpot.
- **Texto:** igual con scope `persistent` (acumula entre sesiones) o `session`, y `required`. Se dispara con *Close Conversation* o por inactividad.
- Los outbound sin respuesta **no** corren análisis.

**Construir:** `AnalysisSchema` por agente (JSON Schema) → LLM con salida estructurada sobre el transcript → guarda en el lead y emite `call_analyzed`/`conversation_closed`; `analysis_successful` mapea a etapa del funnel.

## Logs y métricas

- Voz: `/call-logs/{org}` con filtros, columnas configurables, export, transcript + audio + emociones. KPIs: créditos, llamadas, contactos únicos, **connection rate**, duración, serie por **disconnection reason** (`user_hangup`, `agent_hangup`, `call_transfer`, `voicemail_reached`, `inactivity`…), embudo. Reporte por email programado.
- Texto: métricas por agente, sesiones por día, 👍/👎 por mensaje y sesión, timeline de tools por mensaje.

## Calidad: evals y simulación

- `/call-eval/{id}/eval` evalúa una llamada real.
- **Simulador** (`/ca/v1/simulate/{persona, behavior-profile, turn}`): un LLM hace de contacto con una persona y perfil (apurado, escéptico, pide humano…) y conversa con el agente **antes de gastar llamadas reales**.
- **Construir (diferencial barato):** dos instancias del LLM en modo texto (agente vs. persona), N escenarios por agente, calificados con rúbrica. Corre sin telefonía.

## Integraciones y extensibilidad

- **Flow Studio:** cada flow publicado es un endpoint HTTP (webhooks entrantes, post-call, custom actions). Nodos: OpenAI, Anthropic, Gemini, HubSpot, Gmail, Sheets, llamada Dapta.
- Conectores: HubSpot, GoHighLevel, Salesforce, Zoho, Google Sheets/Calendar, Cal.com, Slack, Notion, Outlook/Gmail/SMTP, Meta Ads Conversions (CAPI).
- **Dapta MCP:** tools de lectura (`list_calls`, `get_call_analytics`, `find_qualified_leads`, `get_feedback_trends`…) y escritura en dos pasos **`preview_* → commit_*`** (agentes, sequences, contactos; publicar/rollback).
