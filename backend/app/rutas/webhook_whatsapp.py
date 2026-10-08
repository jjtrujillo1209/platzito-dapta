"""Webhook de WhatsApp Cloud API: verificación, firma X-Hub-Signature-256, dedupe por wamid,
mensajes entrantes, estados de entrega, ecos de coexistencia, calidad y estado de plantillas."""
import json
import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from ..canales import whatsapp
from ..cerebro.motor import config_de, conversacion_abierta, es_baja, responder_con_demora
from ..config import ajustes
from ..db import FabricaSesion, ahora
from ..eventos import emitir
from ..fondo import lanzar
from ..modelos import Agente, Contacto, Conversacion, Integracion, LineaWhatsapp, Mensaje, Plantilla
from ..secuencias import al_dar_baja, al_responder
from ..seguridad import descifrar_dict, verificar_firma_meta
from .contactos import zona_de_telefono

log = logging.getLogger("platzito.whatsapp")
r = APIRouter(tags=["webhooks"])
ESTADOS = {"sent": "enviado", "delivered": "entregado", "read": "leido", "failed": "fallido"}
CONFIRMACION_BAJA = "Listo, no te volveremos a escribir por este medio. Si cambias de opinión, escríbenos."


@r.get("/webhooks/whatsapp", response_class=PlainTextResponse)
def verificar(modo: str = Query("", alias="hub.mode"), token: str = Query("", alias="hub.verify_token"),
              reto: str = Query("", alias="hub.challenge")):
    if modo == "subscribe" and token == ajustes().meta_verify_token:
        return reto
    raise HTTPException(403, "Token de verificación inválido")


def _espacios_candidatos(db, cuerpo: dict) -> set[int]:
    """Espacios dueños de las líneas (por phone_number_id o WABA) que menciona el cuerpo."""
    pnids, wabas = set(), set()
    for entry in cuerpo.get("entry", []):
        if entry.get("id"):
            wabas.add(str(entry["id"]))
        for cambio in entry.get("changes", []):
            pnid = cambio.get("value", {}).get("metadata", {}).get("phone_number_id")
            if pnid:
                pnids.add(str(pnid))
    if not pnids and not wabas:
        return set()
    lineas = db.scalars(select(LineaWhatsapp).where(or_(LineaWhatsapp.phone_number_id.in_(pnids),
                                                        LineaWhatsapp.waba_id.in_(wabas))))
    return {l.espacio_id for l in lineas}


def _app_secret_propio(db, espacio_id: int) -> str:
    """App secret configurado por el espacio (sin el respaldo global del .env)."""
    fila = db.scalar(select(Integracion).where(Integracion.espacio_id == espacio_id, Integracion.tipo == "meta",
                                               Integracion.activa.is_(True)))
    return descifrar_dict(fila.config_cifrada).get("app_secret", "") if fila else ""


def espacios_autorizados(db, cuerpo: dict, crudo: bytes, firma: str | None) -> set[int] | None:
    """None = firmado con el secreto de la instancia (se procesa todo). Si no, el conjunto de espacios cuyo
    app secret validó la firma: solo se tocan sus líneas y plantillas. Lanza 401 si nadie la validó."""
    global_ = ajustes().meta_app_secret
    if global_ and verificar_firma_meta(global_, crudo, firma):
        return None
    validos, hay_secretos = set(), bool(global_)
    for eid in _espacios_candidatos(db, cuerpo):
        secreto = _app_secret_propio(db, eid)
        hay_secretos = hay_secretos or bool(secreto)
        if secreto and verificar_firma_meta(secreto, crudo, firma):
            validos.add(eid)
    if validos:
        return validos
    if not hay_secretos and not ajustes().es_produccion:
        return None  # desarrollo sin ningún secreto configurado
    raise HTTPException(401, "Firma inválida")


@r.post("/webhooks/whatsapp")
async def recibir(request: Request, fondo: BackgroundTasks):
    crudo = await request.body()
    try:
        cuerpo = json.loads(crudo)
    except json.JSONDecodeError:
        raise HTTPException(400, "JSON inválido")
    db = FabricaSesion()
    try:
        espacios = espacios_autorizados(db, cuerpo, crudo, request.headers.get("x-hub-signature-256"))
    finally:
        db.close()
    fondo.add_task(procesar, cuerpo, espacios)
    return {"ok": True}


