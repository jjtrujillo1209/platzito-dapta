"""Widget web embebible (chat + voz en el navegador). Endpoints públicos por clave del agente.

    <script src="https://TU-HOST/widget.js" data-agente="pk_..." async></script>
"""
from datetime import timedelta

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import llm, serial
from ..canales import retell
from ..cerebro.motor import config_de, es_baja, rellenar, responder, variables_de
from ..config import ajustes
from ..db import ahora, obtener_db
from ..eventos import emitir
from ..integraciones import credenciales
from ..modelos import Agente, Contacto, Conversacion, Espacio, Llamada, Mensaje
from ..secuencias import al_responder

r = APIRouter(prefix="/widget", tags=["widget"])
_limites: dict[str, list[float]] = {}


def _limitar(clave: str, max_por_min: int = 20):
    """Límite simple por sesión para que el widget público no se use como proxy del LLM."""
    import time

    ahora_s = time.time()
    ventana = [t for t in _limites.get(clave, []) if ahora_s - t < 60]
    if len(ventana) >= max_por_min:
        raise HTTPException(429, "Demasiados mensajes, espera un momento")
    ventana.append(ahora_s)
    _limites[clave] = ventana


def _agente(db: Session, clave: str) -> Agente:
    a = db.scalar(select(Agente).where(Agente.clave_publica == clave, Agente.archivado.is_(False)))
    if not a or not a.config_publicada:
        raise HTTPException(404, "Agente no disponible")
    return a


def _token(conv: Conversacion) -> str:
    return jwt.encode({"conv": conv.id, "w": True, "exp": ahora() + timedelta(days=30)}, ajustes().clave_secreta,
                      algorithm="HS256")


def _conv(db: Session, agente: Agente, token: str) -> Conversacion:
    try:
        datos = jwt.decode(token, ajustes().clave_secreta, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Sesión del widget inválida")
    conv = db.get(Conversacion, datos.get("conv"))
    if not datos.get("w") or not conv or conv.agente_id != agente.id or conv.canal != "widget":
        raise HTTPException(401, "Sesión del widget inválida")
    return conv


@r.get("/{clave}/config")
def config(clave: str, db: Session = Depends(obtener_db)):
    a = _agente(db, clave)
    cfg = config_de(a)
    w = cfg.get("variables", {})
    return {"nombre": w.get("widget_titulo") or a.nombre, "color": w.get("widget_color") or "#0ae98a",
            "saludo": rellenar(cfg.get("mensaje_inicial") or "", variables_de(cfg, None, {})),
            "voz": bool(a.retell_agent_id and credenciales(db, a.espacio_id, "retell").get("api_key")),
            "pedir_datos": w.get("widget_pedir_datos", "no") == "si",
            "empresa": db.get(Espacio, a.espacio_id).nombre}


class InicioSesion(BaseModel):
    nombre: str = Field("", max_length=200)
    email: str = Field("", max_length=200)
    telefono: str = Field("", max_length=40)
    pagina: str = Field("", max_length=500)


@r.post("/{clave}/sesion")
def sesion(clave: str, datos: InicioSesion, db: Session = Depends(obtener_db)):
    from .contactos import normalizar_telefono

    a = _agente(db, clave)
    # Nunca se reutiliza un contacto existente por teléfono/correo sin verificar: filtraría sus datos al prompt.
    tel = normalizar_telefono(datos.telefono) if datos.telefono else None
    atributos = {}
    if tel and db.scalar(select(Contacto.id).where(Contacto.espacio_id == a.espacio_id, Contacto.telefono == tel)):
        atributos["telefono_declarado"] = datos.telefono
        tel = None
    contacto = Contacto(espacio_id=a.espacio_id, nombre=datos.nombre, email=datos.email.strip().lower() or None,
                        telefono=tel, atributos=atributos, etiquetas=["widget"])
    db.add(contacto)
    db.flush()
    conv = Conversacion(espacio_id=a.espacio_id, contacto_id=contacto.id, agente_id=a.id, canal="widget",
                        variables={"pagina": datos.pagina} if datos.pagina else {})
    db.add(conv)
    db.flush()
    cfg = config_de(a)
    if cfg["quien_habla_primero"] == "agente" and cfg.get("mensaje_inicial"):
        db.add(Mensaje(conversacion_id=conv.id, direccion="saliente", autor="ia", estado_entrega="entregado",
                       contenido=rellenar(cfg["mensaje_inicial"], variables_de(cfg, contacto, conv.variables))))
    db.commit()
    mensajes = db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id)).all()
    return {"token": _token(conv), "mensajes": [_publico(m) for m in mensajes]}


