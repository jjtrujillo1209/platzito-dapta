"""Planificador interno: corre las tareas periódicas con un candado en base de datos para que
varias instancias no las dupliquen. También se puede disparar desde un cron externo con
POST /interno/tick (encabezado X-Secreto-Tick)."""
import asyncio
import logging
import os
import socket
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from . import ciclo, eventos, secuencias
from .canales import whatsapp
from .config import ajustes
from .db import FabricaSesion, ahora
from .modelos import Bloqueo, Fuente, LineaWhatsapp

log = logging.getLogger("platzito.planificador")
DUENIO = f"{socket.gethostname()}:{os.getpid()}"


def tomar_candado(nombre: str, segundos: int) -> bool:
    db = FabricaSesion()
    try:
        b = db.get(Bloqueo, nombre, with_for_update=True)
        if b and b.hasta > ahora() and b.duenio != DUENIO:
            return False
        if not b:
            b = Bloqueo(nombre=nombre, hasta=ahora(), duenio=DUENIO)
            db.add(b)
        b.hasta, b.duenio = ahora() + timedelta(seconds=segundos), DUENIO
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False
    finally:
        db.close()


def soltar_candado(nombre: str):
    db = FabricaSesion()
    try:
        b = db.get(Bloqueo, nombre)
        if b and b.duenio == DUENIO:
            b.hasta = ahora()
            db.commit()
    finally:
        db.close()


async def revisar_lineas(db):
    """Cada 6 h (o tras un aviso de Meta) se consulta calidad y tier de cada línea."""
    limite = ahora() - timedelta(hours=6)
    for linea in db.scalars(select(LineaWhatsapp).where(LineaWhatsapp.estado == "conectada")):
        if linea.calidad_revisada_en and linea.calidad_revisada_en > limite:
            continue
        try:
            info = await whatsapp.estado_linea(linea)
        except whatsapp.ErrorWhatsapp as e:
            log.warning("No se pudo revisar la línea %s: %s", linea.id, e)
            linea.calidad_revisada_en = ahora()
            continue
        anterior = linea.calidad
        linea.calidad = info.get("quality_rating", linea.calidad)
        linea.tier = info.get("messaging_limit_tier") or linea.tier
        linea.calidad_revisada_en = ahora()
        if linea.calidad == "RED" and anterior != "RED":
            linea.marketing_pausado = True  # pausa automática de marketing
            eventos.emitir(db, linea.espacio_id, "linea.calidad", {"linea_id": linea.id, "calidad": "RED",
                                                                   "marketing_pausado": True})
    db.commit()


async def fuentes_atascadas(db):
    """Reprocesa fuentes que quedaron en 'procesando' por un reinicio."""
    from . import conocimiento

    for f in db.scalars(select(Fuente).where(Fuente.estado.in_(("pendiente", "procesando")),
                                             Fuente.actualizado < ahora() - timedelta(minutes=15))).all():
        await conocimiento.procesar_fuente(db, f.id)


TAREAS = [
    ("secuencias", secuencias.tick),
    ("seguimientos", ciclo.enviar_seguimientos),
    ("cierre", ciclo.cerrar_inactivas),
    ("webhooks", eventos.entregar_pendientes),
    ("lineas", revisar_lineas),
    ("fuentes", fuentes_atascadas),
]


async def tick() -> dict:
    resumen = {}
    for nombre, tarea in TAREAS:
        if not tomar_candado(nombre, 300):
            resumen[nombre] = "ocupado"
            continue
        db = FabricaSesion()
        try:
            r = await tarea(db)
            resumen[nombre] = r if isinstance(r, dict) else "ok"
        except Exception as e:  # una tarea rota no detiene las demás
            db.rollback()
            log.exception("Tarea %s falló", nombre)
            resumen[nombre] = f"error: {e}"
        finally:
            db.close()
            soltar_candado(nombre)
    return resumen


async def bucle():
    await asyncio.sleep(3)
    while True:
        try:
            await tick()
        except Exception:
            log.exception("Fallo en el planificador")
        await asyncio.sleep(ajustes().planificador_intervalo_s)
