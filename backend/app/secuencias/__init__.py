"""Motor de secuencias multicanal.

Una `Secuencia` es una lista de pasos. Cada paso tiene un canal (`llamada`,
`whatsapp`, `correo`, `esperar`), una espera desde el paso anterior y una
condición (`siempre`, `sin_respuesta`, `no_conecto`). Con eso se expresan las
dos "sequences" de Dapta y sus fallbacks cruzados en un solo motor:

    llamada (3 intentos) → whatsapp [no_conecto] → espera 24 h → llamada [sin_respuesta]

Reglas que aplica el `tick` (idempotente, cada ~30 s):
  · franjas horarias por zona del contacto (fuera de franja se reprograma sin contar intento)
  · intentos máximos, intentos por día y espera entre reintentos por paso de llamada
  · cooldown global de 1 h por contacto entre todas las secuencias
  · concurrencia de llamadas por espacio y ritmo (segundos entre llamadas)
  · rotación de caller ID con tope diario por número
  · A/B de agentes por pesos
  · protección de líneas WhatsApp: calentamiento, tope diario por tier y volumen reciente,
    dedupe 24 h, pausa automática de marketing si la calidad cae, opt-out, reintentos
"""
import asyncio
import random
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..canales import correo, retell, whatsapp
from ..cerebro.motor import config_de, registrar_saliente_whatsapp, rellenar, variables_de
from ..db import ahora
from ..eventos import emitir
from ..integraciones import credenciales
from ..modelos import (Agente, Contacto, Conversacion, Envio, Espacio, Inscripcion, LineaWhatsapp, Llamada,
                       NumeroTelefono, Plantilla, Secuencia)

DIAS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"]
COOLDOWN_LLAMADA = timedelta(hours=1)
DEDUPE_WHATSAPP = timedelta(hours=24)
TIERS = {"TIER_50": 50, "TIER_250": 250, "TIER_1K": 1000, "TIER_2K": 2000, "TIER_10K": 10000,
         "TIER_100K": 100000, "TIER_UNLIMITED": 10 ** 9}
MAX_LLAMADAS_POR_TICK = 20
ESTADOS_FINALES = ("completada", "detenida", "respondio", "agendo", "fallida", "baja")


class Paso(BaseModel):
    tipo: str = Field(pattern="^(llamada|whatsapp|correo|esperar)$")
    espera_min: int = Field(0, ge=0, le=60 * 24 * 60)
    condicion: str = Field("siempre", pattern="^(siempre|sin_respuesta|no_conecto)$")
    # llamada
    agente_id: int | None = None
    max_intentos: int = Field(3, ge=1, le=40)
    intentos_por_dia: int = Field(1, ge=1, le=5)
    reintento_min: int = Field(240, ge=5, le=60 * 24 * 7)
    whatsapp_tras_intento: int | None = None  # fallback: plantilla tras el intento N si nunca conectó
    plantilla_fallback_id: int | None = None
    # whatsapp
    plantilla_id: int | None = None
    variables: list[str] = []  # valores de {{1}}, {{2}}… con {{var}} del contacto
    texto: str = ""  # solo si hay ventana de 24 h abierta; si no, se usa la plantilla
    # correo
    asunto: str = ""
    cuerpo: str = ""


def validar_pasos(pasos: list[dict]) -> list[dict]:
    return [Paso.model_validate(p).model_dump() for p in pasos]


# ─────────────────────────────── Horarios ───────────────────────────────

def _zona(sec: Secuencia, contacto: Contacto) -> ZoneInfo:
    nombre = contacto.zona_horaria if sec.usar_zona_contacto and contacto.zona_horaria else sec.zona_horaria
    try:
        return ZoneInfo(nombre)
    except Exception:
        return ZoneInfo(sec.zona_horaria)


