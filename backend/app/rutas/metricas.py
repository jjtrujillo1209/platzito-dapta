"""Registro de llamadas, citas, métricas del panel y simulaciones."""
import csv
import io
from datetime import datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Integer, case, cast, func, select

from .. import llm, serial, simulador
from ..db import FabricaSesion, ahora
from ..modelos import Agente, Cita, Contacto, Conversacion, Envio, LineaWhatsapp, Llamada, Mensaje, Simulacion
from ..seguridad import Contexto, requiere

r = APIRouter(prefix="/api", tags=["metricas"])


def _rango(desde: str | None, hasta: str | None) -> tuple[datetime, datetime]:
    fin = datetime.fromisoformat(hasta) if hasta else ahora()
    ini = datetime.fromisoformat(desde) if desde else fin - timedelta(days=30)
    return ini.replace(tzinfo=None), fin.replace(tzinfo=None)


# ─────────────────────────────── Llamadas ───────────────────────────────

def _consulta_llamadas(ctx: Contexto, desde, hasta, agente_id, resultado, q):
    ini, fin = _rango(desde, hasta)
    consulta = select(Llamada).where(Llamada.espacio_id == ctx.espacio_id, Llamada.creado >= ini,
                                     Llamada.creado <= fin)
    if agente_id:
        consulta = consulta.where(Llamada.agente_id == agente_id)
    if resultado:
        consulta = consulta.where(Llamada.resultado.in_(resultado.split(",")))
    if q:
        consulta = consulta.where(Llamada.hacia.ilike(f"%{q}%") | Llamada.desde.ilike(f"%{q}%"))
    return consulta


@r.get("/llamadas")
def llamadas(desde: str | None = None, hasta: str | None = None, agente_id: int | None = None, resultado: str = "",
             q: str = "", pagina: int = 1, ctx: Contexto = Depends(requiere("lector"))):
    consulta = _consulta_llamadas(ctx, desde, hasta, agente_id, resultado, q)
    total = ctx.db.scalar(select(func.count()).select_from(consulta.subquery()))
    filas = ctx.db.scalars(consulta.order_by(Llamada.id.desc()).offset((pagina - 1) * 50).limit(50)).all()
    convs = {c.id: c for c in ctx.db.scalars(select(Conversacion).where(
        Conversacion.id.in_([l.conversacion_id for l in filas if l.conversacion_id])))}
    salida = []
    for l in filas:
        c = convs.get(l.conversacion_id)
        salida.append({**serial.llamada(l), "contacto": serial.contacto(c.contacto) if c and c.contacto else None,
                       "resumen": c.resumen if c else "", "exito": c.exito if c else None,
                       "sentimiento": c.sentimiento if c else ""})
    return {"total": total, "llamadas": salida}


@r.get("/llamadas/exportar")
def exportar_llamadas(desde: str | None = None, hasta: str | None = None, agente_id: int | None = None,
                      resultado: str = "", ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(_consulta_llamadas(ctx, desde, hasta, agente_id, resultado, "")
                           .order_by(Llamada.id.desc()).limit(50000)).all()
    convs = {c.id: c for c in ctx.db.scalars(select(Conversacion).where(
        Conversacion.id.in_([l.conversacion_id for l in filas if l.conversacion_id])))}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "fecha", "desde", "hacia", "contacto", "agente_id", "resultado", "razon", "duracion_s",
                "exito", "resumen", "grabacion"])
    for l in filas:
        c = convs.get(l.conversacion_id)
        w.writerow([l.id, l.creado.isoformat(), l.desde, l.hacia, c.contacto.nombre if c and c.contacto else "",
                    l.agente_id, l.resultado, l.razon_desconexion, l.duracion_s, c.exito if c else "",
                    (c.resumen if c else "").replace("\n", " "), l.grabacion_url])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"content-disposition": "attachment; filename=llamadas.csv"})


@r.get("/llamadas/{llamada_id}")
def llamada(llamada_id: int, ctx: Contexto = Depends(requiere("lector"))):
    l = ctx.db.get(Llamada, llamada_id)
    if not l or l.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Llamada no encontrada")
    c = ctx.db.get(Conversacion, l.conversacion_id) if l.conversacion_id else None
    mensajes = ctx.db.scalars(select(Mensaje).where(Mensaje.conversacion_id == c.id).order_by(Mensaje.id)).all() \
        if c else []
    return {**serial.llamada(l), "conversacion": serial.conversacion(c) if c else None,
            "transcript": [serial.mensaje(m) for m in mensajes], "datos": l.datos}


@r.get("/citas")
def citas(ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(Cita).where(Cita.espacio_id == ctx.espacio_id, Cita.inicio >= ahora() -
                                              timedelta(days=30)).order_by(Cita.inicio)).all()
    contactos = {c.id: c for c in ctx.db.scalars(select(Contacto).where(
        Contacto.id.in_([x.contacto_id for x in filas if x.contacto_id])))}
    return [{**serial.cita(x), "contacto": serial.contacto(contactos[x.contacto_id])
             if x.contacto_id in contactos else None} for x in filas]


