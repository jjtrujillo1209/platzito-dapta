"""Voz con Retell: webhook de llamadas y el WebSocket de Custom LLM.

Retell maneja audio, STT, TTS y turnos; en cada turno nos manda el transcript por
el WebSocket y nosotros respondemos en streaming con el mismo cerebro del texto.
Si el contacto interrumpe llega un `response_id` nuevo y se cancela la respuesta en curso.
"""
import asyncio
import hmac
import json
import logging
import statistics
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from .. import llm
from ..canales import retell
from ..ciclo import cerrar
from ..cerebro.motor import (aplicar_acciones_texto, config_de, contexto_para, rellenar, turno_stream)
from ..config import ajustes
from ..db import FabricaSesion, ahora
from ..eventos import emitir
from ..integraciones import credenciales
from ..modelos import Agente, Contacto, Conversacion, Llamada, Mensaje
from ..seguridad import verificar_firma_retell
from .contactos import zona_de_telefono

log = logging.getLogger("platzito.voz")
r = APIRouter(tags=["voz"])


# ─────────────────────────────── Persistencia del transcript ───────────────────────────────

def persistir_transcript(db, conv: Conversacion, transcript: list[dict], hasta: int | None = None):
    """Guarda los turnos del transcript de Retell que aún no estén guardados (idempotente por índice)."""
    guardados = {m.datos.get("t") for m in db.scalars(select(Mensaje).where(
        Mensaje.conversacion_id == conv.id, Mensaje.tipo == "texto"))}
    items = transcript[:hasta] if hasta is not None else transcript
    for i, t in enumerate(items):
        if i in guardados or not (t.get("content") or "").strip():
            continue
        es_agente = t.get("role") == "agent"
        db.add(Mensaje(conversacion_id=conv.id, direccion="saliente" if es_agente else "entrante",
                       autor="ia" if es_agente else "contacto", contenido=t["content"], datos={"t": i}))
    conv.ultimo_mensaje_en = ahora()
    db.commit()


def _utc(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).replace(tzinfo=None)


def aplicar_datos_llamada(db, llamada: Llamada, call: dict):
    """Actualiza la llamada con el objeto `call` de Retell (webhook o consulta)."""
    estado = call.get("call_status", "")
    if estado == "ongoing":
        llamada.estado = "en_curso"
    elif estado in ("ended", "error", "not_connected"):
        llamada.estado = "terminada" if estado == "ended" else "fallida"
    if call.get("start_timestamp"):
        llamada.inicio = _utc(call["start_timestamp"])
    if call.get("end_timestamp"):
        llamada.fin = _utc(call["end_timestamp"])
    if call.get("duration_ms") is not None:
        llamada.duracion_s = int(call["duration_ms"] / 1000)
    elif llamada.inicio and llamada.fin:
        llamada.duracion_s = int((llamada.fin - llamada.inicio).total_seconds())
    if call.get("disconnection_reason"):
        llamada.razon_desconexion = call["disconnection_reason"][:60]
    if llamada.estado in ("terminada", "fallida"):
        llamada.resultado = retell.resultado_de(llamada.razon_desconexion, llamada.duracion_s) \
            if llamada.estado == "terminada" else "fallida"
    if call.get("recording_url"):
        llamada.grabacion_url = call["recording_url"]
    costo = (call.get("call_cost") or {}).get("combined_cost")
    if costo is not None:
        llamada.costo_usd = round(costo / 100, 4)  # Retell reporta centavos
    p50 = ((call.get("latency") or {}).get("e2e") or {}).get("p50")
    if p50 and not llamada.latencia_ms:
        llamada.latencia_ms = int(p50)
    for campo in ("from_number", "to_number", "direction"):
        if call.get(campo):
            llamada.datos = {**(llamada.datos or {}), campo: call[campo]}
    db.commit()


def _llamada_de(db, call: dict) -> Llamada | None:
    meta = call.get("metadata") or {}
    if meta.get("llamada_id"):
        l = db.get(Llamada, int(meta["llamada_id"]))
        if l:
            return l
    return db.scalar(select(Llamada).where(Llamada.retell_call_id == call.get("call_id")))


def _entrante(db, call: dict, agente: Agente) -> Llamada:
    """Llamada que entra por un número con agente asignado: se crea contacto, conversación y llamada."""
    desde = call.get("from_number") or ""
    contacto = db.scalar(select(Contacto).where(Contacto.espacio_id == agente.espacio_id,
                                                Contacto.telefono == desde)) if desde else None
    if not contacto and desde:
        contacto = Contacto(espacio_id=agente.espacio_id, telefono=desde, zona_horaria=zona_de_telefono(desde))
        db.add(contacto)
        db.flush()
    conv = Conversacion(espacio_id=agente.espacio_id, contacto_id=contacto.id if contacto else None,
                        agente_id=agente.id, canal="voz")
    db.add(conv)
    db.flush()
    l = Llamada(espacio_id=agente.espacio_id, conversacion_id=conv.id, contacto_id=conv.contacto_id,
                agente_id=agente.id, retell_call_id=call.get("call_id"), direccion=call.get("direction") or "entrante",
                tipo="web" if call.get("call_type") == "web_call" else "telefono", desde=desde,
                hacia=call.get("to_number") or "", estado="en_curso", inicio=ahora())
    db.add(l)
    db.commit()
    return l