def proxima_ventana(desde_utc: datetime, zona: ZoneInfo, horario: dict) -> datetime:
    """Devuelve `desde_utc` si cae dentro de una franja; si no, el inicio de la siguiente (UTC)."""
    if not horario or not any(horario.values()):
        return desde_utc
    local = desde_utc.replace(tzinfo=ZoneInfo("UTC")).astimezone(zona)
    for d in range(15):
        dia = (local + timedelta(days=d)).date()
        for ini, fin in sorted(horario.get(DIAS[dia.weekday()], [])):
            hi, mi = map(int, ini.split(":"))
            hf, mf = map(int, fin.split(":"))
            a = datetime(dia.year, dia.month, dia.day, hi, mi, tzinfo=zona)
            b = datetime(dia.year, dia.month, dia.day, hf, mf, tzinfo=zona)
            if local < b:
                inicio = max(a, local)
                return inicio.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    return desde_utc + timedelta(days=1)


def _dia_local(zona: ZoneInfo) -> str:
    return datetime.now(zona).date().isoformat()


# ─────────────────────────────── Inscripción y avance ───────────────────────────────

def _del_espacio(db: Session, modelo, id_: int | None, espacio_id: int):
    """Carga un recurso solo si pertenece al espacio; (None, False) si no existe y (None, True) si es ajeno."""
    if not id_:
        return None, False
    obj = db.get(modelo, int(id_))
    if obj is not None and obj.espacio_id != espacio_id:
        return None, True
    return obj, False


def _elegir_agente(db: Session, sec: Secuencia) -> int | None:
    pesos = {int(k): float(v) for k, v in (sec.ab_agentes or {}).items() if float(v) > 0}
    propios = set(db.scalars(select(Agente.id).where(Agente.id.in_(pesos), Agente.espacio_id == sec.espacio_id)))
    pesos = {k: v for k, v in pesos.items() if k in propios}
    if not pesos:
        return None
    return random.choices(list(pesos), weights=list(pesos.values()))[0]


def inscribir(db: Session, sec: Secuencia, contacto_ids: list[int], variables: dict | None = None) -> int:
    contacto_ids = list(db.scalars(select(Contacto.id).where(Contacto.id.in_(contacto_ids),
                                                             Contacto.espacio_id == sec.espacio_id)))
    existentes = set(db.scalars(select(Inscripcion.contacto_id).where(Inscripcion.secuencia_id == sec.id,
                                                                      Inscripcion.contacto_id.in_(contacto_ids))))
    espera = sec.pasos[0]["espera_min"] if sec.pasos else 0
    n = 0
    for cid in contacto_ids:
        if cid in existentes:
            continue
        db.add(Inscripcion(secuencia_id=sec.id, contacto_id=cid, agente_id=_elegir_agente(db, sec),
                           variables=variables or {}, proximo_en=ahora() + timedelta(minutes=espera)))
        n += 1
    db.commit()
    return n


def _historial(insc: Inscripcion, evento: str, **datos):
    insc.historial = [*(insc.historial or []), {"t": ahora().isoformat(timespec="seconds"), "paso": insc.paso,
                                                "evento": evento, **datos}][-60:]


def _terminar(db: Session, insc: Inscripcion, estado: str, motivo: str = ""):
    insc.estado = estado
    _historial(insc, "fin", estado=estado, motivo=motivo)
    db.commit()
    sec = db.get(Secuencia, insc.secuencia_id)
    emitir(db, sec.espacio_id, "secuencia.inscripcion_terminada", {
        "secuencia_id": sec.id, "inscripcion_id": insc.id, "contacto_id": insc.contacto_id, "estado": estado,
        "conecto": insc.conecto, "respondio": insc.respondio, "motivo": motivo})


def avanzar(db: Session, insc: Inscripcion, sec: Secuencia):
    insc.paso += 1
    insc.intentos_paso = 0
    insc.estado = "activa"
    insc.bloqueado_hasta = None
    if insc.paso >= len(sec.pasos):
        _terminar(db, insc, "completada")
        return
    insc.proximo_en = ahora() + timedelta(minutes=sec.pasos[insc.paso]["espera_min"])
    db.commit()


