"""Ciclo de vida de las conversaciones: análisis estructurado al cerrar, cierre por
inactividad y seguimientos automáticos dentro de la ventana de 24 h."""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import llm
from .cerebro.motor import (_entregar, config_de, contexto_para, historial, sistema)
from .db import ahora
from .eventos import emitir
from .modelos import Agente, Contacto, Conversacion, Llamada, Mensaje

TIPO_JSON = {"texto": "string", "numero": "number", "booleano": "boolean", "enum": "string"}


def transcript(db: Session, conv: Conversacion) -> str:
    filas = db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id).order_by(Mensaje.id)).all()
    lineas = []
    for m in filas:
        if m.tipo == "nota" or not m.contenido:
            continue
        quien = {"contacto": "Contacto", "ia": "Agente", "humano": "Asesor", "sistema": "Sistema"}[m.autor]
        lineas.append(f"{quien}: {m.contenido}")
    return "\n".join(lineas)


def esquema_analisis(cfg: dict) -> dict:
    props = {
        "resumen": {"type": "string", "description": cfg["analisis"]["resumen_prompt"]},
        "exito": {"type": "boolean", "description": cfg["analisis"]["exito_prompt"]},
        "sentimiento": {"type": "string", "enum": ["positivo", "neutral", "negativo"],
                        "description": "Sentimiento general del contacto"},
    }
    campos_props, requeridos = {}, []
    for c in cfg["analisis"]["campos"]:
        p = {"type": TIPO_JSON[c["tipo"]], "description": c.get("descripcion", "")}
        if c["tipo"] == "enum" and c.get("opciones"):
            p["enum"] = c["opciones"]
        campos_props[c["nombre"]] = p
        if c.get("requerido"):
            requeridos.append(c["nombre"])
    if campos_props:
        props["campos"] = {"type": "object", "properties": campos_props, "required": requeridos,
                           "description": "Datos a extraer; omite los que no aparezcan en la conversación"}
    return {"type": "object", "properties": props, "required": ["resumen", "exito", "sentimiento"]}


async def analizar(db: Session, conversacion_id: int) -> dict | None:
    conv = db.get(Conversacion, conversacion_id)
    if not conv or not conv.agente_id:
        return None
    agente = db.get(Agente, conv.agente_id)
    cfg = config_de(agente, borrador=conv.canal in ("playground", "simulador"))
    if not cfg["analisis"]["activo"]:
        return None
    # Los salientes sin respuesta no se analizan (no hay nada que analizar)
    hablo = db.scalar(select(Mensaje.id).where(Mensaje.conversacion_id == conv.id, Mensaje.autor == "contacto")
                      .limit(1))
    if not hablo:
        return None
    texto = transcript(db, conv)
    m = cfg["modelo"]
    prov = llm.proveedor(db, conv.espacio_id, m.get("proveedor") or None, m.get("nombre") or None)
    instrucciones = (f"Eres un analista de conversaciones comerciales. Objetivo del agente: "
                     f"{cfg.get('proposito') or 'ver sus instrucciones'}.\nAnaliza solo lo que está en el "
                     f"transcript; no inventes datos.")
    datos, r = await prov.json(instrucciones, f"Transcript ({conv.canal}):\n\n{texto}", esquema_analisis(cfg),
                               nombre="registrar_analisis")
    if not datos:
        return None
    conv.resumen = str(datos.get("resumen", ""))[:4000]
    conv.exito = bool(datos.get("exito")) if "exito" in datos else None
    conv.sentimiento = str(datos.get("sentimiento", ""))[:16]
    conv.analisis = datos.get("campos") or {}
    conv.tokens_entrada += r.entrada
    conv.tokens_salida += r.salida
    conv.costo_usd = round(conv.costo_usd + llm.costo(prov.modelo, r.entrada, r.salida), 6)
    if conv.contacto_id:
        contacto = db.get(Contacto, conv.contacto_id)
        persistentes = {c["nombre"] for c in cfg["analisis"]["campos"] if c.get("alcance") == "persistente"}
        if persistentes:
            contacto.datos_ia = {**(contacto.datos_ia or {}),
                                 **{k: v for k, v in conv.analisis.items() if k in persistentes}}
        etapa = cfg["analisis"]["etapa_si_exito"] if conv.exito else cfg["analisis"]["etapa_si_fracaso"]
        if etapa:
            contacto.etapa = etapa
    db.commit()
    tipo = "llamada.analizada" if conv.canal == "voz" else "conversacion.analizada"
    llamada = db.scalar(select(Llamada).where(Llamada.conversacion_id == conv.id)) if conv.canal == "voz" else None
    emitir(db, conv.espacio_id, tipo, {
        "conversacion_id": conv.id, "llamada_id": llamada.id if llamada else None, "contacto_id": conv.contacto_id,
        "agente_id": conv.agente_id, "canal": conv.canal, "resumen": conv.resumen, "exito": conv.exito,
        "sentimiento": conv.sentimiento, "campos": conv.analisis})
    return datos


