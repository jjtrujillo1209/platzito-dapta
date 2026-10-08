"""Agentes: borrador → playground → publicar (versionado, rollback) y sincronización con Retell."""
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import llm, serial
from ..canales import retell
from ..cerebro.config import ConfigAgente, normalizar
from ..cerebro.motor import config_de, responder, variables_de
from ..db import ahora
from ..integraciones import credenciales
from ..modelos import (Agente, AgenteVersion, Cerebro, Contacto, Conversacion, Llamada, Mensaje, NumeroTelefono,
                       Plantilla)
from ..seguridad import Contexto, requiere

r = APIRouter(prefix="/api/agentes", tags=["agentes"])


def _agente(ctx: Contexto, agente_id: int) -> Agente:
    a = ctx.db.get(Agente, agente_id)
    if not a or a.espacio_id != ctx.espacio_id or a.archivado:
        raise HTTPException(404, "Agente no encontrado")
    return a


def _validar_recursos(ctx: Contexto, cfg: dict) -> dict:
    """La config solo puede apuntar a cerebros y plantillas del propio espacio."""
    for cid in (cfg.get("conocimiento") or {}).get("cerebro_ids") or []:
        c = ctx.db.get(Cerebro, int(cid))
        if not c or c.espacio_id != ctx.espacio_id:
            raise HTTPException(422, f"Cerebro {cid} inválido")
    for h in cfg.get("herramientas") or []:
        pid = (h.get("config") or {}).get("plantilla_id")
        if pid:
            p = ctx.db.get(Plantilla, int(pid))
            if not p or p.espacio_id != ctx.espacio_id:
                raise HTTPException(422, f"Plantilla {pid} inválida")
    return cfg


@r.get("")
def listar(ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(Agente).where(Agente.espacio_id == ctx.espacio_id, Agente.archivado.is_(False))
                           .order_by(Agente.id.desc())).all()
    return [serial.agente(a) for a in filas]


@r.get("/opciones")
async def opciones(ctx: Contexto = Depends(requiere("lector"))):
    voces = []
    api_key = credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key")
    if api_key:
        try:
            voces = [{"id": v.get("voice_id"), "nombre": v.get("voice_name"), "proveedor": v.get("provider"),
                      "genero": v.get("gender"), "acento": v.get("accent"), "muestra": v.get("preview_audio_url")}
                     for v in await retell.listar_voces(api_key)]
        except retell.ErrorRetell:
            voces = []
    return {"modelos": llm.MODELOS_SUGERIDOS, "voces": voces, "esquema": ConfigAgente.model_json_schema(),
            "defecto": normalizar({})}


class NuevoAgente(BaseModel):
    nombre: str = Field(min_length=1, max_length=120)
    descripcion: str = ""
    config: dict | None = None


@r.post("")
def crear(datos: NuevoAgente, ctx: Contexto = Depends(requiere("editor"))):
    try:
        cfg = normalizar(datos.config)
    except Exception as e:
        raise HTTPException(422, f"Configuración inválida: {e}")
    a = Agente(espacio_id=ctx.espacio_id, nombre=datos.nombre, descripcion=datos.descripcion,
               config_borrador=_validar_recursos(ctx, cfg), clave_publica="pk_" + secrets.token_urlsafe(16))
    ctx.db.add(a)
    ctx.db.commit()
    return serial.agente(a, completo=True)


@r.get("/{agente_id}")
def ver(agente_id: int, ctx: Contexto = Depends(requiere("lector"))):
    return serial.agente(_agente(ctx, agente_id), completo=True)


class Cambios(BaseModel):
    nombre: str | None = None
    descripcion: str | None = None
    config: dict | None = None


@r.patch("/{agente_id}")
def editar(agente_id: int, datos: Cambios, ctx: Contexto = Depends(requiere("editor"))):
    a = _agente(ctx, agente_id)
    if datos.nombre is not None:
        a.nombre = datos.nombre[:120]
    if datos.descripcion is not None:
        a.descripcion = datos.descripcion
    if datos.config is not None:
        try:
            cfg = normalizar(datos.config)
        except Exception as e:
            raise HTTPException(422, f"Configuración inválida: {e}")
        a.config_borrador = _validar_recursos(ctx, cfg)
    ctx.db.commit()
    return serial.agente(a, completo=True)