@r.post("/citas/{cita_id}/cancelar")
def cancelar_cita(cita_id: int, ctx: Contexto = Depends(requiere("operador"))):
    c = ctx.db.get(Cita, cita_id)
    if not c or c.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrada")
    c.estado = "cancelada"
    ctx.db.commit()
    return serial.cita(c)


# ─────────────────────────────── Panel ───────────────────────────────

@r.get("/metricas")
def metricas(desde: str | None = None, hasta: str | None = None, agente_id: int | None = None,
             ctx: Contexto = Depends(requiere("lector"))):
    ini, fin = _rango(desde, hasta)
    e = ctx.espacio_id
    fc = [Conversacion.espacio_id == e, Conversacion.creado >= ini, Conversacion.creado <= fin,
          Conversacion.canal.not_in(("playground", "simulador"))]
    fl = [Llamada.espacio_id == e, Llamada.creado >= ini, Llamada.creado <= fin]
    if agente_id:
        fc.append(Conversacion.agente_id == agente_id)
        fl.append(Llamada.agente_id == agente_id)

    conv = ctx.db.execute(select(
        func.count(Conversacion.id),
        func.sum(cast(Conversacion.exito.is_(True), Integer)),
        func.sum(cast(Conversacion.exito.is_not(None), Integer)),
        func.sum(cast(Conversacion.motivo_escalado != "", Integer)),
        func.sum(Conversacion.costo_usd),
        func.sum(cast(Conversacion.calificacion == 1, Integer)),
        func.sum(cast(Conversacion.calificacion == -1, Integer)),
        func.count(func.distinct(Conversacion.contacto_id))).where(*fc)).one()
    por_canal = dict(ctx.db.execute(select(Conversacion.canal, func.count(Conversacion.id)).where(*fc)
                                    .group_by(Conversacion.canal)).all())
    ll = ctx.db.execute(select(
        func.count(Llamada.id), func.sum(cast(Llamada.resultado == "contestada", Integer)),
        func.avg(case((Llamada.resultado == "contestada", Llamada.duracion_s))), func.sum(Llamada.duracion_s),
        func.count(func.distinct(Llamada.contacto_id)), func.sum(Llamada.costo_usd),
        func.avg(Llamada.latencia_ms)).where(*fl)).one()
    razones = dict(ctx.db.execute(select(Llamada.razon_desconexion, func.count(Llamada.id))
                                  .where(*fl, Llamada.razon_desconexion != "").group_by(Llamada.razon_desconexion)).all())
    resultados = dict(ctx.db.execute(select(Llamada.resultado, func.count(Llamada.id)).where(*fl)
                                     .group_by(Llamada.resultado)).all())
    dia_c, dia_l = func.date(Conversacion.creado), func.date(Llamada.creado)
    serie_c = {str(d): n for d, n in ctx.db.execute(select(dia_c, func.count(Conversacion.id)).where(*fc)
                                                     .group_by(dia_c)).all()}
    serie_l = {str(d): (n, int(c or 0)) for d, n, c in ctx.db.execute(
        select(dia_l, func.count(Llamada.id), func.sum(cast(Llamada.resultado == "contestada", Integer)))
        .where(*fl).group_by(dia_l)).all()}
    dias = sorted(set(serie_c) | set(serie_l))
    citas_n = ctx.db.scalar(select(func.count(Cita.id)).where(Cita.espacio_id == e, Cita.creado >= ini,
                                                               Cita.creado <= fin)) or 0
    mensajes_ia = ctx.db.scalar(select(func.count(Mensaje.id)).join(Conversacion).where(
        *fc, Mensaje.autor == "ia")) or 0
    envios = dict(ctx.db.execute(select(Envio.canal, func.count(Envio.id)).where(
        Envio.espacio_id == e, Envio.creado >= ini, Envio.creado <= fin).group_by(Envio.canal)).all())
    por_agente = ctx.db.execute(select(Conversacion.agente_id, func.count(Conversacion.id),
                                       func.sum(cast(Conversacion.exito.is_(True), Integer)),
                                       func.sum(Conversacion.costo_usd)).where(*fc)
                                .group_by(Conversacion.agente_id)).all()
    nombres = {a.id: a.nombre for a in ctx.db.scalars(select(Agente).where(Agente.espacio_id == e))}
    lineas = ctx.db.scalars(select(LineaWhatsapp).where(LineaWhatsapp.espacio_id == e,
                                                        LineaWhatsapp.estado == "conectada")).all()
    total_ll, contestadas = ll[0] or 0, int(ll[1] or 0)
    analizadas = int(conv[2] or 0)
    return {
        "rango": {"desde": ini.isoformat() + "Z", "hasta": fin.isoformat() + "Z"},
        "conversaciones": {"total": conv[0] or 0, "contactos_unicos": conv[7] or 0, "por_canal": por_canal,
                           "exitosas": int(conv[1] or 0), "analizadas": analizadas,
                           "tasa_exito": round(int(conv[1] or 0) / analizadas, 3) if analizadas else 0,
                           "escaladas": int(conv[3] or 0), "mensajes_ia": mensajes_ia,
                           "pulgar_arriba": int(conv[5] or 0), "pulgar_abajo": int(conv[6] or 0)},
        "llamadas": {"total": total_ll, "contestadas": contestadas,
                     "tasa_conexion": round(contestadas / total_ll, 3) if total_ll else 0,
                     "duracion_promedio_s": round(ll[2] or 0), "minutos_totales": round((ll[3] or 0) / 60, 1),
                     "contactos_unicos": ll[4] or 0, "latencia_promedio_ms": round(ll[6]) if ll[6] else None,
                     "por_razon": razones, "por_resultado": resultados},
        "citas": citas_n, "envios": envios,
        "costo_usd": round((conv[4] or 0) + (ll[5] or 0), 4),
        "serie": [{"dia": d, "conversaciones": serie_c.get(d, 0),
                   "llamadas": serie_l.get(d, (0, 0))[0], "contestadas": serie_l.get(d, (0, 0))[1]} for d in dias],
        "por_agente": [{"agente_id": a, "nombre": nombres.get(a, "—"), "conversaciones": n,
                        "exitosas": int(x or 0), "costo_usd": round(c or 0, 4)} for a, n, x, c in por_agente],
        "lineas": [{"id": l.id, "numero": l.numero_visible, "calidad": l.calidad, "tier": l.tier,
                    "marketing_pausado": l.marketing_pausado} for l in lineas],
    }


