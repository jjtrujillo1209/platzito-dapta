"""Secuencias (campañas outbound multicanal) e inscripciones."""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Integer, cast, func, select

from .. import secuencias as motor
from .. import serial
from ..modelos import Agente, Contacto, Inscripcion, LineaWhatsapp, Llamada, NumeroTelefono, Plantilla, Secuencia
from ..seguridad import Contexto, requiere

r = APIRouter(prefix="/api/secuencias", tags=["secuencias"])

HORARIO_DEFECTO = {d: [["09:00", "12:30"], ["14:00", "18:00"]] for d in ("lun", "mar", "mie", "jue", "vie")}


def _sec(ctx: Contexto, sec_id: int) -> Secuencia:
    s = ctx.db.get(Secuencia, sec_id)
    if not s or s.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Secuencia no encontrada")
    return s


def _conteos(ctx: Contexto, ids: list[int]) -> dict[int, dict]:
    filas = ctx.db.execute(select(Inscripcion.secuencia_id, Inscripcion.estado, func.count(Inscripcion.id))
                           .where(Inscripcion.secuencia_id.in_(ids))
                           .group_by(Inscripcion.secuencia_id, Inscripcion.estado)).all()
    salida: dict[int, dict] = {}
    for sid, estado, n in filas:
        salida.setdefault(sid, {})[estado] = n
    return salida


@r.get("")
def listar(ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(Secuencia).where(Secuencia.espacio_id == ctx.espacio_id,
                                                   Secuencia.estado != "archivada").order_by(Secuencia.id.desc())).all()
    conteos = _conteos(ctx, [s.id for s in filas])
    return [serial.secuencia(s, conteos.get(s.id)) for s in filas]


class DatosSecuencia(BaseModel):
    nombre: str = Field(min_length=1, max_length=160)
    pasos: list[dict] = []
    zona_horaria: str = "America/Bogota"
    usar_zona_contacto: bool = True
    horario: dict = Field(default_factory=lambda: dict(HORARIO_DEFECTO))
    ab_agentes: dict[str, float] = {}
    numeros_ids: list[int] = []
    linea_id: int | None = None
    tamano_lote: int = Field(100, ge=1, le=500)
    segundos_entre_llamadas: int = Field(3, ge=1, le=600)
    detener_al_responder: bool = True
    detener_al_agendar: bool = True
    fecha_fin: datetime | None = None


def _validar(ctx: Contexto, d: DatosSecuencia) -> dict:
    try:
        pasos = motor.validar_pasos(d.pasos)
    except Exception as e:
        raise HTTPException(422, f"Pasos inválidos: {e}")
    ids_agentes = {int(k) for k in d.ab_agentes} | {p["agente_id"] for p in pasos if p.get("agente_id")}
    for aid in ids_agentes:
        a = ctx.db.get(Agente, aid)
        if not a or a.espacio_id != ctx.espacio_id:
            raise HTTPException(422, f"Agente {aid} inválido")
    if d.ab_agentes and abs(sum(d.ab_agentes.values()) - 100) > 0.01:
        raise HTTPException(422, "Los pesos del A/B deben sumar 100")
    if len(d.ab_agentes) > 4:
        raise HTTPException(422, "Máximo 4 agentes en el A/B")
    for nid in d.numeros_ids:
        n = ctx.db.get(NumeroTelefono, nid)
        if not n or n.espacio_id != ctx.espacio_id:
            raise HTTPException(422, f"Número {nid} inválido")
    if d.linea_id:
        l = ctx.db.get(LineaWhatsapp, d.linea_id)
        if not l or l.espacio_id != ctx.espacio_id:
            raise HTTPException(422, f"Línea {d.linea_id} inválida")
    for p in pasos:
        for pid in (p.get("plantilla_id"), p.get("plantilla_fallback_id")):
            if pid:
                pl = ctx.db.get(Plantilla, pid)
                if not pl or pl.espacio_id != ctx.espacio_id:
                    raise HTTPException(422, f"Plantilla {pid} inválida")
    for dia, franjas in d.horario.items():
        if dia not in motor.DIAS:
            raise HTTPException(422, f"Día inválido: {dia}")
        for f in franjas:
            if len(f) != 2 or f[0] >= f[1]:
                raise HTTPException(422, f"Franja inválida en {dia}: {f}")
    datos = d.model_dump()
    datos["pasos"] = pasos
    if datos["fecha_fin"]:
        datos["fecha_fin"] = datos["fecha_fin"].replace(tzinfo=None)
    return datos


