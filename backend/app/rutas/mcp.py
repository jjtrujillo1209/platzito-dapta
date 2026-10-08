"""Servidor MCP (Streamable HTTP, JSON-RPC) para operar Platzito desde Claude u otros agentes.

Autenticación: clave de API del espacio como `Authorization: Bearer pz_...`.
Las escrituras siguen el patrón vista previa → confirmación: sin `confirmar: true`
devuelven qué harían, y solo con `confirmar: true` aplican el cambio.
"""
import json
from datetime import timedelta

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select

from .. import serial
from ..cerebro.config import normalizar
from ..db import ahora
from ..modelos import Agente, Contacto, Conversacion, Llamada, Secuencia
from ..seguridad import NIVEL, Contexto, contexto
from . import metricas as rutas_metricas

r = APIRouter(tags=["mcp"])
VERSION_PROTOCOLO = "2025-06-18"


def _h(nombre, descripcion, props=None, requeridos=None):
    return {"name": nombre, "description": descripcion,
            "inputSchema": {"type": "object", "properties": props or {}, "required": requeridos or []}}


CONFIRMAR = {"confirmar": {"type": "boolean", "description": "false = vista previa; true = aplicar"}}
HERRAMIENTAS = [
    _h("metricas", "KPIs del espacio: conversaciones, tasa de éxito, llamadas, tasa de conexión, costo.",
       {"dias": {"type": "integer", "default": 30}}),
    _h("listar_llamadas", "Llamadas recientes con resultado, duración y resumen.",
       {"dias": {"type": "integer", "default": 7}, "resultado": {"type": "string"},
        "limite": {"type": "integer", "default": 20}}),
    _h("leads_calificados", "Contactos cuyas conversaciones el análisis marcó como exitosas.",
       {"dias": {"type": "integer", "default": 7}}),
    _h("listar_conversaciones", "Conversaciones del Inbox.",
       {"estado": {"type": "string", "enum": ["abierta", "esperando_humano", "cerrada"]},
        "limite": {"type": "integer", "default": 20}}),
    _h("ver_conversacion", "Transcript y análisis de una conversación.",
       {"conversacion_id": {"type": "integer"}}, ["conversacion_id"]),
    _h("buscar_contactos", "Busca contactos por nombre, teléfono, correo o empresa.",
       {"q": {"type": "string"}}, ["q"]),
    _h("listar_agentes", "Agentes del espacio con su versión publicada."),
    _h("listar_secuencias", "Secuencias outbound y su estado."),
    _h("crear_contacto", "Crea un contacto (vista previa salvo confirmar=true).",
       {"nombre": {"type": "string"}, "telefono": {"type": "string"}, "email": {"type": "string"},
        "empresa": {"type": "string"}, **CONFIRMAR}, ["nombre"]),
    _h("inscribir_en_secuencia", "Inscribe contactos en una secuencia (vista previa salvo confirmar=true).",
       {"secuencia_id": {"type": "integer"}, "contacto_ids": {"type": "array", "items": {"type": "integer"}},
        **CONFIRMAR}, ["secuencia_id", "contacto_ids"]),
    _h("editar_instrucciones_agente", "Cambia el prompt del borrador de un agente (vista previa salvo confirmar).",
       {"agente_id": {"type": "integer"}, "instrucciones": {"type": "string"}, **CONFIRMAR},
       ["agente_id", "instrucciones"]),
]
ESCRITURA = {"crear_contacto", "inscribir_en_secuencia", "editar_instrucciones_agente"}


def _texto(datos) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(datos, ensure_ascii=False, default=str, indent=1)}]}