def al_responder(db: Session, contacto_id: int):
    """El contacto escribió: marcar y detener las secuencias que lo pidan."""
    for insc in db.scalars(select(Inscripcion).where(Inscripcion.contacto_id == contacto_id,
                                                     Inscripcion.estado.in_(("activa", "esperando")))):
        insc.respondio = True
        sec = db.get(Secuencia, insc.secuencia_id)
        if sec.detener_al_responder:
            _terminar(db, insc, "respondio")
    db.commit()


def al_agendar(db: Session, contacto_id: int):
    for insc in db.scalars(select(Inscripcion).where(Inscripcion.contacto_id == contacto_id,
                                                     Inscripcion.estado.in_(("activa", "esperando")))):
        sec = db.get(Secuencia, insc.secuencia_id)
        if sec.detener_al_agendar:
            _terminar(db, insc, "agendo")
    db.commit()


def al_dar_baja(db: Session, contacto_id: int):
    for insc in db.scalars(select(Inscripcion).where(Inscripcion.contacto_id == contacto_id,
                                                     Inscripcion.estado.in_(("activa", "esperando")))):
        _terminar(db, insc, "baja")


# ─────────────────────────────── Protección de líneas WhatsApp ───────────────────────────────

def tope_whatsapp(db: Session, linea: LineaWhatsapp) -> int:
    tier = TIERS.get(linea.tier, 250)
    tope = int(tier * 0.8)
    dias = (ahora() - linea.calentamiento_desde).days
    if dias < 3:
        tope = min(tope, 50)
    elif dias < 7:
        tope = min(tope, 150)
    elif dias < 14:
        tope = min(tope, 400)
    else:  # ligado al volumen reciente: como mucho el doble del mejor día de la última semana
        dia = func.date(Envio.creado)
        conteos = db.execute(select(dia, func.count(Envio.id)).where(
            Envio.linea_id == linea.id, Envio.creado >= ahora() - timedelta(days=7)).group_by(dia)).all()
        pico = max((c for _, c in conteos), default=0)
        tope = min(tope, max(100, 2 * int(pico)))
    if linea.calidad == "YELLOW":
        tope //= 2
    if linea.tope_diario_manual:
        tope = min(tope, linea.tope_diario_manual)
    return tope


def enviados_24h(db: Session, linea_id: int) -> int:
    return db.scalar(select(func.count(Envio.id)).where(Envio.linea_id == linea_id,
                                                        Envio.creado >= ahora() - timedelta(hours=24))) or 0


def _ultimo_envio(db: Session, contacto_id: int, canal: str) -> datetime | None:
    return db.scalar(select(func.max(Envio.creado)).where(Envio.contacto_id == contacto_id, Envio.canal == canal))


def _ventana_abierta(db: Session, contacto_id: int, linea_id: int) -> bool:
    ultimo = db.scalar(select(func.max(Conversacion.ultimo_entrante_en)).where(
        Conversacion.contacto_id == contacto_id, Conversacion.linea_id == linea_id))
    return bool(ultimo and ahora() - ultimo < timedelta(hours=23, minutes=50))