# ─────────────────────────────── Webhook ───────────────────────────────

@r.post("/webhooks/retell")
async def webhook_retell(request: Request):
    crudo = await request.body()
    try:
        cuerpo = json.loads(crudo)
    except json.JSONDecodeError:
        raise HTTPException(400, "JSON inválido")
    evento, call = cuerpo.get("event"), cuerpo.get("call") or {}
    db = FabricaSesion()
    try:
        llamada = _llamada_de(db, call)
        claves = [credenciales(db, llamada.espacio_id if llamada else None, "retell").get("api_key")]
        if ajustes().retell_api_key not in claves:
            claves.append(ajustes().retell_api_key)
        claves = [c for c in claves if c]
        firma = request.headers.get("x-retell-signature")
        if claves and not any(verificar_firma_retell(c, crudo, firma) for c in claves):
            raise HTTPException(401, "Firma inválida")
        if not claves and ajustes().es_produccion:
            raise HTTPException(401, "Retell no configurado")
        if not llamada:
            return {"ok": True, "ignorado": "llamada desconocida"}
        aplicar_datos_llamada(db, llamada, call)
        conv = db.get(Conversacion, llamada.conversacion_id) if llamada.conversacion_id else None
        if evento == "call_ended":
            if conv and call.get("transcript_object"):
                persistir_transcript(db, conv, [{"role": t.get("role"), "content": t.get("content")}
                                                for t in call["transcript_object"]])
            emitir(db, llamada.espacio_id, "llamada.terminada", {
                "llamada_id": llamada.id, "conversacion_id": llamada.conversacion_id,
                "contacto_id": llamada.contacto_id, "resultado": llamada.resultado,
                "razon": llamada.razon_desconexion, "duracion_s": llamada.duracion_s,
                "grabacion_url": llamada.grabacion_url})
            from ..secuencias import al_terminar_llamada

            await al_terminar_llamada(db, llamada)
            if conv:
                if llamada.resultado == "contestada":
                    await cerrar(db, conv, "llamada_terminada")
                else:
                    conv.estado, conv.cerrado_en = "cerrada", ahora()
                    db.commit()
        elif evento == "call_analyzed":
            llamada.datos = {**(llamada.datos or {}), "analisis_retell": call.get("call_analysis")}
            db.commit()
        return {"ok": True}
    finally:
        db.close()


# ─────────────────────────────── WebSocket Custom LLM ───────────────────────────────