@r.delete("/{agente_id}")
async def archivar(agente_id: int, ctx: Contexto = Depends(requiere("admin"))):
    a = _agente(ctx, agente_id)
    a.archivado = True
    if a.retell_agent_id:
        await retell.borrar_agente(credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key", ""),
                                   a.retell_agent_id)
    ctx.db.commit()
    return {"ok": True}


@r.post("/{agente_id}/duplicar")
def duplicar(agente_id: int, ctx: Contexto = Depends(requiere("editor"))):
    a = _agente(ctx, agente_id)
    b = Agente(espacio_id=ctx.espacio_id, nombre=f"{a.nombre} (copia)"[:120], descripcion=a.descripcion,
               config_borrador=normalizar(a.config_borrador), clave_publica="pk_" + secrets.token_urlsafe(16))
    ctx.db.add(b)
    ctx.db.commit()
    return serial.agente(b, completo=True)


async def _sincronizar_retell(ctx: Contexto, a: Agente) -> str | None:
    """Crea o actualiza el espejo del agente en Retell. Devuelve un aviso si no se pudo."""
    api_key = credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key")
    if not api_key:
        return "Retell no está configurado: el agente funciona en texto; configura Retell para voz."
    try:
        a.retell_agent_id = await retell.sincronizar_agente(api_key, a.id, a.nombre, config_de(a), a.retell_agent_id)
        a.retell_sincronizado = ahora()
        return None
    except retell.ErrorRetell as e:
        return f"No se pudo sincronizar con Retell: {e}"


@r.post("/{agente_id}/publicar")
async def publicar(agente_id: int, datos: dict | None = None, ctx: Contexto = Depends(requiere("editor"))):
    a = _agente(ctx, agente_id)
    cfg = normalizar(a.config_borrador)
    numero = a.version_publicada + 1
    ctx.db.add(AgenteVersion(agente_id=a.id, numero=numero, config=cfg, nota=((datos or {}).get("nota") or "")[:300],
                             publicado_por=ctx.usuario.id if ctx.usuario else None))
    a.config_publicada = cfg
    a.version_publicada = numero
    aviso = await _sincronizar_retell(ctx, a)
    ctx.db.commit()
    return {**serial.agente(a, completo=True), "aviso": aviso}


@r.get("/{agente_id}/versiones")
def versiones(agente_id: int, ctx: Contexto = Depends(requiere("lector"))):
    _agente(ctx, agente_id)
    filas = ctx.db.scalars(select(AgenteVersion).where(AgenteVersion.agente_id == agente_id)
                           .order_by(AgenteVersion.numero.desc())).all()
    return [{"numero": v.numero, "nota": v.nota, "publicado_por": v.publicado_por, "creado": v.creado.isoformat() + "Z",
             "config": v.config} for v in filas]


@r.post("/{agente_id}/versiones/{numero}/restaurar")
async def restaurar(agente_id: int, numero: int, ctx: Contexto = Depends(requiere("editor"))):
    a = _agente(ctx, agente_id)
    v = ctx.db.scalar(select(AgenteVersion).where(AgenteVersion.agente_id == agente_id, AgenteVersion.numero == numero))
    if not v:
        raise HTTPException(404, "Versión no encontrada")
    a.config_borrador = normalizar(v.config)
    ctx.db.commit()
    return await publicar(agente_id, {"nota": f"Rollback a v{numero}"}, ctx)


# ─────────────────────────────── Playground ───────────────────────────────

class MensajePrueba(BaseModel):
    texto: str = Field(min_length=1, max_length=4000)
    conversacion_id: int | None = None
    canal_simulado: str = "whatsapp"  # estilo y herramientas: whatsapp | widget | voz


