"""Inbox omnicanal: conversaciones, toma humana (asignar apaga la IA), notas y calificaciones."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from .. import serial
from ..canales import whatsapp
from ..ciclo import analizar, cerrar
from ..db import ahora
from ..modelos import Contacto, Conversacion, LineaWhatsapp, Mensaje, Miembro, Plantilla
from ..seguridad import Contexto, requiere

r = APIRouter(prefix="/api/conversaciones", tags=["conversaciones"])


def _conv(ctx: Contexto, conv_id: int) -> Conversacion:
    c = ctx.db.get(Conversacion, conv_id)
    if not c or c.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Conversación no encontrada")
    return c


@r.get("")
def listar(estado: str = "", canal: str = "", asignado: str = "", agente_id: int | None = None, q: str = "",
           pagina: int = 1, por_pagina: int = 40, ctx: Contexto = Depends(requiere("lector"))):
    consulta = select(Conversacion).where(Conversacion.espacio_id == ctx.espacio_id,
                                          Conversacion.canal.not_in(("playground", "simulador")))
    if estado:
        consulta = consulta.where(Conversacion.estado.in_(estado.split(",")))
    if canal:
        consulta = consulta.where(Conversacion.canal.in_(canal.split(",")))
    if agente_id:
        consulta = consulta.where(Conversacion.agente_id == agente_id)
    if asignado == "yo" and ctx.usuario:
        consulta = consulta.where(Conversacion.asignado_a == ctx.usuario.id)
    elif asignado == "nadie":
        consulta = consulta.where(Conversacion.asignado_a.is_(None))
    elif asignado == "humano":
        consulta = consulta.where(Conversacion.ia_activa.is_(False))
    if q:
        like = f"%{q}%"
        consulta = consulta.join(Contacto, Contacto.id == Conversacion.contacto_id).where(
            or_(Contacto.nombre.ilike(like), Contacto.telefono.ilike(like), Contacto.email.ilike(like)))
    total = ctx.db.scalar(select(func.count()).select_from(consulta.subquery()))
    filas = ctx.db.scalars(consulta.order_by(Conversacion.ultimo_mensaje_en.desc())
                           .offset((pagina - 1) * por_pagina).limit(min(por_pagina, 200))).all()
    ultimos = {}
    if filas:
        ids_ult = ctx.db.execute(select(Mensaje.conversacion_id, func.max(Mensaje.id)).where(
            Mensaje.conversacion_id.in_([c.id for c in filas]), Mensaje.tipo != "nota")
            .group_by(Mensaje.conversacion_id)).all()
        msjs = {m.id: m for m in ctx.db.scalars(select(Mensaje).where(Mensaje.id.in_([i for _, i in ids_ult])))}
        ultimos = {cid: msjs.get(mid) for cid, mid in ids_ult}
    conteo = dict(ctx.db.execute(select(Conversacion.estado, func.count(Conversacion.id)).where(
        Conversacion.espacio_id == ctx.espacio_id, Conversacion.canal.not_in(("playground", "simulador")))
        .group_by(Conversacion.estado)).all())
    return {"total": total, "conteo": conteo,
            "conversaciones": [serial.conversacion(c, ultimos.get(c.id)) for c in filas]}


@r.get("/{conv_id}")
def ver(conv_id: int, ctx: Contexto = Depends(requiere("lector"))):
    c = _conv(ctx, conv_id)
    mensajes = ctx.db.scalars(select(Mensaje).where(Mensaje.conversacion_id == c.id).order_by(Mensaje.id)).all()
    if c.no_leidos:
        c.no_leidos = 0
        ctx.db.commit()
    ventana = None
    if c.canal == "whatsapp" and c.ultimo_entrante_en:
        fin = c.ultimo_entrante_en + timedelta(hours=24)
        ventana = {"abierta": fin > ahora(), "cierra_en": fin.isoformat() + "Z"}
    return {**serial.conversacion(c), "mensajes": [serial.mensaje(m) for m in mensajes], "ventana_24h": ventana}


class NuevoMensaje(BaseModel):
    texto: str = Field(min_length=1, max_length=4096)


@r.post("/{conv_id}/mensajes")
async def enviar(conv_id: int, datos: NuevoMensaje, ctx: Contexto = Depends(requiere("operador"))):
    """Un humano responde: toma la conversación y apaga la IA."""
    c = _conv(ctx, conv_id)
    if c.canal == "voz":
        raise HTTPException(422, "No se puede escribir en una llamada")
    m = Mensaje(conversacion_id=c.id, direccion="saliente", autor="humano", contenido=datos.texto,
                autor_usuario_id=ctx.usuario.id if ctx.usuario else None)
    if c.canal == "whatsapp":
        if not c.ultimo_entrante_en or ahora() - c.ultimo_entrante_en > timedelta(hours=24):
            raise HTTPException(422, "Ventana de 24 h cerrada: envía una plantilla aprobada")
        linea = ctx.db.get(LineaWhatsapp, c.linea_id)
        contacto = ctx.db.get(Contacto, c.contacto_id)
        try:
            m.wamid = await whatsapp.enviar_texto(linea, contacto.telefono, datos.texto)
            m.estado_entrega = "enviado"
        except whatsapp.ErrorWhatsapp as e:
            raise HTTPException(502, str(e))
    else:
        m.estado_entrega = "entregado"
    ctx.db.add(m)
    c.ia_activa = False
    if ctx.usuario and not c.asignado_a:
        c.asignado_a = ctx.usuario.id
    c.estado = "abierta"
    c.ultimo_mensaje_en = ahora()
    ctx.db.commit()
    return serial.mensaje(m)


class EnvioPlantilla(BaseModel):
    plantilla_id: int
    variables: list[str] = []


@r.post("/{conv_id}/plantilla")
async def enviar_plantilla(conv_id: int, datos: EnvioPlantilla, ctx: Contexto = Depends(requiere("operador"))):
    from ..cerebro.motor import registrar_saliente_whatsapp

    c = _conv(ctx, conv_id)
    p = ctx.db.get(Plantilla, datos.plantilla_id)
    if c.canal != "whatsapp" or not p or p.espacio_id != ctx.espacio_id or p.estado != "APPROVED":
        raise HTTPException(422, "Plantilla no disponible")
    linea = ctx.db.get(LineaWhatsapp, p.linea_id)
    contacto = ctx.db.get(Contacto, c.contacto_id)
    if contacto.opt_out_whatsapp:
        raise HTTPException(422, "El contacto pidió no recibir WhatsApp")
    try:
        wamid = await whatsapp.enviar_plantilla(linea, contacto.telefono, p.nombre, p.idioma, datos.variables)
    except whatsapp.ErrorWhatsapp as e:
        raise HTTPException(502, str(e))
    m = registrar_saliente_whatsapp(ctx.db, ctx.espacio_id, linea, contacto, p, datos.variables, wamid, None)
    m.autor, m.autor_usuario_id = "humano", ctx.usuario.id if ctx.usuario else None
    ctx.db.commit()
    return serial.mensaje(m)


@r.post("/{conv_id}/asignar")
def asignar(conv_id: int, datos: dict, ctx: Contexto = Depends(requiere("operador"))):
    """Asignar a una persona apaga la IA; quitar la asignación la vuelve a encender."""
    c = _conv(ctx, conv_id)
    usuario_id = datos.get("usuario_id")
    if usuario_id == "yo":
        if not ctx.usuario:
            raise HTTPException(422, "Con clave de API indica el usuario_id del compañero")
        usuario_id = ctx.usuario.id
    miembro = None
    if usuario_id is not None:
        miembro = ctx.db.scalar(select(Miembro).where(Miembro.espacio_id == ctx.espacio_id,
                                                      Miembro.usuario_id == int(usuario_id)))
        if not miembro:
            raise HTTPException(422, "Ese usuario no es miembro del espacio")
    c.asignado_a = miembro.usuario_id if miembro else None
    c.ia_activa = miembro is None
    if miembro is None and c.estado == "esperando_humano":
        c.estado = "abierta"
    ctx.db.add(Mensaje(conversacion_id=c.id, direccion="interno", autor="sistema", tipo="nota",
                       contenido=f"Asignada a {miembro.usuario.nombre}: IA en pausa" if miembro
                       else "Devuelta a la IA"))
    ctx.db.commit()
    ctx.db.refresh(c)
    return serial.conversacion(c)


@r.post("/{conv_id}/ia")
def ia(conv_id: int, datos: dict, ctx: Contexto = Depends(requiere("operador"))):
    c = _conv(ctx, conv_id)
    c.ia_activa = bool(datos.get("activa"))
    if c.ia_activa:
        c.asignado_a = None
        if c.estado == "esperando_humano":
            c.estado = "abierta"
    ctx.db.commit()
    return serial.conversacion(c)


@r.post("/{conv_id}/notas")
def nota(conv_id: int, datos: NuevoMensaje, ctx: Contexto = Depends(requiere("operador"))):
    c = _conv(ctx, conv_id)
    m = Mensaje(conversacion_id=c.id, direccion="interno", autor="humano", tipo="nota", contenido=datos.texto,
                autor_usuario_id=ctx.usuario.id if ctx.usuario else None)
    ctx.db.add(m)
    ctx.db.commit()
    return serial.mensaje(m)


@r.post("/{conv_id}/cerrar")
async def cerrar_conv(conv_id: int, ctx: Contexto = Depends(requiere("operador"))):
    c = _conv(ctx, conv_id)
    await cerrar(ctx.db, c, "manual")
    return serial.conversacion(c)


@r.post("/{conv_id}/reabrir")
def reabrir(conv_id: int, ctx: Contexto = Depends(requiere("operador"))):
    c = _conv(ctx, conv_id)
    c.estado, c.cerrado_en = "abierta", None
    ctx.db.commit()
    return serial.conversacion(c)


@r.post("/{conv_id}/analizar")
async def reanalizar(conv_id: int, ctx: Contexto = Depends(requiere("editor"))):
    c = _conv(ctx, conv_id)
    datos = await analizar(ctx.db, c.id)
    if datos is None:
        raise HTTPException(422, "No hay nada que analizar (sin respuesta del contacto o análisis apagado)")
    return serial.conversacion(c)


@r.post("/{conv_id}/calificar")
def calificar(conv_id: int, datos: dict, ctx: Contexto = Depends(requiere("operador"))):
    c = _conv(ctx, conv_id)
    c.calificacion = 1 if datos.get("valor", 0) > 0 else -1 if datos.get("valor", 0) < 0 else None
    ctx.db.commit()
    return {"ok": True}


@r.post("/mensajes/{mensaje_id}/calificar")
def calificar_mensaje(mensaje_id: int, datos: dict, ctx: Contexto = Depends(requiere("operador"))):
    m = ctx.db.get(Mensaje, mensaje_id)
    if not m or _conv(ctx, m.conversacion_id) is None:
        raise HTTPException(404, "No encontrado")
    m.calificacion = 1 if datos.get("valor", 0) > 0 else -1 if datos.get("valor", 0) < 0 else None
    ctx.db.commit()
    return {"ok": True}