async def procesar(cuerpo: dict, espacios: set[int] | None = None):
    """Se corre fuera de la petición: Meta exige responder 200 rápido. `espacios` acota qué se puede tocar
    (None = todo, porque la firma es de la app de la instancia)."""
    db = FabricaSesion()
    try:
        for entry in cuerpo.get("entry", []):
            for cambio in entry.get("changes", []):
                campo, valor = cambio.get("field"), cambio.get("value", {})
                try:
                    if campo == "messages":
                        await _mensajes(db, valor, espacios)
                    elif campo == "smb_message_echoes":
                        _ecos(db, valor, espacios)
                    elif campo == "message_template_status_update":
                        _estado_plantilla(db, valor, espacios)
                    elif campo == "phone_number_quality_update":
                        _calidad(db, valor, espacios)
                except Exception:
                    db.rollback()
                    log.exception("Error procesando webhook de WhatsApp (%s)", campo)
    finally:
        db.close()


def _linea(db, valor: dict, espacios: set[int] | None) -> LineaWhatsapp | None:
    pnid = valor.get("metadata", {}).get("phone_number_id")
    if not pnid:
        return None
    consulta = select(LineaWhatsapp).where(LineaWhatsapp.phone_number_id == pnid, LineaWhatsapp.estado == "conectada")
    if espacios is not None:
        consulta = consulta.where(LineaWhatsapp.espacio_id.in_(espacios))
    return db.scalar(consulta)


def _contacto(db, espacio_id: int, wa_id: str, nombre: str = "") -> Contacto:
    tel = "+" + whatsapp.solo_digitos(wa_id)
    c = db.scalar(select(Contacto).where(Contacto.espacio_id == espacio_id, Contacto.telefono == tel))
    if not c:
        c = Contacto(espacio_id=espacio_id, telefono=tel, nombre=nombre, zona_horaria=zona_de_telefono(tel))
        db.add(c)
        db.flush()
    elif nombre and not c.nombre:
        c.nombre = nombre
    return c


def _contenido(m: dict) -> tuple[str, str, dict]:
    t = m.get("type")
    if t == "text":
        return "texto", m["text"]["body"], {}
    if t == "button":
        return "texto", m["button"].get("text", ""), {"boton": m["button"].get("payload")}
    if t == "interactive":
        i = m["interactive"]
        r_ = i.get("button_reply") or i.get("list_reply") or {}
        return "texto", r_.get("title", ""), {"interactivo": r_}
    if t in ("image", "video", "document", "audio", "sticker"):
        media = m.get(t, {})
        etiqueta = {"image": "imagen", "video": "video", "document": "documento", "audio": "nota de voz",
                    "sticker": "sticker"}[t]
        texto = media.get("caption") or f"[El contacto envió un {etiqueta}]"
        return "media", texto, {"media": {"tipo": t, "id": media.get("id"), "mime": media.get("mime_type"),
                                          "nombre": media.get("filename")}}
    if t == "location":
        loc = m["location"]
        return "texto", f"[Ubicación] {loc.get('name', '')} {loc.get('address', '')} " \
                        f"({loc.get('latitude')}, {loc.get('longitude')})", {"ubicacion": loc}
    if t == "contacts":
        return "texto", "[El contacto compartió una tarjeta de contacto]", {"contactos": m.get("contacts")}
    return "texto", f"[Mensaje de tipo {t} no soportado]", {}