@r.post("/{agente_id}/playground")
async def playground(agente_id: int, datos: MensajePrueba, ctx: Contexto = Depends(requiere("editor"))):
    a = _agente(ctx, agente_id)
    conv = ctx.db.get(Conversacion, datos.conversacion_id) if datos.conversacion_id else None
    if not conv or conv.espacio_id != ctx.espacio_id or conv.agente_id != a.id:
        conv = Conversacion(espacio_id=ctx.espacio_id, agente_id=a.id, canal="playground",
                            variables={"_estilo": datos.canal_simulado})
        ctx.db.add(conv)
        ctx.db.flush()
        cfg = config_de(a, borrador=True)
        if cfg["quien_habla_primero"] == "agente" and cfg.get("mensaje_inicial"):
            from ..cerebro.motor import rellenar

            ctx.db.add(Mensaje(conversacion_id=conv.id, direccion="saliente", autor="ia", contenido=rellenar(
                cfg["mensaje_inicial"], variables_de(cfg, None, {}))))
    ctx.db.add(Mensaje(conversacion_id=conv.id, direccion="entrante", autor="contacto", contenido=datos.texto))
    conv.ultimo_entrante_en = ahora()
    ctx.db.commit()
    try:
        await responder(ctx.db, conv.id, borrador=True)
    except llm.ErrorLLM as e:
        raise HTTPException(502, str(e))
    mensajes = ctx.db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id).order_by(Mensaje.id)).all()
    ctx.db.refresh(conv)
    return {"conversacion_id": conv.id, "mensajes": [serial.mensaje(m) for m in mensajes],
            "costo_usd": conv.costo_usd, "tokens": conv.tokens_entrada + conv.tokens_salida,
            "escalado": not conv.ia_activa}


# ─────────────────────────────── Voz: llamada web y de prueba ───────────────────────────────

@r.post("/{agente_id}/llamada-web")
async def llamada_web(agente_id: int, datos: dict | None = None, ctx: Contexto = Depends(requiere("editor"))):
    """Prueba de voz en el navegador. Sincroniza el borrador para probar sin publicar."""
    a = _agente(ctx, agente_id)
    api_key = credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key")
    if not api_key:
        raise HTTPException(422, "Configura Retell en Ajustes → Integraciones")
    if not a.retell_agent_id:
        aviso = await _sincronizar_retell(ctx, a)
        if aviso:
            raise HTTPException(502, aviso)
    conv = Conversacion(espacio_id=ctx.espacio_id, agente_id=a.id, canal="voz",
                        variables={"_borrador": True, **((datos or {}).get("variables") or {})})
    ctx.db.add(conv)
    ctx.db.flush()
    llamada = Llamada(espacio_id=ctx.espacio_id, conversacion_id=conv.id, agente_id=a.id, tipo="web",
                      datos={"borrador": True})
    ctx.db.add(llamada)
    ctx.db.flush()
    try:
        resp = await retell.crear_llamada_web(api_key, a.retell_agent_id, variables_de(config_de(a, True), None,
                                                                                         conv.variables),
                                              {"llamada_id": llamada.id, "espacio_id": ctx.espacio_id})
    except retell.ErrorRetell as e:
        ctx.db.rollback()
        raise HTTPException(502, str(e))
    llamada.retell_call_id = resp.get("call_id")
    ctx.db.commit()
    return {"access_token": resp.get("access_token"), "call_id": resp.get("call_id"), "llamada_id": llamada.id}


class LlamadaPrueba(BaseModel):
    telefono: str
    numero_id: int
    nombre: str = ""


