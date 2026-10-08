"""Cerebros (knowledge base) y sus fuentes: web, sitemap, archivos y texto."""
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .. import conocimiento, serial
from ..config import ajustes
from ..db import FabricaSesion
from ..modelos import Cerebro, Fragmento, Fuente
from ..red import UrlNoPermitida, validar_url_externa
from ..seguridad import Contexto, requiere

r = APIRouter(prefix="/api/cerebros", tags=["conocimiento"])
MAX_FUENTES = 50
EXTENSIONES = (".pdf", ".docx", ".xlsx", ".xlsm", ".csv", ".txt", ".md", ".html", ".htm", ".json")
MAX_BYTES = 25 * 1024 * 1024


def _cerebro(ctx: Contexto, cerebro_id: int) -> Cerebro:
    c = ctx.db.get(Cerebro, cerebro_id)
    if not c or c.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "Cerebro no encontrado")
    return c


async def procesar_en_fondo(fuente_id: int):
    db = FabricaSesion()
    try:
        await conocimiento.procesar_fuente(db, fuente_id)
    finally:
        db.close()


@r.get("")
def listar(ctx: Contexto = Depends(requiere("lector"))):
    filas = ctx.db.scalars(select(Cerebro).where(Cerebro.espacio_id == ctx.espacio_id).order_by(Cerebro.id)).all()
    conteos = dict(ctx.db.execute(select(Fuente.cerebro_id, func.count(Fuente.id)).group_by(Fuente.cerebro_id)).all())
    frags = dict(ctx.db.execute(select(Fragmento.cerebro_id, func.count(Fragmento.id))
                                .group_by(Fragmento.cerebro_id)).all())
    return [{**serial.cerebro(c), "n_fuentes": conteos.get(c.id, 0), "n_fragmentos": frags.get(c.id, 0)}
            for c in filas]


class NuevoCerebro(BaseModel):
    nombre: str = Field(min_length=1, max_length=80)
    descripcion: str = ""


@r.post("")
def crear(datos: NuevoCerebro, ctx: Contexto = Depends(requiere("editor"))):
    c = Cerebro(espacio_id=ctx.espacio_id, nombre=datos.nombre, descripcion=datos.descripcion)
    ctx.db.add(c)
    ctx.db.commit()
    return serial.cerebro(c, [])


@r.get("/{cerebro_id}")
def ver(cerebro_id: int, ctx: Contexto = Depends(requiere("lector"))):
    c = _cerebro(ctx, cerebro_id)
    fuentes = ctx.db.scalars(select(Fuente).where(Fuente.cerebro_id == c.id).order_by(Fuente.id.desc())).all()
    return serial.cerebro(c, fuentes)


@r.patch("/{cerebro_id}")
def editar(cerebro_id: int, datos: NuevoCerebro, ctx: Contexto = Depends(requiere("editor"))):
    c = _cerebro(ctx, cerebro_id)
    c.nombre, c.descripcion = datos.nombre, datos.descripcion
    ctx.db.commit()
    return serial.cerebro(c)


@r.delete("/{cerebro_id}")
def borrar(cerebro_id: int, ctx: Contexto = Depends(requiere("admin"))):
    c = _cerebro(ctx, cerebro_id)
    ctx.db.delete(c)
    ctx.db.commit()
    return {"ok": True}


def _cupo(ctx: Contexto, c: Cerebro):
    n = ctx.db.scalar(select(func.count(Fuente.id)).where(Fuente.cerebro_id == c.id))
    if n >= MAX_FUENTES:
        raise HTTPException(422, f"Máximo {MAX_FUENTES} fuentes por cerebro")


class NuevaFuente(BaseModel):
    tipo: str = Field(pattern="^(url|sitemap|texto)$")
    nombre: str = ""
    url: str = ""
    texto: str = Field("", max_length=500_000)
    max_paginas: int = Field(50, ge=1, le=500)
    urls: list[str] = []  # páginas elegidas del sitemap


