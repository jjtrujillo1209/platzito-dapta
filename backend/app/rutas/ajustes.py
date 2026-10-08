"""Ajustes del espacio: datos, contexto de empresa, integraciones, claves de API, webhooks y eventos."""
import secrets
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import integraciones, llm
from ..canales import retell
from ..conocimiento import descargar_pagina
from ..eventos import emitir, entregar
from ..modelos import ClaveApi, EntregaWebhook, Evento, SuscripcionWebhook
from ..red import UrlNoPermitida, validar_url_externa
from ..seguridad import Contexto, crear_clave_api, requiere

r = APIRouter(prefix="/api", tags=["ajustes"])

CONCURRENCIA_POR_PLAN = {"free": 1, "pro": 5, "scale": 20, "enterprise": 30}


def _espacio(ctx: Contexto) -> dict:
    e = ctx.espacio
    return {"id": e.id, "nombre": e.nombre, "zona_horaria": e.zona_horaria, "plan": e.plan,
            "concurrencia_llamadas": e.concurrencia_llamadas, "contexto_empresa": e.contexto_empresa,
            "rol": ctx.rol}


@r.get("/espacio")
def ver(ctx: Contexto = Depends(requiere("lector"))):
    return _espacio(ctx)


class CambiosEspacio(BaseModel):
    nombre: str | None = Field(None, min_length=2, max_length=120)
    zona_horaria: str | None = None
    contexto_empresa: str | None = Field(None, max_length=20000)
    concurrencia_llamadas: int | None = Field(None, ge=1, le=100)


@r.patch("/espacio")
def cambiar(datos: CambiosEspacio, ctx: Contexto = Depends(requiere("admin"))):
    e = ctx.espacio
    if datos.zona_horaria:
        try:
            ZoneInfo(datos.zona_horaria)
        except Exception:
            raise HTTPException(422, "Zona horaria inválida")
    for campo, valor in datos.model_dump(exclude_none=True).items():
        if campo == "concurrencia_llamadas":
            valor = min(valor, CONCURRENCIA_POR_PLAN.get(e.plan, 5))
        setattr(e, campo, valor)
    ctx.db.commit()
    return _espacio(ctx)


@r.post("/espacio/contexto-desde-url")
async def contexto_desde_url(datos: dict, ctx: Contexto = Depends(requiere("editor"))):
    """Lee la web de la empresa y redacta un contexto para inyectar en el prompt de los agentes."""
    url = (datos.get("url") or "").strip()
    try:
        async with httpx.AsyncClient(timeout=20) as cliente:
            titulo, texto = await descargar_pagina(cliente, url)
    except (httpx.HTTPError, UrlNoPermitida, ValueError) as e:
        raise HTTPException(422, f"No se pudo leer la página: {e}")
    prov = llm.proveedor(ctx.db, ctx.espacio_id)
    try:
        resp = await prov.completar(
            "Redactas fichas de empresa para agentes de ventas y servicio. Sé factual: solo lo que dice la página.",
            [{"rol": "usuario", "texto": f"Página: {titulo}\n\n{texto[:15000]}\n\nEscribe en español, en máximo "
                                         "250 palabras: qué hace la empresa, a quién sirve, productos o servicios, "
                                         "diferenciales, datos de contacto y tono de marca."}], max_tokens=700)
    except llm.ErrorLLM as e:
        raise HTTPException(502, str(e))
    return {"contexto": resp.texto.strip(), "titulo": titulo}


# ─────────────────────────────── Integraciones ───────────────────────────────

@r.get("/integraciones")
def ver_integraciones(ctx: Contexto = Depends(requiere("admin"))):
    return integraciones.vista_publica(ctx.db, ctx.espacio_id)


@r.put("/integraciones/{tipo}")
def guardar_integracion(tipo: str, valores: dict, ctx: Contexto = Depends(requiere("admin"))):
    if tipo not in integraciones.CAMPOS:
        raise HTTPException(404, "Integración desconocida")
    integraciones.guardar(ctx.db, ctx.espacio_id, tipo, valores)
    return integraciones.vista_publica(ctx.db, ctx.espacio_id)