@r.post("/{agente_id}/llamada-prueba")
async def llamada_prueba(agente_id: int, datos: LlamadaPrueba, ctx: Contexto = Depends(requiere("editor"))):
    from .contactos import normalizar_telefono

    a = _agente(ctx, agente_id)
    if not a.config_publicada or not a.retell_agent_id:
        raise HTTPException(422, "Publica el agente (con Retell configurado) antes de llamar")
    numero = ctx.db.get(NumeroTelefono, datos.numero_id)
    if not numero or numero.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Número de salida no encontrado")
    tel = normalizar_telefono(datos.telefono)
    if not tel:
        raise HTTPException(422, "Teléfono inválido")
    contacto = ctx.db.scalar(select(Contacto).where(Contacto.espacio_id == ctx.espacio_id, Contacto.telefono == tel))
    if not contacto:
        contacto = Contacto(espacio_id=ctx.espacio_id, telefono=tel, nombre=datos.nombre, etiquetas=["prueba"])
        ctx.db.add(contacto)
        ctx.db.flush()
    conv = Conversacion(espacio_id=ctx.espacio_id, contacto_id=contacto.id, agente_id=a.id, canal="voz")
    ctx.db.add(conv)
    ctx.db.flush()
    llamada = Llamada(espacio_id=ctx.espacio_id, conversacion_id=conv.id, contacto_id=contacto.id, agente_id=a.id,
                      desde=numero.numero, hacia=tel)
    ctx.db.add(llamada)
    ctx.db.flush()
    try:
        resp = await retell.crear_llamada(credenciales(ctx.db, ctx.espacio_id, "retell").get("api_key", ""),
                                          a.retell_agent_id, numero.numero, tel,
                                          variables_de(config_de(a), contacto, {}),
                                          {"llamada_id": llamada.id, "espacio_id": ctx.espacio_id})
    except retell.ErrorRetell as e:
        ctx.db.rollback()
        raise HTTPException(502, str(e))
    llamada.retell_call_id = resp.get("call_id")
    ctx.db.commit()
    return serial.llamada(llamada)


# ─────────────────────────────── Copiloto ───────────────────────────────

class PedidoGenerar(BaseModel):
    descripcion: str = Field(min_length=10, max_length=4000)
    canal: str = "omnicanal"


@r.post("/generar")
async def generar(datos: PedidoGenerar, ctx: Contexto = Depends(requiere("editor"))):
    """Redacta la configuración inicial de un agente a partir de una descripción en lenguaje natural."""
    esquema = {"type": "object", "properties": {
        "nombre": {"type": "string"}, "proposito": {"type": "string"},
        "instrucciones": {"type": "string", "description": "Prompt completo: rol, objetivo, guion por etapas, "
                                                           "manejo de objeciones, límites y estilo"},
        "mensaje_inicial": {"type": "string", "description": "Saludo con {{nombre}} si aplica"},
        "campos_analisis": {"type": "array", "items": {"type": "object", "properties": {
            "nombre": {"type": "string"}, "tipo": {"type": "string", "enum": ["texto", "numero", "booleano", "enum"]},
            "descripcion": {"type": "string"}, "opciones": {"type": "array", "items": {"type": "string"}}},
            "required": ["nombre", "tipo", "descripcion"]}},
        "usa_agenda": {"type": "boolean"}}, "required": ["nombre", "proposito", "instrucciones", "mensaje_inicial"]}
    prov = llm.proveedor(ctx.db, ctx.espacio_id)
    try:
        d, _ = await prov.json(
            "Eres experto en diseñar agentes conversacionales de ventas y servicio para Latinoamérica. Escribe "
            "prompts claros, en segunda persona, con pasos concretos y límites explícitos.",
            f"Canal: {datos.canal}.\nContexto de la empresa: {ctx.espacio.contexto_empresa or '(no hay)'}\n\n"
            f"Lo que debe hacer el agente:\n{datos.descripcion}", esquema)
    except llm.ErrorLLM as e:
        raise HTTPException(502, str(e))
    cfg = normalizar({})
    cfg.update({"proposito": d.get("proposito", ""), "instrucciones": d.get("instrucciones", cfg["instrucciones"]),
                "mensaje_inicial": d.get("mensaje_inicial", "")})
    cfg["analisis"]["campos"] = [{**c, "requerido": False, "alcance": "persistente"}
                                 for c in d.get("campos_analisis", [])][:10]
    if d.get("usa_agenda"):
        cfg["herramientas"].append({"tipo": "agendar_cita", "config": {"proveedor": "interno", "duracion_min": 30}})
    return {"nombre": d.get("nombre", "Nuevo agente"), "config": normalizar(cfg)}