async def cerrar(db: Session, conv: Conversacion, motivo: str = "manual"):
    if conv.estado == "cerrada":
        return
    conv.estado = "cerrada"
    conv.cerrado_en = ahora()
    db.commit()
    emitir(db, conv.espacio_id, "conversacion.cerrada", {"conversacion_id": conv.id, "canal": conv.canal,
                                                         "motivo": motivo, "contacto_id": conv.contacto_id})
    try:
        await analizar(db, conv.id)
    except llm.ErrorLLM as e:
        db.add(Mensaje(conversacion_id=conv.id, direccion="interno", autor="sistema", tipo="nota",
                       contenido=f"No se pudo analizar: {e}"))
        db.commit()


async def cerrar_inactivas(db: Session):
    abiertas = db.scalars(select(Conversacion).where(
        Conversacion.estado == "abierta", Conversacion.canal.in_(("whatsapp", "widget", "correo", "sms")),
        Conversacion.ultimo_mensaje_en < ahora() - timedelta(minutes=10))).all()
    agentes: dict[int, dict] = {}
    for conv in abiertas:
        if conv.agente_id not in agentes:
            ag = db.get(Agente, conv.agente_id) if conv.agente_id else None
            agentes[conv.agente_id] = config_de(ag) if ag else {"conversacion": {"cierre_inactividad_min": 1440}}
        cfg = agentes[conv.agente_id]
        limite = cfg["conversacion"]["cierre_inactividad_min"]
        pendientes = len(cfg["conversacion"].get("seguimientos", [])) - conv.seguimientos_enviados
        if pendientes > 0 and conv.ia_activa:
            continue  # aún faltan seguimientos
        if conv.ultimo_mensaje_en < ahora() - timedelta(minutes=limite):
            await cerrar(db, conv, "inactividad")


async def enviar_seguimientos(db: Session):
    candidatas = db.scalars(select(Conversacion).where(
        Conversacion.estado == "abierta", Conversacion.ia_activa.is_(True),
        Conversacion.canal.in_(("whatsapp", "widget")), Conversacion.ultimo_ia_en.is_not(None))).all()
    for conv in candidatas:
        if conv.ultimo_entrante_en and conv.ultimo_entrante_en > conv.ultimo_ia_en:
            continue  # el contacto respondió: le toca al agente, no un seguimiento
        agente = db.get(Agente, conv.agente_id) if conv.agente_id else None
        if not agente:
            continue
        cfg = config_de(agente)
        segs = cfg["conversacion"].get("seguimientos", [])
        if conv.seguimientos_enviados >= len(segs):
            continue
        seg = segs[conv.seguimientos_enviados]
        if ahora() - conv.ultimo_ia_en < timedelta(minutes=seg["tras_min"]):
            continue
        if conv.canal == "whatsapp" and (not conv.ultimo_entrante_en or
                                         ahora() - conv.ultimo_entrante_en > timedelta(hours=23, minutes=50)):
            conv.seguimientos_enviados = len(segs)  # fuera de la ventana de 24 h ya no se puede texto libre
            db.commit()
            continue
        if seg["tipo"] == "estatico":
            ctx = contexto_para(db, conv, agente)
            from .cerebro.motor import rellenar

            texto = rellenar(seg["contenido"], ctx.variables)
        else:
            ctx = contexto_para(db, conv, agente)
            m = cfg["modelo"]
            prov = llm.proveedor(db, conv.espacio_id, m.get("proveedor") or None, m.get("nombre") or None)
            mensajes = historial(db, conv) + [{"rol": "usuario", "texto": (
                "(Instrucción interna, no es del contacto: el contacto no ha respondido. Escribe UN mensaje breve "
                f"de seguimiento, natural y sin presionar. {seg['contenido']})")}]
            try:
                r = await prov.completar(sistema(ctx), mensajes, None, m["temperatura"], 300)
            except llm.ErrorLLM:
                continue
            texto = r.texto.strip()
            conv.costo_usd = round(conv.costo_usd + llm.costo(prov.modelo, r.entrada, r.salida), 6)
        if not texto:
            continue
        msj = Mensaje(conversacion_id=conv.id, direccion="saliente", autor="ia", tipo="texto", contenido=texto,
                      datos={"seguimiento": conv.seguimientos_enviados + 1})
        db.add(msj)
        db.flush()
        await _entregar(db, conv, msj)
        conv.seguimientos_enviados += 1
        conv.ultimo_ia_en = conv.ultimo_mensaje_en = ahora()
        db.commit()