async def _mensajes(db, valor: dict, espacios: set[int] | None = None):
    linea = _linea(db, valor, espacios)
    if not linea:
        return
    nombres = {c.get("wa_id"): c.get("profile", {}).get("name", "") for c in valor.get("contacts", [])}
    for st in valor.get("statuses", []):
        msj = db.scalar(select(Mensaje).join(Conversacion, Conversacion.id == Mensaje.conversacion_id).where(
            Mensaje.wamid == st.get("id"), Conversacion.espacio_id == linea.espacio_id))
        if msj:
            nuevo = ESTADOS.get(st.get("status"), msj.estado_entrega)
            orden = ["", "enviado", "entregado", "leido"]
            if nuevo == "fallido" or orden.index(nuevo if nuevo in orden else "") >= orden.index(
                    msj.estado_entrega if msj.estado_entrega in orden else ""):
                msj.estado_entrega = nuevo
            if st.get("errors"):
                e = st["errors"][0]
                msj.error = f"{e.get('code')}: {e.get('title')} {e.get('error_data', {}).get('details', '')}"[:500]
    db.commit()
    for m in valor.get("messages", []):
        if m.get("type") == "reaction":
            continue
        if db.scalar(select(Mensaje.id).where(Mensaje.wamid == m["id"])):
            continue  # dedupe: Meta reintenta webhooks
        contacto = _contacto(db, linea.espacio_id, m["from"], nombres.get(m["from"], ""))
        agente = db.get(Agente, linea.agente_id) if linea.agente_id else None
        conv = conversacion_abierta(db, linea.espacio_id, contacto.id, "whatsapp", linea.id,
                                    agente.id if agente and agente.config_publicada else None)
        tipo, texto, datos = _contenido(m)
        db.add(Mensaje(conversacion_id=conv.id, direccion="entrante", autor="contacto", tipo=tipo, contenido=texto,
                       datos=datos, wamid=m["id"]))
        conv.ultimo_entrante_en = conv.ultimo_mensaje_en = ahora()
        conv.no_leidos += 1
        if conv.estado == "cerrada":
            conv.estado = "abierta"
        contacto.ultimo_contacto_en = ahora()
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        emitir(db, linea.espacio_id, "mensaje.recibido", {"conversacion_id": conv.id, "contacto_id": contacto.id,
                                                          "canal": "whatsapp", "texto": texto})
        al_responder(db, contacto.id)
        cfg = config_de(agente) if agente and agente.config_publicada else None
        if cfg and es_baja(texto, cfg["conversacion"]["palabras_baja"]):
            contacto.opt_out_whatsapp = True
            db.commit()
            al_dar_baja(db, contacto.id)
            emitir(db, linea.espacio_id, "contacto.baja", {"contacto_id": contacto.id, "canales": ["whatsapp"]})
            try:
                wamid = await whatsapp.enviar_texto(linea, contacto.telefono, CONFIRMACION_BAJA)
                db.add(Mensaje(conversacion_id=conv.id, direccion="saliente", autor="sistema",
                               contenido=CONFIRMACION_BAJA, wamid=wamid, estado_entrega="enviado"))
            except whatsapp.ErrorWhatsapp:
                pass
            conv.ia_activa = False
            db.commit()
            continue
        if cfg and conv.ia_activa and conv.agente_id:
            await whatsapp.marcar_leido_y_escribiendo(linea, m["id"])
            demora = max(cfg["conversacion"]["demora_respuesta_s"], 2.0)  # agrupa ráfagas de mensajes
            lanzar(responder_con_demora(conv.id, demora))


def _ecos(db, valor: dict, espacios: set[int] | None = None):
    """Coexistencia: lo que el equipo responde desde la app WhatsApp Business entra al Inbox."""
    linea = _linea(db, valor, espacios)
    if not linea:
        return
    for eco in valor.get("message_echoes", []):
        if db.scalar(select(Mensaje.id).where(Mensaje.wamid == eco.get("id"))):
            continue
        contacto = _contacto(db, linea.espacio_id, eco.get("to", ""))
        conv = conversacion_abierta(db, linea.espacio_id, contacto.id, "whatsapp", linea.id, linea.agente_id)
        tipo, texto, datos = _contenido(eco)
        db.add(Mensaje(conversacion_id=conv.id, direccion="saliente", autor="humano", tipo=tipo, contenido=texto,
                       datos={**datos, "desde_app": True}, wamid=eco.get("id"), estado_entrega="enviado"))
        conv.ia_activa = False  # una persona tomó la conversación desde el celular
        conv.ultimo_mensaje_en = ahora()
        db.commit()


def _estado_plantilla(db, valor: dict, espacios: set[int] | None = None):
    consulta = select(Plantilla).where(Plantilla.meta_id == str(valor.get("message_template_id")))
    if espacios is not None:
        consulta = consulta.where(Plantilla.espacio_id.in_(espacios))
    for p in db.scalars(consulta):
        p.estado = valor.get("event", p.estado)
        p.motivo_rechazo = (valor.get("reason") or "")[:300] if valor.get("reason") not in (None, "NONE") else ""
    db.commit()


def _calidad(db, valor: dict, espacios: set[int] | None = None):
    numero = whatsapp.solo_digitos(valor.get("display_phone_number", ""))
    for linea in db.scalars(select(LineaWhatsapp).where(LineaWhatsapp.estado == "conectada")):
        if espacios is not None and linea.espacio_id not in espacios:
            continue
        if whatsapp.solo_digitos(linea.numero_visible) != numero:
            continue
        if valor.get("current_limit"):
            linea.tier = valor["current_limit"]
        evento = valor.get("event", "")
        if evento in ("FLAGGED", "DOWNGRADE"):
            linea.calidad = "RED" if evento == "DOWNGRADE" else "YELLOW"
            linea.marketing_pausado = True
        elif evento in ("UNFLAGGED", "UPGRADE"):
            linea.calidad = "GREEN"
        linea.calidad_revisada_en = None  # fuerza resincronizar en el siguiente ciclo
        emitir(db, linea.espacio_id, "linea.calidad", {"linea_id": linea.id, "evento": evento, "tier": linea.tier})
    db.commit()