async def _paso_whatsapp(db: Session, insc: Inscripcion, sec: Secuencia, paso: dict, contacto: Contacto,
                         plantilla_id: int | None = None) -> str:
    """Devuelve: ok | posponer:<min> | omitir:<motivo> | error:<motivo>."""
    if contacto.opt_out_whatsapp:
        return "omitir:opt-out"
    if not contacto.telefono:
        return "omitir:sin teléfono"
    plantilla, ajena = _del_espacio(db, Plantilla, plantilla_id or paso.get("plantilla_id"), sec.espacio_id)
    if ajena:
        return "config:la plantilla no pertenece a este espacio"
    linea, ajena = _del_espacio(db, LineaWhatsapp, plantilla.linea_id if plantilla else sec.linea_id, sec.espacio_id)
    if ajena:
        return "config:la línea de WhatsApp no pertenece a este espacio"
    if not linea or linea.estado != "conectada":
        return "config:sin línea de WhatsApp conectada"
    ventana = _ventana_abierta(db, contacto.id, linea.id)
    usar_texto = bool(paso.get("texto")) and ventana and not plantilla_id
    if not usar_texto:
        if not plantilla or plantilla.estado != "APPROVED":
            return ("config:la plantilla no está aprobada por Meta" if plantilla
                    else "config:fuera de la ventana de 24 h solo se puede enviar plantilla")
        if plantilla.categoria == "MARKETING" and (linea.marketing_pausado or linea.calidad == "RED"):
            return "posponer:360"
    ultimo = _ultimo_envio(db, contacto.id, "whatsapp")
    if ultimo and ahora() - ultimo < DEDUPE_WHATSAPP:
        return f"posponer:{int((DEDUPE_WHATSAPP - (ahora() - ultimo)).total_seconds() // 60) + 1}"
    if enviados_24h(db, linea.id) >= tope_whatsapp(db, linea):
        return "posponer:60"
    agente, _ = _del_espacio(db, Agente, insc.agente_id or linea.agente_id, sec.espacio_id)
    cfg = config_de(agente) if agente else {"variables": {}}
    valores = {**variables_de(cfg, contacto, insc.variables)}
    try:
        if usar_texto:
            texto = rellenar(paso["texto"], valores)
            wamid = await whatsapp.enviar_texto(linea, contacto.telefono, texto)
            registrar_saliente_whatsapp(db, sec.espacio_id, linea, contacto, None, [], wamid,
                                        agente.id if agente else None, sec.id, texto=texto)
        else:
            variables = [rellenar(v, valores) for v in paso.get("variables", [])]
            wamid = await whatsapp.enviar_plantilla(linea, contacto.telefono, plantilla.nombre, plantilla.idioma,
                                                    variables)
            registrar_saliente_whatsapp(db, sec.espacio_id, linea, contacto, plantilla, variables, wamid,
                                        agente.id if agente else None, sec.id)
    except whatsapp.ErrorWhatsapp as e:
        if e.codigo in (130429, 131056, 80007):
            return "posponer:15"
        if e.transitorio and insc.intentos_paso < 3:
            return "posponer:5"
        return f"error:{e}"
    return "ok"


async def _paso_correo(db: Session, insc: Inscripcion, sec: Secuencia, paso: dict, contacto: Contacto) -> str:
    if contacto.opt_out_correo:
        return "omitir:opt-out"
    if not contacto.email:
        return "omitir:sin correo"
    agente, _ = _del_espacio(db, Agente, insc.agente_id, sec.espacio_id)
    valores = variables_de(config_de(agente) if agente else {"variables": {}}, contacto, insc.variables)
    try:
        await correo.enviar(db, sec.espacio_id, contacto.email, rellenar(paso["asunto"], valores),
                            rellenar(paso["cuerpo"], valores))
    except correo.ErrorCorreo as e:
        if "no configurado" in str(e):
            return f"config:{e}"
        return "posponer:10" if insc.intentos_paso < 3 else f"error:{e}"
    db.add(Envio(espacio_id=sec.espacio_id, contacto_id=contacto.id, canal="correo", secuencia_id=sec.id))
    contacto.ultimo_contacto_en = ahora()
    db.commit()
    return "ok"


# ─────────────────────────────── Llamadas ───────────────────────────────

def llamadas_vivas(db: Session, espacio_id: int) -> int:
    return db.scalar(select(func.count(Llamada.id)).where(
        Llamada.espacio_id == espacio_id, Llamada.estado.in_(("registrada", "en_curso")),
        Llamada.creado >= ahora() - timedelta(hours=2))) or 0


