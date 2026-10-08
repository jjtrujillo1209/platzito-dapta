"""Aplicación FastAPI de Platzito."""
import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import planificador
from .config import RAIZ, ajustes
from .db import crear_tablas
from .rutas import (agentes, ajustes as rutas_ajustes, auth, canales, conocimiento, contactos, conversaciones, mcp,
                    metricas, secuencias, voz, webhook_whatsapp, widget)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
FRONT = RAIZ.parent / "frontend" / "dist"
WIDGET = RAIZ.parent / "widget"


@asynccontextmanager
async def vida(_: FastAPI):
    crear_tablas()
    tarea = asyncio.create_task(planificador.bucle()) if ajustes().planificador_activo else None
    yield
    if tarea:
        tarea.cancel()


app = FastAPI(title="Platzito", version="1.0.0", lifespan=vida,
              description="Agentes conversacionales omnicanal: WhatsApp, voz, widget web y campañas outbound.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["content-disposition"])

for modulo in (auth, rutas_ajustes, agentes, conocimiento, contactos, conversaciones, canales, secuencias, metricas,
               webhook_whatsapp, voz, widget, mcp):
    app.include_router(modulo.r)


@app.get("/salud")
def salud():
    return {"ok": True, "entorno": ajustes().entorno}


@app.post("/interno/tick")
async def tick_externo(x_secreto_tick: str = Header("")):
    secreto = ajustes().secreto_tick
    if not secreto or not hmac.compare_digest(secreto, x_secreto_tick):
        raise HTTPException(401, "Secreto inválido")
    return await planificador.tick()


@app.get("/widget.js")
def widget_js():
    return FileResponse(WIDGET / "widget.js", media_type="application/javascript",
                        headers={"cache-control": "public, max-age=300"})


@app.get("/widget/retell-sdk.mjs", include_in_schema=False)
def widget_sdk_retell():
    """SDK web de Retell empaquetado (npm run sdk-widget): el widget no depende de CDNs de terceros."""
    return FileResponse(WIDGET / "retell-sdk.mjs", media_type="text/javascript",
                        headers={"cache-control": "public, max-age=86400", "access-control-allow-origin": "*"})


@app.get("/widget/demo", include_in_schema=False)
def widget_demo():
    return FileResponse(WIDGET / "demo.html", media_type="text/html")


# El frontend compilado se sirve desde el mismo origen (SPA con fallback a index.html)
if FRONT.exists():
    app.mount("/assets", StaticFiles(directory=FRONT / "assets"), name="assets")

    @app.get("/{ruta:path}", include_in_schema=False)
    def spa(ruta: str):
        archivo = FRONT / ruta
        if ruta and archivo.is_file() and Path(archivo).resolve().is_relative_to(FRONT.resolve()):
            return FileResponse(archivo)
        if ruta.startswith(("api/", "webhooks/", "widget/", "voz/", "interno/", "mcp")):
            raise HTTPException(404, "No encontrado")
        return FileResponse(FRONT / "index.html")