# ─────────────────────────────── Simulaciones ───────────────────────────────

class NuevaSimulacion(BaseModel):
    nombre: str = "Simulación"
    escenarios: list[dict] = []
    n_escenarios: int = Field(5, ge=1, le=20)
    rubrica: list[str] = []
    max_turnos: int = Field(8, ge=2, le=20)
    usar_borrador: bool = True


async def _correr_en_fondo(sim_id: int):
    db = FabricaSesion()
    try:
        await simulador.correr(db, sim_id)
    finally:
        db.close()


@r.post("/agentes/{agente_id}/simulaciones")
async def crear_simulacion(agente_id: int, datos: NuevaSimulacion, fondo: BackgroundTasks,
                           ctx: Contexto = Depends(requiere("editor"))):
    a = ctx.db.get(Agente, agente_id)
    if not a or a.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Agente no encontrado")
    escenarios = datos.escenarios
    if not escenarios:
        try:
            escenarios = await simulador.generar_escenarios(ctx.db, a, datos.n_escenarios)
        except llm.ErrorLLM:
            escenarios = []  # se reintenta al correr y, si no, se usan los de por defecto
        escenarios = escenarios or simulador.escenarios_por_defecto(datos.n_escenarios)
    s = Simulacion(espacio_id=ctx.espacio_id, agente_id=a.id, nombre=datos.nombre, escenarios=escenarios,
                   rubrica=datos.rubrica or simulador.RUBRICA_DEFECTO, max_turnos=datos.max_turnos,
                   usar_borrador=datos.usar_borrador)
    ctx.db.add(s)
    ctx.db.commit()
    fondo.add_task(_correr_en_fondo, s.id)
    return serial.simulacion(s, completo=True)


@r.get("/agentes/{agente_id}/simulaciones")
def simulaciones(agente_id: int, ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(Simulacion).where(Simulacion.espacio_id == ctx.espacio_id,
                                                    Simulacion.agente_id == agente_id)
                           .order_by(Simulacion.id.desc())).all()
    return [serial.simulacion(s) for s in filas]


@r.get("/simulaciones/{sim_id}")
def simulacion(sim_id: int, ctx: Contexto = Depends(requiere("lector"))):
    s = ctx.db.get(Simulacion, sim_id)
    if not s or s.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrada")
    return serial.simulacion(s, completo=True)


@r.post("/simulaciones/{sim_id}/repetir")
def repetir(sim_id: int, fondo: BackgroundTasks, ctx: Contexto = Depends(requiere("editor"))):
    s = ctx.db.get(Simulacion, sim_id)
    if not s or s.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrada")
    nueva = Simulacion(espacio_id=s.espacio_id, agente_id=s.agente_id, nombre=f"{s.nombre} (repetición)",
                       escenarios=s.escenarios, rubrica=s.rubrica, max_turnos=s.max_turnos,
                       usar_borrador=s.usar_borrador)
    ctx.db.add(nueva)
    ctx.db.commit()
    fondo.add_task(_correr_en_fondo, nueva.id)
    return serial.simulacion(nueva, completo=True)


@r.get("/simulaciones/comportamientos/lista")
def comportamientos(ctx: Contexto = Depends(requiere("lector"))):
    return {"comportamientos": simulador.COMPORTAMIENTOS, "rubrica": simulador.RUBRICA_DEFECTO}
