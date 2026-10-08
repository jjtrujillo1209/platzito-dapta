"""Agendamiento: interno (horario del agente + citas guardadas) o Cal.com."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..integraciones import credenciales
from ..modelos import Cita

DIAS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"]
HORARIO_DEFECTO = {d: [["09:00", "17:00"]] for d in DIAS[:5]}


class ErrorAgenda(Exception):
    pass


def _a_utc(dt: datetime) -> datetime:
    return dt.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


def huecos_internos(db: Session, espacio_id: int, dia: date, cfg: dict, zona: str) -> list[datetime]:
    """Huecos libres (en la zona local) de un día según el horario configurado."""
    tz = ZoneInfo(zona)
    duracion = int(cfg.get("duracion_min", 30))
    horario = cfg.get("horario") or HORARIO_DEFECTO
    franjas = horario.get(DIAS[dia.weekday()], [])
    ocupadas = db.scalars(select(Cita).where(Cita.espacio_id == espacio_id, Cita.estado == "confirmada",
                                             Cita.inicio >= _a_utc(datetime.combine(dia, datetime.min.time(), tz)),
                                             Cita.inicio < _a_utc(datetime.combine(dia + timedelta(days=1),
                                                                                   datetime.min.time(), tz)))).all()
    ocupadas_utc = [(c.inicio, c.inicio + timedelta(minutes=c.duracion_min)) for c in ocupadas]
    minimo = datetime.now(tz) + timedelta(hours=int(cfg.get("antelacion_h", 2)))
    libres = []
    for ini_s, fin_s in franjas:
        h, m = map(int, ini_s.split(":"))
        hf, mf = map(int, fin_s.split(":"))
        actual = datetime(dia.year, dia.month, dia.day, h, m, tzinfo=tz)
        fin = datetime(dia.year, dia.month, dia.day, hf, mf, tzinfo=tz)
        while actual + timedelta(minutes=duracion) <= fin:
            a_utc = _a_utc(actual)
            choca = any(a_utc < f and a_utc + timedelta(minutes=duracion) > i for i, f in ocupadas_utc)
            if actual >= minimo and not choca:
                libres.append(actual)
            actual += timedelta(minutes=duracion)
    return libres


async def disponibilidad(db: Session, espacio_id: int, cfg: dict, zona: str, desde: date, dias: int = 3
                         ) -> dict[str, list[str]]:
    if cfg.get("proveedor") == "calcom":
        return await _calcom_huecos(db, espacio_id, cfg, zona, desde, dias)
    salida: dict[str, list[str]] = {}
    d = desde
    while len(salida) < dias and (d - desde).days < 21:
        libres = huecos_internos(db, espacio_id, d, cfg, zona)
        if libres:
            salida[d.isoformat()] = [h.strftime("%H:%M") for h in libres]
        d += timedelta(days=1)
    return salida


async def agendar(db: Session, espacio_id: int, cfg: dict, zona: str, inicio_local: datetime, contacto,
                  agente_id: int | None, conversacion_id: int | None, notas: str = "", email: str = "") -> Cita:
    tz = ZoneInfo(zona)
    if inicio_local.tzinfo is None:
        inicio_local = inicio_local.replace(tzinfo=tz)
    duracion = int(cfg.get("duracion_min", 30))
    cita = Cita(espacio_id=espacio_id, contacto_id=contacto.id if contacto else None, agente_id=agente_id,
                conversacion_id=conversacion_id, inicio=_a_utc(inicio_local), duracion_min=duracion, notas=notas)
    if cfg.get("proveedor") == "calcom":
        cita.proveedor = "calcom"
        cita.externo_id = await _calcom_reservar(db, espacio_id, cfg, zona, inicio_local, contacto, email, notas)
    else:
        libres = huecos_internos(db, espacio_id, inicio_local.date(), cfg, zona)
        if not any(abs((h - inicio_local).total_seconds()) < 60 for h in libres):
            raise ErrorAgenda("Ese horario no está disponible")
    db.add(cita)
    db.commit()
    return cita


# ─────────────────────────────── Cal.com v2 ───────────────────────────────

async def _calcom_huecos(db, espacio_id, cfg, zona, desde: date, dias: int) -> dict[str, list[str]]:
    cred = credenciales(db, espacio_id, "calcom")
    tipo_evento = cfg.get("event_type_id") or cred.get("event_type_id")
    if not cred.get("api_key") or not tipo_evento:
        raise ErrorAgenda("Cal.com no está configurado (API key y event type)")
    async with httpx.AsyncClient(timeout=20) as cliente:
        r = await cliente.get("https://api.cal.com/v2/slots", params={
            "eventTypeId": tipo_evento, "start": desde.isoformat(),
            "end": (desde + timedelta(days=dias + 4)).isoformat(), "timeZone": zona},
            headers={"authorization": f"Bearer {cred['api_key']}", "cal-api-version": "2024-09-04"})
    if r.status_code >= 400:
        raise ErrorAgenda(f"Cal.com {r.status_code}: {r.text[:200]}")
    datos = r.json().get("data", {})
    salida = {}
    for dia, huecos in sorted(datos.items())[:dias]:
        salida[dia] = [datetime.fromisoformat(h["start"]).astimezone(ZoneInfo(zona)).strftime("%H:%M")
                       for h in huecos]
    return salida


async def _calcom_reservar(db, espacio_id, cfg, zona, inicio: datetime, contacto, email, notas) -> str:
    cred = credenciales(db, espacio_id, "calcom")
    tipo_evento = cfg.get("event_type_id") or cred.get("event_type_id")
    asistente = {"name": (contacto.nombre if contacto else "") or "Contacto", "timeZone": zona,
                 "email": email or (contacto.email if contacto else "") or "sin-correo@platzito.invalid"}
    if contacto and contacto.telefono:
        asistente["phoneNumber"] = contacto.telefono
    async with httpx.AsyncClient(timeout=20) as cliente:
        r = await cliente.post("https://api.cal.com/v2/bookings", json={
            "start": _a_utc(inicio).isoformat() + "Z", "eventTypeId": int(tipo_evento), "attendee": asistente,
            "metadata": {"origen": "platzito"}, "bookingFieldsResponses": {"notes": notas[:500]}},
            headers={"authorization": f"Bearer {cred['api_key']}", "cal-api-version": "2024-08-13"})
    if r.status_code >= 400:
        raise ErrorAgenda(f"Cal.com {r.status_code}: {r.text[:200]}")
    return str(r.json().get("data", {}).get("uid", ""))


def hoy_en(zona: str) -> date:
    return datetime.now(ZoneInfo(zona)).date()