async def _ejecutar(ctx: Contexto, nombre: str, a: dict):
    db = ctx.db
    if nombre in ESCRITURA and NIVEL[ctx.rol] < NIVEL["editor"]:
        return {"error": "La clave de API no tiene permisos de escritura"}
    if nombre == "metricas":
        desde = (ahora() - timedelta(days=int(a.get("dias", 30)))).isoformat()
        return rutas_metricas.metricas(desde, None, None, ctx)
    if nombre == "listar_llamadas":
        desde = (ahora() - timedelta(days=int(a.get("dias", 7)))).isoformat()
        datos = rutas_metricas.llamadas(desde, None, None, a.get("resultado", ""), "", 1, ctx)
        return datos["llamadas"][: int(a.get("limite", 20))]
    if nombre == "leads_calificados":
        filas = db.scalars(select(Conversacion).where(
            Conversacion.espacio_id == ctx.espacio_id, Conversacion.exito.is_(True),
            Conversacion.creado >= ahora() - timedelta(days=int(a.get("dias", 7))))
            .order_by(Conversacion.id.desc()).limit(100)).all()
        return [{"conversacion_id": c.id, "canal": c.canal, "contacto": serial.contacto(c.contacto)
                 if c.contacto else None, "resumen": c.resumen, "datos": c.analisis} for c in filas]
    if nombre == "listar_conversaciones":
        q = select(Conversacion).where(Conversacion.espacio_id == ctx.espacio_id,
                                       Conversacion.canal.not_in(("playground", "simulador")))
        if a.get("estado"):
            q = q.where(Conversacion.estado == a["estado"])
        return [serial.conversacion(c) for c in db.scalars(q.order_by(Conversacion.ultimo_mensaje_en.desc())
                                                           .limit(int(a.get("limite", 20))))]
    if nombre == "ver_conversacion":
        from .conversaciones import ver

        return ver(int(a["conversacion_id"]), ctx)
    if nombre == "buscar_contactos":
        like = f"%{a['q']}%"
        return [serial.contacto(c) for c in db.scalars(select(Contacto).where(
            Contacto.espacio_id == ctx.espacio_id, or_(Contacto.nombre.ilike(like), Contacto.telefono.ilike(like),
                                                       Contacto.email.ilike(like), Contacto.empresa.ilike(like)))
            .limit(25))]
    if nombre == "listar_agentes":
        return [serial.agente(x) for x in db.scalars(select(Agente).where(Agente.espacio_id == ctx.espacio_id,
                                                                          Agente.archivado.is_(False)))]
    if nombre == "listar_secuencias":
        from .secuencias import listar

        return listar(ctx)
    if nombre == "crear_contacto":
        from .contactos import DatosContacto, crear

        datos = DatosContacto(nombre=a.get("nombre"), telefono=a.get("telefono"), email=a.get("email"),
                              empresa=a.get("empresa"))
        if not a.get("confirmar"):
            return {"vista_previa": datos.model_dump(exclude_none=True), "nota": "Repite con confirmar=true"}
        return crear(datos, ctx)
    if nombre == "inscribir_en_secuencia":
        sec = db.get(Secuencia, int(a["secuencia_id"]))
        if not sec or sec.espacio_id != ctx.espacio_id:
            return {"error": "Secuencia no encontrada"}
        ids = [int(i) for i in a.get("contacto_ids", [])]
        if not a.get("confirmar"):
            validos = db.scalars(select(Contacto).where(Contacto.espacio_id == ctx.espacio_id,
                                                        Contacto.id.in_(ids))).all()
            return {"vista_previa": {"secuencia": sec.nombre, "estado": sec.estado,
                                     "contactos": [c.nombre or c.telefono for c in validos]},
                    "nota": "Repite con confirmar=true"}
        from .secuencias import Inscribir, inscribir

        return inscribir(sec.id, Inscribir(contacto_ids=ids), ctx)
    if nombre == "editar_instrucciones_agente":
        ag = db.get(Agente, int(a["agente_id"]))
        if not ag or ag.espacio_id != ctx.espacio_id:
            return {"error": "Agente no encontrado"}
        cfg = normalizar(ag.config_borrador)
        if not a.get("confirmar"):
            return {"vista_previa": {"antes": cfg["instrucciones"][:2000], "despues": a["instrucciones"][:2000]},
                    "nota": "Repite con confirmar=true; luego publica desde la app"}
        cfg["instrucciones"] = a["instrucciones"]
        ag.config_borrador = cfg
        db.commit()
        return {"ok": True, "nota": "Borrador actualizado. Publica el agente para que entre en producción."}
    return {"error": f"Herramienta desconocida: {nombre}"}


@r.post("/mcp")
async def mcp(pedido: dict, ctx: Contexto = Depends(contexto)):
    metodo, id_ = pedido.get("method"), pedido.get("id")
    if id_ is None:  # notificación (p. ej. notifications/initialized)
        return JSONResponse(status_code=202, content=None)
    if metodo == "initialize":
        resultado = {"protocolVersion": VERSION_PROTOCOLO, "capabilities": {"tools": {}},
                     "serverInfo": {"name": "platzito", "version": "1.0.0"},
                     "instructions": "Herramientas para consultar y operar Platzito. Las escrituras requieren "
                                     "confirmar=true después de revisar la vista previa."}
    elif metodo == "tools/list":
        resultado = {"tools": HERRAMIENTAS}
    elif metodo == "tools/call":
        p = pedido.get("params", {})
        try:
            resultado = _texto(await _ejecutar(ctx, p.get("name"), p.get("arguments") or {}))
        except Exception as e:
            resultado = {**_texto({"error": str(e)}), "isError": True}
    elif metodo == "ping":
        resultado = {}
    else:
        return {"jsonrpc": "2.0", "id": id_, "error": {"code": -32601, "message": f"Método no soportado: {metodo}"}}
    return {"jsonrpc": "2.0", "id": id_, "result": resultado}
