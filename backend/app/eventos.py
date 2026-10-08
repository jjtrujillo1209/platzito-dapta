"""Bus de eventos del espacio y entrega de webhooks salientes firmados (HMAC) con reintentos.

Tipos emitidos: conversacion.cerrada · conversacion.analizada · conversacion.escalada ·
mensaje.recibido · llamada.terminada · llamada.analizada · cita.agendada ·
contacto.actualizado · secuencia.inscripcion_terminada · contacto.baja
"""
import json
from datetime import timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import ahora
from .modelos import EntregaWebhook, Evento, SuscripcionWebhook
from .red import UrlNoPermitida, validar_url_externa
from .seguridad import firmar_webhook

ESPERAS_MIN = [1, 5, 30, 120, 720]  # backoff entre reintentos


def emitir(db: Session, espacio_id: int, tipo: str, datos: dict) -> Evento:
    ev = Evento(espacio_id=espacio_id, tipo=tipo, datos=datos)
    db.add(ev)
    db.flush()
    subs = db.scalars(select(SuscripcionWebhook).where(SuscripcionWebhook.espacio_id == espacio_id,
                                                       SuscripcionWebhook.activa.is_(True))).all()
    for s in subs:
        if "*" in s.eventos or tipo in s.eventos or f"{tipo.split('.')[0]}.*" in s.eventos:
            db.add(EntregaWebhook(suscripcion_id=s.id, evento_id=ev.id))
    db.commit()
    return ev


async def entregar(db: Session, entrega: EntregaWebhook) -> bool:
    sub = db.get(SuscripcionWebhook, entrega.suscripcion_id)
    ev = db.get(Evento, entrega.evento_id)
    cuerpo = json.dumps({"id": ev.id, "tipo": ev.tipo, "creado": ev.creado.isoformat() + "Z", "datos": ev.datos},
                        ensure_ascii=False, default=str).encode()
    entrega.intentos += 1
    try:
        validar_url_externa(sub.url)
        async with httpx.AsyncClient(timeout=15) as cliente:
            r = await cliente.post(sub.url, content=cuerpo, headers={
                "content-type": "application/json", "x-platzito-evento": ev.tipo,
                "x-platzito-firma": firmar_webhook(sub.secreto, cuerpo)})
        entrega.respuesta = f"{r.status_code} {r.text[:200]}"
        ok = r.status_code < 300
    except (httpx.HTTPError, UrlNoPermitida) as e:
        entrega.respuesta, ok = str(e)[:300], False
    if ok:
        entrega.estado = "ok"
    elif entrega.intentos > len(ESPERAS_MIN):
        entrega.estado = "fallida"
    else:
        entrega.proximo_intento = ahora() + timedelta(minutes=ESPERAS_MIN[entrega.intentos - 1])
    db.commit()
    return ok


async def entregar_pendientes(db: Session, limite: int = 50):
    pendientes = db.scalars(select(EntregaWebhook).where(EntregaWebhook.estado == "pendiente",
                                                         EntregaWebhook.proximo_intento <= ahora())
                            .order_by(EntregaWebhook.id).limit(limite)).all()
    for e in pendientes:
        await entregar(db, e)