@r.post("/integraciones/{tipo}/probar")
async def probar_integracion(tipo: str, ctx: Contexto = Depends(requiere("admin"))):
    try:
        if tipo in ("anthropic", "openai", "groq", "gemini", "ollama"):
            modelo = llm.MODELOS_SUGERIDOS[tipo][0]
            resp = await llm.proveedor(ctx.db, ctx.espacio_id, tipo, modelo).completar(
                "Responde solo: ok", [{"rol": "usuario", "texto": "ping"}], max_tokens=10)
            return {"ok": True, "detalle": f"{modelo}: {resp.texto.strip()[:40]}"}
        if tipo == "retell":
            voces = await retell.listar_voces(integraciones.credenciales(ctx.db, ctx.espacio_id, "retell")
                                              .get("api_key", ""))
            return {"ok": True, "detalle": f"{len(voces)} voces disponibles"}
        if tipo == "smtp":
            from ..canales.correo import enviar

            destino = ctx.usuario.email if ctx.usuario else None
            if not destino:
                raise HTTPException(422, "Prueba SMTP solo con sesión de usuario")
            await enviar(ctx.db, ctx.espacio_id, destino, "Prueba de Platzito", "El correo saliente funciona.")
            return {"ok": True, "detalle": f"Correo enviado a {destino}"}
        if tipo == "meta":
            cred = integraciones.credenciales(ctx.db, ctx.espacio_id, "meta")
            ok = bool(cred.get("app_id") and cred.get("app_secret"))
            return {"ok": ok, "detalle": "App de Meta configurada" if ok else "Falta app_id o app_secret"}
    except HTTPException:
        raise
    except Exception as e:
        return {"ok": False, "detalle": str(e)[:300]}
    return {"ok": False, "detalle": "Sin prueba disponible"}


# ─────────────────────────────── Claves de API ───────────────────────────────

@r.get("/claves-api")
def claves(ctx: Contexto = Depends(requiere("admin"))):
    filas = ctx.db.scalars(select(ClaveApi).where(ClaveApi.espacio_id == ctx.espacio_id)).all()
    return [{"id": c.id, "nombre": c.nombre, "prefijo": c.prefijo, "rol": c.rol,
             "ultimo_uso": c.ultimo_uso.isoformat() + "Z" if c.ultimo_uso else None,
             "creado": c.creado.isoformat() + "Z"} for c in filas]


@r.post("/claves-api")
def nueva_clave(datos: dict, ctx: Contexto = Depends(requiere("admin"))):
    rol = datos.get("rol", "editor")
    if rol not in ("admin", "editor", "operador", "lector"):
        raise HTTPException(422, "Rol inválido")
    clave, prefijo, hash_ = crear_clave_api()
    fila = ClaveApi(espacio_id=ctx.espacio_id, nombre=(datos.get("nombre") or "Clave")[:120], prefijo=prefijo,
                    hash=hash_, rol=rol)
    ctx.db.add(fila)
    ctx.db.commit()
    return {"id": fila.id, "clave": clave, "aviso": "Guárdala ahora: no se vuelve a mostrar."}


@r.delete("/claves-api/{clave_id}")
def borrar_clave(clave_id: int, ctx: Contexto = Depends(requiere("admin"))):
    c = ctx.db.get(ClaveApi, clave_id)
    if c and c.espacio_id == ctx.espacio_id:
        ctx.db.delete(c)
        ctx.db.commit()
    return {"ok": True}


# ─────────────────────────────── Webhooks salientes ───────────────────────────────

def _sub(s: SuscripcionWebhook) -> dict:
    return {"id": s.id, "url": s.url, "eventos": s.eventos, "activa": s.activa, "secreto": s.secreto,
            "creado": s.creado.isoformat() + "Z"}


@r.get("/webhooks")
def webhooks(ctx: Contexto = Depends(requiere("admin"))):
    return [_sub(s) for s in ctx.db.scalars(select(SuscripcionWebhook)
                                            .where(SuscripcionWebhook.espacio_id == ctx.espacio_id))]