@r.post("")
def crear(datos: DatosSecuencia, ctx: Contexto = Depends(requiere("editor"))):
    s = Secuencia(espacio_id=ctx.espacio_id, **_validar(ctx, datos))
    ctx.db.add(s)
    ctx.db.commit()
    return serial.secuencia(s)


@r.get("/{sec_id}")
def ver(sec_id: int, ctx: Contexto = Depends(requiere("lector"))):
    s = _sec(ctx, sec_id)
    return serial.secuencia(s, _conteos(ctx, [s.id]).get(s.id))


@r.put("/{sec_id}")
def editar(sec_id: int, datos: DatosSecuencia, ctx: Contexto = Depends(requiere("editor"))):
    s = _sec(ctx, sec_id)
    nuevos = _validar(ctx, datos)
    if s.estado == "activa" and len(nuevos["pasos"]) < len(s.pasos):
        raise HTTPException(422, "Pausa la secuencia antes de quitar pasos")
    for k, v in nuevos.items():
        setattr(s, k, v)
    ctx.db.commit()
    return serial.secuencia(s)


@r.post("/{sec_id}/activar")
def activar(sec_id: int, ctx: Contexto = Depends(requiere("editor"))):
    s = _sec(ctx, sec_id)
    if not s.pasos:
        raise HTTPException(422, "La secuencia no tiene pasos")
    s.estado = "activa"
    ctx.db.commit()
    return serial.secuencia(s)


@r.post("/{sec_id}/pausar")
def pausar(sec_id: int, ctx: Contexto = Depends(requiere("operador"))):
    s = _sec(ctx, sec_id)
    s.estado = "pausada"
    ctx.db.commit()
    return serial.secuencia(s)


@r.delete("/{sec_id}")
def archivar(sec_id: int, ctx: Contexto = Depends(requiere("admin"))):
    s = _sec(ctx, sec_id)
    s.estado = "archivada"
    ctx.db.commit()
    return {"ok": True}


class Inscribir(BaseModel):
    contacto_ids: list[int] = []
    etapa: str = ""
    etiqueta: str = ""
    variables: dict = {}


@r.post("/{sec_id}/inscribir")
def inscribir(sec_id: int, datos: Inscribir, ctx: Contexto = Depends(requiere("operador"))):
    s = _sec(ctx, sec_id)
    ids = set(datos.contacto_ids)
    if datos.etapa or datos.etiqueta:
        q = select(Contacto).where(Contacto.espacio_id == ctx.espacio_id)
        if datos.etapa:
            q = q.where(Contacto.etapa == datos.etapa)
        ids |= {c.id for c in ctx.db.scalars(q) if not datos.etiqueta or datos.etiqueta in (c.etiquetas or [])}
    validos = set(ctx.db.scalars(select(Contacto.id).where(Contacto.espacio_id == ctx.espacio_id,
                                                           Contacto.id.in_(ids)))) if ids else set()
    n = motor.inscribir(ctx.db, s, sorted(validos), datos.variables)
    return {"inscritos": n, "omitidos": len(ids) - n}