class SesionVoz:
    def __init__(self, ws: WebSocket, agente_id: int, call_id: str):
        self.ws = ws
        self.agente_id = agente_id
        self.call_id = call_id
        self.db = FabricaSesion()
        self.llamada: Llamada | None = None
        self.conv: Conversacion | None = None
        self.agente: Agente | None = None
        self.tarea: asyncio.Task | None = None
        self.latencias: list[int] = []
        self.enviado_inicio = False

    async def enviar(self, datos: dict):
        await self.ws.send_text(json.dumps(datos, ensure_ascii=False))

    def preparar(self, call: dict):
        self.agente = self.db.get(Agente, self.agente_id)
        if not self.agente or self.agente.archivado:
            raise ValueError("Agente inexistente")
        self.llamada = _llamada_de(self.db, {**call, "call_id": self.call_id})
        if self.llamada and (self.llamada.espacio_id != self.agente.espacio_id or
                             (self.llamada.retell_call_id and self.llamada.retell_call_id != self.call_id)):
            log.warning("Metadata de llamada ajena en WS de voz (agente %s, call %s)", self.agente_id, self.call_id)
            self.llamada = self.db.scalar(select(Llamada).where(Llamada.retell_call_id == self.call_id,
                                                                Llamada.espacio_id == self.agente.espacio_id))
        if not self.llamada:
            self.llamada = _entrante(self.db, {**call, "call_id": self.call_id}, self.agente)
        else:
            self.llamada.estado = "en_curso"
            self.llamada.inicio = self.llamada.inicio or ahora()
            if not self.llamada.retell_call_id:
                self.llamada.retell_call_id = self.call_id
            self.db.commit()
        self.conv = self.db.get(Conversacion, self.llamada.conversacion_id)
        variables = call.get("retell_llm_dynamic_variables") or {}
        if variables:
            self.conv.variables = {**(self.conv.variables or {}), **variables}
            self.db.commit()

    def ctx(self):
        borrador = bool((self.conv.variables or {}).get("_borrador"))
        c = contexto_para(self.db, self.conv, self.agente, borrador)
        c.canal = "voz"
        return c

    async def saludar(self):
        if self.enviado_inicio:
            return
        self.enviado_inicio = True
        c = self.ctx()
        cfg = c.config
        texto = rellenar(cfg.get("mensaje_inicial") or "", c.variables) \
            if cfg["quien_habla_primero"] == "agente" else ""
        await self.enviar({"response_type": "response", "response_id": 0, "content": texto,
                           "content_complete": True, "end_call": False})

    async def responder(self, evento: dict):
        response_id = evento["response_id"]
        inicio = time.monotonic()
        primero = True
        transcript = evento.get("transcript") or []
        persistir_transcript(self.db, self.conv, transcript)
        mensajes = [{"rol": "asistente" if t["role"] == "agent" else "usuario", "texto": t["content"]}
                    for t in transcript if t.get("content")]
        if evento["interaction_type"] == "reminder_required":
            mensajes.append({"rol": "usuario", "texto": "(El contacto lleva un rato en silencio. Retoma con una "
                                                         "frase breve o pregunta si sigue ahí.)"})
        if not mensajes or mensajes[0]["rol"] != "usuario":
            mensajes.insert(0, {"rol": "usuario", "texto": "(el contacto contestó la llamada)"})
        c = self.ctx()
        resumen = {}
        try:
            async for ev in turno_stream(c, mensajes):
                if ev[0] in ("texto", "espera"):
                    if primero:
                        self.latencias.append(int((time.monotonic() - inicio) * 1000))
                        primero = False
                    await self.enviar({"response_type": "response", "response_id": response_id, "content": ev[1],
                                       "content_complete": False})
                elif ev[0] == "herramienta":
                    for res in ev[1]["resultados"]:
                        await self.enviar({"response_type": "tool_call_invocation", "tool_call_id": res["id"],
                                           "name": res["nombre"], "arguments": json.dumps(res["args"])})
                        await self.enviar({"response_type": "tool_call_result", "tool_call_id": res["id"],
                                           "content": str(res["resultado"])[:2000]})
                    self.db.add(Mensaje(conversacion_id=self.conv.id, direccion="saliente", autor="ia",
                                        tipo="herramienta", contenido=ev[1]["texto"],
                                        datos={"llamadas": ev[1]["llamadas"], "resultados": ev[1]["resultados"]}))
                    self.db.commit()
                elif ev[0] == "fin":
                    resumen = ev[1]
        except llm.ErrorLLM as e:
            log.error("LLM falló en llamada %s: %s", self.call_id, e)
            await self.enviar({"response_type": "response", "response_id": response_id,
                               "content": "Disculpa, tuve un problema técnico. Te contactaremos de nuevo.",
                               "content_complete": True, "end_call": True})
            return
        final = {"response_type": "response", "response_id": response_id, "content": "", "content_complete": True,
                 "end_call": False}
        tipos = {a["tipo"]: a for a in resumen.get("acciones", [])}
        if "transferir" in tipos:
            final["transfer_number"] = tipos["transferir"]["numero"]
        elif "colgar" in tipos:
            final["end_call"] = True
        await self.enviar(final)
        self.conv.tokens_entrada += resumen.get("entrada", 0)
        self.conv.tokens_salida += resumen.get("salida", 0)
        self.conv.costo_usd = round(self.conv.costo_usd + resumen.get("costo", 0), 6)
        aplicar_acciones_texto(self.db, self.conv, [a for a in resumen.get("acciones", [])
                                                    if a["tipo"] in ("escalar", "cita_agendada")])
        self.db.commit()

    def cerrar(self):
        try:
            if self.llamada and self.latencias:
                self.llamada.latencia_ms = int(statistics.median(self.latencias))
                self.llamada.datos = {**(self.llamada.datos or {}), "latencias_llm_ms": self.latencias[-50:]}
                self.db.commit()
        finally:
            self.db.close()


@r.websocket("/voz/llm/{agente_id}/{firma}/{call_id}")
async def ws_llm(ws: WebSocket, agente_id: int, firma: str, call_id: str):
    if not hmac.compare_digest(firma, retell.firma_ws(agente_id)):
        await ws.close(code=1008)
        return
    await ws.accept()
    s = SesionVoz(ws, agente_id, call_id)
    try:
        await s.enviar({"response_type": "config", "config": {"auto_reconnect": True, "call_details": True}})
        while True:
            try:
                evento = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=1.5 if not s.llamada else 600))
            except asyncio.TimeoutError:
                if not s.llamada:  # Retell no mandó call_details: seguimos con lo que hay
                    s.preparar({})
                    await s.saludar()
                continue
            tipo = evento.get("interaction_type")
            if tipo == "call_details":
                s.preparar(evento.get("call") or {})
                await s.saludar()
            elif tipo == "ping_pong":
                await s.enviar({"response_type": "ping_pong", "timestamp": evento.get("timestamp")})
            elif tipo in ("response_required", "reminder_required"):
                if not s.llamada:
                    s.preparar({})
                    s.enviado_inicio = True
                if s.tarea and not s.tarea.done():
                    s.tarea.cancel()  # el contacto interrumpió: la respuesta vieja ya no sirve
                s.tarea = asyncio.create_task(s.responder(evento))
            elif tipo == "update_only":
                pass
    except WebSocketDisconnect:
        pass
    except ValueError as e:
        log.warning("WS de voz rechazado: %s", e)
        await ws.close(code=1008)
    finally:
        if s.tarea and not s.tarea.done():
            s.tarea.cancel()
        s.cerrar()