def _publico(m: Mensaje) -> dict:
    return {"id": m.id, "autor": m.autor, "contenido": m.contenido, "creado": serial._f(m.creado),
            "fuentes": m.datos.get("fuentes", []) if m.datos else []}


class MensajeWidget(BaseModel):
    texto: str = Field(min_length=1, max_length=2000)


@r.post("/{clave}/mensajes")
async def mensaje(clave: str, datos: MensajeWidget, x_widget_token: str = Header(...),
                  db: Session = Depends(obtener_db)):
    a = _agente(db, clave)
    conv = _conv(db, a, x_widget_token)
    _limitar(f"{conv.id}")
    if conv.estado == "cerrada":
        conv.estado = "abierta"
    m = Mensaje(conversacion_id=conv.id, direccion="entrante", autor="contacto", contenido=datos.texto)
    db.add(m)
    conv.ultimo_entrante_en = conv.ultimo_mensaje_en = ahora()
    conv.no_leidos += 1
    db.commit()
    emitir(db, a.espacio_id, "mensaje.recibido", {"conversacion_id": conv.id, "contacto_id": conv.contacto_id,
                                                  "canal": "widget", "texto": datos.texto})
    if conv.contacto_id:
        al_responder(db, conv.contacto_id)
    cfg = config_de(a)
    if es_baja(datos.texto, cfg["conversacion"]["palabras_baja"]):
        conv.ia_activa = False
        db.commit()
    elif conv.ia_activa:
        try:
            await responder(db, conv.id)
        except llm.ErrorLLM:
            pass
    nuevos = db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id, Mensaje.id > m.id,
                                              Mensaje.direccion == "saliente", Mensaje.contenido != "")
                        .order_by(Mensaje.id)).all()
    return {"mensajes": [_publico(x) for x in nuevos], "humano": not conv.ia_activa}


@r.get("/{clave}/mensajes")
def nuevos(clave: str, desde_id: int = 0, x_widget_token: str = Header(...), db: Session = Depends(obtener_db)):
    """Polling: trae respuestas de humanos (o de la IA) posteriores a `desde_id`."""
    a = _agente(db, clave)
    conv = _conv(db, a, x_widget_token)
    filas = db.scalars(select(Mensaje).where(Mensaje.conversacion_id == conv.id, Mensaje.id > desde_id,
                                             Mensaje.direccion == "saliente", Mensaje.contenido != "")
                       .order_by(Mensaje.id)).all()
    return {"mensajes": [_publico(x) for x in filas], "humano": not conv.ia_activa}


@r.post("/{clave}/llamada-web")
async def llamada_web(clave: str, x_widget_token: str = Header(...), db: Session = Depends(obtener_db)):
    a = _agente(db, clave)
    conv = _conv(db, a, x_widget_token)
    _limitar(f"voz-{conv.id}", 3)
    api_key = credenciales(db, a.espacio_id, "retell").get("api_key")
    if not a.retell_agent_id or not api_key:
        raise HTTPException(422, "La voz no está habilitada para este agente")
    voz = Conversacion(espacio_id=a.espacio_id, contacto_id=conv.contacto_id, agente_id=a.id, canal="voz")
    db.add(voz)
    db.flush()
    llamada = Llamada(espacio_id=a.espacio_id, conversacion_id=voz.id, contacto_id=conv.contacto_id, agente_id=a.id,
                      tipo="web", direccion="entrante")
    db.add(llamada)
    db.flush()
    contacto = db.get(Contacto, conv.contacto_id) if conv.contacto_id else None
    try:
        resp = await retell.crear_llamada_web(api_key, a.retell_agent_id, variables_de(config_de(a), contacto, {}),
                                              {"llamada_id": llamada.id, "espacio_id": a.espacio_id})
    except retell.ErrorRetell as e:
        db.rollback()
        raise HTTPException(502, str(e))
    llamada.retell_call_id = resp.get("call_id")
    db.commit()
    return {"access_token": resp.get("access_token"), "call_id": resp.get("call_id")}
