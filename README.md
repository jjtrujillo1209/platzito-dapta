# Platzito × Dapta — validación de ingeniería inversa

Análisis técnico de la plataforma **Dapta** (agentes conversacionales de texto, voz y WhatsApp) y plan para replicar sus capacidades en Platzito.

> **Método:** ingeniería inversa **pasiva**. Se analizaron los bundles JS públicos de `app.dapta.ai`, DNS, tráfico de red sin sesión y la documentación pública (`docs.dapta.ai`). No se usó ninguna credencial de Dapta ni se accedió a su backend. Los payloads reales de su API **no** se observaron.

## Hallazgo central

Dapta **no construyó el motor de voz**: orquesta **Retell AI** (y migra a **LiveKit + SIP** propio). Su valor está en la capa de producto: WhatsApp multi-proveedor, campañas outbound con fallback cruzado llamada↔WhatsApp, KB por workspace, análisis post-llamada y la UI. Todo eso es replicable.

## Estado de validación

| # | Proceso | Doc | Evidencia | Confianza |
|---|---------|-----|-----------|-----------|
| 1 | Stack y topología | [01](docs/01-stack-y-topologia.md) | Config de entorno del bundle, DNS | Alta |
| 2 | Agentes de texto + WhatsApp | [02](docs/02-texto-y-whatsapp.md) | Bundle, docs públicas | Alta |
| 3 | Agentes de voz | [03](docs/03-voz-y-telefonia.md) | Nombres de campos ≈ API de Retell | Alta |
| 4 | Telefonía (números, SIP) | [03](docs/03-voz-y-telefonia.md) | Endpoints en bundle, docs | Alta |
| 5 | Campañas outbound | [04](docs/04-campanas-outbound.md) | Docs públicas, reglas en UI | Media-alta |
| 6 | Knowledge base ("Brains") | [05](docs/05-conocimiento-y-analisis.md) | Endpoints `brains.dapta.ai` | Media (pipeline interno inferido) |
| 7 | Post-call, evals, integraciones | [05](docs/05-conocimiento-y-analisis.md) | Bundle, docs, MCP público | Media-alta |
| 8 | Plan de réplica | [06](docs/06-plan-de-replica.md) | Síntesis + validación empírica | — |

**Confianza:** *Alta* = visto directamente en bundle/docs. *Media* = inferido de nombres de endpoints/campos. Lo no verificable sin cuenta está en [Límites](#límites).

## Decisiones de arquitectura

1. WhatsApp: **conexión directa con Meta** (Cloud API + Embedded Signup como Tech Provider), sin BSP intermedio.
2. Voz: **Retell** con *Custom LLM WebSocket* sobre el mismo cerebro del agente de texto.
3. Telefonía: **SIP trunk** importado a Retell.
4. Embeddings: **modelo local** (`nomic-embed-text` vía Ollama), nunca mock en producción.

## Límites

- Sin sesión no se ven payloads reales (p. ej. `post_call_analysis`, webhooks de llamada).
- Con una cuenta de prueba de Dapta se podrían validar: esquema de payloads, costos reales en créditos, comportamiento del scheduler de campañas.

## Antipatrón de seguridad a evitar

El bundle público de Dapta expone `x-api-key` fijas de sus webhooks (WhatsApp, custom actions): cualquiera puede invocar esos flows. En nuestra réplica: webhooks con **firma HMAC** por proveedor y secretos solo del lado servidor.