def _elegir_numero(db: Session, sec: Secuencia, contacto: Contacto) -> NumeroTelefono | None:
    if not sec.numeros_ids:
        return None
    numeros = db.scalars(select(NumeroTelefono).where(NumeroTelefono.id.in_(sec.numeros_ids),
                                                      NumeroTelefono.espacio_id == sec.espacio_id,
                                                      NumeroTelefono.activo.is_(True))).all()
    uso = dict(db.execute(select(Envio.numero_id, func.count(Envio.id)).where(
        Envio.numero_id.in_([n.id for n in numeros]), Envio.creado >= ahora() - timedelta(hours=24))
        .group_by(Envio.numero_id)).all())
    libres = [n for n in numeros if uso.get(n.id, 0) < n.tope_diario]
    if not libres:
        return None
    prefijo = (contacto.telefono or "")[:3]
    locales = [n for n in libres if n.numero.startswith(prefijo)]
    return min(locales or libres, key=lambda n: uso.get(n.id, 0))


async def _paso_llamada(db: Session, insc: Inscripcion, sec: Secuencia, paso: dict, contacto: Contacto) -> str:
    if contacto.opt_out_llamadas:
        return "omitir:opt-out"
    if not contacto.telefono:
        return "omitir:sin teléfono"
    zona = _zona(sec, contacto)
    hoy = _dia_local(zona)
    if insc.dia_intentos != hoy:
        insc.dia_intentos, insc.intentos_hoy = hoy, 0
    if insc.intentos_hoy >= paso["intentos_por_dia"]:
        manana = datetime.now(zona).replace(hour=0, minute=1) + timedelta(days=1)
        minutos = (manana - datetime.now(zona)).total_seconds() // 60 + 1
        return f"posponer:{int(minutos)}"
    ultima = _ultimo_envio(db, contacto.id, "llamada")
    if ultima and ahora() - ultima < COOLDOWN_LLAMADA:
        return f"posponer:{int((COOLDOWN_LLAMADA - (ahora() - ultima)).total_seconds() // 60) + 1}"
    espacio = db.get(Espacio, sec.espacio_id)
    if llamadas_vivas(db, sec.espacio_id) >= espacio.concurrencia_llamadas:
        return "posponer:1"
    agente, ajena = _del_espacio(db, Agente, paso.get("agente_id") or insc.agente_id, sec.espacio_id)
    if ajena:
        return "config:el agente de voz no pertenece a este espacio"
    if not agente or not agente.retell_agent_id:
        return "config:el agente de voz no está publicado en Retell"
    numero = _elegir_numero(db, sec, contacto)
    if not numero:
        return "posponer:60" if sec.numeros_ids else "config:la secuencia no tiene números de salida"
    api_key = credenciales(db, sec.espacio_id, "retell").get("api_key")
    if not api_key:
        return "config:falta la API key de Retell"
    conv = Conversacion(espacio_id=sec.espacio_id, contacto_id=contacto.id, agente_id=agente.id, canal="voz",
                        inscripcion_id=insc.id, variables=insc.variables or {})
    db.add(conv)
    db.flush()
    llamada = Llamada(espacio_id=sec.espacio_id, conversacion_id=conv.id, contacto_id=contacto.id,
                      agente_id=agente.id, inscripcion_id=insc.id, desde=numero.numero, hacia=contacto.telefono,
                      paso_idx=insc.paso, intento=insc.intentos_paso + 1)
    db.add(llamada)
    db.flush()
    cfg = config_de(agente)
    try:
        datos = await retell.crear_llamada(api_key, agente.retell_agent_id, numero.numero, contacto.telefono,
                                           variables_de(cfg, contacto, insc.variables),
                                           {"llamada_id": llamada.id, "espacio_id": sec.espacio_id})
    except retell.ErrorRetell as e:
        llamada.estado, llamada.resultado, llamada.razon_desconexion = "fallida", "fallida", str(e)[:60]
        conv.estado = "cerrada"
        db.commit()
        return "posponer:10" if insc.intentos_paso < 2 and str(e).startswith("Retell 5") else f"error:{e}"
    llamada.retell_call_id = datos.get("call_id")
    db.add(Envio(espacio_id=sec.espacio_id, contacto_id=contacto.id, canal="llamada", numero_id=numero.id,
                 secuencia_id=sec.id))
    insc.intentos_paso += 1
    insc.intentos_hoy += 1
    insc.estado = "esperando"
    insc.bloqueado_hasta = ahora() + timedelta(minutes=30)
    _historial(insc, "llamada", intento=insc.intentos_paso, llamada_id=llamada.id, desde=numero.numero)
    contacto.ultimo_contacto_en = ahora()
    sec.ultimo_envio_llamada = ahora()
    db.commit()
    return "esperando"