@r.get("/{sec_id}/inscripciones")
def inscripciones(sec_id: int, estado: str = "", pagina: int = 1, ctx: Contexto = Depends(requiere("lector"))):
    s = _sec(ctx, sec_id)
    q = select(Inscripcion).where(Inscripcion.secuencia_id == s.id)
    if estado:
        q = q.where(Inscripcion.estado.in_(estado.split(",")))
    total = ctx.db.scalar(select(func.count()).select_from(q.subquery()))
    filas = ctx.db.scalars(q.order_by(Inscripcion.id.desc()).offset((pagina - 1) * 100).limit(100)).all()
    return {"total": total, "inscripciones": [serial.inscripcion(i) for i in filas]}


def _insc(ctx: Contexto, insc_id: int) -> Inscripcion:
    i = ctx.db.get(Inscripcion, insc_id)
    if not i:
        raise HTTPException(404, "No encontrada")
    _sec(ctx, i.secuencia_id)
    return i


@r.post("/inscripciones/{insc_id}/ejecutar-ahora")
async def ejecutar_ahora(insc_id: int, ctx: Contexto = Depends(requiere("operador"))):
    """Reintento manual: se salta franja y espera (la UI pide confirmación)."""
    i = _insc(ctx, insc_id)
    resultado = await motor.ejecutar_ahora(ctx.db, i)
    return {"resultado": resultado, "inscripcion": serial.inscripcion(i)}


@r.post("/inscripciones/{insc_id}/detener")
def detener(insc_id: int, ctx: Contexto = Depends(requiere("operador"))):
    i = _insc(ctx, insc_id)
    if i.estado in ("activa", "esperando"):
        motor._terminar(ctx.db, i, "detenida", "manual")
    return serial.inscripcion(i)


@r.get("/{sec_id}/metricas")
def metricas(sec_id: int, ctx: Contexto = Depends(requiere("lector"))):
    s = _sec(ctx, sec_id)
    conteo = _conteos(ctx, [s.id]).get(s.id, {})
    total = sum(conteo.values())
    llamadas = ctx.db.execute(select(Llamada.resultado, func.count(Llamada.id)).join(
        Inscripcion, Inscripcion.id == Llamada.inscripcion_id).where(Inscripcion.secuencia_id == s.id)
        .group_by(Llamada.resultado)).all()
    por_resultado = {r_ or "pendiente": n for r_, n in llamadas}
    contactos_llamados = ctx.db.scalar(select(func.count(func.distinct(Llamada.contacto_id))).join(
        Inscripcion, Inscripcion.id == Llamada.inscripcion_id).where(Inscripcion.secuencia_id == s.id)) or 0
    total_llamadas = sum(por_resultado.values())
    conectaron = ctx.db.scalar(select(func.count(Inscripcion.id)).where(Inscripcion.secuencia_id == s.id,
                                                                        Inscripcion.conecto.is_(True))) or 0
    respondieron = ctx.db.scalar(select(func.count(Inscripcion.id)).where(Inscripcion.secuencia_id == s.id,
                                                                          Inscripcion.respondio.is_(True))) or 0
    por_paso = dict(ctx.db.execute(select(Inscripcion.paso, func.count(Inscripcion.id)).where(
        Inscripcion.secuencia_id == s.id).group_by(Inscripcion.paso)).all())
    ab = ctx.db.execute(select(Inscripcion.agente_id, func.count(Inscripcion.id),
                               func.sum(cast(Inscripcion.conecto, Integer)),
                               func.sum(cast(Inscripcion.estado == "agendo", Integer)))
                        .where(Inscripcion.secuencia_id == s.id).group_by(Inscripcion.agente_id)).all()
    return {"inscritos": total, "por_estado": conteo, "llamadas": por_resultado, "total_llamadas": total_llamadas,
            "contactos_llamados": contactos_llamados,
            "tasa_conexion": round(por_resultado.get("contestada", 0) / total_llamadas, 3) if total_llamadas else 0,
            "contactos_conectados": conectaron, "respondieron": respondieron,
            "agendaron": conteo.get("agendo", 0), "por_paso": por_paso,
            "ab": [{"agente_id": a, "inscritos": n, "conectaron": int(c or 0), "agendaron": int(g or 0)}
                   for a, n, c, g in ab]}