def _url_publica(url: str):
    try:
        validar_url_externa(url)
    except UrlNoPermitida as e:
        raise HTTPException(422, str(e))


class NuevoWebhook(BaseModel):
    url: str = Field(pattern=r"^https?://")
    eventos: list[str] = ["*"]
    activa: bool = True


@r.post("/webhooks")
def crear_webhook(datos: NuevoWebhook, ctx: Contexto = Depends(requiere("admin"))):
    _url_publica(datos.url)
    s = SuscripcionWebhook(espacio_id=ctx.espacio_id, url=datos.url, eventos=datos.eventos or ["*"],
                           activa=datos.activa, secreto="whsec_" + secrets.token_urlsafe(24))
    ctx.db.add(s)
    ctx.db.commit()
    return _sub(s)


@r.patch("/webhooks/{sub_id}")
def editar_webhook(sub_id: int, datos: dict, ctx: Contexto = Depends(requiere("admin"))):
    s = ctx.db.get(SuscripcionWebhook, sub_id)
    if not s or s.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrado")
    if "url" in datos:
        _url_publica(str(datos["url"]))
    for campo in ("url", "eventos", "activa"):
        if campo in datos:
            setattr(s, campo, datos[campo])
    ctx.db.commit()
    return _sub(s)


@r.delete("/webhooks/{sub_id}")
def borrar_webhook(sub_id: int, ctx: Contexto = Depends(requiere("admin"))):
    s = ctx.db.get(SuscripcionWebhook, sub_id)
    if s and s.espacio_id == ctx.espacio_id:
        ctx.db.delete(s)
        ctx.db.commit()
    return {"ok": True}


@r.post("/webhooks/{sub_id}/probar")
async def probar_webhook(sub_id: int, ctx: Contexto = Depends(requiere("admin"))):
    s = ctx.db.get(SuscripcionWebhook, sub_id)
    if not s or s.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrado")
    ev = Evento(espacio_id=ctx.espacio_id, tipo="prueba", datos={"mensaje": "Hola desde Platzito"})
    ctx.db.add(ev)
    ctx.db.flush()
    e = EntregaWebhook(suscripcion_id=s.id, evento_id=ev.id)
    ctx.db.add(e)
    ctx.db.commit()
    ok = await entregar(ctx.db, e)
    return {"ok": ok, "respuesta": e.respuesta}


@r.get("/webhooks/{sub_id}/entregas")
def entregas(sub_id: int, ctx: Contexto = Depends(requiere("admin"))):
    s = ctx.db.get(SuscripcionWebhook, sub_id)
    if not s or s.espacio_id != ctx.espacio_id:
        raise HTTPException(404, "No encontrado")
    filas = ctx.db.execute(select(EntregaWebhook, Evento).join(Evento, Evento.id == EntregaWebhook.evento_id)
                           .where(EntregaWebhook.suscripcion_id == sub_id).order_by(EntregaWebhook.id.desc())
                           .limit(100)).all()
    return [{"id": e.id, "evento": ev.tipo, "estado": e.estado, "intentos": e.intentos, "respuesta": e.respuesta,
             "creado": e.creado.isoformat() + "Z"} for e, ev in filas]


@r.get("/eventos")
def eventos(tipo: str | None = None, limite: int = 100, ctx: Contexto = Depends(requiere("lector"))):
    q = select(Evento).where(Evento.espacio_id == ctx.espacio_id)
    if tipo:
        q = q.where(Evento.tipo == tipo)
    filas = ctx.db.scalars(q.order_by(Evento.id.desc()).limit(min(limite, 500))).all()
    return [{"id": e.id, "tipo": e.tipo, "datos": e.datos, "creado": e.creado.isoformat() + "Z"} for e in filas]


@r.post("/eventos/emitir-prueba")
def emitir_prueba(ctx: Contexto = Depends(requiere("admin"))):
    ev = emitir(ctx.db, ctx.espacio_id, "prueba", {"mensaje": "Evento de prueba"})
    return {"id": ev.id}