async def al_terminar_llamada(db: Session, llamada: Llamada):
    """Avanza la inscripción según el resultado de la llamada (lo llama el webhook de Retell)."""
    if not llamada.inscripcion_id:
        return
    insc = db.get(Inscripcion, llamada.inscripcion_id)
    if not insc or insc.estado != "esperando" or insc.paso != llamada.paso_idx:
        return
    sec = db.get(Secuencia, insc.secuencia_id)
    paso = sec.pasos[insc.paso]
    _historial(insc, "resultado", resultado=llamada.resultado, llamada_id=llamada.id, duracion=llamada.duracion_s)
    if llamada.resultado == "contestada":
        insc.conecto = True
        avanzar(db, insc, sec)
        return
    contacto = db.get(Contacto, insc.contacto_id)
    if (paso.get("whatsapp_tras_intento") and paso.get("plantilla_fallback_id") and not insc.conecto
            and insc.intentos_paso == paso["whatsapp_tras_intento"]):
        r = await _paso_whatsapp(db, insc, sec, paso, contacto, plantilla_id=paso["plantilla_fallback_id"])
        _historial(insc, "fallback_whatsapp", resultado=r)
    if insc.intentos_paso >= paso["max_intentos"]:
        avanzar(db, insc, sec)
        return
    insc.estado = "activa"
    insc.bloqueado_hasta = None
    insc.proximo_en = proxima_ventana(ahora() + timedelta(minutes=paso["reintento_min"]), _zona(sec, contacto),
                                      sec.horario)
    db.commit()


async def _resolver_huerfanas(db: Session):
    """Inscripciones esperando un webhook que nunca llegó: se consulta a Retell."""
    viejas = db.scalars(select(Inscripcion).where(Inscripcion.estado == "esperando",
                                                  Inscripcion.bloqueado_hasta < ahora())).all()
    for insc in viejas:
        llamada = db.scalars(select(Llamada).where(Llamada.inscripcion_id == insc.id)
                             .order_by(Llamada.id.desc())).first()
        if not llamada:
            insc.estado = "activa"
            continue
        if llamada.estado in ("terminada", "fallida"):
            await al_terminar_llamada(db, llamada)
            continue
        sec = db.get(Secuencia, insc.secuencia_id)
        api_key = credenciales(db, sec.espacio_id, "retell").get("api_key")
        try:
            datos = await retell.obtener_llamada(api_key, llamada.retell_call_id) if llamada.retell_call_id else {}
        except retell.ErrorRetell:
            datos = {}
        if datos.get("call_status") in ("ended", "error") or not datos:
            from ..rutas.voz import aplicar_datos_llamada

            aplicar_datos_llamada(db, llamada, datos or {"call_status": "error",
                                                         "disconnection_reason": "webhook_perdido"})
            await al_terminar_llamada(db, llamada)
        else:
            insc.bloqueado_hasta = ahora() + timedelta(minutes=15)
    db.commit()


# ─────────────────────────────── Tick ───────────────────────────────

def _pausar(db: Session, sec: Secuencia, motivo: str):
    sec.estado = "pausada"
    db.commit()
    emitir(db, sec.espacio_id, "secuencia.pausada", {"secuencia_id": sec.id, "motivo": motivo})