@r.post("/{cerebro_id}/fuentes")
def agregar_fuente(cerebro_id: int, datos: NuevaFuente, fondo: BackgroundTasks,
                   ctx: Contexto = Depends(requiere("editor"))):
    c = _cerebro(ctx, cerebro_id)
    _cupo(ctx, c)
    if datos.tipo in ("url", "sitemap"):
        try:
            validar_url_externa(datos.url)
        except UrlNoPermitida as e:
            raise HTTPException(422, str(e))
    elif not datos.texto.strip():
        raise HTTPException(422, "El texto está vacío")
    f = Fuente(cerebro_id=c.id, tipo=datos.tipo, nombre=(datos.nombre or datos.url or "Texto")[:300], url=datos.url,
               texto=datos.texto, opciones={"max_paginas": datos.max_paginas, "urls": datos.urls[:500]})
    ctx.db.add(f)
    ctx.db.commit()
    fondo.add_task(procesar_en_fondo, f.id)
    return serial.fuente(f)


@r.post("/{cerebro_id}/archivos")
async def subir_archivo(cerebro_id: int, fondo: BackgroundTasks, archivo: UploadFile = File(...),
                        ctx: Contexto = Depends(requiere("editor"))):
    c = _cerebro(ctx, cerebro_id)
    _cupo(ctx, c)
    nombre = archivo.filename or "archivo"
    if not nombre.lower().endswith(EXTENSIONES):
        raise HTTPException(422, f"Formato no soportado. Usa: {', '.join(EXTENSIONES)}")
    contenido = await archivo.read()
    if len(contenido) > MAX_BYTES:
        raise HTTPException(413, "Archivo de más de 25 MB")
    relativo = f"archivos/{ctx.espacio_id}/{uuid.uuid4().hex}_{nombre.replace('/', '_')[-120:]}"
    destino = ajustes().directorio_datos / relativo
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(contenido)
    f = Fuente(cerebro_id=c.id, tipo="archivo", nombre=nombre[:300], archivo=relativo)
    ctx.db.add(f)
    ctx.db.commit()
    fondo.add_task(procesar_en_fondo, f.id)
    return serial.fuente(f)


def _fuente(ctx: Contexto, fuente_id: int) -> Fuente:
    f = ctx.db.get(Fuente, fuente_id)
    if not f:
        raise HTTPException(404, "Fuente no encontrada")
    _cerebro(ctx, f.cerebro_id)
    return f


@r.post("/fuentes/{fuente_id}/reintentar")
def reintentar(fuente_id: int, fondo: BackgroundTasks, ctx: Contexto = Depends(requiere("editor"))):
    f = _fuente(ctx, fuente_id)
    f.estado, f.error = "pendiente", ""
    ctx.db.commit()
    fondo.add_task(procesar_en_fondo, f.id)
    return serial.fuente(f)


@r.delete("/fuentes/{fuente_id}")
def borrar_fuente(fuente_id: int, ctx: Contexto = Depends(requiere("editor"))):
    f = _fuente(ctx, fuente_id)
    cerebro_id = f.cerebro_id
    if f.archivo:
        (ajustes().directorio_datos / f.archivo).unlink(missing_ok=True)
    ctx.db.delete(f)
    ctx.db.commit()
    conocimiento._invalidar(cerebro_id)
    return {"ok": True}


@r.get("/fuentes/{fuente_id}/fragmentos")
def fragmentos(fuente_id: int, ctx: Contexto = Depends(requiere("lector"))):
    f = _fuente(ctx, fuente_id)
    filas = ctx.db.scalars(select(Fragmento).where(Fragmento.fuente_id == f.id).order_by(Fragmento.orden)
                           .limit(200)).all()
    return [{"id": x.id, "orden": x.orden, "titulo": x.titulo, "url": x.url, "texto": x.texto} for x in filas]


@r.post("/{cerebro_id}/buscar")
async def buscar(cerebro_id: int, datos: dict, ctx: Contexto = Depends(requiere("lector"))):
    _cerebro(ctx, cerebro_id)
    try:
        return await conocimiento.buscar(ctx.db, ctx.espacio_id, [cerebro_id], datos.get("consulta", ""),
                                         int(datos.get("top_k", 5)), float(datos.get("umbral", 0.0)))
    except conocimiento.ErrorEmbeddings as e:
        raise HTTPException(502, str(e))


@r.post("/sitemap/descubrir")
async def descubrir(datos: dict, ctx: Contexto = Depends(requiere("editor"))):
    try:
        urls = await conocimiento.descubrir_sitemap(datos.get("url", ""), int(datos.get("max", 300)))
    except UrlNoPermitida as e:
        raise HTTPException(422, str(e))
    return {"urls": urls}