async def procesar(db: Session, insc: Inscripcion, sec: Secuencia, ignorar_franja: bool = False) -> str:
    contacto = db.get(Contacto, insc.contacto_id)
    if insc.paso >= len(sec.pasos):
        _terminar(db, insc, "completada")
        return "completada"
    paso = sec.pasos[insc.paso]
    if (paso["condicion"] == "sin_respuesta" and insc.respondio) or \
            (paso["condicion"] == "no_conecto" and insc.conecto):
        _historial(insc, "omitido", motivo=paso["condicion"])
        avanzar(db, insc, sec)
        return "omitido"
    if paso["tipo"] == "esperar":
        avanzar(db, insc, sec)
        return "esperar"
    ventana = proxima_ventana(ahora(), _zona(sec, contacto), {} if ignorar_franja else sec.horario)
    if ventana > ahora() + timedelta(seconds=59):
        insc.proximo_en = ventana  # fuera de franja: se reprograma sin contar intento
        db.commit()
        return "fuera_de_franja"
    if paso["tipo"] == "whatsapp":
        r = await _paso_whatsapp(db, insc, sec, paso, contacto)
    elif paso["tipo"] == "correo":
        r = await _paso_correo(db, insc, sec, paso, contacto)
    else:
        r = await _paso_llamada(db, insc, sec, paso, contacto)
    if r == "ok":
        _historial(insc, paso["tipo"], resultado="ok")
        avanzar(db, insc, sec)
    elif r.startswith("posponer:"):
        if paso["tipo"] != "llamada":
            insc.intentos_paso += 1
        insc.proximo_en = ahora() + timedelta(minutes=int(r.split(":")[1]))
        db.commit()
    elif r.startswith("omitir:"):
        _historial(insc, "omitido", motivo=r[7:])
        avanzar(db, insc, sec)
    elif r.startswith("config:"):
        # Error de configuración: no se queman contactos, se pausa la secuencia para corregir
        insc.ultimo_error = r[7:][:500]
        _pausar(db, sec, r[7:])
    elif r.startswith("error:"):
        insc.ultimo_error = r[6:][:500]
        _historial(insc, "error", motivo=r[6:][:200])
        if paso["tipo"] == "llamada":
            avanzar(db, insc, sec)
        else:
            _terminar(db, insc, "fallida", r[6:])
    return r


async def tick(db: Session) -> dict:
    await _resolver_huerfanas(db)
    resumen = {"procesadas": 0, "llamadas": 0}
    for sec in db.scalars(select(Secuencia).where(Secuencia.estado == "activa")).all():
        if sec.fecha_fin and ahora() > sec.fecha_fin:
            sec.estado = "completada"
            db.commit()
            continue
        listas = db.scalars(select(Inscripcion).where(
            Inscripcion.secuencia_id == sec.id, Inscripcion.estado == "activa", Inscripcion.proximo_en <= ahora())
            .order_by(Inscripcion.proximo_en).limit(sec.tamano_lote)).all()
        for insc in listas:
            es_llamada = insc.paso < len(sec.pasos) and sec.pasos[insc.paso]["tipo"] == "llamada"
            if es_llamada and resumen["llamadas"] >= MAX_LLAMADAS_POR_TICK:
                continue
            r = await procesar(db, insc, sec)
            resumen["procesadas"] += 1
            if sec.estado != "activa":
                break
            if r == "esperando":
                resumen["llamadas"] += 1
                await asyncio.sleep(sec.segundos_entre_llamadas)
        pendientes = db.scalar(select(func.count(Inscripcion.id)).where(
            Inscripcion.secuencia_id == sec.id, Inscripcion.estado.in_(("activa", "esperando"))))
        total = db.scalar(select(func.count(Inscripcion.id)).where(Inscripcion.secuencia_id == sec.id))
        if total and not pendientes:
            sec.estado = "completada"
            db.commit()
    return resumen


async def ejecutar_ahora(db: Session, insc: Inscripcion) -> str:
    """Reintento manual: ignora franja y espera (la UI pide confirmación antes)."""
    sec = db.get(Secuencia, insc.secuencia_id)
    if insc.estado == "esperando":
        return "esperando"
    if insc.estado in ESTADOS_FINALES:
        insc.estado = "activa"
        if insc.paso >= len(sec.pasos):
            insc.paso = max(0, len(sec.pasos) - 1)
    insc.proximo_en = ahora()
    return await procesar(db, insc, sec, ignorar_franja=True)
